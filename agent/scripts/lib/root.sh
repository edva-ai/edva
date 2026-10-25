# root.sh — source to learn where the kernel lives (the shell twin of
# lib/root.cjs; read that file's header for the why).
#
# Sets (plain shell variables, not exported):
#   EDVA_ROOT           the checkout this script runs from. An exported
#                          EDVA_ROOT wins (tests point it at a sandbox), then
#                          EDVA_HOME, then this file's own location.
#   EDVA_TOOLS          the kernel tree in that checkout (lib/, bin/, agent/, ...)
#   EDVA_INSTALL        the installation under the operator's HOME
#                          (EDVA_HOME, else ~/Dev/edva)
#   EDVA_INSTALL_TOOLS  the kernel tree in the installation
#   EDVA_KERNEL_SUBDIR  the kernel tree's directory under a repo root ("" when
#                          the kernel is the repo root), for a caller that was
#                          handed some other root
#   EDVA_NODE           the node binary: an exported EDVA_NODE wins, then
#                          `command -v node`, then the usual Homebrew / /usr/local
#                          paths (cron's bare PATH has no node); "" when none
#
# Join paths below the kernel tree onto EDVA_TOOLS / EDVA_INSTALL_TOOLS
# ("$EDVA_TOOLS/bin/foo"), never "$EDVA_ROOT/tools/...": that spelling
# is the same in every layout. The layout itself (the kernel's directory under
# the repo root) is read from root.cjs's KERNEL_SUBDIR line, so it is written
# down once. Safe to source twice.

_edva_root_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This file sits in <kernel>/agent/scripts/lib/ in every layout.
_edva_root_code_tools="$(cd "$_edva_root_lib/../../.." && pwd)"
_edva_root_sub="$(sed -n 's/^const KERNEL_SUBDIR = "\([^"]*\)";.*/\1/p' "$_edva_root_code_tools/lib/root.cjs" 2>/dev/null | head -1)"
if [ -n "$_edva_root_sub" ]; then
  _edva_root_code_root="$(cd "$_edva_root_code_tools/$(printf '%s' "$_edva_root_sub" | sed 's#[^/][^/]*#..#g')" && pwd)"
else
  _edva_root_code_root="$_edva_root_code_tools"
fi
if [ -n "${EDVA_ROOT:-}" ]; then
  EDVA_TOOLS="$EDVA_ROOT${_edva_root_sub:+/$_edva_root_sub}"
elif [ -n "${EDVA_HOME:-}" ]; then
  EDVA_ROOT="$EDVA_HOME"
  EDVA_TOOLS="$EDVA_HOME${_edva_root_sub:+/$_edva_root_sub}"
else
  EDVA_ROOT="$_edva_root_code_root"
  EDVA_TOOLS="$_edva_root_code_tools"
fi
EDVA_INSTALL="${EDVA_HOME:-$HOME/Dev/edva}"
EDVA_INSTALL_TOOLS="$EDVA_INSTALL${_edva_root_sub:+/$_edva_root_sub}"
EDVA_KERNEL_SUBDIR="$_edva_root_sub"
if [ -z "${EDVA_NODE:-}" ]; then
  EDVA_NODE="$(command -v node 2>/dev/null || true)"
  for _edva_root_n in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$EDVA_NODE" ] && break
    [ -x "$_edva_root_n" ] && EDVA_NODE="$_edva_root_n"
  done
  unset _edva_root_n
fi
unset _edva_root_lib _edva_root_code_tools _edva_root_code_root _edva_root_sub
