// turn-watchdog.test.mjs — the shared per-turn hang watchdog. Timers are
// injected (a fake scheduler) so we assert the arm/clear/fire logic without
// real time.
//
// Run: node --test agent/test/turn-watchdog.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TurnWatchdog,
  watchdogMsFor,
  isInteractiveSource,
  TURN_WATCHDOG_MS_DEFAULT,
  TURN_WATCHDOG_MS_JOB_DEFAULT,
  INTERACTIVE_SOURCES,
} from "../supervisor/turn-watchdog.mjs";

// A fake timer scheduler: setTimer records {fn, ms}; fire(handle) advances the
// virtual clock by the handle's delay and invokes it. The
// watchdog decides on its own clock (idle / window / ceiling, see
// turn-watchdog.mjs), so a fired timer must also move `now` — otherwise the
// wake sees zero elapsed time and correctly re-arms instead of firing.
function fakeClock() {
  const pending = new Set();
  let t = 1_000_000;
  return {
    setTimer: (fn, ms) => { const h = { fn, ms }; pending.add(h); return h; },
    clearTimer: (h) => { pending.delete(h); },
    fire: (h) => { if (pending.has(h)) { pending.delete(h); t += h.ms; h.fn(); } },
    now: () => t,
    pending,
  };
}

describe("watchdogMsFor", () => {
  it("returns the per-source override, else the default", () => {
    const thresholds = { "daily-summary": 20 * 60_000 };
    assert.equal(watchdogMsFor("daily-summary", { thresholds }), 20 * 60_000);
    assert.equal(watchdogMsFor("edva", { thresholds }), TURN_WATCHDOG_MS_DEFAULT);
  });

  // Regression guard for the "⚠️ Ops turn from <job> hung for 10min with no
  // result" pages. Source after source hit this and was silenced one map entry
  // at a time, each provably mid-work when killed. An unregistered source must
  // now inherit the job window, not the interactive one.
  it("gives an unregistered background source the job default, not the 10-min leash", () => {
    assert.equal(watchdogMsFor("release-watcher", {}), TURN_WATCHDOG_MS_JOB_DEFAULT);
    assert.equal(watchdogMsFor("cron-hum-improvement-ideation-weekly", {}), TURN_WATCHDOG_MS_JOB_DEFAULT);
    assert.equal(watchdogMsFor("some-watcher-invented-next-month", {}), TURN_WATCHDOG_MS_JOB_DEFAULT);
    assert.ok(TURN_WATCHDOG_MS_JOB_DEFAULT > TURN_WATCHDOG_MS_DEFAULT);
  });

  it("keeps the short leash for sources a human is waiting on", () => {
    assert.equal(watchdogMsFor("edva", {}), TURN_WATCHDOG_MS_DEFAULT);
    assert.equal(watchdogMsFor("gmail:fake-msg-a01", {}), TURN_WATCHDOG_MS_DEFAULT);
    // A missing source is a bug, not a job — short leash so it cannot quietly
    // hold the queue for the longer window.
    assert.equal(watchdogMsFor(undefined, {}), TURN_WATCHDOG_MS_DEFAULT);
    assert.equal(watchdogMsFor("", {}), TURN_WATCHDOG_MS_DEFAULT);
  });

  it("an explicit override still wins over both defaults", () => {
    const thresholds = { "nightly-review": 55 * 60_000, "edva": 3 * 60_000 };
    assert.equal(watchdogMsFor("nightly-review", { thresholds }), 55 * 60_000);
    assert.equal(watchdogMsFor("edva", { thresholds }), 3 * 60_000);
  });

  it("isInteractiveSource classifies the documented set", () => {
    for (const s of INTERACTIVE_SOURCES) assert.equal(isInteractiveSource(s), true, s);
    assert.equal(isInteractiveSource("gmail:abc123"), true);
    assert.equal(isInteractiveSource("catalog-watch"), false);
    assert.equal(isInteractiveSource("context-guard"), false);
    // Regression guard for a dropped request: a chat-agent dispatch is handed
    // to ops BECAUSE it is heavy, so it gets the job window, not the 10-min
    // interactive leash that killed it twice and then dropped it.
    assert.equal(isInteractiveSource("chat-agent"), false);
    assert.equal(watchdogMsFor("chat-agent", {}), TURN_WATCHDOG_MS_JOB_DEFAULT);
  });
});

describe("TurnWatchdog", () => {
  it("fires onFire with the item + window after the turn's window elapses", () => {
    const clock = fakeClock();
    const fired = [];
    const wd = new TurnWatchdog({ onFire: (item, ms) => fired.push([item.id, ms]), setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    const handle = [...clock.pending][0]; // none yet
    assert.equal(handle, undefined);
    wd.arm({ id: "t1", source: "edva" });
    assert.equal(wd.armed, true);
    clock.fire([...clock.pending][0]);
    assert.deepEqual(fired, [["t1", TURN_WATCHDOG_MS_DEFAULT]]);
    assert.equal(wd.armed, false, "disarms itself before firing");
  });

  it("clear() cancels a pending turn — onFire never runs (the happy path: result arrived)", () => {
    const clock = fakeClock();
    let fired = 0;
    const wd = new TurnWatchdog({ onFire: () => fired++, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    wd.arm({ id: "t1", source: "edva" });
    wd.clear();
    assert.equal(wd.armed, false);
    assert.equal(clock.pending.size, 0, "timer removed");
    assert.equal(fired, 0);
  });

  it("re-arming clears the prior turn's timer (no leak, only the latest fires)", () => {
    const clock = fakeClock();
    const fired = [];
    const wd = new TurnWatchdog({ onFire: (item) => fired.push(item.id), setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    wd.arm({ id: "t1", source: "edva" });
    wd.arm({ id: "t2", source: "edva" });
    assert.equal(clock.pending.size, 1, "only one live timer after re-arm");
    clock.fire([...clock.pending][0]);
    assert.deepEqual(fired, ["t2"], "only the latest turn fires");
  });

  it("honors per-source thresholds when arming", () => {
    const clock = fakeClock();
    const wd = new TurnWatchdog({ thresholds: { "weekly-deep-review": 30 * 60_000 }, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    const ms = wd.arm({ id: "t1", source: "weekly-deep-review" });
    assert.equal(ms, 30 * 60_000);
  });

  it("arms a background job on the job window, an interactive turn on the short one", () => {
    const clock = fakeClock();
    const wd = new TurnWatchdog({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    assert.equal(wd.arm({ id: "t1", source: "release-watcher" }), TURN_WATCHDOG_MS_JOB_DEFAULT);
    assert.equal(wd.arm({ id: "t2", source: "edva" }), TURN_WATCHDOG_MS_DEFAULT);
  });

  it("a caller may still pin both windows explicitly", () => {
    const clock = fakeClock();
    const wd = new TurnWatchdog({ defaultMs: 60_000, jobDefaultMs: 90_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    assert.equal(wd.arm({ id: "t1", source: "edva" }), 60_000);
    assert.equal(wd.arm({ id: "t2", source: "cron-whatever" }), 90_000);
  });

  it("arm(null) is a no-op (clears, arms nothing)", () => {
    const clock = fakeClock();
    const wd = new TurnWatchdog({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    wd.arm({ id: "t1", source: "x" });
    wd.arm(null);
    assert.equal(wd.armed, false);
    assert.equal(clock.pending.size, 0);
  });

  it("onFire that throws does not crash the watchdog", () => {
    const clock = fakeClock();
    const wd = new TurnWatchdog({ onFire: () => { throw new Error("boom"); }, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
    wd.arm({ id: "t1", source: "x" });
    assert.doesNotThrow(() => clock.fire([...clock.pending][0]));
    assert.equal(wd.armed, false);
  });
});
