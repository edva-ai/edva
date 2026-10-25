// wiki-store-save-guard.test.mjs — savePage refuses a body copied from the
// `wiki read` view (header block, links footer, or a dropped frontmatter).
// Run: node --test tests/wiki-store-save-guard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-save-guard-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });
process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = path.join(fixtureDir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "0";

const { createRequire } = await import("node:module");
const ws = createRequire(import.meta.url)(path.resolve("lib/wiki-store.js"));

const PAGE = "---\nname: Eli & Jo Keller\ntype: user\nentity: people-hub\npinned: true\n---\n# Eli & Jo Keller\n\nOldest and best friends.\n";

test("a normal page saves, and saves again with an edit", () => {
  assert.equal(ws.savePage("user_keller_fixture", PAGE, { editedBy: "test" }).isNew, true);
  const out = ws.savePage("user_keller_fixture", PAGE + "\n- 2026-10-24 · A new line.\n", { editedBy: "test" });
  assert.equal(out.changed, true);
});

test("the read view's header block is refused", () => {
  const view = "=== user_keller_fixture (user_keller_fixture.md) ===\ntype        : user\nstatus      : active\n\n# Eli & Jo Keller\n";
  assert.throws(() => ws.savePage("user_keller_fixture", "---\npinned: true\n---\n" + view), /header block/);
});

test("the read view's links footer is refused", () => {
  const withFooter = PAGE + "\n=== links ===\n  → wikilink     user_sam (Sam)\n  ← wikilink     day_2026-10-02\n";
  assert.throws(() => ws.savePage("user_keller_fixture", withFooter), /links footer/);
});

test("the read view's facts footer is refused", () => {
  const withFacts = PAGE + `\n=== facts ===\n  user_keller_fixture spouse_of → user_x: They are married.\n`;
  assert.throws(() => ws.savePage("user_keller_fixture", withFacts), /facts footer/);
});

test("dropping an existing page's frontmatter is refused", () => {
  assert.throws(() => ws.savePage("user_keller_fixture", "# Eli & Jo Keller\n\nOldest and best friends.\n"), /has frontmatter/);
  assert.equal(ws.getPage("user_keller_fixture").raw_md.startsWith("---\n"), true);
});

test("a page that never had frontmatter can still be saved without one", () => {
  ws.savePage("MEMORY_fixture", "# Index\n\n- one\n", { editedBy: "test" });
  assert.equal(ws.savePage("MEMORY_fixture", "# Index\n\n- one\n- two\n", { editedBy: "test" }).changed, true);
});

test("a page that only mentions the footer text in prose is fine", () => {
  const prose = PAGE + "\nThe `wiki read` view ends with a line reading === links === and is not the page.\n";
  assert.equal(ws.savePage("user_keller_fixture", prose, { editedBy: "test" }).changed, true);
});
