#!/bin/bash
# cron runs with PATH=/usr/bin:/bin; tools like gmail-action need node via
# homebrew. Set PATH explicitly so checks don't silently no-op (the Gmail
# unread sweep was dead from Apr 10 2026 until this was added).
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin
source "$(dirname "$0")/lib/webhook-auth.sh"
# watchdog.sh — health monitor for the agent process-manager.
# Runs every 5 min via cron: */5 * * * * /path/to/watchdog.sh
#
# The process-manager handles spawning and restarting child processes directly.
# This watchdog focuses on higher-level health:
#   - Ops supervisor HTTP health + event staleness
#   - Gmail push delivery gaps
#   - Crash-loop detection (via supervisor /health)
#   - Alerting via Merlin / email draft
#
# It no longer manages tmux sessions or panes.

LOG="${MERLIN_HOME}/agent/logs/watchdog.log"
NODE=/opt/homebrew/bin/node
SEND="${MERLIN_HOME}/bin/merlin-send-curl"
GMAIL_ACTION="${MERLIN_HOME}/bin/gmail-action"
WORKDIR="${MERLIN_HOME}/agent"
SUPERVISOR_DIR="$WORKDIR/supervisor"
CONFIG_DIR="$WORKDIR/config"
ALERT_COOLDOWN="${MERLIN_HOME}/data/.watchdog-last-alert"
STALE_RESTART_COOLDOWN="${MERLIN_HOME}/data/.triage-restart-cooldown"
HOOKDECK_RESTART_COOLDOWN="${MERLIN_HOME}/data/.hookdeck-restart-cooldown"
HOOKDECK_RESTART_MIN_AGE=600  # seconds disconnected before auto-restart (10 min)
HOOKDECK_DISCONNECT_MARKER="${MERLIN_HOME}/data/.hookdeck-disconnect-active"
HOOKDECK_DIAG_DIR="${MERLIN_HOME}/agent/logs/hookdeck-diagnostics"
STALE_EVENT_MS=600000  # 10 min without supervisor events = stale
PUSH_GAP_MS=3600000    # 60 min without Gmail push = likely Pub/Sub delivery failure

# Supervisor health port
eval "$("$CONFIG_DIR/load-agent.sh" ops)"
HEALTH_PORT="$AGENT_SUPERVISOR_HEALTH_PORT"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# log_throttled — write a log line at most once per cooldown window (default
# 16 min, matching should_alert). Use for persistent conditions (push gaps,
# known-disconnect states) so the log doesn't fill up with ~158 duplicates
# during a single incident.
log_throttled() {
  local marker="$1" msg="$2" period="${3:-900}"
  if [ -f "$marker" ]; then
    local age=$(( $(date +%s) - $(stat -f%m "$marker") ))
    [ "$age" -lt "$period" ] && return 0
  fi
  touch "$marker"
  log "$msg"
}

# log_on_change — write a log line only when $key differs from the marker's
# recorded value. Writes the new key to the marker after logging. Keeps the
# summary "Watchdog issues:" line from repeating per tick when the set of
# issues hasn't changed.
log_on_change() {
  local marker="$1" key="$2" msg="$3"
  local prev=""
  [ -f "$marker" ] && prev=$(cat "$marker" 2>/dev/null)
  if [ "$key" != "$prev" ]; then
    printf '%s' "$key" > "$marker"
    log "$msg"
  fi
}

notify() {
  # --skip-precheck: watchdog alerts are critical liveness signals (process
  # crashed, disk full, network down). They must bypass the Sonnet-gated
  # outbound precheck because (a) precheck depends on Supabase being
  # reachable, which is itself a thing the watchdog might be alerting on,
  # and (b) delaying or suppressing a liveness alert defeats its purpose.
  if "$SEND" --skip-precheck --intent watchdog-alert --channel system "$1" > /dev/null 2>&1; then
    log "Notified via Merlin: $1"
  elif [ -x "$GMAIL_ACTION" ]; then
    "$GMAIL_ACTION" draft "${MERLIN_OWNER_EMAIL}" "🔴 Mac Mini Watchdog" "$1" > /dev/null 2>&1
    log "Notified via email draft (Merlin unavailable): $1"
  else
    log "ALERT (no notification channel): $1"
  fi
}

should_alert() {
  if [ -f "$ALERT_COOLDOWN" ]; then
    local age=$(( $(date +%s) - $(stat -f%m "$ALERT_COOLDOWN") ))
    [ "$age" -lt 900 ] && return 1
  fi
  touch "$ALERT_COOLDOWN"
  return 0
}

# --- Heal-then-alert pattern (per-incident state) ---
# Per the heal-then-alert rule (feedback_alerts_self_heal_first.md): the watchdog must
# exhaust auto-repair before paging. Each incident type tracks its own
# consecutive-failure counter. Self-heal fires every tick (idempotent), but
# the user-facing alert only goes out once the heal has demonstrably failed
# — i.e. the same condition still trips on the NEXT tick (count >= 2).
# When the probe passes again, the incident state clears so the next failure
# starts fresh.
INCIDENT_DIR="${MERLIN_HOME}/data/watchdog-incidents"
mkdir -p "$INCIDENT_DIR" 2>/dev/null

# incident_seen <key> — increment and echo the consecutive-failure count.
# Also resets the green-streak counter so a single-tick flicker doesn't trip
# incident_clear's recovery threshold.
incident_seen() {
  local key="$1"
  local file="$INCIDENT_DIR/$key"
  local n=0
  if [ -f "$file" ]; then
    n=$(cat "$file" 2>/dev/null || echo 0)
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
  fi
  n=$((n + 1))
  echo "$n" > "$file"
  rm -f "$INCIDENT_DIR/${key}.green_streak" 2>/dev/null
  echo "$n"
}

# incident_clear <key> — call when the probe passes.
# A single green tick is NOT enough to declare recovery: an intermittent probe
# (port flickers, transient HTTP 200) used to wipe the alert cooldown and
# allow the next failure to re-page. Now we require 3 consecutive green ticks
# before clearing alert state — that matches "the issue actually went away"
# rather than "the probe blinked." Counter is always reset on green so the
# self-heal logic (incident_seen >= 2) still works on the next failure cycle.
incident_clear() {
  local key="$1"
  rm -f "$INCIDENT_DIR/$key" 2>/dev/null
  local streak_file="$INCIDENT_DIR/${key}.green_streak"
  local streak=0
  [ -f "$streak_file" ] && streak=$(cat "$streak_file" 2>/dev/null || echo 0)
  [[ "$streak" =~ ^[0-9]+$ ]] || streak=0
  streak=$((streak + 1))
  echo "$streak" > "$streak_file"
  if [ "$streak" -ge 3 ]; then
    rm -f "$INCIDENT_DIR/${key}.alerted" \
          "$INCIDENT_DIR/${key}.alert_count" \
          "$INCIDENT_DIR/${key}.alert_first" \
          "$streak_file" 2>/dev/null
  fi
}

# incident_should_alert <key> [cooldown_sec=86400] [max_alerts=3] [max_window_sec=21600]
# Per-incident cooldown + cap. Two gates, in order:
#   1) 24h sliding cooldown (existing) — same incident does not re-page within 24h.
#   2) Hard cap — after max_alerts alerts within max_window (default 6h), suppress
#      further pings for the same incident until either the probe goes green for
#      3 consecutive ticks (incident_clear above) OR max_window elapses since the
#      first alert. This stops repeated-page loops (e.g. the wiki-server-down case
#      where a stuck condition can produce 3 identical "manual intervention
#      needed" pings in an hour while the user is asleep — alerts they could
#      not act on remotely).
incident_should_alert() {
  local key="$1"
  local cooldown="${2:-86400}"
  local max_alerts="${3:-3}"
  local max_window="${4:-21600}"
  local alerted_file="$INCIDENT_DIR/${key}.alerted"
  local count_file="$INCIDENT_DIR/${key}.alert_count"
  local first_file="$INCIDENT_DIR/${key}.alert_first"

  if [ -f "$alerted_file" ]; then
    local age=$(( $(date +%s) - $(stat -f%m "$alerted_file") ))
    [ "$age" -lt "$cooldown" ] && return 1
  fi

  local count=0
  if [ -f "$count_file" ]; then
    count=$(cat "$count_file" 2>/dev/null || echo 0)
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
  fi
  if [ "$count" -ge "$max_alerts" ] && [ -f "$first_file" ]; then
    local window_age=$(( $(date +%s) - $(stat -f%m "$first_file") ))
    if [ "$window_age" -lt "$max_window" ]; then
      return 1
    fi
    rm -f "$first_file" 2>/dev/null
    count=0
  fi

  touch "$alerted_file"
  count=$((count + 1))
  echo "$count" > "$count_file"
  [ ! -f "$first_file" ] && touch "$first_file"
  return 0
}

# hookdeck_local_probe — synthetic-webhook liveness gate for Hookdeck alerts.
# The watchdog's "Connection lost with no recovery marker" heuristic gives
# false positives on idle-but-healthy tunnels (no Gmail events yet = no
# [200] POST line). Per the heal-then-alert rule (feedback_alerts_self_heal_first.md)
# we must exhaust concrete probes before paging.
#
# This narrow interpretation: probe that the local supervisor port is
# TCP-reachable via HTTP. Any HTTP response at all (any status) means the
# local receive path is up; Hookdeck cloud reconnects within seconds once
# a real event arrives, so suppress the alert.
#
# The X-Merlin-Probe: watchdog header is a forward-compatible marker so
# the supervisor can short-circuit (return 200 without dispatching) if/when
# that code path is added. Until then we rely purely on the HTTP response
# code being present to infer reachability — we DO NOT send a dispatchable
# payload (no task field).
#
# Exit 0 = port reachable (any HTTP code returned); non-zero = connection
# refused / timeout (genuinely down, alert should fire).
hookdeck_local_probe() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
    -H "X-Merlin-Probe: watchdog" \
    "http://localhost:9092/" 2>/dev/null)
  # curl writes "000" on connection failure/timeout; any other value means
  # we received an HTTP response (even 4xx/5xx = TCP + HTTP stack alive).
  [ -n "$code" ] && [ "$code" != "000" ]
}

ISSUES=""

# --- Hum state invariant check ---
# Runtime state files for hum (hum-state.json, hum-seen.json, hum-feedback.jsonl,
# hum-runs.jsonl) are gitignored as of 497728c + 0edebb0. If a fresh clone or
# disaster-recovery checkout lacks them, hum dispatches silently produce empty
# state — which is exactly the 2026-04-16 empty-digest incident. Watchdog
# initializes any missing file from schema default so the next hum tick has
# somewhere to land.
HUM_STATE="${MERLIN_HOME}/data/hum-state.json"
HUM_SEEN="${MERLIN_HOME}/data/hum-seen.json"
HUM_FEEDBACK="${MERLIN_HOME}/data/hum-feedback.jsonl"
HUM_RUNS="${MERLIN_HOME}/data/hum-runs.jsonl"
HUM_TODAY=$(TZ=America/New_York date +%Y-%m-%d)
if [ ! -f "$HUM_STATE" ]; then
  log "Hum state missing: hum-state.json — initializing schema default"
  jq -n --arg today "$HUM_TODAY" \
    '{schema_version:2, pause:null, last_ping_at:null, last_run_at:null, last_input_signature:null, today:{date:$today, runs:0, pings:0, questions:0}, min_ping_interval_minutes:0, max_pings_per_day:999}' \
    > "$HUM_STATE"
fi
if [ ! -f "$HUM_SEEN" ]; then
  log "Hum seen missing: hum-seen.json — initializing schema default"
  echo '{"core":[],"A":[],"B":[],"C":[],"D":[],"E":[]}' > "$HUM_SEEN"
fi
if [ ! -f "$HUM_FEEDBACK" ]; then
  log "Hum feedback missing: hum-feedback.jsonl — initializing empty"
  : > "$HUM_FEEDBACK"
fi
if [ ! -f "$HUM_RUNS" ]; then
  log "Hum runs missing: hum-runs.jsonl — initializing empty"
  : > "$HUM_RUNS"
fi

# --- Check process-manager is alive (launchd should keep it running) ---
if ! pgrep -f "process-manager.mjs" > /dev/null 2>&1; then
  ATTEMPT=$(incident_seen "process-manager-down")
  log "Process manager not running (attempt $ATTEMPT) — kickstarting ai.claude.session"
  launchctl kickstart -k "gui/$UID/ai.claude.session" >> "$LOG" 2>&1 || true
  # Alert only if the LaunchAgent kickstart didn't bring it back by next tick.
  if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "process-manager-down"; then
    notify "🔴 Process manager is down and didn't restart after launchctl kickstart. Manual intervention needed on Mac Mini."
  fi
  exit 0
else
  incident_clear "process-manager-down"
fi

# --- Ops supervisor health ---
if [ -n "$HEALTH_PORT" ]; then
  HEALTH=$(curl -sf --max-time 3 "http://127.0.0.1:$HEALTH_PORT/health" 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    log "Supervisor /health unreachable on :$HEALTH_PORT"
    ISSUES="$ISSUES ops-supervisor(http-down)"
  else
    # Check for crash loop: supervisor is up but claude child keeps dying
    ZERO_TURNS=$(echo "$HEALTH" | jq -r '.consecutiveZeroTurns // 0')
    if [ "$ZERO_TURNS" -ge 5 ]; then
      log "Crash loop detected: consecutiveZeroTurns=$ZERO_TURNS — POSTing /restart to supervisor"
      curl -sf -X POST "http://127.0.0.1:$HEALTH_PORT/restart" > /dev/null 2>&1
      touch "$STALE_RESTART_COOLDOWN"
      ISSUES="$ISSUES ops-supervisor(crash-loop)"
    fi

    # Check for no-op loop: child alive but every turn returns instantly without real work
    NOOP_TURNS=$(echo "$HEALTH" | jq -r '.consecutiveNoOpTurns // 0')
    if [ "$NOOP_TURNS" -ge 5 ]; then
      log "No-op loop detected: consecutiveNoOpTurns=$NOOP_TURNS — POSTing /restart to supervisor"
      curl -sf -X POST "http://127.0.0.1:$HEALTH_PORT/restart" > /dev/null 2>&1
      touch "$STALE_RESTART_COOLDOWN"
      ISSUES="$ISSUES ops-supervisor(no-op-loop)"
    fi

    # Check event staleness (skip if we just restarted)
    if [ ! -f "$STALE_RESTART_COOLDOWN" ] || [ $(( $(date +%s) - $(stat -f%m "$STALE_RESTART_COOLDOWN") )) -ge 900 ]; then
      LAST_AGE=$(echo "$HEALTH" | jq -r '.lastEventAgeMs // 0')
      QUEUE_DEPTH=$(echo "$HEALTH" | jq -r '.queueDepth // 0')
      # Stale only matters if there's work in flight
      if [ "$LAST_AGE" -gt "$STALE_EVENT_MS" ] && [ "$QUEUE_DEPTH" -gt 0 ]; then
        log "Supervisor stale: lastEventAge=${LAST_AGE}ms queueDepth=$QUEUE_DEPTH — triggering /restart"
        curl -sf -X POST "http://127.0.0.1:$HEALTH_PORT/restart" > /dev/null 2>&1
        touch "$STALE_RESTART_COOLDOWN"
        ISSUES="$ISSUES ops-supervisor(stale)"
      fi

      # Push gap is diagnostic + self-heal only, never an alert on its own.
      # Quiet overnight inboxes gap >60min normally; real failures also trip
      # a downstream detector (watch expiry, Hookdeck disconnect, unread
      # sweep) which alerts with a concrete symptom. The combined-signature
      # alert (gap + stuck unread) fires from the unread sweep below.
      PUSH_AGE=$(echo "$HEALTH" | jq -r '.lastPushAgeMs // 0')
      PUSH_GAP_RENEW_COOLDOWN="${MERLIN_HOME}/data/.watchdog-push-gap-renew-cooldown"
      if [ "$PUSH_AGE" -gt "$PUSH_GAP_MS" ]; then
        log_throttled "${MERLIN_HOME}/data/.watchdog-push-gap-log" \
          "Gmail push gap detected: lastPushAge=${PUSH_AGE}ms (>${PUSH_GAP_MS}ms) — self-healing via watch renewal"

        # Gmail's watch endpoint is idempotent (same topicName just extends
        # expiry). Re-call it at most once per hour: no-op if healthy, repair
        # if silently bad between daily 06:00 renewals.
        SHOULD_RENEW=1
        if [ -f "$PUSH_GAP_RENEW_COOLDOWN" ]; then
          COOLDOWN_AGE=$(( $(date +%s) - $(stat -f%m "$PUSH_GAP_RENEW_COOLDOWN") ))
          [ "$COOLDOWN_AGE" -lt 3600 ] && SHOULD_RENEW=0
        fi
        if [ "$SHOULD_RENEW" -eq 1 ]; then
          log "Push gap — running renew-gmail-watch.sh proactively"
          "${MERLIN_HOME}/agent/scripts/renew-gmail-watch.sh" >> "$LOG" 2>&1 || true
          touch "$PUSH_GAP_RENEW_COOLDOWN"
        fi

        ISSUES="$ISSUES gmail-push-gap(${PUSH_AGE}ms)"
      else
        # Recovery — clear throttles so the next gap self-heals promptly.
        rm -f "${MERLIN_HOME}/data/.watchdog-push-gap-log" 2>/dev/null
        rm -f "$PUSH_GAP_RENEW_COOLDOWN" 2>/dev/null
      fi
    fi
  fi
fi

# --- Chat supervisor health ---
eval "$("$CONFIG_DIR/load-agent.sh" chat)"
CHAT_HEALTH_PORT="$AGENT_SUPERVISOR_HEALTH_PORT"
if [ -n "$CHAT_HEALTH_PORT" ]; then
  CHAT_HEALTH=$(curl -sf --max-time 3 "http://127.0.0.1:$CHAT_HEALTH_PORT/health" 2>/dev/null)
  if [ -z "$CHAT_HEALTH" ]; then
    log "Chat supervisor /health unreachable on :$CHAT_HEALTH_PORT"
    ISSUES="$ISSUES chat-supervisor(http-down)"
  else
    CHAT_ALIVE=$(echo "$CHAT_HEALTH" | jq -r 'if .childAlive then "yes" else "no" end')
    if [ "$CHAT_ALIVE" = "no" ]; then
      log "Chat supervisor child not alive — may be restarting"
      ISSUES="$ISSUES chat-supervisor(child-down)"
    fi

    # Chat crash loop detection (parity with ops checks)
    CHAT_ZERO_TURNS=$(echo "$CHAT_HEALTH" | jq -r '.consecutiveZeroTurns // 0')
    if [ "$CHAT_ZERO_TURNS" -ge 5 ]; then
      log "Chat crash loop: consecutiveZeroTurns=$CHAT_ZERO_TURNS — restarting"
      curl -sf -X POST "http://127.0.0.1:$CHAT_HEALTH_PORT/restart" > /dev/null 2>&1
      ISSUES="$ISSUES chat-supervisor(crash-loop)"
    fi

    # Chat no-op loop detection (parity with ops checks)
    CHAT_NOOP_TURNS=$(echo "$CHAT_HEALTH" | jq -r '.consecutiveNoOpTurns // 0')
    if [ "$CHAT_NOOP_TURNS" -ge 5 ]; then
      log "Chat no-op loop: consecutiveNoOpTurns=$CHAT_NOOP_TURNS — restarting"
      curl -sf -X POST "http://127.0.0.1:$CHAT_HEALTH_PORT/restart" > /dev/null 2>&1
      ISSUES="$ISSUES chat-supervisor(no-op-loop)"
    fi

    # Chat event staleness (only if queue has work)
    CHAT_LAST_AGE=$(echo "$CHAT_HEALTH" | jq -r '.lastEventAgeMs // 0')
    CHAT_QUEUE=$(echo "$CHAT_HEALTH" | jq -r '.queueDepth // 0')
    if [ "$CHAT_LAST_AGE" -gt "$STALE_EVENT_MS" ] && [ "$CHAT_QUEUE" -gt 0 ]; then
      log "Chat supervisor stale: lastEventAge=${CHAT_LAST_AGE}ms queueDepth=$CHAT_QUEUE — restarting"
      curl -sf -X POST "http://127.0.0.1:$CHAT_HEALTH_PORT/restart" > /dev/null 2>&1
      ISSUES="$ISSUES chat-supervisor(stale)"
    fi

    # Phone-channel heartbeat staleness
    HEARTBEAT_AGE=$(echo "$CHAT_HEALTH" | jq -r '.phoneChannelHeartbeatAgeMs // 0')
    if [ "$HEARTBEAT_AGE" -gt 300000 ]; then
      log "Phone-channel heartbeat stale: ${HEARTBEAT_AGE}ms — supervisor should auto-restart"
      ISSUES="$ISSUES phone-channel(heartbeat-stale)"
    fi
  fi
fi

# --- Chat message delivery check (catches silent phone-channel failures) ---
# Query Supabase for unread user messages older than 3 minutes.
# If any exist, the phone-channel realtime subscription likely dropped.
SUPABASE_URL="https://${MERLIN_SUPABASE_PROJECT}.supabase.co"
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "${MERLIN_HOME}/.env" 2>/dev/null | cut -d= -f2-)
STALE_MSG_THRESHOLD=180  # 3 minutes

CUTOFF=$(date -u -v-${STALE_MSG_THRESHOLD}S '+%Y-%m-%dT%H:%M:%S+00:00' 2>/dev/null || date -u -d "${STALE_MSG_THRESHOLD} seconds ago" '+%Y-%m-%dT%H:%M:%S+00:00' 2>/dev/null)
if [ -n "$CUTOFF" ]; then
  STALE_MSGS=$(curl -sf --max-time 5 \
    "${SUPABASE_URL}/rest/v1/merlin_messages?role=eq.user&read=eq.false&created_at=lt.${CUTOFF}&order=created_at.asc&limit=5" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" 2>/dev/null)

  STALE_COUNT=$(echo "$STALE_MSGS" | jq -r 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
  STALE_COUNT=${STALE_COUNT:-0}

  if [ "$STALE_COUNT" -gt 0 ]; then
    ATTEMPT=$(incident_seen "chat-delivery-stuck")
    log "Chat delivery stuck: $STALE_COUNT unread user message(s) older than ${STALE_MSG_THRESHOLD}s (attempt $ATTEMPT)"
    ISSUES="$ISSUES chat-delivery-stuck(${STALE_COUNT}msg)"

    # Self-heal: restart chat supervisor + redispatch every tick the
    # condition holds. Idempotent — RECOVERED MESSAGE prefix dedups in chat.
    if [ -n "$CHAT_HEALTH_PORT" ]; then
      log "Restarting chat supervisor to recover message delivery"
      curl -sf -X POST "http://127.0.0.1:$CHAT_HEALTH_PORT/restart" > /dev/null 2>&1
      sleep 10  # Wait for session to restart and phone-channel to reconnect

      # Dispatch each missed message directly to the chat supervisor
      echo "$STALE_MSGS" | $NODE -e '
        let d="";
        process.stdin.on("data",c=>d+=c);
        process.stdin.on("end",async()=>{
          try {
            const msgs = JSON.parse(d);
            if (!Array.isArray(msgs)) return;
            for (const m of msgs) {
              const body = JSON.stringify({
                content: "RECOVERED MESSAGE (was stuck):\n\nNew message from user:\n\n" + m.content,
                source: "merlin",
                priority: "high",
                msgId: m.id
              });
              const resp = await fetch("http://127.0.0.1:'"$CHAT_HEALTH_PORT"'/dispatch", {
                method: "POST",
                headers: {"content-type":"application/json"},
                body
              });
              console.error("dispatched recovered msg " + m.id + " status=" + resp.status);
            }
          } catch(e) { console.error("dispatch error: " + e.message); }
        });
      ' 2>> "$LOG"
    fi

    # Alert only if recovery has demonstrably failed (still stuck on next tick).
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "chat-delivery-stuck"; then
      notify "🔴 Chat delivery still stuck after self-heal — $STALE_COUNT message(s) sitting unread across $ATTEMPT consecutive ticks. Phone-channel realtime subscription needs manual reconnect."
    fi
  else
    incident_clear "chat-delivery-stuck"
  fi
fi

# --- Hookdeck connection drop detector ---
# Hookdeck's local CLI tunnel can lose its connection to the cloud service.
# When that happens, incoming Gmail pushes sit in the cloud queue until reconnect.
# The log prints "Connection lost, reconnecting..." on disconnect and resumes
# logging successful POSTs on reconnect (no explicit "reconnected" marker).
HOOKDECK_LOG="${MERLIN_HOME}/agent/logs/hookdeck.log"
if [ -f "$HOOKDECK_LOG" ]; then
  # Find the position of the most recent "Connection lost" in the last 500 lines
  RECENT=$(tail -500 "$HOOKDECK_LOG")
  LAST_LOSS_LINE=$(echo "$RECENT" | grep -n "Connection lost" | tail -1 | cut -d: -f1)
  if [ -z "$LAST_LOSS_LINE" ]; then
    # No "Connection lost" within the recent window — tunnel has been
    # clean long enough that the disconnect line rolled out of tail-500.
    # Clear any lingering incident state.
    incident_clear "hookdeck-disconnect"
  fi
  if [ -n "$LAST_LOSS_LINE" ]; then
    # Recovery markers AFTER the last "Connection lost":
    #   [200] POST     → tunnel is live AND forwarding events
    #   is reachable   → handshake to the local ops-supervisor succeeded
    #   Listening on   → the new hookdeck process started up after a kill/respawn
    #                    (may arrive before "is reachable" if the local port
    #                    probe is slow, or if stdout is buffered)
    # Without those last two, a freshly-restarted but idle tunnel — no Gmail
    # events yet — reads as "disconnected" and the watchdog log fills up.
    LINES_AFTER=$(echo "$RECENT" | tail -n +$((LAST_LOSS_LINE + 1)))
    RECOVERED=$(echo "$LINES_AFTER" | grep -Ec "\[200\] POST|is reachable|Listening on")
    if [ "$RECOVERED" -eq 0 ]; then
      # Check how long ago the connection lost happened (no recovery yet)
      LOG_MTIME=$(stat -f%m "$HOOKDECK_LOG")
      NOW=$(date +%s)
      AGE_SEC=$(( NOW - LOG_MTIME ))
      log "Hookdeck appears disconnected: last 'Connection lost' has no subsequent POST (log mtime ${AGE_SEC}s ago)"
      ISSUES="$ISSUES hookdeck(disconnected)"

      # One-shot diagnostic snapshot on FIRST detection of each incident.
      # Marker file prevents repeat snapshots during the same disconnect
      # (cleared by the recovery branch below). Snapshot captures network
      # state at the moment the watchdog noticed the drop, so we can tell
      # next time whether it was DNS, Hookdeck cloud, our ISP, or the
      # local tunnel that failed.
      if [ ! -f "$HOOKDECK_DISCONNECT_MARKER" ]; then
        touch "$HOOKDECK_DISCONNECT_MARKER"
        mkdir -p "$HOOKDECK_DIAG_DIR"
        SNAP="$HOOKDECK_DIAG_DIR/$(date '+%Y-%m-%dT%H-%M-%S').txt"
        {
          echo "=== hookdeck disconnect diagnostic ==="
          echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
          echo "disconnect_age_s: $AGE_SEC"
          echo
          echo "--- ping hkdk.events (3 pkts, 2s timeout) ---"
          ping -c 3 -t 2 hkdk.events 2>&1 || true
          echo
          echo "--- dig hkdk.events +short ---"
          dig hkdk.events +short 2>&1 || true
          echo
          echo "--- en0 (ethernet) status ---"
          ifconfig en0 2>&1 | grep -E "status|inet " || true
          echo
          echo "--- routing table default ---"
          netstat -rn 2>&1 | grep -E "^default" | head -3 || true
          echo
          echo "--- established https connections (top 10) ---"
          netstat -an 2>&1 | grep -E "ESTABLISHED.*(:443|:https)" | head -10 || true
          echo
          echo "--- hookdeck process ---"
          pgrep -af "hookdeck listen" || echo "(no process)"
          echo
          echo "--- last 30 lines of hookdeck.log ---"
          tail -30 "$HOOKDECK_LOG" 2>&1 || true
        } > "$SNAP" 2>&1
        log "Hookdeck diagnostic snapshot written: $SNAP"
      fi

      # Auto-restart if stuck for >=10 min and restart cooldown not active
      if [ "$AGE_SEC" -ge "$HOOKDECK_RESTART_MIN_AGE" ]; then
        SHOULD_RESTART=1
        if [ -f "$HOOKDECK_RESTART_COOLDOWN" ]; then
          COOLDOWN_AGE=$(( $(date +%s) - $(stat -f%m "$HOOKDECK_RESTART_COOLDOWN") ))
          [ "$COOLDOWN_AGE" -lt 600 ] && SHOULD_RESTART=0
        fi
        if [ "$SHOULD_RESTART" -eq 1 ]; then
          HOOKDECK_PID=$(pgrep -f "hookdeck listen" | head -1)
          if [ -n "$HOOKDECK_PID" ]; then
            log "Auto-restarting hookdeck (pid $HOOKDECK_PID) after ${AGE_SEC}s disconnect — process manager will restart"
            kill "$HOOKDECK_PID" 2>/dev/null
            touch "$HOOKDECK_RESTART_COOLDOWN"
          else
            log "Hookdeck disconnect detected but no matching process found to kill"
          fi
        fi
      fi

      # Only alert if disconnect persists past auto-restart. Before paging,
      # run the synthetic-webhook probe: if the local supervisor port
      # responds with any HTTP code, the end-to-end receive path is up and
      # the "Connection lost" log line is a cloud-side idle artifact —
      # suppress the alert. Auto-restart is NOT gated on the probe (above)
      # so real disconnects still get healed. The incident_seen counter
      # ensures the alert only goes out after the kill+respawn has been
      # attempted AND the next tick still finds the tunnel disconnected.
      if [ "$AGE_SEC" -ge "$HOOKDECK_RESTART_MIN_AGE" ]; then
        if hookdeck_local_probe; then
          log "Hookdeck log says disconnected but local probe OK — suppressing alert"
        else
          ATTEMPT=$(incident_seen "hookdeck-disconnect")
          if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "hookdeck-disconnect"; then
            notify "🔴 Hookdeck tunnel disconnected and not recovering after auto-restart (${AGE_SEC}s, $ATTEMPT consecutive ticks) — Gmail pushes are not being relayed. Manual intervention needed. Diagnostics: ${MERLIN_HOME}/agent/logs/hookdeck-diagnostics/"
          fi
        fi
      fi
    else
      # Tunnel recovered (RECOVERED > 0 in the current window): clear the
      # per-incident marker so the NEXT disconnect triggers a fresh snapshot.
      [ -f "$HOOKDECK_DISCONNECT_MARKER" ] && rm -f "$HOOKDECK_DISCONNECT_MARKER"
      incident_clear "hookdeck-disconnect"
    fi
  fi
fi

# --- Gmail unread sweep (catches silently-missed triage) ---
# Periodically query Gmail for unread inbox messages older than 5 min.
# Anything that old should have been triaged by now. If not, the push arrived
# but the agent silently dropped the classification. Dispatch a RECLASSIFY
# task for each stuck message.
STUCK_EMAILS=$("${MERLIN_HOME}/bin/gmail-action" list-unread-older 5 2>/dev/null || echo "[]")
STUCK_COUNT=$(echo "$STUCK_EMAILS" | jq 'length' 2>/dev/null || echo 0)
STUCK_COUNT=${STUCK_COUNT:-0}
if [ "$STUCK_COUNT" -gt 0 ]; then
  ATTEMPT=$(incident_seen "gmail-unread-stuck")
  log "Gmail unread sweep: $STUCK_COUNT message(s) older than 5min not yet triaged (attempt $ATTEMPT)"
  ISSUES="$ISSUES gmail-unread-stuck(${STUCK_COUNT})"

  # Self-heal: dispatch RECLASSIFY for each stuck message every tick.
  echo "$STUCK_EMAILS" | jq -r '.[].id' | while read -r MSGID; do
    [ -z "$MSGID" ] && continue
    curl -sf --max-time 5 -X POST "http://localhost:9092" \
      -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
      -d "{\"task\": \"RECLASSIFY: $MSGID\"}" > /dev/null 2>&1
    log "  Dispatched RECLASSIFY for $MSGID"
  done

  # Alert only if RECLASSIFY didn't drain the queue by the next tick.
  # Stuck unread + push-gap together = real Pub/Sub delivery failure (the
  # push machinery isn't just quiet, it's missing real inbound) — name
  # that infra issue specifically when it's the cause.
  if [ "$STUCK_COUNT" -ge 3 ] && [ "$ATTEMPT" -ge 2 ] && incident_should_alert "gmail-unread-stuck"; then
    GAP_MS=$(echo "$HEALTH" | jq -r '.lastPushAgeMs // 0' 2>/dev/null)
    if [ -n "$GAP_MS" ] && [ "$GAP_MS" -gt "$PUSH_GAP_MS" ]; then
      notify "🔴 Pub/Sub delivery failure — $STUCK_COUNT unread inbox message(s) not pushed for $((GAP_MS / 60000))+ min, persisting after $ATTEMPT RECLASSIFY rounds. Watch-renewal already attempted. Manual inspection of Pub/Sub topic + Hookdeck subscription needed."
    else
      notify "🔴 Email triage sweep: $STUCK_COUNT stuck message(s) still in inbox after $ATTEMPT RECLASSIFY rounds. Manual triage needed."
    fi
  fi
else
  incident_clear "gmail-unread-stuck"
fi

# --- Ollama (local Gemma) health ---
# Phone-channel acks run on `gemma4:e2b` served by Ollama at :11434. If the
# daemon dies, acks fall through to CANNED_REFRESH_MESSAGES silently — users
# just see canned text forever. architecture.md marks canned as the only
# permitted fallback; it is not a desirable steady state.
OLLAMA_RESTART_COOLDOWN="${MERLIN_HOME}/data/.ollama-restart-cooldown"
BREW_BIN=/opt/homebrew/bin/brew
if ! curl -sf --max-time 3 http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  ATTEMPT=$(incident_seen "ollama-down")
  log "Ollama unreachable on :11434 (attempt $ATTEMPT) — phone-channel acks will fall through to CANNED"
  ISSUES="$ISSUES ollama(down)"

  # Self-heal: brew services restart at most once per 10 min.
  SHOULD_RESTART=1
  if [ -f "$OLLAMA_RESTART_COOLDOWN" ]; then
    COOLDOWN_AGE=$(( $(date +%s) - $(stat -f%m "$OLLAMA_RESTART_COOLDOWN") ))
    [ "$COOLDOWN_AGE" -lt 600 ] && SHOULD_RESTART=0
  fi
  if [ "$SHOULD_RESTART" -eq 1 ] && [ -x "$BREW_BIN" ]; then
    log "Attempting: brew services restart ollama"
    "$BREW_BIN" services restart ollama >> "$LOG" 2>&1
    touch "$OLLAMA_RESTART_COOLDOWN"
  fi

  # Alert only if brew restart didn't bring it back by the next tick.
  if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "ollama-down"; then
    notify "🔴 Ollama (local Gemma) is down on :11434 and didn't recover after brew services restart ($ATTEMPT consecutive ticks). Phone-channel acks falling through to canned messages. Manual intervention needed."
  fi
else
  incident_clear "ollama-down"
  rm -f "$OLLAMA_RESTART_COOLDOWN" 2>/dev/null
fi

# --- Wiki server health ---
# The wiki HTTP browser at 127.0.0.1:9096 is a managed child of process-manager.
# If it stops responding, process-manager normally respawns it on exit; this
# watchdog check covers the case where the process is alive but the HTTP
# server is wedged (port held but not answering). Self-heal = SIGKILL the
# `wiki serve` process so process-manager respawns it. Alert only after a
# self-heal cycle has demonstrably failed (next-tick parity with other
# incidents).
if ! curl -sf --max-time 3 http://127.0.0.1:9096/ > /dev/null 2>&1; then
  ATTEMPT=$(incident_seen "wiki-server-down")
  log "Wiki server unreachable on :9096 (attempt $ATTEMPT)"
  ISSUES="$ISSUES wiki-server(down)"

  WIKI_PID=$(pgrep -f "bin/wiki serve" | head -1)
  if [ -n "$WIKI_PID" ]; then
    log "Killing wedged wiki serve pid $WIKI_PID — process-manager will respawn"
    kill "$WIKI_PID" 2>/dev/null
  fi

  if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "wiki-server-down"; then
    notify "🔴 Wiki server (:9096) down and not recovering after $ATTEMPT consecutive ticks. Manual intervention needed on Mac Mini."
  fi
else
  incident_clear "wiki-server-down"
fi

# --- GitHub CLI auth health ---
# The `gh` CLI stores its OAuth token in the macOS keyring. Token is long-lived
# (device-flow OAuth, no expiry) but can be invalidated by revocation or SSO
# cycles. Alert at most once per 24h if it breaks.
GH_BIN=/opt/homebrew/bin/gh
GH_TOKEN_FILE="${MERLIN_HOME}/secrets/gh-token"
GH_ALERT_COOLDOWN="${MERLIN_HOME}/data/.gh-auth-last-alert"
if [ -x "$GH_BIN" ]; then
  if [ -r "$GH_TOKEN_FILE" ]; then
    export GH_TOKEN=$(cat "$GH_TOKEN_FILE")
  fi
  if ! "$GH_BIN" api user -q .login >/dev/null 2>&1; then
    ISSUES="$ISSUES gh-auth(invalid)"
    SHOULD_ALERT=1
    if [ -f "$GH_ALERT_COOLDOWN" ]; then
      AGE=$(( $(date +%s) - $(stat -f%m "$GH_ALERT_COOLDOWN") ))
      [ "$AGE" -lt 86400 ] && SHOULD_ALERT=0
    fi
    if [ "$SHOULD_ALERT" -eq 1 ]; then
      log "gh api user failed — token may be invalid/revoked"
      notify "⚠️ gh CLI auth is broken. Run: gh auth logout -h github.com -u ${MERLIN_OWNER} && gh auth login -h github.com -p https -w -s repo,workflow,read:org,gist"
      touch "$GH_ALERT_COOLDOWN"
    fi
  fi
fi

# --- Gmail watch renewal health ---
# renew-gmail-watch.sh writes data/gmail-watch-last.json after each run:
#   { "at": "<renewal UTC>", "expiresAt": "<expiry UTC|null>", "ok": true|false, "error": "<msg|null>" }
# Alert (at most once per 24h) if the last run failed OR the watch is within
# 24h of expiring. Silent when missing entirely — the first crontab firing
# writes it; before that we have nothing to assert.
GMAIL_WATCH_LAST="${MERLIN_HOME}/data/gmail-watch-last.json"
GMAIL_WATCH_RENEW_COOLDOWN="${MERLIN_HOME}/data/.gmail-watch-self-heal-cooldown"
if [ -r "$GMAIL_WATCH_LAST" ]; then
  GWL_OK=$(jq -r '.ok // false' "$GMAIL_WATCH_LAST" 2>/dev/null)
  GWL_ERR=$(jq -r '.error // ""' "$GMAIL_WATCH_LAST" 2>/dev/null)
  GWL_EXPIRES=$(jq -r '.expiresAt // ""' "$GMAIL_WATCH_LAST" 2>/dev/null)

  NOW_EPOCH=$(date +%s)
  WARN=""

  if [ "$GWL_OK" = "false" ]; then
    WARN="renewal failed: $(echo "$GWL_ERR" | head -c 160)"
  elif [ -n "$GWL_EXPIRES" ]; then
    # Parse ISO-8601 UTC → epoch (macOS date -j)
    GWL_EPOCH=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$GWL_EXPIRES" +%s 2>/dev/null)
    if [ -n "$GWL_EPOCH" ]; then
      SECS_LEFT=$(( GWL_EPOCH - NOW_EPOCH ))
      if [ "$SECS_LEFT" -lt 0 ]; then
        WARN="watch already expired ($((-SECS_LEFT / 3600))h ago); push delivery is dead until renewal"
      elif [ "$SECS_LEFT" -lt 86400 ]; then
        WARN="watch expires in $((SECS_LEFT / 3600))h and renewal may be stuck"
      fi
    fi
  fi

  if [ -n "$WARN" ]; then
    ATTEMPT=$(incident_seen "gmail-watch")
    log "Gmail watch check (attempt $ATTEMPT): $WARN"
    ISSUES="$ISSUES gmail-watch(${WARN// /_})"

    # Self-heal: invoke renew-gmail-watch.sh at most once per hour
    # (Gmail's watch endpoint is idempotent; same topic just extends expiry).
    SHOULD_RENEW=1
    if [ -f "$GMAIL_WATCH_RENEW_COOLDOWN" ]; then
      AGE=$(( NOW_EPOCH - $(stat -f%m "$GMAIL_WATCH_RENEW_COOLDOWN") ))
      [ "$AGE" -lt 3600 ] && SHOULD_RENEW=0
    fi
    if [ "$SHOULD_RENEW" -eq 1 ]; then
      log "Gmail watch — running renew-gmail-watch.sh proactively"
      "${MERLIN_HOME}/agent/scripts/renew-gmail-watch.sh" >> "$LOG" 2>&1 || true
      touch "$GMAIL_WATCH_RENEW_COOLDOWN"
    fi

    # Alert only if auto-renewal didn't fix the warning by the next tick.
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "gmail-watch"; then
      notify "🔴 Gmail push watch: $WARN. Auto-renewal attempted but watch state still bad on $ATTEMPT consecutive ticks. Manual intervention needed: agent/scripts/renew-gmail-watch.sh"
    fi
  else
    incident_clear "gmail-watch"
    rm -f "$GMAIL_WATCH_RENEW_COOLDOWN" 2>/dev/null
  fi
fi

# --- gog CLI auth health ---
# Google Tasks/Calendar/etc. OAuth refresh tokens can be revoked by Google
# (rotation, inactivity, password change). Alert at most once per 24h.
GOG_BIN=/opt/homebrew/bin/gog
GOG_ALERT_COOLDOWN="${MERLIN_HOME}/data/.gog-auth-last-alert"
if [ -x "$GOG_BIN" ]; then
  GOG_ERR=$("$GOG_BIN" tasks list @default --limit 1 2>&1 >/dev/null)
  if echo "$GOG_ERR" | grep -qiE "invalid_grant|expired|revoked|unauthorized"; then
    ISSUES="$ISSUES gog-auth(invalid)"
    SHOULD_ALERT=1
    if [ -f "$GOG_ALERT_COOLDOWN" ]; then
      AGE=$(( $(date +%s) - $(stat -f%m "$GOG_ALERT_COOLDOWN") ))
      [ "$AGE" -lt 86400 ] && SHOULD_ALERT=0
    fi
    if [ "$SHOULD_ALERT" -eq 1 ]; then
      log "gog auth failed: $(echo "$GOG_ERR" | head -c 200)"
      notify "⚠️ gog CLI auth is broken (Google refresh token revoked/expired). Run: gog auth add ${MERLIN_OWNER_EMAIL}"
      touch "$GOG_ALERT_COOLDOWN"
    fi
  fi
fi

if [ -n "$ISSUES" ]; then
  # Only log the summary when the set of issues actually changes. Prevents
  # 158+ duplicate lines during a long persistent incident (the Apr 17 Gmail
  # push gap logged the same Watchdog issues string every 5 min for hours).
  # Strip the gmail-push-gap duration so minor ms drift doesn't count as a
  # change — we key on the issue set, not the exact timing.
  ISSUE_KEY=$(echo "$ISSUES" | sed -E 's/gmail-push-gap\([0-9]+ms\)/gmail-push-gap/g')
  log_on_change "${MERLIN_HOME}/data/.watchdog-issues-key" \
    "$ISSUE_KEY" "Watchdog issues:$ISSUES"
else
  # Clear the marker on clean ticks so the next issue logs even if it
  # happens to produce the same key as the last incident.
  rm -f "${MERLIN_HOME}/data/.watchdog-issues-key" 2>/dev/null
fi
