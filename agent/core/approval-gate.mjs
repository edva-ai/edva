// approval-gate.mjs — WP7 surpass-feature #4: a first-class "high-stakes action
// needs a signed owner approval" substrate primitive.
//
// Conway can gate an action behind a client prompt only while a client is
// attached. Edva is always-on with real financial/browser/home rails, so it
// needs the gate as a DURABLE substrate primitive: wrapping a tool with
// `gate()` turns its execution into a two-step handshake —
//
//   1. the agent "calls" the tool  → NO side effect runs; a pending_approvals
//      row is persisted and the handler returns { pending: true, approval_id }.
//   2. the OWNER approves out-of-band (phone-channel / the client app's approval
//      UI — the only trusted command channel) → approve(id) runs the real
//      handler exactly once and records the result.
//
// This is the substrate realization of the Financial-Operations rule "human
// approval is ALWAYS required before any purchase" (CLAUDE.md) — now a reusable
// primitive, not a per-flow convention. It composes with WP5 (an `approval-tool`
// contribution kind can register a pre-gated tool) and WP1 (the gated tool is a
// normal registry tool).
//
// SAFETY POSTURE — this gate FAILS CLOSED. Unlike recall/snip-semantic (which
// fail OPEN so a down dependency never silences Edva), a high-stakes gate
// that cannot persist its pending record MUST refuse to execute — never run a
// financial/destructive action we can't record or later prove was approved.
//
// The gate itself moves no money and makes no model call. It does NOT decide WHO
// may approve — that is the calling channel's job (phone-channel only). It never
// weakens the absolute bans: transfers/withdrawals remain forbidden regardless
// (no transfer tool exists to gate), and any purchase cap is the installation's
// own (local rules).

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { installTools } from "../../lib/root.cjs";
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

const DEFAULT_TTL_SECONDS = 24 * 3600; // an unapproved high-stakes ask expires in a day.

export function createApprovalGate({
  execute = null, // optional fallback runner: (toolName, input) => result (e.g. registry.executeTool)
  now = () => Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  // Underlying (pre-gate) handlers, keyed by tool name. Rebuilt on every startup
  // as tools are re-gated, so a pending row from before a bounce is still
  // resolvable once the same tools are registered again.
  const handlers = new Map();
  let _db = null;
  let _disabled = false;

  function db() {
    if (_db) return _db;
    if (_disabled) return null;
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      const d = new DatabaseSync(DB_PATH);
      d.exec("PRAGMA journal_mode=WAL");
      d.exec("PRAGMA synchronous=NORMAL");
      d.exec("PRAGMA busy_timeout=3000");
      d.exec(`
        CREATE TABLE IF NOT EXISTS pending_approvals (
          id          TEXT PRIMARY KEY,
          agent_id    TEXT,
          tool        TEXT NOT NULL,
          input_json  TEXT,
          summary     TEXT,
          risk        TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          reason      TEXT,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER,
          decided_at  INTEGER,
          result_json TEXT
        )
      `);
      d.exec("CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status, expires_at)");
      _db = d;
      return _db;
    } catch {
      _disabled = true;
      _db = null;
      return null;
    }
  }

  // Wrap a tool def so its execution becomes a persisted approval request.
  // `describe(input) -> string` renders the human-facing summary the owner sees.
  function gate(toolDef, { risk = "high", describe = null, agentId = null } = {}) {
    if (!toolDef || typeof toolDef.handler !== "function") {
      throw new Error("approval-gate: gate() needs a tool def with a handler");
    }
    const name = toolDef.name;
    handlers.set(name, toolDef.handler);
    return {
      ...toolDef,
      _gated: true,
      _risk: risk,
      async handler(input = {}) {
        const d = db();
        // FAIL CLOSED: no store → refuse, never run the side effect unrecorded.
        if (!d) {
          return { ok: false, error: `approval-gate: approval store unavailable — refusing to run ${name} without a durable approval record` };
        }
        const id = randomUUID();
        const ts = now();
        const summary = safeDescribe(describe, input) || `${name}(${compactInput(input)})`;
        try {
          d.prepare(
            "INSERT INTO pending_approvals(id, agent_id, tool, input_json, summary, risk, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
          ).run(id, agentId, name, JSON.stringify(input ?? {}), summary, risk, ts, ts + ttlSeconds * 1000);
        } catch (e) {
          return { ok: false, error: `approval-gate: could not persist approval (${e?.message || e}) — refusing to run ${name}` };
        }
        return { ok: false, pending: true, needs_approval: true, approval_id: id, tool: name, risk, summary };
      },
    };
  }

  function getRow(id) {
    const d = db();
    if (!d) return null;
    try { return d.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id) || null; } catch { return null; }
  }

  function pending(agentId = null) {
    const d = db();
    if (!d) return [];
    const t = now();
    try {
      const where = agentId
        ? "status = 'pending' AND (expires_at IS NULL OR expires_at > ?) AND agent_id = ?"
        : "status = 'pending' AND (expires_at IS NULL OR expires_at > ?)";
      const args = agentId ? [t, agentId] : [t];
      return d.prepare(`SELECT id, agent_id, tool, summary, risk, created_at, expires_at FROM pending_approvals WHERE ${where} ORDER BY created_at ASC`).all(...args);
    } catch { return []; }
  }

  // Owner-driven APPROVE: run the real handler exactly once, record the result.
  // MUST only be invoked from the trusted owner channel (phone-channel).
  async function approve(id) {
    const d = db();
    if (!d) return { ok: false, error: "approval-gate: store unavailable" };
    const row = getRow(id);
    if (!row) return { ok: false, error: "approval-gate: unknown approval id" };
    if (row.status !== "pending") return { ok: false, error: `approval-gate: already ${row.status}` };
    if (row.expires_at != null && row.expires_at <= now()) {
      try { d.prepare("UPDATE pending_approvals SET status='expired', decided_at=? WHERE id=?").run(now(), id); } catch {}
      return { ok: false, error: "approval-gate: approval expired" };
    }
    let input = {};
    try { input = JSON.parse(row.input_json || "{}"); } catch {}
    const runner = handlers.get(row.tool) || (execute ? (inp) => execute(row.tool, inp) : null);
    if (!runner) return { ok: false, error: `approval-gate: no handler bound for ${row.tool}` };
    // Mark executing BEFORE running so a crash mid-run can't double-execute.
    try { d.prepare("UPDATE pending_approvals SET status='executing', decided_at=? WHERE id=?").run(now(), id); } catch {}
    let result;
    try {
      result = await runner(input);
    } catch (e) {
      result = { ok: false, error: `approval-gate: handler threw (${e?.message || e})` };
    }
    try {
      d.prepare("UPDATE pending_approvals SET status='executed', result_json=? WHERE id=?").run(JSON.stringify(result ?? null), id);
    } catch {}
    return { ok: true, approval_id: id, tool: row.tool, result };
  }

  function deny(id, reason = "") {
    const d = db();
    if (!d) return { ok: false, error: "approval-gate: store unavailable" };
    const row = getRow(id);
    if (!row) return { ok: false, error: "approval-gate: unknown approval id" };
    if (row.status !== "pending") return { ok: false, error: `approval-gate: already ${row.status}` };
    try { d.prepare("UPDATE pending_approvals SET status='denied', reason=?, decided_at=? WHERE id=?").run(reason, now(), id); } catch {}
    return { ok: true, approval_id: id, status: "denied" };
  }

  function expireStale() {
    const d = db();
    if (!d) return 0;
    try {
      const r = d.prepare("UPDATE pending_approvals SET status='expired' WHERE status='pending' AND expires_at IS NOT NULL AND expires_at <= ?").run(now());
      return Number(r.changes || 0);
    } catch { return 0; }
  }

  function stats() {
    const d = db();
    if (!d) return { pending: 0 };
    try {
      const rows = d.prepare("SELECT status, COUNT(*) AS n FROM pending_approvals GROUP BY status").all();
      const out = {};
      for (const r of rows) out[r.status] = r.n;
      return out;
    } catch { return {}; }
  }

  function _closeForTest() {
    try { _db?.close(); } catch {}
    _db = null;
    _disabled = false;
    handlers.clear();
  }

  return { gate, approve, deny, pending, get: getRow, expireStale, stats, _closeForTest };
}

function safeDescribe(describe, input) {
  if (typeof describe !== "function") return null;
  try { const s = describe(input); return typeof s === "string" ? s : null; } catch { return null; }
}

function compactInput(input) {
  try {
    const s = JSON.stringify(input ?? {});
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch { return "..."; }
}
