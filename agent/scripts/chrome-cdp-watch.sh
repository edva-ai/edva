#!/bin/bash
# chrome-cdp-watch.sh — detect Chrome DevTools Protocol outages and notify once per transition.
#
# The ops-agent's chrome-devtools MCP uses --autoConnect, which requires Chrome
# running with --remote-debugging-port=9222 on a non-default user data dir.
# macOS TCC permission prompts (Screen Recording / Accessibility / Automation)
# and chrome-devtools-mcp re-signs can silently drop the grant and break
# browser-automation jobs. This script probes the CDP port and fires exactly
# one Edva ping on each UP→DOWN transition; DOWN→UP is silent (self-heal).
#
# Install via crontab: */15 * * * * $HOME/Dev/edva/agent/scripts/chrome-cdp-watch.sh
#
# State: data/chrome-cdp-state.json {state, since, last_notified}
# Log:   agent/logs/watchdog.log  (single source of truth for ops alerts)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

STATE_FILE="$HOME/Dev/edva/data/chrome-cdp-state.json"
LOG="$HOME/Dev/edva/agent/logs/watchdog.log"
NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# chrome-cdp LaunchAgent + Chrome details (mirror com.edva.chrome-cdp.plist).
PLIST="$HOME/Library/LaunchAgents/com.edva.chrome-cdp.plist"
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_PROFILE="$HOME/.cache/chrome-devtools-mcp/chrome-profile"

# Quiet hours: skip notification during the user's sleep window (00:00–09:00
# LOCAL). Resolve the user's current tz (phone-reported → user-timezone.json, home
# timezone fallback) so quiet-hours follow the user when traveling. The probe still runs so
# state transitions are recorded; only the ping is suppressed. If CDP is still
# down at 09:00 local, the next post-09:00 tick notifies. Base-10 normalize to
# avoid octal parse of "08"/"09".
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
HOUR_LOCAL=$((10#$(TZ="$USER_TZ" date +%H)))
IN_QUIET_HOURS=0
if [ "$HOUR_LOCAL" -lt 9 ]; then IN_QUIET_HOURS=1; fi

# Probe: HTTP 200 on /json/version = CDP healthy. Any other response =
# "down" (connection refused, timeout, 4xx/5xx). Kernel-enforced 5s cutoff.
# Uses `localhost` (not 127.0.0.1) — Chrome 147 silently binds an IPv4 stub
# to :9222 from the user's interactive profile that 404s on every CDP path.
# `localhost` resolves to ::1 first on macOS, hitting the LaunchAgent-managed
# automation Chrome (com.edva.chrome-cdp) which binds IPv6 :9222.
HTTP_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://localhost:9222/json/version 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  CURR="up"
else
  CURR="down"
fi

# --- Tab hygiene: reap leaked page tabs (two-strike, ≥1 tick ≈15min age) ---
# Chrome-automation jobs (event watchers, outreach jobs, …)
# open http(s) page tabs but don't reliably close them. They pile up — dozens of
# pages / well over a hundred targets — and each leaked page keeps a swarm of
# ad/tracker iframes+workers alive, bloating memory and crashing renderers
# (chrome-cdp.err.log: ~700k ERROR + ~13k crash lines). Confirmed live that
# closing the page tabs reaps the whole subtree (28 pages → 1, 169 → 10 targets).
# To avoid yanking a tab a job is actively using, close ONLY tabs that were also
# open on the previous tick (survived ≥1 interval ≈15 min — far longer than any
# single chrome job's per-tab step). A freshly-opened tab always gets at least a
# full interval of grace; a leaked tab is reaped on the next tick. about:blank is
# always kept so the window (and the CDP port) stays alive.
if [ "$CURR" = "up" ]; then
  TAB_SNAP="$HOME/Dev/edva/data/chrome-tab-snapshot.json"
  CLOSE_IDS=$(curl -s --max-time 5 "http://localhost:9222/json/list" | TAB_SNAP="$TAB_SNAP" python3 -c '
import json, os, sys
try:
    tabs = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cur = sorted({t["id"] for t in tabs
              if t.get("type") == "page" and t.get("url", "").startswith("http")})
snap = os.environ["TAB_SNAP"]
try:
    prev = set(json.load(open(snap)))
except Exception:
    prev = set()
# Persist the current set for the next tick before closing anything.
try:
    json.dump(cur, open(snap, "w"))
except Exception:
    pass
# Close only tabs open across two consecutive ticks (leaked, not in active use).
for tid in sorted(set(cur) & prev):
    print(tid)
' 2>/dev/null)
  if [ -n "$CLOSE_IDS" ]; then
    HYG_N=0
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      curl -sf --max-time 5 "http://localhost:9222/json/close/$id" >/dev/null 2>&1 && HYG_N=$((HYG_N+1))
    done <<< "$CLOSE_IDS"
    [ "$HYG_N" -gt 0 ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] tab-hygiene: reaped $HYG_N leaked page tab(s)" >> "$LOG"
  fi
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

# Try to recover Chrome CDP, escalating through three repair tiers. The next
# watchdog tick re-probes :9222 and notifies if still down regardless.
#
# Tier 1 — kickstart: if the LaunchAgent is registered, tear down + respawn (-k).
# Tier 2 — bootstrap: if the agent is NOT registered (a seen failure mode,
#          where the job got unloaded and kickstart silently no-ops
#          with "Could not find service"), clear any stale Chrome holding the
#          profile/port and re-register the agent so KeepAlive resumes.
# Tier 3 — direct launch: if bootstrap still fails, launch Chrome directly so
#          browser-automation jobs can run; not KeepAlive-managed until a later
#          bootstrap succeeds, but better than staying dark.
self_heal_chrome_cdp() {
  local svc="gui/$UID/com.edva.chrome-cdp"
  if launchctl print "$svc" >/dev/null 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] heal tier1: kickstart $svc" >> "$LOG"
    launchctl kickstart -k "$svc" >> "$LOG" 2>&1
    return 0
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] heal tier2: agent not registered — clearing stale chrome + bootstrapping" >> "$LOG"
  pkill -f "user-data-dir=$CHROME_PROFILE" 2>/dev/null; sleep 2
  pkill -9 -f "user-data-dir=$CHROME_PROFILE" 2>/dev/null; sleep 1
  rm -f "$CHROME_PROFILE/SingletonLock" "$CHROME_PROFILE/SingletonSocket" \
        "$CHROME_PROFILE/SingletonCookie" "$CHROME_PROFILE/DevToolsActivePort" 2>/dev/null
  launchctl enable "$svc" >> "$LOG" 2>&1
  if launchctl bootstrap "gui/$UID" "$PLIST" >> "$LOG" 2>&1; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] heal tier2: bootstrap ok" >> "$LOG"
    return 0
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] heal tier3: bootstrap failed — direct-launching chrome" >> "$LOG"
  nohup "$CHROME_BIN" --remote-debugging-port=9222 --user-data-dir="$CHROME_PROFILE" \
    --no-first-run --no-default-browser-check --disable-features=ChromeWhatsNewUI about:blank \
    >> "$LOG" 2>&1 &
  return 0
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
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] transition up→down (HTTP $HTTP_CODE) — kickstarting com.edva.chrome-cdp" >> "$LOG"
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
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] still down after kickstart (HTTP $HTTP_CODE) — ping deferred to post-09:00 local" >> "$LOG"
    write_state "down" "" "keep"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chrome-cdp-watch] still down after kickstart (HTTP $HTTP_CODE) — notifying" >> "$LOG"
    # --skip-precheck: chrome-cdp liveness alert is infrastructure-critical;
    # bypass the Sonnet-gated outbound precheck for the same reasons as
    # watchdog.sh (see system/architecture.md § Outbound Precheck).
    # EDVA_INFRA_PROBE=1 — cron-run, un-sandboxed HTTP probe of :9222, so
    # it may make a machine-health claim (see edva-send-curl's gate).
    EDVA_INFRA_PROBE=1 "$HOME/Dev/edva/bin/edva-send-curl" --suppress-hook --skip-precheck --intent chrome-cdp-down --channel system \
      "🔌 Chrome DevTools port 9222 unreachable (HTTP $HTTP_CODE) — auto-restart of com.edva.chrome-cdp didn't recover it. Likely TCC permission prompt (Screen Recording / Accessibility / Automation) or chrome-devtools-mcp re-signed. Browser-automation jobs will skip until this clears. Manual intervention needed." \
      > /dev/null 2>&1
    write_state "down" "$NOW_ISO" "keep"
  fi
  exit 0
fi

# Steady-state (up→up, or down→down already notified): keep `since` and
# heal marker. No log line to avoid spam.
write_state "$CURR" "$PREV_NOTIFIED" "keep"
