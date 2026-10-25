# instance.sh — source to export this installation's identity
# (EDVA_OWNER_EMAIL, EDVA_TZ, …) from lib/instance.cjs.
# Values already set in the environment win. Safe to source twice.
# Works under cron's bare PATH: node is looked up in PATH, then in the usual
# Homebrew / /usr/local locations.
# The kernel tree (root.sh, in a subshell so its variables do not leak into the caller).
_edva_instance_tools="$(source "$(dirname "${BASH_SOURCE[0]}")/root.sh" && printf '%s' "$EDVA_TOOLS")"
_edva_instance_node="$(command -v node 2>/dev/null || true)"
for _n in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$_edva_instance_node" ] && break
  [ -x "$_n" ] && _edva_instance_node="$_n"
done
if [ -n "$_edva_instance_node" ]; then
  while IFS= read -r _line; do
    _k="${_line%%=*}"; _v="${_line#*=}"
    if [ -z "${!_k:-}" ]; then
      _v="${_v#\"}"; _v="${_v%\"}"
      export "$_k=$_v"
    fi
  done < <("$_edva_instance_node" "$_edva_instance_tools/lib/instance.cjs" --env 2>/dev/null)
fi
unset _line _k _v _n _edva_instance_tools _edva_instance_node
