#!/bin/bash
# hum-explore — at most twice a week, send the best fresh item hum held back
# as an ordinary "Borderline pick:" ping. See jobs/hum-explore.md.
#
# A DIRECT script, no webhook and no agent turn. Runs at 12:30 and 17:30
# local (clock-jobs.json labels trigger-hum-explore-midday / -evening);
# bin/hum-explore-run applies the cadence, moment and lane gates and
# usually decides "skip".
#
# CRON KICKS, LAUNCHD SENDS. A pick goes out through hum-ping →
# edva-send-curl, whose resolve-first gate (Opus) and outbound precheck
# (Sonnet) are `claude -p` calls on the Max login, and cron cannot reach that
# login: from cron a pick logs "model unavailable: not_logged_in" and goes out
# unchecked. So cron only kicks the on-demand agent
# ai.claude.hum-explore, which runs run-hum-explore.sh in the GUI session.
# Not installed → launchd_kick logs it and leaves the install line in the
# System tab, and nothing is sent. Failures go to watchdog.log.
source "$(dirname "$0")/lib/launchd-kick.sh"
launchd_kick ai.claude.hum-explore hum-explore
