#!/usr/bin/env bash
# bootstrap.sh — fresh-install setup for Merlin.
#
# Idempotent. Re-run any time you pull new deps. Does NOT touch your .env or
# data dir contents — only creates them when absent.
#
#   ./scripts/bootstrap.sh           # interactive
#   ./scripts/bootstrap.sh --quiet   # minimal output, suitable for CI

set -euo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

MERLIN_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MERLIN_HOME"

# ── colors ────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  R='\033[31m'; G='\033[32m'; Y='\033[33m'; B='\033[34m'; D='\033[2m'; N='\033[0m'
else
  R=''; G=''; Y=''; B=''; D=''; N=''
fi

info()  { [[ $QUIET -eq 1 ]] || echo -e "${B}▸${N} $*"; }
ok()    { [[ $QUIET -eq 1 ]] || echo -e "${G}✓${N} $*"; }
warn()  { echo -e "${Y}!${N} $*"; }
err()   { echo -e "${R}✘${N} $*" >&2; }
hr()    { [[ $QUIET -eq 1 ]] || echo -e "${D}─────────────────────────────────────${N}"; }

# ── prerequisites ─────────────────────────────────────────────────────────
hr
info "Checking prerequisites"

# Node 22.5+ for built-in node:sqlite
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 22.5+ from https://nodejs.org"
  exit 1
fi
NODE_VER=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
if [[ $NODE_MAJOR -lt 22 ]] || { [[ $NODE_MAJOR -eq 22 ]] && [[ $NODE_MINOR -lt 5 ]]; }; then
  err "Node $NODE_VER too old — need 22.5+ for built-in node:sqlite"
  exit 1
fi
ok "Node $NODE_VER"

# npm
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found"
  exit 1
fi
ok "npm $(npm --version)"

# Optional but recommended: ollama
if command -v ollama >/dev/null 2>&1; then
  ok "Ollama $(ollama --version 2>&1 | head -1)"
  # Models — non-fatal if missing
  if ! ollama list 2>/dev/null | grep -q "gemma3:4b"; then
    warn "Ollama model 'gemma3:4b' not pulled. The ack layer needs it:"
    warn "    ollama pull gemma3:4b"
  fi
  if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    warn "Ollama model 'nomic-embed-text' not pulled. Memory embeddings need it:"
    warn "    ollama pull nomic-embed-text"
  fi
else
  warn "Ollama not installed. Install from https://ollama.com — required for the phone-channel ack layer + memory embeddings."
fi

# Optional: claude CLI (for Max subscription users)
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI installed"
else
  warn "Claude Code CLI not on PATH. Install with: npm install -g @anthropic-ai/claude-code"
fi

# Optional integrations
for tool in gh op gog jq; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool installed"
  else
    [[ $QUIET -eq 1 ]] || echo -e "${D}  (optional) $tool not installed${N}"
  fi
done

# ── data directories ──────────────────────────────────────────────────────
hr
info "Creating runtime directories"
for d in data data/hum-cache logs agent/logs agent/logs/supervisor-ops agent/logs/supervisor-chat agent/supervisor/state/ops agent/supervisor/state/chat secrets credentials; do
  mkdir -p "$d"
done
ok "data/, logs/, agent/logs/, supervisor state/, secrets/, credentials/"

# ── npm dependencies (per package) ────────────────────────────────────────
hr
info "Installing npm dependencies"

# Root deps (light — for top-level scripts)
if [[ -f package.json ]]; then
  npm install --silent --no-audit --no-fund --no-progress
  ok "(root) package.json"
fi

# Each agent subpackage has its own package.json
for d in agent agent/supervisor agent/tools-mcp agent/webhook-channel agent/gmail-channel agent/phone-channel agent/dispatch-bridge bin; do
  if [[ -f "$d/package.json" ]]; then
    (cd "$d" && npm install --silent --no-audit --no-fund --no-progress)
    ok "$d/"
  fi
done

# ── permissions ───────────────────────────────────────────────────────────
hr
info "Marking CLIs + scripts executable"
chmod +x bin/* 2>/dev/null || true
chmod +x agent/bin/*.sh agent/bin/*.py agent/bin/*.mjs 2>/dev/null || true
chmod +x agent/scripts/*.sh agent/scripts/*.mjs 2>/dev/null || true
chmod +x agent/scripts/hum-harvesters/*.mjs 2>/dev/null || true
chmod +x agent/scripts/lib/*.sh 2>/dev/null || true
chmod +x scripts/*.sh 2>/dev/null || true
chmod +x system/test-merlin.sh 2>/dev/null || true
ok "executable bits set"

# ── .env scaffolding ──────────────────────────────────────────────────────
hr
if [[ -f .env ]]; then
  ok ".env exists (not overwritten)"
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    ok ".env created from .env.example"
    warn "Edit .env (or run \`./bin/merlin init\`) to fill in your values."
  fi
fi

# ── done ──────────────────────────────────────────────────────────────────
hr
ok "Bootstrap complete."
echo
[[ $QUIET -eq 1 ]] || cat <<EOF
Next steps:
  1. ./bin/merlin init          # interactive config wizard
  2. ./bin/merlin up            # start everything in the foreground
  3. ./bin/merlin tail ops      # watch the agent work

For deeper docs: ./system/architecture.md
EOF
