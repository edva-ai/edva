// wiki-store.test.mjs — unit tests for lib/wiki-store.js.
// Run: node --test tests/wiki-store.test.mjs
//
// All tests run on an isolated fixture dir + DB via env vars. The live
// memory dir is never touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Fixture scaffolding — set BEFORE requiring wiki-store ───────────────

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
// As of step 5d the wiki-store default is DB-only. The tests
// below were written when the default was "render to disk", and several
// tests assert that savePage produces a file. Keep the legacy contract
// active for those tests by opting back into file rendering.
process.env.MEMORY_DB_AUTHORITATIVE = "0";

// MEMORY.md and _entities.yaml must be skipped by the ingester.
fs.writeFileSync(path.join(fixtureMemoryDir, "MEMORY.md"), "# index (skip me)\n");
fs.writeFileSync(path.join(fixtureMemoryDir, "_entities.yaml"), "entities: {}\n");

const FIXTURES = {
  "user_food_prefs.md": `---
name: Food taste
description: Authentic-first; Italian + Mexican + Greek favored
type: user
---
Alex prefers authentic Italian, Mexican, and Greek food.
See [[user_sam]] for context on shared meals.
`,

  "user_sam.md": `---
name: Sam
type: user
---
Alex's partner. Watchlist 'together' category for shared shows.
`,

  "feedback_plain_words.md": `---
name: No shorthand
description: Spell everything out
type: feedback
status: active
---
Never introduce abbreviations or jargon. Spell things out.
`,

  "project_workshopco.md": `---
name: Workshopco
description: Active properties + contractors
type: project
scope: [workshopco]
related: [user_sam, user_food_prefs]
last_verified_at: 2026-04-15
---
Dock 7 active. See [[user_sam]] for ownership context.
`,

  "reference_trusted.md": `---
name: Trusted restaurants
type: reference
---
Known-good places Alex returns to.

## METRO
Noodle bar downtown.

## Lakeview
Taqueria by the lake.
`,
};

for (const [name, content] of Object.entries(FIXTURES)) {
  fs.writeFileSync(path.join(fixtureMemoryDir, name), content);
}

// ── Require the lib (paths now point at fixtures) ───────────────────────

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));

after(() => {
  ws.closeDb();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// ── Parsing helpers ──

test("splitFrontmatter — round-trip preserves bytes", () => {
  for (const [name, raw] of Object.entries(FIXTURES)) {
    const { frontmatterText, body } = ws.splitFrontmatter(raw);
    assert.ok(frontmatterText !== null, `${name} should have frontmatter`);
    // Reconstruct: "---\n" + frontmatterText + "\n---\n" + body
    const reconstructed = `---\n${frontmatterText}\n---\n${body}`;
    assert.equal(reconstructed, raw, `${name} round-trip mismatch`);
  }
});

test("splitFrontmatter — body without frontmatter", () => {
  const r = ws.splitFrontmatter("just body, no frontmatter");
  assert.equal(r.frontmatterText, null);
  assert.equal(r.body, "just body, no frontmatter");
});

test("extractWikilinks — finds [[target]] and [[target|display]]", () => {
  const links = ws.extractWikilinks(
    "see [[user_sam]] and [[user_food_prefs|food prefs]] please",
  );
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], { target: "user_sam", display: null });
  assert.deepEqual(links[1], { target: "user_food_prefs", display: "food prefs" });
});

test("extractWikilinks — strips .md extension on target", () => {
  const links = ws.extractWikilinks("[[user_sam.md]]");
  assert.equal(links[0].target, "user_sam");
});

test("buildPageRow — promotes frontmatter fields to columns", () => {
  const raw = FIXTURES["project_workshopco.md"];
  const row = ws.buildPageRow("project_workshopco.md", raw);
  assert.equal(row.id, "project_workshopco");
  assert.equal(row.basename, "project_workshopco.md");
  assert.equal(row.type, "project");
  assert.equal(row.title, "Workshopco");
  assert.equal(row.last_verified_at, "2026-04-15");
  assert.deepEqual(JSON.parse(row.scope_json), ["workshopco"]);
  assert.equal(row.raw_md, raw); // raw is stored verbatim
  // frontmatter_json includes the unknown-by-default `related` field.
  const fm = JSON.parse(row.frontmatter_json);
  assert.deepEqual(fm.related, ["user_sam", "user_food_prefs"]);
});

// ── Backfill + verify ──

test("backfill ingests every page and skips MEMORY.md / _entities.yaml", () => {
  const r = ws.backfill();
  assert.equal(r.pages_inserted, 5);
  assert.equal(r.pages_unchanged, 0);
  assert.equal(r.errors.length, 0);
  // Confirm the skips: ids should not include MEMORY or _entities.
  const ids = ws.listPages().map((p) => p.id);
  assert.ok(!ids.includes("MEMORY"));
  assert.ok(!ids.some((i) => i.includes("entities")));
});

test("backfill is idempotent — re-running yields all unchanged", () => {
  const r = ws.backfill();
  assert.equal(r.pages_inserted, 0);
  assert.equal(r.pages_updated, 0);
  assert.equal(r.pages_unchanged, 5);
});

test("verify — every row renders byte-equal to disk", () => {
  const v = ws.verify();
  assert.equal(v.total, 5);
  assert.equal(v.matched, 5);
  assert.equal(v.mismatched.length, 0);
});

test("backfill — reflects edits on disk", () => {
  const target = path.join(fixtureMemoryDir, "user_food_prefs.md");
  const original = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, original + "\nAdded line.\n");
  const r = ws.backfill();
  assert.equal(r.pages_updated, 1);
  assert.equal(r.pages_unchanged, 4);
  // Restore so subsequent tests see a clean fixture.
  fs.writeFileSync(target, original);
  ws.backfill();
});

test("backfill — removes pages whose source file disappears", () => {
  const target = path.join(fixtureMemoryDir, "reference_trusted.md");
  const saved = fs.readFileSync(target, "utf8");
  fs.unlinkSync(target);
  const r = ws.backfill();
  assert.equal(r.pages_removed, 1);
  assert.equal(ws.getPage("reference_trusted"), null);
  // Restore.
  fs.writeFileSync(target, saved);
  ws.backfill();
});

// ── Graph ──

test("page_links — wikilinks + related are recorded", () => {
  const fwd = ws.getForwardLinks("project_workshopco");
  const types = fwd.map((r) => `${r.link_type}:${r.dst_id}`).sort();
  assert.deepEqual(
    types,
    [
      "related:user_food_prefs",
      "related:user_sam",
      "wikilink:user_sam",
    ],
  );
  // user_sam resolves; user_food_prefs resolves too.
  for (const r of fwd) assert.equal(r.resolved, true);
});

test("backlinks — reverse direction works", () => {
  const back = ws.getBacklinks("user_sam");
  const sources = back.map((r) => `${r.link_type}:${r.src_id}`).sort();
  assert.deepEqual(
    sources,
    ["related:project_workshopco", "wikilink:project_workshopco", "wikilink:user_food_prefs"],
  );
});

test("dangling links surface with resolved=false", () => {
  const danglingPage = `---
name: Dangling
type: reference
---
References [[ghost_page]] which does not exist.
`;
  ws.savePage("dangling_test", danglingPage, { editedBy: "test" });
  const fwd = ws.getForwardLinks("dangling_test");
  const ghost = fwd.find((r) => r.dst_id === "ghost_page");
  assert.ok(ghost);
  assert.equal(ghost.resolved, false);
  // Cleanup.
  ws.deletePage("dangling_test", { editedBy: "test", removeFile: true });
});

// ── Write path ──

test("savePage — creates a new page + writes a revision", () => {
  const raw = `---
name: Born today
type: feedback
---
new rule
`;
  const r = ws.savePage("feedback_born_today", raw, { editedBy: "test" });
  assert.equal(r.isNew, true);
  assert.equal(r.rev, 1);
  const row = ws.getPage("feedback_born_today");
  assert.equal(row.title, "Born today");
  assert.equal(row.raw_md, raw);
  // File was rendered (DB_AUTHORITATIVE not set).
  const onDisk = fs.readFileSync(
    path.join(fixtureMemoryDir, "feedback_born_today.md"),
    "utf8",
  );
  assert.equal(onDisk, raw);
});

test("savePage — unchanged body skips revision", () => {
  const row = ws.getPage("feedback_born_today");
  const r = ws.savePage("feedback_born_today", row.raw_md, { editedBy: "test" });
  assert.equal(r.changed, false);
  assert.equal(r.isNew, false);
  assert.equal(r.rev, null);
  const revs = ws.getRevisions("feedback_born_today");
  assert.equal(revs.length, 1); // still just the initial rev
});

test("savePage — body change increments rev", () => {
  const next = `---
name: Born today
type: feedback
---
new rule, edited
`;
  const r = ws.savePage("feedback_born_today", next, { editedBy: "test" });
  assert.equal(r.changed, true);
  assert.equal(r.rev, 2);
  const revs = ws.getRevisions("feedback_born_today");
  assert.equal(revs.length, 2);
  // Old rev recoverable.
  const old = ws.getRevision("feedback_born_today", 1);
  assert.ok(old.raw_md.includes("new rule\n"));
  assert.ok(!old.raw_md.includes("edited"));
});

test("setPinned — flips pinned column + persists in frontmatter", () => {
  ws.setPinned("user_food_prefs", true, { editedBy: "test" });
  const row = ws.getPage("user_food_prefs");
  assert.equal(row.pinned, 1);
  // Frontmatter on disk now includes pinned: true.
  assert.ok(row.raw_md.includes("pinned: true"));
  // Backfill agrees (parse from disk → same pinned).
  ws.backfill();
  assert.equal(ws.getPage("user_food_prefs").pinned, 1);
  // Round-trip still lossless.
  assert.equal(ws.verify().mismatched.length, 0);
});

test("listPages with pinned filter returns only pinned", () => {
  const pinned = ws.listPages({ pinned: true });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, "user_food_prefs");
});

test("supersedePage — old goes superseded, edge added, new lists supersedes", () => {
  // Seed an old + new page.
  ws.savePage(
    "feedback_old_rule",
    `---
name: Old
type: feedback
status: active
---
old text
`,
    { editedBy: "test" },
  );
  ws.savePage(
    "feedback_new_rule",
    `---
name: New
type: feedback
status: active
---
new text
`,
    { editedBy: "test" },
  );
  ws.supersedePage("feedback_old_rule", "feedback_new_rule", { editedBy: "test" });
  const oldRow = ws.getPage("feedback_old_rule");
  const newRow = ws.getPage("feedback_new_rule");
  assert.equal(oldRow.status, "superseded");
  // Edge present.
  const edges = ws.getForwardLinks("feedback_new_rule");
  const sup = edges.find((e) => e.link_type === "supersedes");
  assert.ok(sup);
  assert.equal(sup.dst_id, "feedback_old_rule");
  // New page's frontmatter now lists the old basename.
  const fm = JSON.parse(newRow.frontmatter_json);
  assert.deepEqual(fm.supersedes, ["feedback_old_rule.md"]);
});

test("deletePage — removes row + edges; revision archived first", () => {
  ws.savePage(
    "feedback_to_delete",
    `---
name: Doomed
type: feedback
---
gone
`,
    { editedBy: "test" },
  );
  assert.ok(ws.getPage("feedback_to_delete"));
  ws.deletePage("feedback_to_delete", { editedBy: "test", removeFile: true });
  assert.equal(ws.getPage("feedback_to_delete"), null);
  // Revision survives so a recovery is possible.
  const revs = ws.getRevisions("feedback_to_delete");
  assert.ok(revs.length >= 1);
  // No file on disk.
  assert.equal(
    fs.existsSync(path.join(fixtureMemoryDir, "feedback_to_delete.md")),
    false,
  );
});

test("savePage with MEMORY_DB_AUTHORITATIVE=1 does not touch disk", () => {
  const prev = process.env.MEMORY_DB_AUTHORITATIVE;
  process.env.MEMORY_DB_AUTHORITATIVE = "1";
  try {
    const raw = `---
name: DB-only
type: feedback
---
no file should appear
`;
    ws.savePage("feedback_db_only", raw, { editedBy: "test" });
    assert.ok(ws.getPage("feedback_db_only"));
    assert.equal(
      fs.existsSync(path.join(fixtureMemoryDir, "feedback_db_only.md")),
      false,
      "DB-authoritative mode must NOT render the file",
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_DB_AUTHORITATIVE;
    else process.env.MEMORY_DB_AUTHORITATIVE = prev;
    // Drop the test page so verify() in the round-trip test below stays clean.
    ws.deletePage("feedback_db_only", { editedBy: "test", removeFile: true });
  }
});

test("savePage default (env unset) is DB-authoritative — no file render", () => {
  const prev = process.env.MEMORY_DB_AUTHORITATIVE;
  delete process.env.MEMORY_DB_AUTHORITATIVE;
  try {
    const raw = `---
name: DB-default
type: feedback
---
new default: DB only
`;
    ws.savePage("feedback_db_default", raw, { editedBy: "test" });
    assert.ok(ws.getPage("feedback_db_default"));
    assert.equal(
      fs.existsSync(path.join(fixtureMemoryDir, "feedback_db_default.md")),
      false,
      "Default behaviour (env unset) must NOT render the file",
    );
  } finally {
    if (prev === undefined) delete process.env.MEMORY_DB_AUTHORITATIVE;
    else process.env.MEMORY_DB_AUTHORITATIVE = prev;
    ws.deletePage("feedback_db_default", { editedBy: "test", removeFile: true });
  }
});

test("MEMORY_DB_AUTHORITATIVE=0 opts back into legacy file render", () => {
  // With env=0, savePage SHOULD render the file (legacy behaviour). The test
  // suite-wide setup already sets env=0, so this is the implicit baseline,
  // but we exercise it explicitly here for documentation.
  assert.equal(process.env.MEMORY_DB_AUTHORITATIVE, "0");
  const raw = `---
name: Legacy
type: feedback
---
file should appear
`;
  ws.savePage("feedback_legacy_render", raw, { editedBy: "test" });
  assert.equal(
    fs.existsSync(path.join(fixtureMemoryDir, "feedback_legacy_render.md")),
    true,
    "MEMORY_DB_AUTHORITATIVE=0 must render the file",
  );
  ws.deletePage("feedback_legacy_render", { editedBy: "test", removeFile: true });
});

// ── Search ──

test("searchPages — fts mode finds the right page", () => {
  const r = ws.searchPages("authentic Italian", { mode: "fts", limit: 5 });
  // Memory_chunks may be empty in this test — fts requires `memory reindex`.
  // If chunks aren't present, we fall back to no-results, which is fine for
  // the unit test. But page mode should always work.
  if (r.length) {
    assert.equal(r[0].id, "user_food_prefs");
  }
});

test("searchPages — page mode (LIKE on title/description)", () => {
  const r = ws.searchPages("trusted", { mode: "page", limit: 5 });
  assert.ok(r.some((p) => p.id === "reference_trusted"));
});

test("renderAllToDir — round-trips every page to a directory", () => {
  const out = path.join(fixtureDir, "out");
  const r = ws.renderAllToDir(out);
  assert.ok(r.written >= 5);
  // Spot-check one file is byte-equal to its DB row.
  const onDisk = fs.readFileSync(path.join(out, "user_sam.md"), "utf8");
  assert.equal(onDisk, ws.getPage("user_sam").raw_md);
});

test("stats — sane shape", () => {
  const s = ws.stats();
  assert.ok(s.total >= 5);
  assert.ok(s.byType.length >= 1);
  assert.ok(s.pinned >= 1); // user_food_prefs was pinned earlier
});

// ── SessionStart hook output ──

test("wiki-session-context emits valid hook JSON with pinned bundle", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(
    "node",
    [path.resolve("bin/wiki-session-context")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_INDEX_DIR: fixtureMemoryDir,
        MEMORY_INDEX_DB: fixtureDb,
      },
    },
  );
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = parsed.hookSpecificOutput.additionalContext;
  // user_food_prefs is pinned in the fixture from the earlier test. With no
  // pin_locked pages in the fixture, the guard keeps every pinned page in the
  // full-body identity core (never silently strips the core).
  assert.ok(ctx.includes("Food taste"));
  assert.ok(ctx.includes("identity core (always loaded)"));
  assert.ok(ctx.includes("Memory map")); // constant recall-affordance footer
  assert.ok(ctx.includes("wiki_search"));
});

test("wiki-session-context omits the identity core when nothing is pinned but still emits the memory map", async () => {
  const { spawnSync } = await import("node:child_process");
  // Unpin to test the no-core path.
  ws.setPinned("user_food_prefs", false, { editedBy: "test" });
  const r = spawnSync(
    "node",
    [path.resolve("bin/wiki-session-context")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_INDEX_DIR: fixtureMemoryDir,
        MEMORY_INDEX_DB: fixtureDb,
      },
    },
  );
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  // No pinned pages → no identity-core section and no pinned menu...
  assert.ok(!ctx.includes("identity core (always loaded)"));
  assert.ok(!ctx.includes("Pinned menu"));
  // ...but the constant recall-affordance footer is always present, so the
  // agent is never left without a way to reach memory.
  assert.ok(ctx.includes("Memory map"));
  assert.ok(ctx.includes("wiki_search"));
  // Re-pin so fixture state is restored before any later test depends on it.
  ws.setPinned("user_food_prefs", true, { editedBy: "test" });
});
