// repl-runner.test.mjs — the SAFE-activation boundary for the WP8 REPL.
// Run: node --test tests/repl-runner.test.mjs
//
// Security-critical assertions: REPL code cannot reach the host (no
// require/process), cannot invoke a non-allowlisted tool, cannot shell out, and
// cannot hard-delete; the Haiku sampler is concurrency+budget capped; and the
// SAFE writes (wiki_save/wiki_supersede) are budget-capped + refuse episodic /
// pin_locked pages. These are what make exposing `repl_run` to a (possibly
// prompt-injected) agent turn safe.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// Fixture DB set BEFORE importing repl-runner (it require()s wiki-store, which
// binds MEMORY_INDEX_DB at load) so writes never touch the real memory store.
const fixtureDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "repl-runner-test-"));
process.env.MEMORY_INDEX_DB = nodePath.join(fixtureDir, "m.db");
process.env.MEMORY_INDEX_DIR = nodePath.join(fixtureDir, "mem");
fs.mkdirSync(process.env.MEMORY_INDEX_DIR, { recursive: true });
process.env.MEMORY_DB_AUTHORITATIVE = "1";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(nodePath.resolve("lib/wiki-store.js"));
const { getReplSandbox, makeCappedSampler, REPL_READ_ALLOWLIST, REPL_WRITE_ALLOWLIST, _resetForTest } =
  await import(nodePath.resolve("agent/runtime/repl-runner.mjs") + `?t=${Date.now()}`);

// Fake tools-mcp read tools: one allowlisted read tool + one dangerous tool that
// MUST never be registered/reached.
function fakeTools() {
  return [
    { name: "wiki_read", description: "read", schema: { type: "object" },
      run: async (a) => ({ ok: true, page: a.id || "none" }) },
    { name: "email-send", description: "DANGEROUS", schema: { type: "object" },
      run: async () => { throw new Error("email-send SHOULD NEVER RUN FROM REPL"); } },
  ];
}
function fresh() {
  _resetForTest();
  delete process.env.REPL_ENABLED;
  return getReplSandbox(fakeTools()).sandbox;
}

before(() => {
  // A pin_locked identity-core page + an episodic day page — both must be
  // refused by REPL writes.
  ws.savePage("user_owner", "---\nname: Owner\ntype: user\n---\nidentity core\n", { editedBy: "test" });
  ws.setPinLocked("user_owner", true);
  ws.savePage("day_2026-01-01", "---\nname: Jan 1\ntype: day\n---\nepisodic\n", { editedBy: "test" });
});
after(() => {
  try { _resetForTest(); } catch {}
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("allowlists exclude anything that sends/pays/browses/deletes", () => {
  for (const bad of ["email-send", "gmail-action", "plaid", "computer", "repl_run", "wiki_delete"]) {
    assert.ok(!REPL_READ_ALLOWLIST.includes(bad) && !REPL_WRITE_ALLOWLIST.includes(bad), `${bad} must not be allowlisted`);
  }
  assert.deepEqual(REPL_WRITE_ALLOWLIST, ["wiki_save", "wiki_supersede"], "writes are exactly save+supersede");
});

test("REPL code cannot reach the host (no require/process/fs)", async () => {
  const s = fresh();
  const r = await s.evaluate("return [typeof require, typeof process, typeof globalThis.process, typeof module].join(',')");
  assert.equal(r.ok, true);
  assert.equal(r.result, "undefined,undefined,undefined,undefined");
});

test("a non-allowlisted tool is unreachable (executeTool unknown, no global)", async () => {
  const s = fresh();
  const r = await s.evaluate("return await executeTool('email-send', {to:'x'})");
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /unknown tool/i);
  const g = await s.evaluate("return [typeof emailSend, typeof wikiDelete].join(',')");
  assert.equal(g.result, "undefined,undefined", "no email/delete globals");
});

test("hard delete is NOT reachable", async () => {
  const s = fresh();
  const r = await s.evaluate("return await executeTool('wiki_delete', {id:'user_owner'})");
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /unknown tool/i);
});

test("an allowlisted read tool IS reachable (executeTool + camelCase)", async () => {
  const s = fresh();
  assert.equal((await s.evaluate("return (await executeTool('wiki_read',{id:'z'})).page")).result, "z");
  assert.equal((await s.evaluate("return (await wikiRead({id:'q'})).page")).result, "q");
});

test("shell is disabled", async () => {
  const s = fresh();
  const r = await s.evaluate("return await sh`echo hi`");
  assert.equal(r.ok, false);
  assert.match(r.error, /sh is disabled/i);
});

test("wiki_save creates a page (tracked, edited_by=repl)", async () => {
  const s = fresh();
  const r = await s.evaluate("return await executeTool('wiki_save', {id:'reference_repl_made', body:'---\\nname: Made\\ntype: reference\\n---\\nby repl\\n'})");
  assert.equal(r.result.ok, true);
  const p = ws.getPage("reference_repl_made");
  assert.ok(p && /by repl/.test(p.body_md), "page was written to the store");
});

test("wiki_save REFUSES pin_locked identity-core + episodic pages", async () => {
  const s = fresh();
  const locked = await s.evaluate("return await executeTool('wiki_save', {id:'user_owner', body:'---\\nname:x\\ntype:user\\n---\\nHACKED\\n'})");
  assert.equal(locked.result.ok, false);
  assert.match(locked.result.error, /pin_locked/i);
  const day = await s.evaluate("return await executeTool('wiki_save', {id:'day_2026-01-01', body:'---\\nname:x\\ntype:day\\n---\\nHACKED\\n'})");
  assert.equal(day.result.ok, false);
  assert.match(day.result.error, /episodic/i);
  // ...and neither protected page was mutated.
  assert.match(ws.getPage("user_owner").body_md, /identity core/);
  assert.match(ws.getPage("day_2026-01-01").body_md, /episodic/);
});

test("wiki_save is budget-capped per run (≤20 writes)", async () => {
  const s = fresh();
  const r = await s.evaluate(
    "let ok=0,budget=0; for(let i=0;i<23;i++){const res=await executeTool('wiki_save',{id:'reference_replbud_'+i,body:'---\\nname:B'+i+'\\ntype:reference\\n---\\nx\\n'}); if(res.ok)ok++; else if(/budget/.test(res.error))budget++;} return ok+','+budget",
  );
  assert.equal(r.result, "20,3", "20 writes then budget exhausted");
});

test("kill switch: REPL_ENABLED=0 disables eval", async () => {
  _resetForTest();
  process.env.REPL_ENABLED = "0";
  try {
    const { sandbox } = getReplSandbox(fakeTools());
    const r = await sandbox.evaluate("return 1+1");
    assert.equal(r.ok, false);
    assert.match(r.error, /disabled/i);
  } finally {
    delete process.env.REPL_ENABLED;
    _resetForTest();
  }
});

test("sampler is concurrency- and budget-capped", async () => {
  let inFlight = 0, maxInFlight = 0, calls = 0;
  const base = async () => {
    calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return "ok";
  };
  const { sampler, resetRun } = makeCappedSampler(base);
  resetRun();
  const out = await Promise.all(Array.from({ length: 45 }, () => sampler({ messages: [] })));
  assert.equal(calls, 40, "budget capped real sampler calls at 40/run");
  assert.ok(maxInFlight <= 3, `concurrency capped at 3 (saw ${maxInFlight})`);
  assert.equal(out.filter((x) => x === "[sample budget exhausted for this repl_run]").length, 5);
});
