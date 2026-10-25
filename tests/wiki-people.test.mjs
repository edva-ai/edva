// wiki-people.test.mjs — person-page graph checks, concept upsert, link retarget,
// and the linker's ambiguous-alias guard.
// Run: node --test tests/wiki-people.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-people-"));
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
const people = requireFromHere(path.resolve("lib/wiki-people.js"));

const page = (id, entity, body) =>
  ws.savePage(id, `---\nname: ${id}\ntype: user\n${entity ? `entity: ${entity}\n` : ""}---\n${body}\n`, {
    editedBy: "test",
  });

before(() => {
  fs.writeFileSync(
    conceptsPath,
    JSON.stringify({
      concepts: [
        { target: "user_dana_hill", aliases: ["Dana Hill", "Dana"] },
        { target: "user_max_hill", aliases: ["Max Hill", "Max"] },
        { target: "user_leo_hill", aliases: ["Leo Hill"], ambiguous_aliases: ["Leo"] },
        { target: "reference_leo_stone", aliases: ["Leo"] },
      ],
    }),
  );
  page("user_dana_hill", "person", "Mother of [[user_max_hill|Max]] and [[user_leo_hill|Leo]].");
  page("user_max_hill", "person", "Son of [[user_dana_hill|Dana]].");
  page("user_leo_hill", "person", "Son of Dana.");
  page("user_hill_family", "people-hub", "- [[user_max_hill|Max]]\n- [[user_leo_hill|Leo]]");
  page("reference_leo_stone", null, "Leo Stone — not family.");
  page("user_team", "people-hub", "Hub.");
  page("user_ben_doe", "person", "Ben.");
  page("day_2026-03-07", null, "Lunch with [[user_team|Ben]] and [[user_team|Eli]]; [[user_team|Ben]] drove.");
  page("note_lonely", null, "Nobody links here.");
});

after(() => {
  ws.closeDb();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test("an alias two concepts claim is never auto-linked", () => {
  const concepts = linker.loadConcepts({ conceptsPath, includeEmpty: true });
  const guy = concepts.find((c) => c.target === "user_leo_hill");
  const stone = concepts.find((c) => c.target === "reference_leo_stone");
  assert.deepEqual(guy.aliases, ["Leo Hill"]);
  assert.ok(guy.ambiguous_aliases.includes("Leo"));
  assert.deepEqual(stone.aliases, []);
  assert.ok(stone.ambiguous_aliases.includes("Leo"));
  // The empty concept drops out of the linker's working set.
  assert.ok(!linker.loadConcepts({ conceptsPath }).some((c) => c.target === "reference_leo_stone"));
});

test("the linker links a full name but leaves a bare ambiguous first name alone", () => {
  page("reference_lunch", null, "Leo came to lunch. Later Leo Hill left early.");
  const s = linker.suggestLinks({ id: "reference_lunch", conceptsPath });
  assert.deepEqual(s.map((x) => [x.target, x.alias]), [["user_leo_hill", "Leo Hill"]]);
});

test("audit finds one-way person links but ignores hubs", () => {
  const r = people.audit({ conceptsPath });
  assert.deepEqual(r.asymmetric.map((a) => a.need), ["user_leo_hill → user_dana_hill"]);
  assert.deepEqual(r.hubs.map((h) => [h.id, h.people_linked]).sort(), [
    ["user_hill_family", 2],
    ["user_team", 0],
  ]);
  assert.deepEqual(r.not_in_concepts, ["user_ben_doe"]);
  assert.ok(r.collisions.some((c) => c.alias === "Leo"));
  assert.ok(r.orphans.includes("note_lonely"));
});

test("concept-add is idempotent and keeps ambiguous names out of aliases", () => {
  const first = people.addConcept({
    target: "user_ben_doe",
    aliases: ["Ben Doe", "Ben"],
    ambiguous: [],
    conceptsPath,
  });
  assert.equal(first.changed, true);
  const again = people.addConcept({ target: "user_ben_doe", aliases: ["Ben"], conceptsPath });
  assert.equal(again.changed, false);
  const g = people.addConcept({ target: "user_leo_hill", aliases: ["Leo"], ambiguous: ["Leo"], conceptsPath });
  assert.deepEqual(g.entry.aliases, ["Leo Hill"]);
  assert.throws(() => people.addConcept({ target: "user_nobody", aliases: ["X"], conceptsPath }), /no page/);
});

test("retarget rewrites only links with the exact display text", () => {
  const dry = people.retarget({ from: "user_team", to: "user_ben_doe", display: "Ben", dryRun: true });
  assert.deepEqual(dry, [{ id: "day_2026-03-07", count: 2 }]);
  assert.match(ws.getPage("day_2026-03-07").raw_md, /\[\[user_team\|Ben\]\]/);

  people.retarget({ from: "user_team", to: "user_ben_doe", display: "Ben" });
  const body = ws.getPage("day_2026-03-07").raw_md;
  assert.doesNotMatch(body, /\[\[user_team\|Ben\]\]/);
  assert.match(body, /\[\[user_ben_doe\|Ben\]\] drove/);
  assert.match(body, /\[\[user_team\|Eli\]\]/);
});
