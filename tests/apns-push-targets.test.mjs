// apns-push-targets.test.mjs — a visible push goes only to the device class
// the user is actively using (active on the Mac → no phone buzz, and vice
// versa), and to every device when no lease is live.

import test from "node:test";
import assert from "node:assert/strict";
import { selectPushTargets, deviceClass } from "../lib/apns-push.mjs";

const now = 1_800_000_000_000;
const live = new Date(now + 60_000).toISOString();
const lapsed = new Date(now - 1_000).toISOString();
const rows = (mac, phone) => [
  { token: "mac1", platform: "macos", active_until: mac },
  { token: "ios1", platform: "ios", active_until: phone },
  { token: "ios2", platform: "ios", active_until: null },
  { token: "pad1", platform: "ipados", active_until: null },
];
const tokens = (r) => r.map((x) => x.token);

test("deviceClass: macos is mac; ios, ipados and a legacy null platform are mobile", () => {
  assert.equal(deviceClass({ platform: "macos" }), "mac");
  assert.equal(deviceClass({ platform: "ios" }), "mobile");
  assert.equal(deviceClass({ platform: "ipados" }), "mobile");
  assert.equal(deviceClass({}), "mobile");
});

test("active on the Mac → Mac only", () => {
  assert.deepEqual(tokens(selectPushTargets(rows(live, null), now)), ["mac1"]);
});

test("active on the phone → every mobile device, no Mac", () => {
  assert.deepEqual(tokens(selectPushTargets(rows(lapsed, live), now)), ["ios1", "ios2", "pad1"]);
});

test("no live lease → every device (a crashed or asleep app never swallows a ping)", () => {
  assert.deepEqual(tokens(selectPushTargets(rows(lapsed, lapsed), now)), ["mac1", "ios1", "ios2", "pad1"]);
  assert.deepEqual(tokens(selectPushTargets(rows(null, null), now)), ["mac1", "ios1", "ios2", "pad1"]);
});

test("live on both → every device", () => {
  assert.equal(selectPushTargets(rows(live, live), now).length, 4);
});

test("null / empty rows → empty", () => {
  assert.deepEqual(selectPushTargets(null, now), []);
  assert.deepEqual(selectPushTargets([], now), []);
});
