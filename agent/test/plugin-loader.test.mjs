// plugin-loader.test.mjs — WP5 plugin architecture. Writes temp plugins to disk
// and loads them against real WP1/WP10 registries.
//
// Run: node --test agent/test/plugin-loader.test.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../core/tool-registry.mjs";
import { createContextHookRegistry } from "../core/context-hooks.mjs";
import { createPluginLoader } from "../plugins/loader.mjs";

const ROOT = path.join(os.tmpdir(), `plugins-test-${process.pid}`);

function writePlugin(name, { manifest, index }) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  if (index) fs.writeFileSync(path.join(dir, "index.mjs"), index);
  return dir;
}

before(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  // A programmatic plugin: registers a tool + a hook via the factory.
  writePlugin("greeter", {
    index: `export default (api) => {
      api.registerTool({ name: "greet", description: "say hi", handler: ({ who }) => ({ msg: "hi " + who }) });
      api.registerContextHook(() => ({ systemAppend: "greeter-active" }), { name: "banner" });
    };`,
  });
  // A declarative plugin: a skill (inline body) + a static hook, no index.mjs.
  writePlugin("declarative", {
    manifest: { contributes: [
      { kind: "skill", name: "wave", description: "wave hello", body: "# Wave\nRaise a hand." },
      { kind: "hook", name: "note", systemAppend: "declarative-note" },
    ] },
  });
  // A broken plugin: factory throws after a partial registration.
  writePlugin("broken", {
    index: `export default (api) => {
      api.registerTool({ name: "halfDone", description: "partial", handler: () => 1 });
      throw new Error("intentional boom");
    };`,
  });
});
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

describe("plugin-loader (WP5)", () => {
  it("loads a programmatic plugin: tool + hook land in the registries", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    await loader.loadPlugin(path.join(ROOT, "greeter"));
    assert.equal(loader.has("greeter"), true);
    assert.equal(tools.has("greet"), true);
    assert.deepEqual(await tools.executeTool("greet", { who: "operator" }), { ok: true, msg: "hi operator" });
    assert.match((await hooks.runHooks({})).systemAppend, /greeter-active/);
  });

  it("loads a declarative plugin: skill + static hook, no code", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    await loader.loadPlugin(path.join(ROOT, "declarative"));
    assert.match(loader.skillIndex(), /- wave: wave hello/);
    assert.match(loader.loadSkillBody("wave"), /Raise a hand/);
    assert.match((await hooks.runHooks({})).systemAppend, /declarative-note/);
  });

  it("unloadPlugin reverses every registration", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    await loader.loadPlugin(path.join(ROOT, "greeter"));
    assert.equal(tools.has("greet"), true);
    assert.equal(loader.unloadPlugin("greeter"), true);
    assert.equal(tools.has("greet"), false, "tool unregistered");
    assert.equal((await hooks.runHooks({})).systemAppend, "", "hook removed");
    assert.equal(loader.has("greeter"), false);
  });

  it("reloadPlugin re-registers cleanly (no duplicates)", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    await loader.loadPlugin(path.join(ROOT, "greeter"));
    await loader.reloadPlugin("greeter");
    assert.equal(tools.has("greet"), true);
    assert.equal(hooks.count(), 1, "hook not duplicated after reload");
  });

  it("a broken plugin fails ISOLATED and rolls back its partial state", async () => {
    const tools = createToolRegistry({ allowlist: [] });
    const hooks = createContextHookRegistry();
    const loader = createPluginLoader({ toolRegistry: tools, hookRegistry: hooks });
    const res = await loader.loadAll(ROOT);
    // greeter + declarative load; broken is isolated.
    assert.ok(res.loaded.includes("greeter"));
    assert.ok(res.loaded.includes("declarative"));
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].error, /boom/);
    // The broken plugin's partial tool registration was rolled back.
    assert.equal(tools.has("halfDone"), false, "partial registration rolled back");
    // The healthy plugins are fully live.
    assert.equal(tools.has("greet"), true);
  });

  it("rejects a plugin with no manifest name / unreadable manifest", async () => {
    const dir = path.join(ROOT, "nameless");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: "1" }));
    const loader = createPluginLoader({ toolRegistry: createToolRegistry(), hookRegistry: createContextHookRegistry() });
    await assert.rejects(() => loader.loadPlugin(dir), /no name/);
  });
});
