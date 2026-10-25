// memory-db.mjs — one shared handle on data/memory-index.db for the
// associative-memory writers (wiki-hebbian, wiki-activation, wiki-facts) and a
// tiny key/value table they keep their progress in.
//
// Same conventions as wiki-embed.mjs's own handle: WAL (so it co-exists with
// wiki-store's and wiki-embed's handles in one process), a busy timeout, and
// fail-soft — a DB that cannot be opened returns null and every caller treats
// that as "nothing to do". The path is read at FIRST OPEN rather than at module
// load so a test can point MEMORY_INDEX_DB at a fixture before using it.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installTools } from "./root.cjs";
let _db = null;
let _path = null;

export function memoryDbPath() {
  return (
    process.env.MEMORY_INDEX_DB ||
    installTools("data/memory-index.db")
  );
}

export function openMemoryDb() {
  const p = memoryDbPath();
  if (_db && _path === p) return _db;
  if (_db) closeMemoryDb();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const d = new DatabaseSync(p);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA busy_timeout=3000");
    d.exec(`CREATE TABLE IF NOT EXISTS assoc_meta (key TEXT PRIMARY KEY, value TEXT)`);
    _db = d;
    _path = p;
    return d;
  } catch {
    return null;
  }
}

export function closeMemoryDb() {
  try { _db?.close(); } catch {}
  _db = null;
  _path = null;
}

export function getMeta(d, key, fallback = null) {
  try {
    const r = d.prepare("SELECT value FROM assoc_meta WHERE key = ?").get(key);
    return r ? r.value : fallback;
  } catch {
    return fallback;
  }
}

export function setMeta(d, key, value) {
  d.prepare("INSERT OR REPLACE INTO assoc_meta(key, value) VALUES (?, ?)").run(key, String(value));
}

// Read a JSONL file line by line, skipping blank or unparseable lines. The logs
// these writers read are append-only and written fire-and-forget, so a torn
// last line is normal and must not abort a nightly pass.
export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export const AUTO_RECALL_JUDGE_LOG = () =>
  process.env.AUTO_RECALL_JUDGE_LOG ||
  installTools("data/auto-recall-judge.jsonl");

// The wiki pages the auto-recall judge KEPT for one message, as ids. This is
// the "used together" signal both the Hebbian and the base-level writers learn
// from: a Sonnet judge read the candidates and decided these were relevant to
// what the user said. Raw retrieval hits are NOT used — learning from what was
// merely retrieved would make the most-retrieved pages retrieved more, a
// rich-get-richer loop with nothing checking it.
export function keptWikiIds(row) {
  const kept = new Set(Array.isArray(row?.kept) ? row.kept : []);
  const out = [];
  for (const c of Array.isArray(row?.candidates) ? row.candidates : []) {
    if (!kept.has(c.i) || c.source !== "wiki" || !c.id) continue;
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}
