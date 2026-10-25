// tool-registry.test.mjs — WP1 deferred-tool registry.
//
// Run: node --test agent/test/tool-registry.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry, normalizeResult, camelCaseName } from "../core/tool-registry.mjs";

describe("tool-registry pure helpers (WP1)", () => {
  it("normalizeResult wraps strings/objects and passes through {ok}", () => {
    assert.deepEqual(normalizeResult("hi"), { ok: true, result: "hi" });
    assert.deepEqual(normalizeResult({ ok: false, error: "x" }), { ok: false, error: "x" });
    assert.deepEqual(normalizeResult({ count: 3 }), { ok: true, count: 3 });
    assert.deepEqual(normalizeResult(null), { ok: true, result: null });
  });

  it("camelCaseName maps tool names to REPL globals", () => {
    assert.equal(camelCaseName("wiki_search"), "wikiSearch");
    assert.equal(camelCaseName("recall-events"), "recallEvents");
    assert.equal(camelCaseName("output"), "output");
  });
});

describe("tool-registry allowlist / deferral (WP1)", () => {
  it("allowlisted tools go to the model; everything else defers", () => {
    const r = createToolRegistry({ allowlist: ["output"] });
    r.registerTool({ name: "output", description: "reply", handler: () => "ok" });
    r.registerTool({ name: "sonos_status", description: "speaker state", handler: () => "playing" });

    assert.equal(r.isDeferred("output"), false);
    assert.equal(r.isDeferred("sonos_status"), true);

    const forModel = r.toolsForModel();
    assert.equal(forModel.length, 1);
    assert.equal(forModel[0].name, "output");
    assert.ok(forModel[0].input_schema, "uses input_schema shape");
  });

  it("getDeferredTools returns compact manifest, full schemas on demand", () => {
    const r = createToolRegistry({ allowlist: [] });
    r.registerTool({ name: "web_search", description: "search the web", schema: { type: "object", properties: { q: { type: "string" } } }, handler: () => [] });
    const compact = r.getDeferredTools();
    assert.deepEqual(compact, [{ name: "web_search", description: "search the web" }]);
    const full = r.getDeferredTools({ includeToolDefinition: true });
    assert.ok(full[0].input_schema.properties.q);
  });

  it("getDeferredTools filter matches name or description", () => {
    const r = createToolRegistry({ allowlist: [] });
    r.registerTool({ name: "web_search", description: "search the web", handler: () => 1 });
    r.registerTool({ name: "sonos_status", description: "speaker state", handler: () => 1 });
    assert.equal(r.getDeferredTools({ filter: "search" }).length, 1);
    assert.equal(r.getDeferredTools({ filter: /speaker/ }).length, 1);
  });

  it("buildManifest emits one line per deferred tool", () => {
    const r = createToolRegistry({ allowlist: ["output"] });
    r.registerTool({ name: "output", description: "reply", handler: () => 1 });
    r.registerTool({ name: "a_tool", description: "does a", handler: () => 1 });
    r.registerTool({ name: "b_tool", description: "does b", handler: () => 1 });
    const man = r.buildManifest();
    assert.match(man, /- a_tool: does a/);
    assert.match(man, /- b_tool: does b/);
    assert.doesNotMatch(man, /output/, "allowlisted tool not in the deferred manifest");
  });
});

describe("tool-registry execution (WP1)", () => {
  it("executeTool normalizes success and unknown-tool", async () => {
    const r = createToolRegistry();
    r.registerTool({ name: "adder", description: "add", handler: ({ a, b }) => ({ sum: a + b }) });
    assert.deepEqual(await r.executeTool("adder", { a: 2, b: 3 }), { ok: true, sum: 5 });
    assert.deepEqual(await r.executeTool("missing", {}), { ok: false, error: "unknown tool: missing" });
  });

  it("executeTool catches a throwing handler into {ok:false}", async () => {
    const r = createToolRegistry();
    r.registerTool({ name: "boom", description: "throws", handler: () => { throw new Error("kaboom"); } });
    const res = await r.executeTool("boom", {});
    assert.equal(res.ok, false);
    assert.match(res.error, /kaboom/);
  });

  it("awaits async handlers", async () => {
    const r = createToolRegistry();
    r.registerTool({ name: "slow", description: "async", handler: async () => { await Promise.resolve(); return "done"; } });
    assert.deepEqual(await r.executeTool("slow"), { ok: true, result: "done" });
  });

  it("replBindings exposes camelCase bound executors", async () => {
    const r = createToolRegistry();
    r.registerTool({ name: "wiki_search", description: "search", handler: ({ query }) => ({ hits: [query] }) });
    const g = r.replBindings();
    assert.equal(typeof g.wikiSearch, "function");
    assert.deepEqual(await g.wikiSearch({ query: "piano" }), { ok: true, hits: ["piano"] });
  });
});

describe("tool-registry MCP bridge (WP1)", () => {
  it("registerFromMcpTools ingests the tools-mcp TOOLS shape", async () => {
    const r = createToolRegistry({ allowlist: [] });
    const mcpTools = [
      { name: "sonos_status", description: "speaker state", schema: { type: "object", properties: {} }, run: async () => "playing" },
      { name: "bad", description: "no run" }, // skipped (no run)
    ];
    const n = r.registerFromMcpTools(mcpTools);
    assert.equal(n, 1);
    assert.equal(r.has("sonos_status"), true);
    assert.deepEqual(await r.executeTool("sonos_status", {}), { ok: true, result: "playing" });
  });
});
