#!/bin/bash
# run-hum-deliver-qual.sh — deliver a queued lane-diagnosis question under
# launchd (ai.claude.hum-deliver-qual), kicked by trigger-hum.sh's fallback
# tick when data/hum-qual-delivery-queue.json holds one.
#
# Same reason as run-hum-explore.sh: the question is sent through
# edva-send-curl, whose resolve-first gate and outbound precheck need the
# Max login, which only the GUI session can read. Without a verified login
# the question stays queued for a later tick (hum-deliver-qual drops it itself
# once past its deliver_by); nothing goes out unchecked and nobody is paged
# (watchdog.sh owns Max-outage alerts).
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
LOGFILE="$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"

source "$(dirname "$0")/lib/max-auth-guard.sh"   # CLAUDE.md § Auth Model
max_auth_scrub
if ! max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-deliver-qual] held: Max login check failed ($MAX_AUTH_SUMMARY); question left queued" >> "$LOGFILE"
  exit 0
fi

# Fail-safe by design: hum-deliver-qual logs its own outcome and exits 0.
node "$EDVA_INSTALL_TOOLS/bin/hum-deliver-qual" >> "$LOGFILE" 2>&1
