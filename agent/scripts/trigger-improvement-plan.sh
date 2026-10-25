#!/bin/bash
set -uo pipefail
# Trigger the Self Improvement Plan pass — the job that acts on every item of the
# weekly review: safe changes land on their own (self-improve-auto-apply), complex
# or high-blast-radius ones become Face-ID cards in the Improvements channel.
#
# Normally CHAINED by trigger-nightly-review.sh the moment the review exits
# clean, so it always reads a fresh report. Also installed on its own launchd
# slot (Tuesdays 10:30 local, after the 05:00 review's worst case) as a
# SAFETY NET: if the review died, or the chain
# never fired, this catches it. Two guards make the double-trigger harmless:
# the job's own Step 1 exits when `nightly-review-state.json` is older than
# 24h, and the check below exits BEFORE launching Opus when the planner's own
# `last_run` is already newer than the review's (this week's review has been
# planned from). A first run that died before writing `last_run` (e.g. its
# last drafter was cut off) still gets its safety-net pass.
#
# Without that second guard the safety-net slot re-plans the same review in
# full (tens of dollars on the fork ledger). Fail-open: a missing or unreadable state file runs the planner.
# IMPROVEMENT_PLAN_FORCE=1 runs it regardless (a deliberate manual re-plan).
#
# Runs as an ephemeral `claude -p --model $EDVA_MODEL_OPUS --effort xhigh`
# (lib/run-ephemeral-opus.sh reads the id from agent/config/models.env;
# all improvement-related processes run on Opus, a user rule). This job authors real code changes to Edva's own
# source, which is exactly the workload that deserves the deepest tier.
#
# The opening line below must match the playbook's rule (rubric schema v4,
# jobs/improvement-plan.md): an opening line saying "every item becomes a
# Face-ID card (never auto-apply, not even low-risk ones)" contradicts the
# playbook, and a run that weighs the launcher over the playbook would file
# 15+ cards in one morning.
#
# LAUNCHED BY LAUNCHD (ai.claude.improvement-plan), never crontab — see
# lib/run-ephemeral-opus.sh for why cron cannot authenticate this.

export PATH="/opt/homebrew/bin:$PATH"
# The operator's name for the task text (lib/instance.cjs).
source "$(dirname "$0")/lib/instance.sh"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
ROOT="$EDVA_INSTALL"
JOB_MD="$EDVA_INSTALL_TOOLS/agent/ops-agent/jobs/improvement-plan.md"

TASK="Run the Self Improvement Plan job. Follow the playbook below end-to-end. ultrathink — you are authoring changes to Edva's own source code that ${EDVA_OWNER_NAME:-the user} will approve with a thumb on their phone, so the reasoning behind what you choose to build, and the honesty of each card's rationale, matter more than throughput. Three things to hold onto: every item leaves this run with a disposition; a verified change goes to self-improve-auto-apply first and lands on its own when it allows, and only complex or high-blast-radius changes (its exit 3) become Face-ID cards (${EDVA_OWNER_NAME:-the user}, 2026-09-29); and anything they have skipped is never re-proposed. If the review that should precede you did not run, exit without planning rather than planning from a stale report."

DATA="$EDVA_INSTALL_TOOLS/data"
if [ "${IMPROVEMENT_PLAN_FORCE:-0}" != "1" ]; then
  # Timestamps are machine-written ISO strings; compare them as instants.
  ALREADY=$(node -e '
    const fs = require("fs");
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).last_run; } catch { return null; } };
    const plan = Date.parse(read(process.argv[1]) || ""), review = Date.parse(read(process.argv[2]) || "");
    process.stdout.write(Number.isFinite(plan) && Number.isFinite(review) && plan > review ? "yes" : "no");
  ' "$DATA/improvement-plan-state.json" "$DATA/nightly-review-state.json" 2>/dev/null)
  if [ "$ALREADY" = "yes" ]; then
    mkdir -p "$DATA/logs"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [improvement-plan] skip: last_run is newer than the review's, this week is already planned" >> "$DATA/logs/improvement-plan.log"
    exit 0
  fi
fi

exec "$SCRIPTS/lib/run-ephemeral-opus.sh" improvement-plan "$JOB_MD" --task "$TASK" --timeout-min 180
