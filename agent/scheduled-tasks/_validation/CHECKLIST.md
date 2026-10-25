# Scheduled-task validation — run checklist (Task #4, gate-zero)

Goal: resolve the substrate fork (Cowork vs Claude Code Desktop local task) by testing
**V1 fires**, **V2 tool access**, **V3 billing surface**, **V4 runs/day cap** — on the host.

## Run A — Claude Code Desktop *local* task (tests full host access + its billing)
1. On the host, deploy the probe:
   `mkdir -p ~/.claude/scheduled-tasks/edva-sched-validation`
   `cp ~/Dev/edva/agent/scheduled-tasks/_validation/SKILL.md ~/.claude/scheduled-tasks/edva-sched-validation/`
2. In Claude.app on the host, open the **Schedule** tab → confirm the task appears (or
   create it there pointing at the same prompt). Set frequency = manual, then **Run now**.
3. **V1:** confirm a fresh session fired and finished.
4. **V2:** `cat ~/Dev/edva/data/sched-task-validation.log` — expect `V2-bash OK`,
   `V2-cli`, `V2-mcp OK`, `V2-connector OK`. (Full host access ⇒ this is the powerful path.)
5. **V3 (billing):** note the run in claude.ai usage. Before June 15 it draws from the
   subscription regardless; **after June 15, check whether this run debits the Agent SDK
   credit meter** (→ metered, bad) **or not** (→ subscription, good). This is the decision.

## Run B — Cowork scheduled task (tests the documented subscription carve-out)
1. In Claude.app → **Cowork** → create a scheduled task with the same prompt body.
2. **Run now.** Check the log + Cowork session output.
3. **V2:** expect `V2-bash UNAVAILABLE (sandboxed)` but hopefully `V2-mcp OK` / `V2-connector OK`
   — i.e. can Cowork reach edva's MCP servers + connectors from its VM?
4. **V3:** Cowork is the documented subscription carve-out — confirm it does NOT debit the
   Agent SDK meter after June 15.

## V4 — runs/day cap
In the Schedule/Cowork UI, note any stated per-day run limit for this Max tier. Try
scheduling a couple of quick runs and see if/when it refuses. Record the number.

## Decision matrix
- **Code-Desktop-local = subscription** → use it (full host access, playbooks run ~unchanged). Best case.
- **Code-Desktop-local = metered** but **Cowork reaches our MCP** → use Cowork + expose all
  edva tools via MCP (add a bash-bridge MCP for CLIs).
- **Neither** gives subscription + tool access → fall back to local + capped-API only; re-strategize the roster.

Report back: the four V results for Run A and Run B, and the V4 number.
