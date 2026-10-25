#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger hum-ideation via webhook → ops-light agent
# Four slots a day (06:00, 11:00, 14:00, 19:00 local) to refill the ideas reservoir;
# a slot with healthy inventory and unchanged inputs is skipped (see below).
# Retries once after 60s if supervisor is unhealthy.

export PATH="/opt/homebrew/bin:$PATH"

# Pre-fetch Google Tasks for the ideation agent. This trigger runs unsandboxed
# via cron-run (which injects GOG_KEYRING_PASSWORD from .env), so `gog`
# works here — whereas the ideation agent runs in a Bash sandbox that denies the
# macOS keychain, making its own `gog` calls fail with OSStatus -26276. The agent
# reads this file instead of shelling out to gog (see hum-ideation.md Step 4 +
# Critical rule 8). Best-effort: a gog hiccup must never block the dispatch, and
# we only overwrite the file on success so the agent never sees a half-written or
# error-filled file (it treats missing/empty as "tasks unavailable this run").
TASKS_FILE="$HOME/Dev/edva/data/hum-ideation-tasks.txt"
TASKS_TMP="$(mktemp)"
if gog tasks list @default --plain > "$TASKS_TMP" 2>/dev/null && [ -s "$TASKS_TMP" ]; then
  mv "$TASKS_TMP" "$TASKS_FILE"
else
  rm -f "$TASKS_TMP"
fi

resolve_tier_ports hum-ideation   # tier-routes WEBHOOK_PORT + HEALTH_PORT (was :9092 Opus)
LOGFILE="$HOME/Dev/edva/agent/logs/watchdog.log"
PAYLOAD='{"job": "hum-ideation"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-ideation] $1" >> "$LOGFILE"; }

# Prefetch calendar / P1 threads / flights / context into
# hum-ideation-context.json and decide whether this slot is worth a turn at
# all: skipped only when inventory is healthy AND nothing it reads has changed
# since the last dispatched run (bin/hum-ideation-prefetch).
# The scorecard + digest it reads are rebuilt by the nightly hum-reservoir-prune.
GATE=$("$HOME/Dev/edva/bin/hum-ideation-prefetch" 2>/dev/null)
if echo "$GATE" | grep -q '"decision":"skip"'; then
  log "skip slot: $GATE"
  exit 0
fi
log "gate: ${GATE:-prefetch failed — dispatching anyway}"

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null)
  if [ $? -ne 0 ]; then
    log "Health check failed: supervisor unreachable on :$HEALTH_PORT"
    return 1
  fi
  local alive
  alive=$(echo "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log(s.childAlive?"yes":"no")}catch{console.log("no")}})' 2>/dev/null)
  if [ "$alive" != "yes" ]; then
    log "Health check failed: childAlive=$alive — health=$health"
    return 1
  fi
  return 0
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if is_healthy; then
  dispatch
  log "Dispatched hum-ideation"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched hum-ideation (retry)"
  exit 0
fi

log "hum-ideation failed: supervisor unhealthy after retry"
