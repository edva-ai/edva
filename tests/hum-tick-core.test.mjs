// hum-tick-core.test.mjs — the helpers left from the hum code tick runner
// (reservoir gate, run-log candidate shape), the shared extract-json parser,
// and the pre-rank veto filter.
// Run: node --test tests/hum-tick-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hum-tick-core-"));
// Isolate every ledger the veto lib reads before it is imported.
const FEEDBACK = path.join(tmp, "hum-feedback.jsonl");
process.env.HUM_FEEDBACK_PATH = FEEDBACK;
process.env.HUM_STATE_PATH = path.join(tmp, "hum-state.json"); // ping-budget's live counter
process.env.HUM_NOVELTY_SIDECAR = path.join(tmp, "vectors.jsonl");
// A synthetic installation whose Rule #1 lane is "practice" (hum-lanes.json protected_lanes).
const LOCAL = path.join(tmp, "local");
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "config", "hum-lanes.json"), JSON.stringify({ protected_lanes: ["practice"] }));
process.env.EDVA_LOCAL_DIR = LOCAL;

const core = await import("../lib/hum-tick-core.mjs");
const { extractJsonObject, balancedObjectSpans } = await import("../lib/extract-json.mjs");
const vetoes = await import("../lib/hum-vetoes.mjs");
const { previewVerdict } = await import("../lib/jev-hum-gate.mjs");

// ─── extract-json ──────────────────────────────────────────────────────────
test("extractJsonObject survives braces in surrounding prose (the greedy-match bug)", () => {
  const out = 'I checked {two} sources.\n{"items":[{"title":"A } B","url":"x"}]}\nDone {ok}.';
  assert.deepEqual(extractJsonObject(out, { requireKey: "items" }), { items: [{ title: "A } B", url: "x" }] });
});

test("extractJsonObject honours requireKey and skips a stray object", () => {
  const out = '{"note":1} then {"emit":false,"reason":"quiet"}';
  assert.deepEqual(extractJsonObject(out, { requireKey: "emit" }), { emit: false, reason: "quiet" });
});

test("extractJsonObject recovers an object after an unbalanced brace", () => {
  assert.deepEqual(extractJsonObject('use { carefully: {"say":true}', { requireKey: "say" }), { say: true });
});

test("extractJsonObject returns null rather than throwing", () => {
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject('{"a":'), null);
});

test("balancedObjectSpans ignores escaped quotes inside strings", () => {
  assert.deepEqual(balancedObjectSpans('{"a":"he said \\"}\\""}'), ['{"a":"he said \\"}\\""}']);
});

// ─── reservoir refill gate (hum.md § silent step 3) ───────────────────────
test("silent-streak refill is gated on reservoir health, not the streak alone", () => {
  assert.equal(core.shouldRefill(6, 40), false, "healthy reservoir: silence is the designed norm");
  assert.equal(core.shouldRefill(6, 3), true);
  assert.equal(core.shouldRefill(2, 3), false);
  const rows = [{ id: "idea-a" }, { id: "idea-b" }, { id: "idea-b", consumed: true }, { id: "idea-c", expired: true }];
  assert.equal(core.reservoirLiveCount(rows), 1);
});

test("traceCandidate keeps the item's own link from structured fields", () => {
  const t = core.traceCandidate({ topic: "news", urgency: 0.5, dedup_key: "k", signal: "x".repeat(400), supporting_data: { top: { link: "https://nyt.com/a" } } });
  assert.equal(t.url, "https://nyt.com/a");
  assert.equal(t.signal.length, core.TRACE_SIGNAL_MAX);
  assert.equal(core.traceCandidate({ topic: "x", url: "not a link" }).url, undefined);
});

test("the code-only ranker, shadow comparison and cutover are gone (D16, 2026-10-22)", () => {
  for (const gone of ["compareShadow", "cutoverReady", "CUTOVER", "buildBrief", "validateDecision", "buildTrace", "compareExtras"]) {
    assert.equal(core[gone], undefined, `${gone} should be removed`);
  }
});

// ─── pre-rank vetoes ───────────────────────────────────────────────────────
test("preRankFilter drops a 24h dedup repeat but spares Rule #1 lanes and urgent ones", async () => {
  const sent = new Date(Date.now() - 2 * 3600_000).toISOString();
  fs.writeFileSync(FEEDBACK, JSON.stringify({ sent_at: sent, ping_id: "p-1", findings: [{ dedup_key: "news:dup" }, { dedup_key: "practice:dup" }, { dedup_key: "urgent:dup" }] }) + "\n");
  const { eligible, vetoed } = await vetoes.preRankFilter([
    { topic: "news", dedup_key: "news:dup", urgency: 0.5, signal: "s1" },
    { topic: "practice", dedup_key: "practice:dup", urgency: 0.5, signal: "s2" },
    { topic: "news", dedup_key: "urgent:dup", urgency: 0.95, signal: "s3" },
    { topic: "news", dedup_key: "news:fresh", urgency: 0.5, signal: "s4" },
  ], { embed: async () => null });
  assert.deepEqual(vetoed.map((v) => [v.dedup_key, v.gate]), [["news:dup", "cross_send_dedup"]]);
  assert.deepEqual(eligible.map((c) => c.dedup_key), ["practice:dup", "urgent:dup", "news:fresh"]);
});

test("preRankFilter enforces the retrospective-ask daily cap", async () => {
  const today = new Date().toISOString();
  const rows = [1, 2, 3].map((i) => JSON.stringify({ sent_at: today, ping_id: `p-${i}`, findings: [{ dedup_key: `location_ask:v${i}` }] }));
  fs.writeFileSync(FEEDBACK, rows.join("\n") + "\n");
  const { eligible, vetoed } = await vetoes.preRankFilter([
    { topic: "location_context", dedup_key: "location_ask:v9", urgency: 0.6, signal: "were you at X?" },
    { topic: "nearby", dedup_key: "nearby:1", urgency: 0.6, signal: "a market" },
  // The three asks went out "now", so the 45-min ping budget would also hold the
  // nearby candidate; that gate has its own tests (ping-budget.test.mjs).
  ], { embed: async () => null, checkPingBudget: () => ({ ok: true }) });
  assert.deepEqual(vetoed.map((v) => v.gate), ["retrospective_ask_cap"]);
  assert.deepEqual(eligible.map((c) => c.topic), ["nearby"]);
});

test("preRankFilter applies the novelty gate and fails open on a dead embedder", async () => {
  fs.writeFileSync(FEEDBACK, "");
  const vec = [1, 0, 0];
  const cands = () => [{ topic: "news", dedup_key: "n:1", urgency: 0.5, signal: "same thing" }];
  const blocked = await vetoes.preRankFilter(cands(), {
    embed: async () => vec, recentVectors: () => [{ ping_id: "p-old", vec }], noveltyThreshold: 0.93,
  });
  assert.equal(blocked.vetoed[0]?.gate, "novelty_duplicate");
  const open = await vetoes.preRankFilter(cands(), { embed: async () => { throw new Error("ollama down"); } });
  assert.equal(open.eligible.length, 1);
});

test("deriveDedupKey matches between pre-rank and hum-ping", () => {
  const a = vetoes.deriveDedupKey({ topic: "news", signal: "hello" }, "news");
  const c = { topic: "news", signal: "hello" };
  assert.equal(a, vetoes.deriveDedupKey(c, "news", "the rendered message is ignored when a signal exists"));
  assert.ok(vetoes.isProtectedIntent("hum:practice:pre-slot"));
  assert.ok(!vetoes.isProtectedIntent("hum:news:x"));
});

// ─── preview verdict (idle-bundle gate) ────────────────────────────────────
test("previewVerdict skips only when nothing is eligible and nothing went unseen", () => {
  assert.equal(previewVerdict(null).skip, false);
  assert.equal(previewVerdict({ candidates: [], meta: { eligible_count: 0, preview_skipped_model_lanes: ["art"], errors: [] } }).skip, false);
  assert.equal(previewVerdict({ candidates: [], meta: { eligible_count: 0, errors: [{ topic: "tasks" }] } }).skip, false);
  assert.equal(previewVerdict({ candidates: [{}], meta: { eligible_count: 1, errors: [] } }).skip, false);
  const v = previewVerdict({ candidates: [], claim_check: { dropped: [] }, meta: { eligible_count: 0, errors: [], attempted: ["tasks", "news"], pre_rank_vetoes: [{}] } });
  assert.equal(v.skip, true);
  assert.match(v.reason, /nothing eligible/);
});

// ─── preview write-guard (_common.mjs) ─────────────────────────────────────
test("HUM_HARVEST_PREVIEW=1 turns data writes into no-ops (fs default + named imports)", async () => {
  const { execFileSync } = await import("node:child_process");
  const common = new URL("../agent/scripts/hum-harvesters/_common.mjs", import.meta.url).href;
  const probe = path.join(os.homedir(), "Dev/edva/data", `__preview_probe_${process.pid}.json`);
  const outside = path.join(tmp, "outside.txt");
  const script = `
    const c = await import(${JSON.stringify(common)});
    const fs = (await import("node:fs")).default;
    const { appendFileSync } = await import("node:fs");
    fs.writeFileSync(${JSON.stringify(probe)}, "x");
    appendFileSync(${JSON.stringify(probe)}, "y");
    c.stampRun("probe-topic", true);
    fs.writeFileSync(${JSON.stringify(outside)}, "ok");
    console.log(c.PREVIEW, fs.existsSync(${JSON.stringify(probe)}));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, HUM_HARVEST_PREVIEW: "1" },
  }).trim();
  assert.equal(out, "true false");
  assert.equal(fs.readFileSync(outside, "utf8"), "ok", "writes outside data still happen");
});
