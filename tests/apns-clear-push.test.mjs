// apns-clear-push.test.mjs — read on one device takes the banner off the
// others (a notification viewed on the phone shouldn't buzz the Mac a few
// seconds later, and the reverse). sendApnsPush
// records which device classes a message's push reached; sendClearPush wakes
// exactly those with {kind: "clear_notifications", message_ids, badge}.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPushRecipients, pushRecipients, sendClearPush } from "../lib/apns-push.mjs";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "push-rcpt-")), "push-recipients.json");
const fakeSupabase = (rows) => ({ from: () => ({ select: async () => ({ data: rows, error: null }) }) });
const rows = [
  { token: "mac1111111", platform: "macos" },
  { token: "ios1111111", platform: "ios" },
  { token: "pad1111111", platform: "ipados" },
];
const recorder = () => {
  const calls = [];
  const send = async (jwt, token, payload, headers) => { calls.push({ token, payload: JSON.parse(payload), headers }); return { status: 200, body: "" }; };
  return { calls, send };
};

test("recordPushRecipients merges classes per message and drops entries older than 7 days", () => {
  const file = tmpFile();
  const now = Date.parse("2026-01-15T09:00:00Z");
  recordPushRecipients("old", ["mobile"], { file, nowMs: now - 8 * 86_400_000 });
  recordPushRecipients("m1", ["mobile"], { file, nowMs: now });
  recordPushRecipients("m1", ["mac"], { file, nowMs: now });
  assert.deepEqual(pushRecipients("m1", { file }), ["mac", "mobile"]);
  assert.deepEqual(pushRecipients("old", { file }), []);
  assert.deepEqual(pushRecipients("never", { file }), []);
});

test("sendClearPush wakes only the device classes that got the banner", async () => {
  const file = tmpFile();
  recordPushRecipients("m1", ["mobile"], { file });
  const { calls, send } = recorder();
  const r = await sendClearPush(fakeSupabase(rows), ["m1", "unpushed"], { send, jwt: "j", file, badge: 2 });
  assert.equal(r.delivered, true);
  assert.deepEqual(calls.map((c) => c.token), ["ios1111111", "pad1111111"]);
  assert.deepEqual(calls[0].payload, { kind: "clear_notifications", message_ids: ["m1"], badge: 2, aps: { "content-available": 1 } });
  assert.equal(calls[0].headers["apns-push-type"], "background");
});

test("sendClearPush reaches the Mac when the Mac got the banner", async () => {
  const file = tmpFile();
  recordPushRecipients("m1", ["mac", "mobile"], { file });
  const { calls, send } = recorder();
  await sendClearPush(fakeSupabase(rows), ["m1"], { send, jwt: "j", file, badge: 0 });
  assert.deepEqual(calls.map((c) => c.token), ["mac1111111", "ios1111111", "pad1111111"]);
});

test("sendClearPush sends nothing for messages that never pushed", async () => {
  const { calls, send } = recorder();
  const r = await sendClearPush(fakeSupabase(rows), ["x"], { send, jwt: "j", file: tmpFile(), badge: 0 });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, "never pushed");
  assert.equal(calls.length, 0);
});
