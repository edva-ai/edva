#!/bin/bash
# trigger-usage-push.sh — push per-day Claude usage/cost rollups to the hosted
# /usage telemetry endpoint for central, durable monitoring across hosts.
#
# Direct script — no webhook, no Anthropic API. Wraps `edva-cost-report --push`,
# which unions the per-agent ledgers (supervisor-ops/-light/-haiku job-costs.ndjson),
# rolls them up per (day, job), and POSTs each day to the hosted /usage endpoint.
# Sends the model-WEIGHTED real cost (not the SDK phantom estimate). Idempotent
# server-side per (host, day): a 2-day window is safe to re-run.
#
# Requires EDVA_USAGE_TOKEN (or STATS_TOKEN) in .env — edva-cost-report
# loads it and refuses to push unauthenticated. Non-fatal when there are no cost
# rows yet (logs and exits 0).
#
# Runs nightly from tasks.json. All output → agent/logs/usage-push.log.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/usage-push.log"

mkdir -p "$LOG_DIR"

# PATH for cron context (Homebrew node, git, gh).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"

# Push the last 2 days: yesterday (complete) + today (partial). The /usage
# endpoint overwrites each (host, day) snapshot, so re-pushing never
# double-counts. `|| true` keeps a non-zero exit (no cost rows yet, or missing
# token) from aborting the cron run — we always record the outcome.
OUT="$("$EDVA_TOOLS/bin/edva-cost-report" --since 2d --push 2>&1)" || true
echo "$TS [usage-push] $OUT" >>"$LOG_FILE"
