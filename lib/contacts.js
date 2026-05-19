// contacts.js — Indexed contact database with FTS5 full-text search.
// Uses SQLite FTS5 for search. Zero external dependencies (node:sqlite).
//
// Usage:
//   const contacts = require('./lib/contacts');
//   contacts.upsert({ name: "Jon Barr", company: "Acme", email: "jon@acme.com" });
//   contacts.search("Jon");
//   contacts.get({ name: "Jon Barr" });

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "contacts.db");

let _db = null;

function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      company TEXT DEFAULT '',
      title TEXT DEFAULT '',
      linkedin_url TEXT DEFAULT '',
      apollo_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Unique index on lowercase name+company for dedup
  _db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_name_company
    ON contacts (LOWER(name), LOWER(company))
  `);
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
      name, email, company, title, notes, tags,
      content=contacts,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  // Triggers to keep FTS in sync
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO contacts_fts(rowid, name, email, company, title, notes, tags)
      VALUES (new.id, new.name, new.email, new.company, new.title, new.notes, new.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, name, email, company, title, notes, tags)
      VALUES ('delete', old.id, old.name, old.email, old.company, old.title, old.notes, old.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, name, email, company, title, notes, tags)
      VALUES ('delete', old.id, old.name, old.email, old.company, old.title, old.notes, old.tags);
      INSERT INTO contacts_fts(rowid, name, email, company, title, notes, tags)
      VALUES (new.id, new.name, new.email, new.company, new.title, new.notes, new.tags);
    END
  `);
  return _db;
}

/**
 * Upsert a contact. Matches by apollo_id first, then by name+company.
 * Only overwrites fields where the new value is non-empty.
 * @returns {number} The contact id
 */
function upsert({ name, email, phone, company, title, linkedinUrl, apolloId, notes, tags, metadata }) {
  if (!name) throw new Error("name is required");

  // Try to find existing contact: first by apollo_id, then by name+company
  let existing = null;
  if (apolloId) {
    existing = db().prepare("SELECT * FROM contacts WHERE apollo_id = ?").get(apolloId);
  }
  if (!existing && name) {
    existing = db().prepare(
      "SELECT * FROM contacts WHERE LOWER(name) = LOWER(?) AND LOWER(company) = LOWER(?)"
    ).get(name, company || "");
  }

  if (existing) {
    // Merge: only overwrite with non-empty new values
    const merged = {
      name: name || existing.name,
      email: email || existing.email,
      phone: phone || existing.phone,
      company: company || existing.company,
      title: title || existing.title,
      linkedin_url: linkedinUrl || existing.linkedin_url,
      apollo_id: apolloId || existing.apollo_id,
      notes: notes || existing.notes,
      tags: tags || existing.tags,
    };

    // Merge metadata
    let existingMeta = {};
    try { existingMeta = JSON.parse(existing.metadata_json || "{}"); } catch {}
    const newMeta = metadata || {};
    const mergedMeta = JSON.stringify({ ...existingMeta, ...newMeta });

    db().prepare(`
      UPDATE contacts SET
        name = ?, email = ?, phone = ?, company = ?, title = ?,
        linkedin_url = ?, apollo_id = ?, notes = ?, tags = ?,
        metadata_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      merged.name, merged.email, merged.phone, merged.company, merged.title,
      merged.linkedin_url, merged.apollo_id, merged.notes, merged.tags,
      mergedMeta, existing.id
    );
    return existing.id;
  }

  // Insert new contact
  const metaStr = JSON.stringify(metadata || {});
  const result = db().prepare(`
    INSERT INTO contacts (name, email, phone, company, title, linkedin_url, apollo_id, notes, tags, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, email || "", phone || "", company || "", title || "",
    linkedinUrl || "", apolloId || "", notes || "", tags || "", metaStr
  );
  return Number(result.lastInsertRowid);
}

/**
 * Full-text search contacts. Returns up to `limit` results ranked by relevance.
 */
function search(query, limit = 10) {
  if (!query || !query.trim()) return [];
  const cleaned = query.replace(/[^\w\s@.-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(" ").filter(w => w.length > 1);
  if (words.length === 0) return [];
  const ftsQuery = words.map(w => `"${w}"`).join(" OR ");

  try {
    return db().prepare(`
      SELECT c.*, rank
      FROM contacts_fts f
      JOIN contacts c ON c.id = f.rowid
      WHERE contacts_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit);
  } catch (err) {
    console.error(`[contacts] search error: ${err.message}`);
    return [];
  }
}

/**
 * Get a contact by name (LIKE match) or by id.
 */
function get({ name, id } = {}) {
  if (id) return db().prepare("SELECT * FROM contacts WHERE id = ?").get(id) || null;
  if (name) return db().prepare("SELECT * FROM contacts WHERE LOWER(name) LIKE LOWER(?)").get(`%${name}%`) || null;
  return null;
}

/**
 * List all contacts.
 */
function list({ limit = 50 } = {}) {
  return db().prepare("SELECT * FROM contacts ORDER BY updated_at DESC LIMIT ?").all(limit);
}

/**
 * Remove a contact by ID.
 */
function remove(id) {
  return db().prepare("DELETE FROM contacts WHERE id = ?").run(id);
}

/**
 * Rebuild FTS5 index.
 */
function rebuild() {
  db().exec("INSERT INTO contacts_fts(contacts_fts) VALUES('rebuild')");
}

module.exports = { upsert, search, get, list, remove, rebuild };
