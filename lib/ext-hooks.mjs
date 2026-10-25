// ext-hooks.mjs — optional per-instance behaviour plugged into kernel code.
//
// A kernel call site that only matters for some installations calls a named
// hook instead of carrying that behaviour itself. Hooks are modules in an
// `_ext/` directory next to the kernel code that calls them (e.g.
// agent/supervisor/_ext/gmail-intake.mjs). A missing hook is not an
// error: loadHook returns null and runHook returns the fallback.
//
// An installation's own CLI that kernel code calls when it is there (a
// location tool, a weather CLI) is found with optionalBin: kernel code never
// names a personal bin unguarded (kernel-guard --closure).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cache = new Map();

// loadHook(dir, name) → the module at <dir>/_ext/<name>.mjs, or null.
export async function loadHook(dir, name) {
  const file = path.join(dir, "_ext", `${name}.mjs`);
  if (cache.has(file)) return cache.get(file);
  let mod = null;
  if (fs.existsSync(file)) mod = await import(pathToFileURL(file).href);
  cache.set(file, mod);
  return mod;
}

// runHook(dir, name, fn, args, fallback) → result of the hook's exported
// function `fn`, or `fallback` when the hook or the export is absent. Errors
// thrown by a hook propagate: a hook that exists and fails is a real failure.
export async function runHook(dir, name, fn, args = [], fallback = undefined) {
  const mod = await loadHook(dir, name);
  const f = mod && (mod[fn] || (fn === "default" ? mod.default : undefined));
  if (typeof f !== "function") return fallback;
  return f(...args);
}

// optionalBin(binDir, name, envVar) → the path of an installation's optional
// CLI, or null when it has none: $envVar when set, else <binDir>/_ext/<name>
// (an overlay drop), else <binDir>/<name> — the first that is executable.
export function optionalBin(binDir, name, envVar) {
  const cands = [];
  if (envVar && process.env[envVar]) cands.push(process.env[envVar]);
  cands.push(path.join(binDir, "_ext", name), path.join(binDir, name));
  for (const p of cands) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function clearHookCache() {
  cache.clear();
}
