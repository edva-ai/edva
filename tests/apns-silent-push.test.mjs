// apns-silent-push.test.mjs — sendSilentPush wakes the iOS app
// for a photo probe: background push type, priority 5, content-available and
// no alert/badge/sound, macOS tokens skipped.

import test from "node:test";
import assert from "node:assert/strict";
import { sendSilentPush, isIosToken } from "../lib/apns-push.mjs";

const fakeSupabase = (rows, error = null) => ({
  from: () => ({ select: async () => ({ data: rows, error }) }),
});

test("isIosToken: ios/ipados/missing count, macos does not", () => {
  assert.equal(isIosToken({ platform: "ios" }), true);
  assert.equal(isIosToken({ platform: "ipados" }), true);
  assert.equal(isIosToken({}), true);
  assert.equal(isIosToken({ platform: "macos" }), false);
});

test("sendSilentPush sends a background payload to iOS tokens only", async () => {
  const calls = [];
  const send = async (jwt, token, payload, headers) => { calls.push({ jwt, token, payload: JSON.parse(payload), headers }); return { status: 200, body: "" }; };
  const r = await sendSilentPush(
    fakeSupabase([{ token: "aaaaaaaaaa", platform: "ios" }, { token: "mmmmmmmmmm", platform: "macos" }]),
    { kind: "sync_probe", probe_id: "p1" },
    { send, jwt: "j" },
  );
  assert.equal(r.delivered, true);
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "aaaaaaaaaa");
  assert.deepEqual(calls[0].payload, { kind: "sync_probe", probe_id: "p1", aps: { "content-available": 1 } });
  assert.equal(calls[0].headers["apns-push-type"], "background");
  assert.equal(calls[0].headers["apns-priority"], "5");
});

test("sendSilentPush reports no tokens without sending", async () => {
  let sent = 0;
  const r = await sendSilentPush(fakeSupabase([{ token: "m", platform: "macos" }]), {}, { send: async () => { sent++; return { status: 200 }; }, jwt: "j" });
  assert.equal(r.delivered, false);
  assert.equal(sent, 0);
  assert.match(r.reason, /no iOS device tokens/);
});
