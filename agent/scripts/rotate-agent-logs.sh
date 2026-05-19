#!/bin/bash
# rotate-agent-logs.sh — rotates supervisor + watchdog logs nightly, keeps 14 days.
# Uses copytruncate so open file descriptors in ManagedProcess (createWriteStream)
# and launchd (StandardErrorPath) keep writing to the same path without reopen.
#
# Cron: 0 3 * * * ${MERLIN_HOME_USER}/dev/merlin/agent/scripts/rotate-agent-logs.sh
#
# Replaces the pre-process-manager tmux pipe-pane rotation (was rotating
# chat-agent.log / ops-agent.log that no longer exist).

set -u
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

LOGDIR="${MERLIN_HOME}/agent/logs"
KEEP_DAYS=14
DATE=$(date '+%Y-%m-%d')

# Files to rotate. Extend this list when a new long-lived log appears.
FILES=(
  "$LOGDIR/ops-supervisor.log"
  "$LOGDIR/chat-supervisor.log"
  "$LOGDIR/hookdeck.log"
  "$LOGDIR/claude-launchagent.err.log"
  "$LOGDIR/claude-launchagent.log"
  "$LOGDIR/watchdog.log"
  "$LOGDIR/context-sync.log"
  "$LOGDIR/ack-trace.log"
)

rotated=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  [ -s "$f" ] || continue  # skip empty
  dated="${f%.log}-$DATE.log"
  # Error-named files (e.g. claude-launchagent.err.log) come out as foo.err-DATE.log
  # which is fine for sort-by-name; the .log suffix is just convention.
  # copytruncate: cp content to dated, then truncate in-place (keeps the
  # inode, so any open writer keeps appending at offset 0 after truncate).
  if cp "$f" "$dated" 2>/dev/null; then
    : > "$f"
    rotated=$((rotated + 1))
  fi
done

# Compress yesterday's rotated files (today's stays plain for easy reading).
yesterday=$(date -v-1d '+%Y-%m-%d')
for f in "$LOGDIR"/*-"$yesterday".log "$LOGDIR"/*-"$yesterday".err.log; do
  [ -f "$f" ] && gzip -f "$f" 2>/dev/null
done

# Purge rotated + gzipped logs older than KEEP_DAYS.
find "$LOGDIR" -type f \( -name "*-????-??-??.log" -o -name "*-????-??-??.log.gz" -o -name "*-????-??-??.err.log" -o -name "*-????-??-??.err.log.gz" \) -mtime +"$KEEP_DAYS" -delete 2>/dev/null

echo "$(date '+%Y-%m-%d %H:%M:%S') rotate-agent-logs: rotated $rotated file(s)" >> "$LOGDIR/claude-launchagent.log"
