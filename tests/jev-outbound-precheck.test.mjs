// jev-outbound-precheck.test.mjs — Jev as primary for the outbound relevance
// gate (bin/outbound-precheck.mjs), Sonnet as shadow + fallback.
// Run: node --test tests/jev-outbound-precheck.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

const BIN = path.resolve("bin/outbound-precheck.mjs");
const f = makeFixture("outbound-precheck");
after(() => f.cleanup());
beforeEach(() => f.reset());

const OPTS = ["send", "suppress", "modify"];
const SONNET = {
  send: JSON.stringify({ decision: "send", reason: "consistent" }),
  suppress: JSON.stringify({ decision: "suppress", reason: "the user said they are at the gym" }),
  modify: JSON.stringify({ decision: "modify", message: "Saw you're at the gym — nice. Tomorrow 9am?", reason: "ack context" }),
};
function run({ intent = "test-intent", jev = null, sonnet = "send", env = {} } = {}) {
  const stdin = JSON.stringify({ message: "Want to reschedule the workout block to tomorrow morning?", intent, evidence_as_of: "live", supporting_data: { evidence_as_of: "live" } });
  return f.runCli(BIN, stdin, f.baseEnv({
    OUTBOUND_PRECHECK_CLAUDE_BIN: f.CLAUDE, OUTBOUND_PRECHECK_GOG_BIN: "/usr/bin/false", OUTBOUND_PRECHECK_WIKI_BIN: "/usr/bin/false",
    OUTBOUND_PRECHECK_ENV_FILE: path.join(f.tmp, "no.env"), OUTBOUND_PRECHECK_LOG: path.join(f.tmp, "precheck-log.jsonl"),
    JEV_TEST_ANSWERS: JSON.stringify(jev || {}), STUB_SONNET: SONNET[sonnet] ?? sonnet, ...env,
  }));
}

test("confident Jev send → send; Sonnet runs once as shadow and agrees", async () => {
  const { json } = await run({ jev: choice("send", 0.97, OPTS) });
  assert.equal(json.decision, "send");
  assert.match(json.reason, /^jev:/);
  assert.equal(f.jevCalls().length, 1);
  assert.equal(f.jevCalls()[0].providerOptions, undefined);
  assert.equal(f.claudeRuns(), 1);
  const [row] = f.rows();
  assert.equal(row.used, "jev"); assert.equal(row.agree, true);
});

test("shadow week: Sonnet suppress beats a confident Jev send (conservative wins), disagreement logged", async () => {
  const { json } = await run({ jev: choice("send", 0.97, OPTS), sonnet: "suppress" });
  assert.equal(json.decision, "suppress");
  assert.match(json.reason, /^sonnet shadow suppress over jev send/);
  assert.equal(f.disagreements().length, 1);
});

test("confident Jev suppress is acted on without waiting for text", async () => {
  const { json } = await run({ jev: choice("suppress", 0.96, OPTS), sonnet: "suppress" });
  assert.equal(json.decision, "suppress");
  assert.match(json.reason, /^jev:/);
});

test("confident Jev modify takes Sonnet's text (one Sonnet call, memoized)", async () => {
  const { json } = await run({ jev: choice("modify", 0.95, OPTS), sonnet: "modify" });
  assert.equal(json.decision, "modify");
  assert.ok(json.message.includes("at the gym"), "Sonnet's rewrite carried through");
  assert.equal(f.claudeRuns(), 1);
});

test("low-confidence Jev → Sonnet decides alone", async () => {
  const { json } = await run({ jev: choice("send", 0.6, OPTS), sonnet: "suppress" });
  assert.equal(json.decision, "suppress");
  assert.equal(f.rows()[0].used, "legacy");
});

test("edva-model-only intents never reach Jev; input withheld", async () => {
  // A synthetic installation that adds its own brokerage intent to the kernel's
  // private prefixes (agent/local/config/send-intents.json).
  const local = path.join(f.tmp, "local");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "config", "send-intents.json"), JSON.stringify({ extend_jev_private_intent_prefixes: ["brokerco"] }));
  for (const intent of ["bank-alert", "hum:finance:dup-charge", "brokerco-snapshot", "health:labs"]) {
    f.reset();
    const { json } = await run({ intent, jev: choice("send", 0.99, OPTS), sonnet: "send", env: { EDVA_LOCAL_DIR: local } });
    assert.equal(json.decision, "send");
    assert.equal(f.jevCalls().length, 0, `${intent}: Jev not called`);
    const [row] = f.rows();
    assert.match(row.reason, /^private-intent-excluded/);
    assert.equal(row.input, "[withheld]");
  }
});

// A synthetic installation whose protected Rule #1 lanes are "practice" and
// health (agent/local/config/hum-lanes.json protected_lanes).
function protectedLocal() {
  const local = path.join(f.tmp, "local-protected");
  fs.mkdirSync(path.join(local, "config"), { recursive: true });
  fs.writeFileSync(path.join(local, "config", "hum-lanes.json"), JSON.stringify({ protected_lanes: ["practice", "health"] }));
  return { EDVA_LOCAL_DIR: local };
}

test("protected intents (p1-email, hum:practice, hum:health) stay on Sonnet", async () => {
  for (const intent of ["p1-email", "hum:practice:slot-start", "hum:health:rbc"]) {
    f.reset();
    await run({ intent, jev: choice("suppress", 0.99, OPTS), sonnet: "send", env: protectedLocal() });
    assert.equal(f.jevCalls().length, 0, `${intent}: Jev not called`);
  }
});

test("privacy screen fails closed (Ollama unreachable) → Sonnet only, input withheld", async () => {
  const { json } = await run({ jev: choice("send", 0.99, OPTS), sonnet: "send", env: { JEV_PRIVATE_SCREEN: "" } });
  assert.equal(json.decision, "send");
  assert.equal(f.jevCalls().length, 0);
  assert.match(f.rows()[0].reason, /^sensitive-excluded/);
  assert.equal(f.rows()[0].input, "[withheld]");
});

test("after the shadow window a confident Jev send costs zero Sonnet calls", async () => {
  f.reset({ shadow_until: new Date(Date.now() - 1000).toISOString() });
  const { json } = await run({ jev: choice("send", 0.97, OPTS) });
  assert.equal(json.decision, "send");
  assert.equal(f.claudeRuns(), 0);
});

test("no gateway key → exactly the old Sonnet behavior", async () => {
  // HOME → tmp so jev.mjs's loadEnv can't pick a real key up from ~/Dev/edva/.env (the host has one).
  const { json } = await run({ jev: choice("send", 0.99, OPTS), sonnet: "suppress", env: { TYPESAFE_API_KEY: "", HOME: f.tmp } });
  assert.equal(json.decision, "suppress");
  assert.equal(f.jevCalls().length, 0);
});

test("Sonnet down + Jev unsure → fail-open send (unchanged contract)", async () => {
  const { json } = await run({ jev: choice("send", 0.5, OPTS), sonnet: "" });
  assert.equal(json.decision, "send");
});

test("the Sonnet shadow/fallback is tool-less and never sees the metered API key", async () => {
  await run({ jev: choice("send", 0.97, OPTS), env: { ANTHROPIC_API_KEY: "sk-leak-test" } });
  const [line] = f.claudeArgv();
  assert.match(line, /^key=none /, "ANTHROPIC_API_KEY stripped");
  assert.match(line, /--tools {2}--strict-mcp-config --mcp-config \{"mcpServers":\{\}\} --setting-sources project/);
  assert.doesNotMatch(line, /--allowedTools/);
});

test("protected intents: p1-email and hum:health stay off Jev", async () => {
  for (const intent of ["p1-email", "hum:health:labs", "health-alert"]) {
    f.reset();
    await run({ intent, jev: choice("suppress", 0.99, OPTS), env: protectedLocal() });
    assert.equal(f.jevCalls().length, 0, intent);
  }
});

// The two tests above pass with the fixture's default config, which leaves
// privacy exclusions ON. Production has had them OFF since 2026-09-23, and
// because protection rode on privateIntent() until 2026-09-24 the guarantee
// they claim to pin was not actually in force there: two protected-lane pings
// reached Jev that day. Protection is not a privacy setting — pin it with
// privacy exclusions explicitly off, which is the configuration that runs.
test("protected intents stay off Jev even with privacy exclusions disabled", async () => {
  for (const intent of ["p1-email", "hum:practice:post-slot-miss", "hum:health:labs"]) {
    f.reset({ privacy_exclusions: false });
    const { json } = await run({ intent, jev: choice("suppress", 0.99, OPTS), sonnet: "send", env: protectedLocal() });
    assert.equal(f.jevCalls().length, 0, `${intent}: Jev must not be asked`);
    assert.equal(json.decision, "send", `${intent}: Sonnet decides`);
    assert.match(f.rows()[0].reason, /^protected-intent/, intent);
  }
});

// The same switch must still do its own job: with privacy exclusions ON, a
// edva-model-only intent is excluded for PRIVACY, not for protection, and
// its input is withheld from the log. Protection never withholds anything.
test("privacy exclusions still bite when enabled, and are a separate reason", async () => {
  f.reset();
  await run({ intent: "health-alert", jev: choice("suppress", 0.99, OPTS), sonnet: "send" });
  assert.equal(f.jevCalls().length, 0);
  assert.match(f.rows()[0].reason, /^private-intent-excluded/);
  assert.equal(f.rows()[0].input, "[withheld]");
});
