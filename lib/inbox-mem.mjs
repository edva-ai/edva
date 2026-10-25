// inbox-mem.mjs — the inbox as a MEMORY channel, not a place to run queries at.
//
// WHY THIS EXISTS. Memory is the authority, and memory is updated from
// multiple channels, the inbox included.
//
// The release gate's first cut asked the mailbox directly: a model wrote a Gmail
// keyword query per claim and `gog gmail search` ran it. The way that fails is
// the point.
//
// Say the claim is "<vendor> still hasn't SHIPPED the replacement". The model,
// quite reasonably, searches `<vendor> replacement shipped`. The vendor has sent
// several emails settling it — "Your order is on its way", "Out for delivery",
// "Delivered". Not one contains the word "shipped".
// The search returns exactly one thread: the stale complaint itself. The gate re-reads the false claim,
// concludes the mailbox is silent, and hedges where it should drop.
//
// That is Rule #0b one level removed. No regex touched the user's language — but a
// MODEL-authored lexical query was treated as an authority, and its miss was
// read as evidence of absence. Silence from a keyword search is not silence from
// the world. The source's vocabulary is never the claim's vocabulary.
//
// THE FIX IS NOT A BETTER QUERY. It is to stop point-querying raw channels at
// decision time. Channels get INGESTED into memory; memory is what gets asked,
// semantically, so "on its way" answers a question about "shipped". And
// because the authority is memory rather than one channel, a resolution that
// arrives by chat, WhatsApp, or the user's own reply settles the claim just as
// well as an email does — which the mailbox-only design could never do.
//
// This module is the missing channel. `context-sync email` indexes email
// *classification rules*, not messages, so until now the inbox contributed
// nothing to recall at all.
//
// Shape follows event-fts.mjs deliberately: same memory-index.db, FTS5 + an
// out-of-band embedding table, hybrid search, fail-soft everywhere. One memory
// store, one backup, one place recall looks.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { packF32, unpackF32, knn as knnRows, rrfFuse } from "./hybrid-recall.mjs";

import { installTools } from "./root.cjs";
const HOME = os.homedir();
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

// Message bodies get long and repetitive (footers, quoted chains). The head of
// a transactional mail carries the fact; the tail carries boilerplate.
const MAX_TEXT = 3000;

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
    // sender/subject/text are searchable; identifiers and the timestamp are
    // UNINDEXED so `since` filtering and dedup don't bloat the term index.
    // porter+unicode61 matches pages_fts/events_fts so queries behave alike.
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS inbox_fts USING fts5(
        ts UNINDEXED,
        msg_id UNINDEXED,
        thread_id UNINDEXED,
        sender,
        subject,
        text,
        tokenize='porter unicode61'
      )
    `);
    // FTS5 has no UNIQUE constraint, and the sync re-reads overlapping windows
    // every run. Without this the same message accumulates a row per run and
    // quietly dominates BM25 by sheer duplication.
    d.exec(`
      CREATE TABLE IF NOT EXISTS inbox_seen (
        msg_id     TEXT PRIMARY KEY,
        rowid_ref  INTEGER,
        ts         TEXT,
        indexed_at TEXT DEFAULT (datetime('now'))
      )
    `);
    d.exec(`
      CREATE TABLE IF NOT EXISTS inbox_embeddings (
        inbox_rowid INTEGER PRIMARY KEY,
        model       TEXT,
        dim         INTEGER,
        embedding   BLOB NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

/**
 * Index one message. Idempotent on msg_id, so the sync can re-read an
 * overlapping window without duplicating rows. Returns "inserted" | "skipped".
 */
export function indexMessage(msg) {
  const d = db();
  if (!d || !msg) return "skipped";
  const msgId = String(msg.id || msg.msg_id || "").trim();
  if (!msgId) return "skipped";
  try {
    const seen = d.prepare("SELECT msg_id FROM inbox_seen WHERE msg_id = ?").get(msgId);
    if (seen) return "skipped";

    const ts = String(msg.ts || msg.date || "").trim() || new Date().toISOString();
    let text = String(msg.text || msg.body || msg.snippet || "");
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    d.prepare(
      "INSERT INTO inbox_fts(ts, msg_id, thread_id, sender, subject, text) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ts, msgId, String(msg.thread_id || msg.threadId || ""), String(msg.sender || msg.from || ""),
      String(msg.subject || ""), text);
    const row = d.prepare("SELECT last_insert_rowid() AS id").get();
    d.prepare("INSERT OR REPLACE INTO inbox_seen(msg_id, rowid_ref, ts) VALUES (?, ?, ?)")
      .run(msgId, row?.id ?? null, ts);
    return "inserted";
  } catch {
    return "skipped";
  }
}

function toFtsExpr(query) {
  // lang-regex-ok: tokenizing a query into an FTS5 MATCH expression, mirroring
  // event-fts.toFtsExpr — structure, not meaning.
  const cleaned = String(query || "").replace(/['"]/g, "").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR "); // OR, not AND — see searchInbox
}

/**
 * Lexical recall over indexed mail.
 *
 * Terms are OR-ed, unlike events_fts's AND. The AND default is what made the
 * original mailbox query useless: a claim's wording and a vendor's wording
 * rarely share every token, and requiring all of them means one unlucky word
 * ("shipped") hides every matching message. OR + BM25 ranking keeps the good
 * hits on top while letting partial vocabulary overlap through — and the
 * semantic half of the hybrid is what actually carries the paraphrase.
 */
export function searchInbox(query, { limit = 20, since = null, sender = null } = {}) {
  const d = db();
  if (!d) return [];
  const expr = toFtsExpr(query);
  if (!expr) return [];
  const sinceIso = since instanceof Date ? since.toISOString() : since;
  const where = ["inbox_fts MATCH ?"];
  const params = [expr];
  if (sinceIso) { where.push("ts >= ?"); params.push(sinceIso); }
  if (sender) { where.push("sender LIKE ?"); params.push(`%${sender}%`); }
  const sql = `
    SELECT rowid, ts, msg_id, thread_id, sender, subject,
           snippet(inbox_fts, 5, '«', '»', '…', 20) AS snippet,
           bm25(inbox_fts) AS score
    FROM inbox_fts
    WHERE ${where.join(" AND ")}
    ORDER BY bm25(inbox_fts), ts DESC
    LIMIT ?`;
  params.push(limit);
  try {
    return d.prepare(sql).all(...params).map((r) => ({
      rowid: r.rowid, ts: r.ts, msg_id: r.msg_id, thread_id: r.thread_id,
      sender: r.sender, subject: r.subject, snippet: r.snippet || "", score: r.score,
    }));
  } catch {
    return [];
  }
}

/** Rows still lacking an embedding, oldest first. */
export function pendingEmbeddings(limit = 200) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT f.rowid AS rowid, f.subject AS subject, f.sender AS sender, f.text AS text
      FROM inbox_fts f
      LEFT JOIN inbox_embeddings e ON e.inbox_rowid = f.rowid
      WHERE e.inbox_rowid IS NULL
      ORDER BY f.rowid ASC
      LIMIT ?`).all(limit);
  } catch {
    return [];
  }
}

/**
 * Backfill embeddings out of band (cron/CLI), never on the sync hot path.
 * Embeds sender+subject+body together: a transactional mail's meaning is mostly
 * in its subject, and the sender disambiguates near-identical notification text.
 */
export async function embedPending({ embedFn, limit = 200, model = "nomic-embed-text" } = {}) {
  const d = db();
  if (!d || typeof embedFn !== "function") return { embedded: 0 };
  const rows = pendingEmbeddings(limit);
  let embedded = 0;
  for (const r of rows) {
    const basis = [r.sender, r.subject, r.text].filter(Boolean).join("\n").slice(0, MAX_TEXT);
    if (!basis.trim()) continue;
    let vec;
    try { vec = await embedFn(basis); } catch { continue; }
    if (!vec || !vec.length) continue;
    try {
      d.prepare("INSERT OR REPLACE INTO inbox_embeddings(inbox_rowid, model, dim, embedding) VALUES (?, ?, ?, ?)")
        .run(r.rowid, model, vec.length, packF32(vec));
      embedded++;
    } catch {}
  }
  return { embedded, considered: rows.length };
}

/**
 * Hybrid recall — BM25 fused with embedding KNN via RRF.
 *
 * This is the half that makes the inbox answerable in the claim's own words:
 * "has it shipped?" retrieves "Your order is on its way" without sharing a token with it.
 * Degrades to pure FTS when nothing is embedded or the embedder is down.
 */
export async function searchInboxHybrid(query, { limit = 20, since = null, sender = null, embedQuery = null } = {}) {
  const lexical = searchInbox(query, { limit: Math.max(limit, 20), since, sender });
  const d = db();
  if (!d || typeof embedQuery !== "function") return lexical.slice(0, limit);

  let qVec = null;
  try { qVec = await embedQuery(query); } catch { qVec = null; }
  if (!qVec || !qVec.length) return lexical.slice(0, limit);

  const sinceIso = since instanceof Date ? since.toISOString() : since;
  let candidates = [];
  try {
    const where = [];
    const params = [];
    if (sinceIso) { where.push("f.ts >= ?"); params.push(sinceIso); }
    if (sender) { where.push("f.sender LIKE ?"); params.push(`%${sender}%`); }
    const sql = `
      SELECT f.rowid AS rowid, f.ts AS ts, f.msg_id AS msg_id, f.thread_id AS thread_id,
             f.sender AS sender, f.subject AS subject, substr(f.text, 1, 300) AS snippet,
             e.embedding AS embedding
      FROM inbox_embeddings e
      JOIN inbox_fts f ON f.rowid = e.inbox_rowid
      ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
    candidates = d.prepare(sql).all(...params);
  } catch {
    return lexical.slice(0, limit);
  }
  if (!candidates.length) return lexical.slice(0, limit);

  // knn takes (rows, queryVec, k) and unpacks `embedding` itself — do not
  // pre-unpack or reorder these; both mistakes fail silently as "no semantic
  // hits", which looks exactly like an empty index.
  const semantic = knnRows(candidates, qVec, Math.max(limit, 20));

  // rrfFuse returns {id, rrf, sources, item} wrappers, not the rows — unwrap.
  return rrfFuse([lexical, semantic], (r) => String(r.rowid), { limit })
    .map((f) => ({ ...f.item, rrf: f.rrf }));
}

export function stats() {
  const d = db();
  if (!d) return { messages: 0, embedded: 0, oldest: null, newest: null };
  try {
    const n = d.prepare("SELECT COUNT(*) AS c FROM inbox_fts").get();
    const e = d.prepare("SELECT COUNT(*) AS c FROM inbox_embeddings").get();
    const r = d.prepare("SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM inbox_fts").get();
    return { messages: n?.c ?? 0, embedded: e?.c ?? 0, oldest: r?.oldest ?? null, newest: r?.newest ?? null };
  } catch {
    return { messages: 0, embedded: 0, oldest: null, newest: null };
  }
}

/** Drop messages older than `days` — the index is derived, Gmail is the source. */
export function pruneOlderThan(days = 120) {
  const d = db();
  if (!d) return 0;
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  try {
    const stale = d.prepare("SELECT rowid FROM inbox_fts WHERE ts < ?").all(cutoff);
    for (const s of stale) {
      d.prepare("DELETE FROM inbox_embeddings WHERE inbox_rowid = ?").run(s.rowid);
      d.prepare("DELETE FROM inbox_fts WHERE rowid = ?").run(s.rowid);
    }
    d.prepare("DELETE FROM inbox_seen WHERE ts < ?").run(cutoff);
    return stale.length;
  } catch {
    return 0;
  }
}

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null; _disabled = false;
}

export const INBOX_DB_PATH = DB_PATH;
