#!/usr/bin/env bash
# ci-keychain-lock.sh — shared, crash-safe mutex + helpers for mutating the
# macOS *user keychain search list* from CI. Sourced (not executed) by the
# signing workflows: `source "$GITHUB_WORKSPACE/.github/scripts/ci-keychain-lock.sh"`.
#
# ┌────────────────────────────────────────────────────────────────────────────┐
# │ CANONICAL SOURCE: the gandalf repo, .github/scripts/ci-keychain-lock.sh     │
# │                                                                            │
# │ Every macOS-signing repo on the shared self-hosted mini vendors a BYTE-     │
# │ IDENTICAL copy of this file. Do NOT edit a vendored copy — edit the         │
# │ canonical one, bump KC_LOCK_LIB_VERSION, and re-vendor everywhere.          │
# │ `tools/bin/ci-keychain-lock-audit` (in gandalf) compares every downstream   │
# │ copy by sha256 and fails on drift, so divergence is caught, not discovered. │
# │                                                                            │
# │ The lock path is deliberately HOST-WIDE and identical in every repo: these  │
# │ repos all sign on the same mini, so they must contend for the SAME lock or  │
# │ the serialization is worthless. The "gandalf-" prefix is historical, not    │
# │ ownership.                                                                  │
# └────────────────────────────────────────────────────────────────────────────┘
KC_LOCK_LIB_VERSION="1"
#
# WHY A MUTEX AT ALL
# `security list-keychains -d user -s <list>` is a whole-list REPLACE, not an
# append, so every caller must read-modify-write. That list is global state
# shared by every self-hosted runner on this host. Two concurrent signing jobs
# racing it lose each other's entry, and a list written from a stale read can
# drop login.keychain-db entirely — which takes Gandalf's Max auth down, because
# the OAuth token lives in the login keychain and there is no API-key fallback
# by design. See tools/system/architecture.md 2026-07-28.
#
# WHY CRASH-SAFE
# The original lock was a bare `mkdir` with no owner and no expiry. A job
# SIGKILLed between acquire and release (cancelled workflow, runner restart,
# machine sleep) held it forever; every later job then spun the full timeout and
# proceeded UNSYNCHRONIZED. The serialization silently disappeared exactly when
# builds were being cancelled most — i.e. precisely when it was needed. Two
# independent protections now cover the two distinct death modes:
#   1. trap-based release — a step that fails, errors, or exits early.
#   2. stale-lock breaking — SIGKILL / runner death, where no trap ever runs.
# Neither alone is sufficient: (1) cannot survive SIGKILL, and (2) alone would
# leave every ordinary failure holding the lock for the full stale window.

KC_LOCK="${KC_LOCK:-/tmp/gandalf-ci-keychain.lock}"
# Generous: the critical section is a couple of `security` calls (sub-second).
# Anything holding it for 5 minutes is dead, not slow.
KC_LOCK_STALE_SECS="${KC_LOCK_STALE_SECS:-300}"
KC_LOCK_WAIT_SECS="${KC_LOCK_WAIT_SECS:-60}"
KC_LOGIN_KEYCHAIN="${KC_LOGIN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
KC_LOCK_HELD=0

# Acquire the lock. ALWAYS returns 0 — a failure to acquire is a loud warning,
# not a build failure, because refusing to sign is worse than signing
# unserialized. Callers are therefore safe under `set -e`.
kc_lock_acquire() {
  local waited=0 age owner
  while [ "$waited" -lt "$KC_LOCK_WAIT_SECS" ]; do
    if mkdir "$KC_LOCK" 2>/dev/null; then
      KC_LOCK_HELD=1
      printf '%s %s %s\n' "${GITHUB_RUN_ID:-local}" "$$" "$(date +%s)" \
        > "$KC_LOCK/owner" 2>/dev/null || true
      # Backstop for ordinary failure paths; SIGKILL is covered by staleness.
      trap 'kc_lock_release' EXIT
      return 0
    fi
    # `stat` failing (lock vanished mid-check) yields age=now, which trips the
    # stale branch, does a harmless rm -rf, and retries. That is correct.
    age=$(( $(date +%s) - $(stat -f %m "$KC_LOCK" 2>/dev/null || echo 0) ))
    if [ "$age" -gt "$KC_LOCK_STALE_SECS" ]; then
      owner=$(cat "$KC_LOCK/owner" 2>/dev/null || echo "unknown")
      echo "ci-keychain-lock: breaking STALE lock (age ${age}s, owner: ${owner})" >&2
      rm -rf "$KC_LOCK" 2>/dev/null || true
      waited=$(( waited + 1 ))
      continue
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  echo "ci-keychain-lock: WARNING could not acquire within ${KC_LOCK_WAIT_SECS}s — proceeding UNSERIALIZED" >&2
  return 0
}

# Release only if THIS shell holds it, so a job that proceeded unserialized can
# never delete the lock out from under the job that actually owns it.
kc_lock_release() {
  [ "$KC_LOCK_HELD" = "1" ] || return 0
  rm -rf "$KC_LOCK" 2>/dev/null || true
  KC_LOCK_HELD=0
  trap - EXIT
}

# Prepend $1 to the user search list, preserving every other entry.
kc_prepend() {
  local add="$1" current filtered
  current=$(security list-keychains -d user | tr -d '"' | xargs)
  filtered=$(echo "$current" | tr ' ' '\n' | grep -vxF "$add" | grep -v '^$' | tr '\n' ' ')
  # Unquoted on purpose: the list must word-split into separate arguments.
  security list-keychains -d user -s "$add" $filtered
}

# Remove $1 from the user search list. NEVER emits an empty list: `security
# list-keychains -d user -s` with no arguments SETS AN EMPTY LIST rather than
# doing nothing, which evicts login.keychain-db and takes Gandalf auth down.
# login is therefore re-added explicitly whenever it is absent.
kc_remove() {
  local drop="$1" remaining
  remaining=$(security list-keychains -d user | tr -d '"' | xargs | tr ' ' '\n' \
    | grep -vxF "$drop" | grep -v '^$' | tr '\n' ' ')
  case " $remaining " in
    *" $KC_LOGIN_KEYCHAIN "*) ;;
    *) remaining="$KC_LOGIN_KEYCHAIN $remaining" ;;
  esac
  # Unquoted on purpose: see kc_prepend.
  security list-keychains -d user -s $remaining
}
