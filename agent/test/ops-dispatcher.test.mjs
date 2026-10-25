// ops-dispatcher.test.mjs — priority insertion in the ops Dispatcher.
//
// Live email triage (gmail push, inbound email, RECLASSIFY catch-up) must jump
// ahead of background/cron work in the queue so an inbound email isn't stuck
// behind a 10-minute background job (an unread pile-up). It must NOT
// preempt the in-flight turn.
//
// Run: node --test agent/test/ops-dispatcher.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Dispatcher, isHighPriority, isHumSource } from "../supervisor/dispatcher.mjs";

// Mock session: records sends, completes a turn only when complete() is called
// (so items pile up in the queue and we can assert ordering).
class MockSession extends EventEmitter {
  constructor() { super(); this.sent = []; this.sessionNotFound = false; }
  send(content) { this.sent.push(content); }
  complete() { this.emit("result", { num_turns: 1, total_cost_usd: 0 }); }
  // Simulate `claude -p --resume <missing>`: the child prints "No conversation
  // found" (sets sessionNotFound) then emits a turns=0 result before exiting.
  resumeFailure() { this.sessionNotFound = true; this.emit("result", { num_turns: 0, total_cost_usd: 0 }); }
}

describe("ops dispatcher priority", () => {
  it("isHighPriority classifies triage vs background correctly", () => {
    assert.ok(isHighPriority("gmail:msgA", "New email received"));
    assert.ok(isHighPriority("email-inbound", "..."));
    assert.ok(isHighPriority("webhook", "RECLASSIFY: msgA"));
    assert.ok(!isHighPriority("hum", "20-minute check-in"));
    assert.ok(!isHighPriority("report-digest", "..."));
    assert.ok(!isHighPriority("price-watch", "..."));
    assert.ok(!isHighPriority("webhook", "some other task"));
  });

  it("inserts triage ahead of background work without preempting the in-flight turn", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);

    d.dispatch("jobA", "report-digest");   // drained → in-flight
    d.dispatch("jobB", "price-watch");   // queued
    d.dispatch("jobC", "hum");                // queued
    assert.equal(d.inFlight.source, "report-digest", "first job is in-flight");
    assert.deepEqual(d.queue.map((q) => q.source), ["price-watch", "hum"]);

    // Live email push → jumps to the front of the queue (in-flight untouched).
    d.dispatch("new email", "gmail:msgA");
    assert.equal(d.inFlight.source, "report-digest", "in-flight job not preempted");
    assert.deepEqual(d.queue.map((q) => q.source), ["gmail:msgA", "price-watch", "hum"]);

    // RECLASSIFY catch-up (source 'webhook', detected by content) → also high,
    // queued after the gmail item but before background work.
    d.dispatch("RECLASSIFY: msgB", "webhook");
    assert.deepEqual(d.queue.map((q) => q.source), ["gmail:msgA", "webhook", "price-watch", "hum"]);

    // Drain order: A finishes → gmail → reclassify → background.
    s.complete();
    assert.equal(d.inFlight.source, "gmail:msgA");
    s.complete();
    assert.equal(d.inFlight.source, "webhook");
    s.complete();
    assert.equal(d.inFlight.source, "price-watch");
  });

  it("keeps FIFO order among high-priority peers", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("jobA", "batch-job");          // in-flight
    d.dispatch("e1", "gmail:1");        // queued (high)
    d.dispatch("e2", "gmail:2");        // queued (high) — after e1
    assert.deepEqual(d.queue.map((q) => q.source), ["gmail:1", "gmail:2"]);
  });

  it("a high-priority dispatch into an empty queue drains immediately", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("new email", "gmail:1");
    assert.equal(d.inFlight.source, "gmail:1");
    assert.equal(d.queue.length, 0);
  });

  it("coalesces duplicate RECLASSIFY for the same message (queued + in-flight)", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("jobA", "batch-job");                              // in-flight
    const id1 = d.dispatch("RECLASSIFY: msgA", "webhook"); // queued
    const id2 = d.dispatch("RECLASSIFY: msgA", "webhook"); // dup → coalesced
    assert.equal(id1, id2, "duplicate RECLASSIFY returns the existing id");
    assert.equal(d.queue.filter((q) => q.content === "RECLASSIFY: msgA").length, 1, "only one queued for the same message");
    // A different message is NOT coalesced.
    d.dispatch("RECLASSIFY: msgB", "webhook");
    assert.equal(d.queue.filter((q) => q.content.startsWith("RECLASSIFY:")).length, 2);
    // Coalesce against the in-flight item too.
    s.complete();                                          // jobA done → RECLASSIFY msgA in-flight
    assert.equal(d.inFlight.content, "RECLASSIFY: msgA");
    const id3 = d.dispatch("RECLASSIFY: msgA", "webhook"); // same as in-flight → coalesced
    assert.equal(id3, d.inFlight.id);
    assert.equal(d.queue.filter((q) => q.content === "RECLASSIFY: msgA").length, 0, "not re-queued while in-flight");
  });

  it("re-queues (does not drop) a dispatch consumed by a failed session resume", () => {
    // A cron job was dispatched into a rotation whose fresh session id was
    // never persisted; the turns=0 "No conversation found" result marked it
    // done and it was lost. A sessionNotFound turns=0 result must re-queue,
    // not complete.
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("NIGHTLY SYNC", "cron-nightly-sync"); // drained → in-flight
    assert.equal(d.inFlight.source, "cron-nightly-sync");

    let requeued = null;
    d.on("requeued", (item) => { requeued = item; });

    const completedBefore = d.completed;
    s.resumeFailure(); // turns=0 + sessionNotFound

    assert.equal(d.inFlight, null, "in-flight cleared");
    assert.equal(d.completed, completedBefore, "NOT counted as a completed turn");
    assert.ok(requeued && requeued.source === "cron-nightly-sync", "emitted requeued");
    assert.equal(d.queue[0].content, "NIGHTLY SYNC", "job is back at the head of the queue");

    // A legitimate turns=0 result (e.g. /compact) when the session is valid must
    // still complete normally, not re-queue. Cost must be nonzero here — per
    // lib/phantom-result.mjs's own documented discriminator, a turns=0 AND
    // cost=0 result is indistinguishable from a genuine phantom (real compacts
    // bill real money; the phantom bills exactly $0), so a zero-cost value
    // here would test the phantom path rather than this one.
    s.sessionNotFound = false;
    d._drain(); // re-drain the requeued item into in-flight
    assert.equal(d.inFlight.source, "cron-nightly-sync");
    const completedNow = d.completed;
    s.emit("result", { num_turns: 0, total_cost_usd: 0.5 });
    assert.equal(d.completed, completedNow + 1, "valid turns=0 completes normally");
    assert.equal(d.inFlight, null);
  });

  it("compact-race guard requeues a turn that lands suspiciously fast next to a /compact, then flags a repeat", async () => {
    // A cron dispatch landed ~2s / 1 turn right next to a context-guard
    // /compact and never executed the playbook — the
    // compact's own local-command echo apparently got folded by claude -p's
    // CLI into the content of the very next turn, and the model spent its one
    // turn refusing what looked like an embedded instruction instead of doing
    // the real work. Nothing errored anywhere; the dispatch just silently
    // never ran. This is the guard against that: one free retry, then a loud
    // flag on a repeat so the queue can't wedge forever.
    const s = new MockSession();
    const d = new Dispatcher(s, { postCompactDrainDelayMs: 0 });

    d.dispatch("/compact", "context-guard"); // drained → in-flight
    assert.equal(d.inFlight.source, "context-guard");
    d.dispatch("NIGHTLY SYNC", "cron-nightly-sync"); // queued behind it

    let requeued = null;
    d.on("compact_race_requeue", (info) => { requeued = info; });
    let exhausted = null;
    d.on("compact_race_exhausted", (info) => { exhausted = info; });

    // The compact itself completes normally — real cost, num_turns 0, ~90s.
    // It must NOT be treated as suspect (it IS the compact turn).
    s.emit("result", { num_turns: 0, total_cost_usd: 0.9, duration_ms: 91000 });
    // Draining the next item is deliberately deferred — wait it out.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(d.inFlight.source, "cron-nightly-sync", "next item drained after the post-compact delay");

    // The cron turn lands suspiciously fast/cheap right next to the compact.
    const completedBefore = d.completed;
    s.emit("result", { num_turns: 1, total_cost_usd: 0.002, duration_ms: 2132 });
    assert.ok(requeued, "compact_race_requeue fired");
    assert.equal(d.completed, completedBefore, "NOT counted as completed");
    assert.equal(d.inFlight, null, "in-flight cleared");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(d.queue.length, 0, "requeued item re-drained into in-flight");
    assert.equal(d.inFlight.source, "cron-nightly-sync", "same job redispatched");

    // Second occurrence for the SAME item — no longer a timing fluke. Let it
    // stand rather than retrying forever, but flag it loudly.
    const completedNow = d.completed;
    s.emit("result", { num_turns: 1, total_cost_usd: 0.002, duration_ms: 1980 });
    assert.ok(exhausted, "compact_race_exhausted fired on the second hit");
    assert.equal(d.completed, completedNow + 1, "second hit completes normally so the queue doesn't wedge");
  });

  it("does not flag a normal fast/cheap turn when no compact recently ran", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("hum tick", "hum"); // drained → in-flight, no compact ever ran
    let requeued = false;
    d.on("compact_race_requeue", () => { requeued = true; });
    const completedBefore = d.completed;
    // A legitimately fast, cheap, real turn (e.g. a silent hum tick) must not
    // be mistaken for compact contamination just because it's fast.
    s.emit("result", { num_turns: 1, total_cost_usd: 0.001, duration_ms: 1500 });
    assert.ok(!requeued, "no compact recently completed — must not be flagged");
    assert.equal(d.completed, completedBefore + 1, "completes normally");
  });
});

// ── perishable hum moments ──────────────────────────────────
//
// An arrival is worth nothing if it arrives late: "here is what is around you"
// decays to zero within a few minutes, so queueing it behind a ten-minute cron
// job doesn't delay the ping, it destroys it. Ordinary cadence hum ticks have
// already waited 75 minutes and can wait their turn.
describe("perishable hum moments", () => {
  it("classifies hum:moment as high priority and plain hum as background", () => {
    assert.ok(isHighPriority("hum:moment", "<the hum playbook>"));
    assert.ok(!isHighPriority("hum", "<the hum playbook>"));
    assert.ok(isHumSource("hum"));
    assert.ok(isHumSource("hum:moment"));
    assert.ok(!isHumSource("human-review"));
    assert.ok(!isHumSource(undefined));
  });

  it("an arrival jumps the cron backlog without preempting the in-flight turn", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("jobA", "report-digest");   // in-flight
    d.dispatch("jobB", "events-watch");     // queued
    d.dispatch("jobC", "release-watcher");    // queued

    d.dispatch("<hum playbook>", "hum:moment");
    assert.equal(d.inFlight.source, "report-digest", "a running turn is never interrupted");
    assert.deepEqual(d.queue.map((q) => q.source),
      ["hum:moment", "events-watch", "release-watcher"]);
  });

  it("promote() lifts an already-queued hum turn once an arrival folds into it", () => {
    // The real sequence: a cadence hum tick queues behind cron work, THEN an
    // arrival lands and folds into it. The urgency arrives after the item does,
    // so without promote() the moment is represented but still stuck in line.
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("jobA", "report-digest");   // in-flight
    d.dispatch("jobB", "events-watch");     // queued
    d.dispatch("<hum playbook>", "hum");      // queued behind it
    assert.deepEqual(d.queue.map((q) => q.source), ["events-watch", "hum"]);

    const queued = d.queue.find((q) => q.source === "hum");
    queued.source = "hum:moment";
    assert.equal(d.promote(queued.id), true);
    assert.deepEqual(d.queue.map((q) => q.source), ["hum:moment", "events-watch"]);
  });

  it("promote() is a no-op for an unknown id and never touches the in-flight turn", () => {
    const s = new MockSession();
    const d = new Dispatcher(s);
    d.dispatch("jobA", "report-digest");
    assert.equal(d.promote("no-such-id"), false);
    assert.equal(d.promote(d.inFlight.id), false, "the running turn is not in the queue");
    assert.equal(d.inFlight.source, "report-digest");
  });
});
