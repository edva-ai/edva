// snip-semantic.test.mjs — WP7 surpass-feature #2 (semantic breadcrumbs).
// Uses a DETERMINISTIC injected embedder (no Ollama, no network): a tiny
// bag-of-words vector over a fixed vocabulary, so cosine ranking is predictable.
//
// Run: node --test agent/test/snip-semantic.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `snipsem-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;

const store = await import("../core/message-store.mjs");
const snipping = await import("../core/snipping.mjs");
const sem = await import("../core/snip-semantic.mjs");

// Deterministic embedder: count occurrences of each vocab word → vector.
const VOCAB = ["flight", "springfield", "hotel", "dinner", "invoice", "refund", "garden", "water"];
function fakeEmbed(text) {
  const t = (text || "").toLowerCase();
  const v = VOCAB.map((w) => (t.match(new RegExp(w, "g")) || []).length + 0.01);
  return v; // non-normalized; cosine handles magnitude
}

function cleanup() {
  store._closeForTest();
  snipping._closeForTest();
  sem._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

// Seed a range of real messages, register it as a snip, return the snip id.
function seedSnip(agentId, text, summary) {
  const startSeq = store.appendMessage({ agentId, role: "user", kind: "text", content: text });
  const endSeq = store.appendMessage({ agentId, role: "assistant", kind: "text", content: `ack: ${text}` });
  const id = snipping.registerSnip({ agentId, startSeq, endSeq, summary });
  return { id, startSeq, endSeq };
}

describe("snip-semantic (WP7 #2)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("indexSnip embeds range CONTENT (from the store) and searchSnipsSemantic ranks by meaning", async () => {
    const a = "sess1";
    const springfield = seedSnip(a, "our flight to springfield and the hotel booking", "travel plans");
    const invoice = seedSnip(a, "the vendor invoice and a refund request", "money stuff");
    assert.equal(await sem.indexSnip({ agentId: a, snipId: springfield.id, startSeq: springfield.startSeq, endSeq: springfield.endSeq }, { embed: fakeEmbed }), true);
    assert.equal(await sem.indexSnip({ agentId: a, snipId: invoice.id, startSeq: invoice.startSeq, endSeq: invoice.endSeq }, { embed: fakeEmbed }), true);

    const hits = await sem.searchSnipsSemantic(a, "springfield flight", { embed: fakeEmbed });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].snipId, springfield.id, "travel breadcrumb ranks first for a travel query");
    assert.ok(hits[0].score > 0);

    const money = await sem.searchSnipsSemantic(a, "refund invoice", { embed: fakeEmbed });
    assert.equal(money[0].snipId, invoice.id, "money breadcrumb ranks first for a money query");
  });

  it("falls back to summary text when the range has no store content", async () => {
    const a = "sess2";
    // snipId that points at an empty range → indexSnip should embed the summary.
    assert.equal(
      await sem.indexSnip({ agentId: a, snipId: 999, startSeq: 5000, endSeq: 5001, summary: "dinner reservation garden water" }, { embed: fakeEmbed }),
      true
    );
    const hits = await sem.searchSnipsSemantic(a, "garden water", { embed: fakeEmbed });
    assert.equal(hits[0].snipId, 999);
  });

  it("FAILS OPEN: a throwing embedder writes no row and search returns []", async () => {
    const a = "sess3";
    const s = seedSnip(a, "flight to springfield", "t");
    const boom = () => { throw new Error("ollama down"); };
    assert.equal(await sem.indexSnip({ agentId: a, snipId: s.id, startSeq: s.startSeq, endSeq: s.endSeq }, { embed: boom }), false);
    assert.equal(sem.stats(a).vectors, 0, "no vector written when embedder is down");
    // Even with a vector present, a down query-embedder yields [] not a throw.
    await sem.indexSnip({ agentId: a, snipId: s.id, startSeq: s.startSeq, endSeq: s.endSeq }, { embed: fakeEmbed });
    assert.deepEqual(await sem.searchSnipsSemantic(a, "springfield", { embed: boom }), []);
  });

  it("indexPendingSnips backfills only un-indexed snips (idempotent)", async () => {
    const a = "sess4";
    seedSnip(a, "flight to springfield", "trip");
    seedSnip(a, "hotel dinner", "stay");
    const first = await sem.indexPendingSnips(a, { embed: fakeEmbed });
    assert.equal(first.indexed, 2);
    const second = await sem.indexPendingSnips(a, { embed: fakeEmbed });
    assert.equal(second.indexed, 0, "re-run indexes nothing new");
    assert.equal(second.skipped, 2);
    assert.equal(sem.stats(a).vectors, 2);
  });

  it("hybridSnipSearch fuses lexical (FTS) + semantic, mapping each hit to its snip range", async () => {
    const a = "sess5";
    const springfield = seedSnip(a, "flight to springfield in june", "travel");
    const garden = seedSnip(a, "water the garden this evening", "chores");
    await sem.indexSnip({ agentId: a, snipId: springfield.id, startSeq: springfield.startSeq, endSeq: springfield.endSeq }, { embed: fakeEmbed });
    await sem.indexSnip({ agentId: a, snipId: garden.id, startSeq: garden.startSeq, endSeq: garden.endSeq }, { embed: fakeEmbed });

    const hits = await sem.hybridSnipSearch(a, "springfield", { k: 5, embed: fakeEmbed });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].snipId, springfield.id);
    assert.equal(hits[0].via, "hybrid");
    // Degrades to pure semantic when FTS finds nothing (embedder still up).
    const semOnly = await sem.hybridSnipSearch(a, "water", { k: 5, embed: fakeEmbed });
    assert.ok(semOnly.some((h) => h.snipId === garden.id));
  });

  it("getSnipVector returns the stored range metadata", async () => {
    const a = "sess6";
    const s = seedSnip(a, "flight to springfield", "trip");
    await sem.indexSnip({ agentId: a, snipId: s.id, startSeq: s.startSeq, endSeq: s.endSeq, summary: "trip" }, { embed: fakeEmbed });
    const v = sem.getSnipVector(s.id);
    assert.equal(v.snip_id, s.id);
    assert.equal(v.start_seq, s.startSeq);
    assert.equal(v.summary, "trip");
  });
});
