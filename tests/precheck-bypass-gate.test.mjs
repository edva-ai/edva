// precheck-bypass-gate.test.mjs — --skip-precheck is an allowlist, not a flag.
//
// The precheck is the one universal chokepoint on everything Edva says to
// the user, and its bypass flag was unenforced: CLAUDE.md § Outbound Precheck
// named four permitted caller classes and anything could pass it anyway. The
// ping review traced its worst findings to gates being BYPASSED
// rather than gates being wrong, which is why this one is now checked.
//
// The gate keys on CHANNEL first, because that is what actually separates the
// legitimate bypassers from the rest: system-channel alerts report on the very
// infrastructure the precheck depends on, and improvements-channel approval
// cards are how a broken precheck gets fixed. Only the chat channel — the
// user-facing one the rule exists to protect — needs an intent allowlist.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND = path.join(ROOT, "bin/edva-send-curl");

// A throwaway HOME so nothing here can reach the real Supabase or logs. The
// gate runs long before any network call, so a fake key is enough.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-gate-"));
fs.mkdirSync(path.join(HOME, "Dev/edva/tools"), { recursive: true });
fs.writeFileSync(path.join(HOME, "Dev/edva/.env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
// A synthetic installation that adds its own brokerage intents to the kernel's
// edva-model-only list (agent/local/config/send-intents.json).
const LOCAL = path.join(HOME, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "config", "send-intents.json"), JSON.stringify({ extend_private_data_intents: ["brokerco", "brokerco-*"] }));

function send(args, env = {}) {
  try {
    const out = execFileSync(SEND, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000,
      env: { ...process.env, HOME, ...env },
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}

const REFUSED = /REFUSED: --skip-precheck is not available/;

test("a chat-channel bypass with no intent is refused", () => {
  const { err } = send(["--skip-precheck", "--no-push", "a finding about the user's day"]);
  assert.match(err, REFUSED);
});

test("a chat-channel bypass with an unlisted intent is refused", () => {
  // The shape that matters: a real content ping wearing a plausible label.
  const { err } = send(["--skip-precheck", "--intent", "hum:dining", "--no-push", "there's a good bakery here"]);
  assert.match(err, REFUSED);
});

test("the refusal tells the caller where the message actually belongs", () => {
  // An agent that hits this should learn the routing, not go looking for a
  // workaround — the two exempt channels are named in the error.
  const { err } = send(["--skip-precheck", "--no-push", "x"]);
  assert.match(err, /--channel system/);
  assert.match(err, /--channel improvements/);
});

test("the system channel is exempt — a supervisor must be able to report being stuck", () => {
  const { err } = send(["--channel", "system", "--skip-precheck", "--no-push", "⚠️ a job failed"]);
  assert.doesNotMatch(err, REFUSED);
});

test("the improvements channel is exempt — approval cards fix a broken precheck", () => {
  const { err } = send(["--channel", "improvements", "--skip-precheck", "--no-push", "🔧 a proposed fix"]);
  assert.doesNotMatch(err, REFUSED);
});

test("the allowlisted chat intents still pass", () => {
  for (const intent of ["hum-debug", "resilience-test", "health-alert", "brokerco-status"]) {
    const { err } = send(["--skip-precheck", "--intent", intent, "--no-push", "x"], { EDVA_LOCAL_DIR: LOCAL });
    assert.doesNotMatch(err, REFUSED, `intent "${intent}" should be exempt`);
  }
});

test("EDVA_PRECHECK_BYPASS=1 is the escape hatch for out-of-sandbox probers", () => {
  const { err } = send(["--skip-precheck", "--no-push", "x"], { EDVA_PRECHECK_BYPASS: "1" });
  assert.doesNotMatch(err, REFUSED);
});

test("a normal chat send is untouched — the gate only fires on the bypass flag", () => {
  // The failure mode to avoid is gating sends that were never bypassing
  // anything. No --skip-precheck, no refusal, whatever the intent.
  const { err } = send(["--intent", "hum:dining", "--no-push", "x"]);
  assert.doesNotMatch(err, REFUSED);
});

test("refusals are logged, so drift is visible instead of silent", () => {
  send(["--skip-precheck", "--intent", "some-new-job", "--no-push", "x"]);
  const log = path.join(HOME, "Dev/edva/data/logs/precheck-bypass-blocked.log");
  assert.ok(fs.existsSync(log), "expected a blocked-bypass log");
  assert.match(fs.readFileSync(log, "utf8"), /some-new-job/);
});
