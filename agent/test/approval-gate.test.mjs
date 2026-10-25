// approval-gate.test.mjs — WP7 surpass-feature #4 (high-stakes approval gate).
// Deterministic clock injected; no network, no real rails.
//
// Run: node --test agent/test/approval-gate.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `approval-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const { createApprovalGate } = await import("../core/approval-gate.mjs");

let clock = 1_000_000;
const now = () => clock;

function cleanup() {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
  clock = 1_000_000;
}

// A "high-stakes" tool that records every real execution.
function purchaseTool(log) {
  return {
    name: "purchase",
    description: "buy something",
    schema: { type: "object", properties: { item: { type: "string" }, amount: { type: "number" } } },
    handler: async ({ item, amount }) => { log.push({ item, amount }); return { ok: true, bought: item, amount }; },
  };
}

describe("approval-gate (WP7 #4)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("gating a tool: the call does NOT run the side effect; it persists a pending approval", async () => {
    const log = [];
    const g = createApprovalGate({ now });
    const gated = g.gate(purchaseTool(log), { risk: "high", describe: ({ item, amount }) => `Buy ${item} for $${amount}` });
    const out = await gated.handler({ item: "widgets", amount: 42 });
    assert.equal(out.ok, false);
    assert.equal(out.pending, true);
    assert.equal(out.needs_approval, true);
    assert.ok(out.approval_id);
    assert.equal(out.summary, "Buy widgets for $42");
    assert.equal(log.length, 0, "side effect NOT executed on call");
    assert.deepEqual(g.pending().map((p) => p.tool), ["purchase"]);
    g._closeForTest();
  });

  it("approve() runs the real handler exactly once and records the result", async () => {
    const log = [];
    const g = createApprovalGate({ now });
    const gated = g.gate(purchaseTool(log), {});
    const { approval_id } = await gated.handler({ item: "widgets", amount: 42 });
    const res = await g.approve(approval_id);
    assert.equal(res.ok, true);
    assert.deepEqual(res.result, { ok: true, bought: "widgets", amount: 42 });
    assert.equal(log.length, 1, "handler ran once");
    // A second approve is rejected (no double-execute).
    const again = await g.approve(approval_id);
    assert.equal(again.ok, false);
    assert.match(again.error, /already executed/);
    assert.equal(log.length, 1);
    g._closeForTest();
  });

  it("deny() blocks execution permanently", async () => {
    const log = [];
    const g = createApprovalGate({ now });
    const gated = g.gate(purchaseTool(log), {});
    const { approval_id } = await gated.handler({ item: "x", amount: 5 });
    assert.equal(g.deny(approval_id, "too expensive").ok, true);
    const res = await g.approve(approval_id);
    assert.equal(res.ok, false);
    assert.match(res.error, /already denied/);
    assert.equal(log.length, 0);
    g._closeForTest();
  });

  it("expired approvals cannot be approved", async () => {
    const log = [];
    const g = createApprovalGate({ now, ttlSeconds: 60 });
    const gated = g.gate(purchaseTool(log), {});
    const { approval_id } = await gated.handler({ item: "x", amount: 5 });
    clock += 61_000; // past the 60s TTL
    const res = await g.approve(approval_id);
    assert.equal(res.ok, false);
    assert.match(res.error, /expired/);
    assert.equal(log.length, 0);
    assert.equal(g.pending().length, 0, "expired row not listed as pending");
    g._closeForTest();
  });

  it("DURABILITY: a pending approval survives a gate re-creation (bounce)", async () => {
    const log = [];
    const g1 = createApprovalGate({ now });
    const gated1 = g1.gate(purchaseTool(log), {});
    const { approval_id } = await gated1.handler({ item: "flights", amount: 300 });
    g1._closeForTest(); // simulate supervisor bounce: in-memory handlers lost

    // New gate instance re-registers the SAME tool (startup) → handler rebound.
    const g2 = createApprovalGate({ now });
    g2.gate(purchaseTool(log), {});
    assert.deepEqual(g2.pending().map((p) => p.tool), ["purchase"], "pending row persisted across bounce");
    const res = await g2.approve(approval_id);
    assert.equal(res.ok, true);
    assert.equal(log.length, 1, "approved after bounce ran the rebuilt handler");
    g2._closeForTest();
  });

  it("approve() falls back to an injected execute() when no in-memory handler exists", async () => {
    const log = [];
    const g1 = createApprovalGate({ now });
    const gated1 = g1.gate(purchaseTool(log), {});
    const { approval_id } = await gated1.handler({ item: "amazon", amount: 120 });
    g1._closeForTest();

    // A gate that never re-registered the tool, but has a registry executor.
    const execLog = [];
    const g2 = createApprovalGate({ now, execute: async (tool, input) => { execLog.push([tool, input]); return { ok: true, via: "execute" }; } });
    const res = await g2.approve(approval_id);
    assert.equal(res.ok, true);
    assert.equal(res.result.via, "execute");
    assert.deepEqual(execLog[0], ["purchase", { item: "amazon", amount: 120 }]);
    g2._closeForTest();
  });

  it("FAILS CLOSED: unknown id and already-decided are rejected, never silently run", async () => {
    const g = createApprovalGate({ now });
    assert.match((await g.approve("nope")).error, /unknown approval id/);
    assert.match(g.deny("nope").error, /unknown approval id/);
    g._closeForTest();
  });
});
