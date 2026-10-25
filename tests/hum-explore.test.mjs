// hum-explore — the occasional "borderline pick" send that replaced the weekly
// canary: discretionary lanes still being guessed at, fresh judgment silences
// only, nothing already sent, rare by cadence; identity is structural.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectCandidates, sentKeysFrom, settledLanes, cadenceGate, momentGate, buildMessage, LANE_SOURCE, WHY_SENT,
} from "../lib/hum-explore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "../bin/hum-explore-run");
const NOW = Date.parse("2026-10-07T16:00:00Z");
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const run = (ts, near, { cause = "all_below_threshold", harvest, ...extra } = {}) => ({
  ts,
  harvest: { candidates: harvest || near.map((n) => ({ topic: n.topic, dedup_key: n.dedup_key || `${n.topic}:${n.signal}`, signal: n.signal })) },
  sonnet: { decision: "silent", silent_root_cause: cause, near_miss_candidates: near.map(({ dedup_key, ...n }) => n) },
  outcome: { sent: false },
  ...extra,
});

test("discretionary lanes only, ranker-scored first, then by score", () => {
  const recs = [
    run(ago(30), [{ topic: "art", score: 0.55, signal: "Show A" }, { topic: "music", score: 0.3, signal: "too low" }]),
    run(ago(60), [{ topic: "dining", score: 0.62, signal: "Place B" }, { topic: "location_context", score: 0.9, signal: "At X?" }]),
  ];
  assert.deepEqual(selectCandidates(recs, NOW).map((c) => c.summary), ["Place B", "Show A"]);
});

test("only fresh ticks — a held-back item from yesterday is not actionable", () => {
  assert.equal(selectCandidates([run(ago(5 * 60), [{ topic: "art", score: 0.8, signal: "old" }])], NOW).length, 0);
});

test("structural silences are never explored", () => {
  const recs = ["cross_send_dedup", "novelty_duplicate", "wiki_settled", "protected_event"]
    .map((cause, i) => run(ago(10 + i), [{ topic: "art", score: 0.8, signal: `S${i}` }], { cause }));
  assert.equal(selectCandidates(recs, NOW).length, 0);
});

test("already-sent items are excluded, by key or (keyless) exact lane+signal", () => {
  const keyed = run(ago(20), [{ topic: "art", score: 0.8, signal: "Clock tower", dedup_key: "nearby:clock" }]);
  assert.equal(selectCandidates([keyed], NOW, { sentKeys: sentKeysFrom([{ sent_at: ago(3000), findings: [{ dedup_key: "nearby:clock" }] }], NOW) }).length, 0);
  // Keyless harvest items (older traces) are never explored: identity unprovable.
  const keyless = run(ago(20), [{ topic: "music", score: 0.5, signal: "x" }], { harvest: [{ topic: "music", signal: "Harbor Jazz Fest" }] });
  assert.equal(selectCandidates([keyless], NOW).length, 0);
});

test("harvester signal, not the ranker's annotation; ranker <0.40 keeps it out", () => {
  const r = run(ago(20), [{ topic: "music", score: 0.5, signal: "Jazz fest (deduped)" }],
    { harvest: [{ topic: "music", dedup_key: "m1", signal: "Harbor Jazz Festival at the Town Hall" }] });
  assert.equal(selectCandidates([r], NOW)[0].summary, "Harbor Jazz Festival at the Town Hall");
  assert.equal(selectCandidates([run(ago(20), [{ topic: "art", score: 0.2, signal: "meh" }])], NOW).length, 0);
});

test("ambiguous lane match uses urgency, never borrows the ranker's score", () => {
  const r = run(ago(20), [{ topic: "art", score: 0.9, signal: "?" }],
    { harvest: [{ topic: "art", dedup_key: "a1", signal: "One", urgency: 0.2 }, { topic: "art", dedup_key: "a2", signal: "Two", urgency: 0.3 }] });
  assert.deepEqual(selectCandidates([r], NOW).map((c) => [c.summary, c.score]), [["Two", 0.3], ["One", 0.2]]);
});

test("excluded (settled / cooling) lanes are skipped", () => {
  const r = run(ago(20), [{ topic: "dining", score: 0.7, signal: "Food" }, { topic: "art", score: 0.5, signal: "Art" }]);
  assert.deepEqual(selectCandidates([r], NOW, { excludeLanes: new Set(["dining"]) }).map((c) => c.lane), ["art"]);
});

test("settledLanes: clear one-way evidence settles a lane; thin or mixed does not", () => {
  const s = settledLanes({ dining: { pos: 4, neg: 0.5 }, art: { pos: 1, neg: 0 }, music: { pos: 2, neg: 2 } });
  assert.deepEqual([...s], ["dining"]);
});

test("cadence: max 2 a week, 48h apart, one per lane per week", () => {
  assert.equal(cadenceGate([], NOW).ok, true);
  assert.equal(cadenceGate([{ explore: true, sent_at: ago(24 * 60), lane: "art" }], NOW).ok, false);
  const g = cadenceGate([{ explore: true, sent_at: ago(3 * 24 * 60), lane: "art" }], NOW);
  assert.equal(g.ok, true);
  assert.ok(g.coolLanes.has("art"));
  assert.equal(cadenceGate([{ explore: true, sent_at: ago(5 * 24 * 60) }, { explore: true, sent_at: ago(3 * 24 * 60) }], NOW).ok, false);
});

test("moment: needs a recent tick, and not one holding for a protected event or question", () => {
  assert.equal(momentGate([], NOW).ok, false);
  assert.equal(momentGate([run(ago(10), [], { cause: "protected_event" })], NOW).ok, false);
  assert.equal(momentGate([run(ago(10), [], { cause: "pending_question_active" })], NOW).ok, false);
  assert.equal(momentGate([run(ago(10), [])], NOW).ok, true);
  assert.equal(momentGate([run(ago(90), [])], NOW).ok, false);
});

// A real failure: a "Borderline pick: <headline>" news ping went out alone,
// with no context and no link.
const NYT = "https://news.example.com/2026/03/15/world/winter-energy-plan.html";
const newsTick = (cand) => run(ago(20), [], { harvest: [{ topic: "news", urgency: 0.275, signal: "Why the City Is Rethinking Its Winter Energy Plan", ...cand }] });

test("a news pick says what it is and why it was sent, and carries the article link", () => {
  const [pick] = selectCandidates([newsTick({ dedup_key: `news:${NYT}`, url: NYT })], NOW);
  const lines = buildMessage(pick).split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Borderline pick: Why the City Is Rethinking Its Winter Energy Plan");
  assert.ok(lines[1].startsWith(`${LANE_SOURCE.news} `), lines[1]);
  assert.ok(WHY_SENT.some((w) => lines[1].endsWith(w)), lines[1]);
  assert.equal(lines[2], NYT);
  assert.equal(buildMessage(pick), buildMessage({ ...pick }), "an item always reads the same");
});

test("a tick logged before the run log kept links still gets the article link from the news key", () => {
  const [pick] = selectCandidates([newsTick({ dedup_key: `news:${NYT}` })], NOW);
  assert.equal(pick.url, NYT);
  assert.equal(buildMessage(pick).split("\n")[2], NYT);
  // Other lanes cut their keys to 60 characters: never a link from those.
  const [art] = selectCandidates([run(ago(20), [], { harvest: [{ topic: "art", urgency: 0.4, dedup_key: "art:https://example.org/shows/a-very-long-path-that-was-cut-at-60-ch", signal: "Show @ Gallery" }] })], NOW);
  assert.equal(art.url, null);
  assert.equal(buildMessage(art).split("\n").length, 2);
});

test("a talk's own second line is not the headline, and a cut-off signal ends on a whole word", () => {
  const [talk] = selectCandidates([run(ago(20), [], { harvest: [{ topic: "talks", urgency: 0.5, dedup_key: "talks:1", url: "https://lectures.example.com/e/1", signal: "Deep Sea Life — Lecture Hall, 2026-03-16 ($20)\nhttps://lectures.example.com/e/1" }] })], NOW);
  assert.equal(talk.headline, "Deep Sea Life — Lecture Hall, 2026-03-16 ($20)");
  assert.equal(buildMessage(talk).split("\n")[2], "https://lectures.example.com/e/1");
  const long = `Corner Hummus $ (local hummus) — 700m from you — ${"a family-run hummus counter ".repeat(10)}`.slice(0, 240);
  const [dining] = selectCandidates([run(ago(20), [], { harvest: [{ topic: "dining", urgency: 0.35, dedup_key: "dining:new:x", signal: long }] })], NOW);
  assert.ok(dining.headline.endsWith("…"), dining.headline);
  const kept = dining.headline.slice(0, -1);
  assert.ok(long.startsWith(kept) && long[kept.length] === " ", `cut mid-word: ${dining.headline}`);
  assert.equal(buildMessage(dining).split("\n")[1].startsWith("It's"), false, "dining already says what it is: no source clause");
});

function binEnv(dir, extra = {}) {
  return { ...process.env, HUM_RUNS_FILE: join(dir, "runs.jsonl"), HUM_FEEDBACK_FILE: join(dir, "fb.jsonl"), HUM_EXPLORE_NOW: new Date(NOW).toISOString(), ...extra };
}

test("bin --json decides without sending", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-explore-"));
  writeFileSync(join(dir, "runs.jsonl"), JSON.stringify(run(ago(20), [{ topic: "talks", score: 0.55, signal: "Lecture tonight" }])) + "\n");
  const r = spawnSync(process.execPath, [BIN, "--json"], { encoding: "utf8", env: binEnv(dir, { HUM_EXPLORE_PING: "/usr/bin/false" }) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.send, true);
  assert.equal(out.pick.summary, "Lecture tonight");
});

test("bin sends through hum-ping with the explore intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-explore-"));
  writeFileSync(join(dir, "runs.jsonl"), JSON.stringify(run(ago(20), [{ topic: "art", score: 0.5, signal: "Gallery show" }])) + "\n");
  const argsFile = join(dir, "args");
  const fake = join(dir, "fake-ping");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: binEnv(dir, { HUM_EXPLORE_PING: fake }) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(argsFile));
  const a = readFileSync(argsFile, "utf8");
  assert.match(a, /hum:explore:art/);
  assert.match(a, /Borderline pick: Gallery show/);
});

test("bin refuses unknown flags instead of sending", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", env: { ...process.env, HUM_EXPLORE_PING: "/usr/bin/false" } });
  assert.equal(r.status, 2);
});
