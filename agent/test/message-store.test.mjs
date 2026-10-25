// message-store.test.mjs — WP4 unified persistent message store.
//
// Run: node --test agent/test/message-store.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the DB BEFORE importing (the module captures DB_PATH at load time).
const TMP_DB = path.join(os.tmpdir(), `message-store-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");

function cleanup() {
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

describe("message-store (WP4)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("appends messages and returns monotonic seqs", () => {
    const s1 = store.appendMessage({ agentId: "ops", role: "user", content: "triage the inbox" });
    const s2 = store.appendMessage({ agentId: "ops", role: "assistant", kind: "text", content: "done, 3 P1s" });
    assert.equal(typeof s1, "number");
    assert.ok(s2 > s1, "seq is monotonic");
  });

  it("getRecentMessages returns oldest-first, scoped per agent", () => {
    store.appendMessage({ agentId: "ops", role: "user", content: "a" });
    store.appendMessage({ agentId: "ops", role: "user", content: "b" });
    store.appendMessage({ agentId: "chat", role: "user", content: "other agent" });
    const recent = store.getRecentMessages("ops", 10);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map((m) => m.content), ["a", "b"]); // chronological
    assert.ok(recent.every((m) => m.agentId === "ops"));
  });

  it("retrieveRange recovers a contiguous inclusive slice", () => {
    const seqs = ["one", "two", "three", "four"].map((c) =>
      store.appendMessage({ agentId: "ops", role: "user", content: c }));
    const mid = store.retrieveRange("ops", seqs[1], seqs[2]);
    assert.deepEqual(mid.map((m) => m.content), ["two", "three"]);
  });

  it("preserves structured content (parts arrays) round-trip", () => {
    const content = [
      { type: "text", text: "calling a tool" },
      { type: "tool_use", name: "wiki_search", input: { query: "piano" } },
    ];
    const seq = store.appendMessage({ agentId: "ops", role: "assistant", kind: "tool_use", content });
    const [row] = store.retrieveRange("ops", seq, seq);
    assert.deepEqual(row.content, content);
  });

  it("searchFTS finds messages by content, ranked", () => {
    store.appendMessage({ agentId: "ops", role: "user", content: "renew the domain on Thursday" });
    store.appendMessage({ agentId: "ops", role: "assistant", content: "the coupon expired" });
    const hits = store.searchFTS("ops", "domain renew");
    assert.ok(hits.length >= 1);
    assert.match(hits[0].snippet, /domain|renew/i);
  });

  it("searchFTS across all agents when agentId is null", () => {
    store.appendMessage({ agentId: "ops", role: "user", content: "unicorn sighting alpha" });
    store.appendMessage({ agentId: "chat", role: "user", content: "unicorn sighting beta" });
    const hits = store.searchFTS(null, "unicorn sighting");
    const agents = new Set(hits.map((h) => h.agentId));
    assert.ok(agents.has("ops") && agents.has("chat"));
  });

  it("agents registry upserts and tracks fork lineage", () => {
    store.upsertAgent({ id: "fork-abc", kind: "fork", label: "price scan", forkedFromSeq: 42, forkedContextStartSeq: 10, autoJoin: false });
    const row = store.getAgentRow("fork-abc");
    assert.equal(row.kind, "fork");
    assert.equal(row.forked_from_seq, 42);
    assert.equal(row.auto_join, false);
    store.setAgentStatus("fork-abc", "running");
    assert.equal(store.getAgentRow("fork-abc").status, "running");
  });

  it("tool_pairs link use+result seqs (PAIR rule for snipping)", () => {
    store.registerToolPair({ toolUseId: "tu_1", agentId: "ops", useSeq: 5 });
    store.setToolResultSeq("tu_1", 6);
    const pair = store.getToolPair("tu_1");
    assert.equal(pair.use_seq, 5);
    assert.equal(pair.result_seq, 6);
  });

  it("durable inbound queue survives (enqueue → pending → processed)", () => {
    const seq = store.enqueueInbound("ops", [{ type: "hint", text: "actually skip that" }]);
    assert.equal(typeof seq, "number");
    let pend = store.pendingInbound("ops");
    assert.equal(pend.length, 1);
    assert.equal(pend[0].parts[0].text, "actually skip that");
    store.markInboundProcessed(seq);
    pend = store.pendingInbound("ops");
    assert.equal(pend.length, 0);
  });

  it("data survives reopening the DB (persistence)", () => {
    store.appendMessage({ agentId: "ops", role: "user", content: "persist me across a reopen" });
    store._closeForTest();                 // drop the handle, keep the file
    const again = store.getRecentMessages("ops", 5);
    assert.ok(again.some((m) => m.content === "persist me across a reopen"));
  });

  it("stats reports counts", () => {
    store.appendMessage({ agentId: "ops", role: "user", content: "x" });
    const st = store.stats();
    assert.equal(st.available, true);
    assert.ok(st.messages >= 1);
  });
});
