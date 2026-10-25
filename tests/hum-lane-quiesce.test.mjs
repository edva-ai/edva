// hum-lane-quiesce.test.mjs — tests for lib/hum-lane-quiesce.mjs, the
// auto-quiesce-a-lane-after-2-consecutive-expired-unanswered-lane_diagnosis-
// questions mechanism (see data/hum-improvement-loop.md § Qualitative
// diagnosis).
//
// Calls the library functions directly against an isolated fixture directory
// (via the `paths` override every exported function accepts) — never spawns
// bin/hum-answer or any other CLI binary. hum-answer's effect on
// hum-pending-question.json / hum-learnings.jsonl is simulated with plain
// fs writes, matching the shapes those files actually have.
//
// Run: node --test tests/hum-lane-quiesce.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkExpiredLaneDiagnosis,
  checkPositiveReactionReenable,
  quiesceLane,
  reenableLane,
  laneQuiesceStatus,
  recordLaneDiagnosisDelivered,
} from "../lib/hum-lane-quiesce.mjs";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hum-lane-quiesce-"));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

let n = 0;
function freshPaths() {
  const dir = path.join(fixtureRoot, `case-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const paths = {
    pendingQuestion: path.join(dir, "hum-pending-question.json"),
    learnings: path.join(dir, "hum-learnings.jsonl"),
    feedback: path.join(dir, "hum-feedback.jsonl"),
    interests: path.join(dir, "hum-interests.json"),
    interventions: path.join(dir, "hum-interventions.jsonl"),
    quiesceState: path.join(dir, "hum-lane-quiesce-state.json"),
  };
  fs.writeFileSync(paths.interests, JSON.stringify({
    schema_version: 1,
    topics: [
      { name: "talks", enabled: true, script: "talks.mjs", cadence_min: 60, cache_ttl_min: 60 },
      { name: "music", enabled: true, script: "music.mjs", cadence_min: 180, cache_ttl_min: 1440 },
    ],
  }));
  fs.writeFileSync(paths.pendingQuestion, "null\n");
  return paths;
}

function writePending(paths, obj) { fs.writeFileSync(paths.pendingQuestion, JSON.stringify(obj)); }
function appendLearning(paths, obj) { fs.appendFileSync(paths.learnings, JSON.stringify(obj) + "\n"); }
function appendFeedback(paths, obj) { fs.appendFileSync(paths.feedback, JSON.stringify(obj) + "\n"); }
function readInterests(paths) { return JSON.parse(fs.readFileSync(paths.interests, "utf8")); }
function readTopic(paths, name) { return readInterests(paths).topics.find((t) => t.name === name); }
function readInterventions(paths) {
  if (!fs.existsSync(paths.interventions)) return [];
  return fs.readFileSync(paths.interventions, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
// Mutate-and-persist in one step (readTopic() above returns a throwaway
// object from a fresh parse — assigning onto it alone never reaches disk).
function patchTopic(paths, name, patch) {
  const interests = readInterests(paths);
  Object.assign(interests.topics.find((t) => t.name === name), patch);
  fs.writeFileSync(paths.interests, JSON.stringify(interests));
}

const T0 = Date.parse("2026-08-01T12:00:00Z");
const HOUR = 3600_000;

test("a single expired-unanswered lane_diagnosis question counts but does not quiesce", () => {
  const paths = freshPaths();
  writePending(paths, {
    id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks",
    question: "Hum's talks lane...", expires_at: new Date(T0 - HOUR).toISOString(),
  });

  const actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.deepEqual(actions, [{ type: "expired_unanswered", lane: "talks", id: "qual-talks-20260601", consecutive: 1 }]);
  assert.equal(readTopic(paths, "talks").enabled, true);
  assert.equal(readInterventions(paths).length, 0);
});

test("2nd consecutive expired-unanswered question quiesces the lane", () => {
  const paths = freshPaths();
  writePending(paths, {
    id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks",
    question: "q1", expires_at: new Date(T0 - HOUR).toISOString(),
  });
  checkExpiredLaneDiagnosis({ now: T0, paths });

  const t1 = T0 + 14 * 24 * HOUR; // cooldown-respecting gap, doesn't matter to this module
  writePending(paths, {
    id: "qual-talks-20260615", category: "lane_diagnosis", lane: "talks",
    question: "q2", expires_at: new Date(t1 - HOUR).toISOString(),
  });
  const actions = checkExpiredLaneDiagnosis({ now: t1, paths });

  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, "expired_unanswered");
  assert.equal(actions[0].consecutive, 2);
  assert.equal(actions[1].type, "quiesced");
  assert.equal(actions[1].lane, "talks");

  const topic = readTopic(paths, "talks");
  assert.equal(topic.enabled, false);
  assert.match(topic._paused_reason, /2 consecutive/);
  assert.ok(topic._paused_at);

  const interventions = readInterventions(paths);
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].lane, "talks");
  assert.equal(interventions[0].action, "disabled");
  assert.equal(interventions[0].trigger, "auto_lane_quiesce");
  assert.deepEqual(interventions[0].predicted_effect, { surface_rate: "-0.03", signal_per_surfaced: "+0.05" });
});

test("re-processing the same still-expired question is idempotent (no double-count, no double-log)", () => {
  const paths = freshPaths();
  const pending = {
    id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks",
    question: "q1", expires_at: new Date(T0 - HOUR).toISOString(),
  };
  writePending(paths, pending);
  checkExpiredLaneDiagnosis({ now: T0, paths });
  const again = checkExpiredLaneDiagnosis({ now: T0 + 60_000, paths });
  assert.deepEqual(again, []);
  assert.equal(readTopic(paths, "talks").enabled, true); // still just 1, unchanged
});

test("an answered lane_diagnosis question in between breaks the consecutive streak", () => {
  const paths = freshPaths();

  // Occurrence 1: expires unanswered.
  writePending(paths, {
    id: "qual-music-20260601", category: "lane_diagnosis", lane: "music",
    question: "q1", expires_at: new Date(T0 - HOUR).toISOString(),
  });
  let actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.equal(actions[0].consecutive, 1);

  // Occurrence 2: answered on time (hum-answer's effect: a learnings row +
  // the pending slot cleared to null — simulated directly, never via the CLI).
  const t1 = T0 + 14 * 24 * HOUR;
  appendLearning(paths, {
    id: "qual-music-20260615", asked_at: new Date(t1 - HOUR).toISOString(),
    answered_at: new Date(t1).toISOString(), subject: "hum music decay",
    memory_hook: "hum_improvement_loop", question: "q2", answer: "wrong artists lately",
  });
  writePending(paths, null);
  actions = checkExpiredLaneDiagnosis({ now: t1, paths });
  assert.deepEqual(actions, []); // nothing expired this pass, but the streak reset internally

  // Occurrence 3: expires unanswered again — should be back to 1, not 3.
  const t2 = t1 + 14 * 24 * HOUR;
  writePending(paths, {
    id: "qual-music-20260629", category: "lane_diagnosis", lane: "music",
    question: "q3", expires_at: new Date(t2 - HOUR).toISOString(),
  });
  actions = checkExpiredLaneDiagnosis({ now: t2, paths });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].consecutive, 1);
  assert.equal(readTopic(paths, "music").enabled, true); // never quiesced
});

test("the global lane (global_decay_drop questions) is never quiesced", () => {
  const paths = freshPaths();
  writePending(paths, {
    id: "qual-global-20260601", category: "lane_diagnosis", lane: "global",
    question: "signal dropped", expires_at: new Date(T0 - HOUR).toISOString(),
  });
  const actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.deepEqual(actions, []);
  assert.equal(readInterventions(paths).length, 0);
});

test("an unexpired pending question is left alone", () => {
  const paths = freshPaths();
  writePending(paths, {
    id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks",
    question: "q1", expires_at: new Date(T0 + HOUR).toISOString(), // future
  });
  const actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.deepEqual(actions, []);
});

// --- Durable per-lane delivery record (regression coverage) ---
//
// Regression: hum-pending-question.json is a SHARED slot across every hum
// Q&A. The original checkExpiredLaneDiagnosis() only ever inspected whatever
// currently occupied that slot, so once a lane_diagnosis question got
// superseded by ANY other question before its own 24h TTL elapsed, its
// expiry became permanently invisible — auto-quiesce had fired for zero
// lanes in 4+ months live. These tests exercise the fix: a durable
// per-lane record written via recordLaneDiagnosisDelivered (mirroring what
// bin/hum-deliver-qual now does at delivery time) that survives the
// shared slot being overwritten.

function readQuiesceState(paths) { return JSON.parse(fs.readFileSync(paths.quiesceState, "utf8")); }

test("recordLaneDiagnosisDelivered stamps a durable outstanding record for the lane", () => {
  const paths = freshPaths();
  const rec = recordLaneDiagnosisDelivered({
    lane: "talks", id: "qual-talks-20260601", expiresAt: new Date(T0 + HOUR).toISOString(), now: T0, paths,
  });
  assert.equal(rec.id, "qual-talks-20260601");
  assert.equal(rec.expires_at, new Date(T0 + HOUR).toISOString());

  const state = readQuiesceState(paths);
  assert.equal(state.lanes.talks.outstanding.id, "qual-talks-20260601");
});

test("recordLaneDiagnosisDelivered no-ops for the global lane and for missing fields", () => {
  const paths = freshPaths();
  assert.equal(recordLaneDiagnosisDelivered({ lane: "global", id: "qual-global-20260601", expiresAt: new Date(T0).toISOString(), now: T0, paths }), null);
  assert.equal(recordLaneDiagnosisDelivered({ lane: "talks", id: null, expiresAt: new Date(T0).toISOString(), now: T0, paths }), null);
  assert.equal(recordLaneDiagnosisDelivered({ lane: "talks", id: "x", expiresAt: null, now: T0, paths }), null);
  assert.equal(fs.existsSync(paths.quiesceState), false);
});

test("a durable record catches expiry even after the shared pending slot is overwritten by an unrelated question", () => {
  const paths = freshPaths();
  recordLaneDiagnosisDelivered({
    lane: "talks", id: "qual-talks-20260601", expiresAt: new Date(T0 - HOUR).toISOString(), now: T0 - 25 * HOUR, paths,
  });
  // The shared slot has since moved on to a completely different question —
  // this is the exact scenario that made the old check permanently blind.
  writePending(paths, { id: "q-tick-999", category: "tick_question", question: "unrelated", expires_at: new Date(T0 + HOUR).toISOString() });

  const actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.deepEqual(actions, [{ type: "expired_unanswered", lane: "talks", id: "qual-talks-20260601", consecutive: 1 }]);
  assert.equal(readTopic(paths, "talks").enabled, true); // 1st occurrence only, not yet quiesced

  const state = readQuiesceState(paths);
  assert.equal(state.lanes.talks.outstanding, null); // consumed
});

test("2 consecutive durable-record expiries quiesce the lane, slot superseded both times", () => {
  const paths = freshPaths();
  recordLaneDiagnosisDelivered({ lane: "talks", id: "qual-talks-20260601", expiresAt: new Date(T0 - HOUR).toISOString(), now: T0 - 25 * HOUR, paths });
  writePending(paths, { id: "q-tick-1", category: "tick_question", question: "unrelated", expires_at: new Date(T0 + HOUR).toISOString() });
  checkExpiredLaneDiagnosis({ now: T0, paths });

  const t1 = T0 + 14 * 24 * HOUR;
  recordLaneDiagnosisDelivered({ lane: "talks", id: "qual-talks-20260615", expiresAt: new Date(t1 - HOUR).toISOString(), now: t1 - 25 * HOUR, paths });
  writePending(paths, { id: "q-tick-2", category: "tick_question", question: "unrelated", expires_at: new Date(t1 + HOUR).toISOString() });
  const actions = checkExpiredLaneDiagnosis({ now: t1, paths });

  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, "expired_unanswered");
  assert.equal(actions[0].consecutive, 2);
  assert.equal(actions[1].type, "quiesced");
  assert.equal(actions[1].lane, "talks");
  assert.equal(readTopic(paths, "talks").enabled, false);
});

test("an answer recorded in learnings clears the durable outstanding record so it never counts as expired", () => {
  const paths = freshPaths();
  recordLaneDiagnosisDelivered({ lane: "music", id: "qual-music-20260601", expiresAt: new Date(T0 + HOUR).toISOString(), now: T0 - HOUR, paths });
  appendLearning(paths, {
    id: "qual-music-20260601", asked_at: new Date(T0 - HOUR).toISOString(),
    answered_at: new Date(T0).toISOString(), subject: "hum music decay",
    memory_hook: "hum_improvement_loop", question: "q1", answer: "wrong artists lately",
  });

  // Even well past the original expiry, no expiry should ever be recorded —
  // the answer cleared the durable record before it could go stale.
  const later = T0 + 2 * HOUR;
  const actions = checkExpiredLaneDiagnosis({ now: later, paths });
  assert.deepEqual(actions, []);
  assert.equal(readQuiesceState(paths).lanes.music.outstanding, null);
});

test("durable record and legacy pending slot referring to the same id are not double-counted", () => {
  const paths = freshPaths();
  const expiresAt = new Date(T0 - HOUR).toISOString();
  recordLaneDiagnosisDelivered({ lane: "talks", id: "qual-talks-20260601", expiresAt, now: T0 - 25 * HOUR, paths });
  // The slot still happens to hold the very same lane_diagnosis question
  // (the common case — most questions never get superseded before expiry).
  writePending(paths, { id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks", question: "q1", expires_at: expiresAt });

  const actions = checkExpiredLaneDiagnosis({ now: T0, paths });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].consecutive, 1);
});

test("a positive reaction re-enables a quiesced lane", () => {
  const paths = freshPaths();
  const quiescedAt = new Date(T0).toISOString();
  fs.writeFileSync(paths.quiesceState, JSON.stringify({
    lanes: { talks: { consecutive_expired: 2, last_seen_id: "qual-talks-20260615", quiesced: true, quiesced_at: quiescedAt } },
  }));
  patchTopic(paths, "talks", { enabled: false, _paused_reason: "test seed", _paused_at: quiescedAt });

  appendFeedback(paths, {
    ping_id: "p-1", sent_at: new Date(T0 + HOUR).toISOString(), lane: "talks",
    reaction: "helpful", reaction_at: new Date(T0 + 2 * HOUR).toISOString(),
  });

  const actions = checkPositiveReactionReenable({ now: T0 + 3 * HOUR, paths });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "reenabled");
  assert.equal(actions[0].lane, "talks");

  const after = readTopic(paths, "talks");
  assert.equal(after.enabled, true);
  assert.equal(after._paused_reason, undefined);
  assert.equal(after._paused_at, undefined);

  const interventions = readInterventions(paths);
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].action, "enabled");
  assert.equal(interventions[0].trigger, "auto_lane_reenable");
});

test("a reaction predating the quiesce does not re-enable", () => {
  const paths = freshPaths();
  const quiescedAt = new Date(T0).toISOString();
  fs.writeFileSync(paths.quiesceState, JSON.stringify({
    lanes: { talks: { consecutive_expired: 2, quiesced: true, quiesced_at: quiescedAt } },
  }));
  patchTopic(paths, "talks", { enabled: false });

  appendFeedback(paths, {
    ping_id: "p-old", sent_at: new Date(T0 - 2 * HOUR).toISOString(), lane: "talks",
    reaction: "helpful", reaction_at: new Date(T0 - HOUR).toISOString(), // before quiesced_at
  });

  const actions = checkPositiveReactionReenable({ now: T0 + HOUR, paths });
  assert.deepEqual(actions, []);
  assert.equal(readTopic(paths, "talks").enabled, false);
});

test("quiesceLane / reenableLane manual calls are idempotent and reject unknown lanes", () => {
  const paths = freshPaths();

  const first = quiesceLane("talks", "manual test", { now: T0, paths });
  assert.equal(first.changed, true);
  assert.equal(readTopic(paths, "talks").enabled, false);

  const second = quiesceLane("talks", "manual test again", { now: T0 + HOUR, paths });
  assert.equal(second.changed, false);
  assert.equal(readInterventions(paths).length, 1); // no duplicate log

  const unknown = quiesceLane("nonexistent-lane", "x", { now: T0, paths });
  assert.equal(unknown, null);

  const re1 = reenableLane("talks", "bring back talks", { now: T0 + 2 * HOUR, paths });
  assert.equal(re1.changed, true);
  assert.equal(readTopic(paths, "talks").enabled, true);

  const re2 = reenableLane("talks", "bring back talks again", { now: T0 + 3 * HOUR, paths });
  assert.equal(re2.changed, false);

  const reUnknown = reenableLane("nonexistent-lane", "x", { now: T0, paths });
  assert.equal(reUnknown, null);
});

test("laneQuiesceStatus reports enabled state and streak per lane", () => {
  const paths = freshPaths();
  writePending(paths, {
    id: "qual-talks-20260601", category: "lane_diagnosis", lane: "talks",
    question: "q1", expires_at: new Date(T0 - HOUR).toISOString(),
  });
  checkExpiredLaneDiagnosis({ now: T0, paths });

  const rows = laneQuiesceStatus({ paths });
  const talks = rows.find((r) => r.lane === "talks");
  const music = rows.find((r) => r.lane === "music");
  assert.equal(talks.enabled, true);
  assert.equal(talks.consecutive_expired, 1);
  assert.equal(music.enabled, true);
  assert.equal(music.consecutive_expired, 0);
});
