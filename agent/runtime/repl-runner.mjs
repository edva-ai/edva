// repl-runner.mjs — the SAFE activation of the WP8 agentic REPL (repl-sandbox.mjs).
//
// The REPL itself is a general primitive that's dangerous by construction
// (arbitrary code-eval on a box with financial rails). This runner constructs
// it behind a hard, read/compute-only boundary so it can be exposed to the live
// agent as the `repl_run` MCP tool without opening a code-execution attack
// surface. The security model (verified against tool-registry.mjs + the vm):
//
//   1. The vm context has NO `require`/`fs`/`process`/`child_process` — only the
//      injected bridge + ECMAScript intrinsics. Code cannot reach the host.
//   2. The bridge is `executeTool` + camelCase globals for REGISTERED tools only,
//      `sample` (Haiku fork), and pure JS. We register ONLY read/compute tools
//      (REPL_READ_ALLOWLIST) — so `executeTool('email-send', …)` returns
//      `{ok:false, "unknown tool"}`, never executes. There is no path from REPL
//      code to writing/sending/paying/browsing.
//   3. Shell is OFF (`enableShell:false`).
//   4. `sample()` (the one resource risk — a code loop could fan out many
//      `claude -p` Haiku forks) is wrapped with a concurrency cap + a per-run
//      budget, so a runaway loop can't spawn an unbounded fork storm.
//   5. Kill switch: `REPL_ENABLED=0` disables eval (the sandbox returns a
//      disabled error). Default-on (activated by the user).
//
// This runner is why `repl_run` is safe even when the CALLING agent turn is
// prompt-injected: the worst an injected `repl_run(code)` can do is read memory
// and burn a bounded amount of Haiku compute.

import { createReplSandbox, makeClaudeSampler } from "./repl-sandbox.mjs";
import { createToolRegistry } from "../core/tool-registry.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ws = require("../../lib/wiki-store.js"); // lib/wiki-store.js (write path)

// READ / COMPUTE ONLY. The security boundary is this list: a tool not named here
// is never registered, so REPL code cannot invoke it. Keep it to tools that
// cannot write, send, pay, or browse. (No wiki_save, no email/gmail, no
// calendar-write, no bank/brokerage, no browser/computer-use, no delete.)
export const REPL_READ_ALLOWLIST = [
  "wiki_search",
  "wiki_read",
  "wiki_list",
  "wiki_backlinks",
  "wiki_associate",
  "wiki_map",
  "recall",
  "recall_events",
  "episode_get",
  "episode_search",
  "episode_list",
];

// SAFE MEMORY WRITES. The REPL can also do bulk memory
// maintenance, but writes are the escalation point, so they're guarded, capped,
// attributed (edited_by=repl → revertable via `wiki history`), and NEVER able to
// hard-delete. Registered directly into the REPL registry (not new general agent
// tools) so the write capability is REPL-scoped.
export const REPL_WRITE_ALLOWLIST = ["wiki_save", "wiki_supersede"];
const MAX_WRITES_PER_RUN = 20;                        // bound a poisoning loop
const PROTECTED_WRITE_TYPES = new Set(["day", "week", "month"]); // episodic = immutable
const MAX_CONCURRENT_SAMPLES = 3; // at most N in-flight claude -p Haiku forks
const MAX_SAMPLES_PER_RUN = 40;   // per repl_run call, so a loop can't fork-storm

// Wrap a base sampler with a concurrency semaphore + a per-run budget.
// resetRun() is called by repl_run before each evaluate. `base` defaults to the
// Max-compliant Haiku fork; tests inject a mock. Exported for unit testing.
export function makeCappedSampler(base = makeClaudeSampler()) {
  let budget = MAX_SAMPLES_PER_RUN;
  let active = 0;
  const waiters = [];
  const acquire = () =>
    new Promise((res) => {
      if (active < MAX_CONCURRENT_SAMPLES) { active++; res(); }
      else waiters.push(res);
    });
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) { active++; next(); }
  };
  const sampler = async (args) => {
    if (budget <= 0) return "[sample budget exhausted for this repl_run]";
    budget--;
    await acquire();
    try {
      return await base(args);
    } finally {
      release();
    }
  };
  return { sampler, resetRun: () => { budget = MAX_SAMPLES_PER_RUN; } };
}

// Refuse a write to a protected page: episodic (day/week/month, an immutable
// record) or a pin_locked identity-core page (the owner's user_ page, feedback rules, …).
// A brand-new page (getPage → null) or an ordinary existing page is allowed.
// Returns a refusal reason string, or null when the write is permitted.
function guardWrite(id) {
  let p = null;
  try { p = ws.getPage(id); } catch { return null; } // if we can't check, don't block a new page
  if (!p) return null;
  if (PROTECTED_WRITE_TYPES.has(p.type)) return `refused: ${id} is an episodic ${p.type} page (immutable via REPL)`;
  if (p.pin_locked) return `refused: ${id} is a pin_locked identity-core page (protected from REPL writes)`;
  return null;
}

let _sandbox = null;
let _resetRun = null;

// Lazily build a single persistent sandbox per process (so REPL variables
// survive across repl_run calls — the "buffers outside context" property).
// `mcpTools` is the tools-mcp TOOLS array; only the read-allowlisted ones are
// registered from it. Write handlers are registered directly (REPL-scoped).
export function getReplSandbox(mcpTools = []) {
  if (_sandbox) return { sandbox: _sandbox, resetRun: _resetRun };
  const registry = createToolRegistry({ allowlist: [...REPL_READ_ALLOWLIST, ...REPL_WRITE_ALLOWLIST] });
  const readTools = (mcpTools || []).filter((t) => REPL_READ_ALLOWLIST.includes(t.name));
  // registerFromMcpTools reads {name, description, schema, run} → handler=run.
  registry.registerFromMcpTools(readTools);

  // Per-run write budget (reset alongside the sample budget by resetRun).
  let writeBudget = MAX_WRITES_PER_RUN;
  registry.registerTool({
    name: "wiki_save",
    description: "Create or overwrite a wiki page. args: {id, body} where body is the full raw_md (frontmatter + body). Tracked revision (edited_by=repl), revertable via `wiki history`. Refuses episodic + pin_locked pages; capped per run.",
    schema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] },
    handler: async ({ id, body } = {}) => {
      if (writeBudget <= 0) return { ok: false, error: "wiki_save: write budget exhausted for this repl_run" };
      if (!id || typeof body !== "string" || !body.trim()) return { ok: false, error: "wiki_save: id and non-empty body required" };
      const refusal = guardWrite(id);
      if (refusal) return { ok: false, error: refusal };
      writeBudget--;
      try { const r = ws.savePage(id, body, { editedBy: "repl" }); return { ok: true, id, rev: r?.rev ?? null }; }
      catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
  });
  registry.registerTool({
    name: "wiki_supersede",
    description: "Mark an old page superseded by a new one (status flip + edge; the old page's content is preserved and revertable). args: {old_id, new_id}. Refuses episodic + pin_locked old pages; capped per run.",
    schema: { type: "object", properties: { old_id: { type: "string" }, new_id: { type: "string" } }, required: ["old_id", "new_id"] },
    handler: async ({ old_id, new_id } = {}) => {
      if (writeBudget <= 0) return { ok: false, error: "wiki_supersede: write budget exhausted for this repl_run" };
      if (!old_id || !new_id) return { ok: false, error: "wiki_supersede: old_id and new_id required" };
      const refusal = guardWrite(old_id);
      if (refusal) return { ok: false, error: refusal };
      writeBudget--;
      try { ws.supersedePage(old_id, new_id, { editedBy: "repl" }); return { ok: true, old_id, new_id }; }
      catch (e) { return { ok: false, error: e?.message || String(e) }; }
    },
  });

  const cap = makeCappedSampler();
  _resetRun = () => { cap.resetRun(); writeBudget = MAX_WRITES_PER_RUN; };
  _sandbox = createReplSandbox({
    sessionId: "agent-repl",
    registry,
    sampler: cap.sampler,
    store: null, // no message-store bound in v1 → db bridge is inert (returns [])
    enabled: process.env.REPL_ENABLED !== "0", // kill switch
    enableShell: false, // never
  });
  return { sandbox: _sandbox, resetRun: _resetRun };
}

// Test/maintenance: drop the singleton so a fresh registry/allowlist can be built.
export function _resetForTest() {
  try { _sandbox?.dispose?.(); } catch {}
  _sandbox = null;
  _resetRun = null;
}
