// question-pacing.test.mjs — questions lead the hum candidate list, draw on
// their own budget, and speed up as the waiting backlog grows.
// Run: node --test tests/question-pacing.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "question-pacing-"));
process.env.EDVA_DATA_DIR = dir;
delete process.env.HUM_QUESTION_SCALE;
const qp = await import("../lib/question-pacing.mjs");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-27T05:00:00Z");
const TZ = "Asia/Tokyo";

test("question candidates are recognised by lane, key and flags", () => {
  assert.ok(qp.isQuestionCandidate({ topic: "decisions" }));
  assert.ok(qp.isQuestionCandidate({ topic: "dream_asks" }));
  assert.ok(qp.isQuestionCandidate({ topic: "location_context", dedup_key: "location_ask:v1" }));
  assert.ok(qp.isQuestionCandidate({ topic: "ideas", supporting_data: { confidence: "low", verify_question: "Still on?" } }));
  assert.ok(!qp.isQuestionCandidate({ topic: "ideas", supporting_data: { confidence: "high" } }));
  assert.ok(!qp.isQuestionCandidate({ topic: "dining", urgency: 0.8 }));
});

test("questions lead the list, perishable first; info keeps its order", () => {
  const cands = [
    { topic: "dining", urgency: 0.9, dedup_key: "d1" },
    { topic: "dream_asks", urgency: 0.4, dedup_key: "q1" },
    { topic: "nearby", urgency: 0.7, dedup_key: "n1" },
    { topic: "location_context", urgency: 0.3, dedup_key: "location_ask:v" },
    { topic: "decisions", urgency: 0.6, dedup_key: "decision:x" },
  ];
  const r = qp.orderQuestionsFirst(cands);
  assert.equal(r.questions, 3);
  assert.deepEqual(r.candidates.map((c) => c.dedup_key), ["location_ask:v", "decision:x", "q1", "d1", "n1"]);
  assert.ok(r.candidates.slice(0, 3).every((c) => c.supporting_data.question_first));
  assert.ok(!r.candidates[3].supporting_data?.question_first);
});

test("while the pending slot is busy, only slot-free questions lead", () => {
  const cands = [{ topic: "dream_asks", dedup_key: "q1" }, { topic: "decisions", dedup_key: "decision:x" }, { topic: "dining", dedup_key: "d1" }];
  const r = qp.orderQuestionsFirst(cands, { slotBusy: true });
  assert.equal(r.questions, 1);
  assert.equal(r.candidates[0].dedup_key, "decision:x");
});

test("the backlog sums fresh lane reports and sets the scale", () => {
  assert.equal(qp.currentScale({ now: NOW }), 1);
  qp.reportBacklog("decisions", 2, { now: NOW });
  qp.reportBacklog("dream_asks", 1, { now: NOW });
  assert.equal(qp.questionBacklog({ now: NOW }).total, 3);
  assert.equal(qp.currentScale({ now: NOW }), 1);
  qp.reportBacklog("open_questions", 2, { now: NOW });
  assert.equal(qp.currentScale({ now: NOW }), 2);
  qp.reportBacklog("hum_asks", 6, { now: NOW });
  assert.equal(qp.currentScale({ now: NOW }), 3);
  // A stale report no longer counts.
  assert.equal(qp.questionBacklog({ now: NOW + 13 * 3600e3 }).total, 0);
});

test("lane pacing and the question pool scale with the backlog", () => {
  assert.deepEqual(qp.scaledLanePacing({ maxPerDay: 3, spacingH: 2 }, 2), { maxPerDay: 6, spacingH: 1, scale: 2 });
  assert.deepEqual(qp.questionCaps(1), { maxPerDay: 6, minIntervalMin: 5, scale: 1 });
  assert.deepEqual(qp.questionCaps(3), { maxPerDay: 18, minIntervalMin: 5, scale: 3 });
});

test("the question pool counts its own sends: spacing, then the daily cap", () => {
  const at = (minAgo) => ({ sent_at: new Date(NOW - minAgo * 60e3).toISOString() });
  assert.equal(qp.checkQuestionBudget({ now: new Date(NOW), tz: TZ, scale: 1, sends: [at(3)] }).gate, "min_interval");
  assert.equal(qp.checkQuestionBudget({ now: new Date(NOW), tz: TZ, scale: 2, sends: [at(25)] }).ok, true);
  const six = [40, 80, 120, 160, 200, 240].map(at);
  assert.equal(qp.checkQuestionBudget({ now: new Date(NOW), tz: TZ, scale: 1, sends: six }).gate, "daily_cap");
  assert.equal(qp.checkQuestionBudget({ now: new Date(NOW), tz: TZ, scale: 2, sends: six }).ok, true);
});

test("recordQuestionSend appends to the pool's ledger", () => {
  qp.recordQuestionSend({ lane: "decisions", id: "ppl:x", now: new Date(NOW - 2 * 60e3) });
  const v = qp.checkQuestionBudget({ now: new Date(NOW), tz: TZ, scale: 1 });
  assert.equal(v.count, 1);
  assert.equal(v.gate, "min_interval");
});

test("pre-rank: a question draws on the question pool, so a spent info budget does not hold it", async () => {
  const { preRankFilter } = await import("../lib/hum-vetoes.mjs");
  const deps = {
    nowMs: NOW, feedbackPath: "/nonexistent/fb.jsonl", runsPath: "/nonexistent/runs.jsonl", preview: true,
    wikiSettled: new Map(), resolvedKeys: new Map(), embed: async () => null,
    checkPingBudget: () => ({ ok: false, gate: "daily_cap", detail: "6 pings today (cap 6)" }),
    checkQuestionBudget: () => ({ ok: true }),
  };
  const { eligible, vetoed } = await preRankFilter([
    { topic: "dining", dedup_key: "dining:1", urgency: 0.7, signal: "a" },
    { topic: "decisions", dedup_key: "decision:ppl:x", urgency: 0.45, signal: "b" },
  ], deps);
  assert.deepEqual(eligible.map((c) => c.topic), ["decisions"]);
  assert.equal(vetoed[0].gate, "rate_limited");
});

test("a question offered and held in the last few hours steps behind the rest", async () => {
  const { recentlyOffered, rotateOffered } = await import("../lib/question-pacing.mjs");
  const now = Date.parse("2026-10-27T12:00:00Z");
  const runs = [
    { ts: "2026-10-27T10:00:00Z", harvest: { candidates: [{ topic: "dream_asks", dedup_key: "a" }] }, outcome: { sent: false } },
    { ts: "2026-10-27T11:00:00Z", harvest: { claim_check: { dropped: [{ topic: "dream_asks", dedup_key: "b" }] } }, outcome: { sent: false } },
    { ts: "2026-10-27T11:30:00Z", harvest: { candidates: [{ topic: "dream_asks", dedup_key: "c" }] }, sonnet: { winner_dedup_key: "c" }, outcome: { sent: true } },
    { ts: "2026-10-27T01:00:00Z", harvest: { candidates: [{ topic: "dream_asks", dedup_key: "old" }] }, outcome: { sent: false } },
    { ts: "2026-10-27T11:00:00Z", harvest: { candidates: [{ topic: "decisions", dedup_key: "d" }] }, outcome: { sent: false } },
  ];
  const offered = recentlyOffered("dream_asks", { now, runs });
  assert.deepEqual([...offered].sort(), ["a", "b"], "sent winners, other lanes and runs past the window do not count");
  assert.deepEqual(rotateOffered(["a", "b", "x", "old"], (k) => k, offered), ["x", "old", "a", "b"]);
});
