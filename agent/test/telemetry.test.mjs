// telemetry.test.mjs — WP13 server-side: status line, live checklist, mobilePush
// one-push discipline. Isolated tmp DB; injected pusher (no real APNs).
//
// Run: node --test agent/test/telemetry.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `telemetry-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const t = await import("../core/telemetry.mjs");

function cleanup() {
  t._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

describe("telemetry status line + todos (WP13)", () => {
  before(cleanup); after(cleanup); beforeEach(cleanup);

  it("setStatusLine round-trips and clears with empty", () => {
    assert.equal(t.setStatusLine("chat", "researching flights…"), true);
    assert.equal(t.getTelemetry("chat").statusLine, "researching flights…");
    t.setStatusLine("chat", "");
    assert.equal(t.getTelemetry("chat").statusLine, null);
  });

  it("setTodos persists an in-progress checklist, clears when all complete", () => {
    t.setTodos("ops", [
      { content: "fetch", status: "completed" },
      { content: "analyze", status: "in_progress" },
    ]);
    assert.equal(t.getTelemetry("ops").todos.length, 2);
    // All complete → checklist clears (Conway's rule).
    t.setTodos("ops", [
      { content: "fetch", status: "completed" },
      { content: "analyze", status: "completed" },
    ]);
    assert.deepEqual(t.getTelemetry("ops").todos, []);
  });

  it("status line and todos coexist on one agent row", () => {
    t.setStatusLine("job1", "step 2 of 3");
    t.setTodos("job1", [{ content: "x", status: "in_progress" }]);
    const tel = t.getTelemetry("job1");
    assert.equal(tel.statusLine, "step 2 of 3");
    assert.equal(tel.todos.length, 1);
  });

  it("clearTelemetry removes the row; allTelemetry lists active + honors maxAge", () => {
    t.setStatusLine("a", "x", { now: 1000 });
    t.setStatusLine("b", "y", { now: 50_000 });
    assert.equal(t.allTelemetry().length, 2);
    assert.equal(t.allTelemetry({ maxAgeMs: 10_000, now: 55_000 }).length, 1); // only b is fresh
    t.clearTelemetry("a");
    assert.equal(t.getTelemetry("a"), null);
    assert.equal(t.allTelemetry().length, 1);
  });
});

describe("mobilePush one-push-per-task discipline (WP13)", () => {
  before(cleanup); after(cleanup); beforeEach(() => { cleanup(); t._resetPushDedupeForTest(); });

  it("sends once, dedupes a repeat within the window, sends again after it", () => {
    const sent = [];
    const pusher = (title, body) => { sent.push({ title, body }); return true; };
    let clock = 1_000_000;
    const now = () => clock;

    const r1 = t.mobilePush("Job done", "research complete", { dedupeKey: "job-42", pusher, now });
    assert.deepEqual(r1, { sent: true, reason: "sent" });
    assert.equal(sent.length, 1);

    clock += 60_000;   // within the 5-min window
    const r2 = t.mobilePush("Job done", "research complete (again)", { dedupeKey: "job-42", pusher, now });
    assert.equal(r2.sent, false);
    assert.equal(r2.reason, "deduped");
    assert.equal(sent.length, 1, "no incremental spam");

    clock += 6 * 60_000;   // past the window
    const r3 = t.mobilePush("Job done", "final", { dedupeKey: "job-42", pusher, now });
    assert.equal(r3.sent, true);
    assert.equal(sent.length, 2);
  });

  it("distinct dedupe keys push independently", () => {
    const sent = [];
    const pusher = () => { sent.push(1); return true; };
    t.mobilePush("A", "a", { dedupeKey: "task-a", pusher });
    t.mobilePush("B", "b", { dedupeKey: "task-b", pusher });
    assert.equal(sent.length, 2);
  });

  it("reports push-failed when the pusher fails (fail-soft, no throw)", () => {
    const r = t.mobilePush("X", "y", { dedupeKey: "k", pusher: () => false });
    assert.deepEqual(r, { sent: false, reason: "push-failed" });
  });
});
