// memory-lint.test.mjs — structural lint checks.
// Run: node --test tests/memory-lint.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-lint-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
const fixtureLog = path.join(fixtureDir, "memory-retrieval.jsonl");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_INDEX_LOG = fixtureLog;

fs.writeFileSync(path.join(fixtureMemoryDir, "MEMORY.md"), "# i\n");

fs.writeFileSync(
  path.join(fixtureMemoryDir, "_entities.yaml"),
  `entities:
  north_workshop:
    type: property
    aliases: [northside]
  dock_7:
    type: property
    aliases: ["dock 7", "bay seven"]
  sam_ortiz:
    type: person
    scope: [dock_7]
    aliases: ["sam ortiz"]
  thermostat_control:
    type: system
    scope: [north_workshop]
    aliases: ["thermostat control", "thermostat-server"]
`,
);

// File with a dangling wikilink AND a bad frontmatter supersedes.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "feedback_dangling.md"),
  `---
name: Has dangles
type: feedback
supersedes: [nonexistent.md]
---
See [[never_existed]] for context.
`,
);

// File with scope conflict: declared scope excludes entity's scope.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_scope_bug.md"),
  `---
name: Scope bug
type: project
scope: [north_workshop]
---
Sam Ortiz did the work at Dock 7. The mention of an dock-scoped
person here conflicts with the file's north_workshop scope.
`,
);

// File with unknown entity id in scope.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "feedback_unknown_entity.md"),
  `---
name: Unknown entity ref
type: feedback
scope: [totally_made_up]
---
Body.
`,
);

// Stale supersession: new says it supersedes old, old is still active.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_old.md"),
  `---
name: Old
type: project
---
Old content.`,
);
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_new.md"),
  `---
name: New
type: project
status: active
supersedes: [project_old.md]
---
New content.`,
);

// Orphan: project file with no links, no scope, no entity mentions.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "project_orphan.md"),
  `---
name: Orphan
type: project
---
This file has nothing in common with any other file or entity.
`,
);

// A clean file to prove lint doesn't over-flag.
fs.writeFileSync(
  path.join(fixtureMemoryDir, "reference_ok.md"),
  `---
name: Clean reference
type: reference
---
Nothing special here.`,
);

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ms = require(path.resolve("lib/memory-store.js"));
const mlint = require(path.resolve("lib/memory-lint.js"));

ms.setEmbedFn(async (t) => {
  const v = new Array(ms.EMBED_DIM).fill(0);
  for (let i = 0; i < t.length; i++) v[(t.charCodeAt(i) + i) % ms.EMBED_DIM] += 0.01;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
});

before(async () => {
  await ms.reindex({ force: true });
});

after(() => {
  try {
    ms.closeDb();
  } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function byCheck(issues, check) {
  return issues.filter((i) => i.check === check);
}

test("lint detects dangling body wikilinks", () => {
  const issues = mlint.lint();
  const dangles = byCheck(issues, "dangling-link");
  const body = dangles.find(
    (i) => i.file === "feedback_dangling.md" && i.link_type === "body",
  );
  assert.ok(body, `expected dangling body wikilink, got: ${JSON.stringify(dangles)}`);
  assert.equal(body.target, "never_existed.md");
});

test("lint detects dangling frontmatter supersedes", () => {
  const issues = mlint.lint();
  const dangle = byCheck(issues, "dangling-link").find(
    (i) => i.link_type === "fm-supersedes",
  );
  assert.ok(dangle);
  assert.equal(dangle.target, "nonexistent.md");
  assert.equal(dangle.severity, "error");
});

test("lint detects unknown entity ids in scope", () => {
  const issues = mlint.lint();
  const unknown = byCheck(issues, "unknown-entity");
  assert.ok(unknown.length >= 1);
  const hit = unknown.find((i) => i.file === "feedback_unknown_entity.md");
  assert.ok(hit);
  assert.equal(hit.entity_id, "totally_made_up");
  assert.equal(hit.severity, "error");
});

test("lint detects scope conflicts (entity scope misses file scope)", () => {
  const issues = mlint.lint();
  const conflicts = byCheck(issues, "scope-conflict");
  const hit = conflicts.find((i) => i.file === "project_scope_bug.md");
  assert.ok(
    hit,
    `expected scope-conflict on project_scope_bug.md, got: ${JSON.stringify(conflicts.map((c) => c.file))}`,
  );
  assert.equal(hit.entity, "sam_ortiz");
});

test("lint flags stale supersession", () => {
  const issues = mlint.lint();
  const stale = byCheck(issues, "supersession-stale");
  const hit = stale.find((i) => i.file === "project_old.md");
  assert.ok(hit);
  assert.equal(hit.superseded_by, "project_new.md");
});

test("lint flags orphan project files", () => {
  const issues = mlint.lint();
  const orphans = byCheck(issues, "orphan");
  const hit = orphans.find((i) => i.file === "project_orphan.md");
  assert.ok(hit);
});

test("lint does not flag clean files", () => {
  const issues = mlint.lint();
  const complaints = issues.filter((i) => i.file === "reference_ok.md");
  assert.deepEqual(complaints, []);
});

test("summarize rolls up by severity + check", () => {
  const issues = mlint.lint();
  const s = mlint.summarize(issues);
  assert.equal(s.total, issues.length);
  assert.ok(s.bySeverity.error >= 2);
  assert.ok(s.byCheck["dangling-link"] >= 2);
});
