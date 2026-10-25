#!/usr/bin/env python3
"""
sanitize-guard — refuse to land personal-identifier content in the public
Edva tree.

Runs as a pre-commit hook (staged files), in CI (`--all`, see
.github/workflows/sanitize-guard.yml) and from `edva audit`.

Patterns
--------
Two sets are matched, case-insensitively, against every line:

1. Generic detectors, defined below (tokens and keys whose shape gives them
   away, e.g. a JWT such as a Supabase anon key, whose base64 payload names
   the project even when no plain-text project ref appears).
2. The operator's identity patterns — their names, handles, homes, project
   refs, hosts, addresses. That list is itself personal data, so it is never
   committed. It is loaded at run time from, in order:
       $EDVA_SANITIZE_PATTERNS_JSON   the JSON itself (e.g. a CI secret)
       $EDVA_SANITIZE_PATTERNS        a path to the JSON file
       agent/local/sanitize-patterns.json   (gitignored)
   The JSON is an object of {"<pattern_name>": "<python regex>"}. Only the
   regexes are private; the names are public, because baseline entries are
   keyed `<name>:<line>` and every reported hit prints its name (in CI, in a
   public log). So a name says what KIND of identifier the pattern catches
   and never spells what it matches: `project_homepage`, `repo_url`,
   `companion_app_name`, `owner_handle`, `address_1`, `org_2` — not a
   brand, domain, handle, person, pet or place. Keep names stable too:
   renaming one means rewriting the baseline keys (and the CI secret) to match.
   Without it the guard still runs the generic set and says so on stderr.

What it skips
-------------
Overlay surfaces by construction (agent/local/, legacy local/, any `_ext/`,
data/, secrets/, credentials/, .env), lockfiles, symlinks, files over 2 MB,
and this tool's own directory. Content only — file paths are not judged.

Line markers
------------
A line carrying `sanitize-guard-ok: <reason>` is exempt. So is a line carrying
`kernel-guard-ok: <reason>`: kernel files are synced from an upstream
installation whose own guard already reviewed and exempted that line.

Baseline ratchet
----------------
Intentional public references that match an identity pattern (none today —
the baseline is empty) are accepted in .tools/sanitize-guard-baseline.json
— relpath → sorted `<pattern>:<line snippet>` keys (no line numbers, so edits
that only move a line keep it accepted). Only hits not in the baseline fail.
`--baseline` rewrites it from the current hits; review that diff like code.

Usage
-----
    .tools/sanitize-guard.py              # staged files (pre-commit)
    .tools/sanitize-guard.py --all        # every tracked + untracked, non-ignored file
    .tools/sanitize-guard.py FILE...      # specific files
    .tools/sanitize-guard.py --baseline   # snapshot current hits as accepted
    .tools/sanitize-guard.py --list-patterns [--json]

Exit codes: 0 clean · 1 new hit(s) · 2 invocation/config error
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
DEFAULT_OVERLAY = ROOT / "agent" / "local" / "sanitize-patterns.json"

# ─── Generic detectors (safe to publish) ────────────────────────────────────
BUILTIN_PATTERNS: dict[str, str] = {
    # A JSON Web Token: header.payload, both base64url JSON objects.
    "jwt_token": r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}",
    # Supabase secret keys in their prefixed form.
    "supabase_secret_key": r"\bsb_secret_[A-Za-z0-9_-]{16,}",
}

LINE_MARKERS = ("sanitize-guard-ok:", "kernel-guard-ok:")


def _overlay_source() -> tuple[str, str | None]:
    """→ (description, json text or None when absent)."""
    inline = os.environ.get("EDVA_SANITIZE_PATTERNS_JSON", "").strip()
    if inline:
        return "$EDVA_SANITIZE_PATTERNS_JSON", inline
    explicit = os.environ.get("EDVA_SANITIZE_PATTERNS", "").strip()
    path = Path(explicit) if explicit else DEFAULT_OVERLAY
    try:
        return str(path), path.read_text()
    except FileNotFoundError:
        if explicit:
            print(f"sanitize-guard: EDVA_SANITIZE_PATTERNS points at a missing file: {path}", file=sys.stderr)
            sys.exit(2)
        return str(path), None
    except OSError as e:
        print(f"sanitize-guard: cannot read {path}: {e}", file=sys.stderr)
        sys.exit(2)


def load_overlay_patterns() -> tuple[str, dict[str, str]]:
    where, text = _overlay_source()
    if text is None:
        return where, {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"sanitize-guard: identity patterns in {where} are not valid JSON: {e}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
        print(f"sanitize-guard: {where} must be a JSON object of name -> regex strings", file=sys.stderr)
        sys.exit(2)
    return where, {k: v for k, v in data.items() if not k.startswith("_")}


OVERLAY_WHERE, OVERLAY_PATTERNS = load_overlay_patterns()
PERSONAL_PATTERNS: dict[str, str] = {**BUILTIN_PATTERNS, **OVERLAY_PATTERNS}
try:
    COMPILED = {k: re.compile(v, re.IGNORECASE) for k, v in PERSONAL_PATTERNS.items()}
except re.error as e:
    print(f"sanitize-guard: a pattern does not compile: {e}", file=sys.stderr)
    sys.exit(2)

# ─── Path-level skips ────────────────────────────────────────────────────────
SKIP_PREFIXES = (
    "agent/local/",
    "local/",
    "data/",
    "secrets/",
    "credentials/",
    "node_modules/",
    # The baseline stores each accepted hit verbatim; this script names the
    # generic patterns. Scanning the directory would flag itself.
    ".tools/",
)
SKIP_PATH_CONTAINS = ("/_ext/", "/node_modules/")
SKIP_SUFFIXES = (
    ".env",
    ".gitkeep",
    "package-lock.json",   # generated; transitive package names
)
MAX_BYTES = 2 * 1024 * 1024


def is_skipped(rel: str) -> bool:
    return (
        rel.startswith(SKIP_PREFIXES)
        or rel.startswith("_ext/")
        or any(p in rel for p in SKIP_PATH_CONTAINS)
        or rel.endswith(SKIP_SUFFIXES)
    )


def _git(*args: str) -> list[str]:
    try:
        out = subprocess.check_output(["git", *args], cwd=ROOT, text=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"sanitize-guard: git failed ({' '.join(args)}): {e}", file=sys.stderr)
        sys.exit(2)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def staged_files() -> list[str]:
    return _git("diff", "--cached", "--name-only", "--diff-filter=ACMR")


def all_files() -> list[str]:
    # Tracked plus untracked-but-not-ignored: what the next `git add -A` would
    # publish. In CI the two are the same.
    return sorted(set(_git("ls-files")) | set(_git("ls-files", "--others", "--exclude-standard")))


def scan_one(path: Path) -> list[tuple[str, int, str]]:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_BYTES:
            return []
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    hits: list[tuple[str, int, str]] = []
    for i, line in enumerate(text.splitlines(), 1):
        if any(m in line for m in LINE_MARKERS):
            continue
        for name, regex in COMPILED.items():
            if regex.search(line):
                snippet = line.strip()
                if len(snippet) > 100:
                    snippet = snippet[:100] + "…"
                hits.append((name, i, snippet))
    return hits


def read_baseline() -> dict[str, list[str]]:
    try:
        return json.loads(BASELINE_PATH.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        print(f"sanitize-guard: baseline file is corrupt: {e}", file=sys.stderr)
        sys.exit(2)


def hit_key(name: str, snippet: str) -> str:
    return f"{name}:{snippet}"


def collect_hits(files: list[str]) -> list[tuple[str, list[tuple[str, int, str]]]]:
    out = []
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


def write_baseline(flagged) -> None:
    baseline = {rel: sorted({hit_key(n, s) for n, _, s in hits}) for rel, hits in flagged}
    BASELINE_PATH.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")


def main(argv: list[str]) -> int:
    if "--list-patterns" in argv:
        if "--json" in argv:
            print(json.dumps({"overlay_loaded": bool(OVERLAY_PATTERNS), "overlay_source": OVERLAY_WHERE,
                              "patterns": PERSONAL_PATTERNS}, indent=2))
            return 0
        width = max(len(k) for k in PERSONAL_PATTERNS)
        for k, v in PERSONAL_PATTERNS.items():
            tag = "generic " if k in BUILTIN_PATTERNS else "identity"
            print(f"  {k.ljust(width)}  [{tag}]  {v}")
        if not OVERLAY_PATTERNS:
            print(f"  (no identity patterns loaded: {OVERLAY_WHERE} not found)")
        return 0

    explicit = [a for a in argv[1:] if not a.startswith("--")]
    write_mode = "--baseline" in argv
    if explicit:
        files = explicit
    elif "--all" in argv or write_mode:
        files = all_files()
    else:
        files = staged_files()
    if not files:
        return 0

    if not OVERLAY_PATTERNS:
        print("sanitize-guard: warning: no identity patterns loaded (set EDVA_SANITIZE_PATTERNS or "
              "create agent/local/sanitize-patterns.json); checking generic patterns only", file=sys.stderr)

    flagged = collect_hits(files)

    if write_mode:
        if not OVERLAY_PATTERNS:
            print("sanitize-guard: refusing to write a baseline without the identity patterns — "
                  "it would drop every accepted identity hit", file=sys.stderr)
            return 2
        write_baseline(flagged)
        total = sum(len(h) for _, h in flagged)
        print(f"sanitize-guard: wrote baseline ({len(flagged)} files, {total} hits) to "
              f"{BASELINE_PATH.relative_to(ROOT)}")
        return 0

    baseline = read_baseline()
    new_flagged = []
    for rel, hits in flagged:
        accepted = set(baseline.get(rel, []))
        new_hits = [(n, ln, s) for (n, ln, s) in hits if hit_key(n, s) not in accepted]
        if new_hits:
            new_flagged.append((rel, new_hits))
    if not new_flagged:
        return 0

    total_new = sum(len(h) for _, h in new_flagged)
    err = sys.stderr
    print(f"\nsanitize-guard: {total_new} new hit(s) in {len(new_flagged)} file(s) beyond the accepted baseline:\n", file=err)
    for rel, hits in new_flagged:
        print(f"  {rel}", file=err)
        for name, lineno, snippet in hits:
            print(f"    line {lineno}: [{name}] {snippet}", file=err)
        print("", file=err)
    print("Resolve by one of:", file=err)
    print("  • removing or genericizing the identifier,", file=err)
    print("  • moving the content into your private overlay (agent/local/ or an _ext/ dir;", file=err)
    print("    see docs/architecture-public-private.md),", file=err)
    print("  • marking a deliberate line with `sanitize-guard-ok: <reason>`, or", file=err)
    print("  • for intentional public content, accepting it: .tools/sanitize-guard.py --baseline", file=err)
    print("    (and committing the baseline change with a reason in the PR).", file=err)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
