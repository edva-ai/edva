#!/usr/bin/env bash
# launchd-kick.sh — run a scripted job inside the GUI session from a cron line.
#
# The scripted jobs (event-watch lanes, morning-digest-run, newsletter-digest-run,
# and the installation's own *-run scripts) make one tool-less `claude -p` judgment
# on the Max subscription. `claude -p` can only read the Max credential from the
# login keychain inside the GUI (Aqua) session — from cron it prints "Not logged
# in" and exits 0 (agent/CLAUDE.md § Effort Policy). So the schedule stays in cron (and in
# clock-jobs.json, for local-time jobs like morning-digest), and cron hands the
# run to an on-demand launchd user agent with `launchctl kickstart` — the same
# mechanism watchdog.sh already uses.
#
# No `-k`: if a run is still going, a second kick is a no-op rather than a kill.
#
# SELF-INSTALL. A change that moves a job onto a new agent lands its plist in
# agent/launch-agents/, but nothing else copies it into
# ~/Library/LaunchAgents, so the agent stays inert until someone hand-installs
# it (runs fail "Could not find service" and the System tab gets "<job> did not
# run: its launchd agent is not loaded … Install it with: cp …").
# So a failed kick installs the repo plist itself (launchd_ensure_installed)
# and kicks once more; the page goes out only when that fails too. Only an
# on-demand agent (runs when kicked, nothing else) is installed this way. A copy already
# in ~/Library/LaunchAgents that is not loaded was booted out on purpose (launchd
# loads every plist there at login), and is left alone.
# Test: tests/launchd-kick-self-install.test.mjs.
#
# Usage (from a trigger script):
#   source "$(dirname "$0")/lib/launchd-kick.sh"
#   launchd_kick ai.claude.example-watch example-watch

# The kernel's repo plists are templates (__EDVA_HOME__ / __EDVA_TOOLS__ / __HOME__): an install
# renders them (lib/launchd-render.sh), never copies them verbatim.
source "$(dirname "${BASH_SOURCE[0]}")/launchd-render.sh"

# launchd_ensure_installed <label> [job] — 0 if the agent is loaded on return.
# Sets LAUNCHD_INSTALL_ERR (why an install failed) and LAUNCHD_INSTALLED (1 when
# this call installed it) for the caller.
launchd_ensure_installed() {
  local label="$1" job="${2:-$1}"
  local logfile="$HOME/Dev/edva/agent/logs/watchdog.log"
  local domain="gui/$(id -u)"
  local src="$HOME/Dev/edva/agent/launch-agents/$label.plist"
  local dst="$HOME/Library/LaunchAgents/$label.plist"
  local out
  LAUNCHD_INSTALL_ERR="" LAUNCHD_INSTALLED=""
  launchctl print "$domain/$label" >/dev/null 2>&1 && return 0
  [ -f "$src" ] || return 1
  if [ -e "$dst" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] launchd agent $label is in ~/Library/LaunchAgents: present but not loaded — leaving it (booted out on purpose?)" >> "$logfile"
    return 1
  fi
  if ! plutil -lint "$src" >/dev/null 2>&1 || [ "$(plutil -extract Label raw "$src" 2>/dev/null)" != "$label" ]; then
    LAUNCHD_INSTALL_ERR="the repo plist $label.plist does not lint or its Label is not $label"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] ERROR: not installing $label: $LAUNCHD_INSTALL_ERR" >> "$logfile"
    return 1
  fi
  # On-demand agents only. One that would also start by itself (at load, kept
  # alive, on a schedule or a watch) is installed by whoever wrote it, never by a kick.
  local key val
  for key in RunAtLoad KeepAlive StartCalendarInterval StartInterval WatchPaths QueueDirectories StartOnMount; do
    val=$(plutil -extract "$key" raw "$src" 2>/dev/null) || continue
    [ "$val" = "false" ] && continue
    LAUNCHD_INSTALL_ERR="the repo plist $label.plist would start by itself ($key), so it is installed by hand, not by a kick"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] ERROR: not installing $label: $LAUNCHD_INSTALL_ERR" >> "$logfile"
    return 1
  done
  if ! out=$(mkdir -p "$HOME/Library/LaunchAgents" 2>&1 && launchd_render_plist "$src" "$dst" 2>&1 \
      && launchctl bootstrap "$domain" "$dst" 2>&1); then
    # Not left behind: a copy that is present but not loaded reads as booted out on purpose.
    rm -f "$dst"
    out="${out//$'\n'/ }"
    LAUNCHD_INSTALL_ERR="${out:0:200}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] ERROR: installing launchd agent $label failed: $LAUNCHD_INSTALL_ERR" >> "$logfile"
    return 1
  fi
  LAUNCHD_INSTALLED=1
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] installed launchd agent $label from the repo (it was added but never installed)" >> "$logfile"
  return 0
}

launchd_kick() {
  local label="$1" job="${2:-$1}"
  local logfile="$HOME/Dev/edva/agent/logs/watchdog.log"
  local out note=""
  if out=$(launchctl kickstart "gui/$(id -u)/$label" 2>&1); then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] kicked launchd agent $label" >> "$logfile"
    return 0
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] ERROR: launchctl kickstart $label failed: $out" >> "$logfile"
  # Added in the repo but never installed: install it, kick once more.
  if launchd_ensure_installed "$label" "$job"; then
    if out=$(launchctl kickstart "gui/$(id -u)/$label" 2>&1); then
      if [ -n "$LAUNCHD_INSTALLED" ]; then note=" (after installing it)"; else note=" (second try)"; fi
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] kicked launchd agent $label$note" >> "$logfile"
      return 0
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] ERROR: launchctl kickstart $label failed again: $out" >> "$logfile"
  fi
  [ -z "${LAUNCHD_INSTALL_ERR:-}" ] || note=" (Installing it automatically failed: $LAUNCHD_INSTALL_ERR)"
  # How alerts name this machine: the instance's host_label (lib/instance.sh;
  # "the host" by default).
  [ -n "${EDVA_HOST_LABEL:-}" ] || source "$(dirname "${BASH_SOURCE[0]}")/instance.sh"
  # A job reporting its own failure (class 5, agent/CLAUDE.md § Outbound Precheck).
  # geo-gate-ok: system-channel infra note about a missing launchd agent, not an event recommendation.
  "$HOME/Dev/edva/bin/edva-send-curl" --channel system --skip-precheck --intent "$job" \
    "$job did not run: its launchd agent $label is not loaded on ${EDVA_HOST_LABEL:-the host}. Install it with: ~/Dev/edva/agent/launch-agents/install.sh $label (renders agent/launch-agents/$label.plist into ~/Library/LaunchAgents and bootstraps it)$note" \
    > /dev/null 2>&1 || true
  return 1
}
