#!/usr/bin/env python3
"""
sanitize-guard — pre-commit guard that refuses to land personal-identifier
content in the public merlin tree.

This is the *commit-time* counterpart to the gandalf→merlin migration's
`scan.py` (which classifies the whole tree at publish time). The migration
scanner lives in the private gandalf repo and runs as a one-off; this guard
runs on every merlin commit and is the durable boundary.

What it does
------------
1. Walk the staged files (or, with --all, every tracked file).
2. Skip paths that are overlay surfaces by construction: `local/`,
   `**/_ext/`, `data/`, `secrets/`, `credentials/`, `.env*`, anything
   in `.gitignore`'d locations that somehow got staged.
3. For each surviving file, grep for the PERSONAL_PATTERNS below.
4. If any hit, print a clean report and exit 1 (blocks the commit).

What it does NOT do
-------------------
- It does not classify files into copy-clean / copy-sanitize buckets — that's
  scan.py's job in the private repo.
- It does not look at file *paths* (only content). Putting a file under a
  personal-sounding directory doesn't make it personal; what matters is
  whether the content names a real person/place/credential.
- It does not gate on the brand word "gandalf" (which appears legitimately in
  the kernel's docs about the companion app). Only on identity-coupled
  patterns.

Usage
-----
    .tools/sanitize-guard.py              # check git staged files (pre-commit)
    .tools/sanitize-guard.py --all        # check every tracked file
    .tools/sanitize-guard.py path/to/file # check specific files
    .tools/sanitize-guard.py --baseline   # snapshot current hits as accepted baseline
    .tools/sanitize-guard.py --list-patterns

Baseline ratchet
----------------
The kernel inherently contains a small set of intentional public references
(e.g. README points at `silo.co/merlin` as the marketing URL, SECURITY.md
links to the public repo). To accept those without blocking commits, we keep
a baseline snapshot at `.tools/sanitize-guard-baseline.json`. The guard
rejects only hits *not* present in the baseline. Add a new accepted hit via
`--baseline` and commit the updated baseline file alongside the kernel
change that introduces it — the diff is the audit trail.

Exit codes
----------
    0 — clean (no new hits beyond baseline)
    1 — at least one new personal-identifier hit
    2 — invocation/env error (no git, etc.)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = Path(__file__).resolve().parent / "sanitize-guard-baseline.json"

# ─── Personal-identifier patterns (sync'd with gandalf scan.py) ─────────────
# These are the patterns that, if found in any file destined for the public
# tree, mean the commit MUST be sanitized (or moved into the overlay) before
# it can land.
#
# Update this list when you add a new identity coupling in your personal
# overlay that the kernel would have no business referencing.
PERSONAL_PATTERNS: dict[str, str] = {
    "owner_firstname":  r"\bmoshik\b",
    "owner_handle":     r"\bmraccah(?:2)?\b",
    "owner_partner":    r"\bpari\b",
    "owner_pet_rico":   r"\brico\b",
    "owner_pet_oscar":  r"\boscar\b",
    "domain_silo":      r"\bsilo\.co\b|@silo\.co\b",
    "prop_villa_b":     r"villa\s*biscayne|biscayne\s*park|845[\s_-]*NE[\s_-]*116",
    "prop_villa_t":     r"villa\s*tropical|936[\s_-]*NE[\s_-]*128",
    "prop_casa":        r"casa\s*miami|351[\s_-]*NE[\s_-]*117",
    "prop_chelsea":     r"chelsea\s*home",
    "prop_mansfield":   r"\bmansfield\b",
    "prop_cleveland":   r"cleveland\s*118|118th\s*st.*cleveland",
    "brand_scamper":    r"\bscamper\b",
    "brand_listo":      r"\blisto\b",
    "brand_allwhere":   r"\ballwhere\b",
    "brand_pamper":     r"\bpamperhomes\b",
    "brand_schwab":     r"\bschwab\b",
    "brand_spotter":    r"\bspotter\b",
    "ios_bundle_id":    r"com\.mraccah\.[Gg]andalf",
    "supabase_proj":    r"mszowrkjhfstptnssrzk|wmchpoddwdiabdobdpgh",
    "gcp_proj":         r"eminent-wording-489203-t2",
    "firebase_rtdb":    r"openclaw-heartbeat",
    "hookdeck_host":    r"hkdk\.events",
    "mac_user_path":    r"/Users/(?:moshikraccah|mraccah)\b",
    "owner_email":      r"mraccah@gmail\.com",
    "personal_repo":    r"mraccah2/(?:gandalf|gandalf-personal)",
    "host_mini":        r"moshiks-mac-mini",
    "tripit_inbound":   r"plans@tripit\.com",
}

COMPILED = {k: re.compile(v, re.IGNORECASE) for k, v in PERSONAL_PATTERNS.items()}

# ─── Path-level skips ────────────────────────────────────────────────────────
# These are overlay surfaces by definition — personal content is the entire
# point. The .gitignore should already keep them out of git, but if they end
# up staged anyway (`git add -f`) we still don't want the guard to flag the
# content, since it's not headed for the public push.
SKIP_PREFIXES = (
    "local/",
    "data/",
    "secrets/",
    "credentials/",
    "node_modules/",
    ".tools/sanitize-guard.py",   # this file (it documents the patterns)
)
SKIP_PATH_CONTAINS = (
    "/_ext/",                      # any extension drop
)
SKIP_SUFFIXES = (
    ".env", ".env.example",        # env templates are documented separately
    ".gitkeep",
    "PORT-DELTA-2026-05-23.md",    # auto-generated audit report
    "package-lock.json",           # generated; would hit on transitive package names
)

# Files larger than this are skipped — binary blobs and lockfiles aren't where
# leaks happen, and scanning them is slow.
MAX_BYTES = 2 * 1024 * 1024


def is_skipped(rel: str) -> bool:
    if any(rel.startswith(p) for p in SKIP_PREFIXES):
        return True
    if any(p in rel for p in SKIP_PATH_CONTAINS):
        return True
    if any(rel.endswith(s) for s in SKIP_SUFFIXES):
        return True
    return False


def staged_files() -> list[str]:
    try:
        out = subprocess.check_output(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
            cwd=ROOT, text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"sanitize-guard: not a git repo or git missing: {e}", file=sys.stderr)
        sys.exit(2)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def all_tracked_files() -> list[str]:
    out = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def scan_one(path: Path) -> list[tuple[str, int, str]]:
    """Return [(pattern_name, lineno, context_snippet), ...]."""
    try:
        if path.stat().st_size > MAX_BYTES:
            return []
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    hits: list[tuple[str, int, str]] = []
    for i, line in enumerate(text.splitlines(), 1):
        for name, regex in COMPILED.items():
            m = regex.search(line)
            if m:
                snippet = line.strip()
                if len(snippet) > 100:
                    snippet = snippet[:100] + "…"
                hits.append((name, i, snippet))
    return hits


def read_baseline() -> dict[str, list[str]]:
    """Baseline maps relpath → sorted list of `<pattern>:<line-snippet>` keys
    that are pre-accepted. Line numbers are deliberately NOT in the key —
    edits that shift line numbers without changing personal content don't
    invalidate the baseline."""
    try:
        return json.loads(BASELINE_PATH.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        print(f"sanitize-guard: baseline file is corrupt: {e}", file=sys.stderr)
        sys.exit(2)


def hit_key(name: str, snippet: str) -> str:
    """Stable key for a hit independent of line number — just <pattern>:<snippet>."""
    return f"{name}:{snippet}"


def collect_hits(files: list[str]) -> list[tuple[str, list[tuple[str, int, str]]]]:
    out: list[tuple[str, list[tuple[str, int, str]]]] = []
    for rel in files:
        if is_skipped(rel):
            continue
        p = ROOT / rel
        if not p.is_file():
            continue
        hits = scan_one(p)
        if hits:
            out.append((rel, hits))
    return out


def write_baseline(flagged: list[tuple[str, list[tuple[str, int, str]]]]) -> None:
    baseline: dict[str, list[str]] = {}
    for rel, hits in flagged:
        baseline[rel] = sorted({hit_key(n, s) for n, _, s in hits})
    BASELINE_PATH.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")


def main(argv: list[str]) -> int:
    if "--list-patterns" in argv:
        width = max(len(k) for k in PERSONAL_PATTERNS)
        for k, v in PERSONAL_PATTERNS.items():
            print(f"  {k.ljust(width)}  {v}")
        return 0

    explicit = [a for a in argv[1:] if not a.startswith("--")]
    write_baseline_mode = "--baseline" in argv
    use_all = "--all" in argv or write_baseline_mode

    if explicit:
        files = explicit
    elif use_all:
        files = all_tracked_files()
    else:
        files = staged_files()

    if not files:
        return 0

    flagged = collect_hits(files)

    if write_baseline_mode:
        write_baseline(flagged)
        total = sum(len(h) for _, h in flagged)
        print(f"sanitize-guard: wrote baseline ({len(flagged)} files, {total} hits) "
              f"to {BASELINE_PATH.relative_to(ROOT)}")
        return 0

    # Filter against baseline — only NEW hits count.
    baseline = read_baseline()
    new_flagged: list[tuple[str, list[tuple[str, int, str]]]] = []
    for rel, hits in flagged:
        accepted = set(baseline.get(rel, []))
        new_hits = [(n, ln, s) for (n, ln, s) in hits if hit_key(n, s) not in accepted]
        if new_hits:
            new_flagged.append((rel, new_hits))

    if not new_flagged:
        return 0

    total_new = sum(len(h) for _, h in new_flagged)
    print("", file=sys.stderr)
    print(f"sanitize-guard: {total_new} NEW personal-identifier hit(s) in "
          f"{len(new_flagged)} file(s) beyond the accepted baseline:", file=sys.stderr)
    print("", file=sys.stderr)
    for rel, hits in new_flagged:
        print(f"  {rel}", file=sys.stderr)
        for name, lineno, snippet in hits:
            print(f"    line {lineno}: [{name}] {snippet}", file=sys.stderr)
        print("", file=sys.stderr)
    print("Resolve by either:", file=sys.stderr)
    print("  • removing/genericizing the identifier in the file, or", file=sys.stderr)
    print("  • moving the file into your personal overlay (see", file=sys.stderr)
    print("    docs/architecture-public-private.md), or", file=sys.stderr)
    print("  • if this hit is intentional public content, accept it into the", file=sys.stderr)
    print("    baseline:  .tools/sanitize-guard.py --baseline", file=sys.stderr)
    print("    (and commit the updated baseline file).", file=sys.stderr)
    print("", file=sys.stderr)
    print("To inspect the pattern set: .tools/sanitize-guard.py --list-patterns",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
