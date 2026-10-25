// jev-claim-check.test.mjs — Jev as primary for claim-check stage 2 (the
// settled/contradicted adjudicator), Sonnet as shadow + fallback.
// Run: node --test tests/jev-claim-check.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

const BIN = path.resolve("bin/claim-check");
const f = makeFixture("claim-check");
after(() => f.cleanup());
beforeEach(() => f.reset());

const OPTS = ["pass", "rewrite", "drop"];
const SONNET = {
  pass: JSON.stringify({ verdict: "pass", reason: "nothing settles it" }),
  drop: JSON.stringify({ verdict: "drop", reason: "the user answered this on 9/20" }),
  rewrite: JSON.stringify({ verdict: "rewrite", reason: "stale date", corrected_text: "The corrected candidate text." }),
};
function run({ lane = "ideas", jev = null, sonnet = "pass", env = {} } = {}) {
  const stdin = JSON.stringify({ text: "Want me to look into a new espresso grinder for the kitchen?", subject: "espresso-grinder", lane, evidence_as_of: "live" });
  // --force: Stage 2 runs regardless of the cheap gate (the recall stub returns nothing).
  return f.runCli(BIN, stdin, f.baseEnv({
    CLAIM_CHECK_CLAUDE_BIN: f.CLAUDE, CLAIM_CHECK_RECALL_BIN: "/usr/bin/false", CLAIM_CHECK_LOG: path.join(f.tmp, "cc-log.jsonl"),
    JEV_TEST_ANSWERS: JSON.stringify(jev || {}), STUB_SONNET: SONNET[sonnet] ?? sonnet, ...env,
  }), ["--force", "--json"]);
}

test("confident Jev pass → pass; Sonnet shadow agrees", async () => {
  const { json } = await run({ jev: choice("pass", 0.97, OPTS) });
  assert.equal(json.verdict, "pass");
  assert.match(json.reasons[0], /^jev:/);
  assert.equal(f.jevCalls().length, 1);
  assert.equal(f.claudeRuns(), 1);
  assert.equal(f.rows()[0].agree, true);
});

test("shadow week: Sonnet drop beats a confident Jev pass, disagreement logged", async () => {
  const { json } = await run({ jev: choice("pass", 0.97, OPTS), sonnet: "drop" });
  assert.equal(json.verdict, "drop");
  assert.match(json.reasons[0], /^sonnet shadow drop over jev pass/);
  assert.equal(f.disagreements().length, 1);
});

test("confident Jev drop is acted on", async () => {
  const { json } = await run({ jev: choice("drop", 0.95, OPTS), sonnet: "drop" });
  assert.equal(json.verdict, "drop");
  assert.match(json.reasons[0], /^jev:/);
});

test("confident Jev rewrite takes Sonnet's corrected text", async () => {
  const { json } = await run({ jev: choice("rewrite", 0.95, OPTS), sonnet: "rewrite" });
  assert.equal(json.verdict, "rewrite");
  assert.equal(json.corrected_text, "The corrected candidate text.");
  assert.equal(f.claudeRuns(), 1);
});

test("low-confidence Jev → Sonnet decides", async () => {
  const { json } = await run({ jev: choice("pass", 0.6, OPTS), sonnet: "drop" });
  assert.equal(json.verdict, "drop");
  assert.equal(f.rows()[0].used, "legacy");
});

test("health / finance lanes never reach Jev", async () => {
  for (const lane of ["health", "finance", "stocks", "exercise"]) {
    f.reset();
    await run({ lane, jev: choice("pass", 0.99, OPTS) });
    assert.equal(f.jevCalls().length, 0, `${lane}: Jev not called`);
    assert.match(f.rows()[0].reason, /^private-intent-excluded/);
  }
});

test("privacy screen fails closed → Sonnet only", async () => {
  await run({ jev: choice("pass", 0.99, OPTS), env: { JEV_PRIVATE_SCREEN: "" } });
  assert.equal(f.jevCalls().length, 0);
  assert.match(f.rows()[0].reason, /^sensitive-excluded/);
});

test("--no-llm never calls Jev (no test/dry mode reaches it)", async () => {
  const stdin = JSON.stringify({ text: "Want me to look into a new espresso grinder?", subject: "x", evidence_as_of: "live" });
  await f.runCli(BIN, stdin, f.baseEnv({ CLAIM_CHECK_CLAUDE_BIN: f.CLAUDE, CLAIM_CHECK_LOG: path.join(f.tmp, "cc-log.jsonl"), JEV_TEST_ANSWERS: JSON.stringify(choice("drop", 0.99, OPTS)) }), ["--no-llm", "--force"]);
  assert.equal(f.jevCalls().length, 0);
  assert.equal(f.claudeRuns(), 0);
});

test("Sonnet down + Jev unsure → fail-open pass (adjudicator_unavailable)", async () => {
  const { json } = await run({ jev: choice("pass", 0.5, OPTS), sonnet: "" });
  assert.equal(json.verdict, "pass");
  assert.deepEqual(json.reasons, ["adjudicator_unavailable"]);
});
