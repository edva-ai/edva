// jev-claim-freshness.test.mjs — Jev as primary for claim-freshness stage 3
// (is the premise still TRUE at release?), Sonnet adjudicator as shadow + fallback.
// Run: node --test tests/jev-claim-freshness.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeFixture, choice } from "./jev-gate-harness.mjs";

const f = makeFixture("claim-freshness");
Object.assign(process.env, {
  JEV_CONFIG_FILE: f.CFG, JEV_QUESTIONS_DIR: f.qdir, JEV_SHADOW_DIR: f.SHADOW,
  JEV_ENDPOINT: "https://jev.test/v1/evaluate", JEV_NO_ALERT: "1", TYPESAFE_API_KEY: "test-key",
  JEV_PRIVATE_SCREEN: "off",
  CLAIM_FRESHNESS_CLAUDE_BIN: f.CLAUDE, CLAIM_FRESHNESS_LOG: path.join(f.tmp, "cf-log.jsonl"),
});
let jevAnswer = {};
let screen = null;
let jevCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/v1/evaluate")) { jevCalls++; return new Response(JSON.stringify({ answers: jevAnswer }), { status: 200 }); }
  if (u.includes("/api/")) {
    if (screen) return new Response(JSON.stringify({ message: { content: screen } }), { status: 200 });
    throw new Error("offline: no ollama");
  }
  throw new Error("offline: " + u);
};
after(() => { globalThis.fetch = realFetch; f.cleanup(); });
beforeEach(() => { f.reset(); jevCalls = 0; screen = null; process.env.JEV_PRIVATE_SCREEN = "off"; });

const { adjudicate } = await import("../lib/claim-freshness.mjs");
const OPTS = ["pass", "rewrite", "drop"];
const sonnet = (v) => { process.env.STUB_SONNET = v ? JSON.stringify(v) : ""; };
const ctx = (over = {}) => ({
  body: "The customer on account 12 still hasn't enrolled in autopay.",
  observedIso: "2026-09-20T12:00:00.000Z", nowIso: "2026-09-23T12:00:00.000Z", solicited: false,
  rechecked: [{ claim: "the customer hasn't enrolled in autopay", why_mutable: "they could enroll", memory_query: "did the customer enroll",
    search: { ok: true, hits: [{ source: "inbox", title: "Autopay set up: account 12", snippet: "Autopay set up", date: "2026-09-21T10:00", after_evidence: true }] } }],
  input: { subject: "hum:ideas:customer-autopay" },
  ...over,
});

test("confident Jev drop (proactive) is acted on; the memory rows reached Jev as state", async () => {
  jevAnswer = choice("drop", 0.95, OPTS); sonnet({ verdict: "drop", reason: "memory: autopay set up 9/21" });
  const p = await adjudicate(ctx());
  assert.equal(p.verdict, "drop");
  assert.match(p.reason, /^jev:/);
  assert.equal(jevCalls, 1);
  assert.equal(f.claudeRuns(), 1, "shadow ran once");
  assert.equal(f.rows()[0].agree, true);
});

test("shadow week: Sonnet drop beats a confident Jev pass", async () => {
  jevAnswer = choice("pass", 0.97, OPTS); sonnet({ verdict: "drop", reason: "resolved 9/21" });
  const p = await adjudicate(ctx());
  assert.equal(p.verdict, "drop");
  assert.equal(f.disagreements().length, 1);
});

test("Jev rewrite takes Sonnet's corrected text", async () => {
  jevAnswer = choice("rewrite", 0.95, OPTS); sonnet({ verdict: "rewrite", reason: "moved", corrected_text: "The customer enrolled on 9/21." });
  const p = await adjudicate(ctx());
  assert.equal(p.verdict, "rewrite");
  assert.equal(p.corrected_text, "The customer enrolled on 9/21.");
  assert.equal(f.claudeRuns(), 1);
});

test("SOLICITED replies never reach Jev (phone-channel carries no intent/lane): Sonnet decides", async () => {
  jevAnswer = choice("drop", 0.97, OPTS); sonnet({ verdict: "rewrite", reason: "dated", corrected_text: "As of Monday, the customer had not enrolled." });
  const p = await adjudicate(ctx({ solicited: true, input: {} }));
  assert.equal(p.verdict, "rewrite");
  assert.match(p.corrected_text, /As of Monday/);
  assert.equal(jevCalls, 0, "Jev not called for a solicited reply");
  assert.equal(f.rows()[0].reason, "solicited-reply-excluded");
  assert.equal(f.rows()[0].input, "[withheld]");
});

test("a forwarded hum lane (claim-check → freshness) keeps a health candidate off Jev", async () => {
  jevAnswer = choice("pass", 0.99, OPTS); sonnet({ verdict: "pass", reason: "fine" });
  await adjudicate(ctx({ input: { subject: "customer", lane: "health", intent: null } }));
  assert.equal(jevCalls, 0);
  await adjudicate(ctx({ input: { subject: "customer", intent: "hum:health:labs" } }));
  assert.equal(jevCalls, 0);
});

test("low-confidence Jev → Sonnet adjudicates", async () => {
  jevAnswer = choice("pass", 0.6, OPTS); sonnet({ verdict: "rewrite", reason: "x", corrected_text: "y" });
  const p = await adjudicate(ctx());
  assert.equal(p.verdict, "rewrite");
  assert.equal(f.rows()[0].used, "legacy");
});

test("finance / health intents never reach Jev", async () => {
  for (const subject of ["hum:finance:dup-charge", "health-alert", "hum:health:rbc"]) {
    f.reset(); jevCalls = 0;
    jevAnswer = choice("pass", 0.99, OPTS); sonnet({ verdict: "pass", reason: "ok" });
    await adjudicate(ctx({ input: { subject } }));
    assert.equal(jevCalls, 0, `${subject}: Jev not called`);
    assert.match(f.rows()[0].reason, /^private-intent-excluded/);
  }
});

test("privacy screen: a YES keeps the memory rows off Jev", async () => {
  process.env.JEV_PRIVATE_SCREEN = ""; screen = "YES";
  jevAnswer = choice("pass", 0.99, OPTS); sonnet({ verdict: "pass", reason: "ok" });
  const p = await adjudicate(ctx());
  assert.equal(p.verdict, "pass");
  assert.equal(jevCalls, 0);
  assert.match(f.rows()[0].reason, /^sensitive-excluded/);
});

test("Sonnet down + Jev unsure → null (caller's adjudicator_unavailable → pass)", async () => {
  jevAnswer = choice("pass", 0.5, OPTS); sonnet(null);
  assert.equal(await adjudicate(ctx()), null);
});

test("the ADJUDICATE_PROMPT path is unchanged: Sonnet is still asked with the claim block", async () => {
  // The stub echoes STUB_SONNET regardless of prompt; this guards that the
  // legacy call still happens (shadow) on a normal Jev decision.
  jevAnswer = choice("pass", 0.97, OPTS); sonnet({ verdict: "pass", reason: "ok" });
  await adjudicate(ctx());
  assert.ok(fs.existsSync(f.CLAUDE_COUNT));
});
