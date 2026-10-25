// capabilities.test.mjs — CAP (Appendix A) capability tools. Every provider is
// INJECTED so nothing spawns claude -p, touches Chrome, or hits the network.
//
// Run: node --test agent/test/capabilities.test.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebSearchTool, parseResults } from "../capabilities/web-search.mjs";
import { createViewImageTool, imageBlock } from "../capabilities/view-image.mjs";
import { createCreateImageTool } from "../capabilities/create-image.mjs";
import { createBrowserTool, SIMPLIFY_DOM_JS } from "../capabilities/browser.mjs";
import { createToolRegistry } from "../core/tool-registry.mjs";
import { createContextHookRegistry } from "../core/context-hooks.mjs";
import { createPluginLoader } from "../plugins/loader.mjs";

// A 1x1 transparent PNG.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const TMP_PNG = path.join(os.tmpdir(), `capimg-${process.pid}.png`);

before(() => fs.writeFileSync(TMP_PNG, PNG_1x1));
after(() => { try { fs.unlinkSync(TMP_PNG); } catch {} });

describe("web_search (A1)", () => {
  it("parseResults pulls the first JSON array out of noisy text and caps it", () => {
    const noisy = `here you go:\n[{"title":"A","url":"http://a","snippet":"one"},{"title":"B","url":"http://b"}] done`;
    const r = parseResults(noisy);
    assert.equal(r.length, 2);
    assert.equal(r[0].url, "http://a");
    assert.equal(r[1].snippet, "");            // missing snippet -> empty string
    assert.deepEqual(parseResults("no json here"), []);
  });

  it("caps at 5 results and truncates snippets", () => {
    const many = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "x".repeat(1000) }))
    );
    const r = parseResults(many);
    assert.equal(r.length, 5);
    assert.equal(r[0].snippet.length, 400);
  });

  it("routes through an injected provider and returns the {ok, results} envelope", async () => {
    const tool = createWebSearchTool({
      search: async (q) => [{ title: "hit", url: "http://x", snippet: `for ${q}` }],
    });
    const out = await tool.handler({ query: "  london weather " });
    assert.equal(out.ok, true);
    assert.equal(out.query, "london weather");
    assert.equal(out.results[0].snippet, "for london weather");
  });

  it("rejects an empty query and reports a provider failure without throwing", async () => {
    assert.equal((await createWebSearchTool({ search: async () => [] }).handler({ query: "  " })).ok, false);
    const boom = createWebSearchTool({ search: async () => { throw new Error("net down"); } });
    const out = await boom.handler({ query: "x" });
    assert.equal(out.ok, false);
    assert.match(out.error, /net down/);
  });
});

describe("view_image (A2)", () => {
  it("resolves a real PNG into a base64 image block (no model call)", async () => {
    const out = await createViewImageTool().handler({ path: TMP_PNG });
    assert.equal(out.ok, true);
    assert.equal(out.media_type, "image/png");
    assert.equal(out.block.type, "image");
    assert.equal(out.block.source.type, "base64");
    assert.ok(out.block.source.data.length > 0);
    assert.equal(out.block.source.data, PNG_1x1.toString("base64"));
  });

  it("routes an unsupported format through the injected sips.convert", () => {
    let converted = null;
    const sips = { convert: (p) => { converted = p; return TMP_PNG; }, resize: (p) => p };
    const { media_type } = imageBlock("/some/photo.heic", { sips });
    assert.equal(converted, "/some/photo.heic");
    assert.equal(media_type, "image/png");
  });

  it("missing path -> ok:false", async () => {
    assert.equal((await createViewImageTool().handler({})).ok, false);
  });
});

describe("create_image (A3) — gated off by default", () => {
  it("with no provider, reports not-configured (never invents a paid path)", async () => {
    const out = await createCreateImageTool().handler({ prompt: "a cat" });
    assert.equal(out.ok, false);
    assert.match(out.error, /no image provider configured/);
  });

  it("prompt is required", async () => {
    assert.equal((await createCreateImageTool().handler({})).ok, false);
  });

  it("with an injected provider returning a path, succeeds", async () => {
    const tool = createCreateImageTool({ provider: async ({ out }) => ({ path: out }) });
    const out = await tool.handler({ prompt: "a cat", out: "/tmp/cat.png" });
    assert.deepEqual(out, { ok: true, path: "/tmp/cat.png" });
  });

  it("with an injected provider returning base64, persists and returns the path", async () => {
    const target = path.join(os.tmpdir(), `genimg-${process.pid}.png`);
    const tool = createCreateImageTool({ provider: async () => ({ base64: PNG_1x1.toString("base64") }) });
    const out = await tool.handler({ prompt: "a cat", out: target });
    assert.equal(out.ok, true);
    assert.ok(fs.existsSync(target));
    fs.unlinkSync(target);
  });
});

describe("browser (A4) — wraps the logged-in Chrome via injected cdp", () => {
  it("navigate opens the url", async () => {
    const calls = [];
    const tool = createBrowserTool({ cdp: (a) => { calls.push(a); return ""; } });
    const out = await tool.handler({ action: "navigate", url: "https://x.test" });
    assert.equal(out.ok, true);
    assert.deepEqual(calls[0], ["open", "https://x.test"]);
  });

  it("read returns a SIMPLIFIED DOM (text+links+controls), never raw HTML", async () => {
    const fakeDom = { title: "T", url: "u", text: "hello world", links: [{ text: "L", href: "h" }], controls: [] };
    const calls = [];
    const tool = createBrowserTool({
      cdp: (a) => { calls.push(a); return a[0] === "eval" ? JSON.stringify(fakeDom) : ""; },
    });
    const out = await tool.handler({ action: "read", url: "https://x.test" });
    assert.equal(out.ok, true);
    assert.equal(out.text, "hello world");
    assert.deepEqual(out.links, [{ text: "L", href: "h" }]);
    assert.equal(calls[0][0], "open");             // navigated first
    assert.equal(calls[1][0], "eval");             // then simplified-DOM eval
    assert.equal(calls[1][1], SIMPLIFY_DOM_JS);
    assert.ok(!("html" in out), "no raw html field");
  });

  it("click requires a selector and honors the clicked result", async () => {
    assert.equal((await createBrowserTool({ cdp: () => "" }).handler({ action: "click" })).ok, false);
    const hit = createBrowserTool({ cdp: () => JSON.stringify({ clicked: true }) });
    assert.equal((await hit.handler({ action: "click", selector: "#go" })).ok, true);
    const miss = createBrowserTool({ cdp: () => JSON.stringify({ clicked: false }) });
    assert.equal((await miss.handler({ action: "click", selector: "#nope" })).ok, false);
  });

  it("screenshot writes to a path; unknown action -> ok:false; cdp throw -> ok:false", async () => {
    const shot = createBrowserTool({ cdp: () => "" });
    const out = await shot.handler({ action: "screenshot", path: "/tmp/s.png" });
    assert.deepEqual(out, { ok: true, action: "screenshot", path: "/tmp/s.png" });
    assert.equal((await shot.handler({ action: "frobnicate" })).ok, false);
    const boom = createBrowserTool({ cdp: () => { throw new Error("no chrome"); } });
    assert.equal((await boom.handler({ action: "navigate", url: "u" })).ok, false);
  });
});

describe("CAP plugin (WP5) — registers all four into a real registry", () => {
  it("loads the capabilities plugin: 4 tools, gated create_image + live view_image via executeTool", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/capabilities");
    await loader.loadPlugin(pluginDir);
    for (const name of ["web_search", "view_image", "create_image", "browser"]) {
      assert.equal(tools.has(name), true, `${name} registered`);
    }
    // create_image is gated off (no spawn, safe to execute through the registry).
    const ci = await tools.executeTool("create_image", { prompt: "x" });
    assert.equal(ci.ok, false);
    assert.match(ci.error, /no image provider configured/);
    // view_image is pure — runs end-to-end through the registry.
    const vi = await tools.executeTool("view_image", { path: TMP_PNG });
    assert.equal(vi.ok, true);
    assert.equal(vi.media_type, "image/png");
  });
});
