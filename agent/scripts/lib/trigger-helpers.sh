#!/bin/bash
# trigger-helpers.sh — shared boilerplate for agent/scripts/trigger-*.sh
# Each trigger used to duplicate the same is_healthy + dispatch + retry logic
# (~40 lines per file). Source this file and call trigger_job to run it.
#
# Required before sourcing: webhook-auth.sh (populates CURL_AUTH).
#
# Assumes callers export PATH to include /opt/homebrew/bin so node is
# reachable under cron.

HEALTH_PORT=${HEALTH_PORT:-9093}
WEBHOOK_PORT=${WEBHOOK_PORT:-9092}
LOGFILE="$HOME/Dev/edva/agent/logs/watchdog.log"

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

# trigger_dispatch <payload> — POSTs to the webhook and verifies delivery.
# Returns non-zero (and logs why) on a curl-level failure or a non-2xx
# response, instead of swallowing the result — a dispatch that never reached
# the supervisor must not be reported as a success.
trigger_dispatch() {
  local payload="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$payload" 2>/dev/null)
  local curl_exit=$?
  if [ $curl_exit -ne 0 ] || [ "${http_code:-000}" = "000" ] || [ "${http_code:0:1}" != "2" ]; then
    trigger_log "Dispatch failed: curl_exit=$curl_exit http_code=${http_code:-none}"
    return 1
  fi
  return 0
}

# trigger_job <job-name> — standard dispatch pattern. Picks job-name as the
# payload `{"job": "<name>"}` and retries once after 60s on supervisor
# unhealth OR a failed dispatch (health check passing is not sufficient —
# the POST itself must be confirmed delivered before logging success).
trigger_job() {
  TRIGGER_JOB="$1"
  local payload="{\"job\": \"$TRIGGER_JOB\"}"

  # Route to the job's tier supervisor (haiku/sonnet/opus) instead of the
  # hardcoded :9092 default — sets WEBHOOK_PORT + HEALTH_PORT used below.
  # Requires webhook-auth.sh sourced first (provides resolve_tier_ports).
  command -v resolve_tier_ports >/dev/null 2>&1 && resolve_tier_ports "$TRIGGER_JOB"

  if trigger_is_healthy && trigger_dispatch "$payload"; then
    trigger_log "Dispatched $TRIGGER_JOB"
    return 0
  fi

  trigger_log "First attempt failed, retrying in 60s"
  sleep 60

  if trigger_is_healthy && trigger_dispatch "$payload"; then
    trigger_log "Dispatched $TRIGGER_JOB (retry)"
    return 0
  fi

  trigger_log "$TRIGGER_JOB failed: supervisor unhealthy or dispatch failed after retry"
  return 1
}
