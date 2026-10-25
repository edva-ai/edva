// hum-responses.test.mjs — unit tests for the canonical reply-capture lib and
// the wiki-recall consult helper. The capture→consolidate→consult
// loop's two pure pieces.
//
// Run: node --test tests/hum-responses.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// hum-responses.mjs anchors its log path at os.homedir() (honors $HOME on
// POSIX). Point HOME at a fixture so the test never touches the real log.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-resp-"));
const fakeHome = path.join(fixtureDir, "home");
fs.mkdirSync(path.join(fakeHome, "Dev/edva/data"), { recursive: true });
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const RESP_PATH = path.join(fakeHome, "Dev/edva/data/hum-responses.jsonl");

test("appendResponse writes a normalized row and requires reply_text", async () => {
  const { appendResponse } = await import("../lib/hum-responses.mjs");
  const row = appendResponse({
    ping_id: "p-1", lane: "exercise", subject: "morning workout",
    reply_text: "did it this morning", disposition: "positive", source: "phone_rule",
  });
  assert.equal(row.reply_text, "did it this morning");
  assert.equal(row.lane, "exercise");
  assert.ok(row.ts, "ts is stamped");

  const lines = fs.readFileSync(RESP_PATH, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).disposition, "positive");

  assert.throws(() => appendResponse({ lane: "x" }), /reply_text is required/);
});

test("readToday returns today's rows; readSince filters by watermark", async () => {
  const { appendResponse, readToday, readSince } = await import("../lib/hum-responses.mjs");
  // Manually inject an old row (last year) by appending to the file directly.
  const oldRow = {
    ts: "2025-01-01T00:00:00.000Z", ping_id: "old", lane: "dining",
    subject: "old", subject_key: null, ping_text: null,
    reply_text: "ancient", disposition: "neutral", source: "test",
  };
  fs.appendFileSync(RESP_PATH, JSON.stringify(oldRow) + "\n");
  const justNow = appendResponse({ lane: "dining", reply_text: "fresh reply", source: "test" });

  const today = readToday();
  assert.ok(today.some((r) => r.reply_text === "fresh reply"), "fresh reply is in today");
  assert.ok(!today.some((r) => r.reply_text === "ancient"), "ancient row is not in today");

  const since = readSince(new Date(Date.now() - 3600_000).toISOString());
  assert.ok(since.some((r) => r.reply_text === "fresh reply"));
  assert.ok(!since.some((r) => r.reply_text === "ancient"));
  void justNow;
});

test("recallForCandidates returns per-candidate shape + today's replies", async () => {
  // hum-wiki-recall reads today's replies from the fixture HOME and searches
  // the wiki (real DB; may or may not have hits — we assert shape, not content).
  const { recallForCandidates } = await import("../agent/scripts/hum-wiki-recall.mjs");
  // Must be awaited — it's async (it hits the wiki store), and the real caller
  // in hum-harvest-all.mjs awaits it. Without this the assertions below run
  // against a Promise, so `out.per_candidate` is undefined.
  const out = await recallForCandidates([
    { topic: "dining", subject: "trusted restaurants", dedup_key: "dining:t" },
    { topic: "exercise", signal: "morning workout nudge" },
  ]);
  assert.equal(out.per_candidate.length, 2);
  for (const pc of out.per_candidate) {
    assert.ok("wiki_hits" in pc, "each candidate has wiki_hits");
    assert.ok(Array.isArray(pc.wiki_hits));
  }
  assert.ok(Array.isArray(out.today_replies));
  // The "fresh reply" appended in the prior test is today → should appear.
  assert.ok(out.today_replies.some((r) => r.reply_text === "fresh reply"));
});
