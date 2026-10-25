// email-memory.js — Fast indexed email memory for LLM classification context.
// Uses SQLite FTS5 for full-text search. Zero external dependencies (node:sqlite).
//
// Usage:
//   const em = require('./lib/email-memory');
//   em.add({ text: "Already handled the ACME Accounting tax document", tags: "acme, tax" });
//   em.search("ACME tax");       // returns matching memories
//   em.searchForEmail({ from, subject, snippet }); // auto-builds query from email fields

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "email-memory.db");

let _db = null;

function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT NULL
    )
  `);
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, tags,
      content=memories,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  // Triggers to keep FTS in sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END
  `);
  return _db;
}

/**
 * Add a memory.
 * @param {object} opts
 * @param {string} opts.text - The memory content (e.g., "Already handled the ACME Accounting tax document")
 * @param {string} [opts.tags] - Comma-separated tags for better matching (e.g., "acme, tax")
 * @param {string} [opts.expiresAt] - ISO date after which this memory is ignored (e.g., "2026-04-15")
 * @returns {number} The memory ID
 */
function add({ text, tags = "", expiresAt = null }) {
  const stmt = db().prepare(
    "INSERT INTO memories (text, tags, expires_at) VALUES (?, ?, ?)"
  );
  const result = stmt.run(text, tags, expiresAt);
  return Number(result.lastInsertRowid);
}

/**
 * Search memories by free-text query. Returns up to `limit` results ranked by relevance.
 * Automatically filters out expired memories.
 */
function search(query, limit = 5) {
  if (!query || !query.trim()) return [];
  // Clean query for FTS5: strip special chars, keep words
  const cleaned = query.replace(/[^\w\s@.-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  // Build OR query from words for broad matching
  const words = cleaned.split(" ").filter(w => w.length > 1);
  if (words.length === 0) return [];
  const ftsQuery = words.map(w => `"${w}"`).join(" OR ");

  try {
    const rows = db().prepare(`
      SELECT m.id, m.text, m.tags, m.created_at, m.expires_at,
             rank
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
        AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit);
    return rows;
  } catch (err) {
    console.error(`[email-memory] search error: ${err.message}`);
    return [];
  }
}

/**
 * Build a search query from email fields and return matching memories.
 * Extracts key terms from sender, subject, and snippet.
 */
function searchForEmail({ from, subject, snippet } = {}) {
  const parts = [];
  // Extract sender name/domain
  if (from) {
    const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
    if (nameMatch) parts.push(nameMatch[1].trim());
    const domainMatch = from.match(/@([\w.-]+)\./);
    if (domainMatch) parts.push(domainMatch[1]);
  }
  // Subject words (skip very short/common words)
  if (subject) {
    const subjectWords = subject
      .replace(/^(re:|fwd?:)\s*/gi, "")
      .replace(/[^\w\s@.-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2);
    parts.push(...subjectWords.slice(0, 10));
  }
  // Snippet words (first few meaningful words)
  if (snippet) {
    const snippetWords = snippet
      .replace(/[^\w\s@.-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 5);
    parts.push(...snippetWords);
  }
  const query = [...new Set(parts)].join(" ");
  // Superseded rows are excluded from the CLASSIFIER-facing path (this function
  // and formatForPrompt) while remaining fully visible to `search` / `list` —
  // history matters, but a retired decision must not be fed back to triage as
  // guidance. Without this, `email-mem supersede` was purely cosmetic: it wrote
  // a `superseded-by-#N` tag that nothing ever read, so 37 rows describing the
  // retired 2026-05-18 reply-echo rule kept out-ranking the policy row that
  // replaced them (2026-08-17). Over-fetch, then filter, so dropping a
  // superseded row promotes a live one instead of shrinking the block.
  return search(query, 30)
    .filter((r) => !(r.tags || "").includes("superseded-by-#"))
    .slice(0, 5);
}

/**
 * List all memories (optionally filter by tag).
 */
function list({ tag, limit = 50 } = {}) {
  if (tag) {
    return db().prepare(
      "SELECT * FROM memories WHERE tags LIKE ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY created_at DESC LIMIT ?"
    ).all(`%${tag}%`, limit);
  }
  return db().prepare(
    "SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

/**
 * Remove a memory by ID.
 */
function remove(id) {
  return db().prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/**
 * Update a memory's text or tags.
 */
function update(id, { text, tags }) {
  const fields = [];
  const values = [];
  if (text !== undefined) { fields.push("text = ?"); values.push(text); }
  if (tags !== undefined) { fields.push("tags = ?"); values.push(tags); }
  if (fields.length === 0) return;
  values.push(id);
  db().prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/**
 * Format matching memories as a string block for LLM prompt injection.
 * Returns empty string if no matches.
 */
function formatForPrompt({ from, subject, snippet } = {}) {
  const matches = searchForEmail({ from, subject, snippet });
  if (matches.length === 0) return "";
  const lines = matches.map(m => `- ${m.text}${m.tags ? ` [${m.tags}]` : ""}`);
  return `\nRELEVANT MEMORY (from past instructions/context):\n${lines.join("\n")}\nUse these memories to inform your classification. For example, if a memory says something was already handled, classify as IGNORE.\n`;
}

/**
 * Rebuild the FTS5 index from the content table.
 * Call this if the index gets out of sync (e.g., after manual DB edits or crash recovery).
 */
function rebuild() {
  db().exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

module.exports = { add, search, searchForEmail, list, remove, update, formatForPrompt, rebuild };
