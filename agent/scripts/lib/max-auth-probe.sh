# max-auth-probe.sh — the last launchd-context Max sign-in check, kept on disk
# so watchdog.sh can tell a live Max-auth outage from quiet supervisor logs.
# Sourced (bash) by trigger-live-day.sh (writer) and watchdog.sh (reader).
#
# WHY. watchdog.sh runs under cron, which cannot read the login keychain, so
# it cannot ask `claude auth status` itself (every tick would read logged out).
# Without this file it can only see an outage through a supervisor's own failed
# turn: an AUTH ERROR line under 6 minutes old, or authAlertSent on /health,
# which a supervisor sets only after 3 failed turns in a row. Overnight the
# supervisors run few turns: a single AUTH ERROR line ages out, nothing holds
# the incident, and the system channel gets "✅ Recovered: Max auth" inside a
# live outage, with the first red page long after the sign-in was lost. All of
# that time, live-day's launchd run reads `loggedIn=false` every 10 minutes.
# This file passes that reading to watchdog.
#
# Writer: trigger-live-day.sh --run, i.e. the launchd agent ai.claude.live-day,
# which cron kicks every 10 minutes. That is the keychain-capable context the
# scheduled Claude runs use. It is the only writer on purpose: a write from
# cron or an SSH shell would always read logged out, and so would page an
# outage that isn't there. The writer skips SSH sessions (max_auth_from_ssh).
#
# File, one JSON line (machine structure only):
#   {"ts":<epoch>,"ok":true|false,"fail_since":<epoch, 0 when ok>,
#    "summary":"<max_auth_check's MAX_AUTH_SUMMARY>","source":"live-day"}
# fail_since is the first failing check of the current run of failures, so
# the reader can wait for a second failing check before paging.

MAX_AUTH_PROBE_FILE="${MAX_AUTH_PROBE_FILE:-$HOME/Dev/edva/data/max-auth-probe.json}"

# A failing check only carries an earlier fail_since forward when the previous
# record is this recent, so a failure left on disk by a week-old run cannot
# make a fresh one look like a long outage.
MAX_AUTH_PROBE_STREAK_GAP=1800

_max_auth_probe_num() {   # <key> <file>: an integer field, or nothing
  grep -oE "\"$1\":[0-9]+" "$2" 2>/dev/null | head -n1 | sed -E 's/^[^:]*://'
}

# max_auth_probe_record <ok: 1|0> <summary> [source]
# Never fails the caller: the record is advisory, the refresh is the job.
max_auth_probe_record() {
  local ok="${1:-0}" summary="${2:-}" src="${3:-live-day}" now since prev_ts prev_since tmp okj
  now=$(date +%s)
  since=0
  okj=true
  if [ "$ok" != "1" ]; then
    okj=false
    since="$now"
    if grep -q '"ok":false' "$MAX_AUTH_PROBE_FILE" 2>/dev/null; then
      prev_ts=$(_max_auth_probe_num ts "$MAX_AUTH_PROBE_FILE")
      prev_since=$(_max_auth_probe_num fail_since "$MAX_AUTH_PROBE_FILE")
      if [[ "$prev_ts" =~ ^[0-9]+$ ]] && [[ "$prev_since" =~ ^[0-9]+$ ]] \
         && [ "$prev_since" -gt 0 ] && [ "$prev_since" -le "$now" ] \
         && [ $(( now - prev_ts )) -le "$MAX_AUTH_PROBE_STREAK_GAP" ]; then
        since="$prev_since"
      fi
    fi
  fi
  summary=$(printf '%s' "$summary" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-200)
  tmp="$MAX_AUTH_PROBE_FILE.tmp.$$"
  if printf '{"ts":%s,"ok":%s,"fail_since":%s,"summary":"%s","source":"%s"}\n' \
       "$now" "$okj" "$since" "$summary" "$src" 2>/dev/null > "$tmp"; then
    mv -f "$tmp" "$MAX_AUTH_PROBE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

# max_auth_probe_read [now_epoch] [max_age_sec=1200] — sets
#   MAX_AUTH_PROBE_STATE     ok | fail | stale | absent
#   MAX_AUTH_PROBE_FAIL_SEC  how long the failing run has lasted, first failing
#                            check to latest (0 unless fail)
#   MAX_AUTH_PROBE_SINCE     epoch of the first failing check (0 unless fail)
#   MAX_AUTH_PROBE_SUMMARY   what `auth status` said
#   MAX_AUTH_PROBE_TS        epoch the reading was taken (0 unless ok/fail)
# stale = older than max_age, from the future, or unreadable. A stale or absent
# record is no evidence either way, and the caller must treat it that way.
max_auth_probe_read() {
  local now="${1:-$(date +%s)}" max_age="${2:-1200}" ts since
  MAX_AUTH_PROBE_STATE=absent
  MAX_AUTH_PROBE_FAIL_SEC=0
  MAX_AUTH_PROBE_SINCE=0
  MAX_AUTH_PROBE_SUMMARY=""
  MAX_AUTH_PROBE_TS=0
  [ -f "$MAX_AUTH_PROBE_FILE" ] || return 0
  MAX_AUTH_PROBE_STATE=stale
  ts=$(_max_auth_probe_num ts "$MAX_AUTH_PROBE_FILE")
  [[ "$ts" =~ ^[0-9]+$ ]] || return 0
  [ $(( now - ts )) -le "$max_age" ] || return 0
  [ "$ts" -le $(( now + 300 )) ] || return 0
  MAX_AUTH_PROBE_TS="$ts"
  MAX_AUTH_PROBE_SUMMARY=$(grep -oE '"summary":"[^"]*"' "$MAX_AUTH_PROBE_FILE" 2>/dev/null | head -n1 | sed -E 's/^"summary":"//; s/"$//')
  if grep -q '"ok":true' "$MAX_AUTH_PROBE_FILE" 2>/dev/null; then
    MAX_AUTH_PROBE_STATE=ok
  elif grep -q '"ok":false' "$MAX_AUTH_PROBE_FILE" 2>/dev/null; then
    MAX_AUTH_PROBE_STATE=fail
    since=$(_max_auth_probe_num fail_since "$MAX_AUTH_PROBE_FILE")
    { [[ "$since" =~ ^[0-9]+$ ]] && [ "$since" -gt 0 ] && [ "$since" -le "$ts" ]; } || since="$ts"
    MAX_AUTH_PROBE_SINCE="$since"
    MAX_AUTH_PROBE_FAIL_SEC=$(( ts - since ))
  fi
  return 0
}
