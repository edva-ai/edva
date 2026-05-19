#!/bin/bash
# resilience-test.sh — Automated kill-and-verify test for the claude agent session
#
# Kills the tmux session, waits for launchd to restart it, verifies the agent
# reaches a running state (past all prompts), and logs the result.
# Sends a Merlin notification on each run with pass/fail status.
#
# Usage: runs via launchd on a schedule, auto-removes itself after 2 days.

set -euo pipefail
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"


TMUX=tmux
SESSION=claude
LOGDIR="${MERLIN_HOME}/agent/logs"
LOG="$LOGDIR/resilience-test.log"
PLIST="$HOME/Library/LaunchAgents/ai.claude.resilience-test.plist"
MERLIN="${MERLIN_HOME}/bin/merlin-send-curl"

# Auto-expire: remove ourselves after 2 days from first run
CREATED_FILE="$LOGDIR/.resilience-test-created"
if [ ! -f "$CREATED_FILE" ]; then
  date +%s > "$CREATED_FILE"
else
  created=$(cat "$CREATED_FILE")
  now=$(date +%s)
  elapsed=$(( now - created ))
  if [ "$elapsed" -gt 259200 ]; then  # 72 hours (3 days)
    echo "$(date '+%Y-%m-%d %H:%M:%S') Resilience test expired after 48h. Self-removing." >> "$LOG"
    launchctl bootout "gui/$(id -u)/ai.claude.resilience-test" 2>/dev/null || true
    rm -f "$PLIST" "$CREATED_FILE"
    exit 0
  fi
fi

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

notify() {
  local msg="$1"
  # --skip-precheck: diagnostic notification, must not be modified/suppressed
  # by recent chat context — we're verifying the channel itself.
  "$MERLIN" --skip-precheck --intent resilience-test "$msg" 2>/dev/null || log "Merlin notification failed, result logged only"
}

log "=== Resilience test starting ==="

# Step 1: Verify session is currently running
if ! $TMUX has-session -t "$SESSION" 2>/dev/null; then
  log "WARN: Session not running before kill test. Waiting 90s for it to start..."
  sleep 90
  if ! $TMUX has-session -t "$SESSION" 2>/dev/null; then
    log "FAIL: Session never started"
    notify "FAIL: Agent session was not running and did not start within 90s"
    exit 1
  fi
fi

log "Session alive before kill"

# Step 2: Kill the session
$TMUX kill-session -t "$SESSION" 2>/dev/null
log "Session killed"

# Step 3: Wait for recovery (check every 10s for up to 180s)
recovered=false
for i in $(seq 1 18); do
  sleep 10
  if $TMUX has-session -t "$SESSION" 2>/dev/null; then
    # Session exists — check if agent is past prompts
    content=$($TMUX capture-pane -t "$SESSION:0.0" -p 2>/dev/null) || continue
    if echo "$content" | grep -qE '(❯ *$|thinking|Transfiguring|Proofing|Standing by|monitoring)'; then
      log "PASS: Session recovered in $((i * 10))s — agent is running"
      recovered=true
      break
    else
      log "Session exists but agent still initializing ($((i * 10))s)..."
    fi
  fi
done

if [ "$recovered" = true ]; then
  notify "Resilience test PASSED — agent recovered in $((i * 10))s after kill"
else
  log "FAIL: Session did not recover within 180s"
  notify "FAIL: Agent did not recover within 180s after kill test. Check logs."
  exit 1
fi

log "=== Resilience test complete ==="
