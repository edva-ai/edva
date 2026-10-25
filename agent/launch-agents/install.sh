#!/bin/bash
# install.sh — render launchd plists from this directory into
# ~/Library/LaunchAgents and load them (macOS).
#
# The kernel's plists here are TEMPLATES: __EDVA_HOME__, __EDVA_TOOLS__ and __HOME__ are
# substituted at install time by launchd_render_plist
# (agent/scripts/lib/launchd-render.sh), so the repo carries no machine
# path. A plist without placeholders (an installation's own agent) is installed
# as it is. Never `cp` a template into ~/Library/LaunchAgents: launchd would
# run the literal placeholder paths.
#
# Usage:
#   agent/launch-agents/install.sh --list               plists + install state
#   agent/launch-agents/install.sh <label> [<label>…]   install / refresh these
#   agent/launch-agents/install.sh --dry-run <label>…   render to stdout, change nothing
#   agent/launch-agents/install.sh --uninstall <label>  bootout + remove
#
# Re-running on an installed label re-renders it, boots the old copy out and
# bootstraps the new one (launchd only re-reads a plist on bootstrap).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
# shellcheck source=../scripts/lib/launchd-render.sh
source "$HERE/../scripts/lib/launchd-render.sh"

DRY=0; LIST=0; UNINSTALL=0
LABELS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --list) LIST=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) LABELS+=("${a%.plist}") ;;
  esac
done

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

if [ "$LIST" = 1 ]; then
  for f in "$HERE"/*.plist; do
    l=$(basename "$f" .plist)
    state="not installed"
    [ -f "$DEST/$l.plist" ] && state="installed"
    command -v launchctl >/dev/null 2>&1 && loaded "$l" && state="loaded"
    grep -q '__EDVA_HOME__\|__EDVA_TOOLS__\|__HOME__' "$f" && state="$state (template)"
    printf '  %-48s %s\n' "$l" "$state"
  done
  exit 0
fi

if [ "${#LABELS[@]}" -eq 0 ]; then
  echo "usage: $0 --list | <label>… [--dry-run] [--uninstall]" >&2
  exit 64
fi
if [ "$DRY" = 0 ] && ! command -v launchctl >/dev/null 2>&1; then
  echo "install.sh: launchctl not found — launchd agents are macOS-only (use --dry-run to render)" >&2
  exit 2
fi

rc=0
for l in "${LABELS[@]}"; do
  tmpl="$HERE/$l.plist"
  if [ ! -f "$tmpl" ]; then echo "  ✗ $l: no plist $tmpl" >&2; rc=1; continue; fi
  if [ "$UNINSTALL" = 1 ]; then
    if [ "$DRY" = 1 ]; then echo "  would bootout + remove $l"; continue; fi
    launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
    rm -f "$DEST/$l.plist"
    echo "  ✓ $l removed"
    continue
  fi
  if [ "$DRY" = 1 ]; then launchd_render_plist "$tmpl" -; continue; fi
  mkdir -p "$DEST"
  launchd_render_plist "$tmpl" "$DEST/$l.plist.new"
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$DEST/$l.plist.new" >/dev/null; then
    echo "  ✗ $l: rendered plist does not lint" >&2; rm -f "$DEST/$l.plist.new"; rc=1; continue
  fi
  if loaded "$l"; then launchctl bootout "$DOMAIN/$l" 2>/dev/null || true; fi
  mv -f "$DEST/$l.plist.new" "$DEST/$l.plist"
  if launchctl bootstrap "$DOMAIN" "$DEST/$l.plist"; then
    echo "  ✓ $l loaded"
  else
    echo "  ✗ $l: launchctl bootstrap failed" >&2; rc=1
  fi
done
exit $rc
