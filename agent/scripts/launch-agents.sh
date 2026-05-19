#!/bin/bash
# Launch dual-agent setup in tmux session "claude"
# - Pane 0: Chat agent (Sonnet) — Merlin phone-channel
# - Pane 1: Ops agent (Opus) — Gmail + webhook channels
# - Pane 2: Hookdeck CLI — Gmail webhook relay

: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

CLAUDE="$HOME/.local/bin/claude"
SESSION="claude"
ALLOWED_TOOLS='Bash Read Edit Write WebFetch WebSearch Glob Grep Agent "mcp__tools__*" "mcp__claude_ai_Gmail__*" "mcp__claude_ai_Google_Calendar__*" "mcp__claude_ai_Slack__*" "mcp__supabase-merlin__*" "mcp__gtasks__*"'

# Kill existing session if running
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Create session with chat agent (pane 0)
tmux new-session -d -s "$SESSION" -c "${MERLIN_HOME}/agent/chat-agent"
tmux send-keys -t "$SESSION:0.0" \
  "$CLAUDE --model sonnet --dangerously-load-development-channels server:phone-channel --permission-mode auto --remote-control-session-name-prefix chat-agent --allowedTools $ALLOWED_TOOLS" Enter

# Split for ops agent (pane 1)
tmux split-window -t "$SESSION" -v -c "${MERLIN_HOME}/agent/ops-agent"
tmux send-keys -t "$SESSION:0.1" \
  "$CLAUDE --model opus --dangerously-load-development-channels server:gmail-channel server:webhook-channel --permission-mode auto --remote-control-session-name-prefix ops-agent --allowedTools $ALLOWED_TOOLS" Enter

# Split for hookdeck (pane 2)
tmux split-window -t "$SESSION" -v -c "${MERLIN_HOME}/agent"
tmux send-keys -t "$SESSION:0.2" \
  "hookdeck listen 9090 gmail-source" Enter

# Even out pane sizes
tmux select-layout -t "$SESSION" even-vertical

echo "Agents launched in tmux session '$SESSION'"
echo "  Pane 0: Chat agent (Sonnet) — phone-channel"
echo "  Pane 1: Ops agent (Opus) — gmail + webhook"
echo "  Pane 2: Hookdeck"
echo ""
echo "NOTE: Both agents will prompt for dev-channels confirmation."
echo "Attach with: tmux attach -t $SESSION"
