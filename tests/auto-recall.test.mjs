// auto-recall.test.mjs — gate logic + fail-soft/format for the chat auto-recall.
// Run: node --test tests/auto-recall.test.mjs
//
// The gate (shouldAutoRecall) is pure + deterministic. autoRecallBlock's recall
// path is exercised against a fixture wiki DB with chat disabled (no Supabase
// key) and no embeddings (→ wiki FTS degrade), so no network is needed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-recall-test-"));
const fixtureDb = path.join(fixtureDir, "memory-index.db");
fs.mkdirSync(path.join(fixtureDir, "memory"), { recursive: true });
process.env.MEMORY_INDEX_DIR = path.join(fixtureDir, "memory");
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_DB_AUTHORITATIVE = "1";
// Keep the replies source hermetic too: on a live host it otherwise reads the
// real hum-responses.jsonl, and a real reply can match any query.
process.env.UTTERANCE_DATA_DIR = path.join(fixtureDir, "utterances");
// Force chat-recall to no-op (no network) so the test is deterministic.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const { shouldAutoRecall, autoRecallBlock, relevantRows } = await import(
  path.resolve("lib/auto-recall.mjs") + `?t=${Date.now()}`
);

before(() => {
  ws.savePage(
    "user_food_prefs",
    `---\nname: Food taste\ndescription: Restaurant and dining preferences\ntype: user\n---\nThe user loves authentic food and eating out at restaurants; Italian and Mexican favored.\n`,
    { editedBy: "test" },
  );
});
after(() => {
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("gate: trivial messages skip recall", () => {
  for (const t of ["yes", "ok", "👍", "do it", "continue", "/compact", "hi", "no thanks", "   "]) {
    assert.equal(shouldAutoRecall(t), false, `should skip: ${JSON.stringify(t)}`);
  }
});

test("gate: substantive messages trigger recall", () => {
  for (const t of [
    "what did I say about my restaurant preferences?",
    "do it for the conference trip please",
    "remind me where we're staying for the conference",
  ]) {
    assert.equal(shouldAutoRecall(t), true, `should recall: ${JSON.stringify(t)}`);
  }
});

test("autoRecallBlock returns '' for a gated message (no recall attempted)", async () => {
  assert.equal(await autoRecallBlock("ok"), "");
  assert.equal(await autoRecallBlock("👍"), "");
});

test("autoRecallBlock honors the CHAT_AUTORECALL_DISABLED kill switch", async () => {
  process.env.CHAT_AUTORECALL_DISABLED = "1";
  try {
    assert.equal(await autoRecallBlock("what do I like to eat at restaurants?"), "");
  } finally {
    delete process.env.CHAT_AUTORECALL_DISABLED;
  }
});

test("autoRecallBlock builds a <recall> block from wiki hits (chat off, FTS degrade)", async () => {
  // Content-word query so the FTS-only degrade path (no Ollama in tests) matches.
  // In production the query embeds → semantic KNN handles full-sentence queries.
  //
  // `judge: false` skips the Sonnet relevance pass: it forks `claude -p`, which
  // needs the login keychain and several seconds, so the suite exercises the
  // deterministic fallback instead. The model path is verified live against the
  // real corpus, not here.
  //
  // `minBm25: 0` is required, not a shortcut. This fixture corpus holds ONE
  // page, and BM25's IDF term scales with log(N/df) — at N=1 every term has
  // zero IDF and every score collapses to -0.00. The production floor (-12,
  // calibrated against a ~900-page wiki) would therefore reject a hit
  // that is in fact the only and correct answer. This test covers plumbing and
  // formatting; relevance gating is covered by the relevantRows tests below,
  // which don't depend on corpus statistics.
  const block = await autoRecallBlock("restaurant dining preferences favored", { minBm25: 0, judge: false });
  assert.ok(block.startsWith("<recall>"), "starts with the recall tag");
  assert.ok(block.includes("[wiki user_food_prefs]"), "cites the matching wiki page");
  assert.ok(block.trimEnd().endsWith("</recall>"), "closes the recall tag");
});

test("autoRecallBlock returns '' when nothing matches (no hits)", async () => {
  const block = await autoRecallBlock("tell me about quantum chromodynamics and lattice gauge theory", { judge: false });
  assert.equal(block, "", "no wiki/chat hits → empty block");
});

// ─── Relevance gating ─────────────────────────────────────────────────────
//
// Why this exists: `recall` returns its top-k by rank with no relevance floor,
// so it answers for any query. Un-gated, auto-recall prepended loosely-related
// memory to EVERY chat message — measured on a live corpus, a query about
// quantum chromodynamics pulled eight unrelated chat rows about dining.
//
// These are pure over synthetic rows, so unlike the block test above they do
// not depend on corpus statistics.

test("chat rows need a shared distinctive word — cosine cannot do this job", () => {
  // Measured on a live corpus: a nonsense query's best chat hit scored 0.516
  // while a genuine question about a booked appointment scored 0.484.
  // The junk OUTRANKED the real thing, so any similarity threshold is worse
  // than none. Overlap separates cleanly: 0/8 rows survive for an irrelevant
  // query, 1-2/8 for a real message.
  const rows = [
    { source: "chat", score: 0.92, snippet: "we loved the kebab at that corner place last night" },
    { source: "chat", score: 0.88, snippet: "the science museum was closed on Monday" },
  ];
  const kept = relevantRows(rows, "where was that kebab place we went to");
  assert.equal(kept.length, 1, "only the row sharing 'kebab' survives");
  assert.match(kept[0].snippet, /kebab/);
});

test("a high-similarity chat row with no shared word is still dropped", () => {
  const rows = [{ source: "chat", score: 0.97, snippet: "the science museum was closed" }];
  assert.deepEqual(relevantRows(rows, "quantum chromodynamics and lattice gauge theory"), []);
});

test("the message recalling itself is dropped", () => {
  // Auto-recall runs on text that may already be persisted, so the top chat hit
  // is frequently the query verbatim at similarity 1.0 — never useful as
  // "memory", and confusing to read.
  const q = "we stopped for kebab at the corner place for a bit";
  const rows = [{ source: "chat", score: 1.0, snippet: q }];
  assert.deepEqual(relevantRows(rows, q), [], "an exact self-match is not memory");
});

test("wiki rows are floored on BM25, and a missing score is not evidence", () => {
  const rows = [
    { source: "wiki", id: "strong", score: -16.3, snippet: "x" },
    { source: "wiki", id: "weak", score: -7.4, snippet: "x" },
    { source: "wiki", id: "semantic_only", score: null, snippet: "x" },
  ];
  assert.deepEqual(relevantRows(rows, "anything").map((r) => r.id), ["strong"]);
});

test("stopword-only overlap does not qualify a chat row", () => {
  const rows = [{ source: "chat", score: 0.9, snippet: "that would have been about your thing" }];
  assert.deepEqual(relevantRows(rows, "what about that thing you would have wanted"), []);
});
