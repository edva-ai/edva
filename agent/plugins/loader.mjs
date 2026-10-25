// loader.mjs — WP5: plugin / extension architecture (playbooks become plugins).
//
// Turns Edva capabilities into hot-reloadable modules with a manifest and
// typed contribution kinds, so adding a capability never means editing the
// supervisor. A plugin is a directory:
//
//   plugins/<name>/
//     manifest.json     { name, version, contributes?: [...] }
//     index.mjs         (optional) default export (api) => { ... }
//
// The factory receives an `api` bound to per-plugin teardown tracking, so
// reloadPlugin(name) / unloadPlugin(name) cleanly reverse exactly what the
// plugin registered. A broken plugin fails ISOLATED — the rest still load
// (Conway's guarantee). Declarative `contributes` in the manifest cover code-less
// plugins (a skill or a static context hook without any JS).
//
// Contribution kinds route into the substrate registries already built:
//   tool  → WP1 tool-registry.registerTool
//   hook  → WP10 context-hooks.registerContextHook   (or a static systemAppend)
//   skill → an in-loader skill index (WP9-shaped: name/description/body)
// Unknown kinds are recorded (forward-compat), not fatal.
//
// This module is pure orchestration over the injected registries — no global
// state, no I/O beyond reading a plugin's own files. Fully testable in isolation.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function createPluginLoader({ toolRegistry = null, hookRegistry = null } = {}) {
  /** @type {Map<string, {manifest, dir, teardown: Function[], skills: Map}>} */
  const plugins = new Map();
  // Plugin-contributed skills (WP9-shaped). Kept here so a plugin's skills are
  // torn down with it. name → { name, description, when_to_use, body, plugin }.
  const skills = new Map();

  function makeApi(name, dir, teardown) {
    return {
      pluginName: name,
      dir,
      registerTool(def) {
        if (!toolRegistry) throw new Error(`plugin ${name}: no tool registry bound`);
        const toolName = typeof def === "string" ? def : def?.name;
        toolRegistry.registerTool(def);
        teardown.push(() => toolRegistry.unregisterTool(toolName));
        return toolName;
      },
      registerContextHook(fn, opts = {}) {
        if (!hookRegistry) throw new Error(`plugin ${name}: no hook registry bound`);
        const off = hookRegistry.registerContextHook(fn, { name: `${name}:${opts.name || "hook"}` });
        teardown.push(off);
        return off;
      },
      registerSkill(skill) {
        if (!skill?.name) throw new Error(`plugin ${name}: registerSkill needs a name`);
        const rec = { name: skill.name, description: skill.description || "", when_to_use: skill.when_to_use || "", body: skill.body || "", plugin: name };
        skills.set(skill.name, rec);
        teardown.push(() => { if (skills.get(skill.name)?.plugin === name) skills.delete(skill.name); });
        return skill.name;
      },
      // Generic declarative dispatch (used for manifest `contributes`).
      contribute(c) { applyContribution(this, c, dir); },
    };
  }

  function applyContribution(api, c, dir) {
    if (!c || !c.kind) return;
    switch (c.kind) {
      case "skill": {
        // Declarative skill: inline body, or a `file` relative to the plugin dir.
        let body = c.body || "";
        if (!body && c.file) { try { body = fs.readFileSync(path.join(dir, c.file), "utf8"); } catch {} }
        api.registerSkill({ name: c.name, description: c.description, when_to_use: c.when_to_use, body });
        break;
      }
      case "hook": {
        // Declarative hook: a static systemAppend string.
        if (typeof c.systemAppend === "string") {
          const text = c.systemAppend;
          api.registerContextHook(() => ({ systemAppend: text }), { name: c.name || "static" });
        }
        break;
      }
      // `tool` kind needs a handler (code) → must come via index.mjs, not manifest.
      default:
        // Unknown/forward-compat kind: record on the plugin, non-fatal.
        break;
    }
  }

  async function loadPlugin(dir) {
    const manifestPath = path.join(dir, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch (e) { throw new Error(`plugin at ${dir}: unreadable manifest.json (${e.message})`); }
    const name = manifest.name;
    if (!name) throw new Error(`plugin at ${dir}: manifest has no name`);
    if (plugins.has(name)) throw new Error(`plugin ${name} already loaded (reload instead)`);

    const teardown = [];
    const api = makeApi(name, dir, teardown);
    const entry = { manifest, dir, teardown };

    try {
      // Declarative contributions first.
      for (const c of manifest.contributes || []) applyContribution(api, c, dir);
      // Programmatic factory (index.mjs default export).
      const indexPath = path.join(dir, manifest.main || "index.mjs");
      if (fs.existsSync(indexPath)) {
        // Cache-bust on the file's mtime so reloadPlugin picks up real code edits
        // (a same-content reload just re-runs the cached factory, which is fine).
        const mtime = fs.statSync(indexPath).mtimeMs;
        const mod = await import(pathToFileURL(indexPath).href + `?v=${mtime}`);
        const factory = mod.default;
        if (typeof factory === "function") await factory(api);
      }
    } catch (err) {
      // Roll back anything this plugin registered before it threw — no partial state.
      runTeardown(teardown);
      throw new Error(`plugin ${name}: load failed (${err.message})`);
    }
    plugins.set(name, entry);
    return name;
  }

  // Load every plugin under a directory. A broken plugin is isolated: it's
  // reported in `failed` but the rest still load. Returns { loaded, failed }.
  async function loadAll(dir) {
    const result = { loaded: [], failed: [] };
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pdir = path.join(dir, ent.name);
      if (!fs.existsSync(path.join(pdir, "manifest.json"))) continue;
      try { result.loaded.push(await loadPlugin(pdir)); }
      catch (e) { result.failed.push({ dir: pdir, error: e.message }); }
    }
    return result;
  }

  function runTeardown(teardown) {
    // Reverse order so later registrations unwind before earlier ones.
    for (let i = teardown.length - 1; i >= 0; i--) { try { teardown[i](); } catch {} }
    teardown.length = 0;
  }

  function unloadPlugin(name) {
    const entry = plugins.get(name);
    if (!entry) return false;
    runTeardown(entry.teardown);
    plugins.delete(name);
    return true;
  }

  async function reloadPlugin(name) {
    const entry = plugins.get(name);
    if (!entry) throw new Error(`plugin ${name} not loaded`);
    const dir = entry.dir;
    unloadPlugin(name);
    return loadPlugin(dir);
  }

  function list() { return [...plugins.values()].map((e) => ({ name: e.manifest.name, version: e.manifest.version || null, dir: e.dir })); }
  function has(name) { return plugins.has(name); }

  // WP9-shaped views of plugin-contributed skills.
  function skillIndex({ header = "Skills (from plugins):" } = {}) {
    if (!skills.size) return "";
    const lines = [...skills.values()].map((s) => `- ${s.name}: ${s.description}${s.when_to_use ? " — " + s.when_to_use : ""}`);
    return `${header}\n${lines.join("\n")}`;
  }
  function loadSkillBody(name) { return skills.get(name)?.body ?? null; }
  function listSkills() { return [...skills.values()].map(({ body, ...rest }) => rest); }

  return {
    loadPlugin, loadAll, reloadPlugin, unloadPlugin,
    list, has, count: () => plugins.size,
    skillIndex, loadSkillBody, listSkills,
  };
}
