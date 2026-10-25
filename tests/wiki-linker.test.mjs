// wiki-linker.test.mjs — concept wikilink suggestion/apply checks.
// Run: node --test tests/wiki-linker.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-linker-"));
const fixtureMemoryDir = path.join(fixtureDir, "memory");
const fixtureDb = path.join(fixtureDir, "memory-index.db");
const conceptsPath = path.join(fixtureDir, "concepts.json");
fs.mkdirSync(fixtureMemoryDir, { recursive: true });

process.env.MEMORY_INDEX_DIR = fixtureMemoryDir;
process.env.MEMORY_INDEX_DB = fixtureDb;
process.env.MEMORY_DB_AUTHORITATIVE = "0";

const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const ws = requireFromHere(path.resolve("lib/wiki-store.js"));
const linker = requireFromHere(path.resolve("lib/wiki-linker.js"));

before(() => {
  fs.writeFileSync(
    conceptsPath,
    JSON.stringify({
      concepts: [
        { target: "user_sam", aliases: ["Sam Rivers", "Sam"] },
        { target: "project_appco", aliases: ["Appco"] },
      ],
    }),
  );
  ws.savePage(
    "user_sam",
    "---\nname: Sam Rivers\ntype: user\n---\nSam profile\n",
    { editedBy: "test" },
  );
  ws.savePage(
    "project_appco",
    "---\nname: Appco\ntype: project\n---\nAppco project\n",
    { editedBy: "test" },
  );
  ws.savePage(
    "reference_note",
    "---\nname: Note\ntype: reference\n---\nSam is helping on Appco.\n`Sam in code is not linked`\nAlready linked: [[user_sam|Sam]].\n",
    { editedBy: "test" },
  );
});

after(() => {
  ws.closeDb();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("suggestLinks skips already-linked targets but finds unlinked concepts", () => {
  const suggestions = linker.suggestLinks({ id: "reference_note", conceptsPath });
  assert.deepEqual(
    suggestions.map((s) => [s.target, s.alias]),
    [["project_appco", "Appco"]],
  );
});

test("applySuggestions links first occurrence and refreshes page links", () => {
  const changed = linker.applySuggestions({ id: "reference_note", conceptsPath, editedBy: "test" });
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].added, [{ target: "project_appco", alias: "Appco" }]);

  const row = ws.getPage("reference_note");
  assert.match(row.body_md, /\[\[project_appco\|Appco\]\]/);
  assert.match(row.body_md, /`Sam in code is not linked`/);
  const links = ws.getForwardLinks("reference_note").map((l) => l.dst_id).sort();
  assert.deepEqual(links, ["project_appco", "user_sam"]);
});
