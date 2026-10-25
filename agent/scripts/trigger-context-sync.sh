#!/bin/bash
# Trigger context sync — runs directly (no webhook, no agent needed).
# Indexes Apple Notes, iMessage, email memories, and project files into context.db.
#
# Safety: single-instance shlock + 20m hard timeout. Without them, a sync hung
# on an expired OAuth token lets the 30-min cron stack ~20 instances and starve
# a RAM-constrained host into a hard power-cycle.
export PATH="/opt/homebrew/bin:$PATH"
BIN="$HOME/Dev/edva/bin"
LOG="$HOME/Dev/edva/agent/logs/context-sync.log"
LOCK="$HOME/Dev/edva/agent/logs/context-sync.lock"

# The installation's own work that rides this tick (optional hook
# _ext/context-sync-tick.sh; none in a plain install). Capped at 2 min and
# never fatal, so it cannot hold up or fail the sync below.
TICK_EXT="$(dirname "$0")/_ext/context-sync-tick.sh"
if [ -x "$TICK_EXT" ]; then
  /opt/homebrew/bin/timeout --kill-after=10s 2m "$TICK_EXT" > /dev/null 2>&1 || true
fi

# shlock atomically creates LOCK with our PID; returns 1 if a live PID holds it.
if ! /usr/bin/shlock -p $$ -f "$LOCK" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') Skipping — sync still running (pid $(cat "$LOCK" 2>/dev/null))" >> "$LOG"
  exit 0
fi
trap 'rm -f "$LOCK"' EXIT INT TERM

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting context sync" >> "$LOG"
/opt/homebrew/bin/timeout --signal=TERM --kill-after=30s 20m node "$BIN/context-sync" all >> "$LOG" 2>&1
EXIT=$?
if [ "$EXIT" -eq 124 ] || [ "$EXIT" -eq 137 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') TIMED OUT after 20m (exit $EXIT)" >> "$LOG"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') Done (exit $EXIT)" >> "$LOG"
fi
