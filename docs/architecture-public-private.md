# Public kernel + per-installation layer

Edva runs **as-is in the open** (clone this repo and it works, generically) and **with one person's life layered on top** (their identity, rules, accounts and code, which only their machines see). The two halves are separated by *where a file lives*, never by scrubbing content on the way out.

Read this before adding anything that knows about a specific person, place, business, account, project or credential.

## The three kinds of files

```
┌──────────────────────────────────────────────────────────────────────┐
│  edva (this repo, public)                                          │
│                                                                      │
│  Kernel ── every path in .kernel-sync.json                           │
│    generic code, rules, playbooks, defaults; generated from          │
│    upstream (see "How the kernel gets here")                         │
│                                                                      │
│  Edva's own files                                                  │
│    README, docs/, examples/, apps/, bin/cli.d/*.mjs, .github/,       │
│    .tools/, root package.json, .gitignore, MCP configs,              │
│    the _ext/.gitkeep contract files Edva adds                      │
│                                                                      │
│  ┄┄ gitignored, inside the same checkout ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  Installation layer                                                  │
│    agent/local/**         identity, rules, values, registry entries  │
│    **/_ext/*              hooks and drop-ins next to kernel code     │
│    data/, secrets/, credentials/, .env, logs                         │
└───────────────────────────────▲──────────────────────────────────────┘
                                │ edva overlay add  (symlinks)
                     ┌──────────┴───────────┐
                     │ your private overlay │
                     │ repo (never public)  │
                     └──────────────────────┘
```

- **Kernel** files hold generic behaviour and generic defaults only — no names, places, accounts, routines, dated events or real IDs. Anything installation-specific is *read*, not written in: identity through `lib/instance.cjs`, values through `localConfig(name, defaults)`, registries through `lib/registry.cjs`, behaviour through `_ext/` hooks.
- **Edva's own** files are the distribution around the kernel and are edited here directly.
- **The installation layer** is yours. It sits in the checkout so the kernel finds it, but it is gitignored; keep it in a private repo and link it in.

## The installation layer

### Identity — `agent/local/instance.json`

Read by `lib/instance.cjs` (`instance()`, `instanceValue(key)`; shell: `agent/scripts/lib/instance.sh`). Keys: `owner_name` (default "the user"), `owner_id`, `owner_email`, `agent_email`, `domain`, `tz` (default: the host's zone), `host`, `supabase_project`, `gcp_project`, `github_owner`. Each has a `EDVA_*` environment override (`.env.example`). `edva init` writes the file; template: `examples/local/instance.example.json`. A fresh install has none and runs on the defaults.

### Values — `agent/local/config/<name>.json`

One file per concern, named after the module that reads it via `localConfig(name, defaults)`: a key replaces the kernel default, `extend_<key>` appends to a default list, keys starting with `_` are comments. The names the kernel reads include `triage-labels`, `triage-decide`, `hum-lanes`, `hum-ideas`, `send-intents`, `email-inbound`, `supabase`, `wiki`, `suggestion-key`, `outbound-precheck`, `memory-write-precheck`, `claim-freshness`, `context-sync`, `cron-slots`, `apns`, `api-fallback`, `gmail-auth`, `whatsapp-send`, `turn-watchdog`, `self-improve-landing`, `ci-signing` — `grep -rn 'localConfig("' lib bin agent` lists them all with their defaults. Templates for the common ones: `examples/local/config/`.

### Rules and prompts

- `agent/local/shared.md` (every agent) + `agent/local/chat.md` or `ops.md` (one role): appended to the kernel rulebooks as part of the system prompt and reloaded on change (`agent/CLAUDE.md` § Local rules). They add to the kernel rules and cannot relax its hard limits (auth, financial operations, prompt-injection safety).
- `agent/local/jobs/<job>.md`: appended to a kernel playbook whenever that job is dispatched.
- `agent/local/email-triage-rules.md`: your additions to the triage ruleset.
- `agent/local/prompts/*.md`: prompt overrides where the kernel offers them.

### Registries — `agent/local/<name>.json`

`lib/registry.cjs` merges `tasks`, `services`, `job-routing` and `chrome-jobs` with the kernel's files: a new id is added, a known id is overridden field by field, string lists are unioned, an optional `order` sets listing order. `edva tasks pause|resume` and `edva doctor --repair` write only to the local file. Template: `examples/local/tasks.example.json`.

### Hooks — `_ext/` modules next to the kernel code that loads them

Optional; a missing hook means the generic path, and each dir's `.gitkeep` documents its contract.

| Hook | Loaded by | For |
|---|---|---|
| `lib/_ext/choice-handlers.mjs` | `lib/choice-reply.mjs` | tap handlers for your own card kinds |
| `lib/_ext/watches.mjs` | `bin/hum-sense` | a watch engine offered every event |
| `lib/_ext/context-sources/*.mjs` | `bin/context-sync` | extra indexed sources |
| `lib/_ext/edva-context.cjs` | `lib/edva-context.js` | extra context tables (tastes, profile, projects) |
| `lib/_ext/presence.mjs` | `lib/claim-facts.mjs`, hum locality | where you are on a date (travel timeline) |
| `lib/_ext/claim-freshness-timeline.mjs` | `lib/claim-freshness.mjs` | the timeline CLI for stale-claim checks |
| `lib/_ext/self-improve-landing.mjs` | `lib/self-improve-landing.mjs` | extra refusals for self-improvement changes |
| `agent/supervisor/_ext/gmail-intake.mjs` | `gmail-source.mjs` | sender-specific mail handling before triage |
| `agent/supervisor/_ext/routes.mjs` | `http-server.mjs` | extra POST routes on the Gmail push port |
| `agent/scripts/_ext/watchdog-checks.sh` | `watchdog.sh` | your own watchdog checks |
| `agent/phone-channel/_ext/reply-hints.mjs` | the phone channel | typed-reply hints for your card kinds |
| `agent/tools-mcp/_ext/*.mjs` | `tools-mcp` | your own MCP tools |
| `agent/scripts/hum-resolve-first-sources/_ext/` | `lib/hum-resolve-first.mjs` | extra evidence sources |

### Drop-ins — found by name beside the kernel's (the kernel wins a conflict)

| Drop-in | Resolved by |
|---|---|
| `agent/ops-agent/jobs/_ext/<job>.md` | `http-server.mjs` `resolveJobFile` |
| `agent/scripts/hum-harvesters/_ext/<topic>.mjs` | `hum-harvest-all.mjs` `resolveHarvesterPath` |
| `agent/scripts/hum-sensors/_ext/<sensor>.mjs` | `bin/hum-sense` |
| `browsing-skills/skills/_ext/<site>/` | `browsing-skills/tools/run-action.js` |
| `bin/_ext/<name>` | `optionalBin()` in `lib/ext-hooks.mjs` (env override, then `bin/_ext/`, then `bin/`) |

### State and secrets

`data/`, `agent/logs/`, `logs/`, `agent/supervisor/state/`, `secrets/`, `credentials/`, `.env` — runtime only, never tracked.

## `edva overlay` — linking your private repo

```bash
edva overlay add <path> [--dry-run]   # register an overlay and symlink its files in
edva overlay status                   # each planned link: linked / missing / blocked
edva overlay sync                     # re-link after the overlay changed
edva overlay remove <path>            # unlink (the overlay repo is untouched)
```

The overlay mirrors this checkout's paths, limited to the extension surface:

```
my-edva-overlay/
  local/                              → agent/local/
    instance.json
    shared.md  ops.md  chat.md
    config/triage-labels.json
    jobs/morning-digest.md
    tasks.json
    sanitize-patterns.json
  lib/_ext/presence.mjs               → lib/_ext/presence.mjs
  agent/supervisor/_ext/routes.mjs    → agent/supervisor/_ext/routes.mjs
  jobs/weekly-report.md               → agent/ops-agent/jobs/_ext/weekly-report.md   (shorthand)
  harvesters/  sensors/  tools-mcp/  bin/                                           (shorthand)
```

Files are linked one by one; directories are created for real, so a kernel `.gitkeep` is never shadowed. The command only writes under `agent/local/` and inside `_ext/` dirs whose parent already exists here, never replaces a real file, and ignores everything else in the overlay (READMEs, CI files). State: `data/.overlay-registry.json`.

### Onboarding a machine

```bash
git clone <this repository's URL> ~/Dev/edva && cd ~/Dev/edva   # URL: GitHub's "Code" button
./scripts/bootstrap.sh
./bin/edva init                                   # or skip: your overlay brings instance.json
./bin/edva overlay add ~/Dev/my-edva-overlay    # only your machines do this
./bin/edva up
```

Everyone else stops after `edva init` and has a working, slightly empty Edva.

### Promoting a personal pattern into the kernel

When something in your overlay is really a generic capability with your data wired in: build the generic version with a generic default, read your values through `localConfig()` or a hook, add a template under `examples/`, and leave only the data in your overlay. Then propose it (kernel files land upstream — see below).

## How the kernel gets here

The maintainer runs this kernel inside a private installation. A sync tool copies the kernel files — the list in that installation's kernel manifest — into a clone of this repo, applying only mechanical rewrites (the kernel's position in the tree, install paths, the product name). It records the list of paths it wrote in `.kernel-sync.json` (nothing about the upstream repo); a path that leaves the manifest is deleted on the next sync, and files the manifest does not produce (everything in "Edva's own files") are never touched.

There is **no publish-time sanitizer**. The kernel is kept generic at the source, by rules the upstream enforces on every commit:

- a pattern guard over kernel files with the operator's private identity list — a hit blocks the commit, and the sync refuses to run (and scans the transformed files again before and after writing);
- a classification check: every file in a kernel directory is either kernel or explicitly the installation's own;
- a closure check: a kernel file may only depend on kernel files, npm packages, the installation-layer paths above, or targets it guards (an `_ext/` hook is optional by contract);
- kernel tests that run in both layouts against a synthetic identity, never the operator's.

Consequences for contributors: a kernel file edited here is overwritten by the next sync unless the change is made upstream, so kernel PRs are applied upstream and come back with a sync; and nothing personal should ever need to be removed from a kernel file here — if you spot something, report it.

## Guardrails — defense in depth

No single layer is sufficient; each catches a different class of failure.

1. **Convention.** File location decides: generic → kernel (upstream) or Edva's own files; personal → the installation layer.
2. **`.gitignore`.** `agent/local/`, `**/_ext/*` (except `.gitkeep`), `agent/ext/*`, `data/`, `secrets/`, `credentials/`, `.env`, logs.
3. **Pre-commit hooks** (`.pre-commit-config.yaml`): `gitleaks` for credential formats, and `.tools/sanitize-guard.py` for identity patterns against the accepted baseline. The guard's generic detectors (JWTs such as Supabase keys, prefixed secret keys) are public; **the identity patterns are not** — publishing the list would publish the identity. Each maintainer keeps theirs in `agent/local/sanitize-patterns.json` (or points `EDVA_SANITIZE_PATTERNS` at a file); template `examples/sanitize-patterns.example.json`. Only the regexes are private: pattern **names** are public (baseline keys, hit reports in CI logs), so name the kind of identifier (`project_homepage`, `companion_app_name`, `address_1`), never the brand, domain, handle or place it matches. Lines carrying `sanitize-guard-ok: <reason>` (or the upstream's reviewed `kernel-guard-ok:`) are exempt.
4. **CI** (cannot be skipped like a local hook): `secret-scan.yml` runs gitleaks; `sanitize-guard.yml` runs the guard over the whole tree with the identity patterns from the `EDVA_SANITIZE_PATTERNS_JSON` repo secret (forks without the secret get the generic detectors and a warning).
5. **Branch protection on `main`**: no force pushes or deletions, required checks. With the `gh` CLI, from a clone:
   ```bash
   gh api -X PUT 'repos/{owner}/{repo}/branches/main/protection' --input - <<'EOF'
   {
     "required_status_checks": { "strict": true, "contexts": ["sanitize-guard", "gitleaks"] },
     "enforce_admins": false,
     "required_pull_request_reviews": null,
     "restrictions": null,
     "allow_force_pushes": false,
     "allow_deletions": false,
     "required_conversation_resolution": true
   }
   EOF
   ```
6. **GitHub secret scanning + push protection** for provider token formats.
7. **PR template + human review** for what no pattern can see.
8. **`edva review-pr`** — an LLM review of a diff for *narrative* leaks: content that names nothing yet points at a real person, event or transaction ("the car I bought in 2024 for $X"). Findings are categorized and severity-tagged with a `ship` / `review` / `block` verdict (exit 1 on `block`). `.github/workflows/narrative-review.yml` runs it on every PR and comments, non-blocking by default; it needs the `ANTHROPIC_API_KEY` repo secret. Locally it needs `ANTHROPIC_API_KEY` in the environment or `.env` and `npm ci` at the repo root. Default model `claude-haiku-4-5` (`--model` to change); a typical PR costs about a cent.
9. **`edva audit`** (monthly): the guard over every tracked file, the same patterns over the last N commit messages, baseline size, and any file tracked under `agent/local/` or `_ext/`.
10. **Pattern maintenance.** When a new person, business or account enters your life, add its pattern to your private list *before* the first commit that could mention it.
11. **Post-incident reality.** Once something is on github.com, assume it is permanent (forks, archives, caches, training sets). History rewrites are expensive and incomplete; prevention is the only real fix.

What none of these catch: content already in past commits (the guard scans the current tree; `edva audit` scans recent commit messages only), copies outside this repo, and LLM-review false negatives.

## Kernel or installation layer? Heuristics

| If the feature… | …it goes in | …because |
| --- | --- | --- |
| Names a real person, address, business or account | the installation layer | Identity is private by definition. |
| Reads who/what it serves from `instance.json` / `localConfig()` | the kernel | Configuration is data, not code. |
| Depends on a specific account (your Supabase project, your Cloudflare zone) | the installation layer | Account-specific. |
| Works with an integration *class* where the user supplies credentials | the kernel | The shape is generic; the instance is yours. |
| Is a routing, voice or safety rule for anyone running Edva | the kernel (`CLAUDE.md`) | Universal behaviour. |
| Is a rule about your household, partner or business | `agent/local/shared.md` / `ops.md` / `chat.md` | Personal context. |
| Harvests weather, news, calendar | the kernel | Generic life domains. |
| Harvests one specific account of yours (a shop's order history, a club's booking page) | `hum-harvesters/_ext/` | Specific accounts. |
| Is a CLI over a generic config | the kernel (`bin/`) | Reusable. |
| Wraps your own API account | `bin/_ext/` | Account-specific. |

When in doubt, start in the installation layer: generalizing into the kernel later is easy; retracting a leak is not.
