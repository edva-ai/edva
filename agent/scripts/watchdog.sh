#!/bin/bash
# cron runs with PATH=/usr/bin:/bin; tools like gmail-action need node via
# homebrew. Set PATH explicitly so checks don't silently no-op (without it
# the Gmail unread sweep never runs).
export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin
source "$(dirname "$0")/lib/webhook-auth.sh"
source "$(dirname "$0")/lib/max-auth-probe.sh"   # launchd sign-in check, see § Max auth outage
# This installation's identity (EDVA_OWNER_EMAIL, EDVA_DOMAIN,
# EDVA_SUPABASE_PROJECT, …) from lib/instance.cjs; env wins.
source "$(dirname "$0")/lib/instance.sh"
# The instance's own checks (optional): _ext/watchdog-checks.sh defines
# _ext_incident_label and _ext_watchdog_checks, run below where they belong.
[ -f "$(dirname "$0")/_ext/watchdog-checks.sh" ] && source "$(dirname "$0")/_ext/watchdog-checks.sh"
# watchdog.sh — health monitor for the agent process-manager.
# Runs every 5 min via cron: */5 * * * * /path/to/watchdog.sh
#
# The process-manager handles spawning and restarting child processes directly.
# This watchdog focuses on higher-level health:
#   - Ops supervisor HTTP health + event staleness
#   - Gmail push delivery gaps
#   - Crash-loop detection (via supervisor /health)
#   - Alerting via Edva / email draft
#
# It no longer manages tmux sessions or panes.

LOG="$HOME/Dev/edva/agent/logs/watchdog.log"
NODE=/opt/homebrew/bin/node
SEND="$HOME/Dev/edva/bin/edva-send-curl"
GMAIL_ACTION="$HOME/Dev/edva/bin/gmail-action"
EMAIL_SEND="$HOME/Dev/edva/bin/email-send"
WORKDIR="$HOME/Dev/edva/agent"
SUPERVISOR_DIR="$WORKDIR/supervisor"
CONFIG_DIR="$WORKDIR/config"
ALERT_COOLDOWN="$HOME/Dev/edva/data/.watchdog-last-alert"
STALE_RESTART_COOLDOWN="$HOME/Dev/edva/data/.triage-restart-cooldown"
CLOUDFLARED_RESTART_COOLDOWN="$HOME/Dev/edva/data/.cloudflared-restart-cooldown"
# The daily-summary self-heal's once-per-24h marker. Defined up here (not in the
# daily-summary block) because § Max auth outage also needs it: it re-arms the
# heal when an auth outage ends.
DS_HEAL_MARKER="$HOME/Dev/edva/data/.daily-summary-heal-cooldown"
CLOUDFLARED_LABEL="com.cloudflare.cloudflared"
# The tunnel's public host: EDVA_PUSH_HOST, else gmail-push.<instance domain>.
# Empty (no domain configured) → the tunnel check is skipped.
CLOUDFLARED_HOST="${EDVA_PUSH_HOST:-${EDVA_DOMAIN:+gmail-push.$EDVA_DOMAIN}}"
CLOUDFLARED_LSOF="/usr/sbin/lsof"
STALE_EVENT_MS=600000  # 10 min without supervisor events = stale
PUSH_GAP_MS=3600000    # 60 min without Gmail push = likely Pub/Sub delivery failure

# Queue-depth thresholds. Normal steady-state is 0-2 queued;
# WARN logs but stays silent; ALERT pages the user (rate-limited via
# incident_should_alert). Tunable here; durable-queue snapshot baseline at
# data/dispatcher-queue.json shows 0 queued / a few inFlight typically.
QUEUE_BACKLOG_WARN=5
QUEUE_BACKLOG_ALERT=10

# Supervisor health port
eval "$("$CONFIG_DIR/load-agent.sh" ops)"
HEALTH_PORT="$AGENT_SUPERVISOR_HEALTH_PORT"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# home_tz_label — the home time zone's short generic name ("ET", "PT", …) for
# alert text, from EDVA_TZ (lib/instance.sh). Only alert paths call it; an
# unknown zone prints the zone id itself.
home_tz_label() {
  local l
  l=$("$NODE" -e 'const p=new Intl.DateTimeFormat("en-US",{timeZone:process.argv[1],timeZoneName:"shortGeneric"}).formatToParts(new Date()).find((x)=>x.type==="timeZoneName");process.stdout.write(p?p.value:"")' "${EDVA_TZ:-UTC}" 2>/dev/null)
  printf '%s' "${l:-${EDVA_TZ:-UTC}}"
}

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

# Set by incident_should_alert to the incident key it just authorised a page
# for; consumed and cleared by the very next notify(). Lets notify() record
# whether the page actually reached the user, instead of the marker recording
# only that we tried.
PENDING_ALERT_KEY=""

notify() {
  # --skip-precheck: watchdog alerts are critical liveness signals (process
  # crashed, disk full, network down). They must bypass the Sonnet-gated
  # outbound precheck because (a) precheck depends on Supabase being
  # reachable, which is itself a thing the watchdog might be alerting on,
  # and (b) delaying or suppressing a liveness alert defeats its purpose.
  # EDVA_INFRA_PROBE=1 — this script is the ONE authorized author of
  # machine-health pages (agent/CLAUDE.md § System Channel). It runs from
  # cron, outside the agent Bash sandbox, so its curl/pgrep/launchctl probes see
  # the real machine. edva-send-curl rejects total-outage claims without it.
  # Consume the key stashed by incident_should_alert (see PENDING_ALERT_KEY).
  local key="$PENDING_ALERT_KEY"
  PENDING_ALERT_KEY=""

  if EDVA_INFRA_PROBE=1 "$SEND" --skip-precheck --intent watchdog-alert --channel system "$1" > /dev/null 2>&1; then
    log "Notified via Edva: $1"
    [ -n "$key" ] && touch "$INCIDENT_DIR/${key}.delivered" 2>/dev/null
    return 0
  fi

  # The primary channel writes to Supabase, and "Supabase unreachable" is one of
  # the conditions this script pages about -- so the alert about an outage can be
  # the exact thing that outage eats. Fall back to SMTP2Go over HTTPS, which is
  # independent of Supabase, the Gmail API and the Cloudflare tunnel. NOT a Gmail
  # draft: agent/CLAUDE.md forbids a draft as a notification fallback,
  # because the user never sees it; a draft fallback leaves later "Recovered:"
  # pings with no preceding warning anywhere in the channel.
  if [ -x "$EMAIL_SEND" ] && [ -n "${EDVA_OWNER_EMAIL:-}" ] \
     && "$EMAIL_SEND" --to "$EDVA_OWNER_EMAIL" --subject "🔴 ${EDVA_HOST_TITLE:-Host} Watchdog" --body "$1" > /dev/null 2>&1; then
    log "Notified via email (Edva channel unavailable): $1"
    [ -n "$key" ] && touch "$INCIDENT_DIR/${key}.delivered" 2>/dev/null
    return 0
  fi

  log "ALERT UNDELIVERED (no channel reachable): $1"
  # Nothing reached the user. Roll back the bookkeeping incident_should_alert
  # optimistically wrote, so the NEXT tick re-pages instead of recording this as
  # "the user was told". Without this the marker persists, the warning is lost for
  # good, and incident_clear later fires a recovery ping for a failure that
  # never appeared in the channel at all.
  if [ -n "$key" ]; then
    rm -f "$INCIDENT_DIR/${key}.alerted" 2>/dev/null
    local c
    c=$(cat "$INCIDENT_DIR/${key}.alert_count" 2>/dev/null || echo 1)
    [[ "$c" =~ ^[0-9]+$ ]] || c=1
    c=$((c - 1)); [ "$c" -lt 0 ] && c=0
    echo "$c" > "$INCIDENT_DIR/${key}.alert_count"
  fi
  return 1
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
# Heal-then-alert policy: the watchdog must
# exhaust auto-repair before paging. Each incident type tracks its own
# consecutive-failure counter. Self-heal fires every tick (idempotent), but
# the user-facing alert only goes out once the heal has demonstrably failed
# — i.e. the same condition still trips on the NEXT tick (count >= 2).
# When the probe passes again, the incident state clears so the next failure
# starts fresh.
INCIDENT_DIR="$HOME/Dev/edva/data/watchdog-incidents"
mkdir -p "$INCIDENT_DIR" 2>/dev/null

# _incident_label <key> — human-readable name for a recovery ping. Falls back
# to the raw key for any incident not listed here.
_incident_label() {
  case "$1" in
    process-manager-down)   echo "process manager" ;;
    ops-queue-backlog)      echo "ops agent queue backlog" ;;
    chat-queue-backlog)     echo "chat agent queue backlog" ;;
    chat-delivery-stuck)    echo "chat message delivery" ;;
    cloudflared-tunnel)     echo "Cloudflare tunnel (Gmail push ingress)" ;;
    gmail-unread-stuck)     echo "Gmail push / unread delivery" ;;
    ollama-down)            echo "local Ollama (phone-channel acks)" ;;
    auth-outage)            echo "Max auth" ;;
    creds-plaintext)        echo "Max credentials (plaintext copy)" ;;
    creds-plaintext-max-token) echo "Max login stored in plaintext" ;;
    wiki-server-down)       echo "wiki / memory server" ;;
    gmail-watch)            echo "Gmail watch renewal" ;;
    supabase-unreachable)   echo "Supabase" ;;
    phone-channel-duplicate) echo "phone-channel process count" ;;
    daily-summary-missing)  echo "daily summary delivery" ;;
    episode-archive-missing) echo "episode-archive wiki page" ;;
    daily-summary-orphan-row) echo "daily-summary row published without a wiki page" ;;
    nightly-review-missing) echo "weekly self-improvement review" ;;
    gog-auth)               echo "gog (Google Tasks/Calendar/Drive) auth" ;;
    gh-auth)                echo "gh (GitHub CLI) auth" ;;
    disk-low)               echo "${EDVA_HOST_TITLE:-Host} free disk space" ;;
    disk-critical)          echo "${EDVA_HOST_TITLE:-Host} free disk space (critical)" ;;
    *)  # The instance's own incident keys (_ext/watchdog-checks.sh), else the key.
        if declare -F _ext_incident_label >/dev/null && _ext_incident_label "$1"; then :; else echo "$1"; fi ;;
  esac
}

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
    # Recovery notification: if we actually paged for this incident, tell the
    # user it self-healed — parity with the failure alert. Only
    # after 3 consecutive green ticks, and only once (the .alerted marker is
    # removed just below), so it can't spam.
    # .alerted means "we tried to page"; .delivered means "it actually landed".
    # Only the second earns a recovery ping. A green check for a warning the user
    # never received is worse than silence: it reads as "something broke and
    # fixed itself" when the truth is "we could not tell you it broke."
    if [ -f "$INCIDENT_DIR/${key}.alerted" ] && [ -f "$INCIDENT_DIR/${key}.delivered" ]; then
      # "auto-healed" is a causal claim this probe cannot see: a Max auth outage
      # can end because someone signed in by hand, and "recovered on its own"
      # would then be false. Say what was observed, not why.
      local how="auto-healed"
      case "$key" in
        # Set by § Max auth outage from what it actually saw: a fresh launchd
        # sign-in check, or only quiet logs.
        auth-outage)     how="${AUTH_RECOVERY_HOW:-no supervisor has logged a new auth error for 6 minutes (if someone logged in, that was the fix; this check cannot tell)}" ;;
        creds-plaintext) how="the plaintext credentials file is gone" ;;
        creds-plaintext-max-token) how="the Max login is no longer inside ~/.claude/.credentials.json" ;;
        # The disk probe heals nothing (see "Data-volume free space"), so space
        # coming back was someone or something else freeing it: report the line
        # it crossed, never "auto-healed".
        disk-low)        how="free space on the data volume is back above the $(_disk_gib_threshold "$WATCHDOG_DISK_WARN_GIB" 25) GiB warning line" ;;
        disk-critical)   how="free space on the data volume is back above the $(_disk_gib_threshold "$WATCHDOG_DISK_CRIT_GIB" 10) GiB critical line" ;;
      esac
      notify "✅ Recovered: $(_incident_label "$key") is back to normal — $how, stable for 3 checks."
    elif [ -f "$INCIDENT_DIR/${key}.alerted" ]; then
      log "incident_clear $key: recovered, but the failure alert was never delivered -- suppressing the orphan recovery ping"
    fi
    rm -f "$INCIDENT_DIR/${key}.alerted" \
          "$INCIDENT_DIR/${key}.delivered" \
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
#      first alert. This stops a loop of identical "manual intervention needed"
#      pages for one incident that the user cannot act on remotely.
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
  # Hand the key to notify() so it can confirm delivery, or roll this back if
  # nothing landed. Every call site has the shape
  #   if incident_should_alert "k"; then notify "..."; fi
  # so notify() is always the next thing to run. It clears the global on entry,
  # and a notify() with no pending key (the recovery ping) is a no-op here.
  PENDING_ALERT_KEY="$key"
  return 0
}

# cloudflared_tunnel_probe — end-to-end reachability gate for the Gmail-push
# ingress tunnel. Gmail Pub/Sub and the CF Email Worker reach
# the ops-supervisor :9090 through a Cloudflare Tunnel ($CLOUDFLARED_HOST →
# localhost:9090), managed by its own launchd agent (com.cloudflare.cloudflared),
# not by process-manager. By the heal-then-alert policy
# we must exhaust concrete probes before paging.
#
# Two layers:
#
#   1. The public URL, fetched FROM this host. A GET returns the supervisor's
#      {"ok":true} health JSON through Cloudflare and the tunnel, so a 2xx means
#      the whole path works and nothing else is asked: the healthy path. We
#      deliberately send NO OIDC token: the POST path requires one (and would
#      401), but the GET branch is unauthenticated and answers 200.
#   2. Anything else (no answer, or an error status) is ambiguous on its own, so
#      ask cloudflared itself (cloudflared_local_ready below).
#
# Layer 1 alone is wrong in both directions, because it tests this host's OWN
# outbound path to its public hostname, not inbound delivery. Brief stalls on
# that leg read as "tunnel down": a healthy tunnel gets restarted and a false
# "Gmail pushes are not arriving" page goes out while pushes are still being
# accepted through the same tunnel. The other direction:
# when cloudflared really has no connections, Cloudflare's edge answers with its
# own error page (error 1033, "cannot find a healthy cloudflared instance"), and
# that is an HTTP status, which the old "any code = up" rule read as healthy.
#
# Verdict (TUNNEL_PROBE_EVIDENCE carries the reasons into the log and the page):
#   public URL 2xx                        -> up
#   cloudflared holds no live connection  -> down, whatever the public URL said
#   cloudflared connected, URL 530        -> down (the edge cannot find it)
#   cloudflared connected, URL 000        -> up, TUNNEL_HAIRPIN_ONLY=1: only this
#                                            host's view of its own hostname failed
#   cloudflared connected, other status   -> up (502 is :9090 itself, not the tunnel)
#   cloudflared status unreadable         -> the old rule plus 530: 000/530 = down
#
# The X-Edva-Probe: watchdog header marks the request for log correlation.
#
# Exit 0 = tunnel up; non-zero = down.
cloudflared_tunnel_probe() {
  local out rc code timings="" local_state
  TUNNEL_PROBE_EVIDENCE=""
  TUNNEL_HAIRPIN_ONLY=0
  # No tunnel host configured (no instance domain): nothing to probe.
  [ -n "$CLOUDFLARED_HOST" ] || return 0
  out=$(curl -s -o /dev/null --max-time 8 \
    -w "%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s" \
    -H "X-Edva-Probe: watchdog" \
    "https://${CLOUDFLARED_HOST}/" 2>/dev/null)
  rc=$?
  code="${out%% *}"
  [[ "$code" =~ ^[0-9][0-9][0-9]$ ]] || code="000"
  case "$code" in 2??) return 0 ;; esac

  [ "$out" != "${out#* }" ] && timings=", ${out#* }"
  local_state=$(cloudflared_local_ready)
  TUNNEL_PROBE_EVIDENCE="public URL answered HTTP $code from this host (curl exit $rc$timings); cloudflared: $local_state"
  case "$local_state" in
    ready:*)
      [ "$code" = "530" ] && return 1
      [ "$code" = "000" ] && TUNNEL_HAIRPIN_ONLY=1
      return 0
      ;;
    notready:*|notrunning)
      return 1
      ;;
  esac
  if [ "$code" = "000" ] || [ "$code" = "530" ]; then
    return 1
  fi
  return 0
}

# cloudflared_local_ready — cloudflared's own answer to "am I connected to
# Cloudflare?", read from the /ready endpoint of its metrics server
# ({"status":200,"readyConnections":4,...}; 503 and 0 when it holds none).
# Echoes one of:
#   ready:<n>       n >= 1 live connections to the edge
#   notready:<n>    the process is up but holds no live connection
#   notrunning      launchd has the agent loaded and says it is not running
#   unknown:<why>   could not ask (launchctl, lsof or /ready unreadable)
#
# The metrics port is resolved from the process, never assumed: cloudflared
# takes the first free port in 20241-20245, and another cloudflared on the host
# can share that range, so which tunnel holds 20241 depends on
# start order. lsof lives in
# /usr/sbin, which is not on this script's PATH, hence CLOUDFLARED_LSOF.
cloudflared_local_ready() {
  local info state pid port n
  info=$(launchctl print "gui/$UID/$CLOUDFLARED_LABEL" 2>/dev/null) || { echo "unknown:launchctl"; return 0; }
  # The first "state =" line is the service's own; later ones are its endpoints.
  state=$(printf '%s\n' "$info" | awk '$1 == "state" && $2 == "=" { print $3; exit }')
  pid=$(printf '%s\n' "$info" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    # "Not running" only when launchctl described the service and said so; an
    # unexpected shape is unknown, not down.
    case "$state" in
      ""|running) echo "unknown:launchctl-state=${state:-none}" ;;
      *) echo "notrunning" ;;
    esac
    return 0
  fi
  port=$("$CLOUDFLARED_LSOF" -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null \
    | sed -n 's/^n.*:\([0-9][0-9]*\)$/\1/p' | head -1)
  [ -n "$port" ] || { echo "unknown:no-metrics-port"; return 0; }
  n=$(curl -s --max-time 3 "http://127.0.0.1:${port}/ready" 2>/dev/null \
    | jq -r '.readyConnections // empty' 2>/dev/null)
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "unknown:ready-unreadable"; return 0; }
  if [ "$n" -ge 1 ]; then echo "ready:$n"; else echo "notready:$n"; fi
}

# host_network_reachable — the "is it us or them?" control probe.
#
# Every outbound check in this file (the tunnel, Supabase, the gog token probe,
# the heartbeat sender) fails IDENTICALLY when its own vendor is down and when
# THIS HOST has no outbound network at all: curl returns 000 either way. With no
# control, each monitor blames its own component, so one short partition
# produces several simultaneous capability-down pages, each prescribing a remedy
# that cannot work.
#
# That has happened: one short partition failed the tunnel, Supabase, gog token
# and heartbeat probes together, and each page prescribed a remedy for a
# component that was fine. The gh-auth check further down this file already
# asks exactly this question first (see `github_api_reachable`).
#
# TWO INDEPENDENT control vendors, because a single control turns that vendor's
# own outage into silence about ours. Neither may be Cloudflare-fronted: the
# tunnel this controls for resolves through Cloudflare, so a Cloudflare-hosted
# control (one.one.one.one and friends) would fail alongside it and mask a
# genuine Cloudflare incident — the one case where the page is exactly right.
#
# Called lazily, only from a failure branch, so the healthy path pays nothing.
#
# Exit 0 = this host can reach the internet, so a failing vendor probe means the
# vendor really is down. Non-zero = no outbound network path; no verdict is
# available about any individual vendor.
host_network_reachable() {
  local host code
  for host in "https://api.github.com/" "https://aws.amazon.com/"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
      -H "X-Edva-Probe: watchdog" "$host" 2>/dev/null)
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
  done
  return 1
}

# _disk_gib_threshold <value> <default> — a whole-GiB threshold from the
# environment. Anything that is not a whole number falls back to the default:
# a typo in an override must not switch the disk check off.
_disk_gib_threshold() {
  if [[ "$1" =~ ^[0-9]+$ ]]; then echo "$1"; else echo "$2"; fi
}

# disk_free_probe [path] — free space on the volume holding [path] (default
# $HOME/Dev/edva/data: the memory DB, its snapshots, the logs). See
# "Data-volume free space" below for why it exists.
#
# Reads `df -Pk`: POSIX output, a header line then one line per filesystem,
# sizes in KB, Available in column 4 and Capacity in column 5. Capacity is found
# by its shape (NN%) rather than by position, so a device name with a space in
# it cannot shift Available into the wrong column; on an ordinary line it is
# column 5 either way.
#
# Prints ONE line for the caller: "<level> <free_gib> <used_pct> <detail>"
#   level     ok | low | critical | unknown
#   free_gib  Available in GiB, rounded DOWN to one decimal ("-" when unknown),
#             so a reading under the 10 GiB line never prints as "10.0"
#   used_pct  Capacity without its % sign ("-" when unknown)
#   detail    the mount point, or why the reading is unknown
# free < WATCHDOG_DISK_CRIT_GIB (default 10) is critical; free <
# WATCHDOG_DISK_WARN_GIB (default 25) is low.
#
# unknown = df failed or printed something that does not parse. That says
# nothing about the disk either way, so the caller neither counts it toward a
# page nor clears an incident on it.
#
# Read-only: it measures and never deletes, prunes or moves anything.
disk_free_probe() {
  local target="${1:-$HOME/Dev/edva/data}"
  local warn crit out fields avail cap mount free_gib level
  warn=$(_disk_gib_threshold "$WATCHDOG_DISK_WARN_GIB" 25)
  crit=$(_disk_gib_threshold "$WATCHDOG_DISK_CRIT_GIB" 10)
  out=$(df -Pk "$target" 2>/dev/null) || { echo "unknown - - df-failed"; return 0; }
  fields=$(printf '%s\n' "$out" | awk 'NR == 2 {
    for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+%$/) {
      m = $(i + 1); for (j = i + 2; j <= NF; j++) m = m " " $j
      print $(i - 1), $i, m; exit
    } }')
  read -r avail cap mount <<< "$fields"
  if ! [[ "$avail" =~ ^[0-9]+$ ]] || ! [[ "$cap" =~ ^[0-9]+%$ ]]; then
    echo "unknown - - df-unparsed"
    return 0
  fi
  cap="${cap%\%}"
  free_gib=$(awk -v k="$avail" 'BEGIN { printf "%.1f", int(k * 10 / 1048576) / 10 }')
  if [ "$avail" -lt $((crit * 1048576)) ]; then
    level=critical
  elif [ "$avail" -lt $((warn * 1048576)) ]; then
    level=low
  else
    level=ok
  fi
  echo "$level $free_gib $cap ${mount:--}"
}

# disk_alert_body <free_gib> <used_pct> <snapshot_dir> — the human part of a
# disk page, after its stable prefix. Sizes <snapshot_dir> with `du -sk` (that
# one directory, nothing wider), and is only ever called while composing a page,
# so a healthy tick never walks a directory. Read-only like the probe.
disk_alert_body() {
  local free="$1" pct="$2" dir="$3" kb snap
  kb=$(du -sk "$dir" 2>/dev/null | awk 'NR == 1 { print $1 }')
  if [[ "$kb" =~ ^[0-9]+$ ]]; then
    snap="data/memory-db-snapshots holds $(awk -v k="$kb" 'BEGIN { printf "%.1f", k / 1048576 }') GiB of hourly memory-DB copies (they have filled the disk before)."
  else
    snap="data/memory-db-snapshots (hourly memory-DB copies, which have filled the disk before) could not be measured."
  fi
  echo "${free} GiB free on the data volume (${pct}% used). $snap Nothing was deleted. When space runs out, downloads to ${EDVA_HOST_LABEL:-the host} stall and database and log writes start failing."
}

ISSUES=""

# --- Hum state invariant check ---
# Runtime state files for hum (hum-state.json, hum-seen.json, hum-feedback.jsonl,
# hum-runs.jsonl) are gitignored. If a fresh clone or
# disaster-recovery checkout lacks them, hum dispatches silently produce empty
# state (and an empty digest). Watchdog
# initializes any missing file from schema default so the next hum tick has
# somewhere to land.
HUM_STATE="$HOME/Dev/edva/data/hum-state.json"
HUM_SEEN="$HOME/Dev/edva/data/hum-seen.json"
HUM_FEEDBACK="$HOME/Dev/edva/data/hum-feedback.jsonl"
HUM_RUNS="$HOME/Dev/edva/data/hum-runs.jsonl"
HUM_TODAY=$(TZ="${EDVA_TZ:-UTC}" date +%Y-%m-%d)
if [ ! -f "$HUM_STATE" ]; then
  log "Hum state missing: hum-state.json — initializing schema default"
  jq -n --arg today "$HUM_TODAY" \
    '{schema_version:2, pause:null, last_ping_at:null, last_run_at:null, last_input_signature:null, today:{date:$today, runs:0, pings:0, questions:0}, min_ping_interval_minutes:45, max_pings_per_day:6}' \
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
    notify "🔴 Process manager is down and didn't restart after launchctl kickstart. Manual intervention needed on ${EDVA_HOST_LABEL:-the host}."
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

      # Queue-depth early-alert. Normal steady-state is
      # queueDepth=0 with 1-2 inFlight; the durable-queue snapshot
      # data/dispatcher-queue.json was at 4 inFlight / 0 queued. A
      # sustained backlog above QUEUE_BACKLOG_WARN is the leading indicator
      # that downstream turns aren't draining (long-tail subagent, web-search
      # timeout, an agent stuck on a single turn). We log + page well before
      # the stale-then-restart machinery above trips, so debugging happens
      # while the buildup is small.
      if [ "$QUEUE_DEPTH" -ge "$QUEUE_BACKLOG_ALERT" ]; then
        ATTEMPT=$(incident_seen "ops-queue-backlog")
        log "Ops queue backlog: queueDepth=$QUEUE_DEPTH >= $QUEUE_BACKLOG_ALERT (attempt $ATTEMPT)"
        ISSUES="$ISSUES ops-supervisor(queue-backlog=$QUEUE_DEPTH)"
        if incident_should_alert "ops-queue-backlog"; then
          # Say WHICH non-draining state this is; do not guess one.
          #
          # A backlog has several distinct causes (a mid-rotation handover that
          # drains on its own, a dispatcher PAUSED through a Max-auth outage, a
          # genuinely stuck turn), so a hardcoded "likely a stuck subagent" hint
          # sends the reader after a cause that may not exist.
          #
          # $HEALTH is already fetched above and already carries the three fields
          # that tell those cases apart, so there is nothing to add here but a
          # read. A supervisor whose /health lacks them reports "unknown" rather
          # than a confident wrong cause — naming a cause we did not observe is
          # the defect being fixed, so the fix must not reintroduce it on the
          # fallback path. Deliberately NOT changing QUEUE_BACKLOG_ALERT: every
          # firing so far was a genuinely non-draining queue, so this is an
          # accuracy fix, not a suppression.
          Q_STATE=$(echo "$HEALTH" | jq -r '
            if (has("childAlive") and has("dispatcherPaused") and has("authAlertSent")) then
              (if .authAlertSent then "auth-outage"
               elif .dispatcherPaused then "paused"
               elif (.childAlive | not) then "child-down"
               else "working" end)
            else "unknown" end' 2>/dev/null)
          case "$Q_STATE" in
            auth-outage) Q_CAUSE="the dispatcher is paused for a Max-auth outage, so nothing will drain until auth is back." ;;
            paused)      Q_CAUSE="the dispatcher is paused, so nothing is reaching the agent — agent/logs/ops.log has the reason." ;;
            child-down)  Q_CAUSE="the agent process isn't running — most likely restarting, and it should drain once it's back." ;;
            working)     Q_CAUSE="the agent is alive and working, so this is a long-tail turn — check agent/logs/ops.log." ;;
            *)           Q_CAUSE="I can't tell why from the supervisor's health report — check agent/logs/ops.log." ;;
          esac
          log "Ops queue backlog cause: $Q_STATE"
          notify "⚠️ Ops queue backlog: ${QUEUE_DEPTH} tasks queued and $Q_CAUSE"
        fi
      elif [ "$QUEUE_DEPTH" -ge "$QUEUE_BACKLOG_WARN" ]; then
        log "Ops queue elevated: queueDepth=$QUEUE_DEPTH (warn=$QUEUE_BACKLOG_WARN, alert=$QUEUE_BACKLOG_ALERT)"
      else
        incident_clear "ops-queue-backlog"
      fi

      # Push gap is diagnostic + self-heal only, never an alert on its own.
      # Quiet overnight inboxes gap >60min normally; real failures also trip
      # a downstream detector (watch expiry, Cloudflare Tunnel down, unread
      # sweep) which alerts with a concrete symptom. The combined-signature
      # alert (gap + stuck unread) fires from the unread sweep below.
      PUSH_AGE=$(echo "$HEALTH" | jq -r '.lastPushAgeMs // 0')
      PUSH_GAP_RENEW_COOLDOWN="$HOME/Dev/edva/data/.watchdog-push-gap-renew-cooldown"
      if [ "$PUSH_AGE" -gt "$PUSH_GAP_MS" ]; then
        log_throttled "$HOME/Dev/edva/data/.watchdog-push-gap-log" \
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
          "$HOME/Dev/edva/agent/scripts/renew-gmail-watch.sh" >> "$LOG" 2>&1 || true
          touch "$PUSH_GAP_RENEW_COOLDOWN"
        fi

        ISSUES="$ISSUES gmail-push-gap(${PUSH_AGE}ms)"
      else
        # Recovery — clear throttles so the next gap self-heals promptly.
        rm -f "$HOME/Dev/edva/data/.watchdog-push-gap-log" 2>/dev/null
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

    # Chat event staleness (only if queue has work). A chat that is holding its
    # queue for a used-up Claude allowance (/health rateLimitHoldUntil, set by
    # chat-supervisor.mjs) is quiet on purpose: a restart sends
    # no turn and the hold survives it, so restarting would only respawn the
    # CLI and its MCP servers every tick until the reset. A missing field
    # leaves the check exactly as it was.
    CHAT_LAST_AGE=$(echo "$CHAT_HEALTH" | jq -r '.lastEventAgeMs // 0')
    CHAT_QUEUE=$(echo "$CHAT_HEALTH" | jq -r '.queueDepth // 0')
    CHAT_HOLD_UNTIL=$(echo "$CHAT_HEALTH" | jq -r '.rateLimitHoldUntil // empty')
    if [ "$CHAT_LAST_AGE" -gt "$STALE_EVENT_MS" ] && [ "$CHAT_QUEUE" -gt 0 ]; then
      if [ -n "$CHAT_HOLD_UNTIL" ]; then
        log "Chat quiet with queueDepth=$CHAT_QUEUE: holding for the Claude usage limit until $CHAT_HOLD_UNTIL — not restarting"
      else
        log "Chat supervisor stale: lastEventAge=${CHAT_LAST_AGE}ms queueDepth=$CHAT_QUEUE — restarting"
        curl -sf -X POST "http://127.0.0.1:$CHAT_HEALTH_PORT/restart" > /dev/null 2>&1
        ISSUES="$ISSUES chat-supervisor(stale)"
      fi
    fi

    # Chat queue-depth early-alert (parity with ops). Chat
    # backlogs are rarer (one-message-at-a-time phone-channel cadence) so
    # a buildup here is a stronger signal than on ops.
    if [ "$CHAT_QUEUE" -ge "$QUEUE_BACKLOG_ALERT" ]; then
      ATTEMPT=$(incident_seen "chat-queue-backlog")
      log "Chat queue backlog: queueDepth=$CHAT_QUEUE >= $QUEUE_BACKLOG_ALERT (attempt $ATTEMPT)"
      ISSUES="$ISSUES chat-supervisor(queue-backlog=$CHAT_QUEUE)"
      if incident_should_alert "chat-queue-backlog"; then
        notify "⚠️ Chat queue backlog: ${CHAT_QUEUE} tasks queued — phone-channel reply loop isn't draining."
      fi
    elif [ "$CHAT_QUEUE" -ge "$QUEUE_BACKLOG_WARN" ]; then
      log "Chat queue elevated: queueDepth=$CHAT_QUEUE (warn=$QUEUE_BACKLOG_WARN, alert=$QUEUE_BACKLOG_ALERT)"
    else
      incident_clear "chat-queue-backlog"
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
# The instance's Supabase project (EDVA_SUPABASE_PROJECT). With none
# configured SUPABASE_KEY stays empty, which skips every Supabase check below.
SUPABASE_URL="${EDVA_SUPABASE_PROJECT:+https://$EDVA_SUPABASE_PROJECT.supabase.co}"
SUPABASE_KEY=""
[ -n "$SUPABASE_URL" ] && SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$HOME/Dev/edva/.env" 2>/dev/null | cut -d= -f2-)
STALE_MSG_THRESHOLD=180  # 3 minutes

CUTOFF=$(date -u -v-${STALE_MSG_THRESHOLD}S '+%Y-%m-%dT%H:%M:%S+00:00' 2>/dev/null || date -u -d "${STALE_MSG_THRESHOLD} seconds ago" '+%Y-%m-%dT%H:%M:%S+00:00' 2>/dev/null)
if [ -n "$CUTOFF" ] && [ -n "$SUPABASE_URL" ]; then
  STALE_MSGS=$(curl -sf --max-time 5 \
    "${SUPABASE_URL}/rest/v1/edva_messages?role=eq.user&read=eq.false&created_at=lt.${CUTOFF}&order=created_at.asc&limit=5" \
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
                content: "RECOVERED MESSAGE (was stuck):\n\nNew message from " + (process.env.EDVA_OWNER_NAME || "the user") + ":\n\n" + m.content,
                source: "edva",
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

# --- Cloudflare Tunnel (Gmail-push ingress) health ---
# Gmail Pub/Sub + the CF Email Worker reach the ops-supervisor :9090 through a
# Cloudflare Tunnel ($CLOUDFLARED_HOST → localhost:9090), managed by its own
# launchd agent (com.cloudflare.cloudflared), NOT by process-manager. If the
# tunnel drops, inbound Gmail pushes and inbound email to Edva's address stop
# arriving while the rest of Edva looks healthy. Self-heal = kickstart the
# launchd agent; alert only if it doesn't recover by the next tick (parity with
# every other incident, per the heal-then-alert policy). The probe is
# the concrete liveness check that gates the page.
if ! cloudflared_tunnel_probe; then
  if ! host_network_reachable; then
    # No outbound network at all, so the probe's 000 says nothing about the
    # tunnel. Deliberately neither incident_seen nor incident_clear (the same
    # reasoning the gh-auth block below spells out): an unreachable host is not
    # evidence the tunnel is down, so it must not accumulate toward the 2-tick
    # page, and not evidence it is up, so it must not clear an incident already
    # in progress. The counter simply holds and resumes when the network is back.
    #
    # The kickstart is skipped for the same reason: restarting cloudflared
    # during a partition tears down a healthy
    # established tunnel that then has to re-register once the network returns,
    # lengthening the outage it was meant to shorten.
    ISSUES="$ISSUES cloudflared-tunnel(host-offline)"
    log "Cloudflare Tunnel ($CLOUDFLARED_HOST) unreachable, but no control vendor is reachable either — this host has no outbound network; holding the counter, no kickstart, no page"
  else
    ATTEMPT=$(incident_seen "cloudflared-tunnel")
    log "Cloudflare Tunnel ($CLOUDFLARED_HOST) unreachable (attempt $ATTEMPT) — Gmail push + inbound email ingress is down [$TUNNEL_PROBE_EVIDENCE]"
    ISSUES="$ISSUES cloudflared-tunnel(down)"

    # Self-heal: kickstart the launchd agent at most once per 10 min.
    SHOULD_RESTART=1
    if [ -f "$CLOUDFLARED_RESTART_COOLDOWN" ]; then
      COOLDOWN_AGE=$(( $(date +%s) - $(stat -f%m "$CLOUDFLARED_RESTART_COOLDOWN") ))
      [ "$COOLDOWN_AGE" -lt 600 ] && SHOULD_RESTART=0
    fi
    if [ "$SHOULD_RESTART" -eq 1 ]; then
      log "Kickstarting $CLOUDFLARED_LABEL launchd agent"
      launchctl kickstart -k "gui/$UID/$CLOUDFLARED_LABEL" >> "$LOG" 2>&1 || true
      touch "$CLOUDFLARED_RESTART_COOLDOWN"
    fi

    # Alert only if the kickstart didn't bring the tunnel back by the next tick.
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "cloudflared-tunnel"; then
      notify "🔴 Cloudflare Tunnel ($CLOUDFLARED_HOST) is down and didn't recover after launchctl kickstart ($ATTEMPT consecutive ticks): $TUNNEL_PROBE_EVIDENCE. While it is down, Gmail pushes and inbound email to ${EDVA_AGENT_FROM_EMAIL:-the agent address} cannot reach Edva. Manual intervention needed on ${EDVA_HOST_LABEL:-the host}: launchctl kickstart -k gui/\$(id -u)/$CLOUDFLARED_LABEL"
    fi
  fi
else
  # Up by the probe's verdict, but the public URL may still have failed from
  # here. A 000 with cloudflared reporting live connections is this host unable
  # to reach its own public hostname (pushes can still be arriving through
  # the tunnel in the same seconds), so it is logged with curl's timings for
  # attribution and never counted, kickstarted or paged. Sustained push loss is
  # watched separately by the PUSH_GAP_MS arm.
  if [ "$TUNNEL_HAIRPIN_ONLY" = "1" ]; then
    log_throttled "$HOME/Dev/edva/data/.watchdog-tunnel-hairpin-log" \
      "Cloudflare Tunnel ($CLOUDFLARED_HOST): this host could not reach its own public hostname, but cloudflared holds live connections, so the tunnel is up; not counted, no kickstart, no page [$TUNNEL_PROBE_EVIDENCE]"
  elif [ -n "$TUNNEL_PROBE_EVIDENCE" ]; then
    log_throttled "$HOME/Dev/edva/data/.watchdog-tunnel-non2xx-log" \
      "Cloudflare Tunnel ($CLOUDFLARED_HOST): tunnel up, but the public URL did not answer 2xx [$TUNNEL_PROBE_EVIDENCE]"
  fi
  incident_clear "cloudflared-tunnel"
  rm -f "$CLOUDFLARED_RESTART_COOLDOWN" 2>/dev/null
fi

# --- Gmail unread sweep (catches silently-missed triage) ---
# Periodically query Gmail for unread inbox messages older than 5 min that
# do NOT already have the `p1` label (P1 triage intentionally leaves emails
# unread — see ops-agent/CLAUDE.md Step 5). Anything that old without a p1
# label should have been triaged by now. If not, the push arrived but the
# agent silently dropped the classification. Dispatch a RECLASSIFY task for
# each stuck message. (The `-label:p1` exclusion lives in
# `gmail-action list-unread-older`'s query — without it the watchdog
# dispatches RECLASSIFY for every legit-unread P1 every tick forever.)
STUCK_EMAILS=$("$HOME/Dev/edva/bin/gmail-action" list-unread-older 5 2>/dev/null || echo "[]")
STUCK_COUNT=$(echo "$STUCK_EMAILS" | jq 'length' 2>/dev/null || echo 0)
STUCK_COUNT=${STUCK_COUNT:-0}
# The ops dispatcher's usage-limit hold (/health rateLimitHoldUntil: an ISO time
# while supervisor/index.mjs holds the queue for a used-up Claude allowance,
# null otherwise). Empty when $HEALTH is empty or unparseable (supervisor
# unreachable), which leaves the sweep exactly as it was. The chat arm above
# honours the same field for chat.
OPS_HOLD_UNTIL=$(echo "$HEALTH" | jq -r '.rateLimitHoldUntil // empty' 2>/dev/null)
if [ "$STUCK_COUNT" -gt 0 ] && [ -n "$OPS_HOLD_UNTIL" ]; then
  # Held for the usage limit. The ops webhook still accepts a RECLASSIFY
  # POST (it is queued), so without this arm every tick counted a "delivered"
  # round the triage agent never saw and, two ticks on, paged "🔴 Email triage
  # sweep: N stuck message(s) still in inbox after M delivered RECLASSIFY
  # rounds. Manual triage needed." while nothing on ops could run, and kept
  # re-posting the same tasks into the frozen queue. Rounds delivered into a
  # held queue are not evidence about the triage agent, and the queued triage
  # runs when the hold lifts; the hold has its own alert from the supervisor.
  # So: no RECLASSIFY dispatch, no change to the landed-rounds file, no page,
  # and deliberately neither incident_seen nor incident_clear (the same
  # reasoning as the tunnel's host-offline arm): a held queue is not evidence
  # that triage is dropping mail, so it must not accumulate toward the 2-tick
  # page, and not evidence that the inbox is draining, so it must not clear an
  # incident already in progress. The counter simply holds and resumes when
  # the hold lifts.
  # DO NOT "tidy" this branch into symmetry with the one below.
  ISSUES="$ISSUES gmail-unread-stuck(${STUCK_COUNT},usage-hold)"
  log_throttled "$EDVA_INSTALL_TOOLS/data/.watchdog-stuck-sweep-hold-log" \
    "Gmail unread sweep: $STUCK_COUNT message(s) waiting, but the ops dispatcher is holding for the Claude usage limit until $OPS_HOLD_UNTIL; no RECLASSIFY dispatch, not counted, no page"
elif [ "$STUCK_COUNT" -gt 0 ]; then
  ATTEMPT=$(incident_seen "gmail-unread-stuck")
  log "Gmail unread sweep: $STUCK_COUNT message(s) older than 5min not yet triaged (attempt $ATTEMPT)"
  ISSUES="$ISSUES gmail-unread-stuck(${STUCK_COUNT})"

  # Per-tick back-off during active Pub/Sub outage. When the
  # push pipeline itself is broken (`lastPushAgeMs > PUSH_GAP_MS`), N
  # RECLASSIFY dispatches every 2-min tick is the wrong shape — the agent
  # isn't dropping anything, the delivery is the failure. Throttle to one
  # batched sweep per STUCK_SWEEP_BACKOFF_MIN minutes; the alert below still
  # fires on the right cadence via `incident_should_alert`.
  STUCK_SWEEP_BACKOFF_MIN=30
  STUCK_BACKOFF_MARKER="$HOME/Dev/edva/data/.watchdog-stuck-sweep-backoff"
  GAP_FOR_BACKOFF=$(echo "$HEALTH" | jq -r '.lastPushAgeMs // 0' 2>/dev/null)
  SKIP_DISPATCH=0
  if [ -n "$GAP_FOR_BACKOFF" ] && [ "$GAP_FOR_BACKOFF" -gt "$PUSH_GAP_MS" ]; then
    if [ -f "$STUCK_BACKOFF_MARKER" ]; then
      MARK_AGE=$(( $(date +%s) - $(stat -f%m "$STUCK_BACKOFF_MARKER") ))
      if [ "$MARK_AGE" -lt $((STUCK_SWEEP_BACKOFF_MIN * 60)) ]; then
        log "  Pub/Sub outage active (${GAP_FOR_BACKOFF}ms gap) — skipping RECLASSIFY dispatch ($MARK_AGE s into ${STUCK_SWEEP_BACKOFF_MIN}-min back-off)"
        SKIP_DISPATCH=1
      fi
    fi
  else
    # Clear the marker when push gap is back to normal so the next outage
    # gets a fresh back-off window.
    [ -f "$STUCK_BACKOFF_MARKER" ] && rm -f "$STUCK_BACKOFF_MARKER" 2>/dev/null
  fi

  # Dispatch accounting. `curl -sf ... > /dev/null 2>&1` throws away the exit
  # status, so a POST that never reached the ops supervisor would still log
  # "Dispatched RECLASSIFY" and count toward the "N RECLASSIFY rounds" the alert
  # below cites as evidence — e.g. while the webhook at :9092 is down, which
  # produces a false "manual triage needed" page. Count only rounds that
  # actually landed.
  STUCK_ROUNDS_FILE="$INCIDENT_DIR/gmail-unread-stuck.landed_rounds"
  LANDED_ROUNDS=0
  if [ -f "$STUCK_ROUNDS_FILE" ]; then
    LANDED_ROUNDS=$(cat "$STUCK_ROUNDS_FILE" 2>/dev/null || echo 0)
    [[ "$LANDED_ROUNDS" =~ ^[0-9]+$ ]] || LANDED_ROUNDS=0
  fi
  DISPATCH_OK=0
  DISPATCH_FAIL=0

  if [ "$SKIP_DISPATCH" -eq 0 ]; then
    # Self-heal: dispatch RECLASSIFY for each stuck message every tick (or
    # every STUCK_SWEEP_BACKOFF_MIN min during active Pub/Sub outage).
    # Here-string, not a pipe: `... | while read` runs the loop in a subshell,
    # which would discard the DISPATCH_OK/DISPATCH_FAIL tallies.
    while read -r MSGID; do
      [ -z "$MSGID" ] && continue
      if curl -sf --max-time 5 -X POST "http://localhost:9092" \
        -H "Content-Type: application/json" "${CURL_AUTH[@]}" \
        -d "{\"task\": \"RECLASSIFY: $MSGID\"}" > /dev/null 2>&1; then
        DISPATCH_OK=$((DISPATCH_OK + 1))
        log "  Dispatched RECLASSIFY for $MSGID"
      else
        DISPATCH_FAIL=$((DISPATCH_FAIL + 1))
        log "  RECLASSIFY dispatch FAILED for $MSGID — ops webhook :9092 unreachable or rejected"
      fi
    done <<< "$(echo "$STUCK_EMAILS" | jq -r '.[].id' 2>/dev/null)"
    if [ "$DISPATCH_OK" -gt 0 ]; then
      LANDED_ROUNDS=$((LANDED_ROUNDS + 1))
      echo "$LANDED_ROUNDS" > "$STUCK_ROUNDS_FILE"
    fi
    # Stamp the back-off marker so the next tick within
    # STUCK_SWEEP_BACKOFF_MIN minutes of an active push gap will skip.
    if [ -n "$GAP_FOR_BACKOFF" ] && [ "$GAP_FOR_BACKOFF" -gt "$PUSH_GAP_MS" ]; then
      touch "$STUCK_BACKOFF_MARKER"
    fi
  fi

  # Alert only if RECLASSIFY didn't drain the queue by the next tick.
  # Three distinct causes, three distinct alerts — never blame the triage agent
  # for a failure in the delivery or the dispatch path:
  #   push gap over threshold -> Pub/Sub delivery failure, mail isn't arriving
  #   dispatch didn't land    -> the self-heal never reached the agent (:9092)
  #   otherwise               -> the agent really is dropping classifications
  # `$ATTEMPT` counts ticks this incident has been seen; `$LANDED_ROUNDS`
  # counts RECLASSIFY rounds that were actually delivered. Only the latter is
  # evidence about the agent, so only the latter may be cited as such.
  if [ "$STUCK_COUNT" -ge 3 ] && [ "$ATTEMPT" -ge 2 ] && incident_should_alert "gmail-unread-stuck"; then
    GAP_MS=$(echo "$HEALTH" | jq -r '.lastPushAgeMs // 0' 2>/dev/null)
    if [ -n "$GAP_MS" ] && [ "$GAP_MS" -gt "$PUSH_GAP_MS" ]; then
      notify "🔴 Pub/Sub delivery failure — $STUCK_COUNT unread inbox message(s) not pushed for $((GAP_MS / 60000))+ min, persisting after $LANDED_ROUNDS delivered RECLASSIFY round(s). Watch-renewal already attempted. Manual inspection of Pub/Sub topic + Cloudflare Tunnel ($CLOUDFLARED_HOST) needed."
    elif [ "$DISPATCH_FAIL" -gt 0 ] || [ "$LANDED_ROUNDS" -lt 2 ]; then
      notify "🔴 Email triage sweep: $STUCK_COUNT message(s) stuck in inbox and the RECLASSIFY self-heal is not landing — $DISPATCH_FAIL dispatch(es) to the ops webhook (:9092) failed on this tick, and only $LANDED_ROUNDS round(s) have actually reached the agent. Triage itself may be healthy; the dispatch path is the suspect."
    else
      notify "🔴 Email triage sweep: $STUCK_COUNT stuck message(s) still in inbox after $LANDED_ROUNDS delivered RECLASSIFY rounds. Manual triage needed."
    fi
  fi
else
  incident_clear "gmail-unread-stuck"
  # Counterpart to the landed-rounds counter above: `incident_clear` only knows
  # about its own marker files, so reset ours here or the next unrelated
  # incident inherits a stale round count.
  rm -f "$INCIDENT_DIR/gmail-unread-stuck.landed_rounds" 2>/dev/null
fi

# --- Ollama (local Gemma) health ---
# The local model (gemma3:1b served by Ollama at :11434) is the first rung of
# the language ladder for low-stakes non-agent tasks (lib/local-llm.mjs).
# Phone-channel acks no longer use it (they are canned copy only).
OLLAMA_RESTART_COOLDOWN="$HOME/Dev/edva/data/.ollama-restart-cooldown"
BREW_BIN=/opt/homebrew/bin/brew
if ! curl -sf --max-time 3 http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  ATTEMPT=$(incident_seen "ollama-down")
  log "Ollama unreachable on :11434 (attempt $ATTEMPT) — local-model callers will fall through to their next rung"
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
    notify "🔴 Ollama (local Gemma) is down on :11434 and didn't recover after brew services restart ($ATTEMPT consecutive ticks). Local-model callers are falling through to their next rung. Manual intervention needed."
  fi
else
  incident_clear "ollama-down"
  rm -f "$OLLAMA_RESTART_COOLDOWN" 2>/dev/null
fi

# --- Max-auth keychain self-heal (root cause of the recurring auth flaps) ---
# Edva's Max OAuth token is stored in the login keychain ("Claude Code-
# credentials" generic-password item). The host can ALSO be a self-hosted iOS-
# signing CI runner for several repos (Edva's TestFlight and others),
# and some of those builds run `security default-keychain -s <build-keychain>` +
# `security list-keychains -s <build-keychain>` WITHOUT the flock-serialized,
# prepend-and-restore discipline edva-testflight.yml uses. Their residue:
# login.keychain-db drops out of the user search list and the default keychain
# is left pointing at a since-deleted build keychain ("A default keychain could
# not be found"). While login is out of the search list EVERY `claude -p`
# returns "Not logged in" and the whole backend stalls, flapping down /
# "recovered" / down tick after tick.
# Re-adding login.keychain-db to the user search list is a pure user-domain
# plist write: no keychain password, so cron (non-GUI) can do it, and it does
# NOT disturb an in-flight signing build (codesign is passed an explicit
# --keychain). This converts the #1 auth-outage cause from a page-the-human
# incident into a silent heal. Durable belt-and-suspenders alongside fixing the
# CI teardowns (edva-macos.yml takes the shared mutex and rebuilds the
# search list; both workflows guard the empty-list case). NOTE: "move the token
# to ~/.claude/.credentials.json" is NOT a fix and must not be introduced — the
# client resolves credentials keychain-FIRST, so a file copy
# is never read while the keychain is healthy and rots into a superseded
# refresh token that resurfaces as `401 ... revoked`.
KEYCHAIN_HEALED=0
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
# Guard against fighting a LIVE signing build. Some repos' ios-testflight.yml
# intentionally makes its temp keychain the ONLY user keychain during signing
# (to dodge errSecInternalComponent from duplicate identities in login), then
# restores login in its always() teardown. Re-adding login mid-build would
# reintroduce exactly the failure it isolates against. So only heal RESIDUE —
# login missing while NO signing build is running (i.e. a build ended without
# restoring, e.g. a teardown bug). A running `xcodebuild` is the "build
# in progress" signal; when one is live we leave the search list untouched and
# let that job's own teardown put login back.
SIGNING_BUILD_ACTIVE=0
# Any live signing build owns the user search list: a running xcodebuild/codesign,
# or ANY active self-hosted Actions job (Runner.Worker exists only for a job's
# lifetime — the host's several Runner.Listeners idle between jobs and don't count), whose
# workflow may have legitimately just added its temp app-signing keychain and not
# yet reached its teardown. When one is live we leave the list untouched and let
# that job's own teardown clean up; we only ever touch RESIDUE — the list state
# left after every build has ended.
if pgrep -x xcodebuild >/dev/null 2>&1 || pgrep -x codesign >/dev/null 2>&1 \
   || pgrep -f 'Runner\.Worker' >/dev/null 2>&1; then
  SIGNING_BUILD_ACTIVE=1
fi
if [ -f "$LOGIN_KEYCHAIN" ] && [ "$SIGNING_BUILD_ACTIVE" = "0" ]; then
  CUR_KC_LIST=$(security list-keychains -d user 2>/dev/null | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
  # Rebuild the DESIRED user search list: login first, then every OTHER entry
  # that is a real, PERSISTENT keychain — one living in a standard keychain
  # directory ($HOME/Library/Keychains or /Library/Keychains). Everything else
  # in the list is CI signing residue and gets pruned:
  #   1. A transient build keychain the workflow created in RUNNER_TEMP
  #      (~/actions-runner-*/_work/_temp) or /var/folders and added to the GLOBAL
  #      user list — app-signing.keychain-db, build.keychain-db, whatever each
  #      repo names it — that a cancelled/killed job never removed. While one
  #      lingers, locked with its random password long gone, GUI apps that walk
  #      the search list pop "<App> wants to use the … keychain. Enter the
  #      keychain password." for a keychain nobody can unlock. A GUI app that
  #      reads its own OAuth item constantly is the usual one in that dialog
  #      (a recurring keychain prompt).
  #   2. Dangling entries whose keychain file is already gone (delete-keychain
  #      residue / OS-reaped RUNNER_TEMP) — a stale reference that also prompts.
  # Matching by LOCATION (not by name) means it catches every runner's build
  # keychain regardless of what that repo's workflow calls it, including the
  # external repos we don't control. Safe because the host keeps no persistent
  # keychain outside the standard dirs. Runs every tick (2 min), so residue from
  # any workflow clears within one tick of the build ending.
  declare -a KC_NEW=("$LOGIN_KEYCHAIN")
  KC_DROPPED=""
  while IFS= read -r _k; do
    [ -n "$_k" ] || continue
    [ "$_k" = "$LOGIN_KEYCHAIN" ] && continue
    case "$_k" in
      "$HOME/Library/Keychains/"*|/Library/Keychains/*)
        # standard location — keep it, unless the file is gone (dangling ref)
        if [ ! -f "$_k" ]; then KC_DROPPED="$KC_DROPPED $(basename "$_k")(missing)"; continue; fi
        KC_NEW+=("$_k") ;;
      *)
        # outside the standard keychain dirs ⇒ a CI build keychain — prune it
        KC_DROPPED="$KC_DROPPED $(basename "$_k")(ci-temp)"; continue ;;
    esac
  done <<< "$CUR_KC_LIST"
  # Rewrite only when the desired list differs from the current one (login not
  # first, or residue present) — no per-tick `security` write on the happy path.
  CUR_JOINED=$(printf '%s\n' "$CUR_KC_LIST" | grep -v '^[[:space:]]*$')
  NEW_JOINED=$(printf '%s\n' "${KC_NEW[@]}")
  if [ "$CUR_JOINED" != "$NEW_JOINED" ]; then
    if security list-keychains -d user -s "${KC_NEW[@]}" 2>/dev/null; then
      if [ -n "$KC_DROPPED" ]; then
        log "Keychain self-heal: pruned CI signing residue from the user search list —$KC_DROPPED (source of a recurring GUI-app 'app-signing' keychain prompt)"
      else
        log "Keychain self-heal: re-added login.keychain-db to the user search list (evicted by a CI signing build)"
      fi
      KEYCHAIN_HEALED=1
    else
      log "Keychain self-heal: FAILED to rewrite the user search list"
    fi
  fi
  # Restore the default keychain only when it is unreadable (the deleted-build-
  # keychain residue). If a build has legitimately set its own default, leave it
  # — the search-list fix above is all `claude -p` needs to find the token.
  if ! security default-keychain -d user >/dev/null 2>&1; then
    if security default-keychain -d user -s "$LOGIN_KEYCHAIN" 2>/dev/null; then
      log "Keychain self-heal: restored login.keychain-db as the default keychain (left unset by a CI teardown)"
      KEYCHAIN_HEALED=1
    fi
  fi
fi
[ "$KEYCHAIN_HEALED" = "1" ] && ISSUES="$ISSUES keychain(healed)"

# --- Poisoned credentials file self-heal ------------------------------------
# The client resolves credentials keychain-FIRST (`combine(keychain, plaintext)`;
# the plaintext file is read only when the keychain read returns null), so an
# empty or key-less file does NOT override a healthy keychain, and quarantining
# it does not by itself restore auth: "Not logged in" comes from an unreadable
# keychain, and the useless file is a symptom next to that cause.
#
# The block is kept because the action is still correct and cheap: a file that
# can never supply credentials has no reason to exist, and removing it prevents
# the far worse divergence case (a *populated* stale file serving a superseded
# refresh token once the keychain comes back, failing with `401 revoked`).
# Just don't read a quarantine here as "auth is fixed now".
#
# Known ways an empty file appears: `security find-generic-password -w > file`
# when the keychain read fails (the shell's `>` has already truncated the file),
# and a cancelled `claude /login` that leaves `{}` behind. Never copy the token
# into a file to "fix" auth — that is the divergence cause.
#
# The failure is one file operation away from being self-healing, so heal it:
# quarantine the useless file and let the keychain take over again. Deliberately
# conservative — a file with ANY top-level key is left strictly alone, because
# only the empty case is unambiguously worthless. Pure file I/O, no keychain
# read, so it is safe from cron (non-GUI). The contents are NEVER read into a
# variable or logged: a prior helper that "redacted" this file leaked a live
# access token, a refresh token and a client secret into a transcript, which
# then had to be rotated. A byte count and a key count are all that is needed.
CREDS_FILE="$HOME/.claude/.credentials.json"
if [ -f "$CREDS_FILE" ]; then
  CREDS_EMPTY=0
  if [ ! -s "$CREDS_FILE" ]; then
    CREDS_EMPTY=1
  else
    # 0 = has keys / unparseable-but-non-empty (leave alone), 1 = empty object.
    python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1]))
    sys.exit(1 if isinstance(d,dict) and not d else 0)
except Exception:
    sys.exit(0)' "$CREDS_FILE" 2>/dev/null || CREDS_EMPTY=1
  fi
  if [ "$CREDS_EMPTY" = "1" ]; then
    CREDS_BAK="$CREDS_FILE.poisoned-$(date +%Y%m%d-%H%M%S)"
    if mv "$CREDS_FILE" "$CREDS_BAK" 2>/dev/null; then
      log "Creds self-heal: quarantined an EMPTY ~/.claude/.credentials.json (can never supply creds; removing it prevents a stale fallback diverging from the keychain) → $(basename "$CREDS_BAK"). NOTE: resolution is keychain-FIRST, so if auth is still down the keychain itself is unreadable — check the search list + default keychain"
      ISSUES="$ISSUES creds(poisoned-file-quarantined)"
      KEYCHAIN_HEALED=1   # reuse the one-tick page deferral — this IS the fix
    else
      log "Creds self-heal: FAILED to quarantine the empty credentials file"
    fi
  fi
fi

# --- Populated plaintext credentials file ------------------------------------
# The block above heals only an EMPTY file and deliberately leaves a populated
# one "strictly alone" -- so without this check nobody is told about it. A
# populated file is the more dangerous case: CLAUDE.md § Auth Model forbids
# ~/.claude/.credentials.json on this host because the keychain copy is updated
# on every token refresh and this one is not, so within hours it holds a
# superseded refresh token -- served the moment the keychain is briefly
# unreadable (`401 OAuth access token has been revoked`). Such a file is easy to
# write by hand while recovering from a Max auth outage.
#
# Warn, never remove: this runs from cron, which cannot read the keychain, so it
# cannot tell whether the file happens to be the only working credential right
# now. Once a day at most, until a human strips it out.
#
# `[ -s "$CREDS_FILE" ]` is not a test for a Max credential at all. Claude Code
# keeps TWO unrelated things in this one file: `claudeAiOauth` (the Max login
# this rule is about) and `mcpOAuth` (the OAuth grants for every connected MCP
# server). The Max half can be empty ({accessToken:"", refreshToken:"",
# expiresAt:0}) while the file holds live MCP grants; paging on the file would
# be a daily false alarm, and its remedy (`mv` the whole file aside) would
# destroy every connector sign-in in one command.
#
# NOTE for whoever reads CLAUDE.md next: § Auth Model says "do not create
# ~/.claude/.credentials.json on this host", full stop. That is right about the
# Max token and wrong about the file -- Claude Code writes it for MCP grants
# whether we like it or not. Judge the `claudeAiOauth` key, never the file.
#
# Do NOT decide this with the emptiness probe in the block above: that one tests
# whether the WHOLE file is `{}`, so it reads this file as populated too and
# reproduces the identical false positive. The Max keys have to be tested by
# name -- and by several names, so that a future rename shows up as rc=3 rather
# than as silence.
#
# The incident key is creds-plaintext-max-token, not the older creds-plaintext,
# deliberately: an old key's .alerted/.delivered pair left on disk would make
# the first tick send a false "Recovered: the plaintext credentials file is
# gone". Stale creds-plaintext.* markers under data/watchdog-incidents/
# are inert and can be deleted by hand whenever.
#
# Contents are still NEVER read into a variable or logged (same rule as the
# block above, same reason -- a prior helper leaked a live token into a
# transcript). The probe speaks only through its exit status:
#   0 = a Max access/refresh token really is sitting in there   -> page
#   1 = it is not (no claudeAiOauth, or every token field empty) -> clear
#   2 = unreadable / unparseable                                 -> log only
#   3 = claudeAiOauth present in a shape this probe does not know -> log only
#   * = the probe itself could not run                           -> log only
# Anything other than 0 or 1 means "cannot tell", and cannot-tell must neither
# page (the remedy edits a credential file) nor clear (clearing is itself a
# claim). utf-8-sig, because a BOM'd file holding a REAL token used to land in
# the unparseable bucket and go unreported.
if [ -s "$CREDS_FILE" ]; then
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8-sig"))
except Exception:
    sys.exit(2)
o = d.get("claudeAiOauth") if isinstance(d, dict) else None
if o is None:
    sys.exit(1)
if not isinstance(o, dict):
    sys.exit(3)
seen = [k for k in ("accessToken", "access_token", "refreshToken", "refresh_token") if k in o]
if not seen:
    sys.exit(3)
known_shape = False
for k in seen:
    v = o.get(k)
    if isinstance(v, str):
        known_shape = True
        if v.strip():
            sys.exit(0)
    elif isinstance(v, dict):
        known_shape = True
        if any(isinstance(x, str) and x.strip() for x in v.values()):
            sys.exit(0)
sys.exit(1 if known_shape else 3)' "$CREDS_FILE" 2>/dev/null
  CREDS_MAX_RC=$?
else
  CREDS_MAX_RC=1
fi

case "$CREDS_MAX_RC" in
  0)
    ISSUES="$ISSUES creds(plaintext-max-token)"
    if incident_should_alert "creds-plaintext-max-token" 86400 1 86400; then
      # kernel-closure-ok: names the remedy in a log line, not a call
      log "Creds: ~/.claude/.credentials.json holds a POPULATED claudeAiOauth block -- a second Max credential store the keychain refresh does not keep current (Auth Model forbids it). Paging once; never auto-removed from cron. The remedy must delete ONLY that key -- the same file also holds the mcpOAuth connector grants -- which is what bin/creds-strip-max-login does."
      notify "⚠️ There's a plaintext copy of the Max login sitting inside ~/.claude/.credentials.json on this host. It isn't refreshed alongside the keychain, so it goes stale within hours, and a stale copy has taken auth down before. Nothing is broken right now. When you're next at this machine, run \`creds-strip-max-login\` — it backs the file up and takes out just the login, because that same file also holds the sign-ins for all your MCP connectors and moving the whole thing aside would log you out of every one of them."
    fi
    ;;
  1)
    # No Max token in the file. The file itself is very likely still there and
    # perfectly legitimate -- it is where Claude Code keeps the mcpOAuth
    # connector grants -- so this is the normal, quiet state, not a recovery.
    incident_clear "creds-plaintext-max-token"
    ;;
  2|3)
    # 2 = unreadable/unparseable, 3 = a claudeAiOauth block in a shape this
    # probe does not recognise (renamed keys, a new nesting). Neither is a
    # licence to claim anything: do NOT page (the remedy edits the file) and do
    # NOT clear (clearing asserts there is no Max login in there, which is
    # exactly what we could not determine). Logged so the drift is visible --
    # if Claude Code ever moves where it stores the token, this check going
    # dark forever would otherwise be silent.
    ISSUES="$ISSUES creds(shape-unknown)"
    log_throttled "$HOME/Dev/edva/data/.watchdog-creds-shape-unknown" "Creds: ~/.claude/.credentials.json is present but its claudeAiOauth block could not be read (probe rc=$CREDS_MAX_RC: 2=unparseable, 3=unrecognised key name or token shape) -- neither paging nor clearing, because this cannot tell either way." 3600
    ;;
  *)
    # The probe itself failed (no python3 on cron's PATH, interpreter error).
    # Same posture as above, and deliberately NOT the else-branch: a broken
    # check must never read as a clean bill of health.
    ISSUES="$ISSUES creds(probe-failed)"
    log_throttled "$HOME/Dev/edva/data/.watchdog-creds-probe-failed" "Creds: the plaintext-credentials probe failed to run (rc=$CREDS_MAX_RC) -- not paging and not clearing." 3600
    ;;
esac

# --- Max auth outage (now mostly self-healing via the keychain block above) ---
# Both agents run EXCLUSIVELY on the Max subscription (CLAUDE.md § Auth Model);
# there is NO API-key fallback by design. When the Max OAuth token is
# unreachable, every `claude -p` child fails instantly with "AUTH ERROR ... Not
# logged in" ($0, turns=1) and the ENTIRE backend — triage, hum, watchers, the
# self-improvement executor — stalls. The dominant cause (keychain evicted by a
# CI build) is now auto-healed above, and the supervisors' own 60s auth-watchers
# recover within a tick. We still PAGE when a fresh AUTH ERROR persists AFTER a
# heal, because the residual causes (creds genuinely revoked/expired, keychain
# password-locked, no creds at all) need a human /login. Detect via an AUTH
# ERROR line that is BOTH newer than any "auth restored" line in the same log
# AND within the last ~6 min (covering the 2-5 min tick cadence); without this
# an outage can sit undetected until a manual re-login.

# The sign-in clock, read by § Max sign-in renewal heads-up further down.
# The Max login's OAuth session runs out some weeks after each manual sign-in,
# and only a new `claude /login` resets it. Nothing this host can read says
# when: `claude auth status --json` has no expiry field, and the keychain item's
# dates move on every token refresh, not on a sign-in. So the clock records the
# last sign-in watchdog can infer: the close of an auth outage it paged, in
# which the launchd check read signed out (an expired login does; a supervisor
# auth error while the login still reads signed in is something else) and the
# keychain self-heal above did not run (a keychain eviction reads signed out
# too, and the heal, not a sign-in, ends it). One JSON line, machine structure only:
#   {"relogin_ts":<epoch>,"note_ts":<epoch of the last heads-up, 0 = none>,"source":"<what set relogin_ts>"}
# Written only by watchdog.sh, best effort: a missing or broken file costs a
# heads-up, never a tick. Lives in the installation's data dir (root.sh, via
# lib/webhook-auth.sh); prints nothing when neither that nor an override is set.
_max_auth_relogin_file() {
  if [ -n "${MAX_AUTH_RELOGIN_FILE:-}" ]; then printf '%s' "$MAX_AUTH_RELOGIN_FILE"
  elif [ -n "${EDVA_INSTALL_TOOLS:-}" ]; then printf '%s' "$EDVA_INSTALL_TOOLS/data/max-auth-relogin.json"
  fi
}

# _max_auth_relogin_write <relogin_ts> <note_ts> <source>
_max_auth_relogin_write() {
  local f tmp
  f=$(_max_auth_relogin_file)
  [ -n "$f" ] || return 0
  tmp="$f.tmp.$$"
  if printf '{"relogin_ts":%s,"note_ts":%s,"source":"%s"}\n' "$1" "$2" "$3" 2>/dev/null > "$tmp"; then
    mv -f "$tmp" "$f" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

# max_auth_relogin_mark <outage_start_epoch> — run once, as a paged auth outage
# closes. Restarts the clock now if this outage was a lapsed sign-in (see above),
# else leaves it. A missed restart only makes the next heads-up early, which is
# the safe side; a wrong restart would make it late.
max_auth_relogin_mark() {
  local start="${1:-}" now out healed
  now=$(date +%s)
  [[ "$start" =~ ^[0-9]+$ ]] || start="$now"
  out=$(stat -f%m "$INCIDENT_DIR/auth-outage.signed_out" 2>/dev/null || echo 0)
  healed=$(stat -f%m "$INCIDENT_DIR/auth-outage.keychain_healed" 2>/dev/null || echo 0)
  [[ "$out" =~ ^[0-9]+$ ]] || out=0
  [[ "$healed" =~ ^[0-9]+$ ]] || healed=0
  rm -f "$INCIDENT_DIR/auth-outage.signed_out" 2>/dev/null
  [ -n "$(_max_auth_relogin_file)" ] || return 0
  if [ "$out" -lt $(( start - 3600 )) ]; then
    log "Max sign-in clock: the launchd check never read signed out during this outage, so it was not a lapsed sign-in; clock left as it was"
  elif [ "$healed" -ge $(( start - 3600 )) ]; then
    log "Max sign-in clock: the keychain self-heal ran during this outage, so it, not a new sign-in, ended it; clock left as it was"
  else
    _max_auth_relogin_write "$now" 0 "outage-recovery"
    log "Max sign-in clock: restarted at the close of this auth outage (a lapsed sign-in only ends with a new one)"
  fi
  return 0
}

AUTH_CUTOFF_EPOCH=$(( $(date +%s) - 360 ))
AUTH_HIT=""
# AUTH_OUTAGE_HELD=1 on every branch below that holds the auth-outage incident
# open; 0 only on the final else that clears it. Read by the daily-summary
# block further down: during an
# outage it must not spend its one backfill on a turn certain to fail, nor page
# a second 🔴 for the same root cause this section already pages about.
AUTH_OUTAGE_HELD=0
# AUTH_RECOVERY_PENDING=1 on the clearing branch while the outage's page is
# still on record (auth-outage.alerted) and the 3-green-tick recovery has not
# completed. Auth looks fine again but the incident is not closed, and the
# daily-summary heal is only re-armed when it closes, so that block keeps
# deferring until then: otherwise a heal spent before the outage was seen pages
# 🔴 on the first green tick, two ticks before the re-arm runs the backfill.
AUTH_RECOVERY_PENDING=0
# The launchd sign-in check (lib/max-auth-probe.sh). Fresh = under 20 min old,
# two of live-day's 10-minute checks. Read once and used in the branch below.
max_auth_probe_read "$(date +%s)" 1200
# The raw reading, before the overrides below: a signed-out reading marks this
# outage as a real sign-out for the sign-in clock (max_auth_relogin_mark).
if [ "$MAX_AUTH_PROBE_STATE" = "fail" ]; then touch "$INCIDENT_DIR/auth-outage.signed_out" 2>/dev/null; fi
# log timestamps are UTC (Z); parse under TZ=UTC so the epoch is correct.
_auth_epoch() { local ts="${1%% *}"; ts="${ts%.*}"; TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$ts" +%s 2>/dev/null || echo 0; }
for slog in "$HOME"/Dev/edva/agent/logs/{ops,ops-light,ops-haiku,chat}-supervisor.log; do
  [ -f "$slog" ] || continue
  auth_line=$(grep 'AUTH ERROR' "$slog" 2>/dev/null | tail -1)
  [ -n "$auth_line" ] || continue
  auth_epoch=$(_auth_epoch "$auth_line")
  # Skip if the supervisor already logged a recovery newer than this error —
  # otherwise a just-recovered log would still page for one more tick while the
  # last AUTH ERROR line lingers inside the 6-min window.
  restored_line=$(grep 'auth restored' "$slog" 2>/dev/null | tail -1)
  if [ -n "$restored_line" ] && [ "$(_auth_epoch "$restored_line")" -ge "$auth_epoch" ]; then continue; fi
  if [ "$auth_epoch" -ge "$AUTH_CUTOFF_EPOCH" ]; then AUTH_HIT="$slog"; break; fi
done
# A signed-out reading taken before something that could have fixed it says
# nothing about after it. A supervisor "auth restored" line newer than the
# reading means a turn ran on Max again, so the reading is overruled. A keychain
# self-heal newer than the reading makes it out of date, so the incident is held
# quietly (no page, no ✅) until live-day's next check, at most 10 minutes later.
[ "$KEYCHAIN_HEALED" = "1" ] && touch "$INCIDENT_DIR/auth-outage.keychain_healed" 2>/dev/null
if [ "$MAX_AUTH_PROBE_STATE" = "fail" ]; then
  for slog in "$HOME"/Dev/edva/agent/logs/{ops,ops-light,ops-haiku,chat}-supervisor.log; do
    restored_line=$(grep 'auth restored' "$slog" 2>/dev/null | tail -1)
    if [ -n "$restored_line" ] && [ "$(_auth_epoch "$restored_line")" -gt "$MAX_AUTH_PROBE_TS" ]; then
      MAX_AUTH_PROBE_STATE=restored; break
    fi
  done
fi
if [ "$MAX_AUTH_PROBE_STATE" = "fail" ] && [ -f "$INCIDENT_DIR/auth-outage.keychain_healed" ] \
   && [ "$(stat -f%m "$INCIDENT_DIR/auth-outage.keychain_healed" 2>/dev/null || echo 0)" -ge "$MAX_AUTH_PROBE_TS" ]; then
  MAX_AUTH_PROBE_STATE=pre-heal
fi
if [ -n "$AUTH_HIT" ]; then
  log "Max auth outage: recent 'AUTH ERROR / Not logged in' in $(basename "$AUTH_HIT") — backend stalled"
  ISSUES="$ISSUES auth(not-logged-in)"
  AUTH_OUTAGE_HELD=1   # held through the keychain-healed deferral too
  if [ "$KEYCHAIN_HEALED" = "1" ]; then
    # Just re-added login to the search list this tick — give the supervisors'
    # own auth-watchers a tick to recover before paging.
    log "Max auth outage: keychain self-healed this tick — deferring the page one tick to let the supervisors' auth-watchers recover"
  # Re-page every 30 min (the user must act), cap 4 in 6h.
  elif incident_should_alert "auth-outage" 1800 4 21600; then
    # Quote the actual captured AUTH ERROR line instead of always asserting
    # "Not logged in" — that's one real cause (keychain evicted by a CI
    # signing build, handled above) but the supervisor's own error text also
    # includes "OAuth session expired and could not be refreshed" (a refresh
    # failure, no keychain issue at all), which a fixed wording would
    # misdiagnose. Mirrors supervisor/index.mjs's own outage page.
    auth_err_text=$(grep 'AUTH ERROR' "$AUTH_HIT" 2>/dev/null | tail -1 | sed -E 's/^.*AUTH ERROR #[0-9]+: //' | cut -c1-200)
    [ -n "$auth_err_text" ] || auth_err_text="(no error text captured)"
    notify "🔴 Max auth is DOWN on $(basename "$AUTH_HIT" | sed 's/-supervisor\.log//'). Captured error: \"$auth_err_text\". If it mentions a keychain, check \`security default-keychain\` + \`security list-keychains\`; otherwise it's likely just expired/invalid creds needing a plain re-login. Either way: \`claude /login\` on ${EDVA_HOST_LABEL:-the host}. No API-key fallback exists by design."
  fi
else
  # The log-recency probe above goes BLIND during a sustained outage. Once a
  # supervisor crosses AUTH_FAIL_THRESHOLD it kills its child and pauses the
  # dispatcher, so it stops invoking `claude -p` and therefore stops writing
  # AUTH ERROR lines at all — the log falls silent while the outage is still
  # fully live, and the branch below reads that silence as health.
  #
  # Without this guard, a sustained outage reads as "✅ Recovered: Max auth"
  # while every ops supervisor sits paused (childAlive=false /
  # dispatcherPaused=true / authAlertSent=true) for hours. CLAUDE.md § Auth
  # Model is explicit that when Max is down the user must SEE it and act; a
  # green check is the opposite of that.
  #
  # The supervisors' own /health carried the truth throughout: authAlertSent
  # is set in _triggerAuthOutage() and cleared only on real restoration
  # (supervisor/index.mjs:924, :994). Ask them before declaring recovery.
  # Fail OPEN — an unreachable port, a missing field or unparseable JSON never
  # holds the incident open (chat-supervisor.mjs does not expose the field at
  # all). Only an affirmative authAlertSent=true keeps it live.
  AUTH_STILL_PAUSED=""
  for _auth_agent in ops ops-light ops-haiku; do
    _auth_port=$( eval "$("$CONFIG_DIR/load-agent.sh" "$_auth_agent" 2>/dev/null)" >/dev/null 2>&1; echo "$AGENT_SUPERVISOR_HEALTH_PORT" )
    [ -n "$_auth_port" ] || continue
    _auth_health=$(curl -sf --max-time 3 "http://127.0.0.1:$_auth_port/health" 2>/dev/null)
    [ -n "$_auth_health" ] || continue
    if [ "$(echo "$_auth_health" | jq -r 'if .authAlertSent == true then "1" else "0" end' 2>/dev/null)" = "1" ]; then
      AUTH_STILL_PAUSED="$AUTH_STILL_PAUSED $_auth_agent"
    fi
  done
  if [ -n "$AUTH_STILL_PAUSED" ]; then
    log "Max auth outage: no fresh AUTH ERROR line, but$AUTH_STILL_PAUSED still report authAlertSent=true — holding the incident open (a paused supervisor writes no AUTH ERROR lines, so log silence is not recovery)"
    ISSUES="$ISSUES auth(paused-no-log)"
    AUTH_OUTAGE_HELD=1
    # Same cadence as the fresh-error page above: every 30 min, cap 4 in 6h.
    if incident_should_alert "auth-outage" 1800 4 21600; then
      notify "🔴 Max auth is STILL down on$AUTH_STILL_PAUSED. The supervisor(s) killed the child and paused dispatch, so there is nothing new in the logs — quiet does not mean recovered here. Anything queued behind this is not being worked. Run \`claude /login\` on ${EDVA_HOST_LABEL:-the host}; there is no API-key fallback by design."
    fi
  elif [ "$MAX_AUTH_PROBE_STATE" = "fail" ]; then
    # The authAlertSent guard above only engages once a supervisor has failed 3
    # turns in a row. In a quiet period a supervisor may log a single AUTH ERROR
    # and then run no turn for hours; that line ages out of the 6-minute window
    # and this branch would post "✅ Recovered: Max auth" inside a live outage.
    # live-day's launchd run, the context that can read the keychain, checks
    # sign-in every 10 minutes and records the reading in
    # data/max-auth-probe.json (lib/max-auth-probe.sh), so
    # watchdog holds the incident open on a fresh signed-out reading. It pages
    # on it too, so an outage no supervisor has hit yet still gets reported.
    # It pages only after a second failing check, about 10 minutes later,
    # because one bad reading could be a blip. A stale or missing record is no
    # evidence and falls through to the old behaviour.
    rm -f "$INCIDENT_DIR/auth-outage.green_streak" 2>/dev/null
    ISSUES="$ISSUES auth(signed-out)"
    AUTH_OUTAGE_HELD=1   # both the single-reading hold and the confirmed page
    _auth_since_local="$(TZ="${EDVA_TZ:-UTC}" date -r "$MAX_AUTH_PROBE_SINCE" '+%-I:%M %p' 2>/dev/null) $(home_tz_label)"
    if [ "$MAX_AUTH_PROBE_FAIL_SEC" -lt 540 ]; then
      log "Max auth: the launchd sign-in check read signed out once ($MAX_AUTH_PROBE_SUMMARY). Not paging until the next check confirms it, and not clearing either"
    else
      log "Max auth outage: no fresh AUTH ERROR line, but the launchd sign-in check has read signed out since $_auth_since_local ($MAX_AUTH_PROBE_SUMMARY) — holding the incident open"
      if incident_should_alert "auth-outage" 1800 4 21600; then
        notify "🔴 Max auth is down: Claude Code on ${EDVA_HOST_LABEL:-the host} has read as signed out since $_auth_since_local, checked every 10 min from launchd (the context the scheduled runs use). Every scheduled Claude run will refuse to start until it is back, and quiet supervisor logs don't mean it recovered. Run \`claude /login\` on ${EDVA_HOST_LABEL:-the host}; there is no API-key fallback by design."
      fi
    fi
  elif [ "$MAX_AUTH_PROBE_STATE" = "pre-heal" ]; then
    rm -f "$INCIDENT_DIR/auth-outage.green_streak" 2>/dev/null
    AUTH_OUTAGE_HELD=1
    log "Max auth: the last launchd sign-in check (signed out) predates this tick's keychain self-heal — holding without paging until the next check"
  else
    # Say what was actually seen. A fresh signed-in reading is real evidence.
    # Quiet logs alone, with no fresh reading, are not (see above).
    if [ "$MAX_AUTH_PROBE_STATE" = "ok" ]; then
      AUTH_RECOVERY_HOW="Claude Code on ${EDVA_HOST_LABEL:-the host} reads as signed in to Max again (launchd check), and no supervisor has logged a new auth error (if someone logged in, that was the fix; this check can't tell)"
    elif [ "$MAX_AUTH_PROBE_STATE" = "restored" ]; then
      AUTH_RECOVERY_HOW="a supervisor has authenticated on Max again since the last signed-out reading (if someone logged in, that was the fix; this check can't tell)"
    else
      AUTH_RECOVERY_HOW="no supervisor has logged a new auth error for 6 minutes. The launchd sign-in check had no fresh reading, so this is quiet logs, not a confirmed sign-in"
    fi
    # AUTH_OUTAGE_HELD stays 0 here: this is the clearing branch.
    # Re-arm the daily-summary self-heal once, on the recovery transition: the
    # heal's once-per-24h marker may have been spent at the start of the outage
    # on a backfill that could only fail, and then nothing re-dispatches it. The
    # transition is "auth-outage.alerted existed before incident_clear and is
    # gone after it": incident_clear removes it only on the 3rd green tick, once.
    # An ordinary green tick (no .alerted) never touches the marker, or every
    # tick would re-dispatch the backfill. A marker NEWER than the outage's last
    # auth page was spent by the daily-summary block on one of these recovery
    # ticks (it defers, untouched, while the incident is held), so that backfill
    # is already running: leave it, or a second DAILY SUMMARY run would start.
    _auth_alerted_at=""
    [ -f "$INCIDENT_DIR/auth-outage.alerted" ] && _auth_alerted_at=$(stat -f%m "$INCIDENT_DIR/auth-outage.alerted" 2>/dev/null || echo 0)
    # When the outage's first page went out, for the sign-in clock; incident_clear removes the file.
    _auth_first_at=$(stat -f%m "$INCIDENT_DIR/auth-outage.alert_first" 2>/dev/null || echo "")
    incident_clear "auth-outage"
    if [ -n "$_auth_alerted_at" ] && [ ! -f "$INCIDENT_DIR/auth-outage.alerted" ]; then
      max_auth_relogin_mark "${_auth_first_at:-$_auth_alerted_at}"
      # Re-run what the outage made miss, but only the jobs on the installation's
      # approved safe-to-run-late list (bin/auth-outage-replay): queue it
      # here, run it below. It looks from two hours before the first page: the
      # page waits for a confirmed failing check, so the first refusals come
      # before it.
      _auth_replay_from="${_auth_first_at:-$_auth_alerted_at}"
      # A re-run still queued from an earlier outage keeps its earlier start.
      if [[ "$_auth_replay_from" =~ ^[0-9]+$ ]] && [ ! -f "$INCIDENT_DIR/auth-replay.pending" ]; then
        printf '%s\n' "$(( _auth_replay_from - 7200 ))" > "$INCIDENT_DIR/auth-replay.pending" 2>/dev/null
      fi
      if [ -f "$DS_HEAL_MARKER" ] && [ "$(stat -f%m "$DS_HEAL_MARKER" 2>/dev/null || echo 0)" -gt "$_auth_alerted_at" ]; then
        log "Max auth recovery: the daily-summary self-heal already ran after the outage's last auth page; not re-arming it"
      else
        rm -f "$DS_HEAL_MARKER" 2>/dev/null
        log "re-armed daily-summary self-heal after Max auth recovery"
      fi
    elif [ -n "$_auth_alerted_at" ]; then
      AUTH_RECOVERY_PENDING=1   # green, but the incident closes on the 3rd green tick
    else
      # No outage page on record: a signed-out reading that never became a paged
      # outage leaves nothing for the sign-in clock, so drop its marker.
      rm -f "$INCIDENT_DIR/auth-outage.signed_out" 2>/dev/null
    fi
    # The queued re-run waits for the launchd sign-in check itself to read
    # signed in: the outage can close on a supervisor authenticating, or on
    # quiet logs, while the scheduled runs still read signed out, and a job
    # started then only refuses again. It runs once (the marker goes first),
    # posts its one line to the system channel, and is dropped after 12 hours
    # without a confirmed sign-in. Best effort: a failure costs a re-run, never a tick.
    _auth_replay_marker="$INCIDENT_DIR/auth-replay.pending"
    if [ -f "$_auth_replay_marker" ] && [ "$AUTH_RECOVERY_PENDING" != "1" ]; then
      _auth_replay_since=$(head -n 1 "$_auth_replay_marker" 2>/dev/null)
      _auth_replay_age=$(( $(date +%s) - $(stat -f%m "$_auth_replay_marker" 2>/dev/null || echo 0) ))
      if ! [[ "$_auth_replay_since" =~ ^[0-9]+$ ]] || [ "$_auth_replay_age" -gt 43200 ]; then
        rm -f "$_auth_replay_marker" 2>/dev/null
        log "Max auth recovery: re-run of the jobs the outage missed dropped (no confirmed sign-in within 12 hours of it closing)"
      elif [ "$MAX_AUTH_PROBE_STATE" = "ok" ]; then
        rm -f "$_auth_replay_marker" 2>/dev/null
        _auth_replay_bin="${AUTH_OUTAGE_REPLAY_BIN:-${EDVA_INSTALL_TOOLS:-}/bin/auth-outage-replay}"
        if [ -x "$_auth_replay_bin" ]; then
          _auth_replay_line=$("$_auth_replay_bin" --since "$_auth_replay_since" 2>> "${LOG:-/dev/null}" | head -n 1)
          if [ -n "$_auth_replay_line" ]; then
            if EDVA_INFRA_PROBE=1 "$SEND" --skip-precheck --intent watchdog-alert --channel system "$_auth_replay_line" > /dev/null 2>&1; then
              log "Max auth recovery: $_auth_replay_line"
            else
              log "Max auth recovery: re-run note UNDELIVERED: $_auth_replay_line"
            fi
          fi
        fi
      fi
    fi
  fi
fi

# --- Wiki server health ---
# The wiki HTTP browser at 127.0.0.1:9096 is a managed child of process-manager.
# If it stops responding, process-manager normally respawns it on exit; this
# watchdog check covers the case where the process is alive but the HTTP
# server is wedged (port held but not answering). Self-heal = SIGKILL the
# `wiki serve` process so process-manager respawns it. Alert only after a
# self-heal cycle has demonstrably failed (next-tick parity with other
# incidents).
if ! curl -sf --max-time 3 http://127.0.0.1:9096/healthz > /dev/null 2>&1; then
  ATTEMPT=$(incident_seen "wiki-server-down")
  log "Wiki server unreachable on :9096 (attempt $ATTEMPT)"
  ISSUES="$ISSUES wiki-server(down)"

  # Match the :9096 server EXACTLY, by port. A SECOND `wiki serve` runs the
  # internet-facing origin on :9097, so `pgrep -f "bin/wiki serve"` would
  # match both and `head -1` would pick whichever holds the lower pid: the heal
  # could kill the healthy public server while the wedged :9096 one survives,
  # and the next tick would page "Manual intervention needed" for a failure the
  # heal itself caused. Never widen this pattern back to the bare binary name.
  WIKI_PID=$(pgrep -f "bin/wiki serve --port 9096" | head -1)
  if [ -n "$WIKI_PID" ]; then
    log "Killing wedged wiki serve pid $WIKI_PID (:9096) — process-manager will respawn"
    kill "$WIKI_PID" 2>/dev/null
  fi

  if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "wiki-server-down"; then
    notify "🔴 Wiki server (:9096) down and not recovering after $ATTEMPT consecutive ticks. Manual intervention needed on ${EDVA_HOST_LABEL:-the host}."
  fi
else
  incident_clear "wiki-server-down"
fi

# --- Max sign-in renewal heads-up ---
# The Max login has lapsed some weeks after each manual sign-in ("OAuth session
# expired and could not be refreshed"), and a lapse stops every scheduled Claude
# run until someone runs `claude /login` at the host. § Max auth outage pages
# only once it has happened, which can be overnight or while the user is away
# from the host. So from MAX_AUTH_RENEW_NOTE_DAYS (22) days after the last
# sign-in on the clock (§ Max auth outage), this sends ONE note suggesting a
# sign-in at a convenient moment, then nothing more until the clock moves: the
# next lapse's recovery restarts it, and a sign-in done by hand with no outage
# (invisible from here) is covered by the next note, which comes no sooner than
# 22 days after this one.
#
# Channel: system, with --push. It is about Edva's own sign-in, so it is a
# system row (agent/CLAUDE.md § System Channel), and it asks the user to
# do something within days, which is what --push is for. No 🔴: nothing is
# broken. Daytime only (09:00-21:00 home time), so the banner never lands at
# night. Skipped while an auth outage is open or its recovery is unconfirmed:
# the 🔴 page covers that.

_max_auth_relogin_num() {   # <key> <file>: an integer field, or nothing
  grep -oE "\"$1\":[0-9]+" "$2" 2>/dev/null | head -n1 | sed -E 's/^[^:]*://'
}

# max_auth_relogin_bootstrap — first tick with no clock: seed it from the newest
# "auth restored" line any supervisor logged (live or rotated logs), the nearest
# trace of the last sign-in this host keeps. With none, start the clock now, so
# the scan runs once rather than every tick.
# The pattern is the supervisors' own log line, nothing looser: supervisor/index.mjs
# writes "<ISO>Z [supervisor] auth restored — rotating session and resuming
# dispatcher", chat-supervisor.mjs "<ISO>Z [chat-supervisor] auth restored after
# <n> failed turn(s)". (Machine-written log structure, not language.)
MAX_AUTH_RESTORED_LINE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z (\[supervisor\] auth restored .*rotating session and resuming dispatcher|\[chat-supervisor\] auth restored after [0-9]+ failed turn\(s\))$'
max_auth_relogin_bootstrap() {
  local logs="${EDVA_INSTALL_TOOLS:-}/agent/logs" lf line epoch newest=0 now
  now=$(date +%s)
  for lf in "$logs"/ops-supervisor*.log* "$logs"/ops-light-supervisor*.log* \
            "$logs"/ops-haiku-supervisor*.log* "$logs"/chat-supervisor*.log*; do
    [ -f "$lf" ] || continue
    case "$lf" in
      *.gz) line=$(gzip -dc "$lf" 2>/dev/null | grep -E "$MAX_AUTH_RESTORED_LINE_RE" | tail -n1) ;;
      *)    line=$(grep -E "$MAX_AUTH_RESTORED_LINE_RE" "$lf" 2>/dev/null | tail -n1) ;;
    esac
    [ -n "$line" ] || continue
    epoch=$(_auth_epoch "$line")
    [[ "$epoch" =~ ^[0-9]+$ ]] || continue
    if [ "$epoch" -le "$now" ] && [ "$epoch" -gt "$newest" ]; then newest="$epoch"; fi
  done
  if [ "$newest" -gt 0 ]; then
    _max_auth_relogin_write "$newest" 0 "supervisor-log"
    log "Max sign-in clock: no record yet, seeded from the newest supervisor 'auth restored' line ($(date -r "$newest" '+%Y-%m-%d %H:%M'))"
  else
    _max_auth_relogin_write "$now" 0 "first-seen"
    log "Max sign-in clock: no record and no 'auth restored' line in the supervisor logs; starting the clock now"
  fi
  return 0
}

# max_auth_renewal_heads_up <now_epoch> — sends the note when it is due, at
# most once per call. Never fails the tick.
max_auth_renewal_heads_up() {
  local now="${1:-}" f relogin note src anchor days hour host msg push
  [[ "$now" =~ ^[0-9]+$ ]] || now=$(date +%s)
  f=$(_max_auth_relogin_file)
  [ -n "$f" ] || return 0
  [ -f "$f" ] || max_auth_relogin_bootstrap
  relogin=$(_max_auth_relogin_num relogin_ts "$f")
  note=$(_max_auth_relogin_num note_ts "$f")
  [[ "$relogin" =~ ^[0-9]+$ ]] || return 0
  [[ "$note" =~ ^[0-9]+$ ]] || note=0
  anchor="$relogin"
  [ "$note" -gt "$anchor" ] && anchor="$note"
  days="${MAX_AUTH_RENEW_NOTE_DAYS:-22}"
  [[ "$days" =~ ^[0-9]+$ ]] || days=22
  [ $(( now - anchor )) -ge $(( days * 86400 )) ] || return 0
  hour=$(TZ="${EDVA_TZ:-UTC}" date -r "$now" '+%H' 2>/dev/null)
  hour="${hour#0}"
  [[ "$hour" =~ ^[0-9]+$ ]] || return 0
  { [ "$hour" -ge 9 ] && [ "$hour" -lt 21 ]; } || return 0
  host="${EDVA_HOST_LABEL:-the host}"
  if [ "$note" -lt "$relogin" ]; then
    msg="As far as I can tell, the Claude sign-in on $host hasn't been renewed in $(( (now - relogin) / 86400 )) days. It tends to run out about four weeks after a sign-in, and when it does, every scheduled Claude job stops until someone signs in again. If you run \`claude /login\` on $host sometime in the next few days, the clock starts over and you skip that outage."
  else
    # A sign-in after the last note is invisible here, and if one happened it
    # was about this long ago, so it is due again either way: say so plainly.
    msg="It's been $(( (now - note) / 86400 )) days since my last nudge about the Claude sign-in on $host. A sign-in done by hand doesn't show up on my side, so whether or not you renewed it after that note, it's about due again now. Running \`claude /login\` on $host in the next few days keeps every scheduled Claude job from stopping when it runs out."
  fi
  # The banner is cut at ~100 characters, before the ask; give it its own line.
  push="Time to renew the Claude sign-in on $host: run claude /login there in the next few days."
  src=$(grep -oE '"source":"[A-Za-z0-9._-]*"' "$f" 2>/dev/null | head -n1 | sed -E 's/^"source":"//; s/"$//')
  if EDVA_INFRA_PROBE=1 "$SEND" --skip-precheck --intent max-auth-renewal --channel system --push --push-body "$push" "$msg" > /dev/null 2>&1; then
    _max_auth_relogin_write "$relogin" "$now" "${src:-unknown}"
    log "Max sign-in heads-up sent: $msg"
  else
    log_throttled "$EDVA_INSTALL_TOOLS/data/.watchdog-renewal-note-failed" "Max sign-in heads-up could not be delivered; it retries next tick" 3600
  fi
  return 0
}

if [ "${AUTH_OUTAGE_HELD:-0}" != "1" ] && [ "${AUTH_RECOVERY_PENDING:-0}" != "1" ]; then
  max_auth_renewal_heads_up "$(date +%s)"
fi

# --- GitHub CLI auth health ---
# Where the credential actually lives: `gh` reads its OAuth token from
# ~/.config/gh/hosts.yml. It is NOT in the macOS keyring, so there is no
# cron/keychain false-positive to hunt for (`security find-internet-password
# -s github.com` finds nothing). watchdog additionally exports GH_TOKEN from
# secrets/gh-token when that file is readable, and GH_TOKEN OVERRIDES
# hosts.yml — so this probe validates the secrets-file credential, not
# necessarily the one an interactive `gh` call would use.
#
# Token is long-lived (device-flow OAuth, no expiry) but can be invalidated by
# revocation or SSO cycles.
#
# Sandbox/network-aware: a bare `gh api user` failure is ambiguous — it fires
# identically when the token is genuinely revoked AND when GitHub is simply
# unreachable (the default Bash-tool sandbox masks outbound network, a transient
# partition, or GitHub itself being down). Treating "can't reach GitHub" as
# "token invalid" produces a false "gh CLI auth is broken" alarm.
# So we gate the auth verdict on a connectivity probe (same shape as
# cloudflared_tunnel_probe): GET the unauthenticated api.github.com root, which
# answers a non-000 HTTP code without any token. Only when GitHub is reachable
# but the authenticated call still fails do we conclude the token is bad.
#
# PERSIST BEFORE PAGING. That connectivity guard separates "no network at all"
# from everything else and nothing more, so a transient 5xx, a TLS reset, or a
# rate-limited authenticated call still reads as "token invalid/revoked". Paging
# off a SINGLE failing sample (a hand-rolled cooldown instead of the house
# incident_seen/incident_should_alert/incident_clear trio) cries wolf: a
# genuinely revoked OAuth token cannot un-revoke itself, yet such pages clear
# with no re-login. Skipping incident_clear also leaves "auth is broken, run
# this command" as the last word on a condition that already fixed itself.
#
# So: require GH_MIN_TICKS consecutive failures, report the error actually
# observed instead of asserting revocation, and clear through the shared
# machinery so a real breakage gets its ✅ Recovered ping for free.
GH_BIN=/opt/homebrew/bin/gh
GH_TOKEN_FILE="$HOME/Dev/edva/secrets/gh-token"
GH_MIN_TICKS=3   # ~6 min of sustained failure at the 2-min watchdog cadence

# Exit 0 = api.github.com reachable (any HTTP code returned); non-zero = no
# network path (sandbox-masked, partitioned, or GitHub down).
github_api_reachable() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
    -H "X-Edva-Probe: watchdog" \
    "https://api.github.com/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

if [ -x "$GH_BIN" ]; then
  if [ -r "$GH_TOKEN_FILE" ]; then
    export GH_TOKEN=$(cat "$GH_TOKEN_FILE")
  fi
  GH_OUT=$("$GH_BIN" api user -q .login 2>&1)
  GH_RC=$?
  if [ "$GH_RC" -ne 0 ]; then
    if ! github_api_reachable; then
      # GitHub unreachable — connectivity, not auth. Don't cry wolf; the auth
      # token can't be assessed when there's no network path to validate it.
      # Deliberately neither incident_seen nor incident_clear: an unreachable
      # network is not evidence the token is bad (so it must not accumulate
      # toward GH_MIN_TICKS) and not evidence it is good (so it must not clear a
      # real incident in progress). The counter simply holds.
      ISSUES="$ISSUES gh-auth(unreachable)"
      log "gh api user failed but api.github.com is unreachable — connectivity/sandbox, not a token problem; skipping auth alert"
    else
      # GitHub answered the unauthenticated probe but rejected the authenticated
      # call. That is CONSISTENT with a revoked token but does not establish it —
      # a 5xx, a TLS reset or a secondary rate limit land here too, which is why
      # we require the condition to persist before saying anything.
      GH_ATTEMPT=$(incident_seen "gh-auth")
      # Deliberately WITHOUT the tick number: $ISSUES feeds log_on_change, so a
      # per-tick-varying value would log a fresh summary line every 2 min for the
      # whole incident. The attempt count lives in the dedicated log line below.
      ISSUES="$ISSUES gh-auth(invalid)"
      log "gh api user failed while api.github.com reachable (attempt $GH_ATTEMPT, rc=$GH_RC): $(echo "$GH_OUT" | head -c 200)"

      # Read the cause off the probe's own output rather than asserting
      # revocation every time. These are machine-generated CLI/HTTP error
      # strings, not natural language — matching them is structure, not
      # interpretation.
      if echo "$GH_OUT" | grep -qiE "bad credentials|401|requires authentication"; then
        GH_HINT="GitHub rejected the token outright. Run: gh auth logout -h github.com${EDVA_OWNER:+ -u $EDVA_OWNER} && gh auth login -h github.com -p https -w -s repo,workflow,read:org,gist — and note that only rewrites ~/.config/gh/hosts.yml, so secrets/gh-token (what this probe reads) needs updating too."
      elif echo "$GH_OUT" | grep -qiE "rate limit|403|abuse detection"; then
        GH_HINT="This looks like a rate limit rather than a bad token — it should clear on its own."
      else
        GH_HINT="This is not a rejected token or a rate limit — GitHub's API or the network has been failing repeatedly."
      fi

      if [ "$GH_ATTEMPT" -ge "$GH_MIN_TICKS" ] && incident_should_alert "gh-auth"; then
        notify "⚠️ gh CLI auth has been failing $GH_ATTEMPT checks running. $GH_HINT Last error: $(echo "$GH_OUT" | tr '\n' ' ' | head -c 180)"
      fi
    fi
  else
    incident_clear "gh-auth"
  fi
fi

# --- Gmail watch renewal health ---
# renew-gmail-watch.sh writes data/gmail-watch-last.json after each run:
#   { "at": "<renewal UTC>", "expiresAt": "<expiry UTC|null>", "ok": true|false, "error": "<msg|null>" }
# Alert (at most once per 24h) if the last run failed OR the watch is within
# 24h of expiring. Silent when missing entirely — the first crontab firing
# writes it; before that we have nothing to assert.
GMAIL_WATCH_LAST="$HOME/Dev/edva/data/gmail-watch-last.json"
GMAIL_WATCH_RENEW_COOLDOWN="$HOME/Dev/edva/data/.gmail-watch-self-heal-cooldown"
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
      "$HOME/Dev/edva/agent/scripts/renew-gmail-watch.sh" >> "$LOG" 2>&1 || true
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
# gog (Google Tasks/Calendar/Drive) is critical — triage P1 tasks, calendar
# and Drive reads all depend on it. It breaks THREE ways
# on this mostly-headless host: (1) the macOS login KEYCHAIN locks (reboot/sleep/
# no GUI unlock) so gog can't read its keychain-stored token; (2) Google revokes
# the refresh token; (3) Google's own token endpoint blips — a single
# `oauth2: "internal_failure"` on refresh, healthy again on the next tick.
#
# Paging off a SINGLE failing sample of cause (3) is wrong twice over: the next
# tick usually clears it, and a fixed "the login keychain locked" diagnosis
# contradicts the log line (`oauth2: "internal_failure"` is Google's endpoint,
# not a locked keychain). A 🔴 page also dispatches an Opus escalation run.
# Like every sibling check, this probe uses the house
# incident_seen/should_alert/clear trio, so it persists first and a self-healed
# outage gets its ✅ Recovered instead of leaving "auth is DOWN" as the last word.
#
# So: persist across GOG_MIN_TICKS consecutive failing ticks before paging,
# name the cause from the error actually observed, and clear through the shared
# machinery so recovery pings for free.
GOG_BIN=/opt/homebrew/bin/gog
GOG_MIN_TICKS=3   # ~4-6 min of sustained failure at the 2-min watchdog cadence
if [ -x "$GOG_BIN" ]; then
  GOG_OUT=$("$GOG_BIN" tasks lists --plain ${EDVA_OWNER_EMAIL:+--account=$EDVA_OWNER_EMAIL} --no-input 2>&1)
  GOG_RC=$?
  GOG_FAILED=0
  if [ "$GOG_RC" -ne 0 ] || echo "$GOG_OUT" | grep -qiE "no auth|no tokens|invalid_grant|expired|revoked|unauthorized|keychain|locked"; then
    GOG_FAILED=1
  fi
  # Same control question the tunnel arm above and the gh-auth arm below ask:
  # a token probe that cannot reach oauth2.googleapis.com says nothing about the
  # token (e.g. a `dial tcp` error in the same tick the tunnel arm reads
  # host-offline). Neither incident_seen nor incident_clear, for the reason the tunnel arm
  # spells out: an unreachable host is not evidence the token is bad, so it must
  # not accumulate toward GOG_MIN_TICKS, and not evidence it is good, so it must
  # not clear an incident already in progress. The counter holds and resumes.
  if [ "$GOG_FAILED" = 1 ] && ! host_network_reachable; then
    ISSUES="$ISSUES gog-auth(host-offline)"
    log "gog auth probe failed, but no control vendor is reachable either — this host has no outbound network; holding the counter, no page"
  elif [ "$GOG_FAILED" = 1 ]; then
    GOG_ATTEMPT=$(incident_seen "gog-auth")
    # Deliberately WITHOUT the tick number: $ISSUES feeds the log_on_change key
    # below, so a per-tick-varying value would log a fresh summary line every
    # 2 min for the whole incident (the gmail-push-gap ms-drift bug). The
    # attempt count lives in the dedicated log line instead.
    ISSUES="$ISSUES gog-auth(down)"
    log "gog auth probe failed (attempt $GOG_ATTEMPT, rc=$GOG_RC): $(echo "$GOG_OUT" | head -c 200)"

    # Read the cause off the probe's own output rather than asserting the
    # keychain hypothesis every time. These are machine-generated CLI/oauth2
    # error strings, not natural language — matching them is structure, not
    # interpretation.
    if echo "$GOG_OUT" | grep -qiE "keychain|locked|no auth|no tokens"; then
      GOG_HINT="The login keychain looks locked or the token store unreadable — unlock the keychain on ${EDVA_HOST_LABEL:-the host}, or run 'gog login ${EDVA_OWNER_EMAIL:-<account>}'."
    elif echo "$GOG_OUT" | grep -qiE "invalid_grant|revoked|unauthorized"; then
      GOG_HINT="Google looks to have revoked the refresh token — run 'gog login ${EDVA_OWNER_EMAIL:-<account>}' to re-consent."
    else
      GOG_HINT="This is not a locked keychain or a revoked token — Google's token endpoint or the network has been failing repeatedly."
    fi

    if [ "$GOG_ATTEMPT" -ge "$GOG_MIN_TICKS" ] && incident_should_alert "gog-auth"; then
      notify "🔴 gog (Google) auth is DOWN — Tasks/Calendar/Drive unavailable (P1-task creation, calendar and Drive reads, etc.). Failing $GOG_ATTEMPT checks running. $GOG_HINT Last error: $(echo "$GOG_OUT" | tr '\n' ' ' | head -c 180)"
    fi
  else
    incident_clear "gog-auth"
  fi
fi

# ── Supabase DB reachability.
# The Edva app + phone channel are dead whenever the DB is unreachable, and
# without this that surfaces only as a silently-spinning app. This alerts to the
# system channel the moment it degrades. The query is AUTHENTICATED (hits
# Postgres, not just the edge — the edge stays up during a DB outage).
#
# Debounce: an in-tick `sleep 3` + re-probe, AND TWO consecutive failing ticks
# before anything pages, the same `[ "$ATTEMPT" -ge 2 ]` gate every sibling flapping
# probe in this file already carries (process-manager-down, cloudflared-tunnel,
# chat-delivery-stuck, gog-auth).
#
# The in-tick double-check is NOT by itself enough to keep a brief blip from
# paging: 3 seconds of re-probing samples a sliver of a 2-minute cron cadence,
# so a blip of ~11s would page at full 🔴 CRITICAL confidence with a specific,
# usually-wrong remediation, and 🔴 also dispatches a heavy system-issue-review
# escalation run.
#
# The failure path must call incident_seen: it is the ONLY writer that removes
# ${key}.green_streak. Without it a failure would not reset the green counter,
# incident_clear's `streak -ge 3` gate could be satisfied by ticks that preceded
# the outage, and the ✅ would assert a stability nobody had verified. (The
# streak file's own 1→2→3→deleted churn on a healthy
# host is incident_clear's doing, not this omission's, and still happens.)
if [ -n "$SUPABASE_KEY" ]; then
  supabase_reachable() {
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
      -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" \
      "$SUPABASE_URL/rest/v1/edva_messages?select=id&limit=1" 2>/dev/null)
    [ "$code" = "200" ] || [ "$code" = "206" ]
  }
  # Every incident key needs a matching incident_clear on its success path;
  # without one its marker sits there until the cooldown ages out and it can
  # never emit a recovery.
  if supabase_reachable; then
    incident_clear "supabase-unreachable"
  else
    sleep 3
    if supabase_reachable; then
      incident_clear "supabase-unreachable"
    elif ! host_network_reachable; then
      # Control probe, per the tunnel arm above. A 000 from this host during a
      # partition is not evidence about Supabase compute, and a "likely compute
      # saturation" page would send the user to the Supabase dashboard for
      # nothing. No incident_seen and no
      # incident_clear: the double-check above has already run, so the state
      # simply holds until this host can see the internet again. The pages
      # this suppresses could not be delivered anyway (they log "ALERT
      # UNDELIVERED (no channel reachable)"), because the push path needs the
      # same network.
      #
      # DO NOT "tidy" this branch by adding incident_seen or incident_clear to
      # match the arm below. The omission here is deliberate and load-bearing: an
      # unreachable host is not evidence Supabase is down (so it must not count
      # toward the 2-tick gate) and not evidence it is up (so it must not clear an
      # incident already in progress). The counter holds and resumes.
      ISSUES="$ISSUES supabase(host-offline)"
      log "Supabase unreachable, but no control vendor is reachable either — this host has no outbound network; holding, no page"
    else
      # Persist across two consecutive failing ticks before paging, and reset the
      # green streak on the way through (incident_seen is the only thing that
      # does) so the ✅ Recovered that follows has actually seen 3 green ticks.
      # See the block comment above.
      ATTEMPT=$(incident_seen "supabase-unreachable")
      # Deliberately WITHOUT the tick number, per the gog arm: $ISSUES feeds the
      # log_on_change key, so a per-tick-varying value would log a fresh summary
      # line every 2 min for the whole incident. The count lives in the dedicated
      # log line and in the page instead.
      ISSUES="$ISSUES supabase(unreachable)"
      log "Supabase unreachable after in-tick re-probe (attempt $ATTEMPT), host network is fine"
      if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "supabase-unreachable" 1800 4 21600; then
        notify "🔴 Supabase DB unreachable — the Edva app + phone channel are down (queries to edva_messages failing). Failing $ATTEMPT checks running. Check Supabase compute/dashboard for project ${EDVA_SUPABASE_PROJECT} (likely compute saturation)."
      fi
    fi
  fi
fi

# ── Duplicate phone-channel detection. A rogue 2nd phone-channel (e.g. a stray
# edva-phone MCP entry in a local Claude Desktop config) double-processes
# the channel + Supabase and amplifies an outage. Exactly ONE should
# run (the chat supervisor's child); alert if more. Belt-and-suspenders to the
# in-process single-instance guard in phone-channel/index.mjs.
#
# Debounced — do NOT restore first-detection paging. The one legit phone-channel is an MCP stdio child of the chat
# supervisor's `claude -p` session, so every session kill+restart (any 10-min
# turn hang causes one) briefly overlaps a dying copy with the new one and
# `pgrep` transiently counts 2; at a 2-min tick a first-detection page fires
# ~90s after a "killing + restarting" alert.
# chat-supervisor.mjs already guards its own phone-channel heartbeat against
# this same handover window. `incident_should_alert` is only a rate limiter, so
# the >= 2 gate below is what separates a handover flicker from a real rogue
# duplicate (which still pages, ~4 min in instead of ~2).
# _etime_secs — convert a `ps -o etime=` string to seconds. macOS ps has no
# `etimes` keyword ("ps: etimes: keyword not found"), so the four Darwin widths are parsed by hand:
#   "ss" | "mm:ss" | "hh:mm:ss" | "dd-hh:mm:ss"
# Machine-generated structure, not language — no model needed (Rule #0b).
# Prints seconds on stdout; returns 1 and prints nothing on anything it can't
# parse, so every caller can fail open.
_etime_secs() {
  local e d=0 h=0 m=0 s=0 OLDIFS
  e=$(echo "$1" | tr -d '[:space:]')
  [ -n "$e" ] || return 1
  case "$e" in
    *-*) d=${e%%-*}; e=${e#*-} ;;
  esac
  OLDIFS=$IFS
  IFS=:
  # shellcheck disable=SC2086
  set -- $e
  IFS=$OLDIFS
  case $# in
    1) s=$1 ;;
    2) m=$1; s=$2 ;;
    3) h=$1; m=$2; s=$3 ;;
    *) return 1 ;;
  esac
  case "$d$h$m$s" in ""|*[!0-9]*) return 1 ;; esac
  echo $(( 10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}

# _pc_ppid <pid> — the parent pid of <pid>, whitespace-trimmed. Prints nothing
# and returns 1 when ps can't read it (the pid vanished between pgrep and ps, or
# ps errored) or the answer isn't a bare integer, so every caller can fail open.
# Machine-generated structure, not language — no model needed (Rule #0b).
_pc_ppid() {
  local p
  p=$(ps -o ppid= -p "$1" 2>/dev/null | tr -d '[:space:]')
  case "$p" in ""|*[!0-9]*) return 1 ;; esac
  echo "$p"
}

PC_PIDS=$(pgrep -f "phone-channel/index.mjs" 2>/dev/null)
PC_COUNT=$(printf '%s' "$PC_PIDS" | grep -c . 2>/dev/null)
# Orphans this watchdog already sent SIGTERM on an earlier tick, one "pid <n>"
# line each, so a survivor gets SIGKILL on the next. The "pid " prefix is for
# `edva watchdog`, which reads any un-suffixed file in this dir as an integer
# failure counter — a bare pid would show up there as a huge failure count.
PC_ORPHAN_FILE="$INCIDENT_DIR/phone-channel-duplicate.orphans_termed"
if [ "${PC_COUNT:-0}" -gt 1 ]; then
  ATTEMPT=$(incident_seen "phone-channel-duplicate")
  log "$PC_COUNT phone-channel processes running (expected 1, attempt $ATTEMPT)"
  ISSUES="$ISSUES phone-channel(duplicate=$PC_COUNT)"

  # ORPHANS are reaped, not paged about.
  # When the turn watchdog SIGKILLs a hung chat `claude -p`, its phone-channel
  # MCP child is not killed with it: it is re-parented to launchd (ppid 1) and
  # can linger for many minutes as a second Supabase subscriber beside the
  # replacement session's phone-channel. Replacement sessions have been seen
  # to stall while such an orphan lingered (plausibly an orphaned subscriber
  # competing for incoming rows; not proven), and the pages this probe sent
  # were handover/orphan artifacts rather than real rogues.
  #
  # So: a phone-channel whose ppid is exactly 1 is an ORPHAN; one whose ppid is
  # readable and not 1 is LIVE; an unreadable ppid is unknown and is never killed.
  # Only when at least one LIVE instance is positively seen do the orphans get
  # SIGTERM — then SIGKILL if the same pid is still here next tick — and only
  # the remaining (live + unknown) set goes on to the age/paging logic below. All
  # orphans, or none, changes nothing: exactly the behaviour without reaping.
  # Never signals a pid outside $PC_PIDS, and re-reads the ppid right before
  # each signal, so nothing whose parent is not launchd is ever touched. Two
  # LIVE-parented instances (e.g. a stray Claude Desktop MCP entry) are still
  # a genuine rogue and still page as before.
  # Guarded by tests/watchdog-phone-channel-orphan.test.mjs.
  PC_ORPHANS=""
  PC_LIVE=""
  PC_KEEP=""
  for _pco_pid in $PC_PIDS; do
    if _pco_ppid=$(_pc_ppid "$_pco_pid"); then
      if [ "$_pco_ppid" = "1" ]; then
        PC_ORPHANS="$PC_ORPHANS $_pco_pid"
        continue
      fi
      PC_LIVE="$PC_LIVE $_pco_pid"
    fi
    PC_KEEP="$PC_KEEP $_pco_pid"
  done
  if [ -n "$PC_ORPHANS" ] && [ -n "$PC_LIVE" ]; then
    _pco_desc=""
    for _pco_pid in $PC_ORPHANS; do
      if _pco_age=$(_etime_secs "$(ps -o etime= -p "$_pco_pid" 2>/dev/null)"); then
        _pco_up="${_pco_age}s"
      else
        _pco_up="unknown"
      fi
      _pco_desc="${_pco_desc:+$_pco_desc, }$_pco_pid (ppid 1, up $_pco_up)"
    done
    if [ "$(printf '%s\n' $PC_LIVE | grep -c .)" -gt 1 ]; then
      _pco_live_txt="the live ones are$PC_LIVE"
    else
      _pco_live_txt="the live one is$PC_LIVE"
    fi
    log "orphaned phone-channel $_pco_desc left behind by a killed chat session — terminating; $_pco_live_txt"
    _pco_termed=""
    for _pco_pid in $PC_ORPHANS; do
      [ "$(_pc_ppid "$_pco_pid")" = "1" ] || continue
      if grep -qx "pid $_pco_pid" "$PC_ORPHAN_FILE" 2>/dev/null; then
        log "orphaned phone-channel $_pco_pid survived SIGTERM from an earlier tick — sending SIGKILL"
        kill -KILL "$_pco_pid" 2>/dev/null
      else
        kill -TERM "$_pco_pid" 2>/dev/null
      fi
      _pco_termed="$_pco_termed $_pco_pid"
    done
    if [ -n "$_pco_termed" ]; then
      # shellcheck disable=SC2086
      printf 'pid %s\n' $_pco_termed > "$PC_ORPHAN_FILE"
    else
      rm -f "$PC_ORPHAN_FILE" 2>/dev/null
    fi
    # shellcheck disable=SC2086
    PC_PIDS=$(printf '%s\n' $PC_KEEP)
    PC_COUNT=$(printf '%s' "$PC_PIDS" | grep -c . 2>/dev/null)
  fi

  # AGE, not tick count, separates a handover from a rogue duplicate. A
  # ">= 2 consecutive ticks" gate measures how LONG the overlap lasts, and that
  # varies with how fast the dying MCP stdio child releases its Supabase
  # realtime subscription and interval timers (from ~70s to over two ticks of
  # the */2 cron), so handovers would still page.
  #
  # A session restart always leaves exactly one BRAND-NEW process beside the
  # dying one, so the youngest PID's age is positive evidence of a handover.
  # A genuine rogue duplicate (e.g. a stray Claude Desktop MCP entry) is two
  # independently long-lived processes and clears the grace
  # window trivially — it still pages, ~5 min in instead of ~4.
  #
  # Fails OPEN: if ps yields nothing parseable, PC_MIN_AGE_S stays empty and we
  # fall through to the old tick-only behaviour rather than going silent.
  PC_HANDOVER_GRACE_S=300
  PC_MIN_AGE_S=""
  for _pc_pid in $PC_PIDS; do
    _pc_age=$(_etime_secs "$(ps -o etime= -p "$_pc_pid" 2>/dev/null)") || continue
    if [ -z "$PC_MIN_AGE_S" ] || [ "$_pc_age" -lt "$PC_MIN_AGE_S" ]; then
      PC_MIN_AGE_S=$_pc_age
    fi
  done

  if [ "$PC_COUNT" -le 1 ]; then
    # Only reachable after the orphan reaping above: what was left is a single
    # live instance, so there is no duplicate to page about. No incident_clear
    # here either — that waits for a tick where pgrep itself counts one.
    log "phone-channel duplicate was an orphan of a killed chat session (reaped); one live instance left — not paging"
  elif [ -n "$PC_MIN_AGE_S" ] && [ "$PC_MIN_AGE_S" -lt "$PC_HANDOVER_GRACE_S" ]; then
    log "phone-channel duplicate: youngest process is ${PC_MIN_AGE_S}s old (grace ${PC_HANDOVER_GRACE_S}s) — chat-supervisor session handover, not paging"
  elif [ "$ATTEMPT" -ge 2 ] && incident_should_alert "phone-channel-duplicate" 3600 3 21600; then
    notify "⚠️ $PC_COUNT phone-channel processes running (expected 1) for $ATTEMPT consecutive ticks, and the youngest has been up ${PC_MIN_AGE_S:-unknown}s — too long to be a session handover. Likely a rogue duplicate double-processing the channel + Supabase. Kill the non-supervisor one (check for a stray launch / a Claude Desktop MCP entry)."
  fi
else
  rm -f "$PC_ORPHAN_FILE" 2>/dev/null
  incident_clear "phone-channel-duplicate"
fi

# ── Daily-summary cron-miss detection.
# The daily-summary cron builds the prior day's episodic-memory row in
# `daily_summaries` (keyed on date). Without this, misses are SILENT — a hung
# supervisor or a crashed run just drops a day of episodic memory, surfacing only
# the next night when episode-archive fails (24h late, no page). This checks the
# actual artifact (the row), not a self-reported marker that can't catch a no-run.
# Heal-then-alert: dispatch one idempotent
# backfill/day (upsert on date), page only if the heal hasn't landed the row.
#
# Grace: the job's own scheduled hour + 2h, DERIVED from system/tasks.json
# rather than hardcoded. A hardcoded gate drifts from the real schedule when the
# job moves, leaving a blind window of hours in which nothing self-heals a miss
# (and the downstream episode-archive gate then alerts with the real cause one
# layer upstream). Deriving it keeps the window at the intended ~2h.
#
# Max auth outage deferral. During a Max sign-in outage the backfill is an ops
# turn certain to fail, and a "🔴 Daily-summary missing ... Backfill manually"
# page would be a second red page for the same root cause as § Max auth outage's
# own "🔴 Max auth is DOWN", with a remedy that cannot work until /login. So
# while that section holds the auth-outage incident open (AUTH_OUTAGE_HELD=1), this block
# still records the miss (incident, log, ISSUES) but neither dispatches, nor
# touches DS_HEAL_MARKER (defined at the top of this file), nor pages. The auth
# section re-arms the marker once on recovery, so the backfill runs when auth
# is back. The nightly-review and episode-archive heals below have related
# shapes but are intentionally out of scope for this fix.
HOME_HOUR=$(TZ="${EDVA_TZ:-UTC}" date +%H); HOME_HOUR=$((10#$HOME_HOUR))
# tasks registry = kernel system/tasks.json + agent/local/tasks.json (lib/registry.cjs).
DS_CRON_HOUR=$("$NODE" "$HOME/Dev/edva/lib/registry.cjs" tasks 2>/dev/null \
  | jq -r '.tasks[] | select(.name=="daily-summary") | .schedule | split(" ")[1]' 2>/dev/null)
case "$DS_CRON_HOUR" in ''|*[!0-9]*) DS_CRON_HOUR=1 ;; esac  # fall back to the known schedule
DS_GRACE_HOUR=$(( DS_CRON_HOUR + 2 ))
[ "$DS_GRACE_HOUR" -gt 23 ] && DS_GRACE_HOUR=23
# Target + gate on the user's LOCAL clock. daily-summary fires at
# 04:00 local (clock-jobs.json; tasks.json's "0 4" is that local hour) and
# compiles yesterday-local, so the check must name the same day and wait on the
# same clock — gating "yesterday at home" on the home-zone hour looks two days
# back in a far-off time zone and misses a whole day. Falls back to the home
# zone if local-day errors.
DS_LOCAL=$("$HOME/Dev/edva/bin/local-day" --json 2>/dev/null)
DS_LOCAL_HOUR=$(echo "$DS_LOCAL" | jq -r '.hour // empty' 2>/dev/null)
DS_TARGET=$(echo "$DS_LOCAL" | jq -r '.yesterday // empty' 2>/dev/null)
case "$DS_LOCAL_HOUR" in ''|*[!0-9]*) DS_LOCAL_HOUR=$HOME_HOUR ;; esac
[ -z "$DS_TARGET" ] && DS_TARGET=$(TZ="${EDVA_TZ:-UTC}" date -v-1d +%Y-%m-%d)
if [ -n "$SUPABASE_KEY" ] && [ "$DS_LOCAL_HOUR" -ge "$DS_GRACE_HOUR" ]; then
  DS_ROW=$(curl -s --max-time 8 \
    -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" \
    "$SUPABASE_URL/rest/v1/daily_summaries?date=eq.${DS_TARGET}&select=date&limit=1" 2>/dev/null)
  if echo "$DS_ROW" | grep -q "\"${DS_TARGET}\""; then
    incident_clear "daily-summary-missing"
    rm -f "$DS_HEAL_MARKER" 2>/dev/null
  else
    ATTEMPT=$(incident_seen "daily-summary-missing")
    log "daily_summaries row missing for $DS_TARGET (attempt $ATTEMPT)"
    ISSUES="$ISSUES daily-summary(missing:$DS_TARGET)"

    if [ "${AUTH_OUTAGE_HELD:-0}" = "1" ] || [ "${AUTH_RECOVERY_PENDING:-0}" = "1" ]; then
      # See the deferral note above this block: no dispatch, no marker, no 🔴.
      # Also while the auth recovery is still being confirmed, because the heal
      # is re-armed only when that incident closes.
      log "daily-summary backfill + page deferred: Max auth outage open or its recovery not yet confirmed (watchdog's auth page covers it; the backfill runs once auth is back)"
    else
      # Self-heal: dispatch an idempotent backfill at most once per 24h. The
      # ops dispatcher routes any task starting with "DAILY SUMMARY" to the
      # daily-summary playbook; the trailing date backfills that specific day.
      SHOULD_HEAL=1
      if [ -f "$DS_HEAL_MARKER" ]; then
        HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$DS_HEAL_MARKER") ))
        [ "$HEAL_AGE" -lt 86400 ] && SHOULD_HEAL=0
      fi
      if [ "$SHOULD_HEAL" -eq 1 ]; then
        DS_TOKEN=$(cat "$HOME/Dev/edva/secrets/webhook-token" 2>/dev/null)
        curl -s --max-time 10 -X POST "http://localhost:9092" \
          -H "Content-Type: application/json" \
          ${DS_TOKEN:+-H "Authorization: Bearer $DS_TOKEN"} \
          -d "{\"task\":\"DAILY SUMMARY ${DS_TARGET}\",\"source\":\"watchdog-backfill\"}" > /dev/null 2>&1
        touch "$DS_HEAL_MARKER"
        log "Dispatched daily-summary backfill for $DS_TARGET (self-heal)"
      fi

      # Page only after the heal has had ≥20 min to land the row and it's still
      # missing — avoids paging while a freshly-dispatched backfill is running.
      HEAL_AGE=999999
      [ -f "$DS_HEAL_MARKER" ] && HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$DS_HEAL_MARKER") ))
      if [ "$HEAL_AGE" -ge 1200 ] && incident_should_alert "daily-summary-missing" 86400 2 86400; then
        notify "🔴 Daily-summary missing for $DS_TARGET — the ${DS_CRON_HOUR}:xx local-time cron didn't produce a daily_summaries row and a watchdog backfill dispatch didn't recover it. A day of episodic memory is at risk. Backfill manually: dispatch \"DAILY SUMMARY $DS_TARGET\" to the ops webhook, or check the ops supervisor (:9093) health + watchdog.log."
      fi
    fi
  fi
fi

# ── Episode-archive cron-miss detection.
# The episode-archive cron (07:25 home time — see tasks.json; the gate below derives it)
# ingests yesterday's daily_summaries row into
# the wiki as a `day_YYYY-MM-DD` page via `wiki-day-write`. A successful cron
# dispatch does not prove the page was written, so this checks the actual
# artifact (the wiki page); otherwise a gap can accumulate silently for weeks.
# Sibling of the daily-summary cron-miss block directly above (same
# heal-then-alert shape).
#
# Existence check differs from daily-summary's: there's no simple REST row to grep,
# so we shell out to the `wiki` CLI, which exits 0 when a page with the given id
# exists and non-zero (stderr: "no page with id ...") when it doesn't — verified
# directly: `wiki read day_2099-01-01` -> exit 1, an existing day page -> exit 0.
#
# Grace: the job's own scheduled hour + 2h, DERIVED from system/tasks.json
# rather than hardcoded: a hardcoded hour goes stale when the cron is moved,
# and then the watchdog probes nightly for a page that cannot exist yet (bogus
# "missing" lines, a wasted backfill, a false 🔴 page). Deriving the gate means
# a reschedule can't desync it.
EA_HEAL_MARKER="$HOME/Dev/edva/data/.episode-archive-heal-cooldown"
EA_CRON_HOUR=$("$NODE" "$HOME/Dev/edva/lib/registry.cjs" tasks 2>/dev/null \
  | jq -r '.tasks[] | select(.name=="episode-archive") | .schedule | split(" ")[1]' 2>/dev/null)
case "$EA_CRON_HOUR" in ''|*[!0-9]*) EA_CRON_HOUR=7 ;; esac  # fall back to the known schedule
EA_GATE_HOUR=$(( EA_CRON_HOUR + 2 ))
[ "$EA_GATE_HOUR" -gt 23 ] && EA_GATE_HOUR=23
if [ "$HOME_HOUR" -ge "$EA_GATE_HOUR" ]; then
  EA_TARGET=$(TZ="${EDVA_TZ:-UTC}" date -v-1d +%Y-%m-%d)
  if "$HOME/Dev/edva/bin/wiki" read "day_${EA_TARGET}" > /dev/null 2>&1; then
    incident_clear "episode-archive-missing"
    incident_clear "episode-archive-escalation"
    incident_clear "daily-summary-orphan-row"
    rm -f "$EA_HEAL_MARKER" 2>/dev/null
  else
    ATTEMPT=$(incident_seen "episode-archive-missing")
    # Log with exponential backoff — attempts 1, 2, 4, 8, 16, 32, 64... The probe
    # itself still runs every tick (a cheap local wiki read), but a fixed 2-min
    # log interval writes ~100+ identical lines a night, which buries genuine
    # incidents in the same file.
    if [ "$ATTEMPT" -le 2 ] || [ $(( ATTEMPT & (ATTEMPT - 1) )) -eq 0 ]; then
      log "wiki page day_${EA_TARGET} missing (attempt $ATTEMPT)"
    fi
    ISSUES="$ISSUES episode-archive(missing:$EA_TARGET)"

    # Self-heal: run the deterministic write directly, at most once per 24h.
    # Not an agent turn via the ops webhook: an agent can misread the playbook
    # (e.g. take "no delivery" as "no work" and skip the write while reporting
    # success), and a heal by the same kind of actor fails the same way.
    # wiki-day-write is one fixed command with no language judgment in it
    # (Rule #0b), matching the cron trigger (trigger-episode-archive.sh).
    SHOULD_HEAL=1
    if [ -f "$EA_HEAL_MARKER" ]; then
      HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$EA_HEAL_MARKER") ))
      [ "$HEAL_AGE" -lt 86400 ] && SHOULD_HEAL=0
    fi
    # The day writer is the installation's (optional): without it there is no
    # self-heal, only the pages below.
    EA_DAY_WRITER="$HOME/Dev/edva/bin/wiki-day-write"
    if [ "$SHOULD_HEAL" -eq 1 ] && [ -f "$EA_DAY_WRITER" ]; then
      EA_HEAL_OUT=$(timeout 60 node "$EA_DAY_WRITER" "$EA_TARGET" 2>&1)
      EA_HEAL_RC=$?
      touch "$EA_HEAL_MARKER"
      log "Self-heal: ran wiki-day-write $EA_TARGET directly (rc=$EA_HEAL_RC): ${EA_HEAL_OUT:-(no output)}"
    fi

    # Page only after the heal has had ≥20 min to land the page and it's still
    # missing — avoids paging while a freshly-dispatched backfill is running.
    HEAL_AGE=999999
    [ -f "$EA_HEAL_MARKER" ] && HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$EA_HEAL_MARKER") ))
    if [ "$HEAL_AGE" -ge 1200 ] && incident_should_alert "episode-archive-missing" 86400 2 86400; then
      notify "🔴 Episode-archive missing for $EA_TARGET — the ${EA_CRON_HOUR}:xx $(home_tz_label) cron didn't produce a day_${EA_TARGET} wiki page and a watchdog backfill dispatch didn't recover it. A day of episodic memory is at risk. Backfill manually: ~/Dev/edva/bin/wiki-day-write $EA_TARGET, or check the ops supervisor (:9093) health + watchdog.log."
    fi

    # ── Row-exists-but-no-wiki-page refinement.
    # The check above only proves the wiki page is missing — it can't tell you
    # WHY, and "why" is two different bugs with two different fixes: either
    # daily-summary never produced a row at all (nothing to archive — the
    # daily-summary-missing detector above already owns that case), or
    # daily-summary DID publish a row and episode-archive itself is the thing
    # failing to turn it into a page. The first case can wear the second's
    # symptom (e.g. a settle/prose/publish race leaves the row unwritten), and
    # one alert text for both makes it hard to diagnose. This block queries the row directly so the alert says which
    # one actually happened, and tracks it under its own incident key so a
    # genuine "row exists, archive is broken" case pages distinctly instead
    # of hiding inside the generic episode-archive-missing noise.
    DS_ROW_FOR_EA=$(curl -s --max-time 8 \
      -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" \
      "$SUPABASE_URL/rest/v1/daily_summaries?date=eq.${EA_TARGET}&select=date,narrative&limit=1" 2>/dev/null)
    if echo "$DS_ROW_FOR_EA" | grep -q '"narrative":"'; then
      ISSUES="$ISSUES daily-summary-orphan-row:$EA_TARGET"
      if [ "$HEAL_AGE" -ge 1200 ] && incident_should_alert "daily-summary-orphan-row" 86400 2 86400; then
        notify "🔴 daily_summaries has a published row for $EA_TARGET but day_${EA_TARGET} is still missing from the wiki — this is NOT a missing build (the row has a narrative). episode-archive itself is failing to render it. Run ~/Dev/edva/bin/wiki-day-write $EA_TARGET directly and check its output, or check the ops supervisor (:9093) health + watchdog.log."
      fi
    else
      incident_clear "daily-summary-orphan-row"
    fi

    # Escalation: still missing 3h past the grace window (~90 ticks) means the
    # self-heal has demonstrably failed and this is not transient. Separate
    # incident key so it isn't swallowed by the 24h cooldown on the 🔴 above.
    if [ "$ATTEMPT" -ge 90 ] && incident_should_alert "episode-archive-escalation" 86400 1 86400; then
      # kernel-closure-ok: advice text in a page, not a call
      notify "🚨 ESCALATION: day_${EA_TARGET} wiki page STILL missing after 3h and $ATTEMPT watchdog checks. Automated backfill has failed — this needs hands. Run ~/Dev/edva/bin/wiki-day-write $EA_TARGET, and check whether the ops supervisor (:9093) is dropping dispatches at /compact boundaries."
    fi
  fi
fi

# ── Nightly-review cron-miss detection.
# The nightly-review job (weekly, Tuesday 05:00 home time per tasks.json — this is the
# Self Improvement Review) reads the prior 7 days, emails a report, and stamps
# `last_run` in nightly-review-state.json as its own completion marker. A
# successful cron dispatch does not prove the review ran (it can silently
# no-op for weeks), so this watches the actual artifact (last_run itself).
# Same heal-then-alert shape as the detectors above.
#
# Unlike the two detectors above, the grace window here is expressed in DAYS,
# not an hour-of-day gate: nightly-review runs weekly (not nightly), so there's
# no "today's cron hour + 2h" to derive — the natural check is "how many days
# since last_run", with ~1 day of slack past the 7-day cadence before flagging.
NR_HEAL_MARKER="$HOME/Dev/edva/data/.nightly-review-heal-cooldown"
NR_STATE_FILE="$HOME/Dev/edva/data/nightly-review-state.json"
NR_LAST_RUN=$(jq -r '.last_run // empty' "$NR_STATE_FILE" 2>/dev/null)
NR_AGE_DAYS=999
if [ -n "$NR_LAST_RUN" ]; then
  NR_TODAY_EPOCH=$(date -j -u -f "%Y-%m-%d" "$(date -u +%Y-%m-%d)" +%s 2>/dev/null)
  NR_LAST_EPOCH=$(date -j -u -f "%Y-%m-%d" "${NR_LAST_RUN:0:10}" +%s 2>/dev/null)
  if [ -n "$NR_TODAY_EPOCH" ] && [ -n "$NR_LAST_EPOCH" ]; then
    NR_AGE_DAYS=$(( (NR_TODAY_EPOCH - NR_LAST_EPOCH) / 86400 ))
  fi
fi
if [ "$NR_AGE_DAYS" -ge 8 ]; then
  ATTEMPT=$(incident_seen "nightly-review-missing")
  log "nightly-review last_run is ${NR_AGE_DAYS}d stale (attempt $ATTEMPT)"
  ISSUES="$ISSUES nightly-review(stale:${NR_AGE_DAYS}d)"

  # Self-heal: re-run the weekly review, at most once per 24h.
  #
  # This KICKSTARTS THE LAUNCHD AGENT rather than POSTing to the :9092 webhook.
  # Two reasons, and the second is the load-bearing one:
  #   1. The review runs as a dedicated ephemeral Opus `claude -p`, because
  #      `model: opus` in job-routing.json is a tier label and the heavy
  #      supervisor runs Sonnet. A webhook heal would quietly heal it
  #      onto the wrong model — and skip the improvement-plan chain entirely.
  #   2. watchdog.sh runs from CRON, outside the GUI login session, so it cannot
  #      run `claude -p` itself — no keychain, no Max credentials, instant "Not
  #      logged in". `launchctl kickstart` in the
  #      gui domain hands the work to launchd, which runs it IN-session. That
  #      indirection is the whole point of the launchd agent existing.
  SHOULD_HEAL=1
  if [ -f "$NR_HEAL_MARKER" ]; then
    HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$NR_HEAL_MARKER") ))
    [ "$HEAL_AGE" -lt 86400 ] && SHOULD_HEAL=0
  fi
  if [ "$SHOULD_HEAL" -eq 1 ]; then
    launchctl kickstart -k "gui/$(id -u)/ai.claude.improvement-review" > /dev/null 2>&1
    touch "$NR_HEAL_MARKER"
    log "Kickstarted ai.claude.improvement-review (self-heal, last_run ${NR_AGE_DAYS}d stale)"
  fi

  # Page only after the heal has had a real chance to land — nightly-review is
  # an unbounded "ultrathink" pass over a full week of activity (its own
  # playbook explicitly says "no tool-call budget... take as many as the
  # analysis genuinely needs"), not a quick single-row backfill, so the 20-min
  # grace the daily-summary/episode-archive detectors use would almost always
  # fire while a legitimately-running heal is still in flight. 3h matches the
  # order of magnitude of a full weekly review.
  HEAL_AGE=999999
  [ -f "$NR_HEAL_MARKER" ] && HEAL_AGE=$(( $(date +%s) - $(stat -f%m "$NR_HEAL_MARKER") ))
  if [ "$HEAL_AGE" -ge 10800 ] && incident_should_alert "nightly-review-missing" 86400 2 86400; then
    notify "🔴 Nightly-review (weekly Self Improvement Review) hasn't updated last_run in ${NR_AGE_DAYS}d — the Tuesday 05:00 $(home_tz_label) launchd agent didn't produce a fresh nightly-review-state.json and a watchdog kickstart didn't recover it. A week+ of self-improvement analysis is at risk, and the improvement-plan cards that chain off it never got filed. Backfill manually: ~/Dev/edva/agent/scripts/trigger-nightly-review.sh, or check \`launchctl print gui/\$(id -u)/ai.claude.improvement-review\` + agent/logs/nightly-review.log."
  fi
else
  incident_clear "nightly-review-missing"
  rm -f "$NR_HEAL_MARKER" 2>/dev/null
fi

# The instance's own checks (_ext/watchdog-checks.sh, sourced at the top), at
# this point in the tick so they share its incident state and ISSUES summary.
if declare -F _ext_watchdog_checks >/dev/null; then _ext_watchdog_checks; fi

# --- Watch engine liveness (system/watch.md) ---
# hum-sense kicks `watch tick` at least once a minute; each tick stamps
# last_tick in watch-state.json. A stale stamp while watches are armed means
# the user's standing reminders are silently not being checked. Page after 30 min,
# confirmed on two watchdog runs, at most once a day.
WATCH_STATE="$HOME/Dev/edva/data/watch-state.json"
WATCH_ACTIVE=$(sqlite3 "$HOME/Dev/edva/data/memory-index.db" "SELECT count(*) FROM watch_rules WHERE status='active'" 2>/dev/null || echo 0)
case "$WATCH_ACTIVE" in ''|*[!0-9]*) WATCH_ACTIVE=0 ;; esac
if [ "$WATCH_ACTIVE" -gt 0 ] && [ -f "$WATCH_STATE" ]; then
  WATCH_LAST=$(jq -r '.last_tick // empty' "$WATCH_STATE" 2>/dev/null)
  WATCH_EPOCH=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${WATCH_LAST:0:19}" +%s 2>/dev/null)
  case "$WATCH_EPOCH" in ''|*[!0-9]*) WATCH_EPOCH="" ;; esac
  if [ -n "$WATCH_EPOCH" ] && [ $(( $(date +%s) - WATCH_EPOCH )) -ge 1800 ]; then
    ATTEMPT=$(incident_seen "watch-engine-stale")
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "watch-engine-stale" 86400 2 86400; then
      notify "⚠️ The watch engine hasn't run since ${WATCH_LAST} (${WATCH_ACTIVE} watches armed), so standing reminders aren't being checked. hum-sense kicks it: launchctl print gui/\$(id -u)/ai.claude.hum-sense; tail agent/logs/watch.log; manual pass: bin/watch tick --json."
    fi
  else
    incident_clear "watch-engine-stale" 2>/dev/null || true
  fi
fi

# --- Data-volume free space ---
# A full data volume fails quietly: hourly memory-DB snapshots
# (data/memory-db-snapshots) can fill it, after which other services on
# the host stall for lack of space, and nothing pages unless something looks
# at free space.
#
# Two incidents, one per threshold (disk_free_probe above):
#   disk-low       free < WATCHDOG_DISK_WARN_GIB (25) -> "⚠️ <host title> disk space low:"
#   disk-critical  free < WATCHDOG_DISK_CRIT_GIB (10) -> "🔴 <host title> disk space critical:"
# The ⚠️ row lands silently in the System tab and the 🔴 one pushes; that split
# is intended. Both page on the second consecutive tick, like the other probes,
# and the prefixes stay exactly as written: the nightly system-issue review
# clusters on them. No number goes into the ISSUES token (free space moves every
# tick, which would defeat log_on_change on the summary line).
#
# NO SELF-HEAL, deliberately: this block measures and reports, and never
# deletes, prunes or moves a file. What may be thrown away, backups above all,
# is an operator decision, and the fix for a filling disk is to find what is
# growing and stop it, not to delete whatever is biggest. The page names the
# folder that filled it last time so that search starts in the right place.
DISK_SNAPSHOT_DIR="$HOME/Dev/edva/data/memory-db-snapshots"
read -r DISK_LEVEL DISK_FREE_GIB DISK_USED_PCT DISK_DETAIL <<< "$(disk_free_probe "$HOME/Dev/edva/data")"
case "$DISK_LEVEL" in
  ok)
    incident_clear "disk-low"
    incident_clear "disk-critical"
    ;;
  low)
    incident_clear "disk-critical"
    ATTEMPT=$(incident_seen "disk-low")
    ISSUES="$ISSUES disk(low)"
    log_throttled "$HOME/Dev/edva/data/.watchdog-disk-low-log" \
      "Data volume ($DISK_DETAIL) free space low: ${DISK_FREE_GIB} GiB free, ${DISK_USED_PCT}% used (attempt $ATTEMPT)" 3600
    # The body (and its du) is built inside notify's argument, after
    # incident_should_alert has stashed PENDING_ALERT_KEY and before notify runs;
    # nothing in it calls notify, so the key reaches the right page.
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "disk-low"; then
      notify "⚠️ ${EDVA_HOST_TITLE:-Host} disk space low: $(disk_alert_body "$DISK_FREE_GIB" "$DISK_USED_PCT" "$DISK_SNAPSHOT_DIR")"
    fi
    ;;
  critical)
    # disk-low is left alone on a critical reading, neither counted nor cleared:
    # its condition still holds (under 10 GiB is under 25), so clearing it would
    # send a "✅ Recovered" while the disk is fuller than ever, and the 🔴 page
    # already says everything the ⚠️ one would.
    ATTEMPT=$(incident_seen "disk-critical")
    ISSUES="$ISSUES disk(critical)"
    log_throttled "$HOME/Dev/edva/data/.watchdog-disk-critical-log" \
      "Data volume ($DISK_DETAIL) free space CRITICAL: ${DISK_FREE_GIB} GiB free, ${DISK_USED_PCT}% used (attempt $ATTEMPT)" 3600
    if [ "$ATTEMPT" -ge 2 ] && incident_should_alert "disk-critical"; then
      notify "🔴 ${EDVA_HOST_TITLE:-Host} disk space critical: $(disk_alert_body "$DISK_FREE_GIB" "$DISK_USED_PCT" "$DISK_SNAPSHOT_DIR")"
    fi
    ;;
  *)
    # df failed or did not parse: no evidence either way, so no count, no
    # clear, no page (same reasoning as the tunnel's host-offline hold).
    ISSUES="$ISSUES disk(unknown)"
    log_throttled "$HOME/Dev/edva/data/.watchdog-disk-unknown-log" \
      "Data volume free space unreadable (${DISK_DETAIL:-no probe output}); not counted, not cleared, no page" 3600
    ;;
esac

if [ -n "$ISSUES" ]; then
  # Only log the summary when the set of issues actually changes. Prevents
  # 150+ duplicate lines during a long persistent incident (e.g. a Gmail push
  # gap logging the same Watchdog issues string every 5 min for hours).
  # Strip the gmail-push-gap duration so minor ms drift doesn't count as a
  # change — we key on the issue set, not the exact timing.
  ISSUE_KEY=$(echo "$ISSUES" | sed -E 's/gmail-push-gap\([0-9]+ms\)/gmail-push-gap/g')
  log_on_change "$HOME/Dev/edva/data/.watchdog-issues-key" \
    "$ISSUE_KEY" "Watchdog issues:$ISSUES"
else
  # Clear the marker on clean ticks so the next issue logs even if it
  # happens to produce the same key as the last incident.
  rm -f "$HOME/Dev/edva/data/.watchdog-issues-key" 2>/dev/null
fi

# --- Supervisor code reload: put each supervisor on the code that is on disk ---
# A supervisor loads its .mjs once at Node start, so a committed fix to it (an
# owner-approved Face-ID one included) does nothing until that process restarts,
# and nothing else restarts it, so a signed fix can sit unloaded for days while
# the bug it fixes keeps firing. The tool SIGTERMs at
# most one stale supervisor per tick, only when it is idle, its code is committed
# and parses; process-manager respawns it. Last in the tick on purpose: this
# tick's health checks have already run, and the respawn takes seconds, so the
# next tick sees it back up and nothing reads the gap as an outage. Holds and
# reloads go to this log only. It pages through here (the one authorized
# author) in two cases: exit 3 = a supervisor it reloaded did not come back
# (every further reload is held until one does), exit 4 = a supervisor has
# stayed on stale code for 6h because every tick found a reason to hold.
# It also reloads hum-sense (launchd), only
# between its passes. Exit 5 = something is still on old code or unreadable
# with no page due (or process-manager is down and nothing is known): neither
# page nor clear. The stale incident is cleared, and its recovery line sent,
# only on exit 0, when every target runs the code on disk. Kill switch: data/.supervisor-code-reload-off.
if [ ! -f "$HOME/Dev/edva/data/.supervisor-code-reload-off" ]; then
  node "$HOME/Dev/edva/bin/supervisor-code-reload" >> "$LOG" 2>&1
  SCR_RC=$?
  if [ "$SCR_RC" -eq 3 ]; then
    incident_seen "supervisor-code-reload-failed" > /dev/null
    SCR_FAILED=$(jq -r '._failed // empty' "$HOME/Dev/edva/data/supervisor-code-reload-state.json" 2>/dev/null)
    if incident_should_alert "supervisor-code-reload-failed"; then
      notify "🔴 A supervisor (or hum-sense) I restarted to load new code didn't come back (${SCR_FAILED:-unknown which; see the log}), and I've stopped reloading the others. The last committed change to its code most likely fails at startup. Details: grep supervisor-code-reload agent/logs/watchdog.log; to stop it: touch data/.supervisor-code-reload-off"
    fi
  elif [ "$SCR_RC" -ne 5 ]; then
    incident_clear "supervisor-code-reload-failed"
  fi
  if [ "$SCR_RC" -eq 4 ]; then
    incident_seen "supervisor-code-stale" > /dev/null
    if incident_should_alert "supervisor-code-stale"; then
      notify "⚠️ A supervisor (or hum-sense) has been running older code than what's committed for 6h+, so a fix on disk isn't live yet. The reload keeps holding; the reason is in watchdog.log (grep supervisor-code-reload). edva restart session loads it now (hum-sense: launchctl kickstart -k gui/\$(id -u)/ai.claude.hum-sense)."
    fi
  elif [ "$SCR_RC" -eq 0 ]; then
    incident_clear "supervisor-code-stale"
  fi
fi

# ── Stale code, the rest ─────────────────────────────────────────────────────
# bin/stale-code-watch restarts the SMALL daemons nothing above restarts
# (heartbeat-sender, minibeat, dashboard: launchctl kickstart -k; the two wiki
# servers: SIGTERM, process-manager respawns) as soon as their committed code is
# newer than the process, and flags what it must not restart itself: whatsapp-
# channel / phone-channel / process-manager on old code for 6h+, a restart that
# did not take, and tracked code files left uncommitted for 12h+. Exit 6 = flag
# (text in its state file's _flag), 0 = clear, 5 = could not read processes
# (neither). Restarts and holds go to this log. Kill switch: data/.stale-code-watch-off.
if [ ! -f "$HOME/Dev/edva/data/.stale-code-watch-off" ]; then
  node "$HOME/Dev/edva/bin/stale-code-watch" >> "$LOG" 2>&1
  SCW_RC=$?
  if [ "$SCW_RC" -eq 6 ]; then
    incident_seen "stale-code-flag" > /dev/null
    SCW_FLAG=$(jq -r '._flag // empty' "$HOME/Dev/edva/data/stale-code-watch-state.json" 2>/dev/null)
    if [ -n "$SCW_FLAG" ] && incident_should_alert "stale-code-flag"; then
      notify "$SCW_FLAG"
    fi
  elif [ "$SCW_RC" -eq 0 ]; then
    incident_clear "stale-code-flag"
  fi
fi
