#!/bin/bash
# morning-digest — scripted: bin/morning-digest-run via
# launchd (GUI session, Max auth for its one pick call). The cron slot itself is
# still rewritten nightly by cron-tz-sync so it fires at 8:00 LOCAL time
# (data/clock-jobs.json) — only what the slot runs changed.
# Playbook: ops-agent/jobs/morning-digest.md
#
# The runner and its launchd agent belong to the installation: one without the
# agent's plist has no morning digest, so the slot does nothing (no kick, no
# "did not run" page).
source "$(dirname "$0")/lib/root.sh"
[ -f "$EDVA_INSTALL_TOOLS/agent/launch-agents/ai.claude.morning-digest.plist" ] || exit 0
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.morning-digest morning-digest
