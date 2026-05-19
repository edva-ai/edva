#!/bin/bash
# claude-session-launcher.sh — managed by launchd (ai.claude.session)
#
# Long-lived process. launchd's KeepAlive restarts it when it exits non-zero.
# Creates 3-pane tmux layout:
#   Pane 0: Chat agent (Sonnet, interactive)  — launched via claude CLI + dev-channels
#   Pane 1: Ops agent  (Opus, supervised)      — launched via Node supervisor (stream-json)
#   Pane 2: Hookdeck                           — Gmail webhook relay → supervisor :9090
#
# All launch config (model, allowedTools, channels, ports) lives in
# agent/config/agents.json. This script reads it via load-agent.sh.

set -euo pipefail
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"


TMUX=tmux
CLAUDE="$HOME/.local/bin/claude"
NODE=node
SESSION=claude
WORKDIR="${MERLIN_HOME}/agent"
CHAT_DIR="$WORKDIR/chat-agent"
SUPERVISOR_DIR="$WORKDIR/supervisor"
CONFIG_DIR="$WORKDIR/config"
LOGDIR="$WORKDIR/logs"
LOG="$LOGDIR/claude-launchagent.log"
LOCKFILE="/tmp/claude-session-launcher.lock"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# ── Lockfile — prevent concurrent launcher instances ────────────────────
cleanup() { rm -f "$LOCKFILE"; }
trap cleanup EXIT

if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "Another launcher is running (pid $LOCK_PID) — exiting"
    exit 0
  fi
  log "Stale lockfile found (pid $LOCK_PID) — taking over"
fi
echo $$ > "$LOCKFILE"

# ── Load chat-agent config (ops-agent config consumed by supervisor) ────
eval "$("$CONFIG_DIR/load-agent.sh" chat)"
CHAT_MODEL="$AGENT_MODEL"
CHAT_DEV_CHANNELS="$AGENT_DEV_CHANNELS"
CHAT_PERMISSION_MODE="$AGENT_PERMISSION_MODE"
CHAT_REMOTE_PREFIX="$AGENT_REMOTE_CONTROL_PREFIX"
CHAT_ALLOWED_TOOLS="$AGENT_ALLOWED_TOOLS"

# ── Persistent prompt watcher (chat-agent only — supervisor handles ops) ─
# Chat-agent runs interactively with --dangerously-load-development-channels,
# which triggers the "I am using this for local development" prompt and the
# first-MCP-tool-use prompt. Ops-agent runs under supervisor in -p mode with
# bypassPermissions, so no TTY prompts to watch.
watch_and_accept_prompts() {
  sleep 8
  while $TMUX has-session -t "$SESSION" 2>/dev/null; do
    local content
    content=$($TMUX capture-pane -t "$SESSION:0.0" -p -S -30 2>/dev/null) || continue
    if echo "$content" | grep -q "local development"; then
      $TMUX send-keys -t "$SESSION:0.0" Enter 2>/dev/null
      log "Auto-accepted channels prompt in chat-agent"
      sleep 3
      continue
    fi
    if echo "$content" | grep -q "Do you want to proceed"; then
      $TMUX send-keys -t "$SESSION:0.0" Down Enter 2>/dev/null
      log "Auto-accepted tool permission in chat-agent"
      sleep 3
      continue
    fi
    sleep 5
  done
}

# ── Main ─────────────────────────────────────────────────────────────────
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
  log "Session '$SESSION' already exists — attaching as monitor"
else
  $TMUX kill-session -t "$SESSION" 2>/dev/null || true
  sleep 1

  log "Starting 3-pane tmux session (chat / ops-supervisor / hookdeck)"

  # Pane 0: chat-agent (interactive claude, Sonnet, phone-channel)
  $TMUX new-session -d -s "$SESSION" -c "$CHAT_DIR"
  CHAT_CMD="$CLAUDE --model $CHAT_MODEL --dangerously-load-development-channels $CHAT_DEV_CHANNELS --permission-mode $CHAT_PERMISSION_MODE --remote-control-session-name-prefix $CHAT_REMOTE_PREFIX --allowedTools $CHAT_ALLOWED_TOOLS"
  $TMUX send-keys -t "$SESSION:0.0" "$CHAT_CMD" Enter

  # Pane 1: ops-supervisor (spawns claude -p internally, Opus, HTTP 9090/9092/9093)
  $TMUX split-window -t "$SESSION" -v -c "$SUPERVISOR_DIR"
  $TMUX send-keys -t "$SESSION:0.1" "$NODE $SUPERVISOR_DIR/index.mjs --agent ops" Enter

  # Pane 2: hookdeck relay (POST → :9090, unchanged from old setup)
  $TMUX split-window -t "$SESSION" -v -c "$WORKDIR"
  $TMUX send-keys -t "$SESSION:0.2" 'hookdeck listen 9090 gmail-source' Enter

  $TMUX select-layout -t "$SESSION" even-vertical

  CHAT_LOG="$LOGDIR/chat-agent.log"
  OPS_LOG="$LOGDIR/ops-supervisor.log"
  HOOKDECK_LOG="$LOGDIR/hookdeck.log"
  $TMUX pipe-pane -t "$SESSION:0.0" -o "cat >> '$CHAT_LOG'"
  $TMUX pipe-pane -t "$SESSION:0.1" -o "cat >> '$OPS_LOG'"
  $TMUX pipe-pane -t "$SESSION:0.2" -o "cat >> '$HOOKDECK_LOG'"

  log "tmux session started — chat→$CHAT_LOG ops→$OPS_LOG hookdeck→$HOOKDECK_LOG"

  watch_and_accept_prompts &
  WATCHER_PID=$!
fi

# Block until tmux session dies
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 10
done

kill "${WATCHER_PID:-0}" 2>/dev/null || true
wait 2>/dev/null
log "tmux session '$SESSION' died — exiting non-zero to trigger launchd restart"
exit 1
