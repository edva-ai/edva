import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DB = path.join(os.tmpdir(), `triage-decisions-test-${process.pid}.db`);
process.env.TRIAGE_DECISIONS_DB = DB;
const td = require("../lib/triage-decisions.js");
const { senderConsensusDetail } = await import("../lib/local-triage.mjs");

function fresh() { td._resetForTests(); for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB + s, { force: true }); }

function decided(id, from, label, { star = false, p1 = false, actor = "agent" } = {}) {
  td.register(id, from);
  process.env.EDVA_TRIAGE_ACTOR = actor;
  td.recordAction(id, "label", label);
  if (star) td.recordAction(id, "star");
  if (p1) td.recordAction(id, "label", "p1");
  if (!p1) td.recordAction(id, "mark-read");
  delete process.env.EDVA_TRIAGE_ACTOR;
}

test("priority is derived from the final Gmail state", () => {
  fresh();
  decided("m1", "A <a@x.com>", "vendor");
  decided("m2", "A <a@x.com>", "personal", { star: true });
  decided("m3", "A <a@x.com>", "personal", { star: true, p1: true });
  assert.equal(td.get("m1").priority, "P3");
  assert.equal(td.get("m2").priority, "P2");
  assert.equal(td.get("m3").priority, "P1");
  td.recordAction("m3", "unlabel", "p1"); td.recordAction("m3", "unstar");
  assert.equal(td.get("m3").priority, "P3", "the user's unstar/downgrade is reflected");
});

test("consensus is a GROUP BY on the sender address", () => {
  fresh();
  for (const i of [1, 2, 3]) decided(`n${i}`, "News <news@letter.com>", "vendor");
  const c = td.senderConsensus("Other Name <news@letter.com>");
  assert.equal(c.enough, true);
  assert.deepEqual(c.consensus, { label: "vendor", priority: "P3" });
  assert.equal(td.senderConsensus("someone@else.com").enough, false);
});

test("any P1/P2 for the sender → no consensus; too few rows → not enough", () => {
  fresh();
  decided("p1", "b@y.com", "personal"); decided("p2", "b@y.com", "personal");
  assert.equal(td.senderConsensus("b@y.com").enough, false);
  decided("p3", "b@y.com", "personal", { star: true });
  const c = td.senderConsensus("b@y.com");
  assert.equal(c.enough, true);
  assert.equal(c.consensus, null);
  assert.equal(c.reason, "mixed-or-urgent");
});

test("intake's own writes never count toward consensus", () => {
  fresh();
  for (const i of [1, 2, 3, 4]) decided(`i${i}`, "c@z.com", "vendor", { actor: "intake:gmail-source" });
  assert.equal(td.senderConsensus("c@z.com").enough, false);
});

test("register never overwrites a known sender; non-triage labels are ignored", () => {
  fresh();
  td.register("r1", "first@x.com");
  td.register("r1", "second@x.com");
  assert.equal(td.get("r1").sender_addr, "first@x.com");
  assert.equal(td.recordAction("r1", "label", "edva-out"), false);
});

test("senderConsensusDetail: structured rows win once there are enough, else email-mem", () => {
  fresh();
  for (const i of [1, 2, 3]) decided(`s${i}`, "d@w.com", "vendor");
  const s = senderConsensusDetail("  #1: P3 personal from d@w.com", { from: "d@w.com" });
  assert.equal(s.source, "triage-decisions");
  assert.equal(s.consensus.label, "vendor");
  const m = senderConsensusDetail("  #1: triaged P3 personal from e@w.com", { from: "e@w.com" });
  assert.equal(m.source, "email-mem");
  assert.equal(m.consensus.label, "personal");
});
