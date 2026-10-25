// message-store.mjs — WP4: the unified, append-only substrate of record.
//
// Conway's edge is that an agent is a persistent, addressable object that owns
// its own message array AND a durable store behind it (messages.db). This module
// is Edva's equivalent: a single append-only message store over the SAME
// memory-index.db the wiki + events_fts already live in (one DB, one backup, one
// durability regime — a user directive).
//
// What it stores that the existing layers don't:
//   - wiki `pages`      : curated memory the agent chose to write.
//   - `events_fts`      : the supervisor event firehose (dispatch lifecycle).
//   - `agent_messages`  : EVERY message in an Agent's context array (role/kind/
//                         content), keyed by (agent_id, seq) — the thing snipping
//                         (WP2), forks (WP3), and continuity (WP6) all address.
//
// It generalizes M2's events_fts into the substrate of record: same DB, same
// mount-safe PRAGMA discipline, same fail-soft "return null → degrade" contract
// as event-fts.mjs. Nothing live depends on it yet — it is the foundation the
// core Agent (WP0) persists into.
//
// Tables (all prefixed `agent_*` / `agents` / `tool_pairs` to avoid colliding
// with the wiki's `pages` and the `events_fts` virtual table in the same file):
//   agent_messages(seq PK, agent_id, role, kind, content_json, ts)
//   agent_messages_fts  FTS5 over rendered text (+ UNINDEXED agent_id/seq/role)
//   agents(id PK, kind, label, status, forked_from_seq, forked_context_start_seq,
//          auto_join, joined_at, created_at, updated_at)
//   tool_pairs(tool_use_id PK, agent_id, use_seq, result_seq)   -- WP2 PAIR rule
//   inbound_queue(seq PK, agent_id, parts_json, ts, processed)  -- WP6 durable mailbox

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installTools } from "../../lib/root.cjs";
const HOME = os.homedir();

const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

// Rendered-text cap for the FTS row. A single message can be huge (a 50KB tool
// result); we index a bounded projection for recall and keep the full content in
// content_json. Snipping (WP2) is what actually bounds the live context.
const MAX_FTS_TEXT = 8000;

let _db = null;
let _disabled = false;
const _stmts = {};

// Open (once) and ensure the schema exists. Returns the handle or null when
// unavailable — every caller tolerates null and degrades (mirrors event-fts.mjs).
function db() {
  if (_db) return _db;
  if (_disabled) return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA busy_timeout=3000");
    d.exec("PRAGMA foreign_keys=ON");
    d.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id     TEXT NOT NULL,
        role         TEXT NOT NULL,        -- user | assistant | system | tool
        kind         TEXT,                 -- text | tool_use | tool_result | breadcrumb | ...
        content_json TEXT NOT NULL,        -- the raw content (string or parts[]) as JSON
        ts           TEXT NOT NULL
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_agent_messages_agent ON agent_messages(agent_id, seq)");
    // Plain (non-external-content) FTS5, matching the events_fts convention:
    // searchable `text`, UNINDEXED metadata we filter/join on. porter+unicode61
    // so message search behaves identically to pages_fts / events_fts.
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_messages_fts USING fts5(
        agent_id UNINDEXED,
        seq UNINDEXED,
        role UNINDEXED,
        text,
        tokenize='porter unicode61'
      )
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id                       TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL DEFAULT 'main',  -- main | subagent | fork
        label                    TEXT,
        status                   TEXT NOT NULL DEFAULT 'idle',  -- idle | running | error
        forked_from_seq          INTEGER,
        forked_context_start_seq INTEGER,
        auto_join                INTEGER NOT NULL DEFAULT 1,
        joined_at                TEXT,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS tool_pairs (
        tool_use_id TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        use_seq     INTEGER NOT NULL,
        result_seq  INTEGER
      )
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS inbound_queue (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id  TEXT NOT NULL,
        parts_json TEXT NOT NULL,
        ts        TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_inbound_agent ON inbound_queue(agent_id, processed, seq)");
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

function stmt(key, sql) {
  if (_stmts[key]) return _stmts[key];
  const d = db();
  if (!d) return null;
  _stmts[key] = d.prepare(sql);
  return _stmts[key];
}

// Render arbitrary message content to a flat searchable string. Content may be a
// string, an array of content parts ({type:'text',text}, {type:'tool_use',...},
// {type:'tool_result',content}, image blocks, etc.), or any object. We extract
// human/searchable text and stringify the rest compactly, then cap.
export function renderText(content) {
  let out = "";
  const push = (s) => { if (s) out += (out ? " " : "") + s; };
  const part = (p) => {
    if (p == null) return;
    if (typeof p === "string") { push(p); return; }
    if (typeof p !== "object") { push(String(p)); return; }
    if (typeof p.text === "string") { push(p.text); return; }
    if (p.type === "tool_use") { push(p.name || "tool_use"); if (p.input) { try { push(JSON.stringify(p.input)); } catch {} } return; }
    if (p.type === "tool_result") { part(p.content); return; }
    if (p.type === "image") { push("[image]"); return; }
    try { push(JSON.stringify(p)); } catch {}
  };
  if (Array.isArray(content)) content.forEach(part);
  else part(content);
  if (out.length > MAX_FTS_TEXT) out = out.slice(0, MAX_FTS_TEXT);
  return out;
}

// Append one message to an agent's context array. Returns its seq, or null if
// the store is unavailable. `content` is stored verbatim as JSON; a rendered
// projection is indexed for FTS.
export function appendMessage({ agentId, role, kind = null, content, ts = null } = {}) {
  const d = db();
  if (!d) return null;
  if (!agentId || !role) throw new Error("appendMessage: agentId and role are required");
  const when = ts || new Date().toISOString();
  let json;
  try { json = JSON.stringify(content ?? null); } catch { json = JSON.stringify(String(content ?? "")); }
  try {
    const r = stmt("insMsg",
      "INSERT INTO agent_messages(agent_id, role, kind, content_json, ts) VALUES (?, ?, ?, ?, ?)",
    ).run(agentId, role, kind, json, when);
    const seq = Number(r.lastInsertRowid);
    const text = renderText(content);
    if (text) {
      stmt("insFts",
        "INSERT INTO agent_messages_fts(agent_id, seq, role, text) VALUES (?, ?, ?, ?)",
      ).run(agentId, String(seq), role, text);
    }
    return seq;
  } catch {
    return null;
  }
}

function parseRow(r) {
  let content;
  try { content = JSON.parse(r.content_json); } catch { content = r.content_json; }
  return { seq: r.seq, agentId: r.agent_id, role: r.role, kind: r.kind, content, ts: r.ts };
}

// The last `limit` messages for an agent, returned oldest-first (chronological)
// so a caller can splice them straight into a context array.
export function getRecentMessages(agentId, limit = 100) {
  const d = db();
  if (!d) return [];
  try {
    const rows = stmt("recent",
      "SELECT * FROM agent_messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?",
    ).all(agentId, limit);
    return rows.map(parseRow).reverse();
  } catch {
    return [];
  }
}

// Recover a raw contiguous range [startSeq, endSeq] (inclusive) for an agent —
// what snipping (WP2) rehydrates when a breadcrumb is expanded.
export function retrieveRange(agentId, startSeq, endSeq) {
  const d = db();
  if (!d) return [];
  try {
    return stmt("range",
      "SELECT * FROM agent_messages WHERE agent_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC",
    ).all(agentId, startSeq, endSeq).map(parseRow);
  } catch {
    return [];
  }
}

// Full-text search across an agent's messages (or all agents when agentId is
// null). BM25-ranked with a recency tiebreak, mirroring searchEvents.
export function searchFTS(agentId, query, { limit = 20 } = {}) {
  const d = db();
  if (!d) return [];
  const expr = toFtsExpr(query);
  if (!expr) return [];
  const where = ["agent_messages_fts MATCH ?"];
  const params = [expr];
  if (agentId) { where.push("agent_id = ?"); params.push(agentId); }
  try {
    const rows = stmt("ftsSearch" + (agentId ? "A" : ""),
      `SELECT agent_id, seq, role,
              snippet(agent_messages_fts, 3, '«', '»', '…', 18) AS snippet,
              bm25(agent_messages_fts) AS score
       FROM agent_messages_fts WHERE ${where.join(" AND ")}
       ORDER BY bm25(agent_messages_fts) LIMIT ?`,
    ).all(...params, limit);
    return rows.map((r) => ({
      agentId: r.agent_id, seq: Number(r.seq), role: r.role,
      snippet: r.snippet || "", score: r.score,
    }));
  } catch {
    return [];
  }
}

function toFtsExpr(query) {
  const cleaned = String(query || "").replace(/['"]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

// ---- agents registry (forks/subagents live here — WP3) --------------------

export function upsertAgent({ id, kind = "main", label = null, status = "idle", forkedFromSeq = null, forkedContextStartSeq = null, autoJoin = true } = {}) {
  const d = db();
  if (!d || !id) return null;
  try {
    stmt("upAgent",
      `INSERT INTO agents(id, kind, label, status, forked_from_seq, forked_context_start_seq, auto_join, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind, label=excluded.label, status=excluded.status,
         forked_from_seq=excluded.forked_from_seq,
         forked_context_start_seq=excluded.forked_context_start_seq,
         auto_join=excluded.auto_join, updated_at=datetime('now')`,
    ).run(id, kind, label, status, forkedFromSeq, forkedContextStartSeq, autoJoin ? 1 : 0);
    return id;
  } catch {
    return null;
  }
}

export function getAgentRow(id) {
  const d = db();
  if (!d) return null;
  try {
    const r = stmt("getAgent", "SELECT * FROM agents WHERE id = ?").get(id);
    if (!r) return null;
    return { ...r, auto_join: !!r.auto_join };
  } catch {
    return null;
  }
}

export function setAgentStatus(id, status) {
  const d = db();
  if (!d) return;
  try {
    stmt("setStatus", "UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  } catch {}
}

// ---- tool pairs (WP2 needs use+result as an atomic PAIR) -------------------

export function registerToolPair({ toolUseId, agentId, useSeq, resultSeq = null } = {}) {
  const d = db();
  if (!d || !toolUseId) return;
  try {
    stmt("insPair",
      `INSERT INTO tool_pairs(tool_use_id, agent_id, use_seq, result_seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(tool_use_id) DO UPDATE SET result_seq=excluded.result_seq`,
    ).run(toolUseId, agentId, useSeq, resultSeq);
  } catch {}
}

export function setToolResultSeq(toolUseId, resultSeq) {
  const d = db();
  if (!d) return;
  try {
    stmt("updPair", "UPDATE tool_pairs SET result_seq = ? WHERE tool_use_id = ?").run(resultSeq, toolUseId);
  } catch {}
}

export function getToolPair(toolUseId) {
  const d = db();
  if (!d) return null;
  try {
    return stmt("getPair", "SELECT * FROM tool_pairs WHERE tool_use_id = ?").get(toolUseId) || null;
  } catch {
    return null;
  }
}

// ---- durable inbound mailbox (WP6 sendDurable) ----------------------------

// Persist an inbound message so it survives a crash between enqueue and process.
// Returns the row seq. `parts` is any JSON-serializable steering payload.
export function enqueueInbound(agentId, parts) {
  const d = db();
  if (!d || !agentId) return null;
  try {
    const r = stmt("enq",
      "INSERT INTO inbound_queue(agent_id, parts_json, ts, processed) VALUES (?, ?, ?, 0)",
    ).run(agentId, JSON.stringify(parts ?? null), new Date().toISOString());
    return Number(r.lastInsertRowid);
  } catch {
    return null;
  }
}

// Unprocessed inbound rows for an agent, oldest-first — replayed on boot so a
// message enqueued before a supervisor bounce is not lost.
export function pendingInbound(agentId) {
  const d = db();
  if (!d) return [];
  try {
    return stmt("pend",
      "SELECT seq, agent_id, parts_json, ts FROM inbound_queue WHERE agent_id = ? AND processed = 0 ORDER BY seq ASC",
    ).all(agentId).map((r) => {
      let parts; try { parts = JSON.parse(r.parts_json); } catch { parts = r.parts_json; }
      return { seq: r.seq, agentId: r.agent_id, parts, ts: r.ts };
    });
  } catch {
    return [];
  }
}

export function markInboundProcessed(seq) {
  const d = db();
  if (!d) return;
  try {
    stmt("markProc", "UPDATE inbound_queue SET processed = 1 WHERE seq = ?").run(seq);
  } catch {}
}

// ---- migration / maintenance ----------------------------------------------

// One-time backfill: replay events.ndjson lines into agent_messages so history
// is unified under the store. Maps each event to a message row (role derived
// from the event kind). Idempotent-ish only if the target agent has no rows yet
// — callers should guard. `agentFor(file)` maps a path → agent id.
export function backfillFromNdjson(files, { agentFor = null } = {}) {
  const d = db();
  if (!d) return { imported: 0, files: 0, errors: [] };
  const label = agentFor || ((p) => { const m = /supervisor-([^/]+)/.exec(p); return m ? m[1] : "unknown"; });
  const stats = { imported: 0, files: 0, errors: [] };
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { stats.errors.push({ file, error: e.message }); continue; }
    stats.files++;
    const agentId = label(file);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const role = ev.role || (ev.kind === "result" ? "assistant" : "system");
      const seq = appendMessage({ agentId, role, kind: ev.kind || ev.type || null, content: ev.result ?? ev, ts: ev.ts });
      if (seq != null) stats.imported++;
    }
  }
  return stats;
}

export function stats() {
  const d = db();
  if (!d) return { available: false };
  try {
    const messages = d.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n;
    const agents = d.prepare("SELECT COUNT(*) AS n FROM agents").get().n;
    const inbound = d.prepare("SELECT COUNT(*) AS n FROM inbound_queue WHERE processed = 0").get().n;
    const byAgent = d.prepare("SELECT agent_id, COUNT(*) AS n FROM agent_messages GROUP BY agent_id ORDER BY n DESC LIMIT 12").all();
    return { available: true, messages, agents, pendingInbound: inbound, byAgent };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// Test helper — close so a fresh MEMORY_INDEX_DB path can be opened.
export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
  for (const k of Object.keys(_stmts)) delete _stmts[k];
}

export const MESSAGE_STORE_DB_PATH = DB_PATH;
