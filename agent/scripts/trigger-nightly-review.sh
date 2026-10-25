#!/bin/bash
set -uo pipefail
# Trigger the weekly Self Improvement Review, then chain the plan pass.
#
# Runs weekly Tuesday 05:00 local. Analyzes the prior 7 days of activity, ecosystem
# developments, and research, and emails a prioritized improvement memo — as it
# always has. Job/script/state-file names keep the historical "nightly-review"
# label for repo-stability; the cadence is weekly.
#
# TWO DESIGN RULES (both the user's):
#
# 1. EPHEMERAL OPUS instead of a webhook dispatch. All improvement-related
#    processes run on Opus. POSTing to the heavy supervisor on :9092 would run
#    Sonnet: `"model": "opus"` in job-routing.json is a TIER LABEL consumed by
#    webhook-auth.sh, not a model id (see agent/CLAUDE.md § Effort Policy),
#    so the week's deepest reasoning job would quietly run on Sonnet.
#    It runs as a dedicated `claude -p --model <Opus> --effort xhigh`
#    via lib/run-ephemeral-opus.sh — the same shape the other Opus forks use,
#    and no fourth resident supervisor on the RAM-tight host.
#
# 2. CHAINS THE PLAN PASS. The weekly improvement process generates improvement
#    cards in the channel automatically, without being asked. If the review's
#    ACTION ITEMS ended at the email and waited for the user to ask for each
#    fix by hand, good findings would age out of the 30-day suggestion window
#    unimplemented. On a clean exit this launches
#    `improvement-plan`, which turns those findings into Face-ID cards.
#    Chaining here rather than from its own cron slot is what guarantees the plan
#    reads a FRESH report — it cannot start before the review has written state.
#    The review email still goes out either way; the cards are additive.
#
# LAUNCHED BY LAUNCHD (ai.claude.improvement-review), not crontab. A `claude -p`
# under cron runs outside the GUI session, can't unlock the keychain holding the
# Max credentials, prints "Not logged in" and exits 0 having done nothing — a
# silent miss. Same rule as agent/CLAUDE.md
# § Scheduled Reminders.
#
# Flags:
#   --no-chain   run the review only, skip the plan pass (manual / debug runs)

export PATH="/opt/homebrew/bin:$PATH"
# The operator's name for the task text (lib/instance.cjs).
source "$(dirname "$0")/lib/instance.sh"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
ROOT="$EDVA_INSTALL"
JOB_MD="$EDVA_INSTALL_TOOLS/agent/ops-agent/jobs/nightly-review.md"
LOG="$EDVA_INSTALL_TOOLS/agent/logs/nightly-review.log"

CHAIN=1
for arg in "$@"; do
  case "$arg" in
    --no-chain) CHAIN=0 ;;
  esac
done

# `ultrathink` must appear in the OPENING message — a thinking hint inside a file
# the agent later reads as a tool result does not allocate the budget.
TASK="Run the Self Improvement Review job (cadence: weekly Tuesday, scope: prior 7 days). Follow the playbook below end-to-end, including sending the review email — that memo is the analysis of record and ${EDVA_OWNER_NAME:-the user} reads it. ultrathink — this is a holistic system self-assessment that warrants the maximum reasoning budget for pattern-spotting across the week and prioritizing improvements. No tool-call budget on this job: it is one of the two most important things the system runs (the other is named in this instance's additions to the playbook). Take as many tool calls as the analysis genuinely needs — re-query, cross-check, dig into anomalies, iterate until the picture is honest. Quality of insight is the only thing that matters; throughput and cost are not constraints. NOTE: when you finish, a separate improvement-plan pass reads your state file and turns your ACTION ITEMS into approvable Face-ID cards — so write each item concretely enough to be built from (what is wrong, which files, how you would verify it)."

"$SCRIPTS/lib/run-ephemeral-opus.sh" nightly-review "$JOB_MD" --task "$TASK" --timeout-min 90
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [nightly-review] review exited $RC — NOT chaining the plan pass" >> "$LOG"
  exit "$RC"
fi

if [ "$CHAIN" -eq 1 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [nightly-review] chaining improvement-plan" >> "$LOG"
  # Sequential, not backgrounded: the plan pass reads the state file the review
  # just wrote, and both are Opus runs — overlapping them would double the peak
  # memory footprint on the host for nothing. The 05:00 slot has hours to spare.
  "$SCRIPTS/trigger-improvement-plan.sh"
fi

exit 0
