#!/usr/bin/env bash
# ci-signing-assets.sh — per-job scoping for the OTHER shared per-user state a
# macOS signing job touches: provisioning profiles and App Store Connect API
# keys. Sourced (not executed):
#   source "$GITHUB_WORKSPACE/.github/scripts/ci-signing-assets.sh"
#
# ┌────────────────────────────────────────────────────────────────────────────┐
# │ CANONICAL SOURCE: the gandalf repo, .github/scripts/ci-signing-assets.sh    │
# │ Every signing repo vendors a BYTE-IDENTICAL copy. Do not edit a vendored    │
# │ copy — edit canonical, bump SA_LIB_VERSION, re-vendor everywhere.           │
# │ `tools/bin/ci-keychain-lock-audit` compares copies by sha256.               │
# └────────────────────────────────────────────────────────────────────────────┘
SA_LIB_VERSION="1"
#
# WHY THIS EXISTS
# `~/Library/MobileDevice/Provisioning Profiles/` and `~/private_keys/` are
# per-USER, not per-job. Every signing workflow on this shared mini was clearing
# them with globs:
#     rm -f ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision
#     rm -f ~/private_keys/AuthKey_*.p8
# so the first job to reach setup or teardown deleted every other in-flight
# job's signing assets. Observed 2026-07-28: a Butterfly build died with
# "AuthKey_***.p8 ... no such file" and Tracker with "No App Store profile ...
# found on this runner", both while sibling builds ran.
#
# This is the SAME defect class as the keychain search list (see
# ci-keychain-lock.sh): shared global per-user state mutated without per-job
# scoping. The keychain version took Gandalf's Max auth down; this version
# breaks sibling builds.
#
# The hygiene the globs were reaching for — "no stale duplicate profile for MY
# app" — is preserved: sa_install_profile prunes existing profiles carrying the
# SAME application-identifier as the one being installed, and nothing else.
# That needs no hardcoded bundle id: it is read out of the profile itself.

SA_PROFILES_DIR="${SA_PROFILES_DIR:-$HOME/Library/MobileDevice/Provisioning Profiles}"
# Overridable so the logic below is testable without Apple's CMS decoder.
SA_SECURITY="${SA_SECURITY:-/usr/bin/security}"
SA_PLISTBUDDY="${SA_PLISTBUDDY:-/usr/libexec/PlistBuddy}"

# sa__field <profile-path> <plist-key> — echo one field, EMPTY on failure.
#
# The here-string is load-bearing: PlistBuddy needs a SEEKABLE file and cannot
# read a pipe. `security ... | PlistBuddy /dev/stdin` returns the literal string
# "Error Reading File: /dev/stdin" — and it prints that to STDOUT, so 2>/dev/null
# does not hide it. The first version of this function piped, and the bogus value
# flowed through as a UUID: foodierank installed "Error.mobileprovision" and the
# archive failed with "No profile for team". `<<<` materialises a temp file,
# which is what the hand-rolled code this replaced always did.
sa__field() {
  local plist out
  plist=$("$SA_SECURITY" cms -D -i "$1" 2>/dev/null) || return 0
  [ -n "$plist" ] || return 0
  out=$("$SA_PLISTBUDDY" -c "Print $2" /dev/stdin <<< "$plist" 2>/dev/null) || return 0
  # PlistBuddy reports failures on stdout ("Error Reading File:", "Does Not
  # Exist"), so a non-zero exit is not the only failure signal. Emit nothing
  # rather than let an error string masquerade as a value.
  case "$out" in
    *"Error Reading File"*|*"Does Not Exist"*|*"Unexpected Character"*) return 0 ;;
  esac
  printf '%s' "$out"
}

# sa_install_profile <decoded-profile-path> [extension]
#   extension: mobileprovision (default, iOS) | provisionprofile (macOS)
# Prunes same-app-id profiles, installs under the UUID filename Xcode expects,
# and records the path so sa_cleanup_installed can remove exactly this one.
# Echoes "<uuid> <name>" for callers that need to pin a specifier.
sa_install_profile() {
  local src="$1" ext="${2:-mobileprovision}" app_id uuid name existing e_id
  [ -f "$src" ] || { echo "sa_install_profile: no such file: $src" >&2; return 1; }
  app_id=$(sa__field "$src" "Entitlements:application-identifier")
  uuid=$(sa__field "$src" "UUID")
  name=$(sa__field "$src" "Name")
  # A malformed UUID means the decode failed. Refuse rather than install
  # something like "Error.mobileprovision" and fail later in the archive.
  case "$uuid" in
    "" ) echo "sa_install_profile: no UUID in $src" >&2; return 1 ;;
    *[!0-9A-Fa-f-]* ) echo "sa_install_profile: implausible UUID '$uuid' from $src" >&2; return 1 ;;
  esac

  mkdir -p "$SA_PROFILES_DIR"
  # Prune ONLY profiles for the same application-identifier — the stale-match
  # hygiene the blanket `rm -f *` was after, without touching other apps.
  if [ -n "$app_id" ]; then
    for existing in "$SA_PROFILES_DIR"/*.mobileprovision "$SA_PROFILES_DIR"/*.provisionprofile; do
      [ -f "$existing" ] || continue
      e_id=$(sa__field "$existing" "Entitlements:application-identifier")
      [ -n "$e_id" ] && [ "$e_id" = "$app_id" ] && rm -f "$existing"
    done
  fi

  cp "$src" "$SA_PROFILES_DIR/$uuid.$ext"
  # Record for teardown. GITHUB_ENV persists across steps; the shell var covers
  # same-step use and local runs.
  SA_INSTALLED="${SA_INSTALLED:+$SA_INSTALLED:}$SA_PROFILES_DIR/$uuid.$ext"
  [ -n "${GITHUB_ENV:-}" ] && echo "SA_INSTALLED=$SA_INSTALLED" >> "$GITHUB_ENV"
  echo "$uuid $name"
}

# sa_cleanup_installed — remove ONLY the profiles this job installed.
sa_cleanup_installed() {
  local IFS=':' p
  for p in ${SA_INSTALLED:-}; do
    [ -n "$p" ] && rm -f "$p"
  done
}

# sa_asc_key_stage <key-id> <pem-contents> [dir]
#   Writes AuthKey_<id>.p8 0600 into dir (default ~/private_keys) and echoes the
#   path. Never globs.
sa_asc_key_stage() {
  local id="$1" pem="$2" dir="${3:-$HOME/private_keys}"
  [ -n "$id" ] || { echo "sa_asc_key_stage: empty key id" >&2; return 1; }
  mkdir -p "$dir"
  ( umask 077; printf '%s\n' "$pem" > "$dir/AuthKey_$id.p8" )
  chmod 600 "$dir/AuthKey_$id.p8" 2>/dev/null || true
  echo "$dir/AuthKey_$id.p8"
}

# sa_asc_key_remove <key-id> [dir...] — remove ONLY this job's key, from every
# directory altool is known to search. NEVER `AuthKey_*.p8`: several repos stage
# keys into the same per-user directories on this host, so a glob deletes
# sibling jobs' credentials mid-build.
sa_asc_key_remove() {
  local id="$1" d
  [ -n "$id" ] || return 0
  for d in "$HOME/private_keys" "$HOME/.private_keys" "$HOME/.appstoreconnect/private_keys" "${@:2}"; do
    [ -n "$d" ] && rm -f "$d/AuthKey_$id.p8"
  done
}
