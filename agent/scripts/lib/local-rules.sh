# local-rules.sh — the instance's own agent rules for a `claude -p` fork that
# runs outside the supervisors. Source it; it defines functions only.
#
# The kernel rulebooks (agent/CLAUDE.md + <agent>/CLAUDE.md) and the
# kernel playbooks (ops-agent/jobs/<job>.md) are generic. The instance's own
# rules live in agent/local/ (see agent/CLAUDE.md § Local rules):
#   shared.md + chat.md | ops.md   appended to the system prompt
#   jobs/<job>.md                  appended to the dispatched playbook
# The supervisors do both for their own sessions and webhook jobs
# (claude-session.mjs buildLocalRulesFile, http-server.mjs). A launcher with its
# own `claude -p` line does the same with these helpers, so a fork still
# receives every rule its cwd's CLAUDE.md files used to carry.
#
#   merlin_job_companion <job-md>
#       The path of the playbook's local companion (<local>/jobs/<basename>.md)
#       when it exists and is not blank; nothing otherwise.
#   merlin_job_prompt <job-md>
#       The playbook, then its local companion (<local>/jobs/<basename>.md)
#       after a blank line when that exists and is not blank. Without one the
#       playbook's bytes are printed unchanged.
#   merlin_local_rules_role <cwd>
#       Which local rules the CLAUDE.md hierarchy at <cwd> stands for:
#       "ops" (an ops-* agent dir), "chat" (chat-agent), "shared" (elsewhere
#       under agent) or "" (outside it: no Merlin CLAUDE.md is loaded,
#       so no local rules either).
#   merlin_local_rules_file <role> <out-file>
#       Write shared.md (+ <role>.md for chat/ops) joined, the same join as
#       readLocalRules() in claude-session.mjs. Returns 1 and leaves no file
#       when there is nothing to append.
#
# The local dir is $MERLIN_LOCAL_DIR, else <kernel>/agent/local, where
# <kernel> is the kernel tree under $ROOT when the caller set it (an install
# root, the dir holding tools/), else the installation's (~/Dev/merlin/tools;
# lib/root.sh).

_MERLIN_LOCAL_RULES_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_merlin_local_tools() {
  ( source "$_MERLIN_LOCAL_RULES_LIB/root.sh"
    if [ -n "${ROOT:-}" ]; then printf '%s' "$ROOT${MERLIN_KERNEL_SUBDIR:+/$MERLIN_KERNEL_SUBDIR}"
    else printf '%s' "$MERLIN_INSTALL_TOOLS"; fi )
}

merlin_local_dir() {
  if [ -n "${MERLIN_LOCAL_DIR:-}" ]; then printf '%s' "$MERLIN_LOCAL_DIR"
  else printf '%s' "$(_merlin_local_tools)/agent/local"; fi
}

# True when the file exists and holds something other than whitespace.
_merlin_local_nonblank() {
  [ -f "$1" ] && grep -q '[^[:space:]]' "$1" 2>/dev/null
}

merlin_job_companion() {
  local companion
  companion="$(merlin_local_dir)/jobs/$(basename "$1" .md).md"
  _merlin_local_nonblank "$companion" && printf '%s\n' "$companion"
  return 0
}

merlin_job_prompt() {
  local md="$1" companion
  companion="$(merlin_job_companion "$md")"
  if [ -n "$companion" ]; then
    printf '%s\n\n%s\n' "$(cat "$md")" "$(cat "$companion")"
  else
    cat "$md"
  fi
}

merlin_local_rules_role() {
  local cwd="$1" agent_root
  agent_root="$(_merlin_local_tools)/agent"
  # Compare physical paths, so a symlinked checkout or cwd still matches.
  cwd="$(cd "$cwd" 2>/dev/null && pwd -P || printf '%s' "$cwd")"
  agent_root="$(cd "$agent_root" 2>/dev/null && pwd -P || printf '%s' "$agent_root")"
  case "$cwd/" in
    "$agent_root"/chat-agent/*)                                   echo chat ;;
    "$agent_root"/ops-agent/*|"$agent_root"/ops-*-agent/*)        echo ops ;;
    "$agent_root"/*)                                              echo shared ;;
    *)                                                            echo "" ;;
  esac
}

merlin_local_rules_file() {
  local role="$1" out="$2" dir names=() name sep="" any=0
  dir="$(merlin_local_dir)"
  case "$role" in
    chat|ops) names=(shared.md "$role.md") ;;
    shared)   names=(shared.md) ;;
    *)        rm -f "$out"; return 1 ;;
  esac
  : > "$out" || return 1
  for name in "${names[@]}"; do
    _merlin_local_nonblank "$dir/$name" || continue
    printf '%s%s\n' "$sep" "$(cat "$dir/$name")" >> "$out"
    sep=$'\n'
    any=1
  done
  if [ "$any" -eq 0 ]; then rm -f "$out"; return 1; fi
  return 0
}
