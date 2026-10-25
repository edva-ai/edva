# script-job-env.sh — shared environment for cron triggers that run a job as a
# plain script (no webhook, no agent turn). Source it, then call
# `run_script_job <job> <command> [args...]`.
#
# Why a helper: every job converted from an agent turn to a plain script
# (watchers, calendar syncs, invoice checks, …) needs the same three things
# the first such conversion discovered:
#   - PATH with Homebrew + the signed node at ~/.local/node/bin
#   - GOG_KEYRING_PASSWORD from .env, or every gog call dies on the keyring
#   - stdout/stderr captured to data/logs/<job>.log (the log skill-health.js
#     scans), since there is no agent transcript any more
# Cron runs these OUTSIDE the agent's sandboxed Bash, which is the point: the
# sandbox is what breaks gog and node's resolver for such jobs.

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/google-cloud-sdk/bin:$PATH"
source "$(dirname "${BASH_SOURCE[0]}")/root.sh"   # EDVA_INSTALL, EDVA_INSTALL_TOOLS
EDVA_REPO="$EDVA_INSTALL"

if [ -z "${GOG_KEYRING_PASSWORD:-}" ] && [ -f "$EDVA_INSTALL_TOOLS/.env" ]; then
  GOG_KEYRING_PASSWORD="$(grep -E '^GOG_KEYRING_PASSWORD=' "$EDVA_INSTALL_TOOLS/.env" | head -1 | cut -d= -f2-)"
  export GOG_KEYRING_PASSWORD
fi

# run_script_job <job> <cmd> [args...] — run, append all output to the job log,
# and log a one-line watchdog note on a non-zero exit. Returns the command's rc.
run_script_job() {
  local job="$1"; shift
  local logdir="$EDVA_INSTALL_TOOLS/data/logs"
  mkdir -p "$logdir"
  local logfile="$logdir/$job.log"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] start: $*" >> "$logfile"
  "$@" >> "$logfile" 2>&1
  local rc=$?
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] exit $rc" >> "$logfile"
  if [ "$rc" -ne 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$job] script exited $rc — see data/logs/$job.log" \
      >> "$EDVA_INSTALL_TOOLS/agent/logs/watchdog.log"
  fi
  return $rc
}
