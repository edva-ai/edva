# Hardening

For 24/7 deployment on a host that's running real workloads. Not required to try Merlin — the defaults are fine for local dev.

## Auth: Max-only mode

Default Merlin reads `ANTHROPIC_API_KEY` from `.env` and bills your API account per token. That's fine until two things become true:

1. Your bill is unpredictable (a runaway loop = a $400 surprise).
2. You're sure enough about the system that you want a flat-rate fail-stop instead of degraded silent operation.

At that point, switch to **Max-only**:

1. Subscribe to Claude Max.
2. Authenticate `claude` once on the host: `claude` → browser flow → confirms `~/.claude/.credentials.json`.
3. Remove `ANTHROPIC_API_KEY` from `.env` (delete the line or comment it).
4. In `agent/supervisor/claude-session.mjs`, the supervisor already strips `ANTHROPIC_API_KEY` from the child env on Max mode — but verify the `unsetEnv: ["ANTHROPIC_API_KEY"]` line is present (it is by default).
5. Restart: `merlin up` (or kick the launchd unit).

**The hard invariant in Max-only mode**: if Max becomes unavailable (expired login, network partition, quota exhaustion), **Merlin is down. Do not route around the failure.** The supervisors will not silently fall back to API-key calls. This is the point — the user sees the failure and acts (re-login, top up, etc.) rather than letting a degraded proxy quietly run up charges.

A `merlin status` check that returns "child not alive — last error: max-credentials-expired" is the design.

## Outbound precheck

Already on by default. Worth understanding what it does.

Every programmatic phone-channel message that flows through `bin/merlin-send-curl` is routed through `bin/outbound-precheck.mjs` — a Sonnet `--effort low` reasoner that sees the last 90 min of phone-channel chat + active calendar and decides `send` / `suppress` / `modify` before the message ships.

Why: programmatic harvesters write user-facing text in code with no awareness of what the user just said. The precheck catches things like "going to the gym soon" pings that arrive 20 min after the user texted "already at the gym."

`--skip-precheck` is reserved for **infrastructure liveness alerts only** — supervisor crash, watchdog process-died, channel-down. Reason: a stuck supervisor must be able to alert about being stuck even if Sonnet/Supabase (the precheck's dependencies) are exactly what's stuck.

Read [`agent/CLAUDE.md` § Outbound Precheck](../agent/CLAUDE.md) for the full rule.

## Memory-write precheck

Same shape, different gate. Before saving new facts to a wiki page, `bin/memory-write-precheck.mjs` searches existing memory for direct contradictions and asks Sonnet to adjudicate.

Default behavior: **fail-open** — any error in the precheck (timeout, Sonnet down, malformed reply) lets the write proceed. Better an occasional stale write than a broken pipeline that can't save anything.

To wire it into a job's write path:

```bash
echo '{"page_id":"reference_x","content":"new fact","intent":"job-name"}' \
  | ${MERLIN_HOME}/bin/memory-write-precheck.mjs
# emits {"decision":"save","reason":"…"} or {"decision":"conflict",…}
```

Jobs that write to memory should check `decision: conflict` and either surface to the user or skip the write.

## Secrets: 1Password-managed (optional)

If you want to keep `.env` minimal and pull secrets at runtime from a vault:

1. Install the `op` CLI (`brew install 1password-cli`).
2. Create a 1Password Service Account, scope it to a single vault.
3. Set `OP_SERVICE_ACCOUNT_TOKEN` in `.env`.
4. Replace each secret line in `.env` with a reference:
   ```
   SUPABASE_SERVICE_ROLE_KEY="$(op read 'op://Vault/Supabase Service Role/credential')"
   ```
5. Source `.env` via `op run` instead of plain dotenv:
   ```bash
   op run --env-file=.env -- ./bin/merlin up
   ```

This keeps the actual secrets out of `.env` (which is gitignored but still plaintext on disk) and into the vault.

## File permissions

Set tight permissions on the secret-bearing files:

```bash
chmod 600 .env secrets/* credentials/*
chmod 700 secrets credentials
```

The bootstrap script does NOT do this automatically (different conventions on different platforms). Worth running once after `merlin init`.

## Disable channels you don't use

`agent/config/agents.json` declares which MCP servers + channels each agent role loads. If you're not using Gmail Pub/Sub, drop the gmail-channel entry — fewer moving parts, fewer surfaces to keep auth fresh on.

Same for the phone-channel if you're not running the companion app, the dispatch-bridge if you're not pushing system alerts into chat, etc. Each channel is independently optional.

## Watchdog cadence

`agent/scripts/watchdog.sh` runs every 2 min by default (from your crontab if you wire it). It implements the heal-then-alert pattern: probe-fail → self-heal → re-probe → only escalate after the heal demonstrably fails.

The two knobs:

- `WATCHDOG_INCIDENT_COOLDOWN_S` — minimum seconds between identical alerts. Default 86400 (24h). Prevents alert spam from a persistent failure.
- `WATCHDOG_QUIET_START` / `WATCHDOG_QUIET_END` — hours (24h local time) where the watchdog suppresses non-urgent alerts. Default unset (no quiet window). Set to `0,9` to suppress alerts overnight.

## launchd / systemd: install as a service

For real always-on:

- **macOS**: see `docs/installer.md` (TODO — will copy `system/services.json` entries into `~/Library/LaunchAgents/*.plist`).
- **Linux**: see `docs/installer.md` (TODO — `.service` files for `systemd --user`).

Until that doc lands, manually:

```bash
# Sketch for macOS — copy the labels from system/services.json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.merlin.session.plist
launchctl kickstart gui/$(id -u)/ai.merlin.session
```

## What to monitor in production

- `merlin status` — should show all supervisors alive, child uptime > 0
- `merlin doctor` — should report `0/N failing`
- `merlin cost-report --today` — per-job cost attribution; flags runaway loops
- Disk space on `data/` — the SQLite memory + wiki + ndjson logs grow over time. `data/memory-db-snapshots/` rotates to 24 (~hourly), but if you have novel jobs writing ndjson with no rotation, set up logrotate.

## Backups

Two things you cannot lose without pain:

1. **The auto-memory corpus** — your `.claude/projects/<project-slug>/memory/` directory. The `memory-snapshot` job pushes this to `${MERLIN_BACKUP_REPO}` every 30 min. Make sure that env var points at a private repo, and that the repo has push access from your host's git config.
2. **The wiki DB** — `data/memory-index.db`. The `wiki-db-snapshot` job hot-snapshots this hourly into `data/memory-db-snapshots/` (rotated to 24). Local-only — pair with a periodic off-host backup of `data/` if you care.

Everything else (logs, hum state, email memory, etc.) is rebuildable.
