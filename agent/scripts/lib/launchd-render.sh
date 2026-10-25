#!/usr/bin/env bash
# launchd-render.sh — render a launchd plist template from the repo.
#
# The kernel's plists in agent/launch-agents/ carry no machine paths:
#   __EDVA_HOME__   the checkout launchd runs from (default the installation,
#                      $HOME/Dev/edva; override with EDVA_LAUNCHD_ROOT)
#   __EDVA_TOOLS__  the kernel tree in that checkout (__EDVA_HOME__/tools
#                      here; lib/root.sh). A path below the kernel is written
#                      with this one, so the template is the same in every layout.
#   __HOME__           the user's home directory ($HOME)
# Each plist keeps its own PATH string written with those placeholders, so
# a rendered copy is the plist exactly as it was hand-written for this machine.
# A plist without placeholders (an installation's own agent) renders unchanged.
#
# Everything that puts a repo plist into ~/Library/LaunchAgents renders it
# first, never `cp`: agent/launch-agents/install.sh and the self-install
# in lib/launchd-kick.sh. Test: tests/launchd-render.test.mjs.
#
# Usage:
#   source agent/scripts/lib/launchd-render.sh
#   launchd_render_plist <template> <dest>      (dest "-" = stdout)

_LAUNCHD_RENDER_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

launchd_render_plist() {
  local src="$1" dst="$2" root tools home sub install
  # The installation and the layout (root.sh, in a subshell: nothing leaks).
  install="$(source "$_LAUNCHD_RENDER_LIB/root.sh" && printf '%s' "$EDVA_INSTALL")"
  sub="$(source "$_LAUNCHD_RENDER_LIB/root.sh" && printf '%s' "$EDVA_KERNEL_SUBDIR")"
  root="${EDVA_LAUNCHD_ROOT:-$install}"
  tools="$root${sub:+/$sub}"
  home="$HOME"
  # Escape the sed replacement (\, &, and the # delimiter).
  root=$(printf '%s' "$root" | sed -e 's/[\\&#]/\\&/g')
  tools=$(printf '%s' "$tools" | sed -e 's/[\\&#]/\\&/g')
  home=$(printf '%s' "$home" | sed -e 's/[\\&#]/\\&/g')
  if [ "$dst" = "-" ]; then
    sed -e "s#__EDVA_TOOLS__#${tools}#g" -e "s#__EDVA_HOME__#${root}#g" -e "s#__HOME__#${home}#g" "$src"
  else
    sed -e "s#__EDVA_TOOLS__#${tools}#g" -e "s#__EDVA_HOME__#${root}#g" -e "s#__HOME__#${home}#g" "$src" > "$dst"
  fi
}
