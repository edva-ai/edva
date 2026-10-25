// agent.test.mjs — WP0 (own the context array) + WP6 (continuity/cancellation).
// Drives the Agent with a MOCK executor — no real claude -p, no network.
//
// Run: node --test agent/test/agent.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `agent-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");
const { Agent, normalizeParts } = await import("../core/agent.mjs");

function cleanup() {
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
function lastText(parts) {
  const t = parts.map((p) => p.text || "").join(" ").trim();
  return t;
}

// Executor: echoes the user text, but "HANG" turns hang until the signal aborts
// (resolving with "interrupted"), so we can exercise cancel/interrupt.
function echoExecutor() {
  return ({ userParts, signal }) => {
    const text = lastText(userParts);
    if (/HANG/.test(text)) {
      return new Promise((resolve) => {
        if (signal.aborted) return resolve({ text: "interrupted" });
        signal.addEventListener("abort", () => resolve({ text: "interrupted" }), { once: true });
      });
    }
    return Promise.resolve({ text: `echo:${text}` });
  };
}

describe("Agent core loop (WP0/WP6)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("normalizeParts handles string/array/object", () => {
    assert.deepEqual(normalizeParts("hi"), [{ type: "text", text: "hi" }]);
    assert.deepEqual(normalizeParts([{ type: "text", text: "x" }]), [{ type: "text", text: "x" }]);
    assert.deepEqual(normalizeParts({ type: "hint", text: "h" }), [{ type: "hint", text: "h" }]);
  });

  it("runs a turn and resolves send() with the assistant text", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    const text = await a.send("triage inbox");
    assert.equal(text, "echo:triage inbox");
    assert.equal(a.status, "idle");
    assert.equal(a.turns, 1);
  });

  it("owns the context array: user + assistant appended in order", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    await a.send("hello");
    const roles = a.messages.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant"]);
    assert.equal(a.messages[0].content[0].text, "hello");
    assert.equal(a.messages[1].content[0].text, "echo:hello");
  });

  it("persists messages to the WP4 store", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    await a.send("remember this");
    const rows = store.getRecentMessages("ops", 10);
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
    assert.ok(store.getAgentRow("ops"), "agent registered in store");
  });

  it("drains multiple queued sends, each resolving", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    const [r1, r2, r3] = await Promise.all([a.send("one"), a.send("two"), a.send("three")]);
    // All three land in one drained batch → same turn text (merged parts).
    assert.match(r1, /echo:/);
    assert.equal(r1, r2);
    assert.equal(r2, r3);
    assert.equal(a.status, "idle");
  });

  it("awaitIdle fast-path when idle, and resolves after work", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    await a.awaitIdle();                       // fast path, already idle
    const p = a.send("work");
    const idle = a.awaitIdle();                // pending until the turn finishes
    await Promise.all([p, idle]);
    assert.equal(a.status, "idle");
  });

  it("cancel() ends an in-flight turn gracefully (no error status)", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    const p = a.send("HANG on this");
    await tick();                              // let the turn start
    assert.equal(a.status, "running");
    a.cancel();
    const text = await p;
    assert.equal(text, "interrupted");
    assert.equal(a.status, "idle");
  });

  it("interrupt steers: cancels the running turn, then processes the new message", async () => {
    const a = new Agent("ops", { executor: echoExecutor() });
    const first = a.send("HANG forever");
    await tick();                              // first turn in-flight
    const second = a.send("actually do this", { interrupt: true });
    assert.equal(await first, "interrupted");  // cancelled
    assert.equal(await second, "echo:actually do this");
    assert.equal(a.turns, 2);
  });

  it("subagent kind cannot interrupt (message queues instead of cancelling)", async () => {
    const a = new Agent("sub", { kind: "subagent", executor: echoExecutor() });
    const first = a.send("HANG a while");
    await tick();
    a.send("second", { interrupt: true });     // interrupt ignored for subagent
    // The first turn is NOT cancelled by the interrupt; cancel it ourselves so
    // the test doesn't hang, then confirm the second still processes.
    await tick();
    assert.equal(a.status, "running");         // still on the first (uncancelled) turn
    a.cancel();
    await first;
    assert.equal(a._allowInterrupt, false);
  });

  it("sendDurable persists to inbound_queue; replayInbound re-feeds", async () => {
    // Enqueue durably against an agent that isn't looping yet.
    const seq = store.enqueueInbound("ops", normalizeParts("queued before boot"));
    assert.ok(seq);
    const a = new Agent("ops", { executor: echoExecutor() });
    const n = a.replayInbound();
    assert.equal(n, 1);
    await a.awaitIdle();
    assert.equal(store.pendingInbound("ops").length, 0, "replayed rows marked processed");
    assert.ok(a.messages.some((m) => m.role === "assistant" && m.content[0].text === "echo:queued before boot"));
  });

  it("rejects construction without an executor (no raw-SDK default)", () => {
    assert.throws(() => new Agent("x", {}), /executor function is required/);
  });
});

describe("Agent context hooks (WP10 integration)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  // Captures the `system` the turn was called with, for assertions.
  function capturingExecutor(sink) {
    return ({ system, userParts }) => {
      sink.push(system);
      return Promise.resolve({ text: `echo:${lastText(userParts)}` });
    };
  }

  it("no contextHooks: system is passed through unchanged (default behavior)", async () => {
    const seen = [];
    const a = new Agent("ops", { system: "BASE", executor: capturingExecutor(seen) });
    await a.send("hi");
    assert.deepEqual(seen, ["BASE"]);
  });

  it("contextHooks.assembleSystem result becomes the turn's system", async () => {
    const seen = [];
    const contextHooks = { assembleSystem: async (base) => `${base}\n\nLIVE STATE` };
    const a = new Agent("ops", { system: "BASE", executor: capturingExecutor(seen), contextHooks });
    await a.send("hi");
    assert.deepEqual(seen, ["BASE\n\nLIVE STATE"]);
  });

  it("a throwing contextHooks falls back to the static system (fail-soft)", async () => {
    const seen = [];
    const contextHooks = { assembleSystem: async () => { throw new Error("boom"); } };
    const a = new Agent("ops", { system: "BASE", executor: capturingExecutor(seen), contextHooks });
    const text = await a.send("hi");
    assert.deepEqual(seen, ["BASE"]);
    assert.equal(text, "echo:hi");   // turn still completes normally
  });

  it("assembleSystem receives the rendered messages and the agent", async () => {
    let evSeen = null;
    const contextHooks = { assembleSystem: async (base, ev) => { evSeen = ev; return base; } };
    const a = new Agent("ops", { system: "BASE", executor: capturingExecutor([]), contextHooks });
    await a.send("hi");
    assert.ok(Array.isArray(evSeen.messages));
    assert.equal(evSeen.agent, a);
  });
});
