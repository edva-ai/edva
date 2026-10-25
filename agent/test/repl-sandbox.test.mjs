// repl-sandbox.test.mjs — WP8 agentic REPL. Mock registry + mock sampler; the
// only real subprocess touched is the gated `sh` echo.
//
// Run: node --test agent/test/repl-sandbox.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../core/tool-registry.mjs";

const TMP_DB = path.join(os.tmpdir(), `repl-store-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");
const { createReplSandbox } = await import("../runtime/repl-sandbox.mjs");

const SPILL = path.join(os.tmpdir(), `repl-spill-${process.pid}`);

function mkRegistry() {
  const r = createToolRegistry({ allowlist: [] });
  r.registerTool({ name: "adder", description: "add", handler: ({ a, b }) => ({ sum: a + b }) });
  r.registerTool({ name: "web_search", description: "search", handler: ({ query }) => ({ hits: [query] }) });
  return r;
}
const mockSampler = async ({ messages }) => "SAMPLED:" + (messages[0]?.content ?? "");

function mkSandbox(extra = {}) {
  return createReplSandbox({
    sessionId: "repl-test", registry: mkRegistry(), sampler: mockSampler,
    store, enabled: true, spillDir: SPILL, spillThreshold: 50, ...extra,
  });
}

function cleanupSpill() { try { fs.rmSync(SPILL, { recursive: true, force: true }); } catch {} }
function cleanupDb() {
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

describe("repl-sandbox gating (WP8)", () => {
  after(() => { cleanupSpill(); cleanupDb(); });

  it("is disabled by default (must opt in behind owner approval)", async () => {
    const sb = createReplSandbox({ registry: mkRegistry() });   // enabled defaults false
    const res = await sb.evaluate("return 1 + 1");
    assert.equal(res.ok, false);
    assert.match(res.error, /disabled/);
  });

  it("sh is gated off by default even when enabled", async () => {
    const sb = mkSandbox();                                     // enableShell defaults false
    const res = await sb.evaluate("return await sh`echo hi`");
    assert.equal(res.ok, false);
    assert.match(res.error, /sh is disabled/);
  });
});

describe("repl-sandbox evaluation (WP8)", () => {
  before(cleanupSpill);
  after(() => { cleanupSpill(); cleanupDb(); });

  it("evaluates an expression and returns the value", async () => {
    const sb = mkSandbox();
    assert.deepEqual(await sb.evaluate("40 + 2"), { ok: true, result: 42, logs: [] });
  });

  it("persists variables across calls (REPL vars as buffers)", async () => {
    const sb = mkSandbox();
    await sb.evaluate("counter = (typeof counter === 'number' ? counter : 0) + 1; return counter");
    const second = await sb.evaluate("counter = counter + 1; return counter");
    assert.equal(second.result, 2);
  });

  it("captures console.log into logs", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("log('hello'); log('world'); return 1");
    assert.deepEqual(res.logs, ["hello", "world"]);
  });

  it("calls tools via executeTool and camelCase globals", async () => {
    const sb = mkSandbox();
    const r1 = await sb.evaluate("return await executeTool('adder', { a: 2, b: 3 })");
    assert.deepEqual(r1.result, { ok: true, sum: 5 });
    const r2 = await sb.evaluate("return await adder({ a: 10, b: 5 })");
    assert.deepEqual(r2.result, { ok: true, sum: 15 });
  });

  it("fans out tool calls with Promise.all", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("return await Promise.all([adder({a:1,b:1}), adder({a:2,b:2})])");
    // Spread into an outer-realm array — the sandbox's Array has a different
    // prototype, which deepStrictEqual (correctly) rejects across realms.
    assert.deepEqual([...res.result].map((r) => r.sum), [2, 4]);
  });

  it("getDeferredTools reads the registry from code", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("return getDeferredTools({ filter: 'search' }).map(t => t.name)");
    assert.deepEqual([...res.result], ["web_search"]);
  });

  it("sample() routes cheap-model fan-out (mock)", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("return await sample({ messages: [{ role: 'user', content: 'summarize' }] })");
    assert.equal(res.result, "SAMPLED:summarize");
  });

  it("spawn/bg/wait tracks background work", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("spawn('k', Promise.resolve(42)); return await wait('k')");
    assert.equal(res.result, 42);
    const bgres = await sb.evaluate("return bg.get('k')");
    assert.equal(bgres.result.status, "settled");
  });

  it("spills oversized results to disk instead of returning them inline", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("return 'x'.repeat(500)");
    assert.equal(res.ok, true);
    assert.ok(res.spilled, "returns a spill path");
    assert.ok(res.bytes > 50);
    assert.ok(fs.existsSync(res.spilled), "spill file written");
  });

  it("protects the bridge globals from reassignment", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("try { executeTool = 123; } catch (e) {} return typeof executeTool");
    assert.equal(res.result, "function");
  });

  it("db bridge reads the WP4 store", async () => {
    store.appendMessage({ agentId: "repl-test", role: "user", content: "a db-visible message" });
    const sb = mkSandbox();
    const res = await sb.evaluate("return db.recent(10).length");
    assert.ok(res.result >= 1);
  });

  it("a throwing eval returns {ok:false} with logs, never throws", async () => {
    const sb = mkSandbox();
    const res = await sb.evaluate("log('before'); throw new Error('boom')");
    assert.equal(res.ok, false);
    assert.match(res.error, /boom/);
    assert.deepEqual(res.logs, ["before"]);
  });
});

describe("repl-sandbox shell (gated, WP8)", () => {
  after(() => { cleanupSpill(); cleanupDb(); });
  it("runs sh when explicitly enabled", async () => {
    // Raise the spill threshold so the small sh result comes back inline.
    const sb = mkSandbox({ enableShell: true, spillThreshold: 100000 });
    const res = await sb.evaluate("return await sh`echo substrate`");
    assert.equal(res.result.ok, true);
    assert.match(res.result.stdout, /substrate/);
  });
});
