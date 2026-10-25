#!/bin/bash
# run-wiki-assoc-llm.sh — the model half of the nightly associative-memory
# writers, under launchd (ai.claude.wiki-assoc-llm), kicked by cron's
# trigger-wiki-assoc.sh. Design: system/wiki-architecture.md
# § Associative recall.
#
#   wiki-assoc nightly --llm  →  typed facts for curated pages whose body
#   changed (page_facts; Rule #0b ladder, gemma3:1b then Sonnet on validation
#   failure, WIKI_FACTS_SONNET_BUDGET per run), then trigger cues for curated
#   pages (page_cues kind='trigger', WIKI_TRIGGER_ESCALATION_CAP Sonnet calls
#   per run). Every claim must quote its page verbatim or it is not written.
#
# Why launchd: the Sonnet rung is a tool-less `claude -p` on the Max login and
# only the GUI session can read it. Without a verified Max login the run goes
# to the wiki's API fallback (lib/api-fallback.mjs; CLAUDE.md § Auth
# Model carve-out, a user decision): the same Sonnet on the Anthropic API,
# capped at $25 a month, paging the system channel when it is used and when
# the cap stops it. With no fallback key in .env the run is held, as
# before, and pages nobody (watchdog.sh owns Max-outage alerts). Silent
# otherwise; log only.
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
source "$(dirname "${BASH_SOURCE[0]}")/lib/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
LOGFILE="$EDVA_INSTALL_TOOLS/agent/logs/wiki-assoc.log"
mkdir -p "$(dirname "$LOGFILE")"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [wiki-assoc-llm] $1" >> "$LOGFILE"; }

source "$(dirname "$0")/lib/max-auth-guard.sh"   # CLAUDE.md § Auth Model
max_auth_scrub
if ! max_auth_check "${CLAUDE_BIN:-$HOME/.local/bin/claude}"; then
  # Only checks the key is there. It is never exported: api-fallback.mjs reads
  # that one line itself, so no claude child ever sees it.
  if grep -q '^EDVA_WIKI_API_KEY=.' "$EDVA_INSTALL_TOOLS/.env" 2>/dev/null && [ "${WIKI_API_FALLBACK:-1}" != "0" ]; then
    log "Max login check failed ($MAX_AUTH_SUMMARY); running on the API fallback"
  else
    log "held: Max login check failed ($MAX_AUTH_SUMMARY) and no API fallback key; no model writes tonight"
    exit 0
  fi
fi

# --api-fallback: the Sonnet steps go to the API only if the fork itself says
# Max is unavailable, so on a normal night this flag changes nothing.
OUT=$(node "$EDVA_INSTALL_TOOLS/bin/wiki-assoc" nightly --llm --api-fallback 2>&1); RC=$?
if [ $RC -eq 0 ]; then log "ok: $(echo "$OUT" | tr -d '\n' | cut -c1-900)"
else log "FAILED ($RC): $(echo "$OUT" | tail -3 | tr -d '\n' | cut -c1-400)"; fi

# The wiki home portal's topics (bin/wiki-portal): re-curated weekly, or
# sooner when the page count moved >10%. A no-op most nights. wiki-cloud-sync
# carries the result to the public memory site within 5 minutes.
POUT=$(node "$EDVA_INSTALL_TOOLS/bin/wiki-portal" build --if-stale-days 7 --api-fallback 2>&1); PRC=$?
log "portal rc=$PRC $(echo "$POUT" | tr -d '\n' | cut -c1-500)"
exit $RC
