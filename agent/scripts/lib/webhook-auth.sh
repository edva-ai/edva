# Shared webhook authentication + tier routing for trigger scripts.
# Source this file before calling dispatch_or_skip().
# Provides CURL_AUTH array for use in curl calls: curl ... "${CURL_AUTH[@]}" ...
# If the token file is missing, CURL_AUTH is empty and curl works without auth.

# Where the installation lives and which node to run (EDVA_INSTALL_TOOLS,
# EDVA_NODE).
source "$(dirname "${BASH_SOURCE[0]}")/root.sh"

WEBHOOK_TOKEN_FILE="$EDVA_INSTALL_TOOLS/secrets/webhook-token"
CURL_AUTH=()
if [ -f "$WEBHOOK_TOKEN_FILE" ]; then
  WEBHOOK_TOKEN=$(cat "$WEBHOOK_TOKEN_FILE")
  CURL_AUTH=(-H "Authorization: Bearer $WEBHOOK_TOKEN")
fi

# ── Tier routing (Lever B, June-15 cost re-architecture) ────────────────────
# Three supervisors run side by side (see agent/config/agents.json):
#   ops        (Opus)   — webhook :9092  health :9093  — deep synthesis + Gmail
#   ops-light  (Sonnet) — webhook :9082  health :9083  — drafting/reasoning jobs
#   ops-haiku  (Haiku)  — webhook :9072  health :9073  — pure scan/watch jobs
# A job's tier comes from its agent/config/job-routing.json `model`:
#   model=="haiku"            → ops-haiku   (cheapest; 5× under Opus, 3× under Sonnet)
#   model set, !=opus, !=haiku → ops-light  (sonnet / local-on-supervisor)
#   model opus / null / unknown, or a job in config/chrome-jobs.json → ops
#     (the only supervisor that loads the chrome-devtools MCP).
# Each tier has a degrade-UPWARD health fallback (haiku→sonnet→opus) so a
# scheduled job is never dropped just because a cheaper sibling is flaky.
# Fail safe: anything the router can't classify defaults to ops.
NODE_BIN="${NODE_BIN:-$EDVA_NODE}"
# Both registries are the kernel's file (config/job-routing.json,
# config/chrome-jobs.json) plus this installation's agent/local/<name>.json,
# merged by lib/registry.cjs.
REGISTRY_CJS="$EDVA_INSTALL_TOOLS/lib/registry.cjs"

# _resolve_tier <job-name> -> echoes "haiku" | "light" | "heavy"
_resolve_tier() {
  local job="$1"
  [ -x "$NODE_BIN" ] || { echo heavy; return; }
  "$NODE_BIN" -e '
    const fs=require("fs");
    // Chrome-MCP jobs MUST stay on ops — it is the only supervisor that loads the
    // chrome-devtools MCP. The list lives in config/chrome-jobs.json and is checked
    // against the playbooks by tests/chrome-jobs-sync.test.mjs. It used to be
    // hand-synced here and drifted: runner-only jobs (cdp-runner from Bash works
    // from any supervisor) were pinned to the heavy tier for nothing.
    const { loadRegistry } = require(process.argv[1]);
    let chrome=new Set();
    try { chrome=new Set(loadRegistry("chrome-jobs").jobs||[]); } catch {}
    const job=process.argv[2];
    let tier="heavy";
    try {
      const r=loadRegistry("job-routing");
      const j=(r.jobs||{})[job];
      const m=j&&j.model;
      if (m && !chrome.has(job)) {
        if (m==="haiku") tier="haiku";
        else if (m!=="opus") tier="light"; // sonnet / local → sonnet supervisor
      }
    } catch {}
    process.stdout.write(tier);
  ' "$REGISTRY_CJS" "$job" 2>/dev/null || echo heavy
}

# _is_healthy <health-port> -> return 0 if that supervisor reports childAlive:true
_is_healthy() {
  curl -sf --max-time 5 "http://127.0.0.1:$1/health" 2>/dev/null | grep -q '"childAlive":true'
}

# resolve_tier_ports <job> — set WEBHOOK_PORT + HEALTH_PORT globals to the job's
# tier (haiku→9072/9073, sonnet/local→9082/9083, opus/chrome/unknown→9092/9093).
# For triggers that dispatch INLINE (their own health-check + curl) rather than
# calling dispatch_or_skip — they used to hardcode :9092 and bypass tier routing.
# No degrade-upward fallback here (the trigger's own skip-on-unhealthy stands and
# cron retries); use dispatch_or_skip if you want the fallback chain.
resolve_tier_ports() {
  case "$(_resolve_tier "$1")" in
    haiku) WEBHOOK_PORT=9072; HEALTH_PORT=9073 ;;
    light) WEBHOOK_PORT=9082; HEALTH_PORT=9083 ;;
    *)     WEBHOOK_PORT=9092; HEALTH_PORT=9093 ;;
  esac
}

# dispatch_or_skip <json-payload> [<job-name-for-log>]
# Resolves the job's tier, then POSTs to the cheapest HEALTHY supervisor in its
# degrade-upward chain (haiku→sonnet→opus). Falling back keeps a scheduled job
# running when a cheaper sibling is restarting/dead. If no supervisor in the
# chain is healthy, skips with a watchdog.log line so cron dispatches don't pile
# up against a dead stack.
dispatch_or_skip() {
  local payload="$1"
  local job_name="${2:-$(basename "$0" .sh)}"
  local logfile="$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"
  local tier; tier=$(_resolve_tier "$job_name")

  # webhook:health port pairs, cheapest first.
  local -a chain
  case "$tier" in
    haiku) chain=("9072:9073" "9082:9083" "9092:9093") ;; # haiku → sonnet → opus
    light) chain=("9082:9083" "9092:9093") ;;             # sonnet → opus
    *)     chain=("9092:9093") ;;                          # opus
  esac

  local pair wport hport chosen="" idx=0
  for pair in "${chain[@]}"; do
    wport="${pair%%:*}"; hport="${pair##*:}"
    if _is_healthy "$hport"; then chosen="$wport"; break; fi
    if [ "$idx" -eq 0 ] && [ "${#chain[@]}" -gt 1 ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$job_name] ${tier}-tier primary (:$hport) unhealthy — degrading upward" >> "$logfile"
    fi
    idx=$((idx + 1))
  done

  if [ -z "$chosen" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job_name] skipped: no healthy supervisor in ${tier} chain" >> "$logfile"
    return 1
  fi

  curl -s -X POST "http://localhost:$chosen" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
    -d "$payload" > /dev/null 2>&1
}
