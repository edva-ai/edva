#!/bin/bash
source "$(dirname "$0")/lib/webhook-auth.sh"
# Trigger hum via webhook → ops agent.
#
# MODES:
#   tick (default)  Called every 20 min by cron. WATCHDOG ONLY: hum is
#                   driven by the hum-sense event
#                   engine (see below), and this tick exits immediately
#                   whenever that engine is alive. It dispatches only when
#                   the engine's heartbeat has gone stale — i.e. the event
#                   path is down and something has to keep hum breathing.
#
#   --manual        Dev/testing. Bypasses activity + cap gates; still honors
#                   the lock. Used by `edva hum test`.
#
# No --after-message piggyback or --silence-check modes; see jobs/hum.md.
#
# The tick is not the thing that drives hum. Sensors
# (agent/scripts/hum-sensors/) detect real situational edges — arrival,
# a meeting ending, rain starting, a workout finishing, the city changing —
# and the gate in lib/hum-events.mjs decides whether the moment is worth
# an agent turn. The "nothing is happening, say something anyway" path still
# exists but lives inside that engine as the `idle` sensor, where it is at
# least situationally gated. What remains here is a failsafe, nothing more.

export PATH="/opt/homebrew/bin:$PATH"

MODE="tick"
case "$1" in
  --manual)        MODE="manual" ;;
  "")              MODE="tick" ;;
  *)               echo "unknown mode: $1" >&2; exit 2 ;;
esac

resolve_tier_ports hum   # tier-routes WEBHOOK_PORT + HEALTH_PORT (hum is sonnet → ops-light; was :9092 Opus)
LOGFILE="$HOME/Dev/edva/agent/logs/watchdog.log"
STATE_FILE="$HOME/Dev/edva/data/hum-state.json"
HEARTBEAT_FILE="$HOME/Dev/edva/data/hum-sense-heartbeat.json"
# How stale the hum-sense heartbeat must be before this cron considers the
# event engine dead and takes over. The daemon stamps it every tick (10s), so
# 5 minutes is ~30 missed ticks — comfortably past a restart or a slow pass.
SENSE_STALE_MIN=5
PAYLOAD="{\"job\": \"hum\", \"trigger\": \"$MODE\"}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum:$MODE] $1" >> "$LOGFILE"; }

is_healthy() {
  local health
  health=$(curl -sf --max-time 5 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null) || return 1
  echo "$health" | grep -q '"childAlive":true' || return 1
  # Dispatcher pauses itself during an auth outage; no point dispatching while
  # the supervisor is deliberately refusing to drain.
  echo "$health" | grep -q '"dispatcherPaused":true' && return 1
  return 0
}

dispatch() {
  curl -s --max-time 10 -X POST "http://localhost:$WEBHOOK_PORT" \
    -H "Content-Type: application/json" "${CURL_AUTH[@]}" -d "$PAYLOAD" > /dev/null 2>&1
}

# --- bash gates (skip most ticks before the LLM call) ---

# Hard quiet window: 00:00-09:00 local, the same span as the hum gate's default
# quiet_hours (lib/hum-events.mjs). Manual mode bypasses it. No reason to
# tick while the user is likely asleep.
USER_TZ_FILE="$HOME/Dev/edva/data/user-timezone.json"
# Fallback: the home timezone (lib/instance.cjs tz, as EDVA_TZ).
source "$(dirname "$0")/lib/instance.sh"
USER_TZ="${EDVA_TZ:-UTC}"
if [ -f "$USER_TZ_FILE" ]; then
  PARSED_TZ=$(jq -r '.timezone // empty' "$USER_TZ_FILE" 2>/dev/null)
  if [ -n "$PARSED_TZ" ] && TZ="$PARSED_TZ" date +%H >/dev/null 2>&1; then
    USER_TZ="$PARSED_TZ"
  fi
fi
HOUR_LOCAL=$(TZ="$USER_TZ" date +%H)
if [ "$MODE" != "manual" ] && [ "$HOUR_LOCAL" -lt 9 ]; then
  exit 0
fi

# Activity state gate (soft). Skip if the user is sleeping/winding down.
if [ "$MODE" != "manual" ]; then
  EDVA_BIN="$HOME/Dev/edva/bin/edva"
  if [ -x "$EDVA_BIN" ]; then
    STATE=$("$EDVA_BIN" activity --state-only 2>/dev/null)
    if [ "$STATE" = "sleeping" ] || [ "$STATE" = "winding_down" ]; then
      log "skip:activity=$STATE"
      exit 0
    fi
  fi
fi

# Calendar busy gate: skip if the user is in a meeting right now.
# Transparent/free events (e.g. entries kept only to show someone else's plans) don't block.
# Same verdict as the hum-sense calendar sensor: its pure
# calendarSituation(), with the model verdicts the daemon cached for events
# over three hours. A long event with no cached verdict holds, as before.
if [ "$MODE" != "manual" ]; then
  GOG_BIN="/opt/homebrew/bin/gog"
  if [ -x "$GOG_BIN" ]; then
    NOW_ISO=$(TZ="$USER_TZ" date -Iseconds)
    FOUR_AGO=$(TZ="$USER_TZ" date -v-4H -Iseconds)
    IN_MEETING=$("$GOG_BIN" calendar list --json --results-only --from "$FOUR_AGO" --to "$NOW_ISO" --all 2>/dev/null | \
      node --input-type=module -e '
        import fs from "node:fs";
        const cal = await import(process.argv[1]);
        let memo = {};
        try { memo = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).sensors?.calendar?.memo || {}; } catch {}
        const s = cal.calendarSituation(cal.parseEvents(JSON.parse(fs.readFileSync(0, "utf8"))), { nowMs: Date.now(), verdicts: memo.verdicts || {} });
        console.log(s.hold ? 1 : 0);
      ' "$HOME/Dev/edva/agent/scripts/hum-sensors/calendar.mjs" "$HOME/Dev/edva/data/hum-sense-state.json" 2>/dev/null)
    if [ "${IN_MEETING:-0}" -gt 0 ]; then
      log "skip:in_meeting"
      exit 0
    fi
  fi
fi

# State-date guard + pause gate (state-file aware). Manual mode bypasses pause
# but still runs the date roll-over so counters reset cleanly after midnight.
#
# hum-state.json.today.date can lag by a day mid-session (supervisor restart +
# stale fixture), leaving runs/pings counters from the wrong date. Force a counter
# reset here whenever today.date != local-today, BEFORE hum.md increments
# them.
LOCAL_TODAY=$(TZ="$USER_TZ" date +%Y-%m-%d)
DECISION=$(node <<NODE 2>>"$LOGFILE"
const fs = require('fs');
const MODE = '$MODE';
const STATE_FILE = '$STATE_FILE';
const LOCAL_TODAY = '$LOCAL_TODAY';
let s;
try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { console.log('go'); process.exit(0); }
const now = Date.now();
// Date roll-over: reset today counters when state-file date != local-today.
// Writes back atomically before any other logic runs.
if (s.today && s.today.date && s.today.date !== LOCAL_TODAY) {
  s.today = { date: LOCAL_TODAY, runs: 0, pings: 0, questions: 0 };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); } catch (e) {}
  process.stderr.write('[hum] reset today counters (date rollover)\n');
}
if (s.pause && s.pause.until && new Date(s.pause.until).getTime() > now) {
  console.log('skip:paused'); process.exit(0);
}
// No cap check here: the daily ping budget (6/day, 45 min apart) is enforced
// per candidate, pre-rank and in hum-ping (exit 11) — lib/ping-budget.mjs.
// A tick at cap still runs; only Rule #1 / >= 0.9 candidates can ship from it.
console.log('go');
NODE
)

case "$DECISION" in
  go) ;;
  skip:*)
    log "decision=$DECISION"
    exit 0
    ;;
  *)
    log "decision=unexpected '$DECISION' (treating as skip)"
    exit 0
    ;;
esac

# --- lift the crontab half of a hum pause ---
# Reaching this line means the pause gate above said "go": hum is NOT paused.
# But pausing hum switches off two different things, and only one of them
# comes back by itself. `edva hum pause` writes hum-state.json, which the gate above
# reads; the eight daily hum jobs are switched off separately, by prefixing
# their crontab lines with #HUMPAUSE#. Without this, a pause expiring (or
# `edva hum resume`) brings this */20 tick back and leaves hum-daily,
# ideation, review, canary, consolidate, metrics-collect, weekly-ideation and
# action-executor commented out for good — with hum looking alive, because the
# tick is running.
#
# Doing it here rather than in `hum resume` covers both ways a pause ends: the
# expiry (nobody runs anything) and the manual resume. No #HUMPAUSE# lines is
# the overwhelmingly common case and costs one `crontab -l`; the install only
# happens when there is something to restore, so this is a no-op on every
# ordinary tick. Caveat worth knowing: #HUMPAUSE# means "paused with hum", so
# do not use that marker to disable a hum job long-term — it will come back.
CRON_UNPAUSE="$HOME/Dev/edva/bin/cron-unpause"
if [ -x "$CRON_UNPAUSE" ]; then
  RESTORED=$("$CRON_UNPAUSE" HUMPAUSE 2>&1)
  [ -n "$RESTORED" ] && log "$RESTORED"
fi

# --- hum-sense watchdog gate ---
# Situational awareness drives hum now; this cron does not. If the hum-sense
# daemon is alive, it owns every dispatch decision — including the idle path,
# which lives there as the `idle` sensor — and this tick has nothing to add,
# so it exits. Only a stale heartbeat (engine crashed, launchd not loaded,
# machine restarted mid-day) promotes this back into the plain fallback tick
# it used to be, so hum degrades to "quieter and dumber" rather than "silent".
if [ "$MODE" != "manual" ]; then
  SENSE_AGE_MIN=$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      console.log(Math.round((Date.now() - new Date(s.ts).getTime()) / 60000));
    } catch { console.log(999999); }
  " "$HEARTBEAT_FILE" 2>/dev/null)
  if [ -n "$SENSE_AGE_MIN" ] && [ "$SENSE_AGE_MIN" -lt "$SENSE_STALE_MIN" ] 2>/dev/null; then
    log "skip:hum_sense_live (heartbeat ${SENSE_AGE_MIN}m ago)"
    exit 0
  fi
  log "hum-sense heartbeat stale (${SENSE_AGE_MIN}m) — falling back to a cron tick"
fi
PAYLOAD="{\"job\": \"hum\", \"trigger\": \"watchdog-fallback\"}"

# --- deliver a queued qualitative (lane-diagnosis) question, if any ---
# Runs only on go-ticks, i.e. after the sleep/activity/calendar/pause gates that
# protect every hum ping. hum-metrics-collect (06:29 local, inside the sleep window)
# queues these; this delivers at the next good moment and atomically writes the
# pending slot only on a real send — so a never-delivered zombie question can't
# occupy the slot for 48h. Fail-safe: never blocks the tick.
#
# Since hum-sense drives hum, this line is only reached on a
# fallback tick (the heartbeat gate above exits first), so a queued question
# waits for one.
#
# THROUGH LAUNCHD. The question is sent through edva-send-curl,
# whose resolve-first gate and outbound precheck are `claude -p` on the Max
# login, which this cron script cannot reach: both would fail open, and the
# question would go out unchecked. A queued question now kicks the
# on-demand agent ai.claude.hum-deliver-qual (run-hum-deliver-qual.sh), which
# checks the Max login first and otherwise leaves the question queued. The
# kick returns at once, so this waits (up to 150s: the gate's 90s deadline plus
# the precheck) for that run to finish before the hum dispatch below, as it
# did when delivery ran inline: both write hum-state.json and the pending slot.
QUAL_QUEUE="$HOME/Dev/edva/data/hum-qual-delivery-queue.json"
if [ "$MODE" != "manual" ] && [ -s "$QUAL_QUEUE" ]; then
  source "$(dirname "$0")/lib/launchd-kick.sh"
  if launchd_kick ai.claude.hum-deliver-qual hum-deliver-qual; then
    for _ in $(seq 1 30); do
      launchctl print "gui/$(id -u)/ai.claude.hum-deliver-qual" 2>/dev/null | grep -q "state = running" || break
      sleep 5
    done
  fi
fi

# --- dispatch (with health retry) ---
if is_healthy; then
  dispatch
  log "Dispatched hum"
  exit 0
fi

log "First attempt failed, retrying in 60s"
sleep 60

if is_healthy; then
  dispatch
  log "Dispatched hum (retry)"
  exit 0
fi

log "Pulse failed: supervisor unhealthy after retry"
exit 1
