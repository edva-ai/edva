// Tests for `edva hum reactions` counting the QUESTION channel, not just
// info pings.
//
// hum surfaces a finding either as an info ping (a row in hum-feedback.jsonl,
// engagement = a tapback token) or as a question (a hum-runs.jsonl row with
// sonnet.decision "question", engagement = an answer in hum-learnings.jsonl
// keyed by outcome.question_id). Before 2026-07-30 this command read only the
// first, so a lane that mostly asks questions was invisible to its decay
// detector and could be flagged `low_engagement` while the user was answering it
// fine. Fixture shapes are verbatim from the host's real ledgers (14-day
// window sampled 2026-07-30), including the downgrade_reason values that mark
// a question the pipeline decided against actually sending.
//
// The command is a subcommand of the `edva` CLI rather than an exported
// helper, and it resolves its data paths from os.homedir(). Node's
// os.homedir() honours $HOME on POSIX, so these drive the real binary with
// HOME pointed at a temp fixture tree — an end-to-end test of the shipped
// code path, not a re-implementation of its arithmetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EDVA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "edva");

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// An info ping: one row per real send, `reaction` null until the user taps.
const info = (lane, reaction = null) => ({
  ping_id: `p-${Math.random().toString(16).slice(2, 8)}`,
  sent_at: hoursAgo(6),
  lane,
  reaction,
});

// A question tick. `sent` false + a downgrade_reason is the shape hum writes
// when it decided to ask but the send was suppressed — 11 of 44 real ticks.
const question = (topic, { id = null, sent = true, downgrade = null } = {}) => ({
  ts: hoursAgo(6),
  sonnet: { decision: "question", based_on_topic: topic },
  outcome: { sent, downgrade_reason: downgrade, ping_id: null, question_id: id },
});

const answer = (id) => ({ id, asked_at: hoursAgo(6), answered_at: hoursAgo(5), subject: "s", answer: "a" });

function run({ feedback = [], runs = [], learnings = [] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hum-rxn-"));
  const data = path.join(home, "Dev/edva/data");
  fs.mkdirSync(data, { recursive: true });
  const write = (f, rows) => fs.writeFileSync(path.join(data, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  write("hum-feedback.jsonl", feedback);
  write("hum-runs.jsonl", runs);
  write("hum-learnings.jsonl", learnings);
  try {
    const out = execFileSync("node", [EDVA, "hum", "reactions", "--since", "14d", "--json"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("info-only lanes count exactly as before (no regression)", () => {
  const r = run({ feedback: [info("news", "helpful"), info("news", "skip"), info("news")] });
  const news = r.lanes.news;
  assert.equal(news.surfaced, 3);
  assert.equal(news.reacted, 2);
  assert.equal(news.positive, 1);
  assert.equal(news.negative, 1);
  assert.equal(news.info_surfaced, 3);
  assert.equal(news.question_surfaced, 0);
});

test("a sent, answered question counts as surfaced AND reacted", () => {
  const r = run({
    runs: [question("ideas", { id: "q-1" })],
    learnings: [answer("q-1")],
  });
  assert.equal(r.lanes.ideas.surfaced, 1);
  assert.equal(r.lanes.ideas.reacted, 1);
  assert.equal(r.lanes.ideas.question_surfaced, 1);
  assert.equal(r.lanes.ideas.info_surfaced, 0);
});

test("an answered question is valence-free — counts as `other`, never positive/negative", () => {
  const r = run({ runs: [question("ideas", { id: "q-1" })], learnings: [answer("q-1")] });
  assert.equal(r.lanes.ideas.other, 1);
  assert.equal(r.lanes.ideas.positive, 0);
  assert.equal(r.lanes.ideas.negative, 0);
  assert.equal(r.lanes.ideas.positive_rate, null);
});

test("a sent but unanswered question is surfaced, not reacted", () => {
  const r = run({ runs: [question("location_context", { id: "q-1" })] });
  assert.equal(r.lanes.location_context.surfaced, 1);
  assert.equal(r.lanes.location_context.reacted, 0);
});

test("questions that never reached the user are not counted at all", () => {
  // The real downgrade reasons observed in the 14d to 2026-07-30.
  const r = run({
    runs: [
      question("ideas", { sent: false, downgrade: "pending_question_active" }),
      question("ideas", { sent: false, downgrade: "precheck_suppressed" }),
      question("ideas", { sent: false, downgrade: "wiki_settled" }),
      question("ideas", { id: "q-live" }),
    ],
  });
  assert.equal(r.lanes.ideas.surfaced, 1, "only the sent question counts");
  assert.equal(r.lanes.ideas.question_surfaced, 1);
});

test("a sent question with no question_id is unmatchable and is not counted", () => {
  const r = run({ runs: [question("calendar", { id: null, sent: true })] });
  assert.equal(r.lanes.calendar, undefined);
});

test("learnings rows without an id (canary-feedback / chat rules) never mark a question answered", () => {
  const r = run({
    runs: [question("ideas", { id: "q-1" })],
    learnings: [{ ts: hoursAgo(5), source: "canary-feedback", topic: "ideas", rule: "some rule" }],
  });
  assert.equal(r.lanes.ideas.reacted, 0);
});

test("REGRESSION: a lane answered via questions is no longer falsely flagged low_engagement", () => {
  // Info pings alone read as total disengagement (4 surfaced, 0 reacted);
  // through the question channel the user answered 3 of 4. Combined: 8 surfaced,
  // 3 reacted = 38% — engaged, no flag.
  const feedback = [info("ideas"), info("ideas"), info("ideas"), info("ideas")];
  const runs = ["q-1", "q-2", "q-3", "q-4"].map((id) => question("ideas", { id }));
  const learnings = [answer("q-1"), answer("q-2"), answer("q-3")];

  const before = run({ feedback });
  assert.equal(before.lanes.ideas.decay, "low_engagement", "info-only view sees a dead lane");

  const after = run({ feedback, runs, learnings });
  assert.equal(after.lanes.ideas.surfaced, 8);
  assert.equal(after.lanes.ideas.reacted, 3);
  assert.equal(after.lanes.ideas.decay, null, "the question channel proves engagement");
});

test("a genuinely dead question lane still earns low_engagement", () => {
  // The location_context case: 8 sent questions, zero answers.
  const runs = Array.from({ length: 8 }, (_, i) => question("location_context", { id: `q-${i}` }));
  const r = run({ runs });
  assert.equal(r.lanes.location_context.surfaced, 8);
  assert.equal(r.lanes.location_context.reacted, 0);
  assert.equal(r.lanes.location_context.decay, "low_engagement");
});

test("mostly_negative gates on the valence-bearing sample, so questions cannot trip it", () => {
  // 3 info reactions, 2 of them negative (positive_rate 0.33 — below 0.40) but
  // only 3 valence-bearing rows. Ten answered questions push `surfaced` past 5;
  // if the gate used the combined total it would now render a "mostly
  // negative" verdict off a 3-reaction sample.
  const feedback = [info("tasks", "helpful"), info("tasks", "skip"), info("tasks", "snooze")];
  const runs = Array.from({ length: 10 }, (_, i) => question("tasks", { id: `q-${i}` }));
  const learnings = Array.from({ length: 10 }, (_, i) => answer(`q-${i}`));
  const r = run({ feedback, runs, learnings });
  assert.equal(r.lanes.tasks.surfaced, 13);
  assert.ok(r.lanes.tasks.positive_rate < 0.4);
  assert.equal(r.lanes.tasks.decay, null, "questions must not inflate the valence gate");
});

test("mostly_negative still fires when the info population itself is negative", () => {
  const feedback = [
    info("tasks", "helpful"),
    info("tasks", "skip"),
    info("tasks", "skip"),
    info("tasks", "snooze"),
    info("tasks", "👎"),
  ];
  const r = run({ feedback });
  assert.equal(r.lanes.tasks.info_surfaced, 5);
  assert.equal(r.lanes.tasks.decay, "mostly_negative");
});

test("missing ledgers degrade to an empty report rather than throwing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hum-rxn-empty-"));
  fs.mkdirSync(path.join(home, "Dev/edva/data"), { recursive: true });
  try {
    const out = execFileSync("node", [EDVA, "hum", "reactions", "--since", "14d", "--json"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const r = JSON.parse(out);
    assert.equal(r.total_surfaced, 0);
    assert.deepEqual(r.lanes, {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
