#!/bin/bash
# load-agent.sh — emit shell vars for an agent's config (sourced by launcher + watchdog)
# Usage: eval "$(load-agent.sh <chat|ops>)"
#
# Exports:
#   AGENT_MODEL, AGENT_CWD, AGENT_RUNTIME, AGENT_PERMISSION_MODE,
#   AGENT_ALLOWED_TOOLS (quoted string ready for claude CLI),
#   AGENT_DEV_CHANNELS (quoted string), AGENT_REMOTE_CONTROL_PREFIX,
#   AGENT_FALLBACK_MODEL, AGENT_MAX_BUDGET_USD,
#   AGENT_SUPERVISOR_CONTROL_PORT, _GMAIL_PUBSUB_PORT, _WEBHOOK_PORT, _HEALTH_PORT

set -euo pipefail
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

AGENT="${1:?usage: load-agent.sh <name>}"
CONFIG="${AGENT_CONFIG:-${MERLIN_HOME}/agent/config/agents.json}"

exec node -e '
const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const a = cfg.agents[process.argv[2]];
if (!a) { console.error("unknown agent: " + process.argv[2]); process.exit(1); }
const esc = s => "\"" + String(s).replace(/"/g, "\\\"") + "\"";
const tools = a.allowedTools.map(t => /[*]/.test(t) ? esc(t) : t).join(" ");
const channels = (a.devChannels || []).map(c => "server:" + c).join(" ");
const out = [
  `AGENT_MODEL=${esc(a.model)}`,
  `AGENT_CWD=${esc(a.cwd)}`,
  `AGENT_RUNTIME=${esc(a.runtime)}`,
  `AGENT_PERMISSION_MODE=${esc(a.permissionMode)}`,
  `AGENT_ALLOWED_TOOLS=${esc(tools)}`,
  `AGENT_DEV_CHANNELS=${esc(channels)}`,
  `AGENT_REMOTE_CONTROL_PREFIX=${esc(a.remoteControlPrefix || "")}`,
  `AGENT_FALLBACK_MODEL=${esc(a.fallbackModel || "")}`,
  `AGENT_MAX_BUDGET_USD=${esc(a.maxBudgetUsd || "")}`,
];
if (a.supervisor) {
  out.push(`AGENT_SUPERVISOR_CONTROL_PORT=${a.supervisor.controlPort || ""}`);
  out.push(`AGENT_SUPERVISOR_GMAIL_PUBSUB_PORT=${a.supervisor.gmailPubsubPort || ""}`);
  out.push(`AGENT_SUPERVISOR_WEBHOOK_PORT=${a.supervisor.webhookPort || ""}`);
  out.push(`AGENT_SUPERVISOR_HEALTH_PORT=${a.supervisor.healthPort || ""}`);
}
process.stdout.write(out.join("\n") + "\n");
' "$CONFIG" "$AGENT"
