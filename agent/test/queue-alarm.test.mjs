// queue-alarm.test.mjs — the shared queue-backlog alarm hysteresis. Notifiers
// are injected so we assert the arm/fire/clear logic without a live supervisor.
//
// Run: node --test agent/test/queue-alarm.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueueAlarm, CHAT_QUEUE_ALARM_HIGH, CHAT_QUEUE_ALARM_CLEAR } from "../supervisor/queue-alarm.mjs";

function make(overrides = {}) {
  const highs = [], clears = [];
  const alarm = new QueueAlarm({
    high: 12,
    clear: 4,
    onHigh: (d) => highs.push(d),
    onClear: (d) => clears.push(d),
    ...overrides,
  });
  return { alarm, highs, clears };
}

describe("QueueAlarm", () => {
  it("defaults to armed, not active", () => {
    const { alarm } = make();
    assert.equal(alarm.armed, true);
    assert.equal(alarm.active, false);
  });

  it("fires onHigh once when depth crosses high", () => {
    const { alarm, highs } = make();
    alarm.check(13);
    assert.deepEqual(highs, [13]);
    assert.equal(alarm.active, true);
    assert.equal(alarm.armed, false);
  });

  it("does NOT re-fire onHigh while still backed up (no flap)", () => {
    const { alarm, highs } = make();
    alarm.check(13);
    alarm.check(20);
    alarm.check(15);
    assert.deepEqual(highs, [13], "only the first crossing pages");
  });

  it("does not fire between clear and high (hysteresis band)", () => {
    const { alarm, highs, clears } = make();
    alarm.check(8); // between 4 and 12
    assert.deepEqual(highs, []);
    assert.deepEqual(clears, []);
    assert.equal(alarm.armed, true, "stays armed in the band");
  });

  it("fires onClear once when it drains below clear after an alarm", () => {
    const { alarm, highs, clears } = make();
    alarm.check(13);      // alarm
    alarm.check(8);       // still in band — no clear yet
    assert.deepEqual(clears, []);
    alarm.check(3);       // below clear → recovery
    assert.deepEqual(clears, [3]);
    assert.equal(alarm.active, false);
    assert.equal(alarm.armed, true);
  });

  it("does NOT fire onClear if it was never alarmed", () => {
    const { alarm, clears } = make();
    alarm.check(2); // low from the start
    assert.deepEqual(clears, []);
  });

  it("re-arms for a second full cycle", () => {
    const { alarm, highs, clears } = make();
    alarm.check(13); alarm.check(2);   // cycle 1
    alarm.check(13); alarm.check(2);   // cycle 2
    assert.deepEqual(highs, [13, 13]);
    assert.deepEqual(clears, [2, 2]);
  });

  it("exactly at a threshold does not trigger (strict > / <)", () => {
    const { alarm, highs, clears } = make();
    alarm.check(12); // == high, not > high
    assert.deepEqual(highs, []);
    alarm.check(13);
    alarm.check(4);  // == clear, not < clear
    assert.deepEqual(clears, []);
  });

  it("a throwing notifier does not break state transitions", () => {
    const { alarm } = make({ onHigh: () => { throw new Error("boom"); } });
    assert.doesNotThrow(() => alarm.check(13));
    assert.equal(alarm.active, true, "state still advances despite notifier throw");
  });

  it("rejects a non-hysteretic config (high must exceed clear)", () => {
    assert.throws(() => new QueueAlarm({ high: 4, clear: 4 }));
    assert.throws(() => new QueueAlarm({ high: 3, clear: 10 }));
  });

  it("exports sane chat defaults", () => {
    assert.ok(CHAT_QUEUE_ALARM_HIGH > CHAT_QUEUE_ALARM_CLEAR);
  });
});
