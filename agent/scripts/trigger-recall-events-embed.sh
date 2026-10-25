#!/bin/bash
# trigger-recall-events-embed.sh — backfill semantic embeddings for the events
# recall index (events_fts → event_embeddings in memory-index.db).
#
# Embeds high-value events (result / dispatcher.dispatching / turn_complete) that
# don't yet have an embedding, via local Ollama (nomic-embed-text). Pure
# filesystem + local-embedding work — no webhook dispatch, no Anthropic call —
# so it runs directly under cron. Idempotent; degrades gracefully if Ollama is
# down (recall_events still works in FTS mode). Safe to run manually.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/recall-events-embed.log"

mkdir -p "$LOG_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] recall-events embed: starting" >> "$LOG_FILE"

# A few batches per run so a large backlog drains over successive nights without
# hammering Ollama in one burst. embedPending bails early if Ollama is down.
for i in 1 2 3 4 5; do
  OUT="$(node "$EDVA_TOOLS/bin/recall-events" embed --limit 300 2>>"$LOG_FILE" || true)"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] batch $i: $OUT" | tr -d '\n' >> "$LOG_FILE"; echo >> "$LOG_FILE"
  # Stop when nothing left or an error batch (embedded 0).
  echo "$OUT" | grep -q '"embedded": 0' && break
  echo "$OUT" | grep -q '"remaining": 0' && break
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] recall-events embed: done" >> "$LOG_FILE"
