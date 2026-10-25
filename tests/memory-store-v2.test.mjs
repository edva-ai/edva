// memory-store-v2.test.mjs — unit tests for Phase 1 additions to memory-store.js:
//   entity registry, frontmatter v2 (arrays), wikilinks, memory_links,
//   chunk_entities, supersession, file_meta.
// Run: node --test tests/memory-store-v2.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-v2-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
const fixtureLog = path.join(fixtureDir, "memory-retrieval.jsonl");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_INDEX_LOG = fixtureLog;

fs.writeFileSync(path.join(fixtureMemoryDir, "MEMORY.md"), "# index\n");

// Entity registry — exercises nested mappings, inline arrays, scope, status.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "_entities.yaml"),
  `entities:
  north_workshop:
    name: "North Workshop"
    type: property
    aliases: ["north workshop", northside]
  dock_7:
    name: "Dock 7"
    type: property
    aliases: ["dock 7", "bay seven"]
  sam_ortiz:
    name: "Sam Ortiz"
    type: person
    scope: [dock_7]
    aliases: ["sam ortiz"]
  thermostat_control:
    name: "Thermostat Control"
    type: system
    scope: [north_workshop]
    aliases: ["thermostat control", "thermostat-server", "thermostat server"]
`,
);

// File with wikilinks + entity mentions + no scope (control for backwards compat).
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_facilities.md"),
  `---
name: Facilities tech
type: project
---
Dock 7 contractor work covers locks, cameras, internet.
Sam Ortiz handles the loading ramp. See [[user_sites]] for addresses.

## Thermostat Control
Thermostat-server runs at North Workshop. Separate scope.
`,
);

// File with v2 frontmatter — scope, supersedes, related, status.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_thermostat_resolved.md"),
  `---
name: Thermostat server issue resolved
type: project
scope: [north_workshop]
status: active
supersedes: [project_facilities.md]
related: [user_sites.md]
last_verified_at: 2026-04-20
confidence: authoritative
---
The cloud thermostat-server event was handled last month. No further action.
`,
);

fs.writeFileSync(
  path.join(fixtureMemoryDir, "user_sites.md"),
  `---
name: Sites
type: user
---
Primary: North Workshop (Millbrook). Secondary: South Depot (Harborview).
`,
);

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ms = require(path.resolve("lib/memory-store.js"));

// Deterministic embedder — we only need parity for this suite.
ms.setEmbedFn(async (text) => {
  const vec = new Array(ms.EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[(text.charCodeAt(i) * 17 + i) % ms.EMBED_DIM] += 0.01;
  }
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((v) => v / n);
});

before(async () => {
  await ms.reindex({ force: true });
});

after(() => {
  try {
    ms.closeDb();
  } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("frontmatter v2 parses scope/supersedes/related as arrays", () => {
  const parsed = ms.parseMemoryFile(
    path.join(fixtureMemoryDir, "project_thermostat_resolved.md"),
  );
  assert.deepEqual(parsed.meta.scope, ["north_workshop"]);
  assert.deepEqual(parsed.meta.supersedes, ["project_facilities.md"]);
  assert.deepEqual(parsed.meta.related, ["user_sites.md"]);
  assert.equal(parsed.meta.status, "active");
  assert.equal(parsed.meta.confidence, "authoritative");
});

test("frontmatter coerces scalar scope to single-element array", () => {
  const fp = path.join(fixtureMemoryDir, "tmp_scalar_scope.md");
  fs.writeFileSync(
    fp,
    `---
name: X
scope: north_workshop
---
body`,
  );
  try {
    const parsed = ms.parseMemoryFile(fp);
    assert.deepEqual(parsed.meta.scope, ["north_workshop"]);
  } finally {
    fs.unlinkSync(fp);
  }
});

test("extractWikilinks pulls [[target]] and [[target|display]]", () => {
  const links = ms.extractWikilinks(
    "See [[user_sites]] and [[project_thermostat_resolved|the resolution]]",
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].target, "user_sites.md");
  assert.equal(links[0].display, null);
  assert.equal(links[1].target, "project_thermostat_resolved.md");
  assert.equal(links[1].display, "the resolution");
});

test("entity registry loads from _entities.yaml", () => {
  const reg = ms.loadEntityRegistry({ force: true });
  assert.ok(reg.entities.north_workshop);
  assert.deepEqual(reg.entities.sam_ortiz.scope, ["dock_7"]);
  // alias map is case-insensitive
  assert.equal(reg.aliasMap.get("northside"), "north_workshop");
  assert.equal(reg.aliasMap.get("thermostat-server"), "thermostat_control");
  assert.equal(reg.aliasMap.get("sam ortiz"), "sam_ortiz");
});

test("matchEntitiesInText finds aliases with word boundaries", () => {
  const reg = ms.loadEntityRegistry({ force: true });
  const hits = ms.matchEntitiesInText(
    "Sam Ortiz installed the loading ramp at Dock 7.",
    reg,
  );
  assert.ok(hits.has("sam_ortiz"));
  assert.ok(hits.has("dock_7"));
  assert.ok(!hits.has("north_workshop"));
});

test("matchEntitiesInText does not match inside larger words", () => {
  const reg = ms.loadEntityRegistry({ force: true });
  // "northside" is the North Workshop alias but "northsides" should not match.
  const hits = ms.matchEntitiesInText("Nothing about northsidesque here.", reg);
  assert.ok(!hits.has("north_workshop"));
});

test("expandScopeUniverse includes entity's scope chain", () => {
  const reg = ms.loadEntityRegistry({ force: true });
  const u = ms.expandScopeUniverse(["thermostat_control"], reg);
  assert.ok(u.has("thermostat_control"));
  assert.ok(u.has("north_workshop"));
});

test("reindex populates file_meta with status + scope", () => {
  const row = ms
    .db()
    .prepare("SELECT * FROM file_meta WHERE basename = ?")
    .get("project_thermostat_resolved.md");
  assert.equal(row.status, "active");
  assert.equal(row.confidence, "authoritative");
  assert.equal(row.last_verified_at, "2026-04-20");
  const scope = JSON.parse(row.scope_json);
  assert.deepEqual(scope, ["north_workshop"]);
});

test("reindex populates memory_links from wikilinks + frontmatter", () => {
  const rows = ms
    .db()
    .prepare(
      "SELECT src, dst, link_type, section FROM memory_links WHERE src = ? ORDER BY link_type, dst",
    )
    .all("project_thermostat_resolved.md");
  // fm-related + fm-supersedes (body has no wikilinks in thermostat_resolved).
  const types = rows.map((r) => `${r.link_type}:${r.dst}`);
  assert.ok(types.includes("fm-related:user_sites.md"));
  assert.ok(types.includes("fm-supersedes:project_facilities.md"));

  const bodyLinks = ms
    .db()
    .prepare(
      "SELECT dst, section FROM memory_links WHERE src = ? AND link_type = 'body'",
    )
    .all("project_facilities.md");
  assert.ok(bodyLinks.some((r) => r.dst === "user_sites.md"));
});

test("reindex populates supersession table", () => {
  const rows = ms
    .db()
    .prepare("SELECT * FROM supersession WHERE new_basename = ?")
    .all("project_thermostat_resolved.md");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].old_basename, "project_facilities.md");
});

test("reindex populates chunk_entities with alias mentions", () => {
  // project_facilities.md mentions Dock 7, Sam Ortiz, North Workshop, Thermostat.
  const rows = ms
    .db()
    .prepare(
      `SELECT DISTINCT ce.entity_id
       FROM chunk_entities ce
       JOIN memory_chunks m ON m.id = ce.chunk_id
       WHERE m.file = ?`,
    )
    .all("project_facilities.md");
  const ids = new Set(rows.map((r) => r.entity_id));
  assert.ok(ids.has("dock_7"));
  assert.ok(ids.has("sam_ortiz"));
  assert.ok(ids.has("north_workshop"));
  assert.ok(ids.has("thermostat_control"));
});

test("chunk_entities are per-chunk, not whole-file", () => {
  // The Thermostat Control chunk should have thermostat_control + north_workshop,
  // but not sam_ortiz (which is only in the top Dock 7 chunk).
  const thermoChunk = ms
    .db()
    .prepare(
      "SELECT id FROM memory_chunks WHERE file = ? AND heading = 'Thermostat Control'",
    )
    .get("project_facilities.md");
  assert.ok(thermoChunk, "Thermostat Control chunk should exist");
  const ids = ms
    .db()
    .prepare("SELECT entity_id FROM chunk_entities WHERE chunk_id = ?")
    .all(thermoChunk.id)
    .map((r) => r.entity_id);
  assert.ok(ids.includes("thermostat_control"));
  assert.ok(ids.includes("north_workshop"));
  assert.ok(!ids.includes("sam_ortiz"), "sam_ortiz should not bleed into thermostat chunk");
});

test("entities table mirrors the registry", () => {
  const rows = ms
    .db()
    .prepare("SELECT id, type, scope_json FROM entities ORDER BY id")
    .all();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.sam_ortiz.type, "person");
  assert.deepEqual(JSON.parse(byId.sam_ortiz.scope_json), ["dock_7"]);
});

test("deleted file is removed from file_meta and edges", async () => {
  const target = path.join(fixtureMemoryDir, "ephemeral_fm.md");
  fs.writeFileSync(
    target,
    `---
name: Ephemeral
scope: [dock_7]
related: [user_sites.md]
---
Just a test file.`,
  );
  await ms.reindex();
  let row = ms
    .db()
    .prepare("SELECT basename FROM file_meta WHERE basename = ?")
    .get("ephemeral_fm.md");
  assert.ok(row, "ephemeral file should have file_meta row after reindex");

  fs.unlinkSync(target);
  await ms.reindex();
  row = ms
    .db()
    .prepare("SELECT basename FROM file_meta WHERE basename = ?")
    .get("ephemeral_fm.md");
  assert.equal(row, undefined);
  const links = ms
    .db()
    .prepare("SELECT * FROM memory_links WHERE src = ?")
    .all("ephemeral_fm.md");
  assert.equal(links.length, 0);
});

test("reindex is idempotent for v2 tables", async () => {
  const countLinksBefore = ms
    .db()
    .prepare("SELECT COUNT(*) AS n FROM memory_links")
    .get().n;
  await ms.reindex();
  const countLinksAfter = ms
    .db()
    .prepare("SELECT COUNT(*) AS n FROM memory_links")
    .get().n;
  assert.equal(countLinksAfter, countLinksBefore);
});

// ── Phase 2: backlinks + neighbor expansion ──

test("getForwardLinks / getBacklinks round-trip", () => {
  const forward = ms.getForwardLinks("project_thermostat_resolved.md");
  const targets = forward.map((r) => r.dst);
  assert.ok(targets.includes("user_sites.md"));
  assert.ok(targets.includes("project_facilities.md"));

  const back = ms.getBacklinks("user_sites.md");
  const sources = back.map((r) => r.src);
  assert.ok(sources.includes("project_thermostat_resolved.md"));
  assert.ok(sources.includes("project_facilities.md"));
});

test("neighborsOf includes both out + in directions", () => {
  const neighbors = ms.neighborsOf("user_sites.md");
  const directions = new Set(neighbors.map((n) => n.direction));
  assert.ok(directions.has("in"), "should have incoming links from other files");
});

test("search attaches neighbors metadata to each result", async () => {
  const results = await ms.search("loading ramp contractor dock", {
    mode: "fts",
    log: false,
  });
  assert.ok(results.length > 0);
  const hit = results.find((r) => r.file === "project_facilities.md");
  assert.ok(hit, "expected project_facilities hit");
  assert.ok(Array.isArray(hit.neighbors));
  const neighborNames = hit.neighbors.map((n) => n.basename);
  assert.ok(
    neighborNames.includes("user_sites.md"),
    `expected user_sites as neighbor, got: ${neighborNames.join(", ")}`,
  );
});

test("search --expand adds neighbor files not in original top-K", async () => {
  // Query that strongly hits only one file; expansion should surface neighbors.
  const withExpand = await ms.search("loading ramp contractor dock", {
    mode: "fts",
    limit: 10,
    log: false,
    expand: true,
  });
  const withoutExpand = await ms.search("loading ramp contractor dock", {
    mode: "fts",
    limit: 10,
    log: false,
    expand: false,
  });
  const expandedFiles = new Set(withExpand.map((r) => r.file));
  const originalFiles = new Set(withoutExpand.map((r) => r.file));
  const addedByExpansion = [...expandedFiles].filter((f) => !originalFiles.has(f));
  // Expansion should at minimum bring in user_sites via the body wikilink.
  assert.ok(
    addedByExpansion.includes("user_sites.md"),
    `expected user_sites in expanded set, added: ${addedByExpansion.join(", ") || "(none)"}`,
  );
  const expanded = withExpand.find((r) => r.file === "user_sites.md");
  assert.ok(expanded.expanded_from, "expanded result should carry expanded_from");
});

test("expansion is skipped when expand: false", async () => {
  const results = await ms.search("loading ramp dock", {
    mode: "fts",
    log: false,
    expand: false,
  });
  for (const r of results) {
    assert.equal(r.expanded_from, undefined);
  }
});

// ── Phase 3: scope rerank + supersession drop ──

test("parseQueryEntities resolves aliases and expands scope", () => {
  const reg = ms.loadEntityRegistry({ force: true });
  const { queryEntities, universe } = ms.parseQueryEntities(
    "What's happening with the thermostat-server?",
    reg,
  );
  assert.ok(queryEntities.has("thermostat_control"));
  assert.ok(universe.has("thermostat_control"));
  assert.ok(universe.has("north_workshop"));
});

test("applyScopeRerank boosts chunks whose entities align with query", async () => {
  // Query resolves to thermostat_control (via alias) → scope = [north_workshop].
  // Universe = {thermostat_control, north_workshop}. Any chunk with those entities
  // should carry scope_reason='scope_align'.
  const results = await ms.search("thermostat server status", {
    mode: "hybrid",
    log: false,
    limit: 10,
    expand: false,
    scopeRerank: true,
  });
  const aligned = results.filter((r) => r.scope_reason === "scope_align");
  assert.ok(
    aligned.length > 0,
    `at least one result should be scope-aligned. Got: ${JSON.stringify(
      results.map((r) => ({
        file: r.file,
        heading: r.heading,
        entities: r.chunk_entities,
        reason: r.scope_reason,
      })),
      null,
      2,
    )}`,
  );
  // Every aligned row gets score_mult ≥ 1 (penalty × bonus sandwich still
  // leaves a net boost when status=active).
  for (const r of aligned) {
    assert.ok(r.scope_mult >= 1.0, `aligned row should have scope_mult>=1, got ${r.scope_mult}`);
  }
});

test("scope_conflict penalizes chunks whose entity scope misses query universe", async () => {
  // Query is about North Workshop thermostat. The Dock 7 chunk of
  // project_facilities.md (entities: dock_7, sam_ortiz) should
  // rank BELOW the Thermostat Control chunk (entities: north_workshop, thermostat_control).
  const results = await ms.search("thermostat server north workshop", {
    mode: "hybrid",
    log: false,
    limit: 10,
    expand: false,
  });
  // Find both chunks of project_facilities.md in the results.
  const dockChunk = results.find(
    (r) => r.file === "project_facilities.md" && r.heading === "",
  );
  const thermoChunk = results.find(
    (r) => r.file === "project_facilities.md" && r.heading === "Thermostat Control",
  );
  if (dockChunk && thermoChunk) {
    assert.ok(
      (thermoChunk.final_score ?? thermoChunk.rrf ?? 0) >
        (dockChunk.final_score ?? dockChunk.rrf ?? 0),
      `thermostat chunk should outrank dock 7 chunk for a thermostat query (thermostat=${thermoChunk.final_score}, dock=${dockChunk.final_score})`,
    );
  }
  if (dockChunk) {
    assert.equal(dockChunk.scope_reason, "scope_conflict");
  }
});

test("supersession drop silently hides old when active replacement is in set", async () => {
  // project_thermostat_resolved.md (status=active) supersedes project_facilities.md.
  // When both would normally appear, the old one should be dropped.
  const results = await ms.search("thermostat server", {
    mode: "hybrid",
    log: false,
    limit: 10,
    expand: false,
  });
  const hasResolver = results.some((r) => r.file === "project_thermostat_resolved.md");
  if (hasResolver) {
    const hasOld = results.some((r) => r.file === "project_facilities.md");
    assert.ok(
      !hasOld,
      "project_facilities.md should be dropped when resolver is in the set",
    );
  }
});

test("scopeRerank: false produces neutral scoring (no boost/penalty)", async () => {
  const results = await ms.search("thermostat server north workshop", {
    mode: "hybrid",
    log: false,
    limit: 10,
    expand: false,
    scopeRerank: false,
  });
  for (const r of results) {
    assert.equal(r.scope_mult, 1.0);
  }
});

test("warnings carry non-active status through to the caller", async () => {
  // Make an extra file that's marked resolved to prove warnings fire.
  const target = path.join(fixtureMemoryDir, "project_old_fact.md");
  fs.writeFileSync(
    target,
    `---
name: Old fact
type: project
status: resolved
---
Some ancient fact about the thermostat that no longer applies.`,
  );
  try {
    await ms.reindex();
    const results = await ms.search("ancient fact thermostat", {
      mode: "fts",
      log: false,
      limit: 10,
      expand: false,
    });
    const hit = results.find((r) => r.file === "project_old_fact.md");
    if (hit) {
      assert.ok(
        (hit.warnings || []).some((w) => w.includes("status=resolved")),
        `expected status warning, got: ${JSON.stringify(hit.warnings)}`,
      );
    }
  } finally {
    fs.unlinkSync(target);
    await ms.reindex();
  }
});
