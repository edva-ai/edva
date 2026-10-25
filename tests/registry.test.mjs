// registry.test.mjs — lib/registry.cjs: kernel registries merged with the
// installation's agent/local/<name>.json, and writes that land only in
// the local file. Synthetic fixtures; the last test only loads this checkout.
// Run: node --test tests/registry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const REG = path.join(import.meta.dirname, "..", "lib", "registry.cjs");
const { mergeRegistry, loadRegistry, loadRegistryList, writeRegistryList, registryPaths, REGISTRIES } = require(REG);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fixture(files) {
  const root = fs.mkdtempSync(path.join(TMP, "root-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  }
  return root;
}

const KERNEL_TASKS = {
  $schema: "./tasks.schema.json",
  _comment: "kernel",
  tasks: [
    { name: "a", schedule: "0 1 * * *", description: "kernel a", phrases: ["alpha"] },
    { name: "b", schedule: "0 2 * * *", description: "kernel b", phrases: ["beta"] },
  ],
};

test("no local file: the kernel document as it is", () => {
  const root = fixture({ "system/tasks.json": KERNEL_TASKS });
  assert.deepEqual(loadRegistry("tasks", { root }), KERNEL_TASKS);
});

test("local entries append, same-name entries override field by field, kernel key order kept", () => {
  const merged = mergeRegistry(KERNEL_TASKS, {
    _comment: "local",
    tasks: [{ name: "c", schedule: "0 3 * * *" }, { name: "a", description: "local a", extra: 1 }],
  }, "tasks", "name");
  assert.equal(merged._comment, "kernel", "the local _comment is the local file's own");
  assert.deepEqual(merged.tasks.map((t) => t.name), ["a", "b", "c"]);
  assert.deepEqual(Object.keys(merged.tasks[0]), ["name", "schedule", "description", "phrases", "extra"]);
  assert.equal(merged.tasks[0].description, "local a");
  assert.equal(merged.tasks[0].schedule, "0 1 * * *");
});

test("`order` sets the listing order; ids it does not name follow in merge order", () => {
  const merged = mergeRegistry(KERNEL_TASKS, { order: ["c", "b"], tasks: [{ name: "c" }, { name: "d" }] }, "tasks", "name");
  assert.deepEqual(merged.tasks.map((t) => t.name), ["c", "b", "a", "d"]);
});

test("map registries (job-routing): override per job, key order, top-level keys replace", () => {
  const kernel = { $schema: "s", _meta: { purpose: "kernel" }, jobs: { x: { model: "opus", rationale: "k" }, y: { model: "haiku" } } };
  const merged = mergeRegistry(kernel, { order: ["y", "z", "x"], _meta: { purpose: "local" }, jobs: { x: { rationale: "l" }, z: { model: "sonnet" } } }, "jobs");
  assert.deepEqual(Object.keys(merged.jobs), ["y", "z", "x"]);
  assert.deepEqual(merged.jobs.x, { model: "opus", rationale: "l" });
  assert.deepEqual(merged._meta, { purpose: "local" });
  assert.deepEqual(Object.keys(merged), ["$schema", "_meta", "jobs"]);
});

test("string registries (chrome-jobs): union, no duplicates", () => {
  const merged = mergeRegistry({ jobs: ["k1", "k2"] }, { jobs: ["l1", "k2"] }, "jobs");
  assert.deepEqual(merged.jobs, ["k1", "k2", "l1"]);
});

test("writeRegistryList: edits land in the local file only, as minimal overrides", () => {
  const root = fixture({ "system/tasks.json": KERNEL_TASKS });
  const kernelBefore = fs.readFileSync(path.join(root, "system/tasks.json"), "utf8");
  const tasks = loadRegistryList("tasks", { root });
  tasks[1].paused_until = "2099-01-01";
  tasks.push({ name: "new", schedule: "0 5 * * *", phrases: [] });
  const file = writeRegistryList("tasks", tasks, { root });
  assert.equal(file, registryPaths("tasks", { root }).local);
  assert.equal(fs.readFileSync(path.join(root, "system/tasks.json"), "utf8"), kernelBefore, "kernel file untouched");
  const local = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(local.tasks, [{ name: "b", paused_until: "2099-01-01" }, { name: "new", schedule: "0 5 * * *", phrases: [] }]);
  assert.equal(local.order, undefined, "no order needed when merge order already matches");
  assert.deepEqual(loadRegistryList("tasks", { root }), tasks);

  // resume: the override disappears once the entry equals the kernel's again
  const again = loadRegistryList("tasks", { root });
  delete again[1].paused_until;
  writeRegistryList("tasks", again, { root });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).tasks, [{ name: "new", schedule: "0 5 * * *", phrases: [] }]);
  assert.deepEqual(loadRegistryList("tasks", { root }), again);
});

test("writeRegistryList keeps an existing local order and the local entries' order", () => {
  const root = fixture({
    "system/tasks.json": KERNEL_TASKS,
    "agent/local/tasks.json": { _comment: "mine", order: ["l1", "a", "l2", "b"], tasks: [{ name: "l1", phrases: [] }, { name: "l2", phrases: [] }] },
  });
  const tasks = loadRegistryList("tasks", { root });
  assert.deepEqual(tasks.map((t) => t.name), ["l1", "a", "l2", "b"]);
  tasks[2].paused_reason = "x";
  writeRegistryList("tasks", tasks, { root });
  const local = JSON.parse(fs.readFileSync(path.join(root, "agent/local/tasks.json"), "utf8"));
  assert.deepEqual(Object.keys(local), ["_comment", "order", "tasks"]);
  assert.deepEqual(local.tasks.map((t) => t.name), ["l1", "l2"]);
  assert.deepEqual(loadRegistryList("tasks", { root }), tasks);
});

test("writeRegistryList refuses to drop a kernel field it cannot express as an override", () => {
  const root = fixture({ "system/tasks.json": KERNEL_TASKS });
  const tasks = loadRegistryList("tasks", { root });
  delete tasks[0].description;
  assert.throws(() => writeRegistryList("tasks", tasks, { root }), /cannot remove kernel field "description"/);
});

test("CLI prints the merged document for shell readers", () => {
  const root = fixture({
    "agent/config/job-routing.json": { jobs: { k: { model: "opus" } } },
    "agent/local/job-routing.json": { jobs: { l: { model: "haiku" } } },
  });
  const r = spawnSync(process.execPath, [REG, "job-routing", "--root", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { jobs: { k: { model: "opus" }, l: { model: "haiku" } } });
});

test("this checkout's registries load, with unique ids", () => {
  for (const name of Object.keys(REGISTRIES)) {
    const list = loadRegistryList(name);
    const ids = Array.isArray(list) ? list.map((e) => (typeof e === "string" ? e : e.name)) : Object.keys(list);
    assert.ok(ids.length > 0, name);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate ids`);
  }
});
