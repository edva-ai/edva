// sms-send — the guards (identity opener, --authorized, E.164, test-run
// refusal) and the send/status path against a stand-in Twilio API, checking
// that no credential reaches stdout, stderr or the sent log.
//
// Run: node --test tests/sms-send.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { parseArgs, isE164, isMessageSid, hasIdentityOpener, FINAL_STATUSES } from "../lib/sms-core.mjs";

const BIN = new URL("../bin/sms-send", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sms-send-"));
const local = path.join(tmp, "local");
fs.mkdirSync(path.join(local, "config"), { recursive: true });
const LOG = path.join(tmp, "data", "sms-sent.jsonl");

const SID = "AC" + "0".repeat(32);
const TOKEN = "f".repeat(32);
const MSG_SID = "SM" + "a".repeat(32);
const OK_TEXT = "Hi Dana, this is Edva, Alex's AI assistant. Alex asked me to text you. Please call back when you can.";

function run(args, env = {}) {
  const base = {
    PATH: process.env.PATH, HOME: tmp, EDVA_HOME: tmp, EDVA_LOCAL_DIR: local,
    EDVA_OWNER_NAME: "Alex", NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child-v8",
  };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("hasIdentityOpener accepts the two policy openers and nothing else", () => {
  assert.ok(hasIdentityOpener(OK_TEXT, "Alex"));
  assert.ok(hasIdentityOpener("Hi Dana, this is Edva — Alex’s AI assistant. Alex asked me to let you know.", "Alex"));
  assert.ok(hasIdentityOpener("This is Edva on behalf of Alex: the meeting moved.", "Alex"));
  assert.ok(!hasIdentityOpener("Please call Alex when you can.", "Alex"));
  assert.ok(!hasIdentityOpener("Hi Dana, this is Alex. Call me.", "Alex"));
  assert.ok(!hasIdentityOpener("Hi Dana, this is Edva, Sam's AI assistant.", "Alex"), "wrong owner");
  assert.ok(!hasIdentityOpener("Hi, this is Edva, Alex's AI assistant.", "Alex"), "no recipient name");
  assert.ok(!hasIdentityOpener(OK_TEXT, ""));
});

test("isE164, isMessageSid, parseArgs", () => {
  assert.ok(isE164("+15550100001"));
  assert.ok(!isE164("5550100001") && !isE164("+1 555 010 0001") && !isE164(""));
  assert.ok(isMessageSid(MSG_SID) && !isMessageSid("SM123"));
  const a = parseArgs(["--to", "+15550100001", "--text", "x\n", "--authorized", "text her", "--wait", "30", "--json"]);
  assert.deepEqual([a.cmd, a.to, a.text, a.authorized, a.wait, a.json], ["send", "+15550100001", "x", "text her", 30, true]);
  assert.match(parseArgs(["--wait", "9999"]).error, /--wait/);
  assert.match(parseArgs(["--bogus"]).error, /unknown/);
  const s = parseArgs(["status", MSG_SID, "--json"]);
  assert.deepEqual([s.cmd, s.sid, s.json], ["status", MSG_SID, true]);
  assert.ok(FINAL_STATUSES.has("delivered") && !FINAL_STATUSES.has("queued"));
});

test("guards refuse before any credential is read", async () => {
  const noAuth = await run(["--to", "+15550100001", "--text", OK_TEXT]);
  assert.equal(noAuth.status, 3);
  assert.match(noAuth.stderr, /--authorized is required/);
  const noOpener = await run(["--to", "+15550100001", "--text", "Please call Alex.", "--authorized", "text Dana"]);
  assert.equal(noOpener.status, 3);
  assert.match(noOpener.stderr, /identity line/);
  const badTo = await run(["--to", "555-0100", "--text", OK_TEXT, "--authorized", "text Dana"]);
  assert.equal(badTo.status, 3);
  const tooLong = await run(["--to", "+15550100001", "--text", OK_TEXT + "x".repeat(1600), "--authorized", "text Dana"]);
  assert.equal(tooLong.status, 3);
  assert.ok(!fs.existsSync(LOG), "a refusal by a guard is not a send");
});

test("--dry-run checks everything and sends nothing", async () => {
  const r = await run(["--to", "+15550100001", "--text", OK_TEXT, "--authorized", "text Dana", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.credentials, "env");
});

test("inside a test run nothing is sent without a stand-in API", async () => {
  const r = await run(["--to", "+15550100001", "--text", OK_TEXT, "--authorized", "text Dana"],
    { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, SMS_FROM_NUMBER: "+18005550100" });
  assert.equal(r.status, 9);
});

test("no credentials → exit 78", async () => {
  const r = await run(["--to", "+15550100001", "--text", OK_TEXT, "--authorized", "text Dana"],
    { SMS_TWILIO_API_BASE: "http://127.0.0.1:9" });
  assert.equal(r.status, 78);
});

// A stand-in Twilio: POST creates a queued message, GET reports it delivered.
async function withTwilio(fn, { refuse = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(refuse ? 400 : req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      if (refuse) return res.end(JSON.stringify({ code: 21211, message: `Invalid 'To' Phone Number for account ${SID}`, status: 400 }));
      const form = new URLSearchParams(body);
      const status = req.method === "POST" ? "queued" : "delivered";
      res.end(JSON.stringify({ sid: MSG_SID, to: form.get("To") || "+15550100001", from: form.get("From") || "+18005550100", status, error_code: null }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

const CREDS = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, SMS_FROM_NUMBER: "+18005550100" };

test("send + --wait: posts the form with Basic auth, logs sent and final status, never a credential", async () => {
  fs.rmSync(LOG, { force: true });
  await withTwilio(async (api, seen) => {
    const r = await run(["--to", "+15550100001", "--text", OK_TEXT, "--authorized", "Send Dana a text.", "--wait", "5", "--json"],
      { ...CREDS, SMS_TWILIO_API_BASE: api, EDVA_TASK_ID: "t-1" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sid, MSG_SID);
    assert.equal(out.status, "delivered");
    const post = seen.find((s) => s.method === "POST");
    assert.equal(post.url, `/2010-04-01/Accounts/${SID}/Messages.json`);
    assert.equal(post.auth, "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    const form = new URLSearchParams(post.body);
    assert.deepEqual([form.get("To"), form.get("From"), form.get("Body")], ["+15550100001", "+18005550100", OK_TEXT]);
    assert.ok(seen.some((s) => s.method === "GET" && s.url === `/2010-04-01/Accounts/${SID}/Messages/${MSG_SID}.json`));
    const rows = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.kind), ["sent", "status"]);
    assert.equal(rows[0].authorized, "Send Dana a text.");
    assert.equal(rows[0].originating_task, "t-1");
    assert.equal(rows[1].status, "delivered");
    for (const blob of [r.stdout, r.stderr, fs.readFileSync(LOG, "utf8")]) {
      assert.ok(!blob.includes(TOKEN) && !blob.includes(SID), "no credential in output or log");
    }
  });
});

test("Twilio refusal: exit 1, logged as refused", async () => {
  fs.rmSync(LOG, { force: true });
  await withTwilio(async (api) => {
    const r = await run(["--to", "+15550100001", "--text", OK_TEXT, "--authorized", "Send Dana a text."], { ...CREDS, SMS_TWILIO_API_BASE: api });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /21211/);
    const rows = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows[0].kind, "refused");
    for (const blob of [r.stderr, fs.readFileSync(LOG, "utf8")]) {
      assert.ok(!blob.includes(TOKEN) && !blob.includes(SID), "Twilio's error text is redacted");
    }
  }, { refuse: true });
});

test("status <sid> reads and logs the message's status", async () => {
  fs.rmSync(LOG, { force: true });
  await withTwilio(async (api) => {
    const r = await run(["status", MSG_SID], { ...CREDS, SMS_TWILIO_API_BASE: api });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /delivered/);
    assert.equal(JSON.parse(fs.readFileSync(LOG, "utf8").trim()).kind, "status");
  });
  assert.equal((await run(["status", "nope"])).status, 2);
});
