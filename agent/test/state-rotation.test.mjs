// state-rotation.test.mjs — regression for a loop-mode rotation
// bug: rotateSession() minted a new sessionId but left everInitialized=true, so
// canResume reported a never-created session as resumable → a ~90s restart loop
// trying to `--resume` an id claude -p had never created.
//
// Run: node --test agent/test/state-rotation.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { State } from "../supervisor/state.mjs";

const TMP = path.join(os.tmpdir(), `state-rot-${process.pid}.json`);
function fresh() { try { fs.unlinkSync(TMP); } catch {} return new State(TMP); }

describe("State.rotateSession (resume-safety)", () => {
  after(() => { try { fs.unlinkSync(TMP); } catch {} });

  it("a rotated session is NOT resumable until it re-initializes", () => {
    const s = fresh();
    s.markInitialized();
    assert.equal(s.canResume, true, "an initialized session is resumable");
    const oldId = s.sessionId;

    s.rotateSession();
    assert.notEqual(s.sessionId, oldId, "rotate mints a new session id");
    assert.equal(s.canResume, false, "the brand-new id must NOT be resumable yet");

    // Once the new session actually comes up, resume is allowed again.
    s.markInitialized();
    assert.equal(s.canResume, true);
  });

  it("persists everInitialized=false across a reload (survives a restart)", () => {
    const s = fresh();
    s.markInitialized();
    s.rotateSession();
    // Simulate the supervisor restarting and re-reading state from disk.
    const reloaded = new State(TMP);
    assert.equal(reloaded.canResume, false, "a reloaded rotated session stays non-resumable");
  });

  it("a never-initialized fresh session is not resumable", () => {
    const s = fresh();
    assert.equal(s.canResume, false);
  });
});

// The rotation cap counts DISPATCHES. It used to read totalTurns
// (num_turns summed — tool steps), so one 20-step job exhausted a cap of 20.
describe("State dispatch counting (rotation cap)", () => {
  after(() => { try { fs.unlinkSync(TMP); } catch {} });

  it("counts one dispatch per result with work, however many tool turns it took", () => {
    const s = fresh();
    s.recordResult({ costUsd: 0.5, turns: 25 });
    s.recordResult({ costUsd: 0.1, turns: 1 });
    assert.equal(s.dispatches, 2);
    assert.equal(s.data.totalTurns, 26, "tool-step total is still kept for telemetry");
  });

  it("does not count zero-turn results (phantoms, resume handshakes)", () => {
    const s = fresh();
    s.recordResult({ costUsd: 0, turns: 0 });
    assert.equal(s.dispatches, 0);
  });

  it("resets on rotation and reads 0 from a pre-counter state file", () => {
    const s = fresh();
    s.recordResult({ costUsd: 0.1, turns: 3 });
    s.rotateSession();
    assert.equal(s.dispatches, 0);
    fs.writeFileSync(TMP, JSON.stringify({ sessionId: "legacy", totalTurns: 100, everInitialized: true }));
    assert.equal(new State(TMP).dispatches, 0, "legacy totalTurns must not count as dispatches");
  });
});

describe("State floor (kept across a restart that resumes the session)", () => {
  after(() => { try { fs.unlinkSync(TMP); } catch {} });

  it("a recorded floor survives a reload for the same session", () => {
    const s = fresh();
    s.recordFloor(s.sessionId, 118043);
    const reloaded = new State(TMP);
    assert.equal(reloaded.floorFor(reloaded.sessionId), 118043);
  });

  it("a rotated session does not inherit the old floor", () => {
    const s = fresh();
    s.recordFloor(s.sessionId, 118043);
    s.rotateSession();
    assert.equal(s.floorFor(s.sessionId), 0, "a new session measures its own floor");
  });

  it("no recorded floor reads as unmeasured", () => {
    const s = fresh();
    assert.equal(s.floorFor(s.sessionId), 0);
    assert.equal(s.floorFor("some-other-session"), 0);
  });
});
