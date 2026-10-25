// whatsapp-send — the em-dash gate on messages to the user's own number. The
// number comes from WHATSAPP_OWNER_NUMBER, or from an older env name an
// installation lists in local config whatsapp-send.json extend_owner_number_env.
// No runner: an unreachable WHATSAPP_RUNNER_URL means a message that passes the
// gate fails at the send, with a different error.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = new URL("../bin/whatsapp-send", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-send-"));
const local = path.join(tmp, "local");
fs.mkdirSync(path.join(local, "config"), { recursive: true });

function send(to, env) {
  const base = { PATH: process.env.PATH, HOME: tmp, MERLIN_LOCAL_DIR: local, WHATSAPP_RUNNER_URL: "http://127.0.0.1:9" };
  return spawnSync(process.execPath, [BIN, "--to", to, "--text", "one — two"], { env: { ...base, ...env }, encoding: "utf8" });
}
const gated = (r) => r.status === 1 && /em\/en dash found/.test(r.stderr);

test("WHATSAPP_OWNER_NUMBER: dashes to the user's number are refused, to others not gated", () => {
  assert.ok(gated(send("+1 555 010 0001", { WHATSAPP_OWNER_NUMBER: "+15550100001" })));
  const other = send("+15550100002", { WHATSAPP_OWNER_NUMBER: "+15550100001" });
  assert.ok(!gated(other) && /runner unreachable/.test(other.stderr));
  assert.ok(!gated(send("+15550100001", { WHATSAPP_OWNER_NUMBER: "+15550100001", WHATSAPP_ALLOW_DASHES: "1" })));
});

test("an older env name listed in local config is honoured; unlisted, it is not", () => {
  assert.ok(!gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001" })));
  fs.writeFileSync(path.join(local, "config", "whatsapp-send.json"), JSON.stringify({ extend_owner_number_env: ["OLD_OWNER_WA"] }));
  assert.ok(gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001" })));
  // the generic name still wins when both are set
  assert.ok(!gated(send("+15550100001", { OLD_OWNER_WA: "+15550100001", WHATSAPP_OWNER_NUMBER: "+15550100009" })));
  fs.rmSync(path.join(local, "config", "whatsapp-send.json"));
});
