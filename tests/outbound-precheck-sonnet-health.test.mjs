// outbound-precheck-sonnet-health — a message that went out unchecked must be
// visible as such (a weekly review found about one in five decisions in two
// consecutive weeks failed open with Sonnet's answer thrown away). Fail-open is
// unchanged. Pinned: the row keeps the unusable answer's head, an empty answer
// says why, every fail-open path counts as unchecked (an unplanned exception,
// Jev's "modify" with no Sonnet text), and the system channel hears once per
// episode, silently, in words the send path's gates pass, until a ✅ closes it.
//
// Run: node --test tests/outbound-precheck-sonnet-health.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

const BIN = path.resolve("bin/outbound-precheck.mjs");
const SEND_CURL = path.resolve("bin/edva-send-curl");
const f = makeFixture("outbound-precheck");
const LOG = () => path.join(f.tmp, "precheck.jsonl");
const HEALTH = () => path.join(f.tmp, "precheck-health.json");
const SENDS = () => path.join(f.tmp, "sends.log");
const SEND_BIN = path.join(f.tmp, "fake-send.sh");
fs.writeFileSync(SEND_BIN, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${SENDS()}"\n`, { mode: 0o755 });
after(() => f.cleanup());
beforeEach(() => { f.reset(); for (const p of [LOG(), HEALTH(), SENDS()]) fs.rmSync(p, { force: true }); });

const OPTS = ["send", "suppress", "modify"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The report is sent by a detached child, so poll for it rather than guess.
async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (fn()) return true; await sleep(50); }
  return false;
}
const rows = () => (fs.existsSync(LOG()) ? fs.readFileSync(LOG(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const health = () => JSON.parse(fs.readFileSync(HEALTH(), "utf8"));
const sends = () => (fs.existsSync(SENDS()) ? fs.readFileSync(SENDS(), "utf8").trim().split("\n").filter(Boolean) : []);
const prefill = (window, extra = {}) => fs.writeFileSync(HEALTH(), JSON.stringify({ window, ...extra }));
const fill = (checked, unchecked) => [...Array(checked).fill(""), ...Array(unchecked).fill("no_json")];

function run({ sonnet, jev = null, intent = "hum:music", stdin = null } = {}) {
  const body = stdin ?? JSON.stringify({
    message: "The Corner Club has a show Thursday you might want.",
    intent, agent: "ops", evidence_as_of: "live", supporting_data: { evidence_as_of: "live" },
  });
  return f.runCli(BIN, body, f.baseEnv({
    OUTBOUND_PRECHECK_CLAUDE_BIN: f.CLAUDE, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false",
    OUTBOUND_PRECHECK_WIKI_BIN: "/usr/bin/false",
    OUTBOUND_PRECHECK_ENV_FILE: path.join(f.tmp, "no.env"),
    OUTBOUND_PRECHECK_LOG: LOG(), OUTBOUND_PRECHECK_HEALTH: HEALTH(), OUTBOUND_PRECHECK_SEND_BIN: SEND_BIN,
    OUTBOUND_PRECHECK_NO_ALERT: "",   // the harness mutes reports; this file is about them
    JEV_TEST_ANSWERS: JSON.stringify(jev || {}),   // {} = Jev has no answer: the Sonnet path decides
    STUB_SONNET: sonnet,
  }));
}

test("an answer with no JSON still sends, and the row keeps what Sonnet said instead", async () => {
  const { json } = await run({ sonnet: "I think this one is fine to send, it matches what the user asked about." });
  assert.equal(json.decision, "send", "fail-open is unchanged");
  const [row] = rows();
  assert.equal(row.reason, "precheck_sonnet_no_json");
  assert.match(row.sonnet_head, /^I think this one is fine/);
  assert.ok(row.sonnet_head.length <= 200);
  assert.deepEqual(health().window, ["no_json"]);
});

test("an empty answer says why it was empty", async () => {
  const { json } = await run({ sonnet: "" });
  assert.equal(json.decision, "send");
  assert.equal(rows()[0].reason, "precheck_sonnet_unavailable:empty_output");
  assert.deepEqual(health().window, ["unavailable"]);
});

test("a protected intent (Sonnet is its only judge) that gets no JSON is counted", async () => {
  const { json } = await run({ intent: "p1-email", jev: choice("send", 0.99, OPTS), sonnet: "Looks fine." });
  assert.equal(json.decision, "send");
  assert.equal(f.jevCalls().length, 0, "p1-email never reaches Jev");
  assert.equal(rows()[0].reason, "precheck_sonnet_no_json");
  assert.deepEqual(health().window, ["no_json"]);
});

test("a usable answer counts as a checked message", async () => {
  await run({ sonnet: JSON.stringify({ decision: "send", reason: "consistent" }) });
  assert.equal(rows()[0].sonnet_head, undefined);
  assert.deepEqual(health().window, [""]);
});

test("a message Jev decided is checked even when its Sonnet shadow had no JSON", async () => {
  const { json } = await run({ jev: choice("send", 0.97, OPTS), sonnet: "no json from the shadow" });
  assert.equal(json.decision, "send");
  assert.match(json.reason, /^jev:/);
  assert.equal(rows()[0].sonnet_head, "no json from the shadow", "the shadow's answer is still kept");
  assert.deepEqual(health().window, [""]);
});

test("Jev's modify with no Sonnet text is labelled by how Sonnet failed (no_json, not unavailable)", async () => {
  const { json } = await run({ jev: choice("modify", 0.97, OPTS), sonnet: "I would soften this a little." });
  assert.equal(json.decision, "send", "no text to modify with: fail open");
  assert.equal(rows()[0].reason, "precheck_sonnet_no_json");
  assert.deepEqual(health().window, ["no_json"]);
});

test("an exception nobody planned for is an unchecked 'error', never a pass", async () => {
  // A config that parses to null makes the Jev layer throw a TypeError: a real,
  // unplanned exception reaching the relevance stage's catch.
  fs.writeFileSync(f.CFG, "null");
  const { json } = await run({ sonnet: JSON.stringify({ decision: "send", reason: "ok" }) });
  assert.equal(json.decision, "send", "fail-open is unchanged");
  assert.doesNotMatch(rows()[0].reason, /^precheck_/, "the reason is the exception, not one of our codes");
  assert.deepEqual(health().window, ["error"]);
});

test("malformed input never reached the relevance check and is not counted", async () => {
  await run({ stdin: "not json", sonnet: "x" });
  assert.equal(rows()[0].reason, "precheck_invalid_input");
  assert.equal(fs.existsSync(HEALTH()), false);
});

test("crossing 25% tells the system channel once, silently, outside the precheck; a recovery line closes it", async () => {
  prefill(fill(15, 5));                              // 5 of 20 = exactly 25%: not over the line
  await run({ sonnet: "no json here either" });     // 6 of 21 = 29%
  await waitFor(() => sends().length >= 1);
  const first = sends();
  assert.equal(first.length, 1, `one report: ${JSON.stringify(first)}`);
  assert.match(first[0], /^--channel system --skip-precheck --intent precheck-health /);
  const msg = first[0].replace(/^--channel system --skip-precheck --intent precheck-health /, ""); // lang-regex-ok: the alert text Edva composed, not anything the user wrote
  assert.match(msg, /^⚠️ Relevance check partly blind: .*6 of the last 21 messages \(29%; no_json 6\)/); // lang-regex-ok: the alert text Edva composed, not anything the user wrote
  assert.ok(health().alerted_at);

  // The words must get through edva-send-curl's system-channel gates as a
  // plain, silent row: not a claimed outage (exit 3), not an unattested error
  // mechanism (exit 6), not a P1-sweep alert (exit 7), not 🔴/🚨 (which push).
  const src = fs.readFileSync(SEND_CURL, "utf8");
  for (const name of ["INFRA_CLAIM_RE", "MECHANISM_CLAIM_RE", "P1_SWEEP_SUBJECT_RE"]) {
    const m = src.match(new RegExp(`^${name}='(.+)'$`, "m"));
    assert.ok(m, `${name} not found in edva-send-curl`);
    for (const k of ["no_json", "unavailable", "error"]) {
      const variant = msg.replace("no_json 6", `${k} 6`);
      assert.doesNotMatch(variant, new RegExp(m[1], "i"), `${name} would block: ${variant}`);
    }
  }
  assert.ok(!/^(🔴|🚨)/.test(msg), "a degraded check is not a critical page"); // lang-regex-ok: the alert text Edva composed, not anything the user wrote

  await run({ sonnet: "still no json" });   // still over the line, same episode
  await sleep(1000);   // long enough that a wrong second report would have landed
  assert.equal(sends().length, 1, "an episode is reported once, not per message");

  // Between the lines (20%): an open episode neither re-reports nor closes.
  prefill(fill(39, 10), { alerted_at: health().alerted_at });
  await run({ sonnet: JSON.stringify({ decision: "send", reason: "ok" }) });   // 10 of 50 = 20%
  await sleep(1000);
  assert.equal(sends().length, 1, "no recovery at 20%");
  assert.ok(health().alerted_at, "episode still open");

  // Recover: at or below 15% with the episode still open.
  prefill(fill(43, 6), { alerted_at: health().alerted_at });
  await run({ sonnet: JSON.stringify({ decision: "send", reason: "ok" }) });   // 6 of 50 = 12%
  await waitFor(() => sends().length >= 2);
  const all = sends();
  assert.equal(all.length, 2);
  assert.match(all[1], /--channel system --skip-precheck --intent precheck-health ✅ Relevance check seeing again/);
  assert.equal(health().alerted_at, undefined);
});

test("between 20% and 25% is no longer over the line (the old 20% line paged here)", async () => {
  prefill(fill(17, 4));                             // 4 of 21
  await run({ sonnet: "no json" });                 // 5 of 22 = 23%
  await sleep(1000);
  assert.equal(sends().length, 0, "a 23% window does not report");
  assert.equal(health().alerted_at, undefined);
});
