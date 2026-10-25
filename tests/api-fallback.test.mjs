// api-fallback.test.mjs — the wiki's API fallback while Max is unavailable
// (lib/api-fallback.mjs, lib/model-ladder.mjs sonnetRung apiCaller).
// Run from the repo root: node --test tests/api-fallback.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-fallback-"));
process.env.HOME = tmp; // no real .env is read
process.env.WIKI_API_NO_ALERT = "1";
delete process.env.EDVA_WIKI_API_KEY;

const af = await import("../lib/api-fallback.mjs");
const ladder = await import("../lib/model-ladder.mjs");

let n = 0;
function freshLedger() {
  const dir = path.join(tmp, `ledger-${n++}`);
  process.env.WIKI_API_LEDGER_DIR = dir;
  return dir;
}
const rows = (dir) => fs.readFileSync(path.join(dir, "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function stubClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(req); if (reply instanceof Error) throw reply; return reply; } } },
  };
}
const ok = (text, usage = { input_tokens: 1000, output_tokens: 200 }) => ({
  model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text }], usage,
});

test("refuses any caller outside the wiki, before touching the network", async () => {
  freshLedger();
  const client = stubClient(ok("{}"));
  const r = await af.apiComplete("x", { caller: "chat", client });
  assert.equal(r.error.kind, "caller");
  assert.equal(client.calls.length, 0);
});

test("without the key it is off, and says so", async () => {
  freshLedger();
  const r = await af.apiComplete("x", { caller: "wiki-answer" });
  assert.equal(r.error.kind, "no_key");
  process.env.WIKI_API_FALLBACK = "0";
  process.env.EDVA_WIKI_API_KEY = "k";
  assert.equal((await af.apiComplete("x", { caller: "wiki-answer" })).error.kind, "disabled");
  delete process.env.WIKI_API_FALLBACK;
  delete process.env.EDVA_WIKI_API_KEY;
});

test("sends Sonnet with server-side default fallbacks, no tools, and writes a priced ledger row", async () => {
  const dir = freshLedger();
  const client = stubClient(ok('{"answer": "yes"}'));
  const r = await af.apiComplete("question", { caller: "wiki-answer", client, maxTokens: 4000, effort: "low" });
  assert.deepEqual([r.out, r.error], ['{"answer": "yes"}', null]);
  const req = client.calls[0];
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(req.output_config, { effort: "low" });
  assert.equal(req.tools, undefined);
  assert.equal(req.temperature, undefined);
  const [row] = rows(dir);
  assert.equal(row.caller, "wiki-answer");
  assert.equal(row.usd, 0.004); // 1000 × $2/M + 200 × $10/M
});

test("bills every attempt in usage.iterations when a server-side fallback ran", () => {
  const usd = af.usageCost({ input_tokens: 100, output_tokens: 10, iterations: [
    { type: "message", input_tokens: 1000, output_tokens: 0 },
    { type: "fallback_message", input_tokens: 1000, output_tokens: 100 },
  ] });
  assert.equal(Number(usd.toFixed(6)), 0.005);
});

test("the cap is checked against the worst case before the call, and refuses at the cap", async () => {
  const dir = freshLedger();
  fs.mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(path.join(dir, "ledger.ndjson"), JSON.stringify({ month, usd: 24.99 }) + "\n" + JSON.stringify({ month: "1999-01", usd: 500 }) + "\n");
  assert.equal(Number(af.monthSpend().toFixed(2)), 24.99, "only this month counts");
  const client = stubClient(ok("{}"));
  const r = await af.apiComplete("x".repeat(3000), { caller: "wiki-portal", client, maxTokens: 16000 });
  assert.equal(r.error.kind, "cap");
  assert.equal(client.calls.length, 0, "never called once over the cap");
  const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(st.cap_paged_month, month, "the cap page is recorded once for the month");
});

test("an unreadable ledger fails closed", async () => {
  const dir = freshLedger();
  fs.mkdirSync(path.join(dir, "ledger.ndjson"), { recursive: true }); // a directory: read throws EISDIR
  const client = stubClient(ok("{}"));
  const r = await af.apiComplete("x", { caller: "wiki-answer", client });
  assert.equal(r.error.kind, "cap");
  assert.equal(client.calls.length, 0);
});

test("a refusal is an error (and still billed); an SDK error is api_error", async () => {
  const dir = freshLedger();
  const refused = { model: "claude-sonnet-5-5", stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [], usage: { input_tokens: 500, output_tokens: 0 } };
  const r = await af.apiComplete("x", { caller: "wiki-facts", client: stubClient(refused) });
  assert.equal(r.error.kind, "refusal");
  assert.equal(rows(dir).length, 1);
  const e = Object.assign(new Error("overloaded"), { status: 529 });
  const r2 = await af.apiComplete("x", { caller: "wiki-facts", client: stubClient(e) });
  assert.equal(r2.error.kind, "api_error");
  assert.ok(r2.error.message.includes("529"));
});

// ── the rung ──────────────────────────────────────────────────────────────

function deps(forkResult) {
  const seen = { fork: 0, api: [] };
  return {
    seen,
    deps: {
      runToollessDetailed: async () => { seen.fork++; return forkResult; },
      apiComplete: async (prompt, opts) => { seen.api.push(opts); return { out: '{"answer": "from api"}', error: null, usd: 0.01 }; },
    },
  };
}
const validAnswer = (p) => (p.answer ? null : "no answer");

test("rung: Max answering means the API is never called", async () => {
  ladder._resetMaxDown();
  const { seen, deps: d } = deps({ out: '{"answer": "from max"}', error: null });
  const res = await ladder.runLadder("q", { rungs: [ladder.sonnetRung({ apiCaller: "wiki-answer", deps: d })], validate: validAnswer });
  assert.equal(res.value.answer, "from max");
  assert.equal(res.via, undefined);
  assert.equal(seen.api.length, 0);
});

test("rung: not_logged_in and usage_limit go to the API; the next call skips the doomed fork", async () => {
  for (const kind of ["not_logged_in", "usage_limit"]) {
    ladder._resetMaxDown();
    const { seen, deps: d } = deps({ out: "", error: { kind, message: "x" } });
    const rung = ladder.sonnetRung({ apiCaller: "wiki-answer", apiMaxTokens: 4000, deps: d });
    const res = await ladder.runLadder("q", { rungs: [rung], validate: validAnswer });
    assert.deepEqual([res.value.answer, res.via, res.rung], ["from api", "api", "sonnet"]);
    assert.equal(seen.api[0].caller, "wiki-answer");
    assert.equal(seen.api[0].maxTokens, 4000);
    await ladder.runLadder("q2", { rungs: [rung], validate: validAnswer });
    assert.equal(seen.fork, 1, "Max is not re-probed for a few minutes after it said it was unavailable");
    assert.equal(seen.api.length, 2);
  }
  ladder._resetMaxDown();
});

test("rung: a timeout or empty output is not a reason to bill the API", async () => {
  for (const kind of ["timeout", "empty_output", "exit_nonzero"]) {
    ladder._resetMaxDown();
    const { seen, deps: d } = deps({ out: "", error: { kind, message: "x" } });
    const res = await ladder.runLadder("q", { rungs: [ladder.sonnetRung({ apiCaller: "wiki-answer", deps: d })], validate: validAnswer });
    assert.equal(res.value, null);
    assert.equal(seen.api.length, 0, kind);
  }
});

test("rung: without apiCaller it stays Max-only", async () => {
  ladder._resetMaxDown();
  const { seen, deps: d } = deps({ out: "", error: { kind: "not_logged_in", message: "x" } });
  // No apiCaller: the plain runToolless path, which never consults deps.
  const rung = ladder.sonnetRung({ deps: d });
  assert.equal(rung.rungName, "sonnet");
  assert.equal(seen.api.length, 0);
});

test("rung: an API failure fails the rung with both reasons", async () => {
  ladder._resetMaxDown();
  const d = {
    runToollessDetailed: async () => ({ out: "", error: { kind: "not_logged_in", message: "x" } }),
    apiComplete: async () => ({ out: "", error: { kind: "cap", message: "monthly cap $25.00 reached" }, usd: 0 }),
  };
  const res = await ladder.runLadder("q", { rungs: [ladder.sonnetRung({ apiCaller: "wiki-facts", deps: d })], validate: validAnswer });
  assert.equal(res.value, null);
  assert.ok(res.errors[0].includes("max not_logged_in; api cap"), res.errors[0]);
  ladder._resetMaxDown();
});

test("the key is read from .env without loading the rest of the file into the environment", async () => {
  freshLedger();
  const envFile = path.join(tmp, "dot-env");
  fs.writeFileSync(envFile, "ANTHROPIC_BASE_URL=https://elsewhere.invalid\nEDVA_WIKI_API_KEY=sk-test\n");
  process.env.WIKI_API_ENV_FILE = envFile;
  const before = process.env.ANTHROPIC_BASE_URL;
  assert.equal(af.fallbackEnabled(), true);
  assert.equal(process.env.ANTHROPIC_BASE_URL, before, "other .env lines stay out of process.env (and out of claude -p forks)");
  assert.equal(process.env.EDVA_WIKI_API_KEY, undefined);
  delete process.env.WIKI_API_ENV_FILE;
});

test("a rejected key (401) pages once per day so someone replaces it", async () => {
  const dir = freshLedger();
  const e = Object.assign(new Error("invalid x-api-key"), { status: 401 });
  const r = await af.apiComplete("x", { caller: "wiki-answer", client: stubClient(e) });
  assert.equal(r.error.kind, "api_error");
  const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.ok(st.key_rejected_day, "the rejection page is recorded for today");
});
