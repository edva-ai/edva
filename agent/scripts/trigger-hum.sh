#!/bin/bash
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger hum via webhook → ops agent.
#
# MODES:
#   tick (default)  Called every 20 min by cron. Bash-gated; most ticks
#                   exit silently without dispatching. The ops-agent only
#                   runs the full hum playbook on dispatches that reach it.
#
#   --manual        Dev/testing. Bypasses activity + cap gates; still honors
#                   the lock. Used by `merlin hum test`.
#
# 2026-04-14: rewrite — dropped --after-message piggyback and --silence-check
# modes. The new hum is a pure 20-min tick; see jobs/hum.md.

export PATH="/opt/homebrew/bin:$PATH"

MODE="tick"
case "$1" in
  --manual)        MODE="manual" ;;
  "")              MODE="tick" ;;
  *)               echo "unknown mode: $1" >&2; exit 2 ;;
esac

HEALTH_PORT=9093
WEBHOOK_PORT=9092
LOGFILE="${MERLIN_HOME}/agent/logs/watchdog.log"
STATE_FILE="${MERLIN_HOME}/data/hum-state.json"
PAYLOAD="{\"job\": \"hum\", \"trigger\": \"$MODE\"}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum:$MODE] $1" >> "$LOGFILE"; }

is_healthy() {
  local health
  health=$(curl -sf --max-time 5 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true' || return 1
  # Dispatcher pauses itself during an auth outage; no point dispatching while
  # the supervisor is deliberately refusing to drain.
  echo "$health" | grep -q '"dispatcherPaused":true' && return 1
  return 0
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" -d "$PAYLOAD" > /dev/null 2>&1
}

# --- bash gates (skip most ticks before the LLM call) ---

# Hard sleep window: 00:00-09:00 local. Even manual mode respects this.
# No reason to tick while the user is asleep. Override via user_daily_schedule
# memory if the user's hours differ.
USER_TZ_FILE="${MERLIN_HOME}/data/user-timezone.json"
USER_TZ="America/New_York"
if [ -f "$USER_TZ_FILE" ]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  if [ -n "$PARSED_TZ" ] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR_LOCAL=$(TZ="$USER_TZ" date +%H)
if [ "$MODE" != "manual" ] && [ "$HOUR_LOCAL" -lt 9 ]; then
  exit 0
fi

# Activity state gate (soft). Skip if the user is sleeping/winding down.
if [ "$MODE" != "manual" ]; then
  MERLIN_BIN="${MERLIN_HOME}/bin/merlin"
  if [ -x "$MERLIN_BIN" ]; then
    STATE=$("$MERLIN_BIN" activity --state-only 2>/dev/null)
    if [ "$STATE" = "sleeping" ] || [ "$STATE" = "winding_down" ]; then
      log "skip:activity=$STATE"
      exit 0
    fi
  fi
fi

# Calendar busy gate: skip if the user is in a meeting right now.
# Transparent/free events (e.g. shared-calendar-only entries) don't block.
if [ "$MODE" != "manual" ]; then
  GOG_BIN="/opt/homebrew/bin/gog"
  if [ -x "$GOG_BIN" ]; then
    NOW_ISO=$(TZ="$USER_TZ" date -Iseconds)
    FOUR_AGO=$(TZ="$USER_TZ" date -v-4H -Iseconds)
    IN_MEETING=$("$GOG_BIN" calendar list --json --results-only --from "$FOUR_AGO" --to "$NOW_ISO" --all 2>/dev/null | \
      jq -r --arg now "$NOW_ISO" \
        '[.[] | select(.start.dateTime != null and .end.dateTime != null and .end.dateTime > $now and (.transparency // "opaque") != "transparent")] | length')
    if [ "${IN_MEETING:-0}" -gt 0 ]; then
      log "skip:in_meeting"
      exit 0
    fi
  fi
fi

# State-date guard + pause gate (state-file aware). Manual mode bypasses pause
# but still runs the date roll-over so counters reset cleanly after midnight.
#
# 2026-04-16 (nightly-review s-20260416-05): hum-state.json.today.date was
# observed lagging by a day mid-session (supervisor restart + stale fixture),
# leaving runs/pings counters from the wrong date. We now force a counter
# reset here whenever today.date != local-today, BEFORE hum.md increments
# them.
LOCAL_TODAY=$(TZ="$USER_TZ" date +%Y-%m-%d)
DECISION=$(node <<NODE 2>>"$LOGFILE"
const fs = require('fs');
const MODE = '$MODE';
const STATE_FILE = '$STATE_FILE';
const LOCAL_TODAY = '$LOCAL_TODAY';
let s;
try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { console.log('go'); process.exit(0); }
const now = Date.now();
// Date roll-over: reset today counters when state-file date != local-today.
// Writes back atomically before any other logic runs.
if (s.today && s.today.date && s.today.date !== LOCAL_TODAY) {
  s.today = { date: LOCAL_TODAY, runs: 0, pings: 0, questions: 0 };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); } catch (e) {}
  process.stderr.write('[hum] reset today counters (date rollover)\n');
}
if (s.pause && s.pause.until && new Date(s.pause.until).getTime() > now) {
  console.log('skip:paused'); process.exit(0);
}
// Daily cap removed — hum decides on its own based on inputs/relevance.
// pause + sleep + activity gates above still apply.
console.log('go');
NODE
)

case "$DECISION" in
  go) ;;
  skip:*)
    log "decision=$DECISION"
    exit 0
    ;;
  *)
    log "decision=unexpected '$DECISION' (treating as skip)"
    exit 0
    ;;
esac

# --- dispatch (with health retry) ---
if is_healthy; then
  dispatch
  log "Dispatched hum"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched hum (retry)"
  exit 0
fi

log "Pulse failed: supervisor unhealthy after retry"
exit 1
