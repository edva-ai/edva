// unified-recall.test.mjs — tests for chat-recall fail-soft + unified fusion.
// Run: node --test tests/unified-recall.test.mjs
//
// Network sources (chat = Supabase RPC, Ollama embeddings) are NOT exercised —
// those are integration-verified on a live host. Here we pin the two deterministic
// contracts: (1) chat-recall never throws when its backend is unreachable, and
// (2) unified-recall fuses + tags a reachable source correctly (wiki-only on a
// fixture DB, which degrades to pure FTS with no Ollama).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-recall-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });
process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_DB_AUTHORITATIVE = "1";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));

// Seed a few wiki pages so the wiki source has something to return.
before(() => {
  const mk = (id, type, desc, body) =>
    ws.savePage(id, `---\nname: ${id}\ndescription: ${desc}\ntype: ${type}\n---\n${body}\n`, { editedBy: "test" });
  mk("user_food_prefs", "user", "Restaurant and dining preferences", "Alex loves authentic food and eating out at restaurants.");
  mk("user_sam", "user", "Alex's partner", "Sam is Alex's partner.");
  mk("project_appco", "project", "Mobile app startup", "Appco is a mobile app startup project.");
});

after(() => {
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("chat-recall is fail-soft: no backend key → [] (never throws)", async () => {
  const { searchChat, recentChat } = await import(
    path.resolve("lib/chat-recall.mjs") + `?t=${Date.now()}`
  );
  // Force "no credentials" regardless of any local .env — key() reads env at call time.
  const savedRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedAnon = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  try {
    const a = await searchChat("anything", { queryVec: [0.1, 0.2, 0.3] });
    const b = await recentChat({ hours: 24 });
    assert.deepEqual(a, [], "searchChat returns [] with no key");
    assert.deepEqual(b, [], "recentChat returns [] with no key");
  } finally {
    if (savedRole !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedRole;
    if (savedAnon !== undefined) process.env.SUPABASE_ANON_KEY = savedAnon;
  }
});

test("unified recall fuses + tags a reachable source (wiki-only, no network)", async () => {
  const { recall } = await import(
    path.resolve("lib/unified-recall.mjs") + `?t=${Date.now()}`
  );
  // chat + events + replies + inbox off → no Supabase/event dependency; wiki
  // degrades to FTS (no Ollama locally), which is enough to prove fusion +
  // tagging + shape. `replies` and `inbox` are opted out here for the same
  // reason chat is: this test asserts single-source behavior. Their own
  // coverage is in utterance-store.test.mjs + the replies-source test below.
  const out = await recall("restaurant dining preferences", {
    k: 5,
    chat: false,
    events: false,
    replies: false,
    inbox: false,
    wiki: true,
  });
  assert.equal(out.query, "restaurant dining preferences");
  assert.deepEqual(out.sources, ["wiki"]);
  assert.ok(out.results.length > 0, "returns fused results");
  assert.ok(out.results.every((r) => r.source === "wiki"), "every result tagged source=wiki");
  assert.ok(out.results.every((r) => typeof r.rrf === "number"), "every result carries an rrf score");
  assert.ok(out.results.some((r) => r.id === "user_food_prefs"), "the food page is recalled");
  assert.ok(out.results.length <= 5, "respects k");
});

test("unified recall on an empty query returns nothing", async () => {
  const { recall } = await import(
    path.resolve("lib/unified-recall.mjs") + `?t=${Date.now()}`
  );
  const out = await recall("   ", { chat: false, wiki: true });
  assert.deepEqual(out.results, []);
});

test("the replies source is on by default and needs no network", async () => {
  // Alex's own dated answers must be recallable even when Supabase and
  // Ollama are unreachable — it is the last line of defense against re-asking
  // something the user already settled, so it cannot depend on a live service.
  const { recall } = await import(
    path.resolve("lib/unified-recall.mjs") + `?t=${Date.now()}`
  );
  const out = await recall("already handled don't re-ask", {
    k: 5, chat: false, wiki: false, events: false, inbox: false,
  });
  assert.deepEqual(out.sources, ["replies"], "replies is enabled by default");
  // The local reply log may legitimately be empty on a dev box; the contract
  // under test is that the source participates and never throws.
  assert.ok(Array.isArray(out.results));
  assert.ok(out.results.every((r) => r.source === "replies"));
});
