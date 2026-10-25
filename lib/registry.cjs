"use strict";
// registry.cjs — the kernel's registries merged with this installation's own.
//
// Each registry is a kernel file (generic entries the kernel ships) plus an
// optional local file, agent/local/<name>.json, holding the operator's
// own entries. Every reader goes through loadRegistry(name) and sees ONE
// document in the kernel file's shape:
//
//   tasks        system/tasks.json             { tasks: [ {name, …} ] }
//   services     system/services.json          { services: [ {name, …} ] }
//   job-routing  agent/config/job-routing.json { jobs: { <job>: {…} } }
//   chrome-jobs  agent/config/chrome-jobs.json { jobs: [ "<job>" ] }
//
// Merge rules (local file, same list key as the kernel file):
//   - an entry whose id (`name` / the job key) is new is added after the
//     kernel's entries, in the local file's order;
//   - an entry whose id is already in the kernel overrides it field by field
//     ({ ...kernelEntry, ...localEntry }), so a local entry can be just the id
//     plus the fields it changes;
//   - string lists (chrome-jobs) are a union;
//   - optional top-level `order`: ids in this order first, then everything
//     else in merge order (lets an installation keep its own listing order,
//     which `edva tasks match` uses to break ties);
//   - any other top-level key of the local file (except `_comment`) replaces
//     the kernel's key of the same name.
// A missing local file means kernel entries only (a fresh install, a test
// fixture). Writes from code (edva tasks pause/resume, doctor --repair) go
// to the local file only: see writeRegistryList.
//
// CLI (shell readers):  node lib/registry.cjs <name> [--root <repo>]
//                       prints the merged document as JSON.

const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT: ROOT } = require("./root.cjs");

const REGISTRIES = {
  tasks: { kernel: "system/tasks.json", list: "tasks", id: "name" },
  services: { kernel: "system/services.json", list: "services", id: "name" },
  "job-routing": { kernel: "agent/config/job-routing.json", list: "jobs" },
  "chrome-jobs": { kernel: "agent/config/chrome-jobs.json", list: "jobs" },
};

function spec(name) {
  const s = REGISTRIES[name];
  if (!s) throw new Error(`unknown registry: ${name} (known: ${Object.keys(REGISTRIES).join(", ")})`);
  return s;
}

// Paths for a registry. `root` is the repo root (the dir holding tools/);
// without it, this checkout (EDVA_LOCAL_DIR may point the local dir elsewhere).
function registryPaths(name, opts = {}) {
  const s = spec(name);
  const root = opts.root || ROOT;
  const localDir = opts.localDir
    || (opts.root ? path.join(opts.root, "agent", "local")
      : (process.env.EDVA_LOCAL_DIR || path.join(ROOT, "agent", "local")));
  return { kernel: path.join(root, s.kernel), local: path.join(localDir, `${name}.json`) };
}

function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (optional && e.code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

function applyOrder(items, idOf, order) {
  if (!Array.isArray(order) || order.length === 0) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.has(idOf(item)) ? rank.get(idOf(item)) : Infinity }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.item);
}

function mergeList(kernelList, localList, idKey, order) {
  // String list (chrome-jobs): union, kernel first.
  if ((kernelList || []).every((x) => typeof x === "string") && (localList || []).every((x) => typeof x === "string")) {
    const out = [...(kernelList || [])];
    for (const x of localList || []) if (!out.includes(x)) out.push(x);
    return applyOrder(out, (x) => x, order);
  }
  const idOf = (e) => e && e[idKey];
  const localById = new Map();
  for (const e of localList || []) localById.set(idOf(e), e);
  const kernelIds = new Set();
  const out = (kernelList || []).map((k) => {
    kernelIds.add(idOf(k));
    return localById.has(idOf(k)) ? { ...k, ...localById.get(idOf(k)) } : k;
  });
  for (const e of localList || []) if (!kernelIds.has(idOf(e))) out.push(e);
  return applyOrder(out, idOf, order);
}

function mergeMap(kernelMap, localMap, order) {
  const entries = Object.entries(kernelMap || {}).map(([k, v]) => [k, localMap && k in localMap ? { ...v, ...localMap[k] } : v]);
  for (const [k, v] of Object.entries(localMap || {})) if (!(kernelMap && k in kernelMap)) entries.push([k, v]);
  return Object.fromEntries(applyOrder(entries, (e) => e[0], order));
}

// mergeRegistry(kernelDoc, localDoc, listKey, idKey) → merged document (pure).
function mergeRegistry(kernelDoc, localDoc, listKey, idKey = "name") {
  const out = { ...kernelDoc };
  if (!localDoc) return out;
  for (const [k, v] of Object.entries(localDoc)) {
    if (k === "_comment" || k === "order" || k === listKey) continue;
    out[k] = v;
  }
  const kList = kernelDoc[listKey];
  const lList = localDoc[listKey];
  if (lList === undefined) return out;
  if (Array.isArray(kList) || Array.isArray(lList)) {
    out[listKey] = mergeList(kList || [], lList || [], idKey, localDoc.order);
  } else {
    out[listKey] = mergeMap(kList || {}, lList || {}, localDoc.order);
  }
  return out;
}

// loadRegistry(name, { root, localDir }) → merged document.
function loadRegistry(name, opts = {}) {
  const s = spec(name);
  const p = registryPaths(name, opts);
  const kernelDoc = readJson(p.kernel);
  const localDoc = readJson(p.local, { optional: true });
  return mergeRegistry(kernelDoc, localDoc, s.list, s.id);
}

// The merged list itself (tasks → the tasks array, job-routing → the jobs map).
function loadRegistryList(name, opts = {}) {
  return loadRegistry(name, opts)[spec(name).list];
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// writeRegistryList(name, mergedList, opts) — persist a merged array list
// (as returned by loadRegistryList, then edited) without touching the kernel
// file: an entry the kernel does not have is stored whole in the local file;
// a kernel entry is stored as a local override holding only the fields that
// differ from the kernel's (none → no override). The local `order` is set to
// the list's order whenever plain merge order would differ. A kernel field
// removed from an entry cannot be expressed as an override, so it throws.
function writeRegistryList(name, mergedList, opts = {}) {
  const s = spec(name);
  if (!s.id || !Array.isArray(mergedList)) throw new Error(`writeRegistryList: ${name} is not an id-keyed list`);
  const p = registryPaths(name, opts);
  const kernelDoc = readJson(p.kernel);
  const localDoc = readJson(p.local, { optional: true }) || {};
  const kernelById = new Map((kernelDoc[s.list] || []).map((e) => [e[s.id], e]));
  const prevLocal = Array.isArray(localDoc[s.list]) ? localDoc[s.list] : [];
  const nextById = new Map();
  for (const e of mergedList) {
    const id = e[s.id];
    const k = kernelById.get(id);
    if (!k) { nextById.set(id, e); continue; }
    for (const key of Object.keys(k)) {
      if (!(key in e)) throw new Error(`${name}: cannot remove kernel field "${key}" from "${id}" through the local file`);
    }
    const diff = {};
    for (const [key, v] of Object.entries(e)) if (key !== s.id && !deepEqual(v, k[key])) diff[key] = v;
    if (Object.keys(diff).length) nextById.set(id, { [s.id]: id, ...diff });
  }
  // Keep the local file's own entry order; new ids go at the end.
  const nextLocal = [];
  for (const e of prevLocal) {
    const id = e[s.id];
    // Absent from nextById: removed from the list, or now equal to the kernel's.
    if (nextById.has(id)) { nextLocal.push(nextById.get(id)); nextById.delete(id); }
  }
  for (const e of nextById.values()) nextLocal.push(e);
  const nextDoc = { ...localDoc, [s.list]: nextLocal };
  const ids = mergedList.map((e) => e[s.id]);
  delete nextDoc.order;
  const plain = mergeRegistry(kernelDoc, nextDoc, s.list, s.id)[s.list].map((e) => e[s.id]);
  if (localDoc.order || !deepEqual(plain, ids)) nextDoc.order = ids;
  // Field order: _comment, order, then the rest as before.
  const ordered = {};
  if (nextDoc._comment !== undefined) ordered._comment = nextDoc._comment;
  if (nextDoc.order !== undefined) ordered.order = nextDoc.order;
  for (const [k, v] of Object.entries(nextDoc)) if (!(k in ordered)) ordered[k] = v;
  fs.mkdirSync(path.dirname(p.local), { recursive: true });
  const tmp = `${p.local}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ordered, null, 2) + "\n");
  fs.renameSync(tmp, p.local);
  return p.local;
}

module.exports = {
  REGISTRIES, registryPaths, mergeRegistry, loadRegistry, loadRegistryList, writeRegistryList,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const name = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
  const ri = args.indexOf("--root");
  const root = ri >= 0 ? args[ri + 1] : undefined;
  if (!name) {
    process.stderr.write(`usage: registry.cjs <${Object.keys(REGISTRIES).join("|")}> [--root <repo>]\n`);
    process.exit(64);
  }
  process.stdout.write(JSON.stringify(loadRegistry(name, { root }), null, 2) + "\n");
}
