# Shared webhook authentication for trigger scripts.
# Source this file before calling dispatch().
# Provides CURL_AUTH array for use in curl calls: curl ... "${CURL_AUTH[@]}" ...
# If the token file is missing, CURL_AUTH is empty and curl works without auth.

: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

WEBHOOK_TOKEN_FILE="${MERLIN_HOME}/secrets/webhook-token"
CURL_AUTH=()
if [ -f "$WEBHOOK_TOKEN_FILE" ]; then
  WEBHOOK_TOKEN=$(cat "$WEBHOOK_TOKEN_FILE")
  CURL_AUTH=(-H "Authorization: Bearer $WEBHOOK_TOKEN")
fi

# dispatch_or_skip <json-payload> [<job-name-for-log>]
# POSTs payload to the supervisor webhook only if the ops-agent health endpoint
# reports childAlive=true. Skips silently with a watchdog.log line otherwise so
# cron-driven dispatches don't pile up against a restarting/dead agent.
dispatch_or_skip() {
  local payload="$1"
  local job_name="${2:-$(basename "$0" .sh)}"
  local health
  health=$(curl -sf --max-time 5 "http://127.0.0.1:9093/health" 2>/dev/null)
  if ! echo "$health" | grep -q '"childAlive":true'; then
    local logfile="${MERLIN_HOME}/agent/logs/watchdog.log"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job_name] skipped: ops-agent unhealthy" >> "$logfile"
    return 1
  fi
  curl -s -X POST http://localhost:9092 \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$payload" > /dev/null 2>&1
}
