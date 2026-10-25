# max-auth-guard.sh — make sure an ephemeral `claude -p` can only run on the
# Max subscription, and refuse to start it otherwise. Sourced (bash) by
# run-ephemeral-opus.sh, run-ephemeral-fable.sh and the installation's own
# fork triggers, right before their `claude -p`.
#
# WHY. Builds requested through Edva must run on the host, on the
# subscription (a user rule). Stripping only ANTHROPIC_API_KEY and
# ANTHROPIC_AUTH_TOKEN is not enough: several other variables silently move
# Claude Code off it: CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY switch provider,
# CLAUDE_CODE_OAUTH_TOKEN swaps the keychain login for a token, and
# ANTHROPIC_BASE_URL sends every request to another endpoint while
# `claude auth status` still reports claude.ai (measured on the host under
# launchd). So the guard does two things, and both are needed:
#
#   1. max_auth_scrub — unset every ANTHROPIC_* and CLAUDE_CODE_USE_* variable,
#      plus CLAUDE_CODE_OAUTH_TOKEN and AWS_BEARER_TOKEN_BEDROCK. Covers what
#      `auth status` cannot see. (A <PROJECT>_ANTHROPIC_API_KEY in .env
#      does not start with ANTHROPIC_ and is not a variable Claude Code reads.)
#   2. max_auth_check — `claude auth status --json` (no model call, costs
#      nothing) must say loggedIn, authMethod "claude.ai", apiProvider
#      "firstParty", subscriptionType "max". Anything else, including a status
#      it cannot read, refuses: fail CLOSED, because the failure it prevents is
#      a silent bill, and a refused run pages loudly.
#
# The checks read the CLI's own JSON keys (machine structure, not language).
#
# Usage:
#   source "$ROOT/tools/agent/scripts/lib/max-auth-guard.sh"
#   max_auth_scrub
#   if ! max_auth_check "$CLAUDE"; then
#     log REFUSED …"$MAX_AUTH_SUMMARY"…
#     if max_auth_from_ssh; then …tell the operator on stderr, page nobody…
#     elif max_auth_outage_owned_by_watchdog; then …log only: watchdog.sh
#       already paged this sign-in outage, page nobody…
#     else …page the system channel…; fi
#     exit "$MAX_AUTH_REFUSED_RC"
#   fi
#
# Exit code convention for callers that refuse: 78 (EX_CONFIG), so a caller of
# the runner (trigger-chat-build.sh) can tell "refused to start" from "failed".
MAX_AUTH_REFUSED_RC=78

max_auth_scrub() {
  local v
  for v in $(compgen -e); do
    case "$v" in
      ANTHROPIC_*|CLAUDE_CODE_USE_*|CLAUDE_CODE_OAUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK) unset "$v" ;;
    esac
  done
}

# Sets MAX_AUTH_SUMMARY to a one-line description of what `auth status` said.
# Returns 0 only for a claude.ai login on the Max plan.
max_auth_check() {
  local claude="$1" out field
  out="$("$claude" auth status --json 2>&1)"
  field() { printf '%s' "$out" | grep -oE "\"$1\": *(\"[^\"]*\"|true|false)" | head -n1 | sed -E 's/^[^:]*: *//; s/"//g'; }
  MAX_AUTH_SUMMARY="loggedIn=$(field loggedIn) authMethod=$(field authMethod) apiProvider=$(field apiProvider) subscription=$(field subscriptionType)"
  [ "$(field loggedIn)" = "true" ] || return 1
  [ "$(field authMethod)" = "claude.ai" ] || return 1
  [ "$(field apiProvider)" = "firstParty" ] || return 1
  [ "$(field subscriptionType)" = "max" ] || return 1
  return 0
}

# Returns 0 when this process was started from an SSH session. Callers use it
# to decide whether a refusal pages.
#
# WHY. An SSH session cannot reach the login keychain that holds the Max
# credentials, so a run hand-launched over SSH always reads as logged out and
# refuses. That is the operator's shell, not an outage: a trigger run by hand
# over SSH refuses and would page "⚠️ <job> refused to start … sign Claude Code
# in to the Max account" while the same run works seconds later from a context
# that can reach the keychain. Such a refusal must still refuse and exit 78, but tell the person at
# the terminal instead of paging.
#
# sshd sets SSH_CONNECTION / SSH_CLIENT for every SSH login, and nothing
# unattended carries them: measured inside a live scheduled launchd run
# (trigger PPID 1 -> runner -> claude -> shell), process-manager, all four
# supervisors, cron and cron-run, none had either. Do NOT use SSH_AUTH_SOCK —
# launchd sets it for every GUI-session job. XPC_SERVICE_NAME is refuted too
# (scheduled runs present "0" as well). Same discriminator as
# bin/daily-summary-run's SSH guard. The `:-` defaults are
# required: callers run with `set -u`.
max_auth_from_ssh() {
  [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}" ]
}

# Returns 0 when this refusal is part of a Max sign-in outage that watchdog.sh
# already pages, so the caller logs it and pages nobody.
#
# WHY. During a Max sign-in outage watchdog.sh pages it once (🔴 "Max auth is
# down … Run `claude /login`"); without this, every scheduled job that starts
# during the outage pages its own "⚠️ <job> refused to start: this run's
# `claude auth status` was not the Max subscription (loggedIn=false
# authMethod=none …)" row with the same remedy. The system channel carries only
# what the user can or should act on (a user rule), and only watchdog.sh
# authors infrastructure alerts (agent/CLAUDE.md § System Channel); a
# refusal during an outage it has already paged tells the user nothing new.
#
# All three must hold, and anything else returns 1 so the caller still pages:
#   (a) this run's own check read signed OUT (loggedIn=false in
#       MAX_AUTH_SUMMARY, the CLI's key=value structure, not language). A wrong
#       plan, an API-key login or a provider switch is not an outage watchdog
#       sees, so those keep paging.
#   (b) lib/max-auth-probe.sh's launchd reading is fresh, failing, and has been
#       failing long enough that watchdog.sh pages it (MAX_AUTH_PROBE_FAIL_SEC
#       >= MAX_AUTH_WATCHDOG_PAGE_SEC). A single reading, a signed-in, stale or
#       missing record, or a missing probe lib does not count — so a dead
#       live-day or a week-old file cannot hush a refusal.
#   (c) watchdog actually DELIVERED its page for the open auth-outage incident:
#       both "$WATCHDOG_INCIDENT_DIR/auth-outage.alerted" (incident_should_alert
#       authorised a page) and ".delivered" (notify() saw it land) exist.
#       A failing probe alone is not enough: watchdog's "restored" and
#       "pre-heal" overrides hold a failing reading without paging, and an
#       undelivered page rolls .alerted back. incident_clear removes both after
#       3 green ticks, so they cannot outlive the outage.
# Never exits or errors the caller: safe under `set -euo pipefail` (callers use
# it as an `if` condition) and the `:-` defaults cover `set -u`.

# Mirrors watchdog.sh's paging threshold for the launchd sign-in check
# (`[ "$MAX_AUTH_PROBE_FAIL_SEC" -lt 540 ]` there = "not paging until the next
# check confirms it"). Keep the two equal; a lower value here would hush a
# refusal before watchdog has paged anything.
MAX_AUTH_WATCHDOG_PAGE_SEC=540

max_auth_outage_owned_by_watchdog() {
  case " ${MAX_AUTH_SUMMARY:-} " in
    *" loggedIn=false "*) ;;
    *) return 1 ;;
  esac
  local probe_lib
  probe_lib="$(dirname "${BASH_SOURCE[0]:-.}")/max-auth-probe.sh"
  [ -r "$probe_lib" ] || return 1
  # shellcheck source=max-auth-probe.sh
  source "$probe_lib" 2>/dev/null || return 1
  declare -F max_auth_probe_read >/dev/null 2>&1 || return 1
  max_auth_probe_read "$(date +%s)" 1200 2>/dev/null || return 1
  [ "${MAX_AUTH_PROBE_STATE:-}" = "fail" ] || return 1
  case "${MAX_AUTH_PROBE_FAIL_SEC:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$MAX_AUTH_PROBE_FAIL_SEC" -ge "$MAX_AUTH_WATCHDOG_PAGE_SEC" ] || return 1
  # watchdog.sh's INCIDENT_DIR; env-overridable for tests.
  local incidents="${WATCHDOG_INCIDENT_DIR:-${HOME:-}/Dev/edva/data/watchdog-incidents}"
  [ -f "$incidents/auth-outage.alerted" ] || return 1
  [ -f "$incidents/auth-outage.delivered" ] || return 1
  return 0
}
