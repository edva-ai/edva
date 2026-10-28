// test-run-send-guard.test.mjs — a test run can never post into the real chat.
//
// `node --test` sets NODE_TEST_CONTEXT in every test process, and whatever a
// test spawns inherits it. Inside such a run:
//   - loadEnv() (lib/load-env.js) never lets the live service-role key
//     into process.env: not from the .env file, and an inherited one is dropped
//     when it is a real credential by shape; a test's own stand-in key is kept.
//   - edva-send-curl runs its gates and then refuses (exit 9) before the P1
//     fold, the insert, the push and the email fallback, unless the test names
//     a stand-in transport with EDVA_SEND_TEST_CURL.
//   - edva-send.mjs refuses outright (exit 9).
//   - apns-push sendOne refuses before connecting to Apple.
// Outside a test run all of it behaves exactly as before.
//
// Run: node --test tests/test-run-send-guard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadEnv, underTestRunner, isLiveServiceRoleKey } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");
const SEND_CURL = path.join(KERNEL, "bin/edva-send-curl");
const SEND_MJS = path.join(KERNEL, "bin/edva-send.mjs");
const KEY = "SUPABASE_SERVICE_ROLE_KEY";

// Stand-ins built at run time, so no credential-shaped literal sits in the
// source: one shaped like the live legacy key (a JWT whose payload says
// service_role, unsigned), one like the new-style secret key, one anon-shaped.
const jwt = (payload) => [{ alg: "HS256", typ: "JWT" }, payload]
  .map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".not-a-signature";
const LIVE_SHAPED = jwt({ iss: "supabase", ref: "example", role: "service_role" });
const NEW_STYLE = ["sb", "secret", "x".repeat(24)].join("_");
const ANON_SHAPED = jwt({ iss: "supabase", ref: "example", role: "anon" });

// The env a test-spawned child inherits, minus a real key, with EDVA_HOME
// (when the caller sets one) at a throwaway installation.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!("EDVA_HOME" in extra)) delete env.EDVA_HOME;
  for (const k of [KEY, "SUPABASE_ANON_KEY"]) if (!(k in extra)) delete env[k];
  return env;
}

// A throwaway installation: a .env holding a stand-in key, and a fake curl
// first on PATH that records every call, so any network write shows up.
function sandbox(envKey = "fake") {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-guard-"));
  const data = (f = "") => path.join(h, KERNEL_SUBDIR, "data", f);
  fs.mkdirSync(data(), { recursive: true });
  fs.writeFileSync(path.join(h, KERNEL_SUBDIR, ".env"), `${KEY}=${envKey}\n`);
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' "\${FAKE_HTTP:-201}"\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const record = path.join(h, "curl.txt");
  const run = (args, extra = {}) => spawnSync(SEND_CURL, args, {
    encoding: "utf8", timeout: 20_000,
    env: childEnv({ HOME: h, EDVA_HOME: h, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record, ...extra }),
  });
  const calls = () => { try { return fs.readFileSync(record, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  return { h, data, fakeBin, run, calls };
}

// The guards key on NODE_TEST_CONTEXT, which only node --test's default
// process isolation sets: a direct run or --test-isolation=none has none.
const ISOLATED = underTestRunner();
const needsRunner = { skip: !ISOLATED && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

test("node --test marks this process and what it spawns, which is what every guard keys on", needsRunner, () => {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.NODE_TEST_CONTEXT || '')"], { encoding: "utf8" });
  assert.ok(r.stdout, "a child spawned from a test does not inherit NODE_TEST_CONTEXT");
});

test("a live service-role key is recognised by shape; a test's stand-in is not", () => {
  assert.equal(isLiveServiceRoleKey(LIVE_SHAPED), true);
  assert.equal(isLiveServiceRoleKey(NEW_STYLE), true);
  for (const v of [ANON_SHAPED, "fake", "test-key", "decoy-key", "", undefined, "a.b.c"]) {
    assert.equal(isLiveServiceRoleKey(v), false, String(v));
  }
});

test("loadEnv in a test run: the key never comes from the file, a live inherited one is dropped, a stand-in stays", needsRunner, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `${KEY}=${LIVE_SHAPED}\nTEST_RUN_GUARD_OTHER=1\n`);
  const saved = process.env[KEY];
  try {
    delete process.env[KEY];
    delete process.env.TEST_RUN_GUARD_OTHER;
    loadEnv(file);
    assert.equal(process.env[KEY], undefined, "the key was loaded from the file inside a test run");
    assert.equal(process.env.TEST_RUN_GUARD_OTHER, "1", "the rest of the file still loads");

    process.env[KEY] = LIVE_SHAPED;
    loadEnv(file);
    assert.equal(process.env[KEY], undefined, "an inherited live key survived loadEnv inside a test run");

    process.env[KEY] = "test-dummy-key";
    loadEnv(file);
    assert.equal(process.env[KEY], "test-dummy-key", "a test's own stand-in key must be left alone");
  } finally {
    if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
    delete process.env.TEST_RUN_GUARD_OTHER;
  }
});

test("loadEnv outside a test run is unchanged: the file supplies the key, an inherited one wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `${KEY}=${LIVE_SHAPED}\n`);
  const probe = `const { loadEnv } = require(${JSON.stringify(path.join(KERNEL, "lib/load-env.js"))});
loadEnv(${JSON.stringify(file)}); process.stdout.write(process.env.${KEY} || "<none>");`;
  const env = childEnv();
  delete env.NODE_TEST_CONTEXT;
  const fromFile = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env });
  assert.equal(fromFile.stdout, LIVE_SHAPED);
  const inherited = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env: { ...env, [KEY]: "from-env" } });
  assert.equal(inherited.stdout, "from-env");
});

test("edva-send-curl in a test run refuses before any network call, whatever key it finds", needsRunner, () => {
  for (const key of ["fake", LIVE_SHAPED]) {
    const box = sandbox(key);
    const chat = box.run(["--no-push", "a reply from inside a test"], { [KEY]: key });
    assert.equal(chat.status, 9, chat.stderr);
    assert.match(chat.stderr, /not sent — this is a test run/); // lang-regex-ok: the tool's own fixed refusal text, not a person's words
    assert.ok(!chat.stdout.includes("Message sent"));
    const sys = box.run(["--channel", "system", "--skip-precheck", "--no-push", "⚠️ routine notice from a test"]);
    assert.equal(sys.status, 9, sys.stderr);
    assert.deepEqual(box.calls(), [], "curl was called: a test reached the network");
    assert.ok(!fs.existsSync(box.data("system-channel-spool.jsonl")), "nothing parked for a later replay");
  }
});

test("edva-send-curl's gates still run in a test run, ahead of the refusal", needsRunner, () => {
  const box = sandbox();
  const r = box.run(["--skip-precheck", "--no-push", "a finding about the user's day"]);
  assert.match(r.stderr, /REFUSED: --skip-precheck is not available/);
  assert.notEqual(r.status, 9);
  assert.deepEqual(box.calls(), []);
});

test("edva-send-curl posts through a named stand-in only; no push, no stamp, no email, nothing parked", needsRunner, () => {
  const box = sandbox();
  const ok = box.run(["--channel", "system", "--skip-precheck", "⚠️ routine notice from a test"], { EDVA_SEND_TEST_CURL: path.join(box.fakeBin, "curl") });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Message sent to Edva/); // lang-regex-ok: the tool's own fixed success line, not a person's words
  assert.equal(box.calls().length, 1);
  assert.ok(!fs.existsSync(box.data("last-edva-message-at.json")), "a test-run send stamped the live outbound clock");

  const bad = box.run(["--channel", "system", "--skip-precheck", "⚠️ routine notice from a test"], { EDVA_SEND_TEST_CURL: path.join(box.fakeBin, "curl"), FAKE_HTTP: "500" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /test run, nothing parked, no fallback email/);
  assert.ok(!fs.existsSync(box.data("system-channel-spool.jsonl")), "a failed test-run send was parked for replay");
});

let supabaseJs = true;
try { createRequire(SEND_MJS).resolve("@supabase/supabase-js"); } catch { supabaseJs = false; }

test("edva-send.mjs refuses in a test run", { skip: needsRunner.skip || (!supabaseJs && "@supabase/supabase-js is not installed next to bin") }, () => {
  const box = sandbox();
  const r = spawnSync(process.execPath, [SEND_MJS, "a reply from inside a test"], {
    encoding: "utf8", timeout: 20_000, env: childEnv({ HOME: box.h, EDVA_HOME: box.h, [KEY]: LIVE_SHAPED }),
  });
  assert.equal(r.status, 9, r.stderr);
  assert.match(r.stderr, /not sent — this is a test run/);
  assert.ok(!r.stdout.includes("Message sent"));
});

test("apns-push sendOne refuses before connecting to Apple", needsRunner, async () => {
  const { sendOne } = await import("../lib/apns-push.mjs");
  await assert.rejects(sendOne("jwt", "0".repeat(64), "{}"), /not sent — this is a test run/);
});
