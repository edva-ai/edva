// wiki-recall-assoc.test.mjs — associative recall wired into searchPagesHybrid
// and associatePages (lib/wiki-embed.mjs + lib/wiki-assoc.mjs).
// Run: node --test tests/wiki-recall-assoc.test.mjs
//
// Replaces wiki-recall-expand.test.mjs (the retired one-hop link expansion).
// The pure graph maths is covered in wiki-assoc.test.mjs; this file is about
// the integration: seeds come from the fused search, the soft gate scores on the real matrix, association-only hits come back as normal
// rows, and the per-call `assoc` override / kill switch behave.
//
// Separate file because tuning constants are read from env at module load:
// association only matters when the flat candidate window is NARROWER than the
// corpus (production: CANDIDATES=60 against ~1,000 pages), so this pins
// WIKI_RECALL_CANDIDATES=3 before importing.
//
// Same isolated-fixture + deterministic-toy-embedder approach as its siblings:
// no Ollama, no network, the live memory-index.db is never touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-assoc-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = path.join(fixtureDir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "1";
process.env.WIKI_RECALL_CANDIDATES = "3";
// Association ships default-OFF until the associative eval has run on the live
// corpus, so this suite turns it ON explicitly — it tests the mechanism.
process.env.WIKI_ASSOC = "sa";
delete process.env.WIKI_EXPAND_LINKS;

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const { embedPendingPages, searchPagesHybrid, associatePages, _closeForTest } = await import(
  path.resolve("lib/wiki-embed.mjs") + `?t=${Date.now()}`
);

// Toy embedder. Each axis is a small synonym group so a page can RESEMBLE a
// query without sharing a word with it (the "tulips" day below) — which is the
// case association exists for. The trailing out-of-band dimension stops a page
// with none of the vocabulary collapsing onto the first axis.
const AXES = [["seedco", "tulips"], ["nursery"], ["seedlings"], ["plotmark"], ["compost"], ["pepper"], ["kitten"]];
function toyEmbed(text) {
  const s = String(text).toLowerCase();
  const v = AXES.map((group) => group.reduce((n, w) => n + s.split(w).length - 1, 0));
  v.push(v.every((x) => x === 0) ? 1 : 0);
  return v;
}

const PAGES = {
  // The strong hit. Links forward to the multi-hop target and to a hub.
  project_seedco: `---
name: Seedco
description: Seedco nursery seedlings catalogue
type: project
---
Seedco nursery seedlings. See [[project_plotmark]] and [[user_alex]] and [[reference_offtopic]].
`,
  // Forward-link target: shares one term via a heading cue, crowded out of the
  // narrow flat window by the fillers.
  project_plotmark: `---
name: Plotmark
description: Plotmark compost holdings
type: project
---
Plotmark compost.

## Nursery holdings
Compost held at plotmark.
`,
  // BACKLINK target: links TO the strong hit and is reachable only backwards.
  // It resembles the query ("tulips" sits on the seedco axis) without sharing
  // a word with it, so FTS cannot find it.
  "day_2026-08-02": `---
name: Sunday, August 2, 2026
description: Lunch and a walk
type: day
---
Talked about tulips over lunch. [[project_seedco]]
`,
  // The next day — reachable only through contiguity from the day above.
  "day_2026-08-03": `---
name: Monday, August 3, 2026
description: Quiet day at home
type: day
---
Quiet day.
`,
  filler_1: `---\nname: F1\ndescription: Seedco nursery seedlings daily\ntype: reference\n---\nSeedco nursery seedlings.\n`,
  filler_2: `---\nname: F2\ndescription: Seedco nursery seedlings weekly\ntype: reference\n---\nSeedco nursery seedlings.\n`,
  filler_3: `---\nname: F3\ndescription: Seedco nursery seedlings monthly\ntype: reference\n---\nSeedco nursery seedlings.\n`,
  // A hub: linked from the top hit AND from many other pages.
  user_alex: `---\nname: Alex\ndescription: Who Alex is\ntype: user\n---\nProfile page.\n`,
  // Off-topic and low-degree, linked from the top hit: the soft gate (not a
  // degree guard) is what keeps it down.
  reference_offtopic: `---\nname: Offtopic\ndescription: Unrelated kitten grooming notes\ntype: reference\n---\nPepper grooming.\n`,
};
for (let i = 0; i < 12; i++) {
  PAGES[`ref_${i}`] = `---\nname: R${i}\ndescription: pepper kitten ${i}\ntype: reference\n---\nPepper. [[user_alex]]\n`;
}

before(async () => {
  for (const [id, raw] of Object.entries(PAGES)) ws.savePage(id, raw, { editedBy: "test" });
  await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
});

after(() => {
  try { _closeForTest(); } catch {}
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const search = (q, opts = {}) => searchPagesHybrid(q, { limit: 10, embedQuery: toyEmbed, ...opts });

test("a forward-linked page the flat search crowded out is recalled through the graph", async () => {
  const rows = await search("seedco nursery");
  const hit = rows.find((r) => r.id === "project_plotmark");
  assert.ok(hit, "the multi-hop target is recalled");
  assert.ok(["linked", "semantic", "both"].includes(hit.matched));
  if (hit.matched === "linked") assert.equal(hit.expanded_from, "project_seedco");
});

test("a BACKLINK is walked: the day that links to the strong hit comes up", async () => {
  const rows = await search("seedco nursery");
  const day = rows.find((r) => r.id === "day_2026-08-02");
  assert.ok(day, "the old forward-only expansion could never reach this page");
  assert.equal(day.matched, "linked");
  assert.equal(day.assoc_via, "backlink");
  assert.equal(day.expanded_from, "project_seedco");
  assert.equal(day.type, "day", "association-only hits are completed into normal rows");
  assert.ok(day.title && day.title.includes("August 2"));
});

test("the hub is not promoted by its edge to the top hit", async () => {
  const rows = await search("seedco nursery");
  const hub = rows.find((r) => r.id === "user_alex");
  const coin = rows.findIndex((r) => r.id === "project_plotmark");
  assert.ok(!hub || hub.matched !== "linked" || rows.indexOf(hub) > coin,
    "a page everything links to ranks below a specific neighbour");
});

test("an off-topic low-degree neighbour is held down by the soft gate", async () => {
  const rows = await search("seedco nursery");
  const off = rows.findIndex((r) => r.id === "reference_offtopic");
  const day = rows.findIndex((r) => r.id === "day_2026-08-02");
  assert.ok(off === -1 || off > day, "the neighbour that resembles the query outranks the one that does not");
});

test("association never displaces what the direct search found", async () => {
  const rows = await search("seedco nursery");
  assert.equal(rows[0].id, "project_seedco", "the strongest direct hit still leads");
  const direct = rows.filter((r) => r.matched !== "linked").map((r) => r.id);
  assert.ok(direct.includes("filler_1"));
});

test("assoc:'off' for one call reproduces the two-list result, and only ADDS when on", async () => {
  const on = (await search("seedco nursery")).map((r) => r.id);
  const off = (await search("seedco nursery", { assoc: "off" })).map((r) => r.id);
  assert.ok(!off.includes("day_2026-08-02"), "the backlinked day is association's contribution");
  assert.ok(on.includes("day_2026-08-02"));
  // Association may reorder direct hits (convergence is a real signal), but it
  // must not push the direct top 5 out of a top-10 the agent reads in full.
  for (const id of off.slice(0, 5)) assert.ok(on.includes(id), `${id} survives with association on`);
});

test("ppr is selectable per call and reaches the same backlinked day", async () => {
  const rows = await search("seedco nursery", { assoc: "ppr" });
  assert.ok(rows.some((r) => r.id === "day_2026-08-02" && r.matched === "linked"));
});

test("a date window drops episodic pages outside it and leaves curated ones alone", async () => {
  const rows = await search("seedco nursery", { after: "2026-09-01" });
  assert.ok(!rows.some((r) => r.id.startsWith("day_")), "no day page before Sept survives");
  assert.ok(rows.some((r) => r.id === "project_seedco"), "a curated page has no date and stays");
  const inWin = await search("seedco nursery", { after: "2026-08-01", before: "2026-08-31" });
  assert.ok(inWin.some((r) => r.id === "day_2026-08-02"));
});

test("with no query vector, association still runs off the lexical seeds", async () => {
  const rows = await searchPagesHybrid("seedco nursery", { limit: 10 });
  assert.ok(rows.every((r) => r.via === "fts"));
  assert.ok(rows.some((r) => r.id === "day_2026-08-02" && r.matched === "linked"),
    "the graph needs no embedding — Ollama being down does not cost association");
});

test("associatePages: 'everything tied to X' from ids alone, with provenance", async () => {
  const out = await associatePages({ ids: ["project_seedco"], limit: 10 });
  assert.deepEqual(out.seeds, ["project_seedco"]);
  const ids = out.results.map((r) => r.id);
  assert.ok(ids.includes("project_plotmark"));
  assert.ok(ids.includes("day_2026-08-02"));
  assert.ok(!ids.includes("project_seedco"), "the seed is not its own association");
  const day = out.results.find((r) => r.id === "day_2026-08-02");
  assert.equal(day.via, "backlink");
  assert.equal(day.from, "project_seedco");
  // Two hops: the day after the backlinked day, by contiguity.
  const next = out.results.find((r) => r.id === "day_2026-08-03");
  assert.ok(next, "contiguity reaches the next day");
  assert.equal(next.hops, 2);
  assert.equal(next.via, "next_day");
});

test("associatePages: type and date scoping, and unknown ids are ignored", async () => {
  const days = await associatePages({ ids: ["project_seedco", "no_such_page"], type: "day" });
  assert.deepEqual(days.seeds, ["project_seedco"]);
  assert.ok(days.results.length && days.results.every((r) => r.type === "day"));
  const none = await associatePages({ ids: ["no_such_page"] });
  assert.deepEqual(none, { seeds: [], results: [] });
});

test("associatePages: a query seeds from search and gates by resemblance", async () => {
  const out = await associatePages({ query: "seedco nursery", embedQuery: toyEmbed, limit: 10 });
  assert.ok(out.seeds.includes("project_seedco"));
  const ids = out.results.map((r) => r.id);
  assert.ok(ids.includes("day_2026-08-02"));
  const day = out.results.find((r) => r.id === "day_2026-08-02");
  assert.ok(day.cosine != null, "the gate's cosine is reported");
});
