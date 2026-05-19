#!/bin/bash
# trigger-helpers.sh — shared boilerplate for agent/scripts/trigger-*.sh
# Each trigger used to duplicate the same is_healthy + dispatch + retry logic
# (~40 lines per file). Source this file and call trigger_job to run it.
#
# Required before sourcing: webhook-auth.sh (populates CURL_AUTH).
#
# Assumes callers export PATH to include the standard system bin dirs so node is
# reachable under cron.

: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

HEALTH_PORT=${HEALTH_PORT:-9093}
WEBHOOK_PORT=${WEBHOOK_PORT:-9092}
LOGFILE="${MERLIN_HOME}/agent/logs/watchdog.log"

trigger_log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$TRIGGER_JOB] $1" >> "$LOGFILE"; }

trigger_is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null)
  if [ $? -ne 0 ]; then
    trigger_log "Health check failed: supervisor unreachable on :$HEALTH_PORT"
    return 1
  fi
  local alive
  alive=$(echo "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const s=JSON.parse(d);console.log(s.childAlive?"yes":"no")}catch{console.log("no")}})' 2>/dev/null)
  if [ "$alive" != "yes" ]; then
    trigger_log "Health check failed: childAlive=$alive — health=$health"
    return 1
  fi
  return 0
}

trigger_dispatch() {
  local payload="$1"
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$payload" > /dev/null 2>&1
}

# trigger_job <job-name> — standard dispatch pattern. Picks job-name as the
# payload `{"job": "<name>"}` and retries once after 60s on supervisor unhealth.
trigger_job() {
  TRIGGER_JOB="$1"
  local payload="{\"job\": \"$TRIGGER_JOB\"}"

  if trigger_is_healthy; then
    trigger_dispatch "$payload"
    trigger_log "Dispatched $TRIGGER_JOB"
    return 0
  fi

  trigger_log "First attempt failed, retrying in 60s"
  sleep 60

  if trigger_is_healthy; then
    trigger_dispatch "$payload"
    trigger_log "Dispatched $TRIGGER_JOB (retry)"
    return 0
  fi

  trigger_log "$TRIGGER_JOB failed: supervisor unhealthy after retry"
  return 1
}
