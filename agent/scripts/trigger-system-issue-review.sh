#!/bin/bash
# Run the nightly system-issue-review job as an ephemeral Opus 5 agent.
#
# All improvement-related processes run on Opus (a user rule). POSTing to the
# heavy supervisor at :9092 would make this Sonnet work — `"model": "opus"` in
# job-routing.json is a TIER label, not a model id — so it runs as a dedicated
# `claude -p --model <Opus> --effort xhigh` via lib/run-ephemeral-opus.sh.
# The GATE below does all the work of deciding whether to run at all — which
# matters, since each run is an Opus run.
#
# Two consequences of not running on the supervisor worth knowing:
#   - No supervisor turn watchdog (TURN_WATCHDOG_MS_BY_SOURCE); the runner
#     enforces a 45-min cap itself instead.
#   - There is no dispatch queue, so a run that would be queued behind a
#     busy supervisor simply starts. That is fine at this cadence (nightly +
#     a heavily-deduped hourly) and removes the requeue-then-drop failure mode.
#
# LAUNCHED BY LAUNCHD (ai.claude.system-issue-review{,-critical}), not crontab —
# a `claude -p` under cron cannot unlock the keychain holding the Max creds.
#
# Mines Edva's own SYSTEM CHANNEL for alerts, clusters them into issues,
# root-causes each open one, and ships the fix through the unified
# self-improvement pipeline (low/moderate auto-apply + green-check card; high
# risk → Face-ID card). Closes the loop the system channel never had: alerts
# fired reliably, but without a reviewer nobody root-caused them (the same
# alerts repeated for days or weeks, unfixed).
# See jobs/system-issue-review.md.
#
# Like chat-consolidate, the FETCH happens here in the un-sandboxed cron process
# and lands in a LOCAL file, so the agent turn stays fully local — the agent's
# sandboxed Bash cannot reach Supabase or the keychain.
#
# Gate: skip the dispatch when there is genuinely nothing to do — no new
# assistant-authored system alerts since the cursor AND no cluster whose
# verification window has come due.
#
# TWO CADENCES (a user rule: every issue reported in the system channel gets
# a review, even if the system auto-healed):
#
#   nightly (no flag, 04:27 local) — the full pass. Reviews everything, including
#     auto-healed incidents, rather than closing them unread.
#   --critical-only (hourly)    — same-day escalation for a genuinely NEW 🔴
#     condition, so a capability-down issue doesn't wait up to 24h.
#
# The hourly mode is aggressively deduped by lib/system-issue-gate.mjs,
# and that is the whole design problem: in a real 14-day window, most 🔴 alerts
# were repeats of one or two conditions (e.g. "Max auth is DOWN"). A naive
# "critical and newer than the cursor" gate would fire ~17 heavy dispatches in
# one night for one already-carded issue (at ~$1.7 a turn). A worst-case replay
# over that live batch yields 1 escalation, 21 suppressed as already-being-worked.

export PATH="/opt/homebrew/bin:$PATH"
# The operator's name for the task text (lib/instance.cjs).
source "$(dirname "$0")/lib/instance.sh"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
ROOT="$EDVA_INSTALL"
LOGFILE="$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"
JOB_MD="$EDVA_INSTALL_TOOLS/agent/ops-agent/jobs/system-issue-review.md"

MODE="nightly"
for arg in "$@"; do
  case "$arg" in
    --critical-only) MODE="critical" ;;
  esac
done

# The playbook picks its lane from the dispatch mode. An ephemeral run has no
# webhook payload (`reason` field), so the mode travels in the opening message
# instead — same information, same two lanes.
if [ "$MODE" = "critical" ]; then
  TASK='Run the SYSTEM ISSUE REVIEW job in CRITICAL-ESCALATION mode (this is the hourly same-day lane, equivalent to the webhook payload {"job":"system-issue-review","reason":"critical-escalation"}). Follow § Critical-escalation dispatch: cluster normally, then take ONLY the highest-scoring critical cluster and do that one thing. ultrathink.'
else
  TASK='Run the SYSTEM ISSUE REVIEW job (nightly full pass, equivalent to the webhook payload {"job":"system-issue-review"}). Follow the playbook below end-to-end. ultrathink — root-causing an alert correctly is the whole value here, and a wrong diagnosis becomes a code change '"${EDVA_OWNER_NAME:-the user}"' has to approve.'
fi

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [system-issue-review${MODE:+/$MODE}] $1" >> "$LOGFILE"; }

# --- fetch the last 14d of system-channel rows → local batch; print "<new>:<due>:<crit>:<sig>" ---
# new  = assistant alerts newer than the state cursor (the work signal)
# due  = clusters in verifying/awaiting_approval whose verify_after has passed
# crit = NEW 🔴 conditions earning a same-day pass (deduped; see system-issue-gate.mjs)
# sig  = base64 signature of the one condition to escalate, recorded only after
#        a successful dispatch so a transient webhook failure doesn't burn it
GATE=$(cd "$EDVA_INSTALL_TOOLS" && node -e '
const {fetchJson}=require("./lib/supabase-rest.js");
const fs=require("fs"),os=require("os"),path=require("path");
const D=path.join(os.homedir(),"Dev/edva/data");
let cursor="1970-01-01T00:00:00Z", clusters=[];
try{
  const s=JSON.parse(fs.readFileSync(path.join(D,"system-issue-review-state.json"),"utf8"));
  if(s.cursor_ts) cursor=s.cursor_ts;
  if(Array.isArray(s.clusters)) clusters=s.clusters;
}catch{}
let dispatched={};
try{ dispatched=JSON.parse(fs.readFileSync(path.join(D,"system-issue-review-critical-dispatched.json"),"utf8"))||{}; }catch{}
// 14d window: the job needs recurrence history, not just the delta, to weight
// clusters and to tell a self-healed blip from a flapping defect.
const since=new Date(Date.now()-14*864e5).toISOString();
const q="/rest/v1/edva_messages?select=id,role,content,created_at&channel=eq.system"
  +"&created_at=gt."+encodeURIComponent(since)+"&order=created_at.asc&limit=1000";
const now=Date.now();
const due=clusters.filter(c=>c&&["verifying","awaiting_approval"].includes(c.status)
  &&c.verify_after&&Date.parse(c.verify_after)<=now).length;
fetchJson(q,{timeoutMs:10000}).then(rows=>{
  rows=Array.isArray(rows)?rows.filter(r=>r&&typeof r.content==="string"&&r.content.trim()):[];
  // Jev shadow-week disagreement pages ("🔀 Jev disagreement [...]") are owned
  // by jev-disagreement-review, which has the decision logs this job lacks.
  // Counting them here would re-investigate every one as a system defect.
  rows=rows.filter(r=>!r.content.startsWith("\u{1F500} Jev"));
  // Truncate pathological alerts. Some jobs paste an entire failed subprocess
  // invocation into the alert text — one 2026-07-17 pair carried
  // ~8KB each of embedded agent prompt. The diagnostic signal is all in the
  // first line or two (job, binary, error class); the tail is dead weight in
  // the turn"s context. 9 of 185 rows exceeded this on the first real batch.
  const CAP=800;
  rows=rows.map(r=>r.content.length>CAP
    ? {...r, content:r.content.slice(0,CAP)+" …[truncated "+(r.content.length-CAP)+" chars]"}
    : r);
  try{fs.writeFileSync(path.join(D,"system-issue-review-pending.json"),JSON.stringify(rows,null,2));}catch{}
  const fresh=rows.filter(r=>r.role==="assistant"&&r.created_at>cursor).length;
  // Same-day critical selection. Dedup lives in the module so it is testable
  // (tests/system-issue-gate.test.mjs) — the failure mode is a burst of
  // duplicate heavy dispatches, which prose comments did not prevent before.
  return import("./lib/system-issue-gate.mjs").then(g=>{
    const {escalate}=g.selectCriticalEscalations({rows,cursor,clusters,dispatched,max:1});
    const sig=escalate.length?Buffer.from(escalate[0].signature,"utf8").toString("base64"):"";
    process.stdout.write(fresh+":"+due+":"+escalate.length+":"+sig);
  });
}).catch(()=>process.stdout.write("ERR:"+due+":0:"));
' 2>/dev/null || echo "ERR:0:0:")

if [ "${GATE%%:*}" = "ERR" ]; then
  # Upstream fetch failed. Log and skip — this job must never page about its own
  # dependencies being down (agent/CLAUDE.md § System Channel: only
  # watchdog.sh authors infra alerts, from concrete un-sandboxed probes).
  log "skip: supabase fetch failed"
  exit 0
fi

IFS=':' read -r NEW DUE CRIT CRIT_SIG <<< "$GATE"
NEW="${NEW:-0}"; DUE="${DUE:-0}"; CRIT="${CRIT:-0}"

if [ "$MODE" = "critical" ]; then
  # Same-day lane: the ONLY reason to dispatch off-schedule is a genuinely new
  # critical condition. Everything else — warnings, recoveries, repeats of an
  # issue already in flight — waits for the nightly pass, which now reviews
  # auto-healed incidents too rather than closing them unread.
  if [ "$CRIT" -eq 0 ]; then
    log "skip: no new critical condition (nightly pass owns the rest)"
    exit 0
  fi
else
  if [ "$NEW" -eq 0 ] && [ "$DUE" -eq 0 ]; then
    log "skip: no new system alerts and nothing due for verification"
    exit 0
  fi
fi

# Record the escalated signature so the next hourly run doesn't re-dispatch the
# same condition. Called only AFTER a confirmed dispatch — a webhook failure
# must not silently consume the 24h dedup window for a live critical issue.
record_critical() {
  [ "$MODE" = "critical" ] || return 0
  [ -n "$CRIT_SIG" ] || return 0
  (cd "$EDVA_INSTALL_TOOLS" && CRIT_SIG="$CRIT_SIG" node -e '
    const fs=require("fs"),os=require("os"),path=require("path");
    const D=path.join(os.homedir(),"Dev/edva/data");
    const F=path.join(D,"system-issue-review-critical-dispatched.json");
    const sig=Buffer.from(process.env.CRIT_SIG,"base64").toString("utf8");
    import("./lib/system-issue-gate.mjs").then(g=>{
      let cur={}; try{cur=JSON.parse(fs.readFileSync(F,"utf8"))||{};}catch{}
      const next=g.pruneDispatched(cur);
      next[sig]=new Date().toISOString();
      fs.writeFileSync(F,JSON.stringify(next,null,2));
    }).catch(()=>{});
  ' 2>/dev/null) || true
}

# Undo record_critical when the run never produced a review. The signature is
# recorded BEFORE the run on purpose — a 45-minute pass must not be re-dispatched
# by the next hourly tick while it is still working — but that means a run which
# dies on launch burns the whole 24h dedup window for a live 🔴 condition.
#
# The case this exists for: a Max-auth 🔴 escalation whose run dies immediately
# on the auth guard in run-ephemeral-opus.sh — the very outage it was dispatched
# to review is what stops it running. Without the rollback the condition waits
# for the nightly pass, which is exactly the delay the hourly lane exists to
# prevent. (record_critical fires BEFORE the run starts, not after.)
#
# Rolling back on ANY non-zero exit is deliberate — a timeout kill, a crashed
# turn and an auth failure all leave the condition unreviewed, and re-dispatching
# an hour later is cheap next to losing a capability-down issue for a day. The
# gate's other suppressors still apply on the retry: if the nightly pass has
# since clustered and carded the condition, `being_worked` drops it anyway.
unrecord_critical() {
  [ "$MODE" = "critical" ] || return 0
  [ -n "$CRIT_SIG" ] || return 0
  (cd "$EDVA_INSTALL_TOOLS" && CRIT_SIG="$CRIT_SIG" node -e '
    const fs=require("fs"),os=require("os"),path=require("path");
    const D=path.join(os.homedir(),"Dev/edva/data");
    const F=path.join(D,"system-issue-review-critical-dispatched.json");
    const sig=Buffer.from(process.env.CRIT_SIG,"base64").toString("utf8");
    let cur={}; try{cur=JSON.parse(fs.readFileSync(F,"utf8"))||{};}catch{}
    if (Object.prototype.hasOwnProperty.call(cur,sig)) {
      delete cur[sig];
      fs.writeFileSync(F,JSON.stringify(cur,null,2));
    }
  ' 2>/dev/null) || true
}

# ── INSTRUMENTATION ONLY — NOT A FIX. Do not close the cluster on this. ─────
# This job has hit its own 45-minute cap on consecutive nights (passes that
# produce nothing), after a long run of 7-22 minute passes.
#
# Two explanations were never separated, and they have different remedies:
#   (i)  this job's own state file (data/system-issue-review-state.json,
#        hundreds of KB, mostly `resolved` clusters) is the binding
#        constraint — every pass reads it at Step 1, so the per-turn context
#        floor grows with it; or
#   (ii) the per-run work budget is simply genuinely bigger now.
# The review deliberately proposed NO remedy and asked for measurement
# instead: a state-file size series to set against the run durations. (Reading
# the file via jq projections rather than whole-file reads brought one run
# down to ~17 min — suggestive, not conclusive, n=1.)
#
# So this block changes NO decision, NO gate, NO cap, NO dispatch and NO budget.
# It appends one line per dispatched run to THIS JOB'S OWN log — the same file
# run-ephemeral-opus.sh writes its `start` / `exit` / `TIMEOUT after 45m` lines
# to — so each night's size lands next to that night's duration and the series
# reads with one grep:
#   grep -E 'state-size|^.* start |exit ' agent/logs/system-issue-review.log
# Deliberately NOT watchdog.log, which would separate the size from the duration.
#
# Every failure is swallowed (`2>/dev/null`, `|| true`, `${VAR:-?}` defaults) and
# the whole block is gated on the file existing: a missing state file, a jq
# error or an unwritable log must never stop the nightly dispatch. Turning a
# measurement into an outage would be strictly worse than not measuring. This
# script has no `set -e`, and nothing here relies on that either way.
STATE_FILE="$EDVA_INSTALL_TOOLS/data/system-issue-review-state.json"
SIR_LOG="$EDVA_INSTALL_TOOLS/agent/logs/system-issue-review.log"
if [ -f "$STATE_FILE" ]; then
  STATE_BYTES="$(wc -c < "$STATE_FILE" 2>/dev/null | tr -d ' ')"
  STATE_CLUSTERS="$(/usr/bin/jq -r '[.clusters[]?] | length' "$STATE_FILE" 2>/dev/null)"
  STATE_BY_STATUS="$(/usr/bin/jq -r '[.clusters[]?.status // "unknown"] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$STATE_FILE" 2>/dev/null)"
  # The append runs in a subshell so that even a FAILED redirection (unwritable
  # log, missing logs dir) is silent: bash reports a redirect error on the
  # shell's own stderr before the command's `2>/dev/null` would apply, and the
  # subshell is what puts that message inside the suppressed stream.
  ( echo "$(date '+%Y-%m-%d %H:%M:%S') [system-issue-review${MODE:+/$MODE}] state-size: ${STATE_BYTES:-?} bytes, ${STATE_CLUSTERS:-?} clusters (${STATE_BY_STATUS:-?})" \
    >> "$SIR_LOG" ) 2>/dev/null || true
fi

log "Running system-issue-review ($NEW new alerts, $DUE due, $CRIT critical) — ephemeral opus-5"
record_critical

"$SCRIPTS/lib/run-ephemeral-opus.sh" system-issue-review "$JOB_MD" --task "$TASK" --timeout-min 45
RC=$?
log "system-issue-review exited $RC"
if [ "$RC" -ne 0 ]; then
  unrecord_critical
  [ "$MODE" = "critical" ] && log "critical run failed (exit $RC) — released the dedup signature so the next hourly tick can retry"
fi
exit $RC
