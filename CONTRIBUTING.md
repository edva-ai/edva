# Contributing

Merlin is the open-source extraction of a working personal-agent setup. Contributions are welcome with the caveat that the project has strong opinions; not all PRs will land. Read on for what's encouraged + what isn't.

## What we'd love help with

- **New ingress channels** — Slack, Discord, SMS (Twilio), Matrix, RSS-via-poller. Drop a new package under `agent/<name>-channel/` matching the contract in `agent/CLAUDE.md` and the channel descriptions in `system/architecture.md`.
- **New reference jobs** — non-trivial markdown playbooks that demonstrate a useful pattern (RSS-watcher, repo-summary, calendar-aware reminders, etc.). Land them under `agent/ops-agent/jobs/` + add an entry to `system/tasks.json`.
- **More hum harvesters** — additions to `agent/scripts/hum-harvesters/` that read a real data source and emit candidates in the standard shape.
- **Integration docs** — write `docs/integrations/<service>.md` for any external service you wire up (Notion, Linear, GitHub Issues, Discord, anything).
- **Cross-platform fixes** — Linux/Windows-Subsystem-for-Linux compatibility for things that currently assume macOS.
- **Tests** — `agent/test/` has a chaos simulator + mock harness; the kernel could use more coverage, especially around restart semantics and crash recovery.
- **Bug fixes** — anything that doesn't match the documented behavior.

## What we probably won't accept

- **Reverting to per-tool permission prompts.** The supervisors run in `bypassPermissions` mode by design. The layered safety lives in `CLAUDE.md` rules + the outbound precheck, not in per-action prompts. If you have a security concern, please file it per `SECURITY.md` first.
- **Adding a new top-level abstraction without an existing problem it solves.** "What if Merlin supported X" PRs that don't trace to a real workflow get politely declined.
- **Tighter coupling to a specific commercial API.** Where possible, integrations should be opt-in plugins with a clear contract — not directly imported into the kernel.
- **Reintroducing personal-specific tools.** This repo deliberately ships a minimal set of working backends; PRs that hardcode someone's home-automation or fitness tracker won't merge. Add it as a reference integration in your fork, document the pattern in `docs/integrations/`, and link it from the README "Community integrations" section.
- **Bumping the bypass — disabling outbound precheck, financial limits, prompt-injection rules — on the rationale that they're slow or annoying.** They're load-bearing. Speed them up, sure. Bypass them, no.

## Development setup

The README quickstart is the development setup. There's no separate dev environment — the same `./scripts/bootstrap.sh && ./bin/merlin init && ./bin/merlin up` flow gets you a working agent.

For changes you want to test without going through the supervisor:

```bash
# Direct CLI invocations
node bin/merlin status
node bin/merlin doctor

# Direct supervisor invocation
node agent/supervisor/index.mjs --agent ops

# Direct test runner
node agent/test/chat-supervisor.test.mjs
```

## Pull-request checklist

- [ ] `node --check` on every modified `.js` / `.mjs` file passes.
- [ ] If you changed agent behavior or added a job, the corresponding doc (`agent/CLAUDE.md`, `agent/ops-agent/CLAUDE.md`, `agent/ops-agent/jobs/<job>.md`, `system/architecture.md`) is updated **in the same PR**. (Self-awareness Rule #1 — Merlin learns its state from the repo, not from `git log`.)
- [ ] No new hardcoded paths — use `${MERLIN_HOME}` / `process.env.MERLIN_HOME` / `path.join(MERLIN_HOME, ...)`.
- [ ] No personal identifiers in commit messages or content — assume your PR will be read by strangers indefinitely.
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

1. Pass the kernel test suite: `for t in agent/test/*.test.mjs; do node "$t"; done`.
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
