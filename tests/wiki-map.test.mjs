// wiki-map.test.mjs — unit tests for wiki-store.pageMap (the navigation tier).
// Run: node --test tests/wiki-map.test.mjs
//
// Isolated fixture DB via env vars; the live memory-index.db is never touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-map-test-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });
process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_DB_AUTHORITATIVE = "1";

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));

before(() => {
  const mk = (id, type, desc, body = "body") =>
    ws.savePage(
      id,
      `---\nname: ${id}\ndescription: ${desc}\ntype: ${type}\n---\n${body}\n`,
      { editedBy: "test" },
    );
  mk("user_alex", "user", "Who Alex is");
  mk("user_sam", "user", "Alex's partner");
  mk("feedback_plain_words", "feedback", "Write in full");
  mk("project_appco", "project", "Mobile app startup");
  // A large, structured-prefix type to exercise the drill path (> threshold 40).
  for (let i = 0; i < 45; i++) {
    const city = i < 30 ? "springfield" : "riverton";
    mk(`reference_travel_${city}_${i}`, "reference", `Travel note ${i}`);
  }
});

after(() => {
  try { ws.closeDb(); } catch {}
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("overview lists every type with counts and sample titles", () => {
  const map = ws.pageMap();
  assert.equal(map.level, "overview");
  assert.equal(map.total, 4 + 45);
  const byType = Object.fromEntries(map.types.map((t) => [t.type, t.count]));
  assert.equal(byType.user, 2);
  assert.equal(byType.feedback, 1);
  assert.equal(byType.project, 1);
  assert.equal(byType.reference, 45);
  const ref = map.types.find((t) => t.type === "reference");
  assert.ok(ref.samples.length > 0 && ref.samples.length <= 6, "samples are bounded");
});

test("small type drills straight to a page list", () => {
  const map = ws.pageMap({ type: "user" });
  assert.equal(map.level, "type");
  assert.equal(map.tooMany, undefined);
  assert.equal(map.count, 2);
  const ids = map.pages.map((p) => p.id);
  assert.ok(ids.includes("user_alex") && ids.includes("user_sam"));
});

test("large type returns a prefix histogram instead of drowning", () => {
  const map = ws.pageMap({ type: "reference" });
  assert.equal(map.tooMany, true);
  assert.equal(map.count, 45);
  assert.ok(Array.isArray(map.prefixes) && map.prefixes.length > 0);
  // All 45 ids share the "reference_travel" two-token prefix.
  const top = map.prefixes[0];
  assert.equal(top.prefix, "reference_travel");
  assert.equal(top.count, 45);
});

test("prefix drill narrows to matching pages", () => {
  const map = ws.pageMap({ type: "reference", prefix: "reference_travel_springfield" });
  assert.equal(map.level, "type");
  assert.equal(map.prefix, "reference_travel_springfield");
  assert.equal(map.count, 30);
  assert.ok(map.pages.every((p) => p.id.startsWith("reference_travel_springfield")));
});
