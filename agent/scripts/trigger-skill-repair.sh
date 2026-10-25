#!/bin/bash
# trigger-skill-repair.sh — dispatch the same-day repair job when the queue has work.
#
# Kicked (detached) by lib/skill-repair.mjs requestRepair() the moment a
# producer queues a repair, and by cron as a safety net. Dumb on purpose: the
# admission rules (repairable error, read-only action, 1/day per action, 4/day
# overall) were already applied when the item was queued.

STATE_DIR="$HOME/Dev/edva/data"
QUEUE="$STATE_DIR/skill-repair-queue.json"
LOCK="$STATE_DIR/skill-repair.lock"

[[ -f "$STATE_DIR/skill-repair-pause.json" ]] && exit 0
[[ -f "$QUEUE" ]] || exit 0
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
PENDING=$("$NODE_BIN" -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((q.pending||[]).filter(p=>p.status==="pending").length)' "$QUEUE" 2>/dev/null || echo 0)
[[ "$PENDING" -gt 0 ]] || exit 0

# One dispatch at a time; the job drains the queue itself. A lock older than
# 2h belongs to a dead dispatch (skill-repair next re-releases its claim).
if [[ -f "$LOCK" ]] && [[ $(( $(date +%s) - $(stat -f %m "$LOCK") )) -lt 7200 ]]; then
  exit 0
fi
touch "$LOCK"

source "$(dirname "$0")/lib/webhook-auth.sh"
dispatch_or_skip '{"job": "skill-repair"}' skill-repair
