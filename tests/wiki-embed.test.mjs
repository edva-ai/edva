// wiki-embed.test.mjs — unit tests for lib/wiki-embed.mjs.
// Run: node --test tests/wiki-embed.test.mjs
//
// Runs on an isolated fixture DB via env vars — the live memory-index.db is
// never touched. Ollama is not required: embeddings are produced by a
// deterministic toy embedder (bag-of-words over a small vocabulary) so cosine
// similarity is meaningful and the fusion/freshness/degrade plumbing is
// exercised without a network dependency (same approach event-fts uses).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Fixture scaffolding — set BEFORE importing the modules ──────────────
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-embed-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_DB_AUTHORITATIVE = "1"; // DB-only; no file render needed here

// Dynamic imports so the env above is in effect when each module reads its
// DB_PATH const at load time.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const embedMod = await import(
  path.resolve("lib/wiki-embed.mjs") + `?t=${Date.now()}`
);
const {
  embedPendingPages,
  searchPagesHybrid,
  embeddingStats,
  cuesForPage,
  generateTriggerCues,
  validateTriggers,
  _closeForTest,
} = embedMod;

// Deterministic toy embedder: count vocab-word occurrences → vector. Gives
// real cosine structure (a "dining" query lands near a "restaurant/food"
// page) without needing Ollama.
const VOCAB = [
  "food", "restaurant", "dining", "eat",
  "sam", "coach",
  "chessco", "project", "club",
  "pepper", "cat", "feed",
];
function toyEmbed(text) {
  const t = String(text).toLowerCase();
  const v = VOCAB.map(
    (w) => (t.match(new RegExp(`\\b${w}\\b`, "g")) || []).length,
  );
  if (v.every((x) => x === 0)) v[0] = 0.001; // keep cosine defined
  return v;
}

const PAGES = {
  user_food_prefs: `---
name: Food taste
description: Authentic-first restaurant and dining preferences
type: user
---
Alex loves authentic food. Favorite restaurant styles are Italian and Mexican. They like to eat out often.
`,
  user_sam: `---
name: Sam
description: Alex's coach
type: user
---
Sam is Alex's climbing coach. They train and share meals together.
`,
  project_chessco: `---
name: Chessco
description: Chess club project
type: project
---
Chessco is a club project organising weekly games.
`,
  reference_pepper_feeding: `---
name: Pepper feeding
description: Cat feeding routine
type: reference
---
Pepper is the cat. Morning and evening feed routine around the house.
`,
};

before(() => {
  for (const [id, raw] of Object.entries(PAGES)) {
    ws.savePage(id, raw, { editedBy: "test" });
  }
});

after(() => {
  try { _closeForTest(); } catch {}
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("embedPendingPages embeds all active pages, then is idempotent", async () => {
  const first = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(first.embedded, 4, "all four seeded pages embedded");
  assert.equal(first.remaining, 0, "nothing pending after first pass");

  const second = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(second.embedded, 0, "re-run embeds nothing (idempotent)");
  assert.equal(second.remaining, 0);

  const s = embeddingStats();
  assert.equal(s.available, true);
  assert.equal(s.embedded, 4);
  assert.equal(s.pending, 0);
});

test("editing a page's body marks only that page for re-embedding", async () => {
  ws.savePage(
    "user_food_prefs",
    `---
name: Food taste
description: Authentic-first restaurant and dining preferences
type: user
---
Updated: Alex now also loves tapas and dining at wine bars.
`,
    { editedBy: "test" },
  );
  const stat = embeddingStats();
  assert.equal(stat.pending, 1, "exactly the edited page is pending");

  const res = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(res.embedded, 1, "only the changed page re-embedded");
  assert.equal(res.remaining, 0);
});

test("searchPagesHybrid returns hybrid-tagged rows and finds the relevant page", async () => {
  const rows = await searchPagesHybrid("where does he like dining and restaurants", {
    limit: 5,
    embedQuery: toyEmbed,
  });
  assert.ok(rows.length > 0, "hybrid returns results");
  assert.equal(rows[0].via, "hybrid", "rows tagged via=hybrid when embeddings present");
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("user_food_prefs"), "the food/dining page is recalled");
});

test("searchPagesHybrid degrades to pure FTS when no embedQuery is given", async () => {
  const rows = await searchPagesHybrid("restaurant dining", { limit: 5 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.via === "fts"), "no embedQuery → via=fts");
});

test("type filter is honored in hybrid search", async () => {
  const rows = await searchPagesHybrid("project club notes", {
    limit: 5,
    type: "project",
    embedQuery: toyEmbed,
  });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.type === "project"), "only project pages returned");
});

test("deleting a page prunes its orphaned embedding", async () => {
  const before = embeddingStats().embedded;
  ws.deletePage("reference_pepper_feeding");
  // pruneOrphans runs inside embedPendingPages.
  const res = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.ok(res.pruned >= 1, "orphaned embedding pruned");
  const after = embeddingStats().embedded;
  assert.equal(after, before - 1, "embedded count drops by exactly one");
});

test("a page too long for the model is salvaged via a truncated retry", async () => {
  // Mirrors a real host failure: nomic-embed-text 500s on long day pages.
  ws.savePage(
    "reference_long_note",
    `---\nname: Long note\ndescription: A very long reference\ntype: reference\n---\n${"food ".repeat(2000)}\n`,
    { editedBy: "test" },
  );
  // Reject anything longer than the overflow-retry head; accept the short retry.
  const pickyEmbed = (text) => {
    if (String(text).length > 1500) {
      throw new Error("ollama embeddings 500: input length exceeds the context length");
    }
    return toyEmbed(text);
  };
  const res = await embedPendingPages({ embedFn: pickyEmbed, limit: 100 });
  assert.ok(res.embedded >= 1, "the long page was embedded via the truncated retry");
  assert.equal(embeddingStats().pending, 0, "nothing left pending — no page dropped");
});

test("a per-page error does not abort the whole batch (only Ollama-down bails)", async () => {
  // A brand-new page that always errors with a NON-connection error.
  ws.savePage(
    "reference_poison",
    `---\nname: Poison\ndescription: always fails to embed\ntype: reference\n---\nPOISON marker body.\n`,
    { editedBy: "test" },
  );
  // ...and a good page that must still get embedded despite the poison page.
  ws.savePage(
    "reference_good_after",
    `---\nname: Good after\ndescription: should embed fine\ntype: reference\n---\nA normal page about the cat and feeding.\n`,
    { editedBy: "test" },
  );
  const poisonEmbed = (text) => {
    if (String(text).includes("POISON")) throw new Error("malformed page: cannot embed");
    return toyEmbed(text);
  };
  const res = await embedPendingPages({ embedFn: poisonEmbed, limit: 100 });
  assert.ok(res.embedded >= 1, "good pages still embedded past the poison page");
  assert.ok(res.errors.some((e) => e.includes("reference_poison")), "poison page recorded as an error");
  // Only the poison page remains pending — the batch did not bail.
  assert.equal(embeddingStats().pending, 1, "exactly the un-embeddable page stays pending");
});

// ── Cue anchors ───────────────────────────────────────────────────────────

test("cuesForPage extracts the description then the section headings", () => {
  const cues = cuesForPage({
    id: "x",
    title: "X",
    description: "The one-line abstraction",
    body_md: "intro\n\n## First section\ntext\n\n### Nested bit\nmore\n\n# Title restated\n",
  });
  assert.deepEqual(
    cues.map((c) => [c.kind, c.cue_text]),
    [
      ["description", "The one-line abstraction"],
      // Headings carry the page title, so a 2-word heading cannot win a query
      // on its own — see the qualifier note in cuesForPage.
      ["heading", "X — First section"],
      ["heading", "X — Nested bit"],
    ],
    "description first, then title-qualified h2-h4; h1 skipped as a restatement",
  );
});

test("cuesForPage dedupes, caps, and always returns at least one cue", () => {
  const dupes = cuesForPage({
    id: "x",
    title: "T",
    description: "Same text",
    body_md: "## Same text\n## SAME TEXT\n## Real one\n",
  });
  assert.deepEqual(
    dupes.map((c) => c.cue_text),
    ["Same text", "T — Real one"],
    "dedupe compares the UNQUALIFIED heading, so the title prefix cannot smuggle a restatement of the description back in",
  );

  const many = cuesForPage({
    id: "x",
    title: "T",
    description: "d",
    body_md: Array.from({ length: 40 }, (_, i) => `## Heading ${i}`).join("\n"),
  });
  assert.equal(many.length, 20, "capped at MAX_CUES_PER_PAGE");

  // The freshness marker contract: a page with nothing extractable must still
  // produce a row, or it would be reconsidered on every pass forever.
  const bare = cuesForPage({ id: "only_an_id", title: "", description: "", body_md: "" });
  assert.equal(bare.length, 1, "bare page still yields a marker cue");
  assert.equal(bare[0].cue_text, "only_an_id");
});

test("day-page headings reduce to the venue, not the timestamp", () => {
  // Verbatim heading shapes emitted by daily-summary-build.
  const cues = cuesForPage({
    id: "day_2030-03-03",
    type: "day",
    title: "Sunday, March 3, 2030",
    description: "Fixed a bug; noodles for lunch",
    body_md: [
      "### 08:00-09:20 · **the reading room** · 1h 20m",
      "### 09:30-10:15 · unlabeled · 45 min · with [[user_sam|Sam]]",
      "### 10:20-10:30 · **Mostly walked around** · 10 min",
      "### 12:30-13:15 · **Maple (noodle restaurant)** · 45 min · with [[user_sam|Sam]]",
      "### 19:00-19:30 · **Corner pizza shop** · 30 min",
      "### 11:00-11:10 · ~Bar Example? · unconfirmed",
      "## Day's other anchors",
    ].join("\n"),
  });
  const texts = cues.map((c) => c.cue_text);

  // The date qualifier is deliberately absent: on a day page it is the same
  // string for every cue AND across every day page, which is the exact
  // promiscuity the qualifier exists to prevent.
  assert.ok(
    !texts.some((t) => t.includes("March 3, 2030") && t.includes("·")),
    "no timestamped, date-prefixed cues",
  );
  assert.ok(texts.includes("the reading room"), "venue kept, time/duration stripped");
  assert.ok(texts.includes("Maple (noodle restaurant)"), "companion field stripped");
  assert.ok(
    texts.includes("Corner pizza shop"),
    "an evening stop survives — the old cap of 8 truncated exactly these",
  );
  assert.ok(texts.includes("Bar Example"), "emphasis and the unconfirmed marker stripped");
  assert.ok(!texts.includes("unlabeled"), "unnameable stop dropped");
  assert.ok(!texts.some((t) => /walked around/i.test(t)), "walking placeholder dropped");
  assert.ok(!texts.some((t) => /other anchors/i.test(t)), "structural section heading dropped");
});

test("the backfill passes page type through, so day pages get stop cues", async () => {
  // Regression: cuesForPage's own test hands it a row with type set, so it
  // passed while the BACKFILL's SELECT omitted p.type entirely — cuesForPage
  // saw type=undefined, no day page ever took the episodic branch, and the
  // whole day-cue fix was inert in production. Test the path, not the function.
  ws.savePage(
    "day_2030-03-03",
    `---\nname: Sunday, March 3, 2030\ndescription: A day out\ntype: day\n---\n` +
      `### 08:00-09:20 · **the reading room** · 1h 20m\n` +
      `### 19:00-19:30 · **Corner pizza shop** · 30 min\n`,
    { editedBy: "test" },
  );
  await embedPendingPages({ embedFn: toyEmbed, limit: 100 });

  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(fixtureDb, { readOnly: true });
  const cues = raw
    .prepare("SELECT cue_text FROM page_cues WHERE page_id = 'day_2030-03-03' ORDER BY cue_idx")
    .all()
    .map((r) => r.cue_text);
  raw.close();

  assert.ok(
    cues.includes("Corner pizza shop"),
    `stop cue stored unqualified; got ${JSON.stringify(cues)}`,
  );
  assert.ok(
    !cues.some((c) => c.includes("March 3, 2030 —")),
    "no date-qualified cues on an episodic page",
  );
});

test("cues are written, counted, and re-cued only when the body changes", async () => {
  await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  const s = embeddingStats();
  assert.ok(s.cues > 0, "cues exist after a backfill");
  assert.equal(s.cued_pages, s.embedded, "every embedded page got at least one cue");
  assert.ok(s.cues_by_kind.description > 0, "description cues recorded by kind");

  // Idempotent: a second pass re-cues nothing.
  const again = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(again.cued, 0, "no re-cue when nothing changed");

  ws.savePage(
    "user_sam",
    `---\nname: Sam\ndescription: Alex's coach\ntype: user\n---\nSam is Alex's climbing coach.\n\n## Training plan\nThey train together.\n`,
    { editedBy: "test" },
  );
  const after = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(after.cued, 1, "exactly the edited page is re-cued");
});

test("a page is recalled through a cue its whole-page vector would have missed", async () => {
  // The whole-page vector is diluted across three subjects; the query is about
  // one of them. This is the case cue anchors exist for.
  ws.savePage(
    "user_multi",
    `---\nname: Multi\ndescription: A person with several unrelated facets\ntype: user\n---\n` +
      `${"project chessco club notes ".repeat(40)}\n\n## Pepper cat feed\nShort note.\n`,
    { editedBy: "test" },
  );
  await embedPendingPages({ embedFn: toyEmbed, limit: 100 });

  const rows = await searchPagesHybrid("pepper cat feed", { limit: 5, embedQuery: toyEmbed });
  const hit = rows.find((r) => r.id === "user_multi");
  assert.ok(hit, "the diluted page is recalled");
  assert.equal(hit.cue_kind, "heading", "it was found through the heading cue");
  assert.equal(hit.cue, "Multi — Pepper cat feed", "title-qualified heading cue");
});

test("a cue-only hit falls back to showing the cue as its snippet", async () => {
  // "feline" is absent from the page. Pinned to match:"and" so the lexical half
  // genuinely returns nothing — under the "auto" default the OR top-up now
  // finds it, which is the adaptive-match fix working, and would make this test
  // silently stop exercising the fallback it is named for.
  const rows = await searchPagesHybrid("pepper cat feed feline", {
    limit: 5,
    embedQuery: toyEmbed,
    match: "and",
  });
  const hit = rows.find((r) => r.id === "user_multi");
  assert.ok(hit, "recalled semantically despite the unmatched term");
  assert.equal(hit.matched, "semantic", "no lexical half for this page");
  assert.ok(hit.snippet.includes("Pepper cat feed"), "the cue stands in as the matched span");
});

test("score stays BM25-only and cosine stays 0..1 across cue hits", async () => {
  const rows = await searchPagesHybrid("pepper cat feed", { limit: 8, embedQuery: toyEmbed });
  for (const r of rows) {
    if (r.score != null) {
      assert.ok(r.score <= 0, `BM25 score must be negative, got ${r.score} for ${r.id}`);
    }
    if (r.cosine != null) {
      assert.ok(r.cosine >= -1 && r.cosine <= 1, `cosine out of range for ${r.id}`);
    }
  }
});

// ── Trigger cues (the generated tier) ─────────────────────────────────────

const T = (cue, evidence) => ({ cue, evidence });
const json = (cues) => JSON.stringify({ cues });
const ROW = {
  id: "user_food",
  type: "user",
  title: "Food",
  description: "What Alex eats",
  body_md: "Alex avoids cilantro and loves Margherita pizza.",
};

test("generateTriggerCues climbs to the second rung only on validation failure", async () => {
  let localCalls = 0;
  let escalations = 0;

  // Rung 1 returns grounded triggers → rung 2 must never run.
  const good = await generateTriggerCues(ROW, {
    chatFn: async () => {
      localCalls++;
      return json([T("booking a restaurant for dinner", "avoids cilantro"),
        T("ordering takeout on a lazy night", "loves Margherita pizza")]);
    },
    escalateFn: async () => { escalations++; return "{}"; },
  });
  assert.equal(localCalls, 1);
  assert.equal(escalations, 0, "a passing local rung must not escalate");
  assert.deepEqual(good.map((c) => c.kind), ["trigger", "trigger"]);
  assert.equal(good[0].cue_text, "booking a restaurant for dinner");

  // Rung 1 returns unusable output → rung 2 runs and its answer is used.
  const climbed = await generateTriggerCues(ROW, {
    chatFn: async () => "I'm sorry, I can't help with that.",
    escalateFn: async () =>
      "```json\n" + json([T("a", "avoids cilantro"), T("hosting friends at home", "avoids cilantro"),
        T("picking a place for a birthday lunch", "Margherita pizza")]) + "\n```",
  });
  assert.deepEqual(
    climbed.map((c) => c.cue_text),
    ["hosting friends at home", "picking a place for a birthday lunch"],
    "fenced JSON is parsed; the sub-3-char cue is dropped",
  );

  // Both rungs unusable → no cues, and no throw.
  const none = await generateTriggerCues(ROW, {
    chatFn: async () => "nope",
    escalateFn: async () => { throw new Error("fork failed"); },
  });
  assert.deepEqual(none, []);
});

test("an invented trigger has nothing to quote, and a reply of them climbs the ladder", async () => {
  // The failure that kept the generated tier off: well-formed,
  // simply false. The evidence quote is what catches it now.
  const out = await generateTriggerCues(ROW, {
    chatFn: async () =>
      json([T("checking flights between two cities", "overlapping flights between two airports"),
        T("planning a ski trip", "he loves skiing in winter")]),
    escalateFn: async () =>
      json([T("choosing where to eat with friends", "avoids cilantro"),
        T("ordering food for a movie night", "Margherita pizza")]),
  });
  assert.deepEqual(out.map((c) => c.cue_text),
    ["choosing where to eat with friends", "ordering food for a movie night"]);
  assert.match(validateTriggers({ cues: [T("x trip", "nothing like this on the page")] }, ROW.body_md), /usable/);
});

test("a question-shaped trigger is rejected, not indexed", async () => {
  // Verbatim shape from a gemma3:1b sample: query-shaped strings
  // match any question about anything.
  const out = await generateTriggerCues(ROW, {
    chatFn: async () =>
      json([T("What is the main focus of the page?", "avoids cilantro"),
        T("What does he eat?", "Margherita pizza")]),
    escalateFn: async () =>
      json([T("booking a restaurant for dinner", "avoids cilantro"),
        T("ordering takeout on a lazy night", "Margherita pizza")]),
  });
  assert.deepEqual(out.map((c) => c.cue_text),
    ["booking a restaurant for dinner", "ordering takeout on a lazy night"]);
});

test("a mostly-good reply keeps its good triggers and drops the ungrounded one", async () => {
  const out = await generateTriggerCues(ROW, {
    chatFn: async () =>
      json([T("booking a restaurant for dinner", "avoids cilantro"),
        T("ordering takeout on a lazy night", "Margherita   \npizza"),
        T("buying him a watch", "he collects watches")]),
  });
  assert.deepEqual(out.map((c) => c.cue_text),
    ["booking a restaurant for dinner", "ordering takeout on a lazy night"],
    "whitespace in the quote is forgiven; an unquotable trigger is not");
});

test("trigger cues do not duplicate the structural cues they are given", async () => {
  const out = await generateTriggerCues(ROW, {
    chatFn: async () =>
      json([T("What Alex eats", "avoids cilantro"), T("WHAT ALEX EATS", "avoids cilantro"),
        T("booking a restaurant for dinner", "avoids cilantro")]),
    existing: ["What Alex eats"],
  });
  assert.deepEqual(out.map((c) => c.cue_text), ["booking a restaurant for dinner"]);
});

test("turning triggers on re-selects curated pages that are already structurally cued", async () => {
  // The freshness predicate must widen, or enabling the tier over an
  // already-cued corpus would select nothing and silently no-op.
  await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.equal(embeddingStats().pending, 0, "nothing pending without triggers");

  // A writer that quotes whatever page it is handed, so every page validates.
  const quoting = async (prompt) => {
    const body = prompt.slice(prompt.indexOf("BODY:") + 6).trim();
    const words = body.split(" ").filter(Boolean);
    const q = words.slice(0, 4).join(" ");
    return json([T("a generated entry point", q), T("another generated one", q)]);
  };
  let sonnet = 0;
  const res = await embedPendingPages({
    embedFn: toyEmbed,
    limit: 100,
    triggers: true,
    triggerChatFn: quoting,
    triggerEscalateFn: async (p) => { sonnet++; return quoting(p); },
  });
  assert.ok(res.triggered > 0, "pages were re-cued with triggers");
  assert.ok(embeddingStats().cues_by_kind.trigger > 0, "trigger rows written");

  // ...and it converges: a second pass has nothing left to do, including for
  // types that never get triggers (they must not be re-selected forever).
  const again = await embedPendingPages({
    embedFn: toyEmbed,
    limit: 100,
    triggers: true,
    triggerChatFn: quoting,
  });
  assert.equal(again.triggered, 0, "idempotent — no perpetual re-cue loop");
  assert.equal(again.cued, 0, "nothing re-cued on the second pass");
  assert.equal(sonnet, res.sonnet_calls, "every Sonnet call is counted against the cap");
});

test("the Sonnet cap counts successful escalations too", async () => {
  ws.savePage("user_cap_a", "---\nname: Cap A\ndescription: cap test a\ntype: user\n---\nAlpha bravo charlie delta.\n", { editedBy: "test" });
  ws.savePage("user_cap_b", "---\nname: Cap B\ndescription: cap test b\ntype: user\n---\nEcho foxtrot golf hotel.\n", { editedBy: "test" });
  const quoting = async (prompt) => {
    const body = prompt.slice(prompt.indexOf("BODY:") + 6).trim();
    const q = body.split(" ").slice(0, 3).join(" ");
    return json([T("situation one here", q), T("situation two here", q)]);
  };
  process.env.WIKI_TRIGGER_ESCALATION_CAP = "1";
  const mod = await import(path.resolve("lib/wiki-embed.mjs") + `?cap=${Date.now()}`);
  let sonnet = 0;
  const res = await mod.embedPendingPages({
    embedFn: toyEmbed,
    limit: 100,
    triggers: true,
    triggerChatFn: async () => "not json", // local always fails → every page wants Sonnet
    triggerEscalateFn: async (p) => { sonnet++; return quoting(p); },
  });
  delete process.env.WIKI_TRIGGER_ESCALATION_CAP;
  assert.equal(sonnet, 1, "the cap of 1 held even though the first escalation succeeded");
  assert.equal(res.sonnet_calls, 1);
  try { mod._closeForTest(); } catch {}
});

test("deleting a page prunes its orphaned cues too", async () => {
  const before = embeddingStats().cues;
  ws.deletePage("user_multi");
  const res = await embedPendingPages({ embedFn: toyEmbed, limit: 100 });
  assert.ok(res.pruned >= 1, "orphaned rows pruned");
  assert.ok(embeddingStats().cues < before, "cue count drops for the deleted page");
});
