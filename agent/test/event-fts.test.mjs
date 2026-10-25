// event-fts.test.mjs — unit tests for the events_fts recall index.
//
// Run: node --test agent/test/event-fts.test.mjs
//
// Uses a throwaway MEMORY_INDEX_DB so it never touches the real memory-index.db.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `event-fts-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;

// Import AFTER setting MEMORY_INDEX_DB so the module resolves the temp path.
const {
  indexEvent, searchEvents, recentEvents, pruneOlderThan, rebuildFromFiles, stats, _closeForTest,
} = await import("../../lib/event-fts.mjs");

function cleanup() {
  _closeForTest();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch {}
  }
}

describe("event-fts recall index", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(() => {
    // Fresh table each test.
    _closeForTest();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + suffix); } catch {} }
  });

  function seed() {
    indexEvent({ ts: "2026-07-08T09:00:00Z", kind: "dispatcher.dispatching", item: { id: "1", source: "daily-summary", content: "Write the day-in-review narrative for July 8" } }, { agent: "ops" });
    indexEvent({ ts: "2026-07-08T09:03:00Z", kind: "dispatcher.turn_complete", id: "1", source: "daily-summary" }, { agent: "ops" });
    indexEvent({ ts: "2026-07-08T09:10:00Z", kind: "result", result: "Quarterly budget memo emailed: rebalance of the project buckets." }, { agent: "ops" });
    indexEvent({ ts: "2026-07-08T09:20:00Z", kind: "dispatcher.dispatching", item: { id: "2", source: "gmail:5521", content: "Triage Shipment notice email from the courier" } }, { agent: "ops-light" });
  }

  it("indexes events and finds them by full-text query", () => {
    seed();
    const r = searchEvents("budget rebalance");
    assert.ok(r.length >= 1, "should find the rebalance result");
    assert.match(r[0].snippet, /rebalance/i);
  });

  it("respects source / kind / agent filters", () => {
    seed();
    assert.equal(searchEvents("Shipment", { source: "gmail:5521" }).length, 1);
    assert.equal(searchEvents("Shipment", { source: "daily-summary" }).length, 0);
    assert.equal(searchEvents("rebalance", { kind: "result" }).length, 1);
    assert.equal(searchEvents("narrative", { agent: "ops" }).length, 1);
    assert.equal(searchEvents("narrative", { agent: "ops-light" }).length, 0);
  });

  it("recentEvents returns newest-first and honors kind filter", () => {
    seed();
    const recent = recentEvents({ limit: 10, kinds: ["dispatcher.dispatching"] });
    assert.equal(recent.length, 2);
    // newest-first → gmail dispatch (09:20) before daily-summary (09:00)
    assert.equal(recent[0].source, "gmail:5521");
    assert.equal(recent[1].source, "daily-summary");
  });

  it("caps stored text at 4000 chars", () => {
    const big = "x".repeat(9000);
    indexEvent({ ts: "2026-07-08T10:00:00Z", kind: "result", result: big }, { agent: "ops" });
    const r = recentEvents({ limit: 1 });
    assert.ok(r[0].text.length <= 4000, `text should be capped, got ${r[0].text.length}`);
  });

  it("prunes rows older than the cutoff", () => {
    indexEvent({ ts: "2020-01-01T00:00:00Z", kind: "result", result: "ancient" }, { agent: "ops" });
    indexEvent({ ts: new Date().toISOString(), kind: "result", result: "fresh" }, { agent: "ops" });
    const removed = pruneOlderThan(30);
    assert.equal(removed, 1, "only the ancient row should be pruned");
    assert.equal(searchEvents("ancient").length, 0);
    assert.equal(searchEvents("fresh").length, 1);
  });

  it("rebuilds from a JSONL file (source of truth)", () => {
    const ndjson = path.join(os.tmpdir(), `evt-rebuild-${process.pid}-supervisor-ops`, "events.ndjson");
    fs.mkdirSync(path.dirname(ndjson), { recursive: true });
    fs.writeFileSync(ndjson,
      JSON.stringify({ ts: "2026-07-08T08:00:00Z", kind: "dispatcher.dispatching", item: { id: "a", source: "news-watch", content: "weekly news digest" } }) + "\n" +
      JSON.stringify({ ts: "2026-07-08T08:01:00Z", kind: "result", result: "news digest emailed" }) + "\n" +
      "not-json-should-skip\n");
    const res = rebuildFromFiles([ndjson]);
    assert.equal(res.indexed, 2, "two valid lines indexed, junk skipped");
    const r = searchEvents("news digest");
    assert.ok(r.length >= 1);
    // agent inferred from the "supervisor-ops" path segment
    assert.equal(r[0].agent, "ops");
    try { fs.rmSync(path.dirname(ndjson), { recursive: true, force: true }); } catch {}
  });

  it("stats reports totals and kind histogram", () => {
    seed();
    const s = stats();
    assert.equal(s.available, true);
    assert.equal(s.total, 4);
    assert.ok(s.byKind.find((k) => k.kind === "dispatcher.dispatching"));
  });

  it("empty / whitespace query returns no rows (no throw)", () => {
    seed();
    assert.deepEqual(searchEvents(""), []);
    assert.deepEqual(searchEvents("   "), []);
  });
});
