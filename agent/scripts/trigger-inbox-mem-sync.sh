#!/usr/bin/env bash
# Keep the inbox flowing into memory.
#
# Memory is the authority the release gate asks before any message reaches
# the user (Rule #2, agent/CLAUDE.md). An authority is only as good as its
# ingestion: a ping can go out asserting something that the previous day's
# emails already contradicted, and no amount of cleverness at decision time
# recovers a fact nobody ingested.
#
# Like other sync triggers, this does NOT dispatch to the supervisor:
# there is no reasoning to do, just a mailbox read into the memory index. It
# runs under `cron-run`, which sources GOG_KEYRING_PASSWORD from .env so
# gog's file keyring unlocks without a TTY.
#
# Two modes:
#   (default)  short window, run often — keeps memory current within the hour.
#   --deep     wide window + prune, once nightly — repairs anything the short
#              window missed (an outage, a burst past --max) and bounds growth.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
NODE=/opt/homebrew/bin/node
BIN="$EDVA_INSTALL_TOOLS/bin/inbox-mem"
LOG="$EDVA_INSTALL_TOOLS/agent/logs/inbox-mem-sync.log"

# Pause file — stop ingestion without editing crontab.
if [[ -f "$EDVA_INSTALL_TOOLS/data/inbox-mem-pause.json" ]]; then
  exit 0
fi

mkdir -p "$(dirname "$LOG")"

if [[ "${1:-}" == "--deep" ]]; then
  DAYS=30; MAX=1500; EMBED=1500
else
  DAYS=2; MAX=200; EMBED=200
fi

{
  echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) mode=${1:-short} days=$DAYS max=$MAX"
  # Index first, embed second. The FTS half is useful immediately; embeddings
  # are the slow part (local Ollama, one call per message) and are deliberately
  # off the ingestion path so a slow embedder never stalls the pull.
  "$NODE" "$BIN" sync --days "$DAYS" --max "$MAX" || echo "sync failed"
  "$NODE" "$BIN" embed --limit "$EMBED" || echo "embed failed"
  if [[ "${1:-}" == "--deep" ]]; then
    "$NODE" "$BIN" prune --days 120 || echo "prune failed"
    "$NODE" "$BIN" stats
  fi
} >> "$LOG" 2>&1
