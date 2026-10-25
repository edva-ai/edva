// handoff-digest.test.mjs — unit tests for session-handoff digest generation.
//
// Run: node --test agent/test/handoff-digest.test.mjs
//
// Covers: sourcing from the events_fts index, the JSONL-tail fallback, the
// empty case, and the block that gets prepended to the fresh session's first
// real dispatch. There is no model in this path.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `handoff-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;

const { indexEvent, _closeForTest } = await import("../../lib/event-fts.mjs");
const { buildHandoffDigest, formatHandoffBlock } = await import("../supervisor/handoff-digest.mjs");

function cleanup() {
  _closeForTest();
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + suffix); } catch {} }
}

function seedActivity() {
  indexEvent({ ts: "2026-07-08T09:00:00Z", kind: "dispatcher.dispatching", item: { id: "1", source: "daily-summary", content: "Write the day-in-review narrative" } }, { agent: "ops" });
  indexEvent({ ts: "2026-07-08T09:03:00Z", kind: "dispatcher.turn_complete", id: "1", source: "daily-summary" }, { agent: "ops" });
  indexEvent({ ts: "2026-07-08T09:10:00Z", kind: "dispatcher.dispatching", item: { id: "2", source: "gmail:5521", content: "Triage Shipment notice" } }, { agent: "ops" });
  indexEvent({ ts: "2026-07-08T09:12:00Z", kind: "dispatcher.error", id: "2", source: "gmail:5521", error: "turn watchdog fired" }, { agent: "ops" });
}

describe("session-handoff digest", () => {
  before(cleanup);
  after(cleanup);

  it("returns null when there is no activity to summarize", () => {
    const d = buildHandoffDigest({
      agent: "ops", eventsPath: "/nonexistent/events.ndjson",
      fromSessionId: "x", fromDispatches: 0, reason: "test",
    });
    assert.equal(d, null);
  });

  it("builds a deterministic digest from the index — no model", () => {
    seedActivity();
    const d = buildHandoffDigest({
      agent: "ops", eventsPath: "/nonexistent/events.ndjson",
      fromSessionId: "aaaaaaaa-1111", fromDispatches: 40, reason: "dispatch cap 40",
    });
    assert.ok(d, "should produce a digest");
    assert.equal(d.model, "deterministic");
    assert.equal(d.reason, "dispatch cap 40");
    assert.equal(d.fromDispatches, 40);
    assert.match(d.text, /daily-summary/);
    assert.match(d.text, /gmail:5521/);
  });

  it("formats a context-only block naming the rotation and the previous session", () => {
    seedActivity();
    const d = buildHandoffDigest({
      agent: "ops", eventsPath: "/nonexistent/events.ndjson",
      fromSessionId: "bbbbbbbb-2222", fromDispatches: 12, reason: "daily age rotation",
    });
    const block = formatHandoffBlock(d);
    assert.ok(block.startsWith("<session-handoff>\n"));
    assert.ok(block.endsWith("</session-handoff>\n\n"));
    assert.ok(block.includes("bbbbbbbb"));
    assert.ok(block.includes("12 dispatches"));
    assert.ok(block.includes("daily age rotation"));
    assert.ok(block.includes(d.text));
    assert.equal(formatHandoffBlock(null), "");
  });

  it("falls back to the JSONL tail when the index is empty", () => {
    cleanup();
    // Fresh empty index; provide activity only via a JSONL file.
    const dir = path.join(os.tmpdir(), `handoff-tail-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    const ndjson = path.join(dir, "events.ndjson");
    fs.writeFileSync(ndjson,
      JSON.stringify({ ts: "2026-07-08T07:00:00Z", kind: "dispatcher.dispatching", item: { id: "z", source: "news-watch", content: "weekly news digest" } }) + "\n" +
      JSON.stringify({ ts: "2026-07-08T07:05:00Z", kind: "dispatcher.turn_complete", id: "z", source: "news-watch" }) + "\n");
    const d = buildHandoffDigest({
      agent: "ops", eventsPath: ndjson,
      fromSessionId: "cccc", fromDispatches: 12, reason: "daily age rotation",
    });
    assert.ok(d, "should produce a digest from the tail");
    assert.match(d.text, /news-watch/);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});
