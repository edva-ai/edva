// jev-auto-recall.test.mjs — Jev as the primary auto-recall relevance judge.
// Run: node --test tests/jev-auto-recall.test.mjs
//
// Network is fully stubbed: global fetch answers the Jev evaluate endpoint and
// the Ollama chat (private screen) / embeddings calls; the Sonnet judge is
// pointed at /usr/bin/false so the legacy/shadow path fails fast and offline.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-auto-recall-"));
fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
fs.mkdirSync(path.join(tmp, "questions"), { recursive: true });
fs.copyFileSync(new URL("../agent/config/jev-questions/auto-recall.json", import.meta.url), path.join(tmp, "questions/auto-recall.json"));
fs.writeFileSync(path.join(tmp, "jev-config.json"), JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {} }));
Object.assign(process.env, {
  MEMORY_INDEX_DIR: path.join(tmp, "memory"),
  MEMORY_INDEX_DB: path.join(tmp, "memory-index.db"),
  MEMORY_DB_AUTHORITATIVE: "1",
  JEV_CONFIG_FILE: path.join(tmp, "jev-config.json"),
  JEV_QUESTIONS_DIR: path.join(tmp, "questions"),
  JEV_SHADOW_DIR: path.join(tmp, "shadow"),
  JEV_ENDPOINT: "https://jev.test/v1/evaluate",
  JEV_NO_ALERT: "1",
  TYPESAFE_API_KEY: "test-key",
  AUTO_RECALL_CLAUDE_BIN: "/usr/bin/false",
  AUTO_RECALL_JUDGE_LOG: path.join(tmp, "judge.jsonl"),
});
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.JEV_PRIVATE_SCREEN;

let screenAnswer = "NO";
let jevCalls = 0;
let jevProb = 0.97;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://jev.test")) {
    jevCalls++;
    const body = JSON.parse(init.body);
    assert.equal(body.providerOptions, undefined, "TypeSafe direct: no gateway pinning");
    const answers = {};
    for (const k of Object.keys(body.questions)) answers[k] = { type: "boolean", probability: k === "c0" ? jevProb : 0.02 };
    return new Response(JSON.stringify({ answers, providerMetadata: { gateway: { cost: "0.00001" } } }), { status: 200 });
  }
  if (u.includes("/api/chat")) return new Response(JSON.stringify({ message: { content: screenAnswer } }), { status: 200 });
  if (u.includes("/api/embeddings")) return new Response("no", { status: 500 });
  return realFetch(url, init);
};

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const ar = await import(path.resolve("lib/auto-recall.mjs") + `?t=${Date.now()}`);

function shadowRows() {
  const dir = path.join(tmp, "shadow");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

before(() => {
  ws.savePage("user_food_prefs",
    `---\nname: Food taste\ndescription: Restaurant and dining preferences\ntype: user\n---\nThe user loves authentic food and eating out at restaurants; Italian and Mexican favored.\n`,
    { editedBy: "test" });
});
beforeEach(() => { jevCalls = 0; screenAnswer = "NO"; jevProb = 0.97; fs.rmSync(path.join(tmp, "shadow"), { recursive: true, force: true }); });
after(() => {
  globalThis.fetch = realFetch;
  try { ws.closeDb(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("interpretRecallAnswers: keeps p>=0.5 best-first, capped at 4, confidence = the anchor", () => {
  const answers = {};
  const ps = [0.9, 0.1, 0.99, 0.6, 0.8, 0.7, 0.95];
  ps.forEach((p, i) => { answers[`c${i}`] = { type: "boolean", probability: p }; });
  const r = ar.interpretRecallAnswers(answers, ps.length);
  assert.deepEqual(r.value, [2, 6, 0, 4]);
  // The set is anchored by c2 at 0.99. The fence-sitter at 0.6 rides along as
  // one extra line; it does not get to veto a block with a certain best hit.
  assert.equal(Math.round(r.confidence * 100), 99);
  assert.deepEqual(ar.interpretRecallAnswers({}, 2), { value: [], confidence: 0 }, "missing answer → unusable");
});

test("interpretRecallAnswers: keeping nothing is scored by the nearest miss", () => {
  const mk = (ps) => { const a = {}; ps.forEach((p, i) => { a[`c${i}`] = { type: "boolean", probability: p }; }); return a; };
  // Clean sweep — nothing came close, so "no relevant memory" is a confident answer.
  assert.equal(Math.round(ar.interpretRecallAnswers(mk([0.07, 0.11, 0.18]), 3).confidence * 100), 82);
  // A near-miss at 0.32 means we may be discarding something; that is the
  // failure auto-recall exists to prevent, so it stays below the 0.65 bar.
  assert.equal(Math.round(ar.interpretRecallAnswers(mk([0.07, 0.32, 0.18]), 3).confidence * 100), 68);
  // An anchored set is scored by its best note, not by its weakest.
  assert.equal(Math.round(ar.interpretRecallAnswers(mk([0.43, 0.48, 0.67]), 3).confidence * 100), 67);
});

test("sameIndexSet ignores order, not membership", () => {
  assert.equal(ar.sameIndexSet([2, 0], [0, 2]), true);
  assert.equal(ar.sameIndexSet([2], [0, 2]), false);
  assert.equal(ar.sameIndexSet([], []), true);
});

test("jevRecallQuestions builds one boolean per candidate with its number", () => {
  const q = ar.jevRecallQuestions([{}, {}, {}]);
  assert.deepEqual(Object.keys(q), ["c0", "c1", "c2"]);
  assert.equal(q.c1.type, "boolean");
  assert.match(q.c1.instructions, /candidate number 1 /);
});

test("confident Jev verdict builds the block and is logged as used=jev", async () => {
  const block = await ar.autoRecallBlock("restaurant dining preferences favored", { judgeTimeoutMs: 3000 });
  assert.equal(jevCalls, 1);
  assert.ok(block.includes("[wiki user_food_prefs]"), "Jev kept c0");
  await new Promise((r) => setTimeout(r, 300)); // awaitShadow:false — let the shadow finish
  const rows = shadowRows().filter((r) => r.site === "auto-recall");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].used, "jev");
  assert.ok(rows[0].shadow && rows[0].shadow.error, "failed Sonnet shadow is logged as an error, not a disagreement");
  assert.equal(fs.existsSync(path.join(tmp, "shadow/disagreements.jsonl")), false);
});

test("low-confidence Jev falls back to Sonnet; Sonnet down → lexical gate still answers", async () => {
  jevProb = 0.6;
  const block = await ar.autoRecallBlock("restaurant dining preferences favored", { judgeTimeoutMs: 3000, minBm25: 0 });
  assert.equal(jevCalls, 1);
  assert.ok(block.includes("[wiki user_food_prefs]"), "lexical fallback, as before this change");
});

test("private content never reaches Jev (on-device screen says YES)", async () => {
  screenAnswer = "YES";
  await ar.autoRecallBlock("restaurant dining preferences favored", { judgeTimeoutMs: 3000, minBm25: 0 });
  assert.equal(jevCalls, 0, "Jev not called");
  const rows = shadowRows().filter((r) => r.site === "auto-recall");
  await new Promise((r) => setTimeout(r, 100));
  const again = rows.length ? rows : shadowRows().filter((r) => r.site === "auto-recall");
  assert.ok(again.some((r) => String(r.reason).startsWith("sensitive-excluded")));
});

test("screen failure is fail-closed (unclear answer → no Jev)", async () => {
  screenAnswer = "maybe";
  await ar.autoRecallBlock("restaurant dining preferences favored", { judgeTimeoutMs: 3000, minBm25: 0 });
  assert.equal(jevCalls, 0);
});
