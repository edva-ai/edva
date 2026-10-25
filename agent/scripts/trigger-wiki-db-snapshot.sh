#!/bin/bash
# trigger-wiki-db-snapshot.sh — wraps `wiki-db-snapshot` for cron.
#
# Hourly snapshot of data/memory-index.db via SQLite VACUUM INTO into
# data/memory-db-snapshots/, rotated to last 4. Defense-in-depth
# complement to the file-based memory-snapshot cron — protects against the
# DB itself going bad (FTS5 corruption, accidental DROP, etc.).
#
# All output goes to agent/logs/wiki-db-snapshot.log; cron sees only
# the exit code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/wiki-db-snapshot.log"

mkdir -p "$LOG_DIR"

# PATH for cron context (Homebrew sqlite3 if installed, else system).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "=== $TS ==="
  "$EDVA_TOOLS/bin/wiki-db-snapshot" 2>&1 || {
    rc=$?
    echo "wiki-db-snapshot FAILED with exit $rc"
    exit "$rc"
  }
} >>"$LOG_FILE" 2>&1
