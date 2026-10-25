// snipping.mjs — WP2: native context-snipping engine (the amnesia killer).
//
// Replaces the blunt /compact-then-rotate (M1, interim) with Conway's model:
// mark ranges as compressible while work proceeds (registerSnip — does NOT apply
// immediately); only WHEN context crosses budget, collapse the OLDEST pending
// snips (FIFO) into one-line breadcrumbs; keep the full text recoverable from the
// WP4 message store (retrieveRange). Sessions stop hitting the amnesia wall, so
// rotation frequency drops further than M1 alone.
//
// Conway mechanisms mirrored (snipping.ts):
//   - pending snips applied lazily, oldest-first, until under token budget;
//   - BREADCRUMB_TOKENS = 60; marker "[Compressed: start..end @ MM-DD HH:MMZ] summary";
//   - AUTOSNIP: any tool_result > AUTOSNIP_MIN_TOKENS auto-registers once older
//     than AUTOSNIP_MIN_AGE_TURNS turns;
//   - PAIR rule: a snip range never orphans a tool_use from its tool_result;
//   - recovery via retrieveRange (WP4).
//
// Same memory-index.db, same mount-safe PRAGMA + fail-soft contract as
// event-fts.mjs / message-store.mjs. The pending_snips table is the only new
// state; raw ranges already live in agent_messages.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { retrieveRange, getToolPair } from "./message-store.mjs";

import { installTools } from "../../lib/root.cjs";
export const BREADCRUMB_TOKENS = 60;
export const AUTOSNIP_MIN_TOKENS = 2_500;
export const AUTOSNIP_MIN_AGE_TURNS = 3;

const HOME = os.homedir();
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

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
      CREATE TABLE IF NOT EXISTS pending_snips (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id      TEXT NOT NULL,
        start_seq     INTEGER NOT NULL,
        end_seq       INTEGER NOT NULL,
        summary       TEXT,
        registered_at INTEGER NOT NULL,
        applied       INTEGER NOT NULL DEFAULT 0
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_pending_snips_agent ON pending_snips(agent_id, applied, id)");
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

// Uncapped text length of message content — token accounting must see the FULL
// size (message-store.renderText is deliberately capped for the FTS index and
// must NOT be used here, or a huge result would under-count and never auto-snip).
function rawTextLength(content) {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n, p) => n + rawTextLength(p), 0);
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text.length;
    if (content.type === "tool_result") return rawTextLength(content.content);
    try { return JSON.stringify(content).length; } catch { return 0; }
  }
  return String(content).length;
}

// Rough token estimate. A breadcrumb is charged a FIXED BREADCRUMB_TOKENS
// regardless of its rendered length (Conway's rule); everything else ~chars/4.
export function estimateTokens(msgOrContent) {
  if (msgOrContent && typeof msgOrContent === "object" && msgOrContent.kind === "breadcrumb") return BREADCRUMB_TOKENS;
  const content = msgOrContent && typeof msgOrContent === "object" && "content" in msgOrContent
    ? msgOrContent.content : msgOrContent;
  return Math.ceil(rawTextLength(content) / 4);
}

export function totalTokens(messages) {
  let t = 0;
  for (const m of messages) t += estimateTokens(m);
  return t;
}

// Register a range as compressible. Does NOT apply — that happens lazily in
// applyToBudget when context crosses budget. The range is snapped to whole
// tool_use/tool_result PAIRs so a snip never orphans half a pair.
export function registerSnip({ agentId, startSeq, endSeq, summary = "" } = {}) {
  const d = db();
  if (!d || !agentId) return null;
  const [s, e] = snapToPairs(agentId, Math.min(startSeq, endSeq), Math.max(startSeq, endSeq));
  try {
    const r = d.prepare(
      "INSERT INTO pending_snips(agent_id, start_seq, end_seq, summary, registered_at, applied) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(agentId, s, e, summary || mechanicalSummary(agentId, s, e), Date.now());
    return Number(r.lastInsertRowid);
  } catch {
    return null;
  }
}

// Expand a range so it never splits a tool_use from its tool_result (PAIR rule).
function snapToPairs(agentId, startSeq, endSeq) {
  let s = startSeq, e = endSeq;
  // If a pair's use is inside the range but its result is outside (or vice
  // versa), extend the range to swallow the whole pair.
  const range = retrieveRange(agentId, startSeq, endSeq);
  for (const m of range) {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const id = p.tool_use_id || (p.type === "tool_use" ? p.id : null);
      if (!id) continue;
      const pair = getToolPair(id);
      if (!pair) continue;
      if (pair.use_seq != null) { s = Math.min(s, pair.use_seq); e = Math.max(e, pair.use_seq); }
      if (pair.result_seq != null) { s = Math.min(s, pair.result_seq); e = Math.max(e, pair.result_seq); }
    }
  }
  return [s, e];
}

function mechanicalSummary(agentId, startSeq, endSeq) {
  const n = endSeq - startSeq + 1;
  return `${n} message${n === 1 ? "" : "s"} (${startSeq}..${endSeq})`;
}

export function pendingSnips(agentId) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(
      "SELECT id, agent_id, start_seq, end_seq, summary, registered_at, applied FROM pending_snips WHERE agent_id = ? AND applied = 0 ORDER BY id ASC",
    ).all(agentId);
  } catch {
    return [];
  }
}

function markApplied(id) {
  const d = db();
  if (!d) return;
  try { d.prepare("UPDATE pending_snips SET applied = 1 WHERE id = ?").run(id); } catch {}
}

// Build the breadcrumb marker message that replaces a collapsed range.
function breadcrumb(startSeq, endSeq, summary, ts = null) {
  const when = (ts ? new Date(ts) : new Date());
  const stamp = when.toISOString().slice(5, 16).replace("T", " ") + "Z"; // MM-DD HH:MMZ
  const text = `[Compressed: ${startSeq}..${endSeq} @ ${stamp}] ${summary || ""}`.trim();
  return { role: "system", kind: "breadcrumb", content: [{ type: "text", text }], _snip: { startSeq, endSeq } };
}

// THE render step (called from Agent._runTurn). While the rendered context is
// over budget, pop the oldest pending snip and replace its message range with a
// single breadcrumb. Raw ranges stay in the store (retrieveRange rehydrates).
// Returns { messages, applied, tokensBefore, tokensAfter }.
export function applyToBudget(agentId, messages, { budget = 150_000 } = {}) {
  let rendered = messages.slice();
  const tokensBefore = totalTokens(rendered);
  const applied = [];
  if (tokensBefore <= budget) return { messages: rendered, applied, tokensBefore, tokensAfter: tokensBefore };

  const pending = pendingSnips(agentId);   // oldest-first
  for (const snip of pending) {
    if (totalTokens(rendered) <= budget) break;
    const idxs = rendered
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.seq != null && m.seq >= snip.start_seq && m.seq <= snip.end_seq)
      .map(({ i }) => i);
    if (!idxs.length) { markApplied(snip.id); continue; }  // stale range — retire it
    const first = idxs[0], last = idxs[idxs.length - 1];
    const crumb = breadcrumb(snip.start_seq, snip.end_seq, snip.summary, snip.registered_at);
    rendered.splice(first, last - first + 1, crumb);
    markApplied(snip.id);
    applied.push(snip.id);
  }
  return { messages: rendered, applied, tokensBefore, tokensAfter: totalTokens(rendered) };
}

// Auto-register oversized tool results that are old enough. `currentTurn` and a
// per-message `.turn` drive the age check; absent turns fall back to positional
// age (how many messages sit after it). Returns the count newly registered.
export function autoRegisterOversized(agentId, messages, { currentTurn = null, minTokens = AUTOSNIP_MIN_TOKENS, minAgeTurns = AUTOSNIP_MIN_AGE_TURNS } = {}) {
  let registered = 0;
  const already = new Set(pendingSnips(agentId).map((s) => `${s.start_seq}:${s.end_seq}`));
  messages.forEach((m, i) => {
    if (m.seq == null) return;
    if (!isToolResult(m)) return;
    if (estimateTokens(m) <= minTokens) return;
    const age = (currentTurn != null && m.turn != null)
      ? currentTurn - m.turn
      : messages.length - 1 - i;                 // positional fallback
    if (age < minAgeTurns) return;
    const key = `${m.seq}:${m.seq}`;
    if (already.has(key)) return;
    const id = registerSnip({ agentId, startSeq: m.seq, endSeq: m.seq, summary: `tool result (${estimateTokens(m)} tok)` });
    if (id != null) { registered++; already.add(key); }
  });
  return registered;
}

function isToolResult(m) {
  if (m.kind === "tool_result") return true;
  const parts = Array.isArray(m.content) ? m.content : [m.content];
  return parts.some((p) => p && typeof p === "object" && p.type === "tool_result");
}

// Rehydrate a collapsed range from the store (WP4) — what the agent calls to
// expand a breadcrumb back to raw text.
export function retrieveSnipRange(agentId, startSeq, endSeq) {
  return retrieveRange(agentId, startSeq, endSeq);
}

// Mechanical, no-LLM coalescing of adjacent applied ranges into one summary
// (Conway's gapSweepSummary) — used when several breadcrumbs abut.
export function gapSweepSummary(ranges) {
  if (!ranges.length) return "";
  const sorted = ranges.slice().sort((a, b) => a.startSeq - b.startSeq);
  const start = sorted[0].startSeq;
  const end = sorted[sorted.length - 1].endSeq;
  const n = sorted.length;
  return `[Compressed ${n} spans: ${start}..${end}]`;
}

export function stats(agentId = null) {
  const d = db();
  if (!d) return { available: false };
  try {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const args = agentId ? [agentId] : [];
    const total = d.prepare(`SELECT COUNT(*) AS n FROM pending_snips ${where}`).get(...args).n;
    const applied = d.prepare(`SELECT COUNT(*) AS n FROM pending_snips ${where ? where + " AND" : "WHERE"} applied = 1`).get(...args).n;
    return { available: true, total, applied, pending: total - applied };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
}
