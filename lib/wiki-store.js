// wiki-store.js — DB-as-truth wiki layer for long-term context memory.
//
// Step 1 of the migration off file-system-as-truth (see proposal in chat
// 2026-05-02). Adds three tables to data/memory-index.db alongside the
// existing memory_chunks / file_meta / etc.:
//
//   pages           one row per memory page (frontmatter + body, full raw_md)
//   page_links      [[wikilinks]] + supersedes/related edges
//   page_revisions  edit history (one row per save, monotonic rev)
//
// Backfill is lossless by construction: pages.raw_md stores the entire .md
// file byte-for-byte, and `verify` re-renders pages.raw_md and diffs against
// disk. Parsed frontmatter is stored in columns for queries but raw_md is the
// authoritative source.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const yaml = require("./yaml-mini.js");

const HOME = os.homedir();
const MERLIN_HOME = process.env.MERLIN_HOME || path.join(HOME, "Dev/merlin");
// Mirror Claude Code's path-slugification: absolute path → "-" + path.replace("/","-").
const PROJECT_SLUG = "-" + MERLIN_HOME.replace(/^\//, "").replace(/\//g, "-");

const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  path.join(MERLIN_HOME, "data/memory-index.db");
const MEMORY_DIR =
  process.env.MEMORY_INDEX_DIR ||
  path.join(HOME, ".claude/projects", PROJECT_SLUG, "memory");

// Files in the memory dir that aren't pages and must never be ingested.
const NON_PAGE_FILES = new Set(["MEMORY.md", "_entities.yaml"]);

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec("PRAGMA foreign_keys=ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id                TEXT PRIMARY KEY,
      basename          TEXT NOT NULL UNIQUE,
      type              TEXT,
      title             TEXT,
      description       TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      pinned            INTEGER NOT NULL DEFAULT 0,
      scope_json        TEXT,
      confidence        TEXT,
      last_verified_at  TEXT,
      expires_at        TEXT,
      raw_md            TEXT NOT NULL,
      body_md           TEXT NOT NULL,
      frontmatter_json  TEXT NOT NULL,
      body_hash         TEXT NOT NULL,
      source_mtime      INTEGER,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status)`);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_pages_pinned ON pages(pinned)`);

  // Migration: columns added 2026-05-02 (wiki audit). pinned_at tracks when
  // the page was last pinned (for the 7-day tenure check before auto-unpin).
  // pin_locked = 1 means the auto-auditor must never auto-unpin this page,
  // regardless of access count — used for identity / always-needed pages
  // whose value can't be measured by tool-call frequency.
  const cols = _db.prepare("PRAGMA table_info(pages)").all().map((r) => r.name);
  if (!cols.includes("pinned_at")) {
    _db.exec(`ALTER TABLE pages ADD COLUMN pinned_at TEXT`);
  }
  if (!cols.includes("pin_locked")) {
    _db.exec(`ALTER TABLE pages ADD COLUMN pin_locked INTEGER NOT NULL DEFAULT 0`);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS page_links (
      src_id     TEXT NOT NULL,
      dst_id     TEXT NOT NULL,
      link_type  TEXT NOT NULL,
      display    TEXT,
      section    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (src_id, dst_id, link_type, section)
    )
  `);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_page_links_dst ON page_links(dst_id)`);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS page_revisions (
      page_id     TEXT NOT NULL,
      rev         INTEGER NOT NULL,
      raw_md      TEXT NOT NULL,
      edited_by   TEXT,
      edited_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (page_id, rev)
    )
  `);

  // FTS5 over pages — internal-storage variant. The page_id column is
  // UNINDEXED (not searched, just retrievable) so we can JOIN back to
  // pages without depending on rowid alignment. Maintained explicitly by
  // savePage / deletePage / backfill — no triggers (they make node:sqlite's
  // FTS5 bridge brittle when the content table has TEXT primary keys).
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED,
      title,
      description,
      body_md,
      tokenize='porter unicode61'
    )
  `);

  // Backfill on first run: if FTS is empty and pages has rows, populate.
  const ftsRows = _db.prepare("SELECT count(*) AS n FROM pages_fts").get();
  const pageRows = _db.prepare("SELECT count(*) AS n FROM pages").get();
  if (ftsRows.n === 0 && pageRows.n > 0) {
    const insert = _db.prepare(
      "INSERT INTO pages_fts(page_id, title, description, body_md) VALUES (?, ?, ?, ?)",
    );
    const all = _db.prepare("SELECT id, title, description, body_md FROM pages").all();
    _db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of all) {
        insert.run(r.id, r.title || "", r.description || "", r.body_md || "");
      }
      _db.exec("COMMIT");
    } catch (err) {
      _db.exec("ROLLBACK");
      throw err;
    }
  }

  return _db;
}

// Refresh the pages_fts row for one page id. Called from savePage so saves
// are immediately searchable. Idempotent — replaces the prior FTS entry for
// this page_id.
function refreshFtsForPage(d, row) {
  d.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(row.id);
  d.prepare(
    "INSERT INTO pages_fts(page_id, title, description, body_md) VALUES (?, ?, ?, ?)",
  ).run(row.id, row.title || "", row.description || "", row.body_md || "");
}

function deleteFtsForPage(d, pageId) {
  d.prepare("DELETE FROM pages_fts WHERE page_id = ?").run(pageId);
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Convert a basename ("user_food_taste.md") to a page id ("user_food_taste").
// The .md extension is the only recognized suffix; anything else stays as-is.
function basenameToId(basename) {
  return basename.endsWith(".md") ? basename.slice(0, -3) : basename;
}

// Split raw_md into { frontmatterText, body }. frontmatterText is the literal
// substring between the opening and closing `---` lines, NOT including the
// fence lines or surrounding newlines. body is everything after the closing
// fence's trailing newline. If there's no frontmatter, frontmatterText is null
// and body is the whole input. This preserves bytes; render() reconstructs.
function splitFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { frontmatterText: null, body: raw };
  // Closing fence is a line containing exactly "---" (we accept "---\n" or
  // "---" at EOF).
  const after = 4; // length of "---\n"
  const end = raw.indexOf("\n---", after - 1);
  if (end === -1) return { frontmatterText: null, body: raw };
  // Confirm the close fence terminates the line — next char is \n or EOF.
  const afterFence = end + 4; // position right after "\n---"
  if (afterFence < raw.length && raw[afterFence] !== "\n")
    return { frontmatterText: null, body: raw };
  const frontmatterText = raw.slice(after, end);
  // Body starts after "\n---" and the terminating newline (if any).
  const body =
    afterFence < raw.length
      ? raw.slice(afterFence + 1) // skip the \n after the closing ---
      : "";
  return { frontmatterText, body };
}

// Parse frontmatter text via yaml-mini. Returns plain object; coerces the
// usual scalar→array fields so downstream callers don't have to.
function parseFrontmatterText(text) {
  if (!text) return {};
  let meta;
  try {
    meta = yaml.parse(text) || {};
  } catch {
    meta = {};
  }
  for (const k of ["scope", "supersedes", "related"]) {
    if (meta[k] != null && !Array.isArray(meta[k])) meta[k] = [meta[k]];
  }
  return meta;
}

// Render a page row back to a markdown file. raw_md is authoritative — we
// just return it. The contract is that raw_md is a complete file body
// including any frontmatter fences.
function renderPage(row) {
  if (!row || typeof row.raw_md !== "string") {
    throw new Error(`renderPage: row missing raw_md`);
  }
  return row.raw_md;
}

// Wikilink regex — matches `[[target]]` and `[[target|display]]`. Same shape
// as memory-store.js so the two systems agree on edge keys during migration.
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

function extractWikilinks(body) {
  const out = [];
  if (!body) return out;
  for (const m of body.matchAll(WIKILINK_RE)) {
    let target = m[1].trim();
    if (!target) continue;
    // Normalize to id (no .md). Edges keyed by page id; dangling targets
    // keep the original spelling as id (caller can detect via JOIN miss).
    if (target.endsWith(".md")) target = target.slice(0, -3);
    out.push({ target, display: m[2] ? m[2].trim() : null });
  }
  return out;
}

// Build the row to upsert into `pages` from a basename + raw file content.
function buildPageRow(basename, raw, sourceMtime = null) {
  const id = basenameToId(basename);
  const { frontmatterText, body } = splitFrontmatter(raw);
  const meta = parseFrontmatterText(frontmatterText);

  const scope = Array.isArray(meta.scope) ? meta.scope : [];
  const status = typeof meta.status === "string" ? meta.status : "active";
  const pinned = meta.pinned === true || meta.pinned === 1 ? 1 : 0;

  return {
    id,
    basename,
    type: meta.type || null,
    title: meta.name || meta.title || id,
    description: meta.description || null,
    status,
    pinned,
    scope_json: JSON.stringify(scope),
    confidence: meta.confidence || null,
    last_verified_at: meta.last_verified_at || null,
    expires_at: meta.expires_at || null,
    raw_md: raw,
    body_md: body,
    frontmatter_json: JSON.stringify(meta),
    body_hash: sha256(raw),
    source_mtime: sourceMtime,
  };
}

const UPSERT_PAGE_SQL = `
  INSERT INTO pages (
    id, basename, type, title, description, status, pinned,
    scope_json, confidence, last_verified_at, expires_at,
    raw_md, body_md, frontmatter_json, body_hash, source_mtime,
    created_at, updated_at
  ) VALUES (
    @id, @basename, @type, @title, @description, @status, @pinned,
    @scope_json, @confidence, @last_verified_at, @expires_at,
    @raw_md, @body_md, @frontmatter_json, @body_hash, @source_mtime,
    datetime('now'), datetime('now')
  )
  ON CONFLICT(id) DO UPDATE SET
    basename = excluded.basename,
    type = excluded.type,
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    pinned = excluded.pinned,
    scope_json = excluded.scope_json,
    confidence = excluded.confidence,
    last_verified_at = excluded.last_verified_at,
    expires_at = excluded.expires_at,
    raw_md = excluded.raw_md,
    body_md = excluded.body_md,
    frontmatter_json = excluded.frontmatter_json,
    body_hash = excluded.body_hash,
    source_mtime = excluded.source_mtime,
    updated_at = CASE
      WHEN pages.body_hash = excluded.body_hash THEN pages.updated_at
      ELSE datetime('now')
    END
`;

function syncLinksForPage(d, row, meta) {
  const wlinks = extractWikilinks(row.body_md);
  const supersedes = Array.isArray(meta.supersedes)
    ? meta.supersedes.map((s) => basenameToId(String(s)))
    : [];
  const related = Array.isArray(meta.related)
    ? meta.related.map((s) => basenameToId(String(s)))
    : [];

  d.prepare("DELETE FROM page_links WHERE src_id = ?").run(row.id);
  const ins = d.prepare(`
    INSERT OR IGNORE INTO page_links (src_id, dst_id, link_type, display, section)
    VALUES (?, ?, ?, ?, '')
  `);
  for (const w of wlinks) ins.run(row.id, w.target, "wikilink", w.display);
  for (const s of supersedes) ins.run(row.id, s, "supersedes", null);
  for (const r of related) ins.run(row.id, r, "related", null);
}

function listPageFiles() {
  if (!fs.existsSync(MEMORY_DIR)) return [];
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && !NON_PAGE_FILES.has(f))
    .map((f) => path.join(MEMORY_DIR, f))
    .sort();
}

// Backfill every .md file under MEMORY_DIR into `pages` + `page_links`.
// Skips MEMORY.md and _entities.yaml. Returns counts + parse error list.
// Idempotent: re-running is safe and only touches updated_at on rows whose
// body_hash actually changed.
function backfill({ dryRun = false } = {}) {
  const d = db();
  const files = listPageFiles();
  const stats = {
    files_scanned: 0,
    pages_inserted: 0,
    pages_updated: 0,
    pages_unchanged: 0,
    pages_removed: 0,
    errors: [],
  };

  // Track which ids exist in the DB now so we can detect deletions.
  const existing = new Set(
    d.prepare("SELECT id FROM pages").all().map((r) => r.id),
  );
  const seen = new Set();

  const upsert = d.prepare(UPSERT_PAGE_SQL);
  const getPrevHash = d.prepare("SELECT body_hash FROM pages WHERE id = ?");

  const batched = [];
  for (const abs of files) {
    stats.files_scanned++;
    try {
      const raw = fs.readFileSync(abs, "utf8");
      const mtime = Math.floor(fs.statSync(abs).mtimeMs);
      const basename = path.basename(abs);
      const row = buildPageRow(basename, raw, mtime);
      const meta = JSON.parse(row.frontmatter_json);
      seen.add(row.id);
      batched.push({ row, meta });
    } catch (err) {
      stats.errors.push({ file: path.basename(abs), error: err.message });
    }
  }

  if (!dryRun && batched.length) {
    d.exec("BEGIN IMMEDIATE");
    try {
      for (const { row, meta } of batched) {
        const prev = getPrevHash.get(row.id);
        const isNew = !prev;
        const isChanged = prev && prev.body_hash !== row.body_hash;
        upsert.run(row);
        syncLinksForPage(d, row, meta);
        if (isNew || isChanged) refreshFtsForPage(d, row);
        if (isNew) stats.pages_inserted++;
        else if (isChanged) stats.pages_updated++;
        else stats.pages_unchanged++;
      }
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
  }

  // Drop pages whose source file is gone. Cascades manually to page_links +
  // page_revisions because we don't have FK ON DELETE wired (would conflict
  // with future external writers).
  if (!dryRun) {
    const toRemove = [...existing].filter((id) => !seen.has(id));
    if (toRemove.length) {
      const delPage = d.prepare("DELETE FROM pages WHERE id = ?");
      const delLinks = d.prepare("DELETE FROM page_links WHERE src_id = ?");
      const delRevs = d.prepare("DELETE FROM page_revisions WHERE page_id = ?");
      d.exec("BEGIN IMMEDIATE");
      try {
        for (const id of toRemove) {
          delPage.run(id);
          delLinks.run(id);
          delRevs.run(id);
          deleteFtsForPage(d, id);
          stats.pages_removed++;
        }
        d.exec("COMMIT");
      } catch (err) {
        d.exec("ROLLBACK");
        throw err;
      }
    }
  }

  return stats;
}

function getPage(idOrBasename) {
  const d = db();
  const id = basenameToId(idOrBasename);
  return d.prepare("SELECT * FROM pages WHERE id = ?").get(id) || null;
}

function listPages({ type, status, pinned } = {}) {
  const d = db();
  const where = [];
  const args = [];
  if (type) {
    where.push("type = ?");
    args.push(type);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (pinned != null) {
    where.push("pinned = ?");
    args.push(pinned ? 1 : 0);
  }
  const sql = `SELECT id, basename, type, title, description, status, pinned, pinned_at, pin_locked FROM pages${
    where.length ? " WHERE " + where.join(" AND ") : ""
  } ORDER BY type, id`;
  return d.prepare(sql).all(...args);
}

// Most-recently-updated pages, regardless of type. Used by the wiki HTTP
// browser's home dashboard to surface what's been changing without dumping
// the full corpus.
function recentlyUpdated({ limit = 12, status = "active" } = {}) {
  const d = db();
  const where = [];
  const args = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  const sql = `SELECT id, type, title, description, pinned, updated_at
    FROM pages${where.length ? " WHERE " + where.join(" AND ") : ""}
    ORDER BY updated_at DESC
    LIMIT ?`;
  args.push(limit);
  return d.prepare(sql).all(...args);
}

// Render every page row back to disk into a target dir, creating it if
// needed. Used for the markdown-dump backup. Returns counts.
function renderAllToDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const d = db();
  const rows = d.prepare("SELECT id, basename, raw_md FROM pages").all();
  for (const r of rows) {
    fs.writeFileSync(path.join(targetDir, r.basename), renderPage(r));
  }
  return { written: rows.length };
}

// Verify that every row, when rendered, equals the on-disk file byte-for-byte.
// Returns { total, matched, mismatched: [{basename, kind, ...}] }.
//   kind = "missing_file"  — row has no corresponding file on disk
//   kind = "missing_row"   — file on disk has no row in DB
//   kind = "byte_diff"     — row.raw_md != file contents
function verify() {
  const d = db();
  const rows = d.prepare("SELECT id, basename, raw_md FROM pages").all();
  const filesOnDisk = new Set(
    listPageFiles().map((f) => path.basename(f)),
  );
  const result = { total: rows.length, matched: 0, mismatched: [] };

  for (const r of rows) {
    const abs = path.join(MEMORY_DIR, r.basename);
    if (!fs.existsSync(abs)) {
      result.mismatched.push({ basename: r.basename, kind: "missing_file" });
      continue;
    }
    filesOnDisk.delete(r.basename);
    const onDisk = fs.readFileSync(abs, "utf8");
    if (onDisk === r.raw_md) {
      result.matched++;
    } else {
      // Compute a small diff hint: first byte that differs.
      const len = Math.min(onDisk.length, r.raw_md.length);
      let firstDiff = -1;
      for (let i = 0; i < len; i++) {
        if (onDisk[i] !== r.raw_md[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff === -1 && onDisk.length !== r.raw_md.length) {
        firstDiff = len;
      }
      result.mismatched.push({
        basename: r.basename,
        kind: "byte_diff",
        disk_len: onDisk.length,
        db_len: r.raw_md.length,
        first_diff_offset: firstDiff,
      });
    }
  }

  for (const f of filesOnDisk) {
    result.mismatched.push({ basename: f, kind: "missing_row" });
  }

  return result;
}

// ── Write path ──
//
// All page mutations route through these helpers. Behaviour is gated by the
// MEMORY_DB_AUTHORITATIVE env var (default "1" since step 5d, 2026-05-02):
//   unset / "1" → DB-only writes; rendering to disk is opt-in via callers
//                  that explicitly pass renderToDisk=true (e.g. `wiki render`).
//                  Files under ~/.claude/projects/.../memory/ are NOT touched
//                  on save. To produce a fresh on-disk dump for backup, run
//                  `wiki render-all <dir>`.
//   "0"          → Legacy mode: DB write + ALSO render the file to disk.
//                  Used only if a tooling regression requires falling back.
//
// Every write inserts a row into page_revisions with a monotonic rev counter
// so we get edit history for free.

function dbAuthoritative() {
  return process.env.MEMORY_DB_AUTHORITATIVE !== "0";
}

function nextRevision(d, pageId) {
  const r = d
    .prepare("SELECT COALESCE(MAX(rev), 0) AS max_rev FROM page_revisions WHERE page_id = ?")
    .get(pageId);
  return (r?.max_rev || 0) + 1;
}

function writeRevision(d, pageId, rawMd, editedBy) {
  const rev = nextRevision(d, pageId);
  d.prepare(
    "INSERT INTO page_revisions (page_id, rev, raw_md, edited_by) VALUES (?, ?, ?, ?)",
  ).run(pageId, rev, rawMd, editedBy || null);
  return rev;
}

// Save (insert or update) a page from raw_md. Renders the file when not in
// DB-authoritative mode, OR when renderToDisk is explicitly true. Returns
// { id, rev, isNew, changed }.
function savePage(basenameOrId, rawMd, { editedBy = null, renderToDisk = null } = {}) {
  if (typeof rawMd !== "string" || !rawMd) {
    throw new Error("savePage: rawMd must be a non-empty string");
  }
  const d = db();
  const basename = basenameOrId.endsWith(".md")
    ? basenameOrId
    : `${basenameOrId}.md`;
  const row = buildPageRow(basename, rawMd, Math.floor(Date.now()));
  const meta = JSON.parse(row.frontmatter_json);

  const prev = d.prepare("SELECT body_hash FROM pages WHERE id = ?").get(row.id);
  const isNew = !prev;
  const changed = prev && prev.body_hash !== row.body_hash;

  let rev = null;
  d.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    d.prepare(UPSERT_PAGE_SQL).run(row);
    syncLinksForPage(d, row, meta);
    refreshFtsForPage(d, row);
    if (isNew || changed) {
      rev = writeRevision(d, row.id, rawMd, editedBy);
    }
    d.exec("COMMIT");
    committed = true;
  } catch (err) {
    if (!committed) d.exec("ROLLBACK");
    throw err;
  }
  // File render happens outside the transaction so a write failure can't
  // trigger a rollback-on-committed (and so the DB write isn't reverted by
  // a transient FS error).
  const shouldRender =
    renderToDisk === true ||
    (renderToDisk === null && !dbAuthoritative());
  if (shouldRender) {
    const abs = path.join(MEMORY_DIR, basename);
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(abs, rawMd);
  }
  return { id: row.id, basename, rev, isNew, changed: !!changed };
}

// Patch frontmatter on an existing page without touching the body. Reads the
// current raw_md, replaces the frontmatter block (or inserts one), and saves
// via savePage so the revision + render path runs uniformly.
function patchFrontmatter(idOrBasename, patch, { editedBy = null } = {}) {
  const row = getPage(idOrBasename);
  if (!row) throw new Error(`patchFrontmatter: no page ${idOrBasename}`);
  const current = JSON.parse(row.frontmatter_json || "{}");
  const merged = { ...current, ...patch };
  // Drop keys explicitly set to null to mean "remove".
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
  }
  const newFm = renderFrontmatter(merged);
  const { body } = splitFrontmatter(row.raw_md);
  const newRaw = newFm + body;
  return savePage(row.basename, newRaw, { editedBy });
}

// Minimal YAML emitter for the subset we use in frontmatter. Enough for
// scalar values, ISO dates, arrays of strings. Any object value falls back
// to JSON-on-one-line — fine for our schema.
function renderFrontmatter(obj) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "string" && !/[:\s,#]/.test(x))) {
        lines.push(`${k}: [${v.join(", ")}]`);
      } else {
        const items = v.map((x) =>
          typeof x === "string" ? JSON.stringify(x) : String(x),
        );
        lines.push(`${k}: [${items.join(", ")}]`);
      }
    } else if (typeof v === "boolean" || typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === "string") {
      // Quote if it contains chars that would confuse the parser.
      const needsQuote = /[:#\n"']/.test(v) || v.trim() !== v;
      lines.push(`${k}: ${needsQuote ? JSON.stringify(v) : v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// Mark a page status='superseded' AND record an edge from <new> -> <old>.
function supersedePage(oldId, newId, { editedBy = null } = {}) {
  const oldRow = getPage(oldId);
  const newRow = getPage(newId);
  if (!oldRow) throw new Error(`supersede: old page not found: ${oldId}`);
  if (!newRow) throw new Error(`supersede: new page not found: ${newId}`);
  const oldBaseId = basenameToId(oldId);
  const newBaseId = basenameToId(newId);
  // Record the edge.
  db()
    .prepare(
      `INSERT OR IGNORE INTO page_links (src_id, dst_id, link_type, display, section)
       VALUES (?, ?, 'supersedes', NULL, '')`,
    )
    .run(newBaseId, oldBaseId);
  // Flip old page's status via frontmatter patch (so render emits status: superseded).
  patchFrontmatter(oldId, { status: "superseded" }, { editedBy });
  // Add to new page's frontmatter supersedes list.
  const cur = JSON.parse(newRow.frontmatter_json || "{}");
  const list = Array.isArray(cur.supersedes) ? cur.supersedes : [];
  if (!list.includes(`${oldBaseId}.md`)) {
    list.push(`${oldBaseId}.md`);
    patchFrontmatter(newId, { supersedes: list }, { editedBy });
  }
  return { old: oldBaseId, new: newBaseId };
}

function setPinned(idOrBasename, pinned, { editedBy = null } = {}) {
  // Stored as a frontmatter field too so it round-trips with the file.
  const out = patchFrontmatter(idOrBasename, { pinned: !!pinned }, { editedBy });
  const id = basenameToId(idOrBasename);
  // pinned_at is a DB-internal column (not in frontmatter) used by the
  // nightly auditor to enforce the 7-day tenure rule before auto-unpin.
  if (pinned) {
    db()
      .prepare("UPDATE pages SET pinned_at = datetime('now') WHERE id = ? AND pinned_at IS NULL")
      .run(id);
  } else {
    db().prepare("UPDATE pages SET pinned_at = NULL WHERE id = ?").run(id);
  }
  return out;
}

function setPinLocked(idOrBasename, locked) {
  const id = basenameToId(idOrBasename);
  const r = db()
    .prepare("UPDATE pages SET pin_locked = ? WHERE id = ?")
    .run(locked ? 1 : 0, id);
  if (r.changes === 0) throw new Error(`setPinLocked: no page ${idOrBasename}`);
  return { id, pin_locked: !!locked };
}

function deletePage(idOrBasename, { editedBy = null, removeFile = null } = {}) {
  const row = getPage(idOrBasename);
  if (!row) throw new Error(`deletePage: no page ${idOrBasename}`);
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    writeRevision(d, row.id, row.raw_md, editedBy || "delete");
    d.prepare("DELETE FROM page_links WHERE src_id = ?").run(row.id);
    d.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
    deleteFtsForPage(d, row.id);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  const shouldRemove =
    removeFile === true || (removeFile === null && !dbAuthoritative());
  if (shouldRemove) {
    const abs = path.join(MEMORY_DIR, row.basename);
    try {
      fs.unlinkSync(abs);
    } catch {}
  }
  return { id: row.id };
}

function getRevisions(idOrBasename) {
  const id = basenameToId(idOrBasename);
  return db()
    .prepare(
      "SELECT rev, edited_by, edited_at, length(raw_md) AS bytes FROM page_revisions WHERE page_id = ? ORDER BY rev DESC",
    )
    .all(id);
}

function getRevision(idOrBasename, rev) {
  const id = basenameToId(idOrBasename);
  return (
    db()
      .prepare(
        "SELECT rev, raw_md, edited_by, edited_at FROM page_revisions WHERE page_id = ? AND rev = ?",
      )
      .get(id, rev) || null
  );
}

// ── Graph helpers ──

// Outgoing links for one page. dst rows include resolved=true if the target
// page exists; false marks dangling links.
function getForwardLinks(idOrBasename) {
  const d = db();
  const id = basenameToId(idOrBasename);
  return d
    .prepare(
      `SELECT pl.dst_id, pl.link_type, pl.display, pl.section,
              CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS resolved,
              p.title AS dst_title, p.type AS dst_type
       FROM page_links pl
       LEFT JOIN pages p ON p.id = pl.dst_id
       WHERE pl.src_id = ?
       ORDER BY pl.link_type, pl.dst_id`,
    )
    .all(id)
    .map((r) => ({ ...r, resolved: !!r.resolved }));
}

// Incoming links for one page. Always resolved (src must exist).
function getBacklinks(idOrBasename) {
  const d = db();
  const id = basenameToId(idOrBasename);
  return d
    .prepare(
      `SELECT pl.src_id, pl.link_type, pl.section,
              p.title AS src_title, p.type AS src_type
       FROM page_links pl
       JOIN pages p ON p.id = pl.src_id
       WHERE pl.dst_id = ?
       ORDER BY pl.link_type, pl.src_id`,
    )
    .all(id);
}

// ── Search ──
//
// FTS5 BM25 search over pages_fts (page_id UNINDEXED + title, description,
// body_md). Saves and deletes refresh the index in-transaction, so results
// are always current.
//
// Modes:
//   "fts"  — BM25 with type weighting + pinned boost (default; what the
//            MCP wiki_search tool uses).
//   "page" — lightweight title/description LIKE; used when the caller wants
//            a structural rather than full-text match.
//
// `type` (optional) restricts to one page type, e.g. "feedback" or "user".
// Saves an FTS scan over the 400+ travel reference pages when the agent
// already knows what category it's after.
//
// Ranking: BM25 alone over-rewards verbose reference pages because they're
// long and mention common nouns (people, places) many times. We add a small
// per-type penalty so user/feedback/project pages outrank reference pages on
// near-equal text matches, with a pinned-page bonus on top. The raw bm25
// value is still returned as `score` for callers.
function searchPages(query, { mode = "fts", limit = 10, type = null } = {}) {
  const d = db();
  if (!query || !query.trim()) return [];
  if (mode === "page") {
    // No LIKE escaping: query is user text and SQLite's LIKE wildcard set is
    // {%, _}. Treating those literally has been fine in practice for memory
    // search (queries are nouns, never escape-sensitive). Add escaping back
    // in only if a real query in the wild collides with one of those chars.
    const like = `%${query}%`;
    const params = [like, like];
    let sql = `SELECT id, basename, type, title, description, status, pinned
       FROM pages
       WHERE (title LIKE ? OR description LIKE ?)
         AND status = 'active'`;
    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }
    sql += ` ORDER BY pinned DESC, type, id LIMIT ?`;
    params.push(limit);
    return d.prepare(sql).all(...params);
  }
  const ftsQuery = query.replace(/['"]/g, "").trim();
  if (!ftsQuery) return [];
  const ftsExpr = ftsQuery
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  // bm25 returns negative numbers (closer to 0 = weaker match). Adding a
  // positive penalty pushes a row toward 0 (sorts later); subtracting a
  // bonus pulls it more negative (sorts earlier). Penalties are deliberately
  // small (≤ 2) so a clearly stronger BM25 match still wins over weighting.
  const params = [ftsExpr];
  let sql = `SELECT p.id, p.basename, p.type, p.title, p.description,
                    p.status, p.pinned,
                    bm25(pages_fts) AS score,
                    snippet(pages_fts, -1, '«', '»', '…', 24) AS fts_snippet
             FROM pages_fts
             JOIN pages p ON p.id = pages_fts.page_id
             WHERE pages_fts MATCH ? AND p.status = 'active'`;
  if (type) {
    sql += ` AND p.type = ?`;
    params.push(type);
  }
  sql += `
    ORDER BY
      bm25(pages_fts)
      + CASE p.type
          WHEN 'feedback'  THEN 0
          WHEN 'user'      THEN 0
          WHEN 'project'   THEN 0
          WHEN 'day'       THEN 0.5
          WHEN 'reference' THEN 1.5
          ELSE 1
        END
      - CASE WHEN p.pinned = 1 THEN 0.5 ELSE 0 END
    LIMIT ?`;
  params.push(limit);
  let rows;
  try {
    rows = d.prepare(sql).all(...params);
  } catch {
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    basename: r.basename,
    type: r.type,
    title: r.title,
    description: r.description,
    status: r.status,
    pinned: !!r.pinned,
    score: r.score,
    heading: null,
    snippet: r.fts_snippet || "",
  }));
}

function stats() {
  const d = db();
  const total = d.prepare("SELECT COUNT(*) AS n FROM pages").get().n;
  const byType = d
    .prepare("SELECT type, COUNT(*) AS n FROM pages GROUP BY type ORDER BY n DESC")
    .all();
  const byStatus = d
    .prepare("SELECT status, COUNT(*) AS n FROM pages GROUP BY status ORDER BY n DESC")
    .all();
  const links = d.prepare("SELECT COUNT(*) AS n FROM page_links").get().n;
  const dangling = d
    .prepare(
      `SELECT COUNT(*) AS n FROM page_links pl
       LEFT JOIN pages p ON p.id = pl.dst_id
       WHERE p.id IS NULL`,
    )
    .get().n;
  const pinned = d
    .prepare("SELECT COUNT(*) AS n FROM pages WHERE pinned = 1")
    .get().n;
  return { total, byType, byStatus, links, dangling, pinned };
}

// ── Access log ──────────────────────────────────────────────────────────
//
// Append-only JSONL of every wiki_search / wiki_read / wiki_backlinks call
// (CLI or MCP). Used by the nightly auditor (`bin/wiki-audit`) to
// decide pin/unpin moves: pages with high recent hit-counts get pinned;
// pinned pages with no hits in 7 days get auto-unpinned (subject to
// pin_locked). Lives outside the DB on purpose — no schema migration if
// the format evolves, and it can be tail-shipped or grep'd without SQL.

const ACCESS_LOG =
  process.env.WIKI_ACCESS_LOG ||
  path.join(HOME, "dev/merlin/data/wiki-access.jsonl");

function logAccess({ tool, query = null, page_ids = [], caller = null } = {}) {
  if (!tool) return;
  try {
    fs.mkdirSync(path.dirname(ACCESS_LOG), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        tool,
        query,
        page_ids: Array.isArray(page_ids) ? page_ids : [page_ids],
        caller: caller || process.env.WIKI_LOG_CALLER || "cli",
      }) + "\n";
    fs.appendFileSync(ACCESS_LOG, line);
  } catch {
    // Never let logging break the calling operation.
  }
}

// Read the access log and return per-page hit counts since the cutoff.
// Returns { counts: Map<pageId, n>, total_entries, total_hits, by_tool }.
// onlyCallers (optional) restricts which caller tags count toward hits —
// the auditor passes ['mcp'] so ad-hoc CLI use doesn't influence pin moves.
function readAccessLog({ sinceMs = 0, onlyCallers = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(ACCESS_LOG, "utf8");
  } catch {
    return { counts: new Map(), total_entries: 0, total_hits: 0, by_tool: {} };
  }
  const counts = new Map();
  const by_tool = {};
  let total_entries = 0;
  let total_hits = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (onlyCallers && !onlyCallers.includes(row.caller)) continue;
    total_entries++;
    by_tool[row.tool] = (by_tool[row.tool] || 0) + 1;
    for (const id of row.page_ids || []) {
      counts.set(id, (counts.get(id) || 0) + 1);
      total_hits++;
    }
  }
  return { counts, total_entries, total_hits, by_tool };
}

module.exports = {
  DB_PATH,
  MEMORY_DIR,
  db,
  closeDb,
  // Parsing helpers (exported for tests + the CLI).
  splitFrontmatter,
  parseFrontmatterText,
  extractWikilinks,
  basenameToId,
  buildPageRow,
  renderPage,
  // High-level API.
  backfill,
  getPage,
  listPages,
  recentlyUpdated,
  listPageFiles,
  renderAllToDir,
  verify,
  stats,
  // Graph + search.
  getForwardLinks,
  getBacklinks,
  searchPages,
  // Write path.
  savePage,
  patchFrontmatter,
  supersedePage,
  setPinned,
  setPinLocked,
  deletePage,
  getRevisions,
  getRevision,
  renderFrontmatter,
  dbAuthoritative,
  // Access log + auditor support.
  ACCESS_LOG,
  logAccess,
  readAccessLog,
};
