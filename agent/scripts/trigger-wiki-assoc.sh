#!/bin/bash
# trigger-wiki-assoc.sh — nightly writers for associative memory
# (system/wiki-architecture.md § Associative recall).
#
# Two halves, because only one of them can run under cron:
#
#   1. HERE, under cron — the no-model writers, pure SQLite + log reads:
#        wiki-assoc nightly  →  Hebbian co-retrieval weights from the
#        auto-recall judge log (page_coactivation), the unlinked co-used pairs
#        for wiki-link-weave (data/wiki-link-candidates.json), and the
#        ACT-R base-level activation per page (page_activation).
#   2. KICKED, under launchd — the model writers (typed fact extraction and
#      trigger cues). Their Sonnet rung is a tool-less `claude -p` on the Max
#      login, which cron cannot read (CLAUDE.md § Effort Policy). So cron only
#      kicks the on-demand agent ai.claude.wiki-assoc-llm, which runs
#      run-wiki-assoc-llm.sh in the GUI session behind max-auth-guard.
#
# Silent: no email, no ping, no push. Writes only the memory DB and the
# candidates file. Idempotent; safe to run by hand.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/root.sh"   # EDVA_ROOT, EDVA_TOOLS
LOG_FILE="$EDVA_TOOLS/agent/logs/wiki-assoc.log"
mkdir -p "$(dirname "$LOG_FILE")"
export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"; }

log "wiki-assoc nightly: starting"
OUT="$(node "$EDVA_TOOLS/bin/wiki-assoc" nightly 2>>"$LOG_FILE")"
RC=$?
log "nightly rc=$RC $(echo "$OUT" | tr -d '\n' | cut -c1-900)"

source "$SCRIPT_DIR/lib/launchd-kick.sh"
launchd_kick ai.claude.wiki-assoc-llm wiki-assoc-llm
exit 0
