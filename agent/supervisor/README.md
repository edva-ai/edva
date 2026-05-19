# supervisor

Stream-json wrapper for the Merlin ops-agent. Spawns `claude -p` with structured I/O, parses events, dispatches messages via HTTP.

## Why this exists

Before: ops-agent ran in a tmux pane. Gmail pushes arrived via `gmail-channel` MCP server which emitted `notifications/claude/channel` to nudge the agent. Watchdog detected stuck states by regex-scraping pane content. Permission prompts were auto-accepted via tmux keystrokes.

After: supervisor owns the child `claude` process via stream-json. Gmail pushes and webhooks are serialized onto the agent's stdin as user messages. Watchdog just `curl`s `/health`. No TTY prompts, no pane-scraping, no race conditions.

## Layout

```
index.mjs          — glue: parse args, spawn child, wire HTTP, handle signals
claude-session.mjs — spawn claude, parse stream-json stdout, emit events
dispatcher.mjs     — serialize turns: queue until previous result event arrives
http-server.mjs    — HTTP endpoints (9090 gmail, 9092 webhook, 9093 control)
gmail-source.mjs   — dedup historyIds, save last-history, honor pause flag
event-log.mjs      — append events.ndjson + cost.ndjson (fire-and-forget)
state.mjs          — session_id + cumulative cost (for warm --resume)
mcp-config.json    — MCP servers loaded for the child (currently empty; regular MCP connectors are loaded from user config)
```

## HTTP API (port 9093)

- `GET  /health`   → `{sessionId, model, uptimeMs, lastEventAgeMs, totalCostUsd, queueDepth, inFlight, childAlive, ...}`
- `GET  /cost`     → `{todayUsd, weekUsd, totalUsd, perModel}`
- `POST /restart`  → graceful restart (watchdog uses this on stale-event detection)
- `POST /dispatch` → `{content, source}` manual dispatch

Ports 9090 (gmail) and 9092 (webhook) accept POSTs identical to the old channel servers — Hookdeck and cron scripts don't need to change.

## State files

- `state/ops/session.json` — session_id + cumulative cost (persistent across restarts)
- `../logs/supervisor-ops/events.ndjson` — full event firehose
- `../logs/supervisor-ops/cost.ndjson` — one line per turn completion

## Run

```bash
node index.mjs --agent ops                # production
node index.mjs --agent ops --model sonnet # dev
node index.mjs --agent ops --no-resume    # start fresh session
```

## Watchdog integration

```bash
SNAP=$(curl -sf http://localhost:9093/health) || { echo "supervisor down"; exit 1; }
LAST_EVENT_AGE=$(echo "$SNAP" | jq '.lastEventAgeMs // 0')
if [ "$LAST_EVENT_AGE" -gt 600000 ]; then
  curl -sf -X POST http://localhost:9093/restart
fi
```
