// tool-registry.mjs — WP1: the deferred-tool registry (biggest context-cost lever).
//
// Conway keeps ~5K of tool overhead in context instead of ~30K by NOT putting
// every MCP/tool JSON-schema in the model's `tools` param. Instead:
//   - a tiny DIRECT_TOOL_ALLOWLIST of loop primitives is the only thing in `tools`;
//   - everything else is registered here and surfaced as a COMPACT MANIFEST
//     (`- name: one-line desc`) the model reads;
//   - the model pulls a full schema on demand (getDeferredTools) and invokes a
//     tool via executeTool(name, input) — from the REPL (WP8) or a dispatch tool.
//
// This module is pure logic (no DB, no model, no I/O) — a Map of tool defs plus
// the allowlist/manifest/execute helpers. It is consumed by the Agent loop (WP0,
// which builds the `tools` param) and the REPL sandbox (WP8, which binds
// executeTool + camelCase globals). Returns are normalized to Conway's
// { ok:true, ... } / { ok:false, error } convention so the model handles
// failures uniformly.
//
// Mirrors from Conway's tools.ts / agent.ts:
//   DIRECT_TOOL_ALLOWLIST, isDeferredTool, getDeferredTools({filter,
//   includeToolDefinition}), executeTool(name, input).

// The loop primitives that always stay in the model's `tools` param. Small on
// purpose — these are the spine of the agent, independent of which MCP servers
// or skills happen to be connected. (Conway's equivalent set: repl, output,
// contextSnip, fork, restart, report_bug.) Overridable per registry.
export const DEFAULT_DIRECT_ALLOWLIST = [
  "repl",
  "output",
  "context_snip",
  "fork",
  "recall_events",
  "wiki_search",
];

// Normalize any handler return / throw into Conway's { ok } envelope so the
// model never has to guess a tool's failure shape.
export function normalizeResult(value) {
  if (value && typeof value === "object" && typeof value.ok === "boolean") return value;
  if (typeof value === "string") return { ok: true, result: value };
  if (value === undefined || value === null) return { ok: true, result: null };
  if (typeof value === "object") return { ok: true, ...value };
  return { ok: true, result: value };
}

// name → the camelCase global the REPL exposes (WP8). "wiki_search" → "wikiSearch".
export function camelCaseName(name) {
  return String(name).replace(/[-_ ]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

export function createToolRegistry({ allowlist = DEFAULT_DIRECT_ALLOWLIST, deferByDefault = true } = {}) {
  /** @type {Map<string, {name, description, schema, handler, deferred}>} */
  const tools = new Map();
  let allow = new Set(allowlist);

  function registerTool(nameOrDef, maybeDef) {
    // Support registerTool("name", {description,schema,handler,deferred})
    // and    registerTool({name,description,schema,handler,deferred}).
    const def = typeof nameOrDef === "string" ? { name: nameOrDef, ...(maybeDef || {}) } : { ...(nameOrDef || {}) };
    if (!def.name) throw new Error("registerTool: name is required");
    if (typeof def.handler !== "function") throw new Error(`registerTool(${def.name}): handler must be a function`);
    tools.set(def.name, {
      name: def.name,
      description: def.description || "",
      schema: def.schema || { type: "object", properties: {} },
      handler: def.handler,
      // An explicit `deferred` wins; otherwise anything OFF the allowlist defers
      // when deferByDefault (Conway's toolsReplOnly() behavior).
      deferred: def.deferred != null ? !!def.deferred : (deferByDefault && !allow.has(def.name)),
    });
    return def.name;
  }

  // Bridge: register Edva's existing MCP tool definitions (the tools-mcp
  // `TOOLS` array shape: { name, description, schema, run }). Each becomes a
  // deferred tool whose handler is `run`. This is how the ~existing MCP surface
  // populates the registry so its schemas leave the prompt.
  function registerFromMcpTools(mcpTools = []) {
    let n = 0;
    for (const t of mcpTools) {
      if (!t || !t.name || typeof t.run !== "function") continue;
      registerTool({ name: t.name, description: t.description, schema: t.schema, handler: t.run });
      n++;
    }
    return n;
  }

  function has(name) { return tools.has(name); }
  function get(name) { return tools.get(name) || null; }
  function list() { return [...tools.values()].map(({ handler, ...rest }) => rest); }
  function unregisterTool(name) { return tools.delete(name); }
  function clear() { tools.clear(); }

  function setAllowlist(names) { allow = new Set(names); }
  function getAllowlist() { return [...allow]; }

  function isDeferred(name) {
    const t = tools.get(name);
    if (!t) return false;
    return t.deferred && !allow.has(name);
  }

  // The `tools` param handed to the model: ONLY allowlisted tools, in the
  // Messages-API tool shape (name/description/input_schema).
  function toolsForModel() {
    const out = [];
    for (const t of tools.values()) {
      if (allow.has(t.name)) out.push({ name: t.name, description: t.description, input_schema: t.schema });
    }
    return out;
  }

  function matchFilter(t, filter) {
    if (!filter) return true;
    if (filter instanceof RegExp) return filter.test(t.name) || filter.test(t.description);
    const f = String(filter).toLowerCase();
    return t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f);
  }

  // Compact manifest of DEFERRED tools — name + one-line desc, or full schemas
  // when includeToolDefinition. `filter` is a substring or RegExp over name/desc.
  function getDeferredTools({ filter = null, includeToolDefinition = false } = {}) {
    const out = [];
    for (const t of tools.values()) {
      if (allow.has(t.name)) continue;       // allowlisted tools aren't "deferred"
      if (!matchFilter(t, filter)) continue;
      out.push(includeToolDefinition
        ? { name: t.name, description: t.description, input_schema: t.schema }
        : { name: t.name, description: t.description });
    }
    return out;
  }

  // The manifest block to inject into context (mirror Conway's [Client Connected]
  // list). One `- name: desc` per deferred tool. Caller budgets tokens.
  function buildManifest({ filter = null, header = "Deferred tools (fetch a schema with getDeferredTools, invoke with executeTool):" } = {}) {
    const lines = getDeferredTools({ filter }).map((t) => `- ${t.name}: ${t.description}`);
    if (!lines.length) return "";
    return `${header}\n${lines.join("\n")}`;
  }

  // Invoke a tool by name. Always returns a normalized { ok } envelope; never
  // throws (a throwing handler becomes { ok:false, error }).
  async function executeTool(name, input = {}) {
    const t = tools.get(name);
    if (!t) return { ok: false, error: `unknown tool: ${name}` };
    try {
      const value = await t.handler(input);
      return normalizeResult(value);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // camelCase-keyed bound executors for the REPL (WP8): { wikiSearch: (args) => executeTool('wiki_search', args), ... }
  function replBindings() {
    const b = {};
    for (const t of tools.values()) b[camelCaseName(t.name)] = (args = {}) => executeTool(t.name, args);
    return b;
  }

  return {
    registerTool, registerFromMcpTools, unregisterTool, clear,
    has, get, list, size: () => tools.size,
    setAllowlist, getAllowlist, isDeferred,
    toolsForModel, getDeferredTools, buildManifest, executeTool, replBindings,
  };
}

// Convenience module-level singleton for the common case.
export const registry = createToolRegistry();
