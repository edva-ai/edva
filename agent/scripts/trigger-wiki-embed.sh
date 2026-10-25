#!/bin/bash
# trigger-wiki-embed.sh — backfill semantic embeddings for the wiki page store
# (pages → page_embeddings in memory-index.db).
#
# Embeds active pages that are new or changed since their last embedding, via
# local Ollama (nomic-embed-text). This powers wiki_search mode:"hybrid". Pure
# filesystem + local-embedding work — no webhook dispatch, no Anthropic call —
# so it runs directly under cron. Idempotent; degrades gracefully if Ollama is
# down (wiki_search still works in FTS mode). Safe to run manually.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_DIR="$EDVA_TOOLS/agent/logs"
LOG_FILE="$LOG_DIR/wiki-embed.log"

mkdir -p "$LOG_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki embed: starting" >> "$LOG_FILE"

# One pass drains new/changed pages (embedPendingPages loops internal batches).
OUT="$(node "$EDVA_TOOLS/bin/wiki-embed" embed --limit 300 2>>"$LOG_FILE" || true)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] $OUT" | tr -d '\n' >> "$LOG_FILE"; echo >> "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] wiki embed: done" >> "$LOG_FILE"
