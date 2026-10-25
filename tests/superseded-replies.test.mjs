// superseded-replies.test.mjs — a rewritten reply keeps its first draft locally.
// A self-improvement review item: a superseded first draft had existed in no
// log. Run: node --test tests/superseded-replies.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superseded-"));
const FILE = path.join(tmp, "superseded-replies.jsonl");
process.env.EDVA_SUPERSEDED_REPLIES = FILE;
const { recordSuperseded, readSuperseded } = await import("../lib/superseded-replies.mjs");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(FILE, { force: true }));

test("a rewrite appends the original, the replacement, and why", () => {
  assert.equal(recordSuperseded({
    row_id: "r1", original: "The order ships on Monday.", replacement: "The order shipped on Tuesday.",
    reason: "freshness_rewrite", source: "phone-channel", details: { reasons: ["stale"], claims: [] },
  }), true);
  const rows = readSuperseded();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].original, "The order ships on Monday.");
  assert.equal(rows[0].replacement, "The order shipped on Tuesday.");
  assert.equal(rows[0].reason, "freshness_rewrite");
  assert.equal(rows[0].row_id, "r1");
  assert.deepEqual(rows[0].details.reasons, ["stale"]);
  assert.equal(fs.statSync(FILE).mode & 0o077, 0, "owner-only: money/health drafts");
});

test("append-only: a second rewrite adds a row, never replaces the first", () => {
  recordSuperseded({ original: "a", replacement: "b", reason: "freshness_rewrite" });
  recordSuperseded({ original: "b", replacement: "c", reason: "freshness_rewrite" });
  assert.deepEqual(readSuperseded().map((r) => r.original), ["a", "b"]);
});

test("nothing superseded → nothing written; bad input never throws", () => {
  assert.equal(recordSuperseded({ original: "same", replacement: "same", reason: "x" }), false);
  assert.equal(recordSuperseded({ original: "", reason: "x" }), false);
  assert.equal(recordSuperseded(), false);
  assert.deepEqual(readSuperseded(), []);
});

test("sinceIso filters for the weekly window", () => {
  recordSuperseded({ original: "old", replacement: "new", reason: "r" });
  assert.equal(readSuperseded({ sinceIso: "2999-01-01" }).length, 0);
  assert.equal(readSuperseded({ sinceIso: "2000-01-01" }).length, 1);
});

test("phone-channel records the draft BEFORE it overwrites the row", () => {
  const src = fs.readFileSync(new URL("../agent/phone-channel/index.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function correctReplyInPlace"));
  const rec = fn.indexOf("recordSuperseded(");
  const upd = fn.indexOf(".update({ content: fresh.corrected_text");
  assert.ok(rec > 0 && upd > 0 && rec < upd, "recordSuperseded precedes the in-place update");
});
