# root.sh — source to learn where the kernel lives (the shell twin of
# lib/root.cjs; read that file's header for the why).
#
# Sets (plain shell variables, not exported):
#   MERLIN_ROOT           the checkout this script runs from. An exported
#                          MERLIN_ROOT wins (tests point it at a sandbox), then
#                          MERLIN_HOME, then this file's own location.
#   MERLIN_TOOLS          the kernel tree in that checkout (lib/, bin/, agent/, ...)
#   MERLIN_INSTALL        the installation under the operator's HOME
#                          (MERLIN_HOME, else ~/Dev/merlin)
#   MERLIN_INSTALL_TOOLS  the kernel tree in the installation
#   MERLIN_KERNEL_SUBDIR  the kernel tree's directory under a repo root ("" when
#                          the kernel is the repo root), for a caller that was
#                          handed some other root
#   MERLIN_NODE           the node binary: an exported MERLIN_NODE wins, then
#                          `command -v node`, then the usual Homebrew / /usr/local
#                          paths (cron's bare PATH has no node); "" when none
#
# Join paths below the kernel tree onto MERLIN_TOOLS / MERLIN_INSTALL_TOOLS
# ("$MERLIN_TOOLS/bin/foo"), never "$MERLIN_ROOT/tools/...": that spelling
# is the same in every layout. The layout itself (the kernel's directory under
# the repo root) is read from root.cjs's KERNEL_SUBDIR line, so it is written
# down once. Safe to source twice.

_merlin_root_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This file sits in <kernel>/agent/scripts/lib/ in every layout.
_merlin_root_code_tools="$(cd "$_merlin_root_lib/../../.." && pwd)"
_merlin_root_sub="$(sed -n 's/^const KERNEL_SUBDIR = "\([^"]*\)";.*/\1/p' "$_merlin_root_code_tools/lib/root.cjs" 2>/dev/null | head -1)"
if [ -n "$_merlin_root_sub" ]; then
  _merlin_root_code_root="$(cd "$_merlin_root_code_tools/$(printf '%s' "$_merlin_root_sub" | sed 's#[^/][^/]*#..#g')" && pwd)"
else
  _merlin_root_code_root="$_merlin_root_code_tools"
fi
if [ -n "${MERLIN_ROOT:-}" ]; then
  MERLIN_TOOLS="$MERLIN_ROOT${_merlin_root_sub:+/$_merlin_root_sub}"
elif [ -n "${MERLIN_HOME:-}" ]; then
  MERLIN_ROOT="$MERLIN_HOME"
  MERLIN_TOOLS="$MERLIN_HOME${_merlin_root_sub:+/$_merlin_root_sub}"
else
  MERLIN_ROOT="$_merlin_root_code_root"
  MERLIN_TOOLS="$_merlin_root_code_tools"
fi
MERLIN_INSTALL="${MERLIN_HOME:-$HOME/Dev/merlin}"
MERLIN_INSTALL_TOOLS="$MERLIN_INSTALL${_merlin_root_sub:+/$_merlin_root_sub}"
MERLIN_KERNEL_SUBDIR="$_merlin_root_sub"
if [ -z "${MERLIN_NODE:-}" ]; then
  MERLIN_NODE="$(command -v node 2>/dev/null || true)"
  for _merlin_root_n in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$MERLIN_NODE" ] && break
    [ -x "$_merlin_root_n" ] && MERLIN_NODE="$_merlin_root_n"
  done
  unset _merlin_root_n
fi
unset _merlin_root_lib _merlin_root_code_tools _merlin_root_code_root _merlin_root_sub
