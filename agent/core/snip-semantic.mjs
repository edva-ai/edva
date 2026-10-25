// snip-semantic.mjs — WP7 surpass-feature #2: SEMANTIC breadcrumbs.
//
// Conway's snip breadcrumbs (WP2) are id-addressed only — the agent rehydrates a
// compressed range by `retrieveSnipRange(start, end)`, i.e. it must already know
// WHICH range it wants. Edva's landed hybrid recall (local nomic-embed-text +
// RRF, memory-index) lets us do better: when a range is compressed to a
// breadcrumb, index the embedding of its CONTENT so a later turn can find the
// right breadcrumb by MEANING and rehydrate it — recall Conway structurally
// can't do.
//
// This is a fold-in over three already-landed pieces: WP2 snipping (the
// pending_snips + retrieveSnipRange), WP4 message-store (retrieveRange +
// searchFTS + the shared memory-index.db), and the hybrid-recall primitives
// (packF32 / knn / rrfFuse). It owns ONE new table, `snip_vectors`, in the same
// DB — exactly how event-fts.mjs owns its vector table beside agent_messages.
//
// Max-invariant: the embedder is LOCAL (Ollama nomic-embed-text, no API, no
// cost) and INJECTED, so tests never touch Ollama. Everything FAILS OPEN — a
// down embedder means no vector is stored / semantic search returns nothing, and
// the id-addressed WP2 path (retrieveSnipRange) keeps working untouched. Indexing
// runs OFF the hot path (a supervisor/cron backfill), never inside registerSnip,
// so WP2 stays pure + synchronous.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packF32, knn, rrfFuse } from "../../lib/hybrid-recall.mjs";
import { retrieveRange, renderText, searchFTS } from "./message-store.mjs";
import { pendingSnips } from "./snipping.mjs";
import { localLlmEmbed } from "../../lib/local-llm.mjs";

import { installTools } from "../../lib/root.cjs";
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

const MAX_EMBED_TEXT = 6000; // cap the text handed to the embedder.

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
      CREATE TABLE IF NOT EXISTS snip_vectors (
        snip_id    INTEGER PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        start_seq  INTEGER NOT NULL,
        end_seq    INTEGER NOT NULL,
        summary    TEXT,
        embedding  BLOB NOT NULL,
        ts         INTEGER NOT NULL
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_snip_vectors_agent ON snip_vectors(agent_id)");
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

// Render the raw text of a snipped range from the WP4 store (for embedding).
export function snipRangeText(agentId, startSeq, endSeq) {
  const rows = retrieveRange(agentId, startSeq, endSeq);
  if (!rows.length) return "";
  return rows
    .map((r) => renderText(r.content))
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_EMBED_TEXT);
}

// Index ONE snip's embedding. `text` optional (fetched from the store if
// absent). Returns true on success, false on any fail-open path (no embedder,
// empty text, DB down, embed threw). INSERT OR REPLACE so a re-index is idempotent.
export async function indexSnip(
  { agentId, snipId, startSeq, endSeq, summary = "", text = null } = {},
  { embed = localLlmEmbed } = {}
) {
  const d = db();
  if (!d || !agentId || snipId == null) return false;
  const body = (text != null ? text : snipRangeText(agentId, startSeq, endSeq)) || summary;
  if (!body || !body.trim()) return false;
  let vec;
  try {
    vec = await embed(body.slice(0, MAX_EMBED_TEXT));
  } catch {
    return false; // embedder down → fail open, no row written.
  }
  if (!Array.isArray(vec) || !vec.length) return false;
  try {
    d.prepare(
      "INSERT OR REPLACE INTO snip_vectors(snip_id, agent_id, start_seq, end_seq, summary, embedding, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(snipId, agentId, startSeq, endSeq, summary || "", packF32(vec), Date.now());
    return true;
  } catch {
    return false;
  }
}

// Backfill: index every pending snip that has no vector row yet. Off-hot-path
// (supervisor idle / nightly cron), mirroring recall-events-embed. Returns
// { indexed, skipped }.
export async function indexPendingSnips(agentId, { embed = localLlmEmbed, limit = 200 } = {}) {
  const d = db();
  if (!d || !agentId) return { indexed: 0, skipped: 0 };
  const snips = pendingSnips(agentId) || [];
  let indexed = 0,
    skipped = 0;
  for (const s of snips.slice(0, limit)) {
    if (hasVector(s.id)) { skipped++; continue; }
    const ok = await indexSnip(
      { agentId, snipId: s.id, startSeq: s.start_seq, endSeq: s.end_seq, summary: s.summary },
      { embed }
    );
    ok ? indexed++ : skipped++;
  }
  return { indexed, skipped };
}

function hasVector(snipId) {
  const d = db();
  if (!d) return false;
  try {
    return !!d.prepare("SELECT 1 FROM snip_vectors WHERE snip_id = ?").get(snipId);
  } catch {
    return false;
  }
}

export function getSnipVector(snipId) {
  const d = db();
  if (!d) return null;
  try {
    const r = d.prepare(
      "SELECT snip_id, agent_id, start_seq, end_seq, summary FROM snip_vectors WHERE snip_id = ?"
    ).get(snipId);
    return r || null;
  } catch {
    return null;
  }
}

function loadVectors(agentId) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(
      "SELECT snip_id, start_seq, end_seq, summary, embedding FROM snip_vectors WHERE agent_id = ?"
    ).all(agentId);
  } catch {
    return [];
  }
}

// Pure semantic recall: embed the query, KNN over this agent's breadcrumb
// vectors. Returns [{ snipId, startSeq, endSeq, summary, score }], best first.
// Fail-open → [] when the embedder is down or nothing is indexed.
export async function searchSnipsSemantic(agentId, query, { k = 5, embed = localLlmEmbed } = {}) {
  if (!agentId || !query || !query.trim()) return [];
  const rows = loadVectors(agentId);
  if (!rows.length) return [];
  let qv;
  try {
    qv = await embed(query.slice(0, MAX_EMBED_TEXT));
  } catch {
    return [];
  }
  if (!Array.isArray(qv) || !qv.length) return [];
  return knn(rows, qv, k).map((r) => ({
    snipId: r.snip_id,
    startSeq: r.start_seq,
    endSeq: r.end_seq,
    summary: r.summary,
    score: r.score,
  }));
}

// HYBRID recall — fuse the lexical (WP4 searchFTS over the raw messages) and the
// semantic (breadcrumb vectors) rankings via RRF, both collapsed to the snip
// range that CONTAINS each hit. This is the full "searchFTS + vector recall
// rehydrate by meaning" surpass-feature: a breadcrumb surfaces whether the query
// matches its words OR its meaning. Fail-open — if the embedder is down it
// degrades to pure lexical; if FTS finds nothing it degrades to pure semantic.
export async function hybridSnipSearch(agentId, query, { k = 5, embed = localLlmEmbed } = {}) {
  const sem = await searchSnipsSemantic(agentId, query, { k: Math.max(k, 10), embed });
  // Lexical: map each FTS message hit to its containing snip range.
  const ftsHits = searchFTS(agentId, query, { limit: 40 }) || [];
  const lex = [];
  const seen = new Set();
  for (const h of ftsHits) {
    const snip = snipContaining(agentId, h.seq);
    if (!snip || seen.has(snip.snip_id)) continue;
    seen.add(snip.snip_id);
    lex.push({ snipId: snip.snip_id, startSeq: snip.start_seq, endSeq: snip.end_seq, summary: snip.summary });
  }
  if (!sem.length && !lex.length) return [];
  const fused = rrfFuse([sem, lex], (r) => r.snipId, { limit: k });
  return fused.map((f) => ({ ...f.item, rrf: f.rrf, via: "hybrid" }));
}

function snipContaining(agentId, seq) {
  const d = db();
  if (!d || seq == null) return null;
  try {
    return d.prepare(
      "SELECT snip_id, start_seq, end_seq, summary FROM snip_vectors WHERE agent_id = ? AND start_seq <= ? AND end_seq >= ? ORDER BY (end_seq - start_seq) ASC LIMIT 1"
    ).get(agentId, seq, seq) || null;
  } catch {
    return null;
  }
}

export function stats(agentId = null) {
  const d = db();
  if (!d) return { vectors: 0 };
  try {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const args = agentId ? [agentId] : [];
    return { vectors: d.prepare(`SELECT COUNT(*) AS n FROM snip_vectors ${where}`).get(...args).n };
  } catch {
    return { vectors: 0 };
  }
}

export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
  _disabled = false;
}

export const SNIP_SEMANTIC_DB_PATH = DB_PATH;
