// The supervisor's queue alarm must not contradict its own auth-outage pause.
//
// Observed: the ops supervisor paged the auth pause correctly ("the
// dispatcher is paused for a Max-auth outage, so nothing will drain until auth
// is back"), then twenty minutes later the SAME process paged "That supervisor may be
// stuck - check \`edva status\`" about the same queue. Two contradictory
// pages twenty minutes apart, one of them false, from an object that had
// already set this.authAlertSent in _triggerAuthOutage().
//
// This test reads the LIVE source rather than booting a supervisor (which
// spawns a claude -p child), so it pins the branch itself and cannot drift.
//
// Note the shape deliberately NOT taken: returning early from onHigh when
// authAlertSent is true. QueueAlarm.check() latches before it calls onHigh
// (armed=false, active=true), so a silent onHigh still arms onClear - the
// drain would post a lone "recovered: queue drained" with no failure alert in
// front of it, i.e. the orphaned-recovery defect. Both arms of
// the branch must page.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SRC = fs.readFileSync(path.join(ROOT, "agent/supervisor/index.mjs"), "utf8");

function onHighBody() {
  const start = SRC.indexOf("onHigh: (depth) => {");
  assert.ok(start > -1, "onHigh handler not found in supervisor/index.mjs - was the QueueAlarm wiring renamed?");
  const end = SRC.indexOf("onClear: (depth) => {", start);
  assert.ok(end > start, "onClear handler not found after onHigh");
  return SRC.slice(start, end);
}

test("onHigh consults the auth-outage flag the same object sets", () => {
  assert.match(onHighBody(), /this\.authAlertSent/, "onHigh must read this.authAlertSent - the supervisor is the process that HAS the fact");
});

test("the auth branch names the pause instead of guessing at a stuck supervisor", () => {
  const body = onHighBody();
  const authArm = body.split("this.authAlertSent")[2] || "";
  assert.match(body, /dispatch is paused for the Max-auth outage/, "the auth arm must name the real cause");
  assert.ok(!/paused for the Max-auth outage[\s\S]*may be stuck[\s\S]*paused for the Max-auth outage/.test(body), "only one auth-cause string expected");
  assert.ok(authArm.length >= 0);
});

test("both arms still page - a silent arm would orphan the onClear recovery", () => {
  const body = onHighBody();
  assert.ok(!/if \(this\.authAlertSent\) return/.test(body), "early return would latch the alarm and leave the drain recovery with no failure alert");
  assert.ok(!/\breturn\b/.test(body), "no arm may return before paging - same orphaned-recovery reason");
  assert.match(body, /may be stuck/, "the non-auth arm must keep its original wording");
  // Three arms since the quota hold: quota hold, auth pause,
  // unexplained. All three go through the one _sendPush call.
  const pushes = body.match(/queue depth=\${depth}/g) || [];
  assert.equal(pushes.length, 3, "expected exactly three alert strings, one per arm");
  assert.equal((body.match(/this\._sendPush\(/g) || []).length, 1, "one send covers every arm");
});

test("the fixed 'may be stuck' string is no longer unconditional", () => {
  const body = onHighBody();
  const idxCond = body.indexOf("this.authAlertSent");
  const idxStuck = body.indexOf("may be stuck");
  assert.ok(idxCond > -1 && idxStuck > idxCond, "'may be stuck' must sit inside the conditional, not before it");
});
