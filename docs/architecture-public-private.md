# Public kernel + personal overlay

Merlin is built so the same agent system can run **as-is in the open** (this
repo, anyone can clone and run) and **with the operator's personal life
layered on top** (private overlay, only that operator's machines see it). The
two halves stay separated by file location, not by sanitization at sync time.

This document is the contract. Read it before adding code that knows about a
specific person, place, business, project codename, integration credential,
or any other identity-coupled fact.

## Two repos, one runtime

```
┌───────────────────────────────────────┐    ┌──────────────────────────────┐
│  merlin                               │    │  merlin-personal             │
│  (this repo · public · github)        │    │  (your private repo · local) │
│  ───────────────────────────────────  │    │  ──────────────────────────  │
│  • Kernel code (supervisor, dispatch, │    │  • Personal ops jobs         │
│    intake, watchdog, MCP base, hum    │    │  • Personal hum harvesters   │
│    harness, memory, telemetry, CLI)   │◄───│  • Personal MCP tools        │
│  • Reference jobs (morning-digest)    │    │  • Personal bin/ scripts     │
│  • Reference harvesters (weather,     │    │  • local/CLAUDE.md content   │
│    news, calendar, tasks, watchdog,   │    │  • Integration registries    │
│    serendipity)                       │    │  • Memory seed files         │
│  • CLAUDE.md kernel rules             │    │  • .env values               │
│  • Extension surface (`_ext/`)        │    │                              │
│  • docs/, examples/, .env.example     │    │                              │
└───────────────────────────────────────┘    └──────────────────────────────┘
                  │                                          │
                  │                  `merlin overlay add`    │
                  │                  ─ symlinks ─►           │
                  └────────────► Runtime on a host ◄─────────┘
                                  (e.g. your mini)
                                  Resolves to:
                                  merlin/local/...
                                  merlin/agent/**/_ext/*
```

The public repo is canonical for *every* general-purpose concern. The
personal overlay layers on top via symlinks into well-known extension dirs.
Nothing else.

## Why the boundary is "where you wrote the file," not "what's in the file"

The earlier design used a tree-walking sanitizer (`merlin-migration/scan.py`
in the private gandalf repo) that classified every file at publish time and
either copied, sanitized, or excluded it. That pattern has two failure modes:

1. **The sanitizer is the only audit.** Any miss leaks personal content into
   the public repo. We had to rerun the full classifier on every publish.
2. **Improvements only flow one way.** Outside contributors' PRs can't merge
   cleanly back into the private repo because the private repo's tree shape
   is different.

The kernel/overlay model flips this:

- **You decide at write time which repo to commit into.** Generic code →
  merlin. Personal code → merlin-personal. The decision is structural, not
  textual.
- **Improvements flow both ways.** Kernel improvements go in via PR on
  merlin and propagate to every operator. Personal additions stay in your
  overlay and never leave.
- **The sanitizer flips role.** `.tools/sanitize-guard.py` is now a
  pre-commit hook on the public repo that *refuses* commits introducing new
  personal-identifier hits. The migration scanner (`scan.py` in gandalf) is
  retired after the one-time port is done.

## The extension surface

Six well-known drop points, all under `.gitignore` (`**/_ext/*` or `local/`):

| Concern | Kernel path | Overlay drop | Loader |
| --- | --- | --- | --- |
| Agent rules / voice | `agent/CLAUDE.md` (and per-agent CLAUDE.md files) | `local/CLAUDE.md` | "Local Rules" section at end of `agent/CLAUDE.md` instructs every agent to also load this file |
| Ops jobs (webhook-dispatchable) | `agent/ops-agent/jobs/*.md` | `agent/ops-agent/jobs/_ext/*.md` | `resolveJobFile()` in `agent/supervisor/http-server.mjs` — kernel wins on name conflict, overlay is fallback |
| Hum harvesters | `agent/scripts/hum-harvesters/*.mjs` | `agent/scripts/hum-harvesters/_ext/*.mjs` | `resolveHarvesterPath()` in `agent/scripts/hum-harvest-all.mjs` — kernel wins on name conflict |
| MCP tools | `agent/tools-mcp/index.mjs` (static `TOOLS` array) | `agent/tools-mcp/_ext/*.mjs` exporting `{ tools: [...] }` | `loadExtTools()` at MCP server startup; kernel tool names shadow overlay |
| CLI tools | `bin/*` | `bin/_ext/*` (executables) | Personal jobs/harvesters that invoke these scripts get `bin/_ext` on PATH (set in agent child-process env) |
| Memory seeds | `examples/memory/*.md` templates | `local/memory-seed/*.md` | Read by your bootstrap recipe; see `docs/memory.md` |

Each `_ext/` directory ships with a `.gitkeep` whose body documents the drop
contract for that point. You can `cat agent/ops-agent/jobs/_ext/.gitkeep` to
re-read the contract any time.

## The `merlin overlay` command

```bash
merlin overlay add <path>      # attach a personal overlay repo (creates symlinks)
merlin overlay status          # list active overlays + their resolved symlinks
merlin overlay sync            # re-create symlinks for every registered overlay
merlin overlay remove <path>   # unlink a previously-added overlay
```

`add` walks the overlay repo's known subdirs and symlinks individual files
into the matching `_ext/` dir or `local/` location. It refuses to:

- symlink anything outside the declared `OVERLAY_MAP` destinations
  (definition in `bin/merlin` near `cmdOverlay`),
- overwrite a real (non-symlink) file at a destination,
- silently shadow a kernel file (kernel always wins).

State lives in `data/.overlay-registry.json` (gitignored).

### Expected layout of a personal overlay repo

```
merlin-personal/
  CLAUDE.md                 # → linked to local/CLAUDE.md
  jobs/
    mkt-ph-launch-monitor.md     # → agent/ops-agent/jobs/_ext/mkt-ph-launch-monitor.md
    ...
  harvesters/
    exercise.mjs                 # → agent/scripts/hum-harvesters/_ext/exercise.mjs
    ...
  tools-mcp/
    home-control.mjs             # → agent/tools-mcp/_ext/home-control.mjs
    ...
  bin/
    aso-rank-pulse-collect       # → bin/_ext/aso-rank-pulse-collect
    ...
  memory-seed/
    pari.md                      # → local/memory-seed/pari.md
    ...
```

Anything in the overlay repo outside these subdirs is silently ignored.

## Bidirectional flow in practice

### Pull kernel updates onto your mini

```bash
cd ~/Dev/merlin
git pull                       # symlinks survive; nothing to re-link
```

### Write a personal job

```bash
cd ~/Dev/merlin-personal
$EDITOR jobs/mkt-ph-launch-monitor.md
git commit -m "ph: weekend launch monitor" && git push
# Symlink already exists at merlin/agent/ops-agent/jobs/_ext/...
# Next dispatch picks it up.
```

### Promote a personal pattern into the kernel

When you notice a personal job/harvester is really a generic capability with
your data wired in:

```bash
cd ~/Dev/merlin
git checkout -b feature/extract-X
# 1. Build the generic version in the kernel location, reading data from
#    .env or data/<config>.json instead of hardcoded values.
# 2. Add the corresponding template under examples/.
# 3. Wire the overlay to provide the actual data via the registry it now reads.
# 4. Update the existing personal job to delegate to the kernel version.
git commit
gh pr create
# Pre-commit guard runs scan.py against your diff — would block if you
# accidentally left a personal reference behind.
```

### Onboard a new machine

```bash
git clone https://github.com/mraccah2/merlin && cd merlin
./bin/merlin init                                 # public bootstrap
./bin/merlin overlay add ~/Dev/merlin-personal    # only YOUR machines do this
./bin/merlin up
```

Outside contributors stop after `merlin init` and have a fully functional,
slightly-empty Merlin. They don't even see the overlay machinery exists
unless they read this doc.

## Guardrails — defense in depth

No single layer is sufficient. The boundary holds because **multiple
independent layers** each catch a different class of failure, and the cost
of each is roughly proportional to how often it catches a real bug.

### Layer 0 — Convention
File location at write time is the primary boundary. Generic code → merlin.
Personal code → merlin-personal. The decision happens before you press Enter.

### Layer 1 — `.gitignore`
Root has `local/`, `**/_ext/*` (with `!**/_ext/.gitkeep`), and
`*.local.{md,json}` for ad-hoc scratch. Mechanical; catches files you
forget to `git add`.

### Layer 2 — Pre-commit hooks (local)
`.pre-commit-config.yaml` runs two hooks on every commit:
- **`gitleaks`** — known credential formats.
- **`sanitize-guard`** — `.tools/sanitize-guard.py` against the
  `.tools/sanitize-guard-baseline.json` accepted-hit set. Blocks new
  personal-identifier hits. Pattern set visible via
  `.tools/sanitize-guard.py --list-patterns`.

Local hooks can be bypassed (fresh clone without `pre-commit install`, a
`git commit --no-verify`, a web-UI edit on github.com). The next layer is
the actual floor.

### Layer 3 — Server-side CI (cannot be bypassed)
`.github/workflows/secret-scan.yml` runs `gitleaks` on every PR + push to
main. `.github/workflows/sanitize-guard.yml` runs `.tools/sanitize-guard.py
--all` on every PR + push. A failed check blocks the merge.

### Layer 4 — Branch protection on `main`
- No force pushes.
- No deletions.
- Required conversation resolution.
- **Required status checks (TODO — set this once both workflows have run
  successfully on main at least once):**
  ```
  gh api -X PUT /repos/mraccah2/merlin/branches/main/protection \
    --input - <<EOF
  {
    "required_status_checks": {
      "strict": true,
      "contexts": ["sanitize-guard", "gitleaks"]
    },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false,
    "required_conversation_resolution": true
  }
  EOF
  ```

### Layer 5 — GitHub native protections
- **Secret scanning** — enabled. GitHub scans for known token formats from
  major providers (AWS, GitHub, Stripe, Slack, etc.).
- **Push protection** — enabled. GitHub blocks pushes containing recognized
  secret formats *before* they land, with author override prompts.

### Layer 6 — PR template + human review
Every PR opens with `.github/pull_request_template.md` and a checklist
forcing conscious attention on personal-content review and baseline diff
intent. Combined with Layer 6a (below), this is what catches
**paraphrased** or **narrative** personal content (e.g. "the property I
bought last year for $X" — no pattern fires).

### Layer 7 — Periodic audit
`merlin audit` (run monthly) walks every tracked file with the guard,
greps the last N commit messages for the same pattern set (commit
messages aren't scanned by the pre-commit hook), reports baseline drift
stats, and confirms no overlay content has been tracked through .gitignore
bypass. Surfaces drift before it accumulates into a forced-history-rewrite
incident.

### Layer 8 — Pattern set maintenance
Life evolves. Every time a new person/business/credential class enters
your operational scope, add a pattern to `PERSONAL_PATTERNS` in
`.tools/sanitize-guard.py` *before* the first commit that references it.
Otherwise the pattern won't catch the leak.

### Layer 9 — Personal repo isolation
The personal overlay repo has **no public remote.** Either keep it
local-only or push to a private GitHub/GitLab/etc. The `.env` template
documents `MERLIN_OWNER` and identity values — those live there, never in
code.

### Layer 10 — Post-incident reality
Once content is on github.com, assume it's permanent. Forks, archive
crawlers (Software Heritage, GHArchive), search caches, and AI training
datasets all retain copies. Mitigations (`git filter-repo`, force-push,
GitHub support cache clear) exist but are expensive and incomplete. The
only real fix is **never let it land in the first place** — i.e. layers
0–6 doing their job.

### Layer 6a — `merlin review-pr` (Claude-powered narrative review)

The pattern-based guard catches *explicit* identifiers. It cannot catch
content that, without using any of those tokens, still uniquely
identifies a real person, event, transaction, or relationship —
"the property I bought in 2024 for $X", "my partner's medical
condition", AI-generated docs that paraphrase personal context. That's
the gap `merlin review-pr` fills.

```bash
merlin review-pr <PR#>              # diffs PR via `gh pr diff`, prints findings
merlin review-pr --file <path>      # scan any text file
merlin review-pr --stdin            # accept a diff from stdin
merlin review-pr <PR#> --json       # machine-readable, for CI use
merlin review-pr <PR#> --model M    # override model (default claude-haiku-4-5)
```

The findings are categorized (`narrative_personal`, `specific_financial`,
`specific_event`, `geographic_reveal`, `relationship_reveal`,
`ai_generated_echo`, `other`) and severity-tagged
(`low` / `medium` / `high`), with a verdict (`ship` / `review` / `block`).
The exit code is non-zero on `block`, so the command is callable from CI.

**Cost.** Defaults to `claude-haiku-4-5` ($1/$5 per 1M in/out tokens). A
typical PR review runs ~$0.005-$0.02. Use `--model claude-opus-4-7`
for higher-confidence review on a high-stakes change.

**Auth.** Requires `ANTHROPIC_API_KEY` in env or `.env`. If you're on
Claude Max (Mode 2 in `merlin init`), inject the key transiently with
1Password or similar: `op run --env-file=.env.review-pr -- merlin
review-pr <N>`.

**Server-side companion.** `.github/workflows/narrative-review.yml` runs
the same check on every PR, posts findings as a PR comment, and is
**non-blocking by default**. Remove the `|| true` in the workflow to
make it blocking. Requires `ANTHROPIC_API_KEY` repo secret.

**Why a separate layer instead of merging into sanitize-guard.** The
pattern-based guard is deterministic, fast, free, and zero-dependency —
it must keep that posture so it stays in the pre-commit hook on every
clone. The LLM review is probabilistic, costs money, and depends on a
network call. Mixing them would either slow every commit or weaken the
guarantees the deterministic layer provides. Keep them separate so the
fast/cheap floor stays fast/cheap.

### What no layer here can catch

- **Past commits already on the public remote.** Layers 2/3 scan HEAD,
  Layer 6a scans diffs. Use `merlin audit` to scan commit messages back
  N commits, but full content-history audit (`git filter-repo` + force
  push + GitHub support cache clear) is a separate one-off operation.
- **Content in forks, mirrors, AI training datasets, archive crawlers
  (Software Heritage, GHArchive).** Out of scope of any tooling here.
  The only mitigation is **prevention** — Layers 0-6a doing their job.
- **False negatives in Layer 6a itself.** LLM review is probabilistic;
  a passage Claude judges generic may not be. Treat the verdict as one
  input to human review, not the final word.

## What goes in the kernel vs the overlay — heuristics

When you're writing a new feature and unsure where it belongs:

| If the feature… | …it goes in the | …because |
| --- | --- | --- |
| Names a real person, address, or business | overlay | Identity coupling is private by definition. |
| Reads from `.env` / config to learn who/what it serves | kernel | Configuration is data, not code. |
| Depends on a specific external account (your Supabase project, your Vercel team, your Cloudflare zone) | overlay | Account-specific data is private. |
| Depends on an integration *class* (Supabase generally, Vercel generally) where the user supplies their own credentials | kernel | Integration shape is generic; instance is overlay. |
| Encodes a routing/voice/safety rule that should apply to anyone running Merlin | kernel (CLAUDE.md) | Universal agent behavior. |
| Encodes a rule specific to your household, partner, business operations | overlay (`local/CLAUDE.md`) | Personal context. |
| Reads/writes to a hum harvester for "weather" or "news" or "calendar" | kernel | Generic life domains. |
| Reads/writes to a hum harvester for "PamperHomes guest reviews" or "Schwab portfolio" | overlay | Specific account data. |
| Is a CLI tool that takes a generic config | kernel (`bin/`) | Reusable. |
| Is a CLI tool that's a wrapper around your specific API account | overlay (`bin/_ext/`) | Account-specific. |

When still in doubt: write it in the overlay first. Moving overlay → kernel
(generalize) is easier than discovering you leaked identity coupling into
the public tree (retract).

## Migration from the gandalf monolith (one-time)

Phased over multiple PRs — see the project README's "Architecture" section
or ask the operator for the migration log. The short version:

1. **PR 1** (this PR) — establish the extension surface, loaders, overlay
   tool, sanitize-guard, and this document. No kernel content moves.
2. **PR 2** — port the kernel-pure improvements from gandalf into merlin
   (supervisor durable queue, intake-skip cascade, watchdog phantom-loop
   fix, etc.), using the new extension points where appropriate.
3. **PR 3** — bootstrap the merlin-personal repo: walk the gandalf
   redaction-plan's `exclude` and `generalize` buckets and move that
   content into the overlay shape above. Run merlin + overlay on the mini.
   Retire gandalf's process-manager.
4. **PR 4–6** — port docs (`F`), hum harvesters (`E`), and decide the
   companion-app scope (`A`).

After PR 3, `gandalf` ceases to exist as a separately-canonical thing —
merlin + the overlay *is* gandalf. The two-way path is fully open.
