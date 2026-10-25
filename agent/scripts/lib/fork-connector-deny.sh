# fork-connector-deny.sh: the ONE list of connectors a Edva `claude -p` fork
# does not load, and the one list of skills it does not list. Sourced, not
# executed. Defines EDVA_FORK_CONNECTOR_DENY and EDVA_FORK_SKILL_SETTINGS,
# and the function edva_fork_settings (the git-rollback guard, at the end).
#
# Why one file. Every launcher that starts its own `claude -p` needs the deny
# on its own command line; copied one launcher at a time (supervisors, Opus
# forks, the daily-summary build, other jobs with their own `claude -p` lines)
# it drifts, and a missed launcher lists hundreds more tool names than its
# siblings. Each launcher reads this list, so the next one cannot drift.
#
# What goes on it: connectors with ZERO calls across the fork transcripts over
# the last month or two (Opus fork, subagent, daily-summary and other fork
# transcripts), and any second registration of a server the forks already reach
# under another name. A per-run deny, not an account change: the user's own
# Claude sessions keep every connector. Each launcher keeps its own override
# variable (an empty value turns the deny off for that launcher).
#
# Large unused connectors (hundreds of tool names, thousands of tokens re-read
# on every fork turn) belong here too.
# The supervisors' own deny lives with the agents (local config agents.json)
# and is not touched here.
# A server that looks idle in the derived listing may still be used by
# subagents (e.g. a second Chrome profile a job drives), and that listing does
# not scan subagent transcripts. Check subagents before adding one.
#
# Which connectors an account has is the installation's own list:
# agent/local/config/fork-connectors.json {"deny": ["mcp__<server>", ...]},
# read through instance.cjs localConfig (none when the file or node is missing).
_edva_fork_deny_tools="$(source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/root.sh" && printf '%s' "$EDVA_TOOLS")"
_edva_fork_deny_node="$(source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/root.sh" && printf '%s' "${EDVA_NODE:-node}")"
EDVA_FORK_CONNECTOR_DENY="$("$_edva_fork_deny_node" -e 'const c=require(process.argv[1]).localConfig("fork-connectors",{deny:[]});process.stdout.write((Array.isArray(c.deny)?c.deny:[]).filter((s)=>/^[A-Za-z0-9:_.-]+$/.test(s)).join(" "))' "$_edva_fork_deny_tools/lib/instance.cjs" 2>/dev/null || true)"
unset _edva_fork_deny_tools _edva_fork_deny_node

# Skills. Every fork turn also re-reads the
# skill list (dozens of skills, tens of thousands of chars on Sonnet and Opus).
# Three groups on it are never used by a Edva agent: the `anthropic-skills:*`
# synced from the claude.ai account (Office files, browsers, design), the
# installation's own skills in ~/.claude/skills that are not Edva's, and the
# skills bundled with Claude Code. Across thousands of transcripts over 45 days
# (every project dir, subagents included) the Skill tool was called only for
# Edva's own skills. Hiding the ones below measured roughly a quarter off a
# Sonnet turn's prefix (one-turn test, MCP off) and leaves only Edva's own
# skills listed. "user-invocable-only"
# hides a skill from the model and keeps /name; it is passed with --settings, so
# it binds that run only (the user's own sessions keep every skill).
# Do NOT add workflow-authoring: with it hidden, Claude Code pastes the whole
# workflow reference into the Workflow tool's description instead (tens of
# thousands of chars, measured). The product-management plugin skills are not on it either:
# skillOverrides does not reach plugin skills (tested). A job that needs one
# back sets FORK_SKILL_SETTINGS (or DS_SKILL_SETTINGS) to empty in its trigger.
#
# The installation's own ~/.claude/skills to hide are its own list:
# agent/local/config/fork-skills.json {"hidden": ["<skill>", ...]}, read
# through instance.cjs localConfig (none when the file or node is missing).
_edva_fork_skills_account="anthropic-skills:brand-guidelines anthropic-skills:built-in-browser anthropic-skills:canvas-design anthropic-skills:chrome-browser anthropic-skills:computer-use anthropic-skills:deep-research anthropic-skills:docs anthropic-skills:docx anthropic-skills:google-workspace anthropic-skills:import-memory anthropic-skills:internal-comms anthropic-skills:mcp-builder anthropic-skills:morning anthropic-skills:pdf anthropic-skills:pptx anthropic-skills:skill-creator anthropic-skills:theme-factory anthropic-skills:xlsx"
_edva_fork_skills_bundled="claude-api code-review dataviz fewer-permission-prompts init keybindings-help loop run schedule security-review simplify update-config"
_edva_fork_skills_tools="$(source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/root.sh" && printf '%s' "$EDVA_TOOLS")"
_edva_fork_skills_node="$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)"
_edva_fork_skills_local="$("$_edva_fork_skills_node" -e 'const c=require(process.argv[1]).localConfig("fork-skills",{hidden:[]});process.stdout.write((Array.isArray(c.hidden)?c.hidden:[]).filter((s)=>/^[A-Za-z0-9:_.-]+$/.test(s)).join(" "))' "$_edva_fork_skills_tools/lib/instance.cjs" 2>/dev/null || true)"
EDVA_FORK_SKILL_SETTINGS='{"skillOverrides":{'
_edva_fork_skills_sep=""
for _s in $_edva_fork_skills_account $_edva_fork_skills_local $_edva_fork_skills_bundled; do
  EDVA_FORK_SKILL_SETTINGS="$EDVA_FORK_SKILL_SETTINGS$_edva_fork_skills_sep\"$_s\":\"user-invocable-only\""
  _edva_fork_skills_sep=","
done
EDVA_FORK_SKILL_SETTINGS="$EDVA_FORK_SKILL_SETTINGS}}"
unset _s _edva_fork_skills_account _edva_fork_skills_bundled _edva_fork_skills_tools _edva_fork_skills_node _edva_fork_skills_local _edva_fork_skills_sep

# The git-rollback guard. `claude -p` takes ONE --settings, so
# a launcher passes its settings through this to get the PreToolUse hook
# (bin/rollback-guard: snapshot uncommitted work to
# refs/edva/pre-destructive/* before a destructive git command, or block it)
# merged in:   SETTINGS="$(edva_fork_settings "$SETTINGS")"
# The guard is kept even when a trigger empties its skill settings. If node or
# the merge fails, the input comes back unchanged (the fork still runs, unguarded).
edva_fork_settings() {
  local node out
  node="$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)"
  if out="$("$node" "$HOME/Dev/edva/bin/rollback-guard" --settings-json "${1:-}" 2>/dev/null)" && [ -n "$out" ]; then
    printf '%s' "$out"
  else
    printf '%s' "${1:-}"
  fi
}
