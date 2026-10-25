#!/bin/bash
# run-ephemeral-opus.sh — run one job as a dedicated, ephemeral Opus agent
# (model id from agent/config/models.env), and record its cost.
#
# WHY. All improvement-related processes run on Opus (a user rule). The ops
# supervisor runs Sonnet, and `"model": "opus"` in job-routing.json is only a
# TIER LABEL — it routes a job to the heavy supervisor — so without this,
# `nightly-review`, `system-issue-review` and every card they file would be
# Sonnet work wearing an "opus" label.
#
# The two ways to fix that are a fourth persistent Opus supervisor (another
# long-lived Claude session + full MCP server set on a RAM-constrained host
# that already swaps) or a per-job ephemeral fork. This is the fork, generalized
# from an earlier weekly fork trigger that ran exactly this shape:
# same ops-agent cwd, same .mcp.json, same CLAUDE.md hierarchy,
# same session connectors — just a different model, and nothing resident between
# runs.
#
# MUST BE LAUNCHED BY LAUNCHD, NOT CRON. A cron-launched `claude -p` runs outside
# the Aqua session, cannot unlock the login keychain holding the Max credentials,
# prints "Not logged in" and exits 0 — a silent miss that can cost a whole
# weekly run. launchd user agents load into the GUI login session and can.
# The guard below turns that failure mode from silent into loud, but the fix is
# the launcher, not the guard.
#
# Usage:
#   run-ephemeral-opus.sh <job-name> <job-md-path> [--task "<opening line>"] [--timeout-min <n>]
#                         [--model <id>] [--effort <level>] [--cwd <dir>]
#
# --model/--effort/--cwd: the defaults are
# EDVA_MODEL_OPUS from agent/config/models.env, xhigh, and the ops-agent dir. --cwd runs the agent inside another repo so THAT repo's
# CLAUDE.md is loaded; the edva root is still added with --add-dir.
#
# The task line is prepended to the job file's text on stdin. `claude -p` reads
# the prompt from stdin — a positional prompt argument is NOT reliably picked up.
# Anything the job needs to know that isn't in the playbook (dispatch mode, the
# reason it was triggered) goes in the task line, which is the ephemeral
# equivalent of the webhook payload's `task` field.

set -uo pipefail

# node: the signed build at ~/.local/node (see script-job-env.sh) — needed by
# fork-cost-record below.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:$PATH"
CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
source "$(dirname "${BASH_SOURCE[0]}")/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
ROOT="$EDVA_INSTALL"
CWD="$EDVA_INSTALL_TOOLS/agent/ops-agent"
ENV_FILE="$EDVA_INSTALL_TOOLS/.env"
LOGDIR="$EDVA_INSTALL_TOOLS/agent/logs"

# Model ids are pinned in ONE place:
# agent/config/models.env. Re-read on every run, so a flip needs no restart.
MODELS_ENV="$EDVA_INSTALL_TOOLS/agent/config/models.env"
# shellcheck source=../../config/models.env
[ -f "$MODELS_ENV" ] && source "$MODELS_ENV"

JOB="${1:-}"; JOB_MD="${2:-}"; shift 2 2>/dev/null || true
TASK=""
TIMEOUT_MIN=0
MODEL="${EDVA_MODEL_OPUS:-}"
EFFORT="xhigh"

# Connector deny. The ops supervisors don't carry the claude.ai connectors they
# never call (agents.json disallowedTools); without an equivalent here every
# Opus turn would still re-read all of their tool names. The denied servers had
# ZERO calls across hundreds of fork and subagent transcripts over 30 days;
# edva-tools is a second registration of the `tools` server the forks do
# call. Measured on this cwd with Haiku: prefix 84,676 -> 77,231 tokens,
# 1,091 -> 658 tool names. A per-run deny, not an account change: the user's
# own sessions keep every connector. A job that needs one back sets
# FORK_DISALLOWED_TOOLS in its trigger (an empty value turns the deny off).
# The list itself lives in lib/fork-connector-deny.sh, shared by
# every launcher with its own `claude -p` line.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fork-connector-deny.sh"
FORK_DISALLOWED_TOOLS="${FORK_DISALLOWED_TOOLS-${EDVA_FORK_CONNECTOR_DENY-}}"
# Skills hidden from the fork: the same file's skill list, passed
# with --settings so it binds this run only. Set FORK_SKILL_SETTINGS="" in a
# trigger to give a job every skill back.
FORK_SKILL_SETTINGS="${FORK_SKILL_SETTINGS-${EDVA_FORK_SKILL_SETTINGS-}}"
# + the git-rollback guard hook (D2), merged into the same --settings.
FORK_SKILL_SETTINGS="$(edva_fork_settings "$FORK_SKILL_SETTINGS")"
while [ $# -gt 0 ]; do
  case "$1" in
    --task)        TASK="${2:-}"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="${2:-0}"; shift 2 ;;
    --model)       MODEL="${2:-$MODEL}"; shift 2 ;;
    --effort)      EFFORT="${2:-$EFFORT}"; shift 2 ;;
    --cwd)         CWD="${2:-$CWD}"; shift 2 ;;
    *)             shift ;;
  esac
done

if [ -z "$JOB" ] || [ -z "$JOB_MD" ]; then
  echo "usage: run-ephemeral-opus.sh <job-name> <job-md-path> [--task \"...\"] [--timeout-min <n>]" >&2
  exit 64
fi

LOG="$LOGDIR/$JOB.log"
mkdir -p "$LOGDIR"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] $1" >> "$LOG"; }

if [ ! -f "$JOB_MD" ]; then
  log "ERROR: job file missing: $JOB_MD"
  exit 1
fi
if [ -z "$MODEL" ]; then
  log "ERROR: no model — EDVA_MODEL_OPUS missing from $MODELS_ENV and no --model given"
  exit 1
fi

# MCP service secrets (SUPABASE_ACCESS_TOKEN et al — without it the supabase MCP
# returns Unauthorized), then force the Max session: never let a stray
# ANTHROPIC_* credential silently move this onto the metered API.
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi
# Max-only: scrub every variable that can move Claude Code off the
# subscription (provider switches, tokens, a base URL `auth status` can't see),
# then refuse to start unless `claude auth status` reports Max via claude.ai.
# Costs no model call. See lib/max-auth-guard.sh.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/max-auth-guard.sh"
# The instance's own rules (agent/local/): the playbook's local companion
# and the shared + role rules the cwd's CLAUDE.md files stand for. See
# lib/local-rules.sh.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-rules.sh"
# How the refusal names this machine: the instance host_label (lib/instance.sh).
[ -n "${EDVA_HOST_LABEL:-}" ] || source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/instance.sh"
max_auth_scrub
if ! max_auth_check "$CLAUDE"; then
  # Hand-run over SSH: the keychain is out of reach, not Max. Refuse the same
  # way but page nobody — stops a false "⚠️ $JOB refused to start" alert
  # (2026-10-15).
  if max_auth_from_ssh; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY) (SSH session; not paged)" >> "$LOG"
    {
      echo "$JOB: refused to start from an SSH session. An SSH shell cannot reach the Max login in ${EDVA_HOST_LABEL:-the host}'s keychain, so \`claude auth status\` reads as signed out. Nothing ran, nothing was billed, nobody was paged."
      echo "Start it through its launchd agent instead, e.g.: launchctl kickstart gui/\$(id -u)/ai.claude.$JOB"
    } >&2
  elif max_auth_outage_owned_by_watchdog; then
    # A confirmed Max sign-in outage: watchdog.sh's 🔴 page already asked for
    # the /login, so log the refusal and page nobody — stops duplicate
    # "⚠️ $JOB refused to start" rows during one outage
    # (2026-10-21).
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY) (confirmed Max sign-in outage — watchdog.sh owns that page; not paged)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] REFUSED: not on the Max subscription ($MAX_AUTH_SUMMARY)" >> "$LOG"
    "$HOME/Dev/edva/bin/edva-send-curl" --skip-precheck --channel system --observed-error "$MAX_AUTH_SUMMARY" \
      "⚠️ $JOB refused to start: this run's \`claude auth status\` was not the Max subscription ($MAX_AUTH_SUMMARY), and these runs use nothing else. Nothing ran and nothing was billed. Remedy: sign Claude Code in to the Max account from a GUI session on ${EDVA_HOST_LABEL:-the host}." >> "$LOG" 2>&1 || true
  fi
  exit "$MAX_AUTH_REFUSED_RC"
fi

OUT_TMP="$(mktemp -t "$JOB")"
# Set by the turn-cap subshell below, read by the RC>128 branch after `wait`.
# It has to be a FILE: the subshell is a separate process, so nothing it assigns
# can reach this shell, and a bare signal number cannot tell our own cap firing
# from an operator's kill. $OUT_TMP is mktemp-unique per run, so a stale marker
# is already impossible — it is still removed on every exit path, belt and
# braces.
TIMEOUT_MARKER="$OUT_TMP.timeout"
rm -f "$TIMEOUT_MARKER"
log "start (ephemeral ${MODEL#claude-}, $EFFORT${TIMEOUT_MIN:+, ${TIMEOUT_MIN}m cap})"

# Prompt = task line + the playbook, exactly what the webhook server used to
# assemble for the supervisor.
{ [ -n "$TASK" ] && printf '%s\n\n' "$TASK"; edva_job_prompt "$JOB_MD"; } > "$OUT_TMP.prompt"
# + the local rules as --append-system-prompt-file (what the supervisors pass
# their own sessions); none when the cwd loads no Edva CLAUDE.md.
LOCAL_RULES_FILE="$OUT_TMP.local-rules"
edva_local_rules_file "$(edva_local_rules_role "$CWD")" "$LOCAL_RULES_FILE" || LOCAL_RULES_FILE=""

# --output-format json: the run's own usage is the
# only cost record an ephemeral fork can have — it runs outside every
# supervisor, so without it edva-cost-report reads "opus: 0" in weeks where
# Opus jobs ran. stdout is the JSON envelope; stderr is kept apart so it cannot
# corrupt it. After exit, fork-cost-record appends the ledger row and hands back
# the envelope's plain text into $OUT_TMP, so the guards below and the log see
# exactly the text they always did.
cd "$CWD" || { rm -f "$OUT_TMP.prompt" "$OUT_TMP.local-rules"; exit 1; }
"$CLAUDE" -p \
  --model "$MODEL" \
  --effort "$EFFORT" \
  --output-format json \
  --permission-mode bypassPermissions \
  ${FORK_DISALLOWED_TOOLS:+--disallowedTools $FORK_DISALLOWED_TOOLS} \
  ${FORK_SKILL_SETTINGS:+--settings "$FORK_SKILL_SETTINGS"} \
  ${LOCAL_RULES_FILE:+--append-system-prompt-file "$LOCAL_RULES_FILE"} \
  --add-dir "$ROOT" < "$OUT_TMP.prompt" > "$OUT_TMP.json" 2> "$OUT_TMP.err" &
CLAUDE_PID=$!

# Turn cap. The supervisor armed a per-source turn watchdog for these jobs
# (TURN_WATCHDOG_MS_BY_SOURCE); an ephemeral fork has no supervisor, so the cap
# has to live here or a wedged run holds a launchd slot indefinitely. Plain bash,
# because the host has neither `timeout` nor `gtimeout` installed.
if [ "$TIMEOUT_MIN" -gt 0 ] 2>/dev/null; then
  ( sleep $((TIMEOUT_MIN * 60))
    if kill -0 "$CLAUDE_PID" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$JOB] TIMEOUT after ${TIMEOUT_MIN}m — killing $CLAUDE_PID" >> "$LOG"
      # Leave the marker BEFORE the kill, so the parent can never wake from
      # `wait` to a signal death it cannot explain.
      printf 'TIMEOUT after %sm — killing %s\n' "$TIMEOUT_MIN" "$CLAUDE_PID" > "$TIMEOUT_MARKER"
      kill -TERM "$CLAUDE_PID" 2>/dev/null
      sleep 10
      kill -KILL "$CLAUDE_PID" 2>/dev/null
    fi ) &
  WATCHDOG_PID=$!
fi

wait "$CLAUDE_PID"
RC=$?
[ -n "${WATCHDOG_PID:-}" ] && kill "$WATCHDOG_PID" 2>/dev/null
rm -f "$OUT_TMP.prompt" "$OUT_TMP.local-rules"
# Ledger row + plain text. Unparseable output (a crash, a plain-text auth error)
# passes through unchanged and writes no row; if node itself is unavailable the
# raw envelope is used, so the guards still see SOMETHING rather than nothing.
node "$EDVA_INSTALL_TOOLS/bin/fork-cost-record" "$JOB" "$OUT_TMP.json" --model "$MODEL" > "$OUT_TMP" 2>> "$LOG" \
  || cat "$OUT_TMP.json" > "$OUT_TMP"
cat "$OUT_TMP.err" >> "$OUT_TMP" 2>/dev/null
rm -f "$OUT_TMP.json" "$OUT_TMP.err"
cat "$OUT_TMP" >> "$LOG"

# A KILLED RUN IS NOT AN AUTH FAILURE — this branch must stay ABOVE the
# auth/empty guard, because the ordering IS the fix (identical defect and
# identical remedy to bin/daily-summary-run's killed-run branch).
#
# Bash reports a signal death as 128+signal. A SIGTERM'd `claude -p` has
# written NOTHING to $OUT_TMP — it emits its output at the end — so without
# this branch the kill falls straight through to the guard's
# `[ -s "$f" ] || return 0` empty-output arm and is paged as auth, one log line
# after the script logged its own "TIMEOUT after 45m — killing <pid>". Two
# harms: the remedy the wording implies (re-login) is the wrong action, and a
# habitual cap overrun can never form its own alert cluster while every
# occurrence is mislabelled as an auth outage.
if (( RC > 128 )); then
  SIG=$((RC - 128))
  if [ -f "$TIMEOUT_MARKER" ]; then
    # Our own cap fired — attested with the line the watchdog actually wrote.
    OBSERVED="$(head -n1 "$TIMEOUT_MARKER" | cut -c1-120)"
    WHAT="hit its own ${TIMEOUT_MIN}m cap and was killed (signal $SIG)"
    LOGGED="killed by signal $SIG — its own ${TIMEOUT_MIN}m cap"
  else
    # Something else killed it; the only thing observed is what `wait` returned.
    OBSERVED="exit status $RC from wait — killed by signal $SIG"
    WHAT="was killed by signal $SIG"
    LOGGED="killed by signal $SIG"
  fi
  # Wording scoped to THIS INVOCATION for exactly the reasons in the long note
  # above the auth/empty send below — this process knows the fork it launched was
  # interrupted, never the job's final outcome, so no "did NOT run" / "was NOT
  # generated". Describes one run of one process: no machine-wide claim, so the
  # fabricated-outage gate has nothing to catch. --observed-error carries text
  # this script really captured (its own timeout log line, or the status `wait`
  # returned), which is what the mechanism-attestation gate is satisfied by.
  "$EDVA_INSTALL_TOOLS/bin/edva-send-curl" --skip-precheck --channel system --observed-error "$OBSERVED" \
    "⚠️ $JOB $WHAT — interrupted, not an auth failure, so re-login is not the remedy. Nothing was produced by this invocation; if this was the scheduled run, the pass is missing." >> "$LOG" 2>&1 || true
  log "exit 1 (guard: $LOGGED)"
  rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
  exit 1
fi

# Guard (inherited from that earlier fork trigger's hardening):
# never let an auth failure or an empty run exit 0 silently. A job that produces
# nothing is indistinguishable from a job that never ran, and these jobs are
# unattended by design.
#
# Scope the auth scan to the FIRST FEW LINES, never the whole transcript. The
# failure this guard exists for — a `claude -p` outside the Aqua session that
# cannot unlock the keychain — prints its error as line 1 and exits 0 within
# ~2 seconds. The real catches look exactly like that:
#   HH:MM:01 start / "Not logged in · Please run /login" / HH:MM:05 exit
# Grepping the entire output makes the guard fire on a run that SUCCEEDED: a
# complete system-issue-review report can quote the string `Not logged in`
# while root-causing an alert, and the guard would page "did NOT run — the
# improvement pass was NOT generated" after the job wrote its state file. These jobs read the system channel for a
# living, so auth-failure text is their SUBJECT MATTER — the more thorough the
# pass, the likelier the false positive, which is the worst possible gradient.
# Narrowing the window loses nothing: an auth failure that happens mid-run kills
# the session, so `wait` returns non-zero and the script already exits on RC.
AUTH_FAIL_RE='not logged in|please run /login|invalid (api )?key|authentication_error|unauthorized|failed to authenticate|token has been revoked|oauth session expired'
AUTH_MAX_OUTPUT_LINES=3

# The alert this fires claims THIS INVOCATION produced nothing, and stops there
# (the note at the send below says why it must not claim more). Even that narrow
# claim is warranted only when the auth error is essentially the WHOLE output —
# which is exactly what a keychain-locked run looks like: one line, and nothing
# else, in ~2 seconds.
# Scoping by total output size rather than by "does the text appear anywhere" is
# the whole fix: a thorough pass that quotes an auth alert is still a pass.
auth_or_empty_run() {
  local f="$1"
  [ -s "$f" ] || return 0                                    # produced nothing at all
  [ "$(wc -l < "$f")" -le "$AUTH_MAX_OUTPUT_LINES" ] || return 1   # produced a real report
  grep -qiE "$AUTH_FAIL_RE" "$f"
}

if auth_or_empty_run "$OUT_TMP"; then
  FIRST="$(head -n1 "$OUT_TMP" | cut -c1-120)"
  # THE WORDING IS SCOPED TO THIS INVOCATION ON PURPOSE. This process knows
  # exactly one thing: the `claude -p` it just launched exited having produced
  # nothing. It does NOT know the job's final outcome, and must never assert it.
  # Do not "strengthen" this back to "did NOT run" / "the improvement pass was
  # NOT generated" — both have been false, in opposite directions:
  #   - a HAND invocation of the trigger can die in 2s with "Not logged in"
  #     while the real launchd run succeeds a minute later, so "$JOB did NOT
  #     run" is false as the user reads it. This script cannot tell a hand run
  #     from the scheduled one, and deliberately carries NO
  #     scheduled-vs-hand-run discriminator: any such test would also silence
  #     the genuine unattended auth failures this guard exists for. The
  #     firing condition stays as-is; the sentence has to be true either way.
  #   - a scheduled hourly tick can fail (a real Max outage), so "did NOT run"
  #     is true of that tick — but the next hour's retry produces the pass, so
  #     "the improvement pass was NOT generated" is false. A later
  #     retry can always falsify a claim about the job's final state; nothing
  #     can falsify "this invocation produced nothing".
  # Keep it loud. Its whole purpose is catching an unattended run that failed in
  # silence, and a page nobody acts on is the same as no page.
  #
  # --observed-error: this line already quotes real captured output ($FIRST,
  # the claude -p run's own first line) — the flag is required by
  # edva-send-curl's mechanism-attestation gate whenever that text names a
  # specific failure (e.g. "OAuth session expired"), and passing the same
  # string back costs nothing since it's already captured.
  "$EDVA_INSTALL_TOOLS/bin/edva-send-curl" --skip-precheck --channel system --observed-error "$FIRST" \
    "⚠️ $JOB exited without producing output — auth/empty (\"${FIRST}\"). Nothing was generated by this invocation; if this was the scheduled run, the pass is missing." >> "$LOG" 2>&1 || true
  log "exit 1 (guard: auth/empty run)"
  rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
  exit 1
fi

rm -f "$OUT_TMP" "$TIMEOUT_MARKER"
log "exit $RC"
exit $RC
