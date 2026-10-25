# Hardening

For a host running Edva around the clock. None of this is needed to try it.

## Auth: Max only, fail-stop

The agents run on a Claude Max login and nothing else ([`agent-auth-model.md`](agent-auth-model.md)):

- The supervisors spawn `claude -p` with `ANTHROPIC_API_KEY` removed from the child environment (`unsetEnv` in `agent/supervisor/claude-session.mjs`), so a key in `.env` can never make an agent bill per token.
- Ephemeral forks (the weekly review, improvement plan, system-issue review) source `agent/scripts/lib/max-auth-guard.sh`, which clears every `ANTHROPIC_*` variable and refuses to start unless `claude auth status` reports a first-party Max login.
- If Max is unavailable — expired login, quota, network — **Edva is down by design.** It alerts instead of routing around the failure. Re-login with `claude` on the host.

The single exception is the wiki's answer panel, which may fall back to the API under a monthly cap with its own key (`EDVA_WIKI_API_KEY`, `lib/api-fallback.mjs`); leave the key unset, or set `WIKI_API_FALLBACK=0`, to keep everything on Max.

## Outbound precheck

On by default. Every programmatic message to your phone that goes through `bin/edva-send-curl` is reviewed by `bin/outbound-precheck.mjs` — a low-effort model call that reads the recent conversation and calendar and decides `send` / `suppress` / `modify`. It catches pings written in code that no longer fit ("time for the gym" twenty minutes after you said you were there).

`--skip-precheck` is for infrastructure-liveness alerts only (a supervisor crashed, a channel is down): those must get out even when the precheck's own dependencies are what failed. Private intents (bank, health, your own — `agent/local/config/send-intents.json`) skip the model call and are never sent to an external judge. The full rule: `agent/CLAUDE.md` § Outbound Precheck.

## Memory-write precheck

Before an agent-initiated write to the wiki, `bin/memory-write-precheck.mjs` looks for direct contradictions in existing memory and asks a model to adjudicate. It fails open: a broken precheck lets the write through rather than blocking every save.

```bash
echo '{"page_id":"reference_x","content":"new fact","intent":"job-name"}' \
  | ~/Dev/edva/bin/memory-write-precheck.mjs
# {"decision":"save",…} or {"decision":"conflict",…}
```

## Secrets

`.env` is plaintext on disk. At minimum:

```bash
chmod 600 .env secrets/* credentials/*
chmod 700 secrets credentials
```

(`edva init` writes `.env` and `secrets/webhook-token` as `600`; files you create by hand need it.)

To keep the values out of `.env` entirely, resolve them from a password manager when the stack starts. With 1Password's CLI and a service account scoped to one vault, for example, start the process manager under `op run` with an env file whose values are secret references, or export each one in the launcher:

```bash
export SUPABASE_SERVICE_ROLE_KEY="$(op item get 'Supabase service role' --fields credential --reveal)"
```

The process manager only fills variables that are not already in its environment, so values exported this way win over `.env`.

## Keep your own layer out of the public tree

`agent/local/` (identity, rules, config) and the `_ext/` dirs (your code) are gitignored. Keep them in a **private** repo and link it with `edva overlay add <path>`; never `git add -f` them. Run `./bin/edva audit` now and then: it runs the sanitize guard over every tracked file, scans recent commit messages and lists anything tracked under `agent/local/` or `_ext/`. Contributors keep their identity patterns for the guard in `agent/local/sanitize-patterns.json` (template `examples/sanitize-patterns.example.json`).

## Turn off what you don't use

- **MCP servers** — `agent/supervisor/chat-mcp-config.json` (chat), `agent/ops-light-agent/.mcp.json` and `agent/ops-haiku-agent/.mcp.json`, plus your own `agent/ops-agent/.mcp.json` (from `examples/mcp/`). Drop the Supabase server if you don't use Supabase; fewer servers, fewer credentials to keep fresh.
- **Channels** — the phone channel (companion app), WhatsApp and the dispatch bridge are separate processes under the process manager; each is optional.
- **Scheduled jobs** — pause a kernel task with `./bin/edva tasks pause <name>` (written to `agent/local/tasks.json`).

## Watchdog

`agent/scripts/watchdog.sh` runs every 2 minutes from cron and follows heal-then-alert: probe, self-heal, re-probe, and alert only when the heal demonstrably failed, with per-incident cool-downs (`./bin/edva watchdog` lists open incidents). Disk thresholds: `WATCHDOG_DISK_WARN_GIB` / `WATCHDOG_DISK_CRIT_GIB`. Your own checks go in `agent/scripts/_ext/watchdog-checks.sh` (contract in that dir's `.gitkeep`).

## What to monitor

- `./bin/edva status` — every supervisor alive, child uptime above zero.
- `./bin/edva doctor` — zero failing checks.
- `./bin/edva cost` and `bin/edva-cost-report` — per-job usage; flags runaway loops.
- Free disk under `data/` — SQLite stores and ndjson logs grow; the watchdog alerts on low disk.

## Backups

Two things you cannot rebuild:

1. **The auto-memory corpus** — `~/.claude/projects/<slug>/memory/`. Make it a git repo with a private remote; `memory-snapshot` commits and pushes it on a schedule ([`memory.md`](memory.md) § Backup).
2. **The wiki DB** — `data/memory-index.db`. `wiki-db-snapshot` keeps rotating hot snapshots in `data/memory-db-snapshots/`; pair it with an off-host copy of `data/`.

And your **overlay repo** (`agent/local/` + `_ext/`), which is just a git repo — push it somewhere private. Everything else (logs, hum state, caches) is rebuildable.
