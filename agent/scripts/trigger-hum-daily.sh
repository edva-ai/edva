#!/bin/bash
# hum-daily — nightly (23:00 local) chronicle of the last 24h of hum ticks.
# See jobs/hum-daily.md.
#
# A DIRECT script, no webhook and no agent turn. Every number in
# the report is arithmetic over hum-runs/hum-feedback/hum-learnings, and the
# row is a fixed aggregate — bin/hum-daily-run does all of it, and it
# RECORDS to data/hum-daily.jsonl instead of emailing. (As a Sonnet agent
# turn it was a steady daily cost for nothing but counting and table-building.)
# Failures go to watchdog.log.
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
LOGFILE="$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [hum-daily] $1" >> "$LOGFILE"; }

OUT=$("$EDVA_INSTALL_TOOLS/bin/hum-daily-run" 2>&1); RC=$?
if [ $RC -eq 0 ]; then log "ok: $(echo "$OUT" | tail -1 | cut -c1-200)"
else log "FAILED ($RC): $(echo "$OUT" | tail -1 | cut -c1-200)"; fi
exit $RC
