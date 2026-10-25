// hum-qual-delivery.test.mjs — end-to-end tests for bin/hum-deliver-qual,
// the gated delivery of queued lane-diagnosis questions.
//
// Guards the 2026-07-20 regression: a qual question must never occupy the
// pending-question slot without actually being delivered, and delivery + the
// slot-lock must be atomic.
//
// Run: node --test tests/hum-qual-delivery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "..", "bin", "hum-deliver-qual");

// A fake edva-send-curl. Modes via env FAKE_MODE:
//   ok       -> writes id file after --capture-id, prints "Message sent", exit 0
//   suppress -> prints a precheck line to stderr, no id file, exit 0
// Shebang points at the interpreter running the tests, NOT `/usr/bin/env node`:
// hum-deliver-qual execs this fixture directly, and on the host `env` can't
// find `node` on the non-interactive PATH — the fake sender then never runs, no
// id file appears, and the delivery reads as "didn't land" rather than as a
// broken fixture.
const FAKE_SENDER = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const i = a.indexOf("--capture-id");
const idFile = i >= 0 ? a[i + 1] : null;
if (process.env.FAKE_MODE === "suppress") {
  process.stderr.write("outbound-precheck: suppressed (test)\\n");
  process.exit(0);
}
// The two gates that write a JSON sentinel into the capture file.
if (process.env.FAKE_MODE === "precheck-sentinel") {
  fs.writeFileSync(idFile, JSON.stringify({ suppressed: true, reason: "dup" }) + "\\n");
  process.exit(0);
}
if (process.env.FAKE_MODE === "resolve-drop") {
  fs.writeFileSync(idFile + ".resolve.json", JSON.stringify({ by: "hum-resolve-first", decision_id: "hr-1", action: "drop", verdict: "resolved", still_question: false, text: null }));
  fs.writeFileSync(idFile, JSON.stringify({ suppressed: true, by: "hum-resolve-first", decision_id: "hr-1", reason: "resolved before asking" }) + "\\n");
  process.exit(0);
}
if (process.env.FAKE_MODE === "resolve-fyi" || process.env.FAKE_MODE === "resolve-gap") {
  const gap = process.env.FAKE_MODE === "resolve-gap";
  fs.writeFileSync(idFile + ".resolve.json", JSON.stringify({ by: "hum-resolve-first", decision_id: "hr-2", action: "rewrite", verdict: gap ? "partial" : "resolved", still_question: gap, text: gap ? "Only the gap?" : "Here is the answer." }));
}
if (idFile) fs.writeFileSync(idFile, "msg-abc-123\\n");
process.stdout.write("Message sent to Edva.\\n");
process.exit(0);
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hum-qual-"));
  const data = path.join(root, "Dev/edva/data");
  fs.mkdirSync(data, { recursive: true });
  const sender = path.join(root, "fake-send");
  fs.writeFileSync(sender, FAKE_SENDER);
  fs.chmodSync(sender, 0o755);
  fs.writeFileSync(path.join(data, "user-timezone.json"), JSON.stringify({ timezone: "UTC" }));
  return { root, data, sender };
}

function run(env, { nowIso = "2026-07-21T15:00:00Z", fakeMode = "ok" } = {}) {
  // `process.execPath`, not "node": the host has no `node` on its
  // non-interactive PATH (only /opt/homebrew/bin/node), so a bare spawn there
  // fails with status null and every assertion below reads as a logic failure.
  // These tests were silently unrunnable on the machine hum actually runs on.
  return spawnSync(process.execPath, [HELPER], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: env.root,
      HUM_SEND_BIN: env.sender,
      HUM_QUAL_NOW_ISO: nowIso,
      FAKE_MODE: fakeMode,
    },
  });
}

const QUEUE_ENTRY = {
  id: "qual-finance-20260721",
  category: "lane_diagnosis",
  lane: "finance",
  metric_snapshot: { lane: "finance", days_silent: 21 },
  subject: "hum finance decay",
  memory_hook: "hum_improvement_loop",
  question: "Hum's finance lane… what's not working?",
  delivered: false,
  queued_at: "2026-07-21T10:29:00Z",
  deliver_by: "2026-07-22T10:29:00Z",
  trigger_event: { type: "lane_decay_silent", lane: "finance" },
};

const p = (data, f) => path.join(data, f);
const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("successful delivery writes pending slot, stamps state, clears queue", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
  fs.writeFileSync(p(env.data, "hum-state.json"), JSON.stringify({ today: { date: "2026-07-21", runs: 5, pings: 1, questions: 0 } }));

  const r = run(env);
  assert.equal(r.status, 0, r.stderr);

  // Queue cleared.
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), false);

  // Pending slot now holds a DELIVERED question with a 24h reply window.
  const pend = readJSON(p(env.data, "hum-pending-question.json"));
  assert.equal(pend.id, "qual-finance-20260721");
  assert.equal(pend.delivered, true);
  assert.equal(pend.delivered_msg_id, "msg-abc-123");
  assert.equal(pend.asked_at, "2026-07-21T15:00:00.000Z");
  assert.equal(pend.expires_at, "2026-07-22T15:00:00.000Z");

  // State stamped for the backstop clock + question accounting.
  const st = readJSON(p(env.data, "hum-state.json"));
  assert.equal(st.last_question_at, "2026-07-21T15:00:00.000Z");
  assert.equal(st.today.questions, 1);

  // A tick trace was appended.
  const runs = fs.readFileSync(p(env.data, "hum-runs.jsonl"), "utf8").trim().split("\n");
  const trace = JSON.parse(runs[runs.length - 1]);
  assert.equal(trace.outcome.sent, true);
  assert.equal(trace.outcome.question_id, "qual-finance-20260721");

  // A durable per-lane record was also stamped into
  // hum-lane-quiesce-state.json, independent of the shared pending slot
  // above — this is what lets checkExpiredLaneDiagnosis() catch the expiry
  // later even if something else overwrites that slot first.
  const quiesce = readJSON(p(env.data, "hum-lane-quiesce-state.json"));
  assert.equal(quiesce.lanes.finance.outstanding.id, "qual-finance-20260721");
  assert.equal(quiesce.lanes.finance.outstanding.expires_at, pend.expires_at);
});

test("no queue → no-op, pending slot untouched", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
  const r = run(env);
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("live pending question → does not stack (queue kept, no send)", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), JSON.stringify({
    id: "q-live", expires_at: "2026-07-21T15:10:00Z", delivered: true,
  }));
  const r = run(env);
  assert.equal(r.status, 0);
  // Queue still present; pending slot unchanged (still the live one).
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), true);
  assert.equal(readJSON(p(env.data, "hum-pending-question.json")).id, "q-live");
});

test("send suppressed → queue kept for retry, slot not written", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
  const r = run(env, { fakeMode: "suppress" });
  assert.equal(r.status, 0);
  // No zombie: queue remains, slot still null.
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), true);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("past deliver_by → stale queue dropped, no send", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
  const r = run(env, { nowIso: "2026-07-23T15:00:00Z" }); // past deliver_by
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), false);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("outside courtesy hours → waits (queue kept, no send)", () => {
  const env = setup();
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
  // 2026-07-21T03:00:00Z == 23:00 local → past the 21:00 evening cap.
  const r = run(env, { nowIso: "2026-07-21T03:00:00Z" });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), true);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

// ── resolve-first gate ───────────────────────────────────────
// The send now passes bin/hum-resolve-first inside edva-send-curl.

function queued(env) {
  fs.writeFileSync(p(env.data, "hum-qual-delivery-queue.json"), JSON.stringify(QUEUE_ENTRY));
  fs.writeFileSync(p(env.data, "hum-pending-question.json"), "null\n");
}

test("resolved first, nothing sent → queue dropped (nothing to retry), slot left free", () => {
  const env = setup(); queued(env);
  const r = run(env, { fakeMode: "resolve-drop" });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), false);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("a precheck sentinel is not a message id → queue kept, slot not written", () => {
  const env = setup(); queued(env);
  const r = run(env, { fakeMode: "precheck-sentinel" });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), true);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("answered from the records, FYI sent instead → queue dropped, no slot", () => {
  const env = setup(); queued(env);
  const r = run(env, { fakeMode: "resolve-fyi" });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(p(env.data, "hum-qual-delivery-queue.json")), false);
  assert.equal(fs.readFileSync(p(env.data, "hum-pending-question.json"), "utf8").trim(), "null");
});

test("narrowed to the gap → slot holds the text the user actually saw", () => {
  const env = setup(); queued(env);
  const r = run(env, { fakeMode: "resolve-gap" });
  assert.equal(r.status, 0, r.stderr);
  const pend = readJSON(p(env.data, "hum-pending-question.json"));
  assert.equal(pend.question, "Only the gap?");
  assert.equal(pend.delivered_msg_id, "msg-abc-123");
});
