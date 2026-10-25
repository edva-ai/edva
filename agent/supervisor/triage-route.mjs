// triage-route.mjs — send per-message Gmail triage dispatches to the ops-light
// supervisor instead of the ops session (part of a determinism pass).
//
// Why. gmail-source runs inside the ops supervisor (it owns the Pub/Sub port),
// so every triage dispatch used to land in the ops session: Sonnet at --effort
// xhigh with the Chrome MCP and the biggest floor. A per-message triage turn
// needs none of that — the dispatch already carries the body, headers, Jev's
// verdict and the sender history, and the agent reads `triage-rules core` + one
// section. ops-light runs the same model and the same CLAUDE.md (its cwd
// symlinks ops-agent/CLAUDE.md) at --effort medium, with no Chrome.
//
// What moves. Only the per-message triage items gmail-source hands to
// `_dispatchTriage` (source `gmail:<messageId>`). Everything else gmail-source
// dispatches — batch catch-up, history-expired recovery, storm consolidation,
// periodic catch-up — and any mail addressed to Edva itself (the command
// channel, which may need Chrome or a long multi-step turn) stays on ops.
//
// Idempotency and counters are unchanged: gmail-source records the dispatch
// attempt (lib/dispatch-attempts.mjs) BEFORE calling us, and the
// RECLASSIFY flap counter lives in the shared reclassify-tracking.json that
// every tier's dispatcher reads. The ops-light ledger attributes cost under the
// same `gmail:<id>` source, and edva-cost-report unions both ledgers.
//
// Fails toward delivery: if ops-light is unhealthy, or the POST fails, the item
// goes to the local (ops) dispatcher exactly as before. Never drop an email.
//
// Config (agents.json → ops.gmailTriageTarget): "ops-light" (default) | "ops".
// Rollback: set it to "ops" and restart the ops supervisor.

import fs from "node:fs";

export function triageTargetFromConfig(agentsConfig, { selfAgent = "ops" } = {}) {
  const self = agentsConfig?.agents?.[selfAgent] || {};
  const target = self.gmailTriageTarget === undefined ? "ops-light" : self.gmailTriageTarget;
  if (!target || target === selfAgent) return null;
  const sup = agentsConfig?.agents?.[target]?.supervisor;
  if (!sup?.webhookPort || !sup?.healthPort) return null;
  return { agent: target, webhookPort: sup.webhookPort, healthPort: sup.healthPort };
}

export function makeTriageRouter({
  target,                 // { agent, webhookPort, healthPort } | null
  localDispatch,          // (content, source) => any — the ops dispatcher
  tokenFile,
  fetchFn = globalThis.fetch,
  readFile = (p) => fs.readFileSync(p, "utf8"),
  log = () => {},
  timeoutMs = 5000,
}) {
  const token = () => { try { return readFile(tokenFile).trim(); } catch { return ""; } };

  async function healthy() {
    try {
      const r = await fetchFn(`http://127.0.0.1:${target.healthPort}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return false;
      const j = await r.json();
      return j?.childAlive === true;
    } catch { return false; }
  }

  return async function routeTriage(content, source, { forceLocal = false } = {}) {
    if (!target || forceLocal) return { routed: "local", result: localDispatch(content, source) };
    if (!(await healthy())) {
      log(`triage-route ${source} → ops (fallback: ${target.agent} unhealthy)`);
      return { routed: "local", result: localDispatch(content, source) };
    }
    try {
      const headers = { "Content-Type": "application/json" };
      const t = token();
      if (t) headers.Authorization = `Bearer ${t}`;
      const r = await fetchFn(`http://127.0.0.1:${target.webhookPort}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: content, source }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { routed: target.agent };
    } catch (err) {
      log(`triage-route ${source} → ops (fallback: POST to ${target.agent} failed: ${err.message})`);
      return { routed: "local", result: localDispatch(content, source) };
    }
  };
}
