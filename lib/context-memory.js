// context-memory.js — Unified cross-source context index for LLM agents.
// Uses SQLite FTS5 for full-text search across Apple Notes, iMessage, email, files.
// Zero external dependencies (node:sqlite).
//
// Usage:
//   const cm = require('./lib/context-memory');
//   cm.upsert({ source: "notes", sourceId: "Shopping List", summary: "Milk, eggs...", tags: "groceries" });
//   cm.search("shopping");           // returns matching entries across all sources
//   cm.search("<topic>", { source: "notes" }); // filter to one source
//   cm.formatForPrompt("<topic>");     // formatted block for LLM context injection

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "context.db");

const READ_HINTS = {
  notes: (id) => `notes_read "${id}"`,
  imsg: (id) => `imsg_read "${id}"`,
  email: () => `email_mem_search`,
  files: (id) => `Read ~/Dev/edva/${id}`,
  docs: (id) => `Read ~/${id}`,
  watchlist: (id) => `watchlist info "${id}"`,
  wiki: (id) => `wiki_read "${id}"`,
};

let _db = null;

function sleepMs(ms) {
  if (ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function isBusyError(err) {
  return Boolean(
    err &&
      (err.code === "SQLITE_BUSY" ||
        err.code === "SQLITE_LOCKED" ||
        // lang-regex-ok: matches SQLite's own error text, not anyone's language
        /database is locked|database is busy/i.test(err.message || "")),
  );
}

function db() {
  if (_db) return _db;
  const maxAttempts = 6;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let dbHandle = null;
    try {
      dbHandle = new DatabaseSync(DB_PATH);
      try {
        dbHandle.exec("PRAGMA journal_mode=WAL");
      } catch {}
      try {
        dbHandle.exec("PRAGMA synchronous=NORMAL");
      } catch {}
      try {
        dbHandle.exec("PRAGMA busy_timeout=2500");
      } catch {}
      dbHandle.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          tags TEXT DEFAULT '',
          metadata_json TEXT DEFAULT '{}',
          updated_at TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT DEFAULT NULL,
          UNIQUE(source, source_id)
        )
      `);
      dbHandle.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          summary, tags,
          content=entries,
          content_rowid=id,
          tokenize='porter unicode61'
        )
      `);
      // Triggers to keep FTS in sync
      dbHandle.exec(`
        CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
          INSERT INTO entries_fts(rowid, summary, tags) VALUES (new.id, new.summary, new.tags);
        END
      `);
      dbHandle.exec(`
        CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, summary, tags) VALUES ('delete', old.id, old.summary, old.tags);
        END
      `);
      dbHandle.exec(`
        CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, summary, tags) VALUES ('delete', old.id, old.summary, old.tags);
          INSERT INTO entries_fts(rowid, summary, tags) VALUES (new.id, new.summary, new.tags);
        END
      `);
      _db = dbHandle;
      return _db;
    } catch (err) {
      lastErr = err;
      try {
        dbHandle?.close();
      } catch {}
      if (!isBusyError(err) || attempt === maxAttempts) {
        throw err;
      }
      sleepMs(50 * attempt);
    }
  }
  throw lastErr || new Error("context-memory: failed to open database");
}

/**
 * Upsert an entry. Inserts or updates by (source, source_id).
 * @param {object} opts
 * @param {string} opts.source - Source type: 'notes', 'imsg', 'email', 'files'
 * @param {string} opts.sourceId - Unique ID within source (note title, chat handle, etc.)
 * @param {string} opts.summary - Searchable summary text
 * @param {string} [opts.tags] - Comma-separated tags
 * @param {object} [opts.metadata] - Arbitrary JSON metadata
 * @param {string} [opts.expiresAt] - ISO date for auto-expiry
 * @returns {number} The entry ID
 */
function upsert({ source, sourceId, summary, tags = "", metadata = {}, expiresAt = null }) {
  const metaJson = JSON.stringify(metadata);
  const existing = db()
    .prepare(
      "SELECT id, summary, tags, metadata_json, expires_at FROM entries WHERE source = ? AND source_id = ?",
    )
    .get(source, sourceId);
  if (
    existing &&
    existing.summary === summary &&
    existing.tags === tags &&
    existing.metadata_json === metaJson &&
    (existing.expires_at || null) === (expiresAt || null)
  ) {
    return Number(existing.id);
  }
  const stmt = db().prepare(`
    INSERT INTO entries (source, source_id, summary, tags, metadata_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      summary = excluded.summary,
      tags = excluded.tags,
      metadata_json = excluded.metadata_json,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `);
  const result = stmt.run(source, sourceId, summary, tags, metaJson, expiresAt);
  return Number(result.lastInsertRowid);
}

/**
 * Search across all sources by free-text query.
 * Automatically filters out expired entries.
 * @param {string} query - Free-text search query
 * @param {object} [opts]
 * @param {string} [opts.source] - Filter to a specific source
 * @param {number} [opts.limit=10] - Max results
 * @returns {Array} Matching entries
 */
function search(query, { source, limit = 10 } = {}) {
  if (!query || !query.trim()) return [];
  const cleaned = query.replace(/[^\w\s@.\-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(" ").filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const ftsQuery = words.map((w) => `"${w}"`).join(" OR ");

  try {
    const sourceFilter = source ? "AND e.source = ?" : "";
    const params = source ? [ftsQuery, source, limit] : [ftsQuery, limit];
    const rows = db()
      .prepare(
        `
      SELECT e.id, e.source, e.source_id, e.summary, e.tags, e.metadata_json,
             e.updated_at, rank
      FROM entries_fts f
      JOIN entries e ON e.id = f.rowid
      WHERE entries_fts MATCH ?
        AND (e.expires_at IS NULL OR e.expires_at > datetime('now'))
        ${sourceFilter}
      ORDER BY rank
      LIMIT ?
    `
      )
      .all(...params);
    return rows;
  } catch (err) {
    console.error(`[context-memory] search error: ${err.message}`);
    return [];
  }
}

/**
 * List entries, optionally filtered by source.
 */
function list({ source, limit = 50 } = {}) {
  if (source) {
    return db()
      .prepare(
        "SELECT * FROM entries WHERE source = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY updated_at DESC LIMIT ?"
      )
      .all(source, limit);
  }
  return db()
    .prepare(
      "SELECT * FROM entries WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY updated_at DESC LIMIT ?"
    )
    .all(limit);
}

/**
 * Remove a single entry by ID.
 */
function remove(id) {
  return db().prepare("DELETE FROM entries WHERE id = ?").run(id);
}

/**
 * Remove stale entries for a source not seen in the current sync run.
 * @param {string} source - Source type
 * @param {string[]} currentIds - Array of source_ids that were just synced
 * @returns {number} Number of stale entries removed
 */
function removeStale(source, currentIds) {
  if (!currentIds || currentIds.length === 0) return 0;
  const d = db();
  // Use a temp table to avoid SQLite variable limit (~999) on large syncs
  d.exec("CREATE TEMP TABLE IF NOT EXISTS _keep_ids (id TEXT)");
  d.exec("DELETE FROM _keep_ids");
  const ins = d.prepare("INSERT INTO _keep_ids (id) VALUES (?)");
  for (const id of currentIds) ins.run(id);
  const result = d
    .prepare("DELETE FROM entries WHERE source = ? AND source_id NOT IN (SELECT id FROM _keep_ids)")
    .run(source);
  d.exec("DELETE FROM _keep_ids");
  return result.changes;
}

/**
 * Get entry counts per source.
 * @returns {Array<{source: string, count: number}>}
 */
function stats() {
  return db()
    .prepare(
      "SELECT source, COUNT(*) as count FROM entries WHERE expires_at IS NULL OR expires_at > datetime('now') GROUP BY source ORDER BY source"
    )
    .all();
}

/**
 * Format search results as a text block for LLM prompt injection.
 * Each result includes source, summary, and a hint for reading the full item.
 */
function formatForPrompt(query, opts) {
  const matches = search(query, opts);
  if (matches.length === 0) return "";
  const lines = matches.map((m) => {
    const hint = (READ_HINTS[m.source] || (() => ""))(m.source_id);
    const preview = m.summary.length > 120 ? m.summary.slice(0, 120) + "..." : m.summary;
    return `- [${m.source}] ${m.source_id} — ${preview}${hint ? `\n    -> ${hint}` : ""}`;
  });
  return `\nCONTEXT MATCHES:\n${lines.join("\n")}\n`;
}

/**
 * Rebuild the FTS5 index from the content table.
 */
function rebuild() {
  db().exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')");
}

module.exports = { db, upsert, search, list, remove, removeStale, stats, formatForPrompt, rebuild };
