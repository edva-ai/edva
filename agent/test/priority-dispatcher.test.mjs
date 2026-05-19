// priority-dispatcher.test.mjs — tests for PriorityDispatcher.
//
// Run: node --test agent/test/priority-dispatcher.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PriorityDispatcher } from "../lib/priority-dispatcher.mjs";

// Mock session that emits "result" when send() is called.
class MockSession extends EventEmitter {
  constructor({ autoComplete = true, delay = 0 } = {}) {
    super();
    this.sent = [];
    this.autoComplete = autoComplete;
    this.delay = delay;
  }
  send(content) {
    this.sent.push(content);
    if (this.autoComplete) {
      const emit = () => this.emit("result", { num_turns: 1, total_cost_usd: 0.01 });
      this.delay > 0 ? setTimeout(emit, this.delay) : queueMicrotask(emit);
    }
  }
  completeCurrentTurn() {
    this.emit("result", { num_turns: 1, total_cost_usd: 0.01 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("PriorityDispatcher", () => {
  let session, dispatcher;

  beforeEach(() => {
    session = new MockSession({ autoComplete: false });
    dispatcher = new PriorityDispatcher(session);
  });

  // ── Basic dispatch ──────────────────────────────────────────────────

  it("dispatches immediately when queue is empty", () => {
    dispatcher.dispatch("hello", "test");
    assert.equal(session.sent.length, 1);
    assert.equal(session.sent[0], "hello");
    assert.ok(dispatcher.inFlight);
  });

  it("queues when a turn is in-flight", () => {
    dispatcher.dispatch("first", "test");
    dispatcher.dispatch("second", "test");
    assert.equal(session.sent.length, 1);
    assert.equal(dispatcher.queue.length, 1);
  });

  it("drains queue after turn completes", () => {
    dispatcher.dispatch("first", "test");
    dispatcher.dispatch("second", "test");
    session.completeCurrentTurn();
    assert.equal(session.sent.length, 2);
    assert.equal(session.sent[1], "second");
  });

  it("returns item id on dispatch", () => {
    const id = dispatcher.dispatch("test", "src");
    assert.ok(typeof id === "string");
    assert.ok(id.length > 0);
  });

  // ── Priority ordering ──────────────────────────────────────────────

  it("high-priority items go before normal in queue", () => {
    dispatcher.dispatch("running", "test"); // in-flight
    dispatcher.dispatch("normal-1", "test", { priority: "normal" });
    dispatcher.dispatch("high-1", "test", { priority: "high" });
    dispatcher.dispatch("normal-2", "test", { priority: "normal" });

    assert.equal(dispatcher.queue[0].content, "high-1");
    assert.equal(dispatcher.queue[1].content, "normal-1");
    assert.equal(dispatcher.queue[2].content, "normal-2");
  });

  it("low-priority items go after normal", () => {
    dispatcher.dispatch("running", "test");
    dispatcher.dispatch("low-1", "test", { priority: "low" });
    dispatcher.dispatch("normal-1", "test", { priority: "normal" });
    dispatcher.dispatch("high-1", "test", { priority: "high" });

    assert.equal(dispatcher.queue[0].content, "high-1");
    assert.equal(dispatcher.queue[1].content, "normal-1");
    assert.equal(dispatcher.queue[2].content, "low-1");
  });

  it("maintains FIFO within same priority", () => {
    dispatcher.dispatch("running", "test");
    dispatcher.dispatch("h1", "test", { priority: "high" });
    dispatcher.dispatch("h2", "test", { priority: "high" });
    dispatcher.dispatch("h3", "test", { priority: "high" });

    assert.equal(dispatcher.queue[0].content, "h1");
    assert.equal(dispatcher.queue[1].content, "h2");
    assert.equal(dispatcher.queue[2].content, "h3");
  });

  it("processes high-priority items first after turn completes", () => {
    dispatcher.dispatch("running", "test");
    dispatcher.dispatch("normal", "test", { priority: "normal" });
    dispatcher.dispatch("urgent", "test", { priority: "high" });

    session.completeCurrentTurn();
    assert.equal(session.sent[1], "urgent"); // high-priority first
  });

  // ── Dedup by msgId ────────────────────────────────────────────────

  it("deduplicates by msgId", () => {
    dispatcher.dispatch("first", "test", { msgId: "abc" });
    const id2 = dispatcher.dispatch("dupe", "test", { msgId: "abc" });
    assert.equal(id2, null);
    assert.equal(dispatcher.queue.length, 0); // only in-flight, no dupe queued
  });

  it("deduplicates against in-flight msgId", () => {
    dispatcher.dispatch("in-flight", "test", { msgId: "xyz" });
    const id = dispatcher.dispatch("dupe", "test", { msgId: "xyz" });
    assert.equal(id, null);
  });

  it("allows same content with different msgIds", () => {
    dispatcher.dispatch("same", "test", { msgId: "a" });
    const id = dispatcher.dispatch("same", "test", { msgId: "b" });
    assert.ok(id !== null);
  });

  it("clears msgId from seen set after turn completes", () => {
    dispatcher.dispatch("first", "test", { msgId: "m1" });
    session.completeCurrentTurn();
    // Now m1 should be cleared, we can reuse it.
    const id = dispatcher.dispatch("retry", "test", { msgId: "m1" });
    assert.ok(id !== null);
  });

  // ── Interrupt ─────────────────────────────────────────────────────

  it("emits interrupt_requested for high-priority when in-flight > 30s", () => {
    dispatcher.dispatch("slow-task", "test", { priority: "normal" });
    // Simulate 31s elapsed.
    dispatcher.inFlight.dispatchedAt = Date.now() - 31_000;

    const events = [];
    dispatcher.on("interrupt_requested", (item) => events.push(item));

    dispatcher.dispatch("urgent", "test", { priority: "high" });
    assert.equal(events.length, 1);
    assert.equal(events[0].content, "urgent");
  });

  it("does NOT interrupt when in-flight < 30s", () => {
    dispatcher.dispatch("recent-task", "test", { priority: "normal" });
    // In-flight just started (default dispatchedAt is now).

    const events = [];
    dispatcher.on("interrupt_requested", (item) => events.push(item));

    dispatcher.dispatch("urgent", "test", { priority: "high" });
    assert.equal(events.length, 0);
  });

  it("does NOT interrupt when in-flight is already high-priority", () => {
    dispatcher.dispatch("high-task", "test", { priority: "high" });
    dispatcher.inFlight.dispatchedAt = Date.now() - 60_000; // 60s ago

    const events = [];
    dispatcher.on("interrupt_requested", (item) => events.push(item));

    dispatcher.dispatch("another-high", "test", { priority: "high" });
    assert.equal(events.length, 0);
  });

  it("does NOT interrupt when nothing is in-flight", () => {
    const events = [];
    dispatcher.on("interrupt_requested", (item) => events.push(item));

    dispatcher.dispatch("urgent", "test", { priority: "high" });
    assert.equal(events.length, 0);
    // Should dispatch immediately instead.
    assert.equal(session.sent.length, 1);
  });

  // ── requeueInFlight ───────────────────────────────────────────────

  it("requeues in-flight at correct priority position", () => {
    dispatcher.dispatch("normal-inflight", "test", { priority: "normal" });
    dispatcher.dispatch("low-queued", "test", { priority: "low" });

    const requeued = dispatcher.requeueInFlight();
    assert.ok(requeued);
    assert.equal(requeued.content, "normal-inflight");
    // normal should be before low in queue.
    assert.equal(dispatcher.queue[0].content, "normal-inflight");
    assert.equal(dispatcher.queue[1].content, "low-queued");
  });

  it("requeued high-priority goes before everything", () => {
    dispatcher.dispatch("high-inflight", "test", { priority: "high" });
    dispatcher.dispatch("normal-queued", "test", { priority: "normal" });

    dispatcher.requeueInFlight();
    assert.equal(dispatcher.queue[0].content, "high-inflight");
    assert.equal(dispatcher.queue[1].content, "normal-queued");
  });

  it("returns null when nothing is in-flight", () => {
    assert.equal(dispatcher.requeueInFlight(), null);
  });

  // ── Snapshot ──────────────────────────────────────────────────────

  it("snapshot shows priority breakdown", () => {
    dispatcher.dispatch("running", "test");
    dispatcher.dispatch("h1", "test", { priority: "high" });
    dispatcher.dispatch("n1", "test", { priority: "normal" });
    dispatcher.dispatch("l1", "test", { priority: "low" });

    const snap = dispatcher.snapshot();
    assert.equal(snap.queueDepth, 3);
    assert.deepEqual(snap.byPriority, { high: 1, normal: 1, low: 1 });
    assert.ok(snap.inFlight);
    assert.equal(snap.completed, 0);
  });

  it("snapshot tracks completed count", () => {
    session = new MockSession({ autoComplete: true });
    dispatcher = new PriorityDispatcher(session);
    dispatcher.dispatch("a", "test");
    // autoComplete fires synchronously via queueMicrotask, need to wait.
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(dispatcher.snapshot().completed, 1);
        resolve();
      }, 50);
    });
  });

  // ── Events ────────────────────────────────────────────────────────

  it("emits enqueued, dispatching, turn_complete events", async () => {
    const events = [];
    dispatcher.on("enqueued", (item) => events.push({ type: "enqueued", content: item.content }));
    dispatcher.on("dispatching", (item) => events.push({ type: "dispatching", content: item.content }));
    dispatcher.on("turn_complete", (info) => events.push({ type: "turn_complete", content: info.message?.content }));

    dispatcher.dispatch("msg", "test");
    session.completeCurrentTurn();

    assert.equal(events.length, 3);
    assert.equal(events[0].type, "enqueued");
    assert.equal(events[1].type, "dispatching");
    assert.equal(events[2].type, "turn_complete");
  });
});
