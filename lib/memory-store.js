// memory-store.js — hybrid (FTS5 + semantic) retrieval over auto-memory files.
//
// Auto-memory lives at Claude Code's per-project memory dir, which is computed
// from the project's absolute path (e.g. /Users/alice/Dev/merlin →
// ~/.claude/projects/-Users-alice-Dev-merlin/memory). The exact path depends
// on the user's filesystem layout, so we resolve it at runtime from
// ${MERLIN_HOME} unless ${MEMORY_INDEX_DIR} is overridden.
//
// Claude Code loads MEMORY.md into every conversation; this library adds the
// programmatic retrieval layer that grep + "read the whole file" can't do:
// paraphrase-tolerant, ranked, logged, evaluable.
//
// Storage: one SQLite file at data/memory-index.db. A chunk is the
// unit of retrieval — small files are one chunk, larger files split at h2/h3.
// Embeddings are 768-dim nomic-embed-text float32, stored as BLOBs; at query
// time we brute-force cosine (~200 chunks is <5ms). FTS5 on content + tags.
//
// Zero runtime deps beyond node:sqlite + our local-llm helper.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const yaml = require("./yaml-mini.js");

const HOME = os.homedir();
const MERLIN_HOME = process.env.MERLIN_HOME || path.join(HOME, "Dev/merlin");
// Claude Code slugifies the project's absolute path by replacing "/" with "-",
// dropping the leading "/", and prefixing with "-". Mirror that here so the
// memory dir resolves correctly regardless of where the user cloned the repo.
const PROJECT_SLUG = "-" + MERLIN_HOME.replace(/^\//, "").replace(/\//g, "-");
// Paths are env-overridable so tests and one-off reindex runs can use
// isolated fixtures without touching the live index.
const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  path.join(MERLIN_HOME, "data/memory-index.db");
const MEMORY_DIR =
  process.env.MEMORY_INDEX_DIR ||
  path.join(HOME, ".claude/projects", PROJECT_SLUG, "memory");
const LOG_PATH =
  process.env.MEMORY_INDEX_LOG ||
  path.join(MERLIN_HOME, "data/memory-retrieval.jsonl");
const EMBED_DIM = 768;
const ENTITIES_FILE = "_entities.yaml";

// Frontmatter v2 fields we pull into file_meta. Anything else lands in
// raw_frontmatter_json for future-proofing.
const FM_V2_FIELDS = new Set([
  "name",
  "description",
  "type",
  "scope",
  "status",
  "supersedes",
  "related",
  "last_verified_at",
  "expires_at",
  "confidence",
]);

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      chunk_ix INTEGER NOT NULL,
      heading TEXT DEFAULT '',
      title TEXT DEFAULT '',
      type TEXT DEFAULT '',
      body TEXT NOT NULL,
      tags TEXT DEFAULT '',
      embedding BLOB,
      embed_model TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(file, chunk_ix)
    )
  `);
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
      body, heading, title, tags,
      content=memory_chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(rowid, body, heading, title, tags)
      VALUES (new.id, new.body, new.heading, new.title, new.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, body, heading, title, tags)
      VALUES ('delete', old.id, old.body, old.heading, old.title, old.tags);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, body, heading, title, tags)
      VALUES ('delete', old.id, old.body, old.heading, old.title, old.tags);
      INSERT INTO memory_chunks_fts(rowid, body, heading, title, tags)
      VALUES (new.id, new.body, new.heading, new.title, new.tags);
    END
  `);

  // ── v2 additions ──────────────────────────────────────────────────
  // All idempotent (IF NOT EXISTS) so adding these to an existing DB
  // is safe. Populated by reindex(); consumed by search() + memory-lint.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      scope_json TEXT,
      aliases_json TEXT,
      related_json TEXT,
      notes TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS file_meta (
      basename TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      last_verified_at TEXT,
      expires_at TEXT,
      confidence TEXT DEFAULT 'corroborating',
      scope_json TEXT,
      entities_json TEXT,
      raw_frontmatter_json TEXT,
      mtime INTEGER,
      indexed_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Section is NOT NULL (default '') so it can participate in the composite
  // PK without needing a COALESCE expression (which SQLite rejects in PKs).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      link_type TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (src, dst, link_type, section)
    )
  `);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_links_dst ON memory_links(dst)`);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS supersession (
      new_basename TEXT NOT NULL,
      old_basename TEXT NOT NULL,
      PRIMARY KEY (new_basename, old_basename)
    )
  `);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_supersession_old ON supersession(old_basename)`);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_entities (
      chunk_id INTEGER NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (chunk_id, entity_id)
    )
  `);
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_entities_ent ON chunk_entities(entity_id)`);

  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Parsing / chunking ──

// Parse frontmatter using the minimal YAML parser so that v2 fields like
// `scope: [main_residence]` and `supersedes: [old.md]` come through as
// arrays, not strings. Flat (non-frontmatter) bodies are passed through
// unchanged.
function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text };
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  let meta;
  try {
    meta = yaml.parse(header) || {};
  } catch {
    meta = {};
  }
  // Coerce commonly-abused scalar→array fields so we never have to special-case
  // downstream: `scope: foo` becomes `scope: [foo]`.
  for (const k of ["scope", "supersedes", "related"]) {
    if (meta[k] != null && !Array.isArray(meta[k])) meta[k] = [meta[k]];
  }
  return { meta, body };
}

// Extract [[wikilinks]] from body text. Supports `[[target]]` and
// `[[target|display text]]`. Target is normalized: strips any leading/trailing
// whitespace and adds `.md` if the target doesn't already include an extension.
// Returns array of { target, display }.
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
function extractWikilinks(body) {
  const out = [];
  if (!body) return out;
  for (const m of body.matchAll(WIKILINK_RE)) {
    let target = m[1].trim();
    if (!target) continue;
    // Always store as basename (with .md) for stable edge keys.
    if (!/\.[a-z]+$/.test(target)) target += ".md";
    out.push({ target, display: m[2] ? m[2].trim() : null });
  }
  return out;
}

// ── Entity registry (loaded from _entities.yaml next to the memories) ──

let _entityRegistryCache = null;
let _entityRegistryMtime = 0;

function entityRegistryPath() {
  return path.join(MEMORY_DIR, ENTITIES_FILE);
}

// Load and cache the registry. Cache invalidates when the file's mtime changes
// so reindex picks up edits without requiring a process restart. Returns:
//   {
//     entities: { id: {name, type, scope, aliases, ...} },
//     aliasMap: Map<lowercase_alias, entity_id>,
//     aliasPatterns: Array<{regex, id}>   // compiled once, reused per chunk
//   }
// Returns empty maps if the file is missing (system still works without it).
function loadEntityRegistry({ force = false } = {}) {
  const file = entityRegistryPath();
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // File missing is OK — v1 files don't depend on the registry.
    _entityRegistryCache = { entities: {}, aliasMap: new Map(), aliasPatterns: [] };
    _entityRegistryMtime = 0;
    return _entityRegistryCache;
  }
  if (!force && _entityRegistryCache && mtime === _entityRegistryMtime) {
    return _entityRegistryCache;
  }
  let parsed;
  try {
    parsed = yaml.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err.message}`);
  }
  const entities = parsed.entities || {};
  const aliasMap = new Map();
  const aliasPatterns = [];
  for (const [id, ent] of Object.entries(entities)) {
    // The id itself is always a self-alias.
    aliasMap.set(id.toLowerCase(), id);
    const aliases = Array.isArray(ent.aliases) ? ent.aliases : [];
    for (const a of aliases) {
      if (typeof a !== "string" || !a.trim()) continue;
      aliasMap.set(a.toLowerCase(), id);
    }
    // Build a case-insensitive word-boundary regex for each alias. We match
    // on alphanumerics + hyphens + underscores — close enough to "word" for
    // the property/contractor names we care about.
    const forms = [id, ...aliases].filter(Boolean);
    for (const form of forms) {
      const escaped = String(form).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|[^\\w-])(${escaped})(?=[^\\w-]|$)`, "i");
      aliasPatterns.push({ pattern, id });
    }
  }
  _entityRegistryCache = { entities, aliasMap, aliasPatterns };
  _entityRegistryMtime = mtime;
  return _entityRegistryCache;
}

// Return Set<entity_id> of entities whose aliases appear in `text`.
// Cheap: iterates compiled alias patterns; O(aliases × text_length) worst case,
// but aliases total ~60-100 across the whole registry and text is typically
// <2KB per chunk. Easily under 1ms per chunk.
function matchEntitiesInText(text, registry) {
  const hits = new Set();
  if (!text || !registry || !registry.aliasPatterns.length) return hits;
  for (const { pattern, id } of registry.aliasPatterns) {
    if (pattern.test(text)) hits.add(id);
  }
  return hits;
}

// Compute the transitive scope of a query's mentioned entities. This is used
// by the reranker to decide whether a candidate chunk's entities belong in the
// query's conversational frame.
//   Example: query "spa-server retirement" → [project_x]
//            project_x.scope = [main_residence]
//            → query scope universe = {project_x, main_residence}
// We treat property entities as their own scope (they are scope roots), and
// people/systems contribute their `scope` list plus themselves.
function expandScopeUniverse(entityIds, registry) {
  const universe = new Set();
  if (!entityIds || !registry) return universe;
  for (const id of entityIds) {
    universe.add(id);
    const ent = registry.entities[id];
    if (!ent) continue;
    const scope = Array.isArray(ent.scope) ? ent.scope : [];
    for (const s of scope) universe.add(s);
  }
  return universe;
}

// Split body at h2/h3 boundaries; leave smaller files as a single chunk.
// Regex matches exactly "## " or "### " at line-start (not #, ####, #####).
function splitByHeadings(body) {
  const lines = body.split("\n");
  const chunks = [];
  let current = { heading: "", lines: [] };
  for (const line of lines) {
    if (/^#{2,3} /.test(line)) {
      if (current.lines.length || current.heading) chunks.push(current);
      current = { heading: line.replace(/^#+\s*/, "").trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length || current.heading) chunks.push(current);
  return chunks
    .map((c) => ({ heading: c.heading, body: c.lines.join("\n").trim() }))
    .filter((c) => c.body || c.heading);
}

function parseMemoryFile(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const base = path.basename(absPath);
  const title = meta.name || meta.title || base.replace(/\.md$/, "");
  const type = meta.type || "";
  const tags = meta.tags || "";

  // Decide whether to split: only when headings actually yield 2+ non-empty
  // sections. Single-heading files stay as one chunk — splitting them just
  // strips context without a recall win.
  const trimmed = body.trim();
  const parts = splitByHeadings(trimmed);
  const chunks =
    parts.length < 2
      ? [
          {
            file: base,
            chunk_ix: 0,
            heading: "",
            title,
            type,
            body: trimmed,
            tags,
          },
        ]
      : parts.map((p, i) => ({
          file: base,
          chunk_ix: i,
          heading: p.heading,
          title,
          type,
          body: p.body,
          tags,
        }));
  let mtime = 0;
  try {
    mtime = fs.statSync(absPath).mtimeMs;
  } catch {}
  return { basename: base, meta, body: trimmed, chunks, mtime };
}

function chunkFile(absPath) {
  return parseMemoryFile(absPath).chunks;
}

function buildEmbedText(chunk) {
  const parts = [chunk.title];
  if (chunk.type) parts.push(`[${chunk.type}]`);
  if (chunk.heading) parts.push(chunk.heading);
  parts.push(chunk.body);
  return parts.filter(Boolean).join("\n\n");
}

// ── Embedding I/O ──

// Default embedder: Ollama nomic-embed-text via the local-llm helper.
// Tests swap this for a deterministic toy embedder via setEmbedFn().
let _embedFn = async function defaultEmbedText(text) {
  const { localLlmEmbed } = await import("./local-llm.mjs");
  const vec = await localLlmEmbed(text);
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(
      `embedding dim mismatch: got ${vec?.length}, expected ${EMBED_DIM}`,
    );
  }
  return vec;
};

async function embedText(text) {
  return _embedFn(text);
}

function setEmbedFn(fn) {
  _embedFn = fn;
}

function vecToBuf(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function bufToVec(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const f32 = new Float32Array(
    u8.buffer,
    u8.byteOffset,
    u8.byteLength / 4,
  );
  return Array.from(f32);
}

function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Indexing ──

function listMemoryFiles() {
  if (!fs.existsSync(MEMORY_DIR)) return [];
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => path.join(MEMORY_DIR, f));
}

// Sync the entity registry from _entities.yaml into the entities table.
// Upsert every current registry entry; remove rows no longer in the file.
function syncEntitiesTable(d, registry) {
  const upsert = d.prepare(`
    INSERT INTO entities (id, name, type, status, scope_json, aliases_json, related_json, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      status = excluded.status,
      scope_json = excluded.scope_json,
      aliases_json = excluded.aliases_json,
      related_json = excluded.related_json,
      notes = excluded.notes,
      updated_at = datetime('now')
  `);
  const ids = new Set();
  for (const [id, ent] of Object.entries(registry.entities || {})) {
    ids.add(id);
    upsert.run(
      id,
      ent.name ?? id,
      ent.type ?? null,
      ent.status ?? "active",
      JSON.stringify(Array.isArray(ent.scope) ? ent.scope : []),
      JSON.stringify(Array.isArray(ent.aliases) ? ent.aliases : []),
      JSON.stringify(Array.isArray(ent.related) ? ent.related : []),
      ent.notes ?? null,
    );
  }
  // Remove stale ids.
  const existing = d.prepare("SELECT id FROM entities").all();
  const del = d.prepare("DELETE FROM entities WHERE id = ?");
  for (const row of existing) {
    if (!ids.has(row.id)) del.run(row.id);
  }
}

// Upsert file_meta for one file. Computes entities_json as the union of all
// chunks' entity matches.
function upsertFileMeta(d, parsed, unionEntities) {
  const meta = parsed.meta || {};
  const raw = {};
  for (const [k, v] of Object.entries(meta)) {
    // Stash everything so later migrations can look at fields we don't yet
    // promote to columns.
    raw[k] = v;
  }
  d.prepare(`
    INSERT INTO file_meta
      (basename, name, description, type, status, last_verified_at, expires_at,
       confidence, scope_json, entities_json, raw_frontmatter_json, mtime, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(basename) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      type = excluded.type,
      status = excluded.status,
      last_verified_at = excluded.last_verified_at,
      expires_at = excluded.expires_at,
      confidence = excluded.confidence,
      scope_json = excluded.scope_json,
      entities_json = excluded.entities_json,
      raw_frontmatter_json = excluded.raw_frontmatter_json,
      mtime = excluded.mtime,
      indexed_at = datetime('now')
  `).run(
    parsed.basename,
    meta.name ?? parsed.basename,
    meta.description ?? null,
    meta.type ?? null,
    meta.status ?? "active",
    meta.last_verified_at ?? null,
    meta.expires_at ?? null,
    meta.confidence ?? "corroborating",
    JSON.stringify(Array.isArray(meta.scope) ? meta.scope : []),
    JSON.stringify(Array.from(unionEntities).sort()),
    JSON.stringify(raw),
    Math.floor(parsed.mtime || 0),
  );
}

// Replace all link/supersession/chunk_entity rows originating from `basename`
// so a stale file doesn't leave ghost edges. Called at the start of each
// file's reindex pass.
function clearFileEdges(d, basename, chunkIds) {
  d.prepare("DELETE FROM memory_links WHERE src = ?").run(basename);
  d.prepare("DELETE FROM supersession WHERE new_basename = ?").run(basename);
  if (chunkIds && chunkIds.length) {
    const placeholders = chunkIds.map(() => "?").join(",");
    d.prepare(`DELETE FROM chunk_entities WHERE chunk_id IN (${placeholders})`).run(
      ...chunkIds,
    );
  }
}

function insertLink(d, src, dst, linkType, section) {
  d.prepare(`
    INSERT OR IGNORE INTO memory_links (src, dst, link_type, section)
    VALUES (?, ?, ?, ?)
  `).run(src, dst, linkType, section ?? "");
}

function insertSupersession(d, newBasename, oldBasename) {
  d.prepare(`
    INSERT OR IGNORE INTO supersession (new_basename, old_basename)
    VALUES (?, ?)
  `).run(newBasename, oldBasename);
}

function insertChunkEntity(d, chunkId, entityId) {
  d.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id)
    VALUES (?, ?)
  `).run(chunkId, entityId);
}

async function reindex({ dryRun = false, force = false } = {}) {
  const d = db();
  const files = listMemoryFiles();
  const stats = {
    files: files.length,
    chunks_written: 0,
    chunks_skipped_unchanged: 0,
    chunks_removed: 0,
    files_scanned: 0,
    links_written: 0,
    entity_mentions: 0,
    supersessions: 0,
    errors: [],
  };

  // Load + sync the entity registry first. Registry is the ground truth for
  // both alias detection (chunk_entities) and the reranker's scope universe.
  const registry = loadEntityRegistry({ force });
  if (!dryRun) {
    try {
      syncEntitiesTable(d, registry);
    } catch (err) {
      stats.errors.push({ file: ENTITIES_FILE, error: err.message });
    }
  }

  const seenIds = new Set();
  const existing = d
    .prepare(
      "SELECT id, file, chunk_ix, body, embedding FROM memory_chunks",
    )
    .all();
  const existingByKey = new Map();
  for (const row of existing) {
    existingByKey.set(`${row.file}\u0000${row.chunk_ix}`, row);
  }

  for (const abs of files) {
    stats.files_scanned++;
    let parsed;
    try {
      parsed = parseMemoryFile(abs);
    } catch (err) {
      stats.errors.push({ file: path.basename(abs), error: err.message });
      continue;
    }
    const { basename, meta, chunks } = parsed;

    // Track chunk IDs so we can (re)populate chunk_entities after the main
    // chunk upsert. We clear edge tables once per file so stale wikilinks /
    // entity mentions don't linger when a file's body shrinks.
    const thisFileChunkIds = [];

    for (const c of chunks) {
      const key = `${c.file}\u0000${c.chunk_ix}`;
      const prev = existingByKey.get(key);
      const needsEmbed =
        force || !prev || !prev.embedding || prev.body !== c.body;

      if (!needsEmbed) {
        seenIds.add(prev.id);
        thisFileChunkIds.push(prev.id);
        stats.chunks_skipped_unchanged++;
        continue;
      }

      if (dryRun) {
        seenIds.add(prev?.id ?? -1);
        stats.chunks_written++;
        continue;
      }

      let vec;
      try {
        vec = await embedText(buildEmbedText(c));
      } catch (err) {
        stats.errors.push({
          file: c.file,
          chunk_ix: c.chunk_ix,
          error: err.message,
        });
        // Defensive: if embedding fails (e.g. Ollama down) but a prior row
        // exists for this chunk, KEEP the prior row. Otherwise the stale-cleanup
        // pass at end-of-reindex would gut the entire index when the embedder
        // is unavailable. Verified: a force reindex with Ollama unreachable
        // previously deleted all 162 chunks; now they're preserved.
        if (prev?.id) {
          seenIds.add(prev.id);
          thisFileChunkIds.push(prev.id);
        }
        continue;
      }

      const buf = vecToBuf(vec);
      const stmt = d.prepare(`
        INSERT INTO memory_chunks
          (file, chunk_ix, heading, title, type, body, tags, embedding, embed_model, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(file, chunk_ix) DO UPDATE SET
          heading = excluded.heading,
          title = excluded.title,
          type = excluded.type,
          body = excluded.body,
          tags = excluded.tags,
          embedding = excluded.embedding,
          embed_model = excluded.embed_model,
          updated_at = datetime('now')
      `);
      const result = stmt.run(
        c.file,
        c.chunk_ix,
        c.heading,
        c.title,
        c.type,
        c.body,
        c.tags,
        buf,
        "nomic-embed-text",
      );
      const insertedId = Number(result.lastInsertRowid);
      const chunkId = insertedId || prev?.id;
      seenIds.add(chunkId);
      thisFileChunkIds.push(chunkId);
      stats.chunks_written++;
    }

    if (dryRun) continue;

    // ── v2 side-effects: edges + entity mentions + file_meta ──
    clearFileEdges(d, basename, thisFileChunkIds);

    // Wikilinks in body → memory_links (link_type='body'). Track per chunk
    // so the `section` column points at the heading where the link appears.
    for (const c of chunks) {
      const links = extractWikilinks(c.body);
      for (const L of links) {
        insertLink(d, basename, L.target, "body", c.heading || null);
        stats.links_written++;
      }
    }
    // Frontmatter `related:` → memory_links (link_type='fm-related').
    for (const rel of Array.isArray(meta.related) ? meta.related : []) {
      const target = /\.[a-z]+$/.test(rel) ? rel : `${rel}.md`;
      insertLink(d, basename, target, "fm-related", null);
      stats.links_written++;
    }
    // Frontmatter `supersedes:` → memory_links + supersession table.
    for (const sup of Array.isArray(meta.supersedes) ? meta.supersedes : []) {
      const target = /\.[a-z]+$/.test(sup) ? sup : `${sup}.md`;
      insertLink(d, basename, target, "fm-supersedes", null);
      insertSupersession(d, basename, target);
      stats.supersessions++;
    }

    // chunk_entities: match aliases in chunk bodies against the registry.
    const unionEntities = new Set();
    chunks.forEach((c, ix) => {
      const chunkId = thisFileChunkIds[ix];
      if (chunkId == null) return;
      const hits = matchEntitiesInText(c.body, registry);
      for (const id of hits) {
        insertChunkEntity(d, chunkId, id);
        unionEntities.add(id);
        stats.entity_mentions++;
      }
    });

    upsertFileMeta(d, parsed, unionEntities);
  }

  // Remove stale chunks: anything in the table not present in seenIds.
  // Also drop file_meta + edges for any file that no longer exists on disk.
  if (!dryRun) {
    const remove = d.prepare(
      "DELETE FROM memory_chunks WHERE id = ?",
    );
    const removeChunkEntities = d.prepare(
      "DELETE FROM chunk_entities WHERE chunk_id = ?",
    );
    for (const row of existing) {
      if (!seenIds.has(row.id)) {
        removeChunkEntities.run(row.id);
        remove.run(row.id);
        stats.chunks_removed++;
      }
    }

    const currentBasenames = new Set(files.map((f) => path.basename(f)));
    const fmRows = d.prepare("SELECT basename FROM file_meta").all();
    for (const row of fmRows) {
      if (!currentBasenames.has(row.basename)) {
        d.prepare("DELETE FROM file_meta WHERE basename = ?").run(row.basename);
        d.prepare("DELETE FROM memory_links WHERE src = ?").run(row.basename);
        d.prepare("DELETE FROM supersession WHERE new_basename = ?").run(row.basename);
      }
    }
  }

  return stats;
}

// ── Graph helpers ─────────────────────────────────────────────────────

// All outgoing edges from `basename`. Rows: {dst, link_type, section}.
function getForwardLinks(basename) {
  return db()
    .prepare(
      `SELECT dst, link_type, section
       FROM memory_links
       WHERE src = ?
       ORDER BY link_type, dst`,
    )
    .all(basename);
}

// All incoming edges to `basename`. Rows: {src, link_type, section}.
function getBacklinks(basename) {
  return db()
    .prepare(
      `SELECT src, link_type, section
       FROM memory_links
       WHERE dst = ?
       ORDER BY link_type, src`,
    )
    .all(basename);
}

function getChunkEntities(chunkId) {
  return db()
    .prepare("SELECT entity_id FROM chunk_entities WHERE chunk_id = ?")
    .all(chunkId)
    .map((r) => r.entity_id);
}

function getFileMeta(basename) {
  return db()
    .prepare("SELECT * FROM file_meta WHERE basename = ?")
    .get(basename);
}

// Return `{new_basename, old_basename}[]` where old matches.
function getSupersedersOf(oldBasename) {
  return db()
    .prepare(
      `SELECT new_basename FROM supersession WHERE old_basename = ?`,
    )
    .all(oldBasename)
    .map((r) => r.new_basename);
}

// ── Search ──

function sanitizeFtsQuery(q) {
  const cleaned = q
    .replace(/[^\w\s@.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 1);
  if (!words.length) return null;
  return words.map((w) => `"${w}"`).join(" OR ");
}

function ftsSearch(query, limit) {
  const fts = sanitizeFtsQuery(query);
  if (!fts) return [];
  try {
    const rows = db()
      .prepare(`
        SELECT m.id, m.file, m.chunk_ix, m.heading, m.title, m.type, m.body, m.tags,
               bm25(memory_chunks_fts) AS bm25
        FROM memory_chunks_fts f
        JOIN memory_chunks m ON m.id = f.rowid
        WHERE memory_chunks_fts MATCH ?
        ORDER BY bm25
        LIMIT ?
      `)
      .all(fts, limit);
    return rows.map((r, i) => ({ ...r, fts_rank: i + 1, fts_score: -r.bm25 }));
  } catch {
    return [];
  }
}

async function semanticSearch(query, limit) {
  const qvec = await embedText(query);
  const rows = db()
    .prepare(
      "SELECT id, file, chunk_ix, heading, title, type, body, tags, embedding FROM memory_chunks WHERE embedding IS NOT NULL",
    )
    .all();
  const scored = rows.map((r) => {
    const vec = bufToVec(r.embedding);
    const sim = vec ? cosine(qvec, vec) : -1;
    const { embedding, ...rest } = r;
    return { ...rest, sem_score: sim };
  });
  scored.sort((a, b) => b.sem_score - a.sem_score);
  const top = scored.slice(0, limit);
  return top.map((r, i) => ({ ...r, sem_rank: i + 1 }));
}

// Reciprocal Rank Fusion; k=60 is the canonical default.
function rrfMerge(listA, listB, { k = 60, limit = 10 } = {}) {
  const agg = new Map();
  const add = (row, rankField) => {
    const rank = row[rankField];
    if (!rank) return;
    const prev = agg.get(row.id) || { ...row, rrf: 0 };
    prev.rrf += 1 / (k + rank);
    // Preserve any rank/score fields already present on either row.
    if (row.fts_score !== undefined) prev.fts_score = row.fts_score;
    if (row.fts_rank !== undefined) prev.fts_rank = row.fts_rank;
    if (row.sem_score !== undefined) prev.sem_score = row.sem_score;
    if (row.sem_rank !== undefined) prev.sem_rank = row.sem_rank;
    agg.set(row.id, prev);
  };
  for (const r of listA) add(r, "fts_rank");
  for (const r of listB) add(r, "sem_rank");
  return Array.from(agg.values())
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit);
}

// Parse the query string for entity mentions and return the scope universe
// those entities occupy. "Scope universe" = the entities themselves plus any
// entity they are scoped-to (e.g. project_x → adds main_residence).
//
// Returns:
//   { queryEntities: Set<id>, universe: Set<id> }
//   - queryEntities: entities literally mentioned in the query
//   - universe: transitively-scoped entities (entity.scope values)
// If the query mentions no known entities, both are empty and the reranker
// becomes a no-op (neutral scoring for every candidate).
function parseQueryEntities(query, registry) {
  const mentioned = matchEntitiesInText(query || "", registry);
  const universe = expandScopeUniverse(mentioned, registry);
  return { queryEntities: mentioned, universe };
}

// Scope / status / supersession reranker. Pure function of (candidates, query
// universe, file meta, chunk entities). Returns the same list with each row
// decorated by `score_mult`, `warnings[]`, and filtered of supersession drops.
//
// Rules (matching the v2 design memo):
//   scope_mult  = 1.5 if chunk entities ∩ query universe is non-empty
//                 0.4 if query universe is non-empty AND chunk has conflicting
//                     scope (i.e. any chunk entity has a scope list that
//                     doesn't intersect the query universe)
//                 1.0 otherwise
//   status_mult = {active:1.0, resolved:0.4, superseded:0.2, historical:0.6}
//   supersession_drop = silently drop if another candidate in this result set
//                       has status=active and supersedes this candidate's file
function applyScopeRerank(candidates, query, registry, opts = {}) {
  const { disable = false } = opts;
  if (disable || !candidates || !candidates.length) {
    for (const c of candidates || []) c.scope_mult = 1.0;
    return candidates;
  }

  const { queryEntities, universe } = parseQueryEntities(query, registry);
  const haveQueryContext = universe.size > 0;

  // Fetch file_meta + chunk entities for all candidates in one pass.
  const d = db();
  const byFile = new Map();
  for (const c of candidates) {
    if (!byFile.has(c.file)) {
      const meta = d
        .prepare("SELECT status, scope_json FROM file_meta WHERE basename = ?")
        .get(c.file);
      byFile.set(c.file, meta || {});
    }
  }
  const chunkIds = candidates.map((c) => c.id).filter(Boolean);
  const chunkEntMap = new Map();
  if (chunkIds.length) {
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = d
      .prepare(
        `SELECT chunk_id, entity_id FROM chunk_entities WHERE chunk_id IN (${placeholders})`,
      )
      .all(...chunkIds);
    for (const r of rows) {
      if (!chunkEntMap.has(r.chunk_id)) chunkEntMap.set(r.chunk_id, []);
      chunkEntMap.get(r.chunk_id).push(r.entity_id);
    }
  }

  // Supersession drop set: for each candidate file, if there exists another
  // in-set candidate that supersedes it AND is status=active, drop this one.
  const filesInSet = new Set(candidates.map((c) => c.file));
  const activeSupersedersInSet = new Map(); // old -> Array<new>
  for (const file of filesInSet) {
    const newOnes = getSupersedersOf(file);
    const active = [];
    for (const n of newOnes) {
      const m = byFile.get(n) || d
        .prepare("SELECT status FROM file_meta WHERE basename = ?")
        .get(n);
      if (m && m.status === "active" && filesInSet.has(n)) {
        active.push(n);
      }
    }
    if (active.length) activeSupersedersInSet.set(file, active);
  }

  const STATUS_MULT = {
    active: 1.0,
    resolved: 0.4,
    superseded: 0.2,
    historical: 0.6,
  };

  const out = [];
  for (const c of candidates) {
    // Supersession drop
    if (activeSupersedersInSet.has(c.file)) {
      continue;
    }

    const fileMeta = byFile.get(c.file) || {};
    const status = fileMeta.status || "active";
    const status_mult = STATUS_MULT[status] ?? 1.0;

    const chunkEnts = chunkEntMap.get(c.id) || [];
    let scope_mult = 1.0;
    let scope_reason = null;
    if (haveQueryContext) {
      const aligns = chunkEnts.some((e) => universe.has(e));
      if (aligns) {
        scope_mult = 1.5;
        scope_reason = "scope_align";
      } else {
        // Conflicting scope: chunk has entity E whose scope misses the universe.
        let conflict = false;
        for (const e of chunkEnts) {
          const ent = registry.entities[e];
          if (!ent) continue;
          const scope = Array.isArray(ent.scope) ? ent.scope : [];
          if (scope.length && !scope.some((s) => universe.has(s))) {
            conflict = true;
            break;
          }
        }
        if (conflict) {
          scope_mult = 0.4;
          scope_reason = "scope_conflict";
        }
      }
    }

    const baseScore =
      c.rrf !== undefined ? c.rrf : c.sem_score !== undefined ? c.sem_score : c.fts_score || 0;
    const final = baseScore * scope_mult * status_mult;

    const warnings = [];
    if (status !== "active") warnings.push(`status=${status}`);

    out.push({
      ...c,
      score_mult: scope_mult * status_mult,
      scope_mult,
      status_mult,
      scope_reason,
      status,
      chunk_entities: chunkEnts,
      query_entities: Array.from(queryEntities),
      query_universe: Array.from(universe),
      warnings,
      // Override the primary score with the post-rerank value so downstream
      // sorting / log payload uses the adjusted ranking.
      rrf: c.rrf !== undefined ? final : c.rrf,
      sem_score: c.sem_score !== undefined && c.rrf === undefined ? final : c.sem_score,
      fts_score:
        c.fts_score !== undefined && c.rrf === undefined && c.sem_score === undefined
          ? final
          : c.fts_score,
      final_score: final,
    });
  }
  out.sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0));
  return out;
}

// For an origin chunk (a row we already returned), list up to `cap` neighbor
// basenames via memory_links. Returns [{basename, link_type, direction}] so
// callers can render "also see: X (related)" lines. Direction is:
//   'out' — origin → neighbor (origin has a [[wikilink]] or `related:` entry)
//   'in'  — neighbor → origin (someone else points here)
function neighborsOf(basename, cap = 8) {
  const out = new Map();
  const pick = (key, linkType, direction) => {
    if (out.has(key)) return;
    out.set(key, { basename: key, link_type: linkType, direction });
  };
  for (const row of getForwardLinks(basename)) {
    pick(row.dst, row.link_type, "out");
    if (out.size >= cap) break;
  }
  if (out.size < cap) {
    for (const row of getBacklinks(basename)) {
      pick(row.src, row.link_type, "in");
      if (out.size >= cap) break;
    }
  }
  return Array.from(out.values());
}

// Fetch a representative chunk for a file — lowest chunk_ix (top of file).
// Used when expanding neighbor basenames into result rows.
function topChunkFor(basename) {
  return db()
    .prepare(
      `SELECT id, file, chunk_ix, heading, title, type, body, tags
       FROM memory_chunks
       WHERE file = ?
       ORDER BY chunk_ix
       LIMIT 1`,
    )
    .get(basename);
}

async function search(
  query,
  {
    mode = "hybrid",
    limit = 10,
    caller = "cli",
    log = true,
    expand = true,
    expandDepth = 5,
    neighborPenalty = 0.5,
    scopeRerank = true,
  } = {},
) {
  if (!query || !query.trim()) return [];
  const start = Date.now();
  let results = [];
  const tokenCount = query.trim().split(/\s+/).filter(Boolean).length;
  // Pull a larger candidate pool when we're going to rerank, since scope
  // conflicts can push high-BM25 hits down and relevant entity matches up.
  const poolLimit = Math.max(limit * 3, 20);

  if (mode === "fts") {
    results = ftsSearch(query, poolLimit);
  } else if (mode === "semantic") {
    results = await semanticSearch(query, poolLimit);
  } else {
    const fts = ftsSearch(query, poolLimit);
    if (tokenCount <= 3) {
      results = fts;
    } else {
      let sem = [];
      try {
        sem = await semanticSearch(query, poolLimit);
      } catch {
        sem = [];
      }
      results = sem.length ? rrfMerge(fts, sem, { limit: poolLimit }) : fts;
    }
  }

  // Scope + status + supersession rerank. When scopeRerank=false we still
  // populate neutral score_mult fields so downstream callers have a stable
  // shape.
  const registry = loadEntityRegistry();
  results = applyScopeRerank(results, query, registry, { disable: !scopeRerank });
  results = results.slice(0, limit);

  // Attach neighbor metadata to every result so the agent can see related
  // files even when not in the top-K. Cheap — one query per result.
  for (const r of results) {
    r.neighbors = neighborsOf(r.file, 6);
  }

  // Neighbor expansion: only the top `expandDepth` originals contribute
  // neighbors to the expanded set. This caps blast radius and keeps the
  // result list focused on the query.
  if (expand) {
    const presentFiles = new Set(results.map((r) => r.file));
    const added = [];
    const originScore = (r) =>
      r.rrf ?? r.sem_score ?? r.fts_score ?? 0;

    for (let i = 0; i < Math.min(expandDepth, results.length); i++) {
      const origin = results[i];
      for (const n of origin.neighbors || []) {
        if (presentFiles.has(n.basename)) continue;
        const chunk = topChunkFor(n.basename);
        if (!chunk) continue;
        presentFiles.add(n.basename);
        added.push({
          ...chunk,
          rrf: originScore(origin) * neighborPenalty,
          expanded_from: origin.file,
          expansion_type: n.link_type,
          expansion_direction: n.direction,
          neighbors: [], // don't chain further
        });
      }
    }

    if (added.length) {
      results = results
        .concat(added)
        .sort(
          (a, b) =>
            (b.rrf ?? b.sem_score ?? b.fts_score ?? 0) -
            (a.rrf ?? a.sem_score ?? a.fts_score ?? 0),
        )
        .slice(0, limit);
    }
  }

  const latency_ms = Date.now() - start;
  if (log) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(
        LOG_PATH,
        JSON.stringify({
          ts: new Date().toISOString(),
          caller,
          query,
          mode,
          limit,
          latency_ms,
          top: results.slice(0, 5).map((r) => ({
            file: r.file,
            heading: r.heading || null,
            score:
              mode === "hybrid"
                ? Number((r.rrf || 0).toFixed(4))
                : mode === "semantic"
                  ? Number((r.sem_score || 0).toFixed(4))
                  : Number((r.fts_score || 0).toFixed(4)),
          })),
        }) + "\n",
      );
    } catch {
      // Logging is best-effort — never break a search because the log failed.
    }
  }

  return results;
}

// ── Introspection helpers ──

function stats() {
  const d = db();
  const count = d
    .prepare("SELECT COUNT(*) AS n FROM memory_chunks")
    .get().n;
  const files = d
    .prepare("SELECT COUNT(DISTINCT file) AS n FROM memory_chunks")
    .get().n;
  const embedded = d
    .prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE embedding IS NOT NULL")
    .get().n;
  const byType = d
    .prepare(
      "SELECT COALESCE(NULLIF(type, ''), '(untyped)') AS type, COUNT(*) AS n FROM memory_chunks GROUP BY type ORDER BY n DESC",
    )
    .all();
  return { chunks: count, files, embedded, byType };
}

function listEntries({ file, limit = 200 } = {}) {
  if (file) {
    return db()
      .prepare(
        "SELECT id, file, chunk_ix, heading, title, type, body, tags, updated_at, (embedding IS NOT NULL) AS has_embedding FROM memory_chunks WHERE file = ? ORDER BY chunk_ix",
      )
      .all(file);
  }
  return db()
    .prepare(
      "SELECT id, file, chunk_ix, heading, title, type, tags, updated_at, (embedding IS NOT NULL) AS has_embedding FROM memory_chunks ORDER BY file, chunk_ix LIMIT ?",
    )
    .all(limit);
}

module.exports = {
  // DB
  db,
  closeDb,
  DB_PATH,
  MEMORY_DIR,
  LOG_PATH,
  EMBED_DIM,
  ENTITIES_FILE,
  // Indexing
  reindex,
  chunkFile,
  parseMemoryFile,
  parseFrontmatter,
  listMemoryFiles,
  buildEmbedText,
  extractWikilinks,
  // Entity registry
  loadEntityRegistry,
  matchEntitiesInText,
  expandScopeUniverse,
  entityRegistryPath,
  // Graph
  getForwardLinks,
  getBacklinks,
  getChunkEntities,
  getFileMeta,
  getSupersedersOf,
  neighborsOf,
  topChunkFor,
  // Search
  search,
  ftsSearch,
  semanticSearch,
  rrfMerge,
  sanitizeFtsQuery,
  parseQueryEntities,
  applyScopeRerank,
  // Introspection
  stats,
  listEntries,
  // Embedding utilities (exposed for tests)
  embedText,
  setEmbedFn,
  vecToBuf,
  bufToVec,
  cosine,
};
