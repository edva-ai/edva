// A restaurant / place re-recommended under a new key. Fixtures are shaped
// like hum-feedback / hum-responses rows (headline only). The model is
// stubbed with the right answer for these texts; what is tested is which earlier
// recommendations code offers it and what the filter does with a match.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preRankFilter, recentPlacePitches, findSamePlacePitch } from "../lib/hum-vetoes.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hv-place-"));
const sent = (ping_id, sent_at, topic, dedup_key, signal, { reaction = null, sd } = {}) =>
  ({ ping_id, sent_at, lane: topic, reaction, findings: [{ topic, dedup_key, signal, ...(sd ? { supporting_data: sd } : {}) }] });
const FEEDBACK = [
  sent("p-20260301-1520-a1b2", "2026-03-01T15:20:00.000Z", "dining", "dining:at:Corner Hummus", "Corner Hummus is a 8-min walk from you — one of your own tagged spots.", { reaction: "snooze" }),
  sent("p-20260303-1905-c3d4", "2026-03-03T19:05:00.000Z", "ideas", "idea-20260303-harbor-bistro", "Harbor Bistro — a local institution, 5 min from your flat", { reaction: "more", sd: { category: "taste-match" } }),
  sent("p-20260306-0710-e5f6", "2026-03-06T07:10:00.000Z", "ideas", "idea-20260305-parade-roadclosures", "Parade in the park -- expect crowds/closures near the main square", { sd: { category: "event-prep" } }),
  sent("p-20260308-0915-0a1b", "2026-03-08T09:15:00.000Z", "nearby", "nearby:old-school", "Just up the road is the old school, run by the same trust for a century.", { reaction: "more" }),
  sent("p-20260309-1040-2c3d", "2026-03-09T10:40:00.000Z", "dining", "dining:at:Corner Hummus", "Corner Hummus is a 6-min walk from you — one of your own tagged spots.", { reaction: "helpful" }),
  sent("p-20260311-1010-4e5f", "2026-03-11T10:10:00.000Z", "dining", "dining:new:https://example.com/restaurants/best-hummus", "Corner Hummus $ (hummus) — 700m from you — A lunch-only, family-run hummus counter wit"),
];
const write = (name, rows) => { const p = path.join(dir, name); fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return p; };
const feedbackPath = write("fb.jsonl", FEEDBACK);
const beforeMar11Path = write("fb-before-mar11.jsonl", FEEDBACK.slice(0, 5)); // the Mar 11 send itself not on the ledger yet
const responsesPath = write("responses.jsonl", [
  { ping_id: "p-20260303-1905-c3d4", reply_text: "more", disposition: "positive" },
  { ping_id: "p-20260309-1040-2c3d", reply_text: "Great suggestion - but not for today.", disposition: "deferred" },
]);

const BISTRO_MAR12 = { topic: "ideas", dedup_key: "idea-20260305-harbor-bistro-square", urgency: 0.5, signal: "Harbor Bistro on the square -- the house dish, steps from your flat", supporting_data: { category: "taste-match" } };
const HUMMUS_MAR11 = { topic: "dining", dedup_key: FEEDBACK[5].findings[0].dedup_key, urgency: 0.381, signal: FEEDBACK[5].findings[0].signal };
// What a correct model answers for these texts: the earlier recommendations of the same place.
const SAME = { [BISTRO_MAR12.signal]: ["p-20260303-1905-c3d4"], [HUMMUS_MAR11.signal]: ["p-20260301-1520-a1b2", "p-20260309-1040-2c3d"] };
const stubJudge = (log) => async (text, priors) => {
  log.push(priors.map((p) => p.ping_id));
  const i = priors.findIndex((p) => (SAME[text] || []).includes(p.ping_id));
  return i >= 0 ? i : null;
};
// subject_key only isolates the history_blocked gate from the live suggestion ledger.
const cand = (c) => ({ ...c, subject_key: "test:isolated" });
const deps = (nowIso, log, extra = {}) => ({
  nowMs: Date.parse(nowIso), feedbackPath, responsesPath, wikiSettled: new Map(), embed: async () => null, checkPingBudget: () => ({ ok: true }),
  placeJudge: stubJudge(log), placeCachePath: path.join(dir, `cache-${Math.random()}.json`), retireIdea: () => true, ...extra,
});

test("code offers only restaurant / place recommendations in the window, minus deferred ones", () => {
  const priors = recentPlacePitches({ feedbackPath, responsesPath, nowMs: Date.parse("2026-03-12T14:30:00Z") });
  // Not offered: Mar 9 + Mar 1 Corner Hummus (deferred / snoozed), the parade warning (event-prep), a nearby factoid.
  assert.deepEqual(priors.map((p) => p.ping_id), ["p-20260311-1010-4e5f", "p-20260303-1905-c3d4"]);
});

test("replay Mar 12: the bistro under its second idea id is vetoed as Mar 3's, the idea is retired, the runner-up survives", async () => {
  const log = []; const retired = [];
  const { eligible, vetoed } = await preRankFilter([
    cand(BISTRO_MAR12),
    cand({ topic: "location_context", dedup_key: "location_ask:lc-20260312-1700-12.345-67.890", urgency: 0.48, signal: "Looks like you have been here a while" }),
  ], deps("2026-03-12T14:30:00Z", log, { retireIdea: (id, why) => retired.push([id, why]) }));
  assert.deepEqual(eligible.map((c) => c.topic), ["location_context"]);
  assert.equal(vetoed[0].gate, "cross_send_dedup");
  assert.match(vetoed[0].detail, /same place as p-20260303-1905-c3d4 .*idea retired/);
  assert.deepEqual(retired.map((r) => r[0]), ["idea-20260305-harbor-bistro-square"]);
  assert.equal(log.length, 1, "one model question for the one place candidate");
});

test("replay Mar 11: the hummus place after 'not for today' is not a repeat — deferred recommendations are never offered", async () => {
  const log = [];
  const { eligible, vetoed } = await preRankFilter([cand(HUMMUS_MAR11)], deps("2026-03-11T10:10:00Z", log, { feedbackPath: beforeMar11Path }));
  assert.equal(vetoed.length, 0);
  assert.equal(eligible.length, 1);
  assert.ok(!log[0].includes("p-20260301-1520-a1b2") && !log[0].includes("p-20260309-1040-2c3d"));
});

test("never asked: --preview, a reminder / logistics idea, an urgent candidate", async () => {
  const log = []; const at = "2026-03-12T14:30:00Z";
  assert.equal((await preRankFilter([cand(BISTRO_MAR12)], deps(at, log, { preview: true }))).eligible.length, 1);
  const reminder = { ...BISTRO_MAR12, dedup_key: "idea-20260219-art-walk-tonight", signal: "Art Walk tonight 6-8pm -- 10 galleries, free", supporting_data: { category: "event-prep" } };
  assert.equal((await preRankFilter([cand(reminder)], deps(at, log))).eligible.length, 1);
  assert.equal((await preRankFilter([cand({ ...BISTRO_MAR12, urgency: 0.95 })], deps(at, log))).eligible.length, 1);
  assert.equal(log.length, 0);
});

test("cache and fail-open", async () => {
  const log = [];
  const opts = { feedbackPath, responsesPath, nowMs: Date.parse("2026-03-12T14:30:00Z"), placeCachePath: path.join(dir, "cache-shared.json") };
  assert.equal(await findSamePlacePitch(BISTRO_MAR12, { ...opts, placeJudge: async () => undefined }), null, "no answer vetoes nothing");
  assert.equal((await findSamePlacePitch(BISTRO_MAR12, { ...opts, placeJudge: stubJudge(log) }))?.ping_id, "p-20260303-1905-c3d4");
  assert.equal((await findSamePlacePitch(BISTRO_MAR12, { ...opts, placeJudge: async () => { throw new Error("asked twice"); } }))?.ping_id, "p-20260303-1905-c3d4", "second ask served from cache");
  assert.equal(await findSamePlacePitch(BISTRO_MAR12, { ...opts, feedbackPath: "/nonexistent.jsonl", placeJudge: stubJudge(log) }), null);
});

test("deadline: a slow model is skipped (veto nothing, cache nothing, logged); checks run in parallel", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const at = "2026-03-12T14:30:00Z";
  const logs = []; const placeCachePath = path.join(dir, "cache-slow.json");
  const slow = async (...a) => { await sleep(400); return stubJudge([])(...a); };
  const r = await preRankFilter([cand(BISTRO_MAR12)], deps(at, [], { placeJudge: slow, placeCachePath, placeDeadlineMs: 50, log: (m) => logs.push(m) }));
  assert.equal(r.eligible.length, 1, "fail-open past the deadline");
  assert.match(logs[0], /place-repeat check skipped for idea-20260305-harbor-bistro-square/);
  await sleep(450); // let the late answer land
  assert.equal(fs.existsSync(placeCachePath), false, "a late answer is not cached");

  const second = { ...BISTRO_MAR12, topic: "dining", dedup_key: "dining:new:x", signal: "Harbor Bistro, the square — 300m from you", supporting_data: {} };
  SAME[second.signal] = ["p-20260303-1905-c3d4"];
  const t0 = Date.now();
  const both = await preRankFilter([cand(BISTRO_MAR12), cand(second)], deps(at, [], { placeJudge: async (...a) => { await sleep(120); return stubJudge([])(...a); }, placeDeadlineMs: 200 }));
  assert.equal(both.vetoed.length, 2, "two 120 ms checks fit a 200 ms deadline only in parallel");
  assert.ok(Date.now() - t0 < 200);
});
