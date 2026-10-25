# Contributing

Edva is the open-source extraction of a working personal-agent setup. Contributions are welcome with the caveat that the project has strong opinions; not all PRs will land. Read on for what's encouraged + what isn't.

## How this repo is put together

- **The kernel** — every file listed in [`.kernel-sync.json`](.kernel-sync.json) — is generated: the maintainer runs the same kernel in a private installation and a sync tool copies it here mechanically (path and brand rewrites only), behind a guard that refuses personal data. PRs against kernel files are welcome; they land by being applied upstream and arriving with the next sync, so keep them small and self-contained. Don't hand-edit a kernel file in a PR that also does other things.
- **Edva's own files** — this README and the docs, `examples/`, `apps/`, `bin/cli.d/*.mjs` (Edva's own `edva` subcommands), `.github/`, `.tools/`, the root `package.json`, `.gitignore`, the MCP configs (`agent/supervisor/chat-mcp-config.json`, `agent/ops-*-agent/.mcp.json`) and the `_ext/.gitkeep` contract files Edva adds. These are edited here directly.
- **An installation's own files** — `agent/local/` and everything in an `_ext/` dir — are gitignored and never belong in a PR. See [`docs/architecture-public-private.md`](docs/architecture-public-private.md).

## What we'd love help with

- **New ingress channels** — Slack, Discord, SMS (Twilio), Matrix, RSS-via-poller. Drop a new package under `agent/<name>-channel/` matching the contract in `agent/CLAUDE.md` and the channel descriptions in `system/architecture.md`.
- **New reference jobs** — non-trivial markdown playbooks that demonstrate a useful pattern (RSS-watcher, repo-summary, calendar-aware reminders, etc.). Propose them under `agent/ops-agent/jobs/` + an entry in `system/tasks.json` (kernel files — see above), or ship them as an example overlay (`jobs/_ext/`).
- **More hum harvesters** — additions to `agent/scripts/hum-harvesters/` that read a real data source and emit candidates in the standard shape.
- **Integration docs** — write `docs/integrations/<service>.md` for any external service you wire up (Notion, Linear, GitHub Issues, Discord, anything).
- **Cross-platform fixes** — Linux/Windows-Subsystem-for-Linux compatibility for things that currently assume macOS.
- **Tests** — `tests/` and `agent/test/` (chaos simulator + mock harness); more coverage is always welcome, especially around restart semantics and crash recovery.
- **Bug fixes** — anything that doesn't match the documented behavior.

## What we probably won't accept

- **Reverting to per-tool permission prompts.** The supervisors run in `bypassPermissions` mode by design. The layered safety lives in `CLAUDE.md` rules + the outbound precheck, not in per-action prompts. If you have a security concern, please file it per `SECURITY.md` first.
- **Adding a new top-level abstraction without an existing problem it solves.** "What if Edva supported X" PRs that don't trace to a real workflow get politely declined.
- **Tighter coupling to a specific commercial API.** Where possible, integrations should be opt-in plugins with a clear contract — not directly imported into the kernel.
- **Reintroducing personal-specific tools.** This repo deliberately ships a minimal set of working backends; PRs that hardcode someone's home-automation or fitness tracker won't merge. Build it behind a hook in your own `_ext/` dir or `agent/local/config/`, document the pattern in `docs/integrations/`, and link it from the README.
- **Bumping the bypass — disabling outbound precheck, financial limits, prompt-injection rules — on the rationale that they're slow or annoying.** They're load-bearing. Speed them up, sure. Bypass them, no.

## Development setup

The README quickstart is the development setup. There's no separate dev environment — the same `./scripts/bootstrap.sh && ./bin/edva init && ./bin/edva up` flow gets you a working agent.

For changes you want to test without going through the supervisor:

```bash
# Direct CLI invocations
node bin/edva status
node bin/edva doctor

# Direct supervisor invocation
node agent/supervisor/index.mjs --agent ops

# Test suites (node:test)
node --test tests/*.test.mjs agent/test/*.test.mjs

# Public/private boundary checks
python3 .tools/sanitize-guard.py --all
node bin/edva audit
```

A few tests need macOS, launchd or a live supervisor and fail in a Linux container (for example `fork-cost-ledger`, `hum-scheduled-senders-launchd`, `launchd-kick-self-install`, `edva-logs-window`, `system-issue-writeback`, `watchdog-disk-free`); `resource-leak` is timing-sensitive.

## Pull-request checklist

- [ ] `node --check` on every modified `.js` / `.mjs` file passes.
- [ ] If you changed agent behavior or added a job, the corresponding doc (`agent/CLAUDE.md`, `agent/ops-agent/CLAUDE.md`, `agent/ops-agent/jobs/<job>.md`, `system/architecture.md`) is updated **in the same PR**. (Self-awareness Rule #1 — Edva learns its state from the repo, not from `git log`.)
- [ ] No new hardcoded paths — use `lib/root.cjs` (`installRoot()`, `installTools()`, `toolsPath()`) in Node and `agent/scripts/lib/root.sh` in shell.
- [ ] No identity or per-installation values in kernel code — read them through `lib/instance.cjs` (`instance()`, `localConfig(name, defaults)`) with generic defaults.
- [ ] No personal identifiers in commit messages or content — assume your PR will be read by strangers indefinitely. `python3 .tools/sanitize-guard.py` passes (the pre-commit hook runs it; see `docs/architecture-public-private.md` for the private pattern list).
- [ ] If you touched the secret surface (new env vars, new auth flow), `.env.example` updated + a sentence in `docs/hardening.md` if relevant.

## Commit messages

- Subject line ≤72 chars, imperative voice: "add Slack ingress channel" not "added" or "adds".
- Body explains WHY when the change isn't obvious, not WHAT (the diff shows the what).
- `Co-Authored-By:` lines for pair programming or agent assistance are welcome.

## Code style

There isn't a formal style guide. Follow what's already in the file you're editing. Specifics:

- **JavaScript**: Node 22.5+. CommonJS in older files, ESM (`.mjs`) in newer. Keep matching style.
- **Bash**: `set -euo pipefail` for any non-trivial script. Use `${VAR:?error message}` for required vars.
- **Markdown playbooks**: lead with one-sentence purpose. Numbered steps. Show commands literally inside code fences.
- **Swift (companion app)**: SwiftUI + Swift 6, strict concurrency. Match the existing target's idiom.

## Process-manager / supervisor changes

These are load-bearing. PRs that touch `agent/bin/process-manager.mjs`, `agent/supervisor/*.mjs`, or `agent/lib/managed-process.mjs` should:

1. Pass the test suites: `node --test tests/*.test.mjs agent/test/*.test.mjs`.
2. Document the restart-semantics impact (inner-child rotation vs supervisor respawn vs init respawn).
3. Avoid breaking the env-var-substitution path for `.mcp.json` — agents depend on it.

## Sub-agent / model choice

The agents run on Claude. If your change spawns sub-agents:

- Use `--effort low` for high-volume sub-calls (matches existing pattern in `agent/scripts/hum-harvesters/`).
- Keep model choices in code (not env) so they're auditable.
- Don't add a new path that calls the Anthropic SDK directly — go through `claude -p`. This keeps the Max-only hardening profile coherent.

## License

By contributing, you agree your contribution is licensed under Apache 2.0 (the project's license). No CLA.

## Questions

- Architecture questions: open a discussion thread.
- Bug reports: open an issue with steps to reproduce.
- Security: see `SECURITY.md`.
- Anything else: start with an issue describing the problem before you write code.

We respond when we can. This is a side-project for everyone involved — please be patient.
