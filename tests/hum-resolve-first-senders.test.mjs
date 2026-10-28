// hum-resolve-first-senders.test.mjs — every hum sender routes through the
// resolve-first gate and reads its outcome honestly.
//
//   edva-send-curl  runs the gate for a chat-channel `hum:` intent; a drop
//                      exits 0 before anything is posted
//   hum-ask            questions: slot written only for what landed as a question
//   hum-ping           info pings: exit 12 when resolved first, `resolve` on the
//                      feedback row when rewritten, always a `hum:` intent
//
// Fake senders and a fake gate only; a throwaway HOME, so nothing reaches
// Supabase, the phone, or the real data files.
//
// Run: node --test tests/hum-resolve-first-senders.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND_CURL = path.join(ROOT, "bin/edva-send-curl");
const HUM_ASK = path.join(ROOT, "bin/hum-ask");
const HUM_PING = path.join(ROOT, "bin/hum-ping");
const PATH = `${path.dirname(process.execPath)}:${process.env.PATH}`;

// A fake edva-send-curl. It records its argv and the --hum-context file it
// was handed, then behaves per FAKE_MODE the way the real one does after the
// gate: a sentinel in the capture file for a hold, an id (+ sidecar) for a send.
const FAKE_SENDER = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const at = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const cap = at("--capture-id");
const ctx = at("--hum-context");
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: a, context: ctx && fs.existsSync(ctx) ? JSON.parse(fs.readFileSync(ctx, "utf8")) : null }));
const side = (o) => fs.writeFileSync(cap + ".resolve.json", JSON.stringify({ by: "hum-resolve-first", decision_id: "hr-t", ...o }));
switch (process.env.FAKE_MODE) {
  case "fail": process.exit(1);
  case "resolve-drop":
    side({ action: "drop", verdict: "resolved", still_question: false, text: null });
    fs.writeFileSync(cap, JSON.stringify({ suppressed: true, by: "hum-resolve-first", reason: "resolved before asking" }));
    process.exit(0);
  case "precheck":
    fs.writeFileSync(cap, JSON.stringify({ suppressed: true, reason: "dup of 10:02 ping" }));
    process.exit(0);
  case "resolve-fyi": side({ action: "rewrite", verdict: "resolved", still_question: false, text: "The place is yours Apr 1." }); break;
  case "resolve-gap": side({ action: "rewrite", verdict: "partial", still_question: true, text: "When are they handing back the keys?" }); break;
}
if (cap) fs.writeFileSync(cap, "msg-777\\n");
process.stdout.write("Message sent to Edva.\\n");
`;

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hrf-send-"));
  const bin = path.join(h, "Dev/edva/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(h, "Dev/edva/data"), { recursive: true });
  fs.writeFileSync(path.join(h, "Dev/edva/.env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const sender = path.join(bin, "edva-send-curl");
  fs.writeFileSync(sender, FAKE_SENDER);
  fs.chmodSync(sender, 0o755);
  return { h, sender, record: path.join(h, "record.json"), data: path.join(h, "Dev/edva/data") };
}

// ── hum-ask ────────────────────────────────────────────────────────────────

function ask(env, mode, extra = []) {
  return spawnSync(process.execPath, [HUM_ASK, "--id", "q-1", "--lane", "ideas", "--subject", "jordan-booking",
    "--findings", JSON.stringify([{ topic: "ideas", dedup_key: "idea-jordan", signal: "booking ends Mar 31" }]),
    "--message", "Is Jordan heading out or extending?", ...extra], {
    encoding: "utf8", env: { ...process.env, PATH, HOME: env.h, HUM_SEND_BIN: env.sender, FAKE_MODE: mode, FAKE_RECORD: env.record },
  });
}
const pendingOf = (env) => {
  try { return JSON.parse(fs.readFileSync(path.join(env.data, "hum-pending-question.json"), "utf8")); } catch { return null; }
};

test("hum-ask: an unchanged question holds the slot; the send carried a hum: question intent and the finding", () => {
  const env = home();
  const r = ask(env, "ok");
  assert.equal(r.status, 0, r.stderr);
  const p = pendingOf(env);
  assert.equal(p.id, "q-1");
  assert.equal(p.question, "Is Jordan heading out or extending?");
  assert.equal(p.delivered_msg_id, "msg-777");
  assert.equal(Date.parse(p.expires_at) - Date.parse(p.asked_at), 15 * 60_000);
  const rec = JSON.parse(fs.readFileSync(env.record, "utf8"));
  assert.equal(rec.argv[rec.argv.indexOf("--intent") + 1], "hum:ideas:question");
  assert.equal(rec.context.kind, "question");
  assert.equal(rec.context.dedup_key, "idea-jordan");
});

test("hum-ask: narrowed to the gap → the slot holds what the user actually saw", () => {
  const env = home();
  const r = ask(env, "resolve-gap");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(pendingOf(env).question, "When are they handing back the keys?");
  assert.equal(pendingOf(env).resolve.narrowed_to_gap, true);
});

test("hum-ask: answered → FYI sent instead (13) or nothing sent (12); no slot either way", () => {
  for (const [mode, code] of [["resolve-fyi", 13], ["resolve-drop", 12]]) {
    const env = home();
    const r = ask(env, mode);
    assert.equal(r.status, code, `${mode}: ${r.stderr}`);
    assert.equal(pendingOf(env), null, mode);
  }
});

test("hum-ask: a precheck hold is 14 and never takes the slot (it used to, with the sentinel as the id)", () => {
  const env = home();
  const r = ask(env, "precheck");
  assert.equal(r.status, 14);
  assert.equal(pendingOf(env), null);
});

// A hum question carries no choice card, so the row's metadata is its only
// structural record of what it asked about (the stop-evidence audit reads it).
test("hum-ask: the chat row carries the finding's key (finding_key) beside question_id; none without --findings", () => {
  const run = (id, lane, extra, message) => {
    const env = home();
    const r = spawnSync(process.execPath, [HUM_ASK, "--id", id, "--lane", lane, ...extra, "--message", message], {
      encoding: "utf8", env: { ...process.env, PATH, HOME: env.h, HUM_SEND_BIN: env.sender, FAKE_MODE: "ok", FAKE_RECORD: env.record },
    });
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(fs.readFileSync(env.record, "utf8"));
    return JSON.parse(rec.argv[rec.argv.indexOf("--metadata-json") + 1]);
  };
  const key = "location_ask:0000aaaa-1111-4222-8333-444455556666";
  const meta = run("q-loc", "location_context", ["--findings", JSON.stringify([{ topic: "location_context", dedup_key: key }])],
    "Was that a walk, or did you stop somewhere?");
  assert.equal(meta.question_id, "q-loc");
  assert.equal(meta.finding_key, key);
  assert.ok(meta.question_until, "a location question is time-bound");
  assert.ok(Object.values(meta).every((v) => typeof v === "string"), "the app decodes row metadata as [String: String]");
  assert.deepEqual(Object.keys(run("q-bare", "ideas", [], "Still keen on the exhibit?")), ["question_id"]);
});

test("hum-ask: send failure is 3; usage errors are 2", () => {
  const env = home();
  assert.equal(ask(env, "fail").status, 3);
  assert.equal(pendingOf(env), null);
  const u = spawnSync(process.execPath, [HUM_ASK, "--lane", "x", "--message", "hi"], { encoding: "utf8", env: { ...process.env, HOME: env.h } });
  assert.equal(u.status, 2);
});

// ── hum-ping ───────────────────────────────────────────────────────────────

function ping(env, mode, extra = []) {
  return spawnSync(process.execPath, [HUM_PING, "--ping-id", "p-test-1", "--lane", "workshop", "--score", "0.6",
    "--findings", JSON.stringify([{ topic: "workshop", dedup_key: "workshop:jordan", signal: "booking ends Mar 31" }]),
    "--suppress-hook", "--message", "Jordan's booking ends Mar 31. Are they extending?", ...extra], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH, HOME: env.h, FAKE_MODE: mode, FAKE_RECORD: env.record, HUM_NOVELTY_THRESHOLD: "2" },
  });
}
const feedbackOf = (env) => {
  try { return fs.readFileSync(path.join(env.data, "hum-feedback.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

test("hum-ping: resolved first → exit 12, no feedback row", () => {
  const env = home();
  const r = ping(env, "resolve-drop");
  assert.equal(r.status, 12, r.stderr);
  assert.equal(feedbackOf(env).length, 0);
  const rec = JSON.parse(fs.readFileSync(env.record, "utf8"));
  assert.equal(rec.argv[rec.argv.indexOf("--intent") + 1], "hum:workshop", "no caller intent → hum:<lane>");
  assert.equal(rec.context.dedup_key, "workshop:jordan");
  assert.equal(rec.context.finding.signal, "booking ends Mar 31");
});

test("hum-ping: rewritten by the gate → a normal send, with `resolve` on the feedback row", () => {
  const env = home();
  const r = ping(env, "resolve-gap", ["--intent", "hum:workshop:booking"]);
  assert.equal(r.status, 0, r.stderr);
  const [row] = feedbackOf(env);
  assert.equal(row.message_id, "msg-777");
  assert.deepEqual(row.resolve, { decision_id: "hr-t", verdict: "partial", still_question: true });
  const rec = JSON.parse(fs.readFileSync(env.record, "utf8"));
  assert.equal(rec.argv[rec.argv.indexOf("--intent") + 1], "hum:workshop:booking");
});

test("hum-ping: a non-hum intent is nested under the lane, never dropped", () => {
  const env = home();
  ping(env, "ok", ["--intent", "booking-check"]);
  const rec = JSON.parse(fs.readFileSync(env.record, "utf8"));
  assert.equal(rec.argv[rec.argv.indexOf("--intent") + 1], "hum:workshop:booking-check");
});

// ── edva-send-curl ──────────────────────────────────────────────────────

const FAKE_GATE = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const i = a.indexOf("--capture-id");
fs.writeFileSync(process.env.GATE_RECORD, fs.readFileSync(0, "utf8"));
if (i >= 0) fs.writeFileSync(a[i + 1], JSON.stringify({ suppressed: true, by: "hum-resolve-first" }));
process.stdout.write(JSON.stringify({ action: "drop", verdict: "resolved", decision_id: "hr-g" }) + "\\n");
`;

test("edva-send-curl: a chat hum: intent runs the gate; a drop exits 0 before anything is posted", () => {
  const env = home();
  const gate = path.join(env.h, "fake-gate");
  fs.writeFileSync(gate, FAKE_GATE);
  const ctx = path.join(env.h, "ctx.json");
  fs.writeFileSync(ctx, JSON.stringify({ kind: "ping", dedup_key: "k" }));
  const cap = path.join(env.h, "cap");
  const gateRecord = path.join(env.h, "gate-in.json");
  const r = spawnSync(SEND_CURL, ["--intent", "hum:ideas:jordan", "--capture-id", cap, "--hum-context", ctx, "--no-push", "Is Jordan extending?"], {
    encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH, HOME: env.h, HUM_RESOLVE_BIN: gate, GATE_RECORD: gateRecord },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("Message sent"), "nothing posted");
  assert.match(r.stderr, /hum-resolve-first: not sent/);
  const seen = JSON.parse(fs.readFileSync(gateRecord, "utf8"));
  assert.equal(seen.message, "Is Jordan extending?");
  assert.equal(seen.intent, "hum:ideas:jordan");
  assert.equal(seen.context_file, ctx);
  assert.equal(JSON.parse(fs.readFileSync(cap, "utf8")).by, "hum-resolve-first");
});

test("edva-send-curl: --hum-context is a known flag (not swallowed into the message)", () => {
  const src = fs.readFileSync(SEND_CURL, "utf8");
  assert.ok(src.includes("--hum-context)    HUM_CONTEXT_FILE="));
  assert.ok(src.includes("--observed-error, --hum-context,"));
});
