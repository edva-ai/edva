// outbound-precheck-log-attribution — a row in outbound-precheck-log.jsonl must
// name the intent and agent its caller declared.
//
// Before this, emit() wrote the stdout protocol object verbatim into the log, so
// of the last 300 production rows 298 carried no intent and 300 carried no
// sender — while 63 of those 300 were suppressions. The investigator's first
// instruction is to read this file before blaming a harvester, which is
// impossible with the fields blank.
//
// SCOPE: these cover the rows emit() writes. edva-send-curl has a second,
// separate appender for its protected-intent suppress-override, which already
// records its own intent and is not touched here.
//
// Run: node --test tests/outbound-precheck-log-attribution.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

const BIN = path.resolve("bin/outbound-precheck.mjs");
const f = makeFixture("outbound-precheck");
const LOG = () => path.join(f.tmp, "precheck-attrib.jsonl");
after(() => f.cleanup());
beforeEach(() => { f.reset(); fs.rmSync(LOG(), { force: true }); });

const OPTS = ["send", "suppress", "modify"];

function logRows() {
  if (!fs.existsSync(LOG())) return [];
  return fs.readFileSync(LOG(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function run({ intent = "hum:music", agent = "ops", stdin = null, jev = null, sonnet = null } = {}) {
  const body = stdin ?? JSON.stringify({
    message: "The Corner Club has a show Thursday you might want.",
    intent, agent, evidence_as_of: "live", supporting_data: { evidence_as_of: "live" },
  });
  return f.runCli(BIN, body, f.baseEnv({
    OUTBOUND_PRECHECK_CLAUDE_BIN: f.CLAUDE, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false",
    OUTBOUND_PRECHECK_WIKI_BIN: "/usr/bin/false",
    OUTBOUND_PRECHECK_ENV_FILE: path.join(f.tmp, "no.env"),
    OUTBOUND_PRECHECK_LOG: LOG(),
    JEV_TEST_ANSWERS: JSON.stringify(jev || {}),
    STUB_SONNET: sonnet ?? JSON.stringify({ decision: "send", reason: "consistent" }),
  }));
}

test("a SUPPRESS names the lane that lost the message — the case the log exists for", async () => {
  await run({ intent: "events-watch", agent: "ops", jev: choice("suppress", 0.97, OPTS) });
  const rows = logRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "suppress");
  assert.equal(rows[0].intent, "events-watch",
    "a suppressed row with no intent is exactly the six-week-old bug");
  assert.equal(rows[0].sender, "ops");
});

test("a send carries the same attribution", async () => {
  await run({ intent: "hum:music", agent: "chat", jev: choice("send", 0.97, OPTS) });
  const [row] = logRows();
  assert.equal(row.decision, "send");
  assert.equal(row.intent, "hum:music");
  assert.equal(row.sender, "chat");
});

test("a caller that declares no intent is recorded as unknown, not as blank", async () => {
  // Honest rather than useful: the row says nobody declared a lane, which is a
  // different statement from the field being absent.
  const noIntent = JSON.stringify({ message: "A show Thursday.", agent: "ops", evidence_as_of: "live", supporting_data: { evidence_as_of: "live" } });
  await run({ stdin: noIntent, jev: choice("send", 0.97, OPTS) });
  const [row] = logRows();
  assert.equal(row.intent, "unknown");
  assert.equal(row.sender, "ops");
});

test("stdout stays the exact {decision, reason} protocol — the widening is log-only", async () => {
  const { json } = await run({ jev: choice("send", 0.97, OPTS) });
  assert.deepEqual(Object.keys(json).sort(), ["decision", "reason"]);
  assert.equal(json.intent, undefined);
  assert.equal(json.sender, undefined);
});

test("a modify still emits {decision, message, reason} and nothing more", async () => {
  const { json } = await run({
    jev: choice("modify", 0.97, OPTS),
    sonnet: JSON.stringify({ decision: "modify", message: "Shorter version.", reason: "trimmed" }),
  });
  assert.deepEqual(Object.keys(json).sort(), ["decision", "message", "reason"]);
  const [row] = logRows();
  assert.equal(row.intent, "hum:music");
});

test("malformed input still fails open, and claims no intent it never parsed", async () => {
  const { json } = await run({ stdin: "not json" });
  assert.equal(json.decision, "send");
  assert.equal(json.reason, "precheck_invalid_input");
  const [row] = logRows();
  assert.equal(row.decision, "send");
  assert.equal(row.intent, undefined);
});

test("the decision object overrides attribution on a key collision", async () => {
  // Not hypothetical for `reason`: a future attribution key could shadow a
  // protocol key, and the protocol must win. Pinned by construction — spread
  // order is {ts, ...logContext, ...obj}.
  const src = fs.readFileSync(path.resolve("bin/outbound-precheck.mjs"), "utf8");
  assert.match(src, /\.\.\.logContext,\s*\.\.\.obj/,
    "attribution must be spread BEFORE the decision object, never after");
});
