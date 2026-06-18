#!/bin/bash
# trigger-usage-push.sh — push per-day Claude usage/cost rollups to the hosted
# /usage telemetry endpoint for central, durable monitoring across hosts.
#
# Direct script — no webhook, no Anthropic API. It just runs
# `merlin-cost-report --push`, which reads agent/logs/supervisor-ops/job-costs.ndjson,
# rolls it up per (day, job), and POSTs each day to apps/telemetry's /usage.
# Idempotent server-side per (host, day): a 2-day window is safe to re-run.
#
# Requires MERLIN_USAGE_TOKEN (or STATS_TOKEN) in .env — merlin-cost-report
# loads .env itself and refuses to push unauthenticated. Non-fatal when there
# are no cost rows yet (logs and moves on).
#
# Install via crontab (nightly, after midnight so the prior day is complete):
#   15 4 * * * ${MERLIN_HOME}/agent/scripts/trigger-usage-push.sh >> ${MERLIN_HOME}/agent/logs/usage-push.log 2>&1
#
# Registered in system/tasks.json as "usage-push".

set -uo pipefail
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG="${MERLIN_HOME}/agent/logs/usage-push.log"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# Push the last 2 days: yesterday (complete) + today (partial). The /usage
# endpoint overwrites each (host, day) snapshot, so re-pushing never
# double-counts. `|| true` keeps a non-zero exit (e.g. no cost rows yet, or
# missing token) from aborting the cron run — we always record the outcome.
OUT="$("${MERLIN_HOME}/bin/merlin-cost-report" --since 2d --push 2>&1)" || true
echo "${TS} [usage-push] ${OUT}" >> "$LOG"
