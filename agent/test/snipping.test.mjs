// snipping.test.mjs — WP2 native context-snipping engine.
//
// Run: node --test agent/test/snipping.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `snipping-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");
const snip = await import("../core/snipping.mjs");

function cleanup() {
  snip._closeForTest();
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

// Append `content` as a message and return its seq.
function msg(agentId, role, content, kind = null) {
  const seq = store.appendMessage({ agentId, role, kind, content });
  return { seq, role, kind, content };
}
const big = (n) => "x".repeat(n);

describe("snipping token accounting (WP2)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("estimateTokens ~chars/4; breadcrumbs charged a fixed 60", () => {
    assert.equal(snip.estimateTokens({ content: "x".repeat(400) }), 100);
    assert.equal(snip.estimateTokens({ kind: "breadcrumb", content: [{ type: "text", text: big(9999) }] }), snip.BREADCRUMB_TOKENS);
  });
});

describe("snipping register + apply-at-budget (WP2)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("registerSnip does NOT apply immediately", () => {
    const a = msg("ops", "assistant", big(1000));
    const b = msg("ops", "user", big(1000));
    const id = snip.registerSnip({ agentId: "ops", startSeq: a.seq, endSeq: b.seq, summary: "old exchange" });
    assert.ok(id);
    assert.equal(snip.pendingSnips("ops").length, 1);
  });

  it("applyToBudget is a no-op under budget", () => {
    const m = msg("ops", "user", "small");
    const res = snip.applyToBudget("ops", [m], { budget: 1000 });
    assert.equal(res.applied.length, 0);
    assert.equal(res.messages.length, 1);
  });

  it("collapses the oldest pending range to a breadcrumb when over budget", () => {
    const m1 = msg("ops", "user", big(4000));       // ~1000 tok
    const m2 = msg("ops", "assistant", big(4000));  // ~1000 tok
    const m3 = msg("ops", "user", big(400));        // ~100 tok (recent, keep)
    snip.registerSnip({ agentId: "ops", startSeq: m1.seq, endSeq: m2.seq, summary: "early work" });
    const msgs = [m1, m2, m3].map((m) => ({ ...m }));
    const res = snip.applyToBudget("ops", msgs, { budget: 500 });
    assert.equal(res.applied.length, 1);
    // m1+m2 replaced by ONE breadcrumb; m3 preserved.
    assert.equal(res.messages.length, 2);
    assert.equal(res.messages[0].kind, "breadcrumb");
    assert.match(res.messages[0].content[0].text, /Compressed:.*early work/);
    assert.ok(res.tokensAfter < res.tokensBefore);
  });

  it("applies oldest-first (FIFO) and stops once under budget", () => {
    const a1 = msg("ops", "user", big(4000));
    const a2 = msg("ops", "assistant", big(4000));
    const b1 = msg("ops", "user", big(4000));
    const b2 = msg("ops", "assistant", big(4000));
    const s1 = snip.registerSnip({ agentId: "ops", startSeq: a1.seq, endSeq: a2.seq, summary: "first" });
    snip.registerSnip({ agentId: "ops", startSeq: b1.seq, endSeq: b2.seq, summary: "second" });
    const msgs = [a1, a2, b1, b2].map((m) => ({ ...m }));
    // Budget large enough that collapsing just the FIRST range suffices.
    const res = snip.applyToBudget("ops", msgs, { budget: 2100 });
    assert.deepEqual(res.applied, [s1], "only the oldest snip applied");
    assert.equal(snip.pendingSnips("ops").length, 1, "second snip still pending");
  });

  it("raw range stays recoverable via retrieveSnipRange after collapse", () => {
    const m1 = msg("ops", "user", "SECRET-PAYLOAD-ONE");
    const m2 = msg("ops", "assistant", big(8000));
    snip.registerSnip({ agentId: "ops", startSeq: m1.seq, endSeq: m2.seq, summary: "collapse me" });
    snip.applyToBudget("ops", [{ ...m1 }, { ...m2 }], { budget: 10 });
    const raw = snip.retrieveSnipRange("ops", m1.seq, m2.seq);
    assert.ok(raw.some((r) => r.content === "SECRET-PAYLOAD-ONE"), "raw text rehydrated from store");
  });
});

describe("snipping auto-register + PAIR rule (WP2)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("auto-registers oversized tool results older than the age threshold", () => {
    const results = [];
    // 6 messages; the first is a huge tool_result, rest small → old enough.
    results.push(msg("ops", "tool", big(20000), "tool_result"));   // ~5000 tok, oldest
    for (let i = 0; i < 5; i++) results.push(msg("ops", "user", "small"));
    const msgs = results.map((m) => ({ ...m }));
    const n = snip.autoRegisterOversized("ops", msgs, { minAgeTurns: 3 });
    assert.equal(n, 1);
    const pend = snip.pendingSnips("ops");
    assert.equal(pend[0].start_seq, results[0].seq);
  });

  it("does NOT auto-register a recent oversized result (too young)", () => {
    const recent = msg("ops", "tool", big(20000), "tool_result");  // last message → age 0
    const n = snip.autoRegisterOversized("ops", [{ ...recent }], { minAgeTurns: 3 });
    assert.equal(n, 0);
  });

  it("snip range expands to include a tool_use/tool_result PAIR", () => {
    // use at seq U, result at seq R; register a snip covering only the result.
    const use = msg("ops", "assistant", [{ type: "tool_use", id: "tu_9", name: "search", input: {} }], "tool_use");
    const result = msg("ops", "tool", [{ type: "tool_result", tool_use_id: "tu_9", content: big(9000) }], "tool_result");
    store.registerToolPair({ toolUseId: "tu_9", agentId: "ops", useSeq: use.seq, resultSeq: result.seq });
    const id = snip.registerSnip({ agentId: "ops", startSeq: result.seq, endSeq: result.seq, summary: "pair" });
    const row = snip.pendingSnips("ops").find((s) => s.id === id);
    assert.equal(row.start_seq, use.seq, "range extended back to the tool_use");
    assert.equal(row.end_seq, result.seq);
  });

  it("gapSweepSummary coalesces adjacent ranges", () => {
    const s = snip.gapSweepSummary([{ startSeq: 1, endSeq: 3 }, { startSeq: 4, endSeq: 6 }]);
    assert.match(s, /Compressed 2 spans: 1\.\.6/);
  });
});
