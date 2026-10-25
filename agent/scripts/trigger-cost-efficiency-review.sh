#!/bin/bash
# Run the daily cost-efficiency-review job as an ephemeral Opus 5 agent.
#
# WHY THIS JOB EXISTS. One overnight window once burned a large slice of the
# weekly Max cap — at that pace, most of the week's allowance — and nothing
# noticed. Most of it was cache traffic, not work. That is a
# STRUCTURAL failure (the context floor had grown to 151k against a 150k compact
# threshold, so the guard thrashed), and a by-job cost table cannot see it:
# a job re-writing a 100k prefix every dispatch looks like a job doing work.
# nightly-review's cost lens is weekly and job-shaped, so it misses this class.
#
# LAUNCHED BY LAUNCHD (ai.claude.cost-efficiency-review), NOT CRONTAB — a
# `claude -p` under cron runs outside the Aqua session, cannot unlock the login
# keychain holding the Max credentials, prints "Not logged in" and exits 0.
# Same constraint as system-issue-review / improvement-review.
#
# Like chat-consolidate and system-issue-review, the FETCH happens here in the
# un-sandboxed launchd process and lands in LOCAL files, so the agent turn reads
# plain JSON — the agent's sandboxed Bash masks localhost and some paths.
#
# Gate: skip when there is genuinely nothing to review — too few dispatches in
# the window to say anything (a fresh restart, a quiet day). Each run is an Opus
# run, so the gate matters.

set -uo pipefail
export PATH="/opt/homebrew/bin:$PATH:$HOME/Dev/edva/bin"

source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
ROOT="$EDVA_INSTALL"
DATA="$EDVA_INSTALL_TOOLS/data"
LOG="$DATA/logs/cost-efficiency-review.log"
REPORT="$EDVA_INSTALL_TOOLS/bin/edva-cost-report"
TODAY_JSON="$DATA/cost-efficiency-today.json"
WEEK_JSON="$DATA/cost-efficiency-7d.json"
STATE="$DATA/cost-efficiency-review-state.json"

mkdir -p "$DATA/logs"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [cost-efficiency-review] $1" >> "$LOG"; }

# Pause switch — for when the user is deliberately running hot and doesn't want
# to hear about it (a migration, a backfill, a heavy research week).
if [ -f "$DATA/.cost-efficiency-review-pause" ]; then
  log "paused (data/.cost-efficiency-review-pause present) — skip"
  exit 0
fi

# --- Pre-fetch the measurement (un-sandboxed) ------------------------------
if ! node "$REPORT" --since 24h --efficiency --json > "$TODAY_JSON" 2>>"$LOG"; then
  log "cost report (24h) failed — skip, nothing to review"
  exit 0
fi
if ! node "$REPORT" --since 7d --efficiency --json > "$WEEK_JSON" 2>>"$LOG"; then
  log "cost report (7d) failed — continuing with 24h only"
  echo '{}' > "$WEEK_JSON"
fi

# --- Gate: enough signal to be worth an Opus run? --------------------------
# A window with almost no dispatches (fresh restart, machine asleep) produces
# a report whose ratios are noise. Reviewing it would file bogus regressions.
DISPATCHES=$(node -e '
  try { const d = require(process.argv[1]); process.stdout.write(String(d.dispatches || 0)); }
  catch { process.stdout.write("0"); }
' "$TODAY_JSON" 2>/dev/null || echo 0)

if [ "${DISPATCHES:-0}" -lt 20 ]; then
  log "only ${DISPATCHES} dispatches in the last 24h — too little signal, skip"
  exit 0
fi

# Seed the state file on first run so the playbook always has a baseline to
# compare against. The baseline is the installation's own measurement
# (agent/local/config/cost-efficiency-review.json `seed_baseline`, read
# through instance.cjs localConfig); without one it is left unmeasured and the
# first history row stands in for it.
if [ ! -f "$STATE" ]; then
  node -e '
    const { localConfig } = require(process.argv[1]);
    const { seed_baseline } = localConfig("cost-efficiency-review", {
      seed_baseline: {
        captured_at: null,
        note: "no recorded baseline: compare against the first history row",
        context_overhead_pct: null, weighted_cost_usd_24h: null, cost_per_1k_output_usd: null,
        floors: {}, compacts_24h: null, rotates_24h: null,
      },
    });
    const state = { baseline: seed_baseline, history: [], proposals: [], silent_streak_days: 0, last_run_at: null };
    require("fs").writeFileSync(process.argv[2], JSON.stringify(state, null, 2) + "\n");
    process.stdout.write(String(seed_baseline.captured_at || "no"));
  ' "$EDVA_INSTALL_TOOLS/lib/instance.cjs" "$STATE" > "$DATA/.cost-review-seed.tmp" 2>>"$LOG" \
    && log "seeded state file with the $(cat "$DATA/.cost-review-seed.tmp") baseline"
  rm -f "$DATA/.cost-review-seed.tmp"
fi

# --- Seed today's history row ----------------------------------------------
# The measurement must not depend on the agent turn reaching its Step 6. A
# review that dispatches but never writes state loses that day's numbers for
# good — TODAY_JSON is overwritten on the next run. Every field in the row is arithmetic over $TODAY_JSON, which this
# un-sandboxed process already holds, so none of it needs a model. The agent
# ANNOTATES this row (job_cost_index, attribution, verdicts) rather than
# creating it. Idempotent, and can never block the dispatch.
node "$EDVA_INSTALL_TOOLS/agent/scripts/lib/cost-review-seed-history.mjs" \
  "$TODAY_JSON" "$STATE" >>"$LOG" 2>&1 || true

# --- Prune settled memory out of the state file ----------------------------
# The review was measured at nearly a tenth of the ACCOUNT's weekly spend, and
# the cause was this file: hundreds of KB, most of it settled reasoning the run
# re-reads every night. The pruner ARCHIVES (never deletes) closed carry_forward
# entries, the prose on history rows older than 7 days, and detail on
# proposals applied over 14 days ago. Deterministic, idempotent, fails open —
# it can never block the night's review.
node "$EDVA_INSTALL_TOOLS/agent/scripts/lib/cost-review-state-prune.mjs" \
  "$STATE" "$DATA/cost-efficiency-review-archive.json" >>"$LOG" 2>&1 || true

# --- Derive what the agent turn would otherwise re-derive ------------------
# The review is the largest ephemeral-Opus workload on the account and 95% of
# its tokens are cache-read, i.e. `turns x context`. Every mechanical
# derivation it performs — the per-job ledger rollup, the mix-vs-drift
# decomposition of turns_per_dispatch, the always-loaded mtime sweep, the
# runaway discriminators, its own per-run cost series, index comparability —
# is deterministic arithmetic over files this process already holds. Doing it
# here turns ~6-8 tool-calling turns plus their follow-ups into one read.
# Same rationale as the report pre-fetch above. Fails open.
node "$EDVA_INSTALL_TOOLS/bin/cost-review-prefetch.mjs" \
  "$TODAY_JSON" "$WEEK_JSON" "$DATA/cost-efficiency-derived.json" >>"$LOG" 2>&1 || true

log "dispatching (${DISPATCHES} dispatches in window)"
exec "$EDVA_INSTALL_TOOLS/agent/scripts/lib/run-ephemeral-opus.sh" \
  cost-efficiency-review \
  "$EDVA_INSTALL_TOOLS/agent/ops-agent/jobs/cost-efficiency-review.md" \
  --task "COST EFFICIENCY REVIEW (daily). Today's measurement is already fetched at data/cost-efficiency-today.json (24h) and data/cost-efficiency-7d.json (7d) — read those, do NOT re-run edva-cost-report. The mechanical derivations are ALSO pre-computed at data/cost-efficiency-derived.json — the per-job ledger rollup (today vs the prior window, gmail:* folded), the mix-vs-drift decomposition of turns_per_dispatch, the always-loaded mtime sweep, context-guard runaway candidates with the playbook's runaway-row discriminators already applied, this job own per-run cost series, and job_cost_index comparability. Read that file instead of re-deriving any of it. Compare against the baseline in data/cost-efficiency-review-state.json, attribute any regression to a specific change, and build every concrete cut tonight and land it through self-improve-auto-apply (Face-ID card via self-improve-request on exit 3); put decisions with nothing to sign in questions[] in the state file. NEVER email, ping or push — this job has no delivery step (2026-10-06)." \
  --timeout-min 25
