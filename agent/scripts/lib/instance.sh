# instance.sh — source to export this installation's identity
# (MERLIN_OWNER_EMAIL, MERLIN_TZ, …) from lib/instance.cjs.
# Values already set in the environment win. Safe to source twice.
# Works under cron's bare PATH: node is looked up in PATH, then in the usual
# Homebrew / /usr/local locations.
# The kernel tree (root.sh, in a subshell so its variables do not leak into the caller).
_merlin_instance_tools="$(source "$(dirname "${BASH_SOURCE[0]}")/root.sh" && printf '%s' "$MERLIN_TOOLS")"
_merlin_instance_node="$(command -v node 2>/dev/null || true)"
for _n in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$_merlin_instance_node" ] && break
  [ -x "$_n" ] && _merlin_instance_node="$_n"
done
if [ -n "$_merlin_instance_node" ]; then
  while IFS= read -r _line; do
    _k="${_line%%=*}"; _v="${_line#*=}"
    if [ -z "${!_k:-}" ]; then
      _v="${_v#\"}"; _v="${_v%\"}"
      export "$_k=$_v"
    fi
  done < <("$_merlin_instance_node" "$_merlin_instance_tools/lib/instance.cjs" --env 2>/dev/null)
fi
unset _line _k _v _n _merlin_instance_tools _merlin_instance_node
