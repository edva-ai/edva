#!/bin/bash
# trigger-wiki-audit.sh — wraps `wiki-audit` for cron.
#
# Reads data/wiki-access.jsonl (last 7 days), decides pin/unpin
# moves on the wiki page subset, applies them, and emails the user a
# digest IF anything actually changed (silent on no-op nights).
#
# All output goes to agent/logs/wiki-audit.log; cron sees only
# the exit code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/wiki-audit.log"

mkdir -p "$LOG_DIR"

# PATH for cron context (Homebrew node, etc.)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "=== $TS ==="
  "$EDVA_TOOLS/bin/wiki-audit" 2>&1 || {
    rc=$?
    echo "wiki-audit FAILED with exit $rc"
    exit "$rc"
  }
} >>"$LOG_FILE" 2>&1
