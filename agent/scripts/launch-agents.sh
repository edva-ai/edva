#!/bin/bash
# Launch dual-agent setup in tmux session "claude"
# - Pane 0: Chat agent (Sonnet) — Edva phone-channel
# - Pane 1: Ops agent (Opus) — Gmail + webhook channels
#
# Gmail-push ingress is a separate Cloudflare Tunnel (push hostname → :9090)
# under com.cloudflare.cloudflared — not a tmux pane here.
# NOTE: legacy launcher; the live supervision path is process-manager.mjs.

CLAUDE="$HOME/.local/bin/claude"
SESSION="claude"
ALLOWED_TOOLS='Bash Read Edit Write WebFetch WebSearch Glob Grep Agent "mcp__tools__*" "mcp__claude_ai_Gmail__*" "mcp__claude_ai_Google_Calendar__*" "mcp__claude_ai_Slack__*" "mcp__supabase-edva__*" "mcp__gtasks__*"'

# Kill existing session if running
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Create session with chat agent (pane 0)
tmux new-session -d -s "$SESSION" -c "$HOME/Dev/edva/agent/chat-agent"
tmux send-keys -t "$SESSION:0.0" \
  "$CLAUDE --model claude-sonnet-5-5 --dangerously-load-development-channels server:phone-channel --permission-mode auto --remote-control-session-name-prefix chat-agent --allowedTools $ALLOWED_TOOLS" Enter

# Split for ops agent (pane 1)
tmux split-window -t "$SESSION" -v -c "$HOME/Dev/edva/agent/ops-agent"
tmux send-keys -t "$SESSION:0.1" \
  "$CLAUDE --model opus --dangerously-load-development-channels server:gmail-channel server:webhook-channel --permission-mode auto --remote-control-session-name-prefix ops-agent --allowedTools $ALLOWED_TOOLS" Enter

# Even out pane sizes
tmux select-layout -t "$SESSION" even-vertical

echo "Agents launched in tmux session '$SESSION'"
echo "  Pane 0: Chat agent (Sonnet) — phone-channel"
echo "  Pane 1: Ops agent (Opus) — gmail + webhook"
echo ""
echo "NOTE: Both agents will prompt for dev-channels confirmation."
echo "Attach with: tmux attach -t $SESSION"
