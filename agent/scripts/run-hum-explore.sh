#!/bin/bash
# run-hum-explore.sh — the hum-explore run itself, under launchd
# (ai.claude.hum-explore), kicked twice a day by cron's trigger-hum-explore.sh.
# Playbook: agent/ops-agent/jobs/hum-explore.md.
#
# Why launchd: the pick is sent through edva-send-curl, whose resolve-first
# gate and outbound precheck are tool-less `claude -p` calls on the Max login,
# and only the GUI session can read it. Both gates fail open, so from cron a
# pick would go out unchecked. A borderline pick is optional
# by nature, so without a verified Max login it is held, never sent unchecked.
# A held run pages nobody: watchdog.sh owns Max-outage alerts.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
LOGFILE="$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-explore] $1" >> "$LOGFILE"; }

source "$(dirname "$0")/lib/max-auth-guard.sh"   # CLAUDE.md § Auth Model
max_auth_scrub
if ! max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
  log "held: Max login check failed ($MAX_AUTH_SUMMARY); no pick goes out without the resolve-first check"
  exit 0
fi

OUT=$("$EDVA_INSTALL_TOOLS/bin/hum-explore-run" 2>&1); RC=$?
if [ $RC -eq 0 ]; then log "ok: $(echo "$OUT" | tail -1 | cut -c1-200)"
else log "FAILED ($RC): $(echo "$OUT" | tail -1 | cut -c1-200)"; fi
exit $RC
