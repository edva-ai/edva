// event-fts.mjs — full-text recall over the supervisor event stream.
//
// wiki-store.js gives the agent a lovely FTS layer, but only over *curated*
// pages — memory the agent chose to write. The raw activity stream
// (agent/logs/supervisor-*/events.ndjson, append-only JSONL) was not
// relevance-searchable: anything that happened but never got promoted to a
// wiki page was effectively unrecallable except by grepping JSONL by hand.
//
// This module adds an `events_fts` FTS5 table to the SAME memory-index.db the
// wiki uses, and the supervisor's EventLog.append() tees every event into it
// (best-effort). The JSONL files stay the durable source of truth; this table
// is a *derived* index that can be dropped and rebuilt from them at any time
// (see rebuildFromFiles / the `recall-events rebuild` CLI).
//
// Design notes:
//   - Same DB as wiki-store on purpose (user directive 2026-07-08): one memory
//     store, one backup, one place the agent's `recall_events` / `wiki_search`
//     tools both live. WAL + busy_timeout make the cross-process writes (the
//     supervisor writes; tools-mcp/CLIs read) safe on the single production host.
//   - Everything here is fail-soft. A DB that can't be opened (missing dir on a
//     non-production host, lock contention, corrupt file) DISABLES the tee rather
//     than throwing into the supervisor's hot event loop. Recall degrades to
//     "empty results"; the JSONL firehose is untouched.
//   - `text` is a compact projection: JSON.stringify(ev.result ?? ev) capped at
//     4000 chars. For `result` events that's the assistant's final output (the
//     highest-value recall content); for everything else it's the event itself.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { packF32, unpackF32, knn as knnRows, rrfFuse } from "./hybrid-recall.mjs";

import { installTools } from "./root.cjs";
// High-value event kinds worth embedding for semantic recall — the agent's
// final outputs and the task descriptions. The system/assistant/user firehose
// is deliberately excluded (noise, and too high-volume to embed).
const EMBED_KINDS = ["result", "dispatcher.dispatching", "dispatcher.turn_complete"];

const HOME = os.homedir();

const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

const MAX_TEXT = 4000;

let _db = null;
let _insert = null;
let _disabled = false;

// Open (once) and ensure the events_fts table exists. Returns the db handle or
// null when unavailable — callers must tolerate null.
function db() {
  if (_db) return _db;
  if (_disabled) return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA busy_timeout=3000");
    // FTS5 over the event stream. ts/agent/dispatch_id are UNINDEXED (stored +
    // retrievable, not tokenized) so we can filter/prune on them without
    // bloating the term index; kind/source/text are searchable. porter stemmer
    // + unicode61 matches wiki-store's pages_fts so queries behave the same.
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        ts UNINDEXED,
        kind,
        source,
        agent UNINDEXED,
        dispatch_id UNINDEXED,
        text,
        tokenize='porter unicode61'
      )
    `);
    // Semantic layer (opt-in, additive). One embedding per high-value event,
    // keyed by the events_fts rowid. Populated OUT of band by `embedPending`
    // (CLI/cron), never on the append() hot path — embedding the full firehose
    // via Ollama would be far too slow. Hybrid search fuses FTS + KNN over this;
    // if it's empty or the embedder is down, recall degrades to pure FTS.
    d.exec(`
      CREATE TABLE IF NOT EXISTS event_embeddings (
        event_rowid INTEGER PRIMARY KEY,
        model       TEXT,
        dim         INTEGER,
        embedding   BLOB NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);
    _db = d;
    _insert = d.prepare(
      "INSERT INTO events_fts(ts, kind, source, agent, dispatch_id, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    return _db;
  } catch (err) {
    // Disable permanently for this process so we don't retry on every event.
    _disabled = true;
    _db = null;
    _insert = null;
    return null;
  }
}

// Project a raw event object to the compact FTS row. Mirrors the JSONL shape:
// EventLog.append() stamps `ts` and spreads the event, so `ev.kind` is set and
// dispatcher events carry `ev.item` / `ev.source` / `ev.id`.
function projectEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const ts = ev.ts || new Date().toISOString();
  const kind = ev.kind || ev.type || null;
  // Source lives directly on dispatcher.* events (ev.source) or nested on the
  // enqueued/dispatching item (ev.item.source). Cost rows carry it too.
  const source = ev.source || ev.item?.source || null;
  const dispatchId = ev.id || ev.item?.id || ev.dispatch_id || null;
  let text;
  try {
    text = JSON.stringify(ev.result ?? ev);
  } catch {
    text = String(ev.result ?? "");
  }
  if (text && text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return { ts, kind, source, dispatchId, text: text || "" };
}

// Tee one event into the recall index. Best-effort: never throws. `agent` is
// the supervisor identity (ops / ops-light / chat / …) for later filtering.
// Returns true if indexed, false if skipped/unavailable.
export function indexEvent(ev, { agent = null } = {}) {
  const d = db();
  if (!d || !_insert) return false;
  const row = projectEvent(ev);
  if (!row) return false;
  try {
    _insert.run(row.ts, row.kind, row.source, agent, row.dispatchId, row.text);
    return true;
  } catch {
    return false;
  }
}

// Build a safe FTS5 MATCH expression from free user text: strip quotes, split
// on whitespace, phrase-quote each token, AND them together. Mirrors
// wiki-store.searchPages so query behavior is consistent across the two tools.
function toFtsExpr(query) {
  const cleaned = String(query || "").replace(/['"]/g, "").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

// Full-text recall over the event stream. Returns most-relevant-first rows
// (BM25), with a light recency tiebreak. Options:
//   limit   max rows (default 20)
//   source  restrict to one dispatch source (exact match, e.g. "daily-summary")
//   kind    restrict to one event kind (exact match, e.g. "dispatcher.dispatching")
//   agent   restrict to one supervisor (exact match, e.g. "ops")
//   since   ISO string or Date — only events at/after this timestamp
export function searchEvents(query, { limit = 20, source = null, kind = null, agent = null, since = null } = {}) {
  const d = db();
  if (!d) return [];
  const expr = toFtsExpr(query);
  if (!expr) return [];
  const sinceIso = since instanceof Date ? since.toISOString() : since;
  const where = ["events_fts MATCH ?"];
  const params = [expr];
  if (source) { where.push("source = ?"); params.push(source); }
  if (kind) { where.push("kind = ?"); params.push(kind); }
  if (agent) { where.push("agent = ?"); params.push(agent); }
  if (sinceIso) { where.push("ts >= ?"); params.push(sinceIso); }
  const sql = `
    SELECT ts, kind, source, agent, dispatch_id,
           snippet(events_fts, 5, '«', '»', '…', 18) AS snippet,
           bm25(events_fts) AS score
    FROM events_fts
    WHERE ${where.join(" AND ")}
    ORDER BY bm25(events_fts), ts DESC
    LIMIT ?`;
  params.push(limit);
  try {
    return d.prepare(sql).all(...params).map((r) => ({
      ts: r.ts,
      kind: r.kind,
      source: r.source,
      agent: r.agent,
      dispatch_id: r.dispatch_id,
      snippet: r.snippet || "",
      score: r.score,
    }));
  } catch {
    return [];
  }
}

// Most-recent N events, newest-first — no query. Used by the session-handoff
// digest to summarize "what the outgoing session was doing". Optional `kinds`
// (array) restricts to meaningful kinds (e.g. the dispatch lifecycle) so the
// digest input isn't drowned by the assistant/tool firehose.
export function recentEvents({ limit = 40, agent = null, kinds = null, since = null } = {}) {
  const d = db();
  if (!d) return [];
  const where = [];
  const params = [];
  if (agent) { where.push("agent = ?"); params.push(agent); }
  if (Array.isArray(kinds) && kinds.length) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }
  const sinceIso = since instanceof Date ? since.toISOString() : since;
  if (sinceIso) { where.push("ts >= ?"); params.push(sinceIso); }
  // rowid is monotonic with insertion order, so DESC rowid = newest-first
  // regardless of ts formatting.
  const sql = `
    SELECT ts, kind, source, agent, dispatch_id, text
    FROM events_fts
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY rowid DESC
    LIMIT ?`;
  params.push(limit);
  try {
    return d.prepare(sql).all(...params).map((r) => ({
      ts: r.ts, kind: r.kind, source: r.source, agent: r.agent,
      dispatch_id: r.dispatch_id, text: r.text || "",
    }));
  } catch {
    return [];
  }
}

// Drop rows older than `days`. The index is derived + rebuildable, so retention
// is pure hygiene — keeps memory-index.db from growing unbounded off the
// firehose. Returns rows removed.
export function pruneOlderThan(days = 30) {
  const d = db();
  if (!d) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const r = d.prepare("DELETE FROM events_fts WHERE ts < ?").run(cutoff);
    return r.changes || 0;
  } catch {
    return 0;
  }
}

// Rebuild the whole index from the JSONL source of truth. Truncates events_fts
// and re-ingests every line of each file. Used by `recall-events rebuild` and
// after a schema change. `files` is a list of events.ndjson paths; `agentFor`
// maps a file path → agent label (defaults to parsing "supervisor-<agent>").
export function rebuildFromFiles(files, { agentFor = null } = {}) {
  const d = db();
  if (!d) return { indexed: 0, files: 0, errors: [] };
  const label = agentFor || ((p) => {
    const m = /supervisor-([^/]+)/.exec(p);
    return m ? m[1] : null;
  });
  const stats = { indexed: 0, files: 0, errors: [] };
  d.exec("BEGIN IMMEDIATE");
  try {
    d.exec("DELETE FROM events_fts");
    // Rowids reset on rebuild, so any prior embeddings would key to the wrong
    // events — drop them; `recall-events embed` re-populates.
    try { d.exec("DELETE FROM event_embeddings"); } catch {}
    for (const file of files) {
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch (e) { stats.errors.push({ file, error: e.message }); continue; }
      stats.files++;
      const agent = label(file);
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const row = projectEvent(ev);
        if (!row) continue;
        _insert.run(row.ts, row.kind, row.source, agent, row.dispatchId, row.text);
        stats.indexed++;
      }
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    stats.errors.push({ file: "*", error: err.message });
  }
  return stats;
}

// Embed high-value events that don't yet have an embedding. `embedFn` is an
// async (text) => number[] (prod: localLlmEmbed via Ollama; tests: a toy). Kept
// out of the append() hot path on purpose — run from the `recall-events embed`
// CLI or a cron. Returns { embedded, remaining, errors }.
export async function embedPending({ embedFn, limit = 200, model = "nomic-embed-text" } = {}) {
  const d = db();
  if (!d || typeof embedFn !== "function") return { embedded: 0, remaining: 0, errors: ["no db or embedFn"] };
  const placeholders = EMBED_KINDS.map(() => "?").join(", ");
  let rows;
  try {
    rows = d.prepare(
      `SELECT rowid, text FROM events_fts
       WHERE kind IN (${placeholders})
         AND length(text) > 0
         AND rowid NOT IN (SELECT event_rowid FROM event_embeddings)
       ORDER BY rowid DESC LIMIT ?`,
    ).all(...EMBED_KINDS, limit);
  } catch (e) {
    return { embedded: 0, remaining: 0, errors: [e.message] };
  }
  const ins = d.prepare(
    "INSERT OR REPLACE INTO event_embeddings(event_rowid, model, dim, embedding) VALUES (?, ?, ?, ?)",
  );
  const errors = [];
  let embedded = 0;
  for (const r of rows) {
    try {
      const vec = await embedFn(r.text);
      if (!Array.isArray(vec) || !vec.length) { errors.push(`row ${r.rowid}: empty embedding`); continue; }
      ins.run(r.rowid, model, vec.length, packF32(vec));
      embedded++;
    } catch (e) {
      errors.push(`row ${r.rowid}: ${e.message}`);
      // Ollama likely down — stop early rather than hammer it for the whole batch.
      if (errors.length >= 3) break;
    }
  }
  let remaining = 0;
  try {
    remaining = d.prepare(
      `SELECT COUNT(*) AS n FROM events_fts
       WHERE kind IN (${placeholders}) AND length(text) > 0
         AND rowid NOT IN (SELECT event_rowid FROM event_embeddings)`,
    ).get(...EMBED_KINDS).n;
  } catch {}
  return { embedded, remaining, errors };
}

// Hybrid recall: fuse the FTS/BM25 ranking with a vector-KNN ranking via RRF.
// `embedQuery` is an async (text) => number[] used to embed the query once.
// Degrades gracefully: if embedQuery is missing/throws or no embeddings exist,
// returns the pure-FTS result (same shape as searchEvents). Filters match
// searchEvents. Returns rows with an added `via` tag ("hybrid"|"fts").
export async function searchEventsHybrid(query, { limit = 20, source = null, kind = null, agent = null, since = null, embedQuery = null } = {}) {
  const d = db();
  if (!d) return [];
  const expr = toFtsExpr(query);
  if (!expr) return [];
  const sinceIso = since instanceof Date ? since.toISOString() : since;

  // FTS ranking (also gives us rowids to fuse on).
  const where = ["events_fts MATCH ?"];
  const params = [expr];
  if (source) { where.push("source = ?"); params.push(source); }
  if (kind) { where.push("kind = ?"); params.push(kind); }
  if (agent) { where.push("agent = ?"); params.push(agent); }
  if (sinceIso) { where.push("ts >= ?"); params.push(sinceIso); }
  let ftsRows = [];
  try {
    ftsRows = d.prepare(`
      SELECT rowid, ts, kind, source, agent, dispatch_id,
             snippet(events_fts, 5, '«', '»', '…', 18) AS snippet
      FROM events_fts WHERE ${where.join(" AND ")}
      ORDER BY bm25(events_fts) LIMIT 60`).all(...params);
  } catch { ftsRows = []; }

  // If we can't embed, or there are no stored embeddings, just return FTS.
  const embCount = (() => { try { return d.prepare("SELECT COUNT(*) AS n FROM event_embeddings").get().n; } catch { return 0; } })();
  let qVec = null;
  if (typeof embedQuery === "function" && embCount > 0) {
    try { qVec = await embedQuery(query); } catch { qVec = null; }
  }
  if (!qVec || !qVec.length) {
    return ftsRows.slice(0, limit).map((r) => ({ ...stripRowid(r), via: "fts" }));
  }

  // Semantic ranking: brute-force KNN over the embeddings table ALONE, then
  // fetch metadata + snippet for the winners only.
  //
  // This used to JOIN events_fts to event_embeddings and pull every embedded
  // row with its snippet in one statement — 11s on the production host at 62.8k embedded
  // events (2026-10-04), 6.5s of it the FTS-table join alone, vs 136ms to read
  // the embeddings by themselves. node:sqlite is synchronous, so those 11s
  // blocked the whole tools-mcp event loop: unified `recall` wraps this source
  // in a 600ms deadline that could never fire, and `recall` with events:true
  // ran 15-24s inside live chat turns.
  //
  // Metadata filters are applied AFTER ranking, so the KNN pool is widened when
  // any are set; a filter that matches a tiny slice of the corpus can come back
  // with fewer semantic hits than before. That half is fused with FTS (which
  // still filters exactly), so the cost is ranking quality, never correctness.
  const filtered = Boolean(source || kind || agent || sinceIso);
  let semRanked = [];
  try {
    const embRows = d.prepare("SELECT event_rowid AS rowid, embedding FROM event_embeddings").all();
    const winners = knnRows(embRows.map((r) => ({ rowid: r.rowid, embedding: unpackF32(r.embedding) })), qVec, filtered ? 1000 : 60);
    if (winners.length) {
      const embWhere = [`rowid IN (${winners.map(() => "?").join(",")})`];
      const embParams = winners.map((w) => w.rowid);
      if (source) { embWhere.push("source = ?"); embParams.push(source); }
      if (kind) { embWhere.push("kind = ?"); embParams.push(kind); }
      if (agent) { embWhere.push("agent = ?"); embParams.push(agent); }
      if (sinceIso) { embWhere.push("ts >= ?"); embParams.push(sinceIso); }
      const meta = new Map(d.prepare(`
        SELECT rowid, ts, kind, source, agent, dispatch_id,
               snippet(events_fts, 5, '«', '»', '…', 18) AS snippet
        FROM events_fts WHERE ${embWhere.join(" AND ")}`).all(...embParams).map((r) => [r.rowid, r]));
      semRanked = winners
        .filter((w) => meta.has(w.rowid))
        .slice(0, 60)
        .map((w) => ({ ...meta.get(w.rowid), score: w.score }));
    }
  } catch { semRanked = []; }

  // Fuse FTS + semantic by rowid.
  const fused = rrfFuse([ftsRows, semRanked], (r) => r.rowid, { limit });
  return fused.map((f) => ({ ...stripRowid(f.item), via: "hybrid", rrf: f.rrf }));
}

function stripRowid(r) {
  const { rowid, embedding, score, ...rest } = r;
  return rest;
}

export function embeddingStats() {
  const d = db();
  if (!d) return { available: false };
  try {
    const placeholders = EMBED_KINDS.map(() => "?").join(", ");
    const embedded = d.prepare("SELECT COUNT(*) AS n FROM event_embeddings").get().n;
    const embeddable = d.prepare(
      `SELECT COUNT(*) AS n FROM events_fts WHERE kind IN (${placeholders}) AND length(text) > 0`,
    ).get(...EMBED_KINDS).n;
    return { available: true, embedded, embeddable, pending: Math.max(0, embeddable - embedded) };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

export function stats() {
  const d = db();
  if (!d) return { available: false };
  try {
    const total = d.prepare("SELECT COUNT(*) AS n FROM events_fts").get().n;
    const byKind = d.prepare("SELECT kind, COUNT(*) AS n FROM events_fts GROUP BY kind ORDER BY n DESC LIMIT 12").all();
    const range = d.prepare("SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM events_fts").get();
    return { available: true, total, byKind, oldest: range.oldest, newest: range.newest };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// Test/maintenance helper — close the handle so a fresh DB_PATH can be opened.
export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _insert = null;
  _disabled = false;
}

export const EVENT_FTS_DB_PATH = DB_PATH;
