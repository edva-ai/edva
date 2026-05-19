#!/bin/bash
# chrome-cdp-watch.sh — detect Chrome DevTools Protocol outages and notify once per transition.
#
# The ops-agent's chrome-devtools MCP uses --autoConnect, which requires Chrome
# running with --remote-debugging-port=9222 on a non-default user data dir.
# macOS TCC permission prompts (Screen Recording / Accessibility / Automation)
# and chrome-devtools-mcp re-signs can silently drop the grant and break
# browser-automation jobs. This script probes the CDP port and fires exactly
# one Merlin ping on each UP→DOWN transition; DOWN→UP is silent (self-heal).
#
# Install via crontab: */15 * * * * ${MERLIN_HOME_USER}/dev/merlin/agent/scripts/chrome-cdp-watch.sh
#
# State: data/chrome-cdp-state.json {state, since, last_notified}
# Log:   agent/logs/watchdog.log  (single source of truth for ops alerts)

: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

STATE_FILE="${MERLIN_HOME}/data/chrome-cdp-state.json"
LOG="${MERLIN_HOME}/agent/logs/watchdog.log"
NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Quiet hours: skip notification during the configured sleep window (00:00–09:00 local time).
# The probe still runs so state transitions are recorded; only the ping is
# suppressed. If CDP is still down at 09:00, the 09:00–09:15 tick notifies.
HOUR_ET=$(TZ=America/New_York date +%H)
IN_QUIET_HOURS=0
if [ "$HOUR_ET" -lt 9 ]; then IN_QUIET_HOURS=1; fi

# Probe: HTTP 200 on /json/version = CDP healthy. Any other response =
# "down" (connection refused, timeout, 4xx/5xx). Kernel-enforced 5s cutoff.
# Uses `localhost` (not 127.0.0.1) — Chrome 147 silently binds an IPv4 stub
# to :9222 from the user's interactive profile that 404s on every CDP path.
# `localhost` resolves to ::1 first on macOS, hitting the LaunchAgent-managed
# automation Chrome (com.merlin.chrome-cdp) which binds IPv6 :9222.
HTTP_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://localhost:9222/json/version 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  CURR="up"
else
  CURR="down"
fi

# Read previous state (default: "unknown" on first ever run).
PREV="unknown"
PREV_NOTIFIED=""
PREV_HEAL=""
if [ -f "$STATE_FILE" ]; then
  PREV=$(jq -r '.state // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
  PREV_NOTIFIED=$(jq -r '.last_notified // ""' "$STATE_FILE" 2>/dev/null || echo "")
  PREV_HEAL=$(jq -r '.heal_attempted_at // ""' "$STATE_FILE" 2>/dev/null || echo "")
fi

write_state() {
  local state="$1" notified="$2" heal="${3-keep}"
  local since
  if [ "$state" = "$PREV" ] && [ -f "$STATE_FILE" ]; then
    since=$(jq -r '.since // ""' "$STATE_FILE" 2>/dev/null)
    [ -z "$since" ] && since="$NOW_ISO"
  else
    since="$NOW_ISO"
  fi
  # heal arg: "keep" preserves prior value; "" clears; otherwise replaces.
  if [ "$heal" = "keep" ]; then
    heal="$PREV_HEAL"
  fi
  jq -n \
    --arg state "$state" \
    --arg since "$since" \
    --arg notified "$notified" \
    --arg heal "$heal" \
    '{state:$state, since:$since,
      last_notified:(if $notified == "" then null else $notified end),
      heal_attempted_at:(if $heal == "" then null else $heal end)}' \
    > "$STATE_FILE"
}

# Try to recover Chrome CDP via the LaunchAgent. macOS launchctl kickstart
# tears down the existing instance (-k) and spawns a fresh one. Returns 0
# on launchctl success regardless of whether Chrome actually came back up
# — the next watchdog tick re-probes :9222 and notifies if still down.
self_heal_chrome_cdp() {
  launchctl kickstart -k "gui/$UID/com.merlin.chrome-cdp" >> "$LOG" 2>&1
}

# First-ever run: bootstrap state silently. No ping — the user just deployed the
# watch, they don't need an "initial state is DOWN" pager. If the initial state
# is down, stamp last_notified to NOW so the post-quiet-hours deferred branch
# doesn't treat bootstrap as a missed transition.
if [ "$PREV" = "unknown" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] bootstrap: initial state=$CURR (HTTP $HTTP_CODE)" >> "$LOG"
  if [ "$CURR" = "down" ]; then
    write_state "down" "$NOW_ISO"
  else
    write_state "up" ""
  fi
  exit 0
fi

# UP → DOWN: kickstart the LaunchAgent first; defer any user-facing alert
# until the NEXT tick. If the kickstart recovers Chrome before we re-probe,
# the next tick reads "up" and the alert never fires.
if [ "$PREV" = "up" ] && [ "$CURR" = "down" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] transition up→down (HTTP $HTTP_CODE) — kickstarting com.merlin.chrome-cdp" >> "$LOG"
  self_heal_chrome_cdp
  write_state "down" "" "$NOW_ISO"
  exit 0
fi

# DOWN → UP: silent recovery, clear last_notified + heal marker.
if [ "$PREV" = "down" ] && [ "$CURR" = "up" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] recovery: down→up (HTTP 200)" >> "$LOG"
  write_state "up" "" ""
  exit 0
fi

# DOWN → DOWN: kickstart was attempted on the previous transition and Chrome
# is STILL down. Fire the alert now (respecting quiet hours), unless we've
# already notified for this incident.
if [ "$PREV" = "down" ] && [ "$CURR" = "down" ] && [ -z "$PREV_NOTIFIED" ]; then
  if [ "$IN_QUIET_HOURS" = "1" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] still down after kickstart (HTTP $HTTP_CODE) — ping deferred to post-09:00 ET" >> "$LOG"
    write_state "down" "" "keep"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] still down after kickstart (HTTP $HTTP_CODE) — notifying" >> "$LOG"
    # --skip-precheck: chrome-cdp liveness alert is infrastructure-critical;
    # bypass the Sonnet-gated outbound precheck for the same reasons as
    # watchdog.sh (see system/architecture.md § Outbound Precheck).
    "${MERLIN_HOME}/bin/merlin-send-curl" --suppress-hook --skip-precheck --intent chrome-cdp-down --channel system \
      "🔌 Chrome DevTools port 9222 unreachable (HTTP $HTTP_CODE) — auto-restart of com.merlin.chrome-cdp didn't recover it. Likely TCC permission prompt (Screen Recording / Accessibility / Automation) or chrome-devtools-mcp re-signed. Browser-automation jobs will skip until this clears. Manual intervention needed." \
      > /dev/null 2>&1
    write_state "down" "$NOW_ISO" "keep"
  fi
  exit 0
fi

# Steady-state (up→up, or down→down already notified): keep `since` and
# heal marker. No log line to avoid spam.
write_state "$CURR" "$PREV_NOTIFIED" "keep"
