#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger the nightly hum-consolidate job via webhook → ops agent (Opus).
#
# Folds the day's replies-to-pings (data/hum-responses.jsonl) into the
# GENERAL wiki so hum stops re-asking things the user already answered. Runs in
# the sleep window on purpose (3:10 AM local) — it's memory maintenance, not a
# ping. See jobs/hum-consolidate.md.
#
# Gate: skip the dispatch entirely when there are no un-consolidated rows
# (nothing new since hum-consolidate-state.json.last_consolidated_at). Keeps
# quiet nights from burning an Opus dispatch.

export PATH="/opt/homebrew/bin:$PATH"

resolve_tier_ports hum-consolidate   # default heavy → :9092 (Opus; judgment over the wiki)
LOGFILE="$HOME/Dev/edva/agent/logs/watchdog.log"
RESPONSES="$HOME/Dev/edva/data/hum-responses.jsonl"
STATE="$HOME/Dev/edva/data/hum-consolidate-state.json"
PAYLOAD='{"job": "hum-consolidate"}'

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-consolidate] $1" >> "$LOGFILE"; }

# --- gate: any rows newer than the watermark? ---
PENDING=$(node -e '
const fs=require("fs");
const resp=process.argv[1], state=process.argv[2];
let last=0;
try { last=new Date(JSON.parse(fs.readFileSync(state,"utf8")).last_consolidated_at||0).getTime(); } catch {}
let n=0;
try {
  const raw=fs.readFileSync(resp,"utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r=JSON.parse(line); } catch { continue; }
    const t=new Date(r.ts||0).getTime();
    if (Number.isFinite(t) && t>last) n++;
  }
} catch {}
process.stdout.write(String(n));
' "$RESPONSES" "$STATE" 2>/dev/null || echo 0)

if [ "${PENDING:-0}" -eq 0 ]; then
  log "skip: no un-consolidated responses"
  exit 0
fi

is_healthy() {
  local health
  health=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true'
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if is_healthy; then
  dispatch
  log "Dispatched hum-consolidate ($PENDING pending)"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched hum-consolidate (retry, $PENDING pending)"
  exit 0
fi

log "Consolidate failed: supervisor unhealthy after retry"
exit 1
