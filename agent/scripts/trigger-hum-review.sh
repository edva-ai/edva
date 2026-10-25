#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger hum weekly review via webhook → ops agent
# Runs Sundays at 09:30. No jitter (once/week, benefits from predictable arrival).
# Retries once after 60s if supervisor is unhealthy.

export PATH="/opt/homebrew/bin:$PATH"

resolve_tier_ports hum-review   # tier-routes WEBHOOK_PORT + HEALTH_PORT (was :9092 Opus)
LOGFILE="$HOME/Dev/edva/agent/logs/watchdog.log"
PAYLOAD='{"job": "hum-review"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-review] $1" >> "$LOGFILE"; }

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
  log "Dispatched hum-review"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched hum-review (retry)"
  exit 0
fi

log "Pulse-review failed: supervisor unhealthy after retry"
