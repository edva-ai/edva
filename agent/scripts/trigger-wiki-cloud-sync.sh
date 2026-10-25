#!/bin/bash
# trigger-wiki-cloud-sync.sh — wraps `wiki-cloud-sync push` for cron.
#
# Every 5 min: reconcile the Supabase mirror of the wiki (wiki_pages /
# wiki_page_links / wiki_page_revisions) to data/memory-index.db. This is
# the OFF-BOX copy — the hourly wiki-db-snapshot lives on the same disk as the
# DB it protects. Stateless diff, so a failed run heals on the next tick.
# Recovery: `wiki-cloud-sync restore --db <new-file>`.
#
# Output goes to agent/logs/wiki-cloud-sync.log; cron sees only the exit
# code. Three consecutive failures page via notify (edva-notify).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/wiki-cloud-sync.log"
FAIL_FILE="$EDVA_TOOLS/data/.wiki-cloud-sync.failures"

mkdir -p "$LOG_DIR"
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
if OUT="$("$EDVA_TOOLS/bin/wiki-cloud-sync" push --quiet 2>&1)"; then
  [ -n "$OUT" ] && printf '=== %s ===\n%s\n' "$TS" "$OUT" >>"$LOG_FILE"
  rm -f "$FAIL_FILE"
  exit 0
fi

N=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$N" >"$FAIL_FILE"
printf '=== %s === FAILED (%s consecutive)\n%s\n' "$TS" "$N" "$OUT" >>"$LOG_FILE"
if [ "$N" -eq 3 ]; then
  "$EDVA_TOOLS/bin/edva-notify" --channel system "🔴 wiki-cloud-sync has failed 3 runs in a row — the Supabase copy of the wiki is going stale. Last error: ${OUT:0:300}" >/dev/null 2>&1 || true
fi
exit 1
