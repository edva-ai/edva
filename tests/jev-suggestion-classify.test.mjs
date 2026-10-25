// jev-suggestion-classify.test.mjs — Jev primary / rules+Gemma shadow in
// bin/suggestion-classify. Drives the real CLI (fixture HOME, --dry-run)
// against a local stub of the AI Gateway evaluate endpoint (JEV_ENDPOINT).
//
// Run: node --test tests/jev-suggestion-classify.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "../bin/suggestion-classify");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jev-sugg-"));
const DATA = path.join(fixture, "Dev/edva/data");
fs.mkdirSync(DATA, { recursive: true });
const SHADOW = path.join(fixture, "shadow");
const CONFIG = path.join(fixture, "jev-config.json");
fs.writeFileSync(CONFIG, JSON.stringify({ shadow_days: 7, shadow_until: new Date(Date.now() + 864e5).toISOString(), default_threshold: 0.85, sites: {} }));

const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
function writePing(lane) {
  fs.writeFileSync(path.join(DATA, "hum-feedback.jsonl"), JSON.stringify({
    ping_id: `p-${lane}`, sent_at: ago(1), lane, reaction: null, message_id: "m-ping",
    findings: [{ subject_key: `${lane}:abc`, subject_display: "Try Example Bistro for dinner" }],
  }) + "\n");
}

let answers = null;
const CALLS = path.join(fixture, "jev-calls.log");
const PRELOAD = path.join(fixture, "stub-fetch.mjs");
fs.writeFileSync(PRELOAD, `
import fs from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("/v1/systemone")) return real(url, init);
  fs.appendFileSync(process.env.JEV_TEST_CALLS, "call\\n");
  return new Response(JSON.stringify({ model: "jev-latest", answers: JSON.parse(process.env.JEV_TEST_ANSWERS) }), { status: 200 });
};
`);
const calls = () => { try { return fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

function run(text, id, extraEnv) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--import", PRELOAD, BIN, "--message-id", id, "--dry-run", "--text", text], {
      env: { ...process.env, HOME: fixture, TYPESAFE_API_KEY: "k", JEV_CONFIG_FILE: CONFIG,
        JEV_QUESTIONS_DIR: path.join(HERE, "../agent/config/jev-questions"), JEV_SHADOW_DIR: SHADOW, JEV_NO_ALERT: "1",
        JEV_TEST_ANSWERS: JSON.stringify(answers), JEV_TEST_CALLS: CALLS,
        JEV_DRY_RUN: "1", JEV_PRIVATE_SCREEN: "off", ...(extraEnv || {}),
        // Gemma unreachable: the legacy path's fallback returns "unavailable" fast.
        OLLAMA_URL: "http://127.0.0.1:9" },
    });
    let out = ""; c.stdout.on("data", (d) => (out += d));
    c.on("close", (status) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ status, json }); });
  });
}
const rows = () => fs.readdirSync(SHADOW).filter((f) => /^\d{4}/.test(f))
  .flatMap((f) => fs.readFileSync(path.join(SHADOW, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
const B = (p) => ({ type: "boolean", probability: p });
const C = (choice, p) => ({ type: "choice", choice, probabilities: { [choice]: p, _other: 1 - p } });

test("Jev reads a reaction the rules miss, carries love/up + reason", async () => {
  writePing("dining");
  answers = { is_reaction: B(0.97), disposition: C("positive", 0.95), reason: C("none", 0.9), strength: C("love", 0.9) };
  const { status, json } = await run("ooh that one looks fun, let's do Friday", "s1");
  assert.equal(status, 0);
  assert.equal(json.disposition, "positive");
  assert.equal(json.reaction_token, "love");
  assert.equal(json.source, "phone_jev");
  const r = rows().find((x) => x.id === "s1");
  assert.equal(r.used, "jev");
  // Legacy: no rule matches and Gemma is unreachable → the shadow is an error,
  // not a verdict, so nothing is compared (Ollama-down is never a disagreement).
  assert.equal(r.agree, undefined);
  assert.match(r.shadow.error, /gemma unavailable/);
});

test("confident Jev non-reaction overrides a rule hit, and the disagreement is logged", async () => {
  writePing("dining");
  answers = { is_reaction: B(0.03), disposition: C("neutral", 0.5), reason: C("none", 0.9), strength: C("none", 0.9) };
  const { status } = await run("no, I meant the other calendar", "s2");
  assert.equal(status, 1);
  const r = rows().find((x) => x.id === "s2");
  assert.equal(r.used, "jev");
  assert.equal(r.agree, false);
  assert.ok(fs.readFileSync(path.join(SHADOW, "disagreements.jsonl"), "utf8").includes('"id":"s2"'));
});

test("low-confidence Jev falls back to the legacy rules", async () => {
  writePing("dining");
  answers = { is_reaction: B(0.6), disposition: C("negative", 0.6), reason: C("price", 0.6), strength: C("none", 0.9) };
  const { status, json } = await run("too expensive", "s3");
  assert.equal(status, 0);
  assert.equal(json.disposition, "negative");
  assert.equal(json.reason, "price");
  assert.equal(json.source, "phone_rule");
  assert.equal(rows().find((x) => x.id === "s3").reason, "jev-low-confidence");
});

test("an ideas ping's \"(idea)\" placeholder gives way to its headline", async () => {
  // Every ideas-lane ping is stored with subject_display "(idea)"; Jev and Gemma
  // were shown that instead of what the user was replying to (a logged disagreement).
  fs.writeFileSync(path.join(DATA, "hum-feedback.jsonl"), JSON.stringify({
    ping_id: "p-idea", sent_at: ago(1), lane: "ideas", reaction: null, message_id: "m-idea",
    findings: [{ subject_key: "ideas:idea-market", subject_display: "(idea)",
      signal: "Riverside fair Sun + picnic — Oct 11 plan" }],
  }) + "\n");
  answers = { is_reaction: B(0.95), disposition: C("negative", 0.9), reason: C("none", 0.9), strength: C("none", 0.9) };
  const { status, json } = await run("not this one, thanks", "s-idea");
  assert.equal(status, 0);
  assert.equal(json._ping.display, "Riverside fair Sun + picnic — Oct 11 plan");
  const r = rows().find((x) => x.id === "s-idea");
  assert.equal(JSON.parse(r.input).suggestion, "Riverside fair Sun + picnic — Oct 11 plan");
});

test("a real display still wins over the signal; a lone placeholder is kept", async () => {
  fs.writeFileSync(path.join(DATA, "hum-feedback.jsonl"), [
    { ping_id: "p-real", sent_at: ago(2), lane: "dining", reaction: null, message_id: "m-real",
      findings: [{ subject_key: "dining:example-bistro", subject_display: "Example Bistro (downtown Italian)", signal: "Example Bistro has a 9pm table tonight" }] },
    { ping_id: "p-bare", sent_at: ago(1), lane: "ideas", reaction: null, message_id: "m-bare",
      findings: [{ subject_key: "ideas:bare", subject_display: "(idea)" }] },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  answers = { is_reaction: B(0.95), disposition: C("positive", 0.9), reason: C("none", 0.9), strength: C("up", 0.9) };
  const bare = await run("sounds good", "s-bare");
  assert.equal(bare.json._ping.display, "(idea)");
  fs.writeFileSync(path.join(DATA, "hum-feedback.jsonl"), JSON.stringify({
    ping_id: "p-real", sent_at: ago(1), lane: "dining", reaction: null, message_id: "m-real",
    findings: [{ subject_key: "dining:example-bistro", subject_display: "Example Bistro (downtown Italian)", signal: "Example Bistro has a 9pm table tonight" }],
  }) + "\n");
  const real = await run("sounds good", "s-real");
  assert.equal(real.json._ping.display, "Example Bistro (downtown Italian)");
});

test("a health-lane ping never reaches Jev", async () => {
  writePing("health");
  const before = calls();
  const { status, json } = await run("too expensive", "s4");
  assert.equal(status, 0);
  assert.equal(json.source, "phone_rule");
  assert.equal(calls(), before);
  const r = rows().find((x) => x.id === "s4");
  assert.equal(r.reason, "health-excluded");
  assert.doesNotMatch(JSON.stringify(r), /expensive/);
});

test("plain --dry-run (no JEV_DRY_RUN) never calls Jev or writes shadow logs", async () => {
  writePing("dining");
  answers = { is_reaction: B(0.97), disposition: C("positive", 0.95), reason: C("none", 0.9), strength: C("love", 0.9) };
  const before = calls();
  await run("ooh that one looks fun", "s-dry", { JEV_DRY_RUN: "0" }); // exit 1 = no classification (Gemma down) is fine
  assert.equal(calls(), before, "no Jev call");
  assert.equal(rows().filter((x) => x.id === "s-dry").length, 0, "no shadow row");
});

test("privacy screen fails closed (Ollama unreachable) → legacy, text withheld", async () => {
  writePing("dining");
  answers = { is_reaction: B(0.97), disposition: C("positive", 0.95), reason: C("none", 0.9), strength: C("love", 0.9) };
  const before = calls();
  await run("skip it, my knee is killing me", "s-priv", { JEV_PRIVATE_SCREEN: "" });
  assert.equal(calls(), before, "Jev not called");
  const r = rows().find((x) => x.id === "s-priv");
  assert.equal(r.used, "legacy");
  assert.match(r.reason, /^sensitive-excluded/);
  assert.equal(r.input, "[withheld]");
});
