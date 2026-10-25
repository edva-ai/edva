#!/bin/bash
# trigger-memory-snapshot.sh — wraps `memory-snapshot` for cron.
#
# Runs every 30 min from tasks.json. Commits any changes in the auto-memory
# dir to its own git repo (~/.claude/projects/<project-dir>/memory/)
# and pushes to the private personal backup repo configured in memory-snapshot.
#
# Idempotent — exits 0 with no-op output when there are no changes.
# All output goes to agent/logs/memory-snapshot.log; cron itself sees
# only success/failure exit codes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/memory-snapshot.log"

mkdir -p "$LOG_DIR"

# PATH for cron context (Homebrew git, gh, node).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "=== $TS ==="
  "$EDVA_TOOLS/bin/memory-snapshot" --quiet 2>&1 || {
    rc=$?
    echo "memory-snapshot FAILED with exit $rc"
    exit "$rc"
  }
} >>"$LOG_FILE" 2>&1
