// hum-answer-wiki.test.mjs — verifies hum-answer's NEW capture behavior:
// it appends the answer to hum-learnings.jsonl AND the canonical
// hum-responses.jsonl, clears the pending question, and does NOT write any wiki
// page in realtime (the old memory_hook subsection routing was retired — the
// nightly hum-consolidate job owns the wiki write now).
//
// Run: node --test tests/hum-answer-wiki.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-answer-"));

// hum-answer reads HOME-anchored paths for hum-pending-question.json,
// hum-learnings.jsonl, and (via hum-responses.mjs, which uses os.homedir() →
// honors $HOME) hum-responses.jsonl. Mirror the layout under a fake HOME.
const fakeHome = path.join(fixtureDir, "home");
const fakeData = path.join(fakeHome, "Dev/edva/data");
fs.mkdirSync(fakeData, { recursive: true });
// The memory dir hum-answer used to write into — assert it stays empty. Same
// derivation as lib/instance.cjs claudeMemoryDir(), under the fake HOME.
const { claudeProjectSlug } = createRequire(import.meta.url)("../lib/instance.cjs");
const fakeMemoryDir = path.join(fakeHome, ".claude/projects", claudeProjectSlug(path.join(fakeHome, "Dev", "edva")), "memory");
fs.mkdirSync(fakeMemoryDir, { recursive: true });

function writePending(obj) {
  fs.writeFileSync(path.join(fakeData, "hum-pending-question.json"), JSON.stringify(obj));
}
function readJsonl(name) {
  const p = path.join(fakeData, name);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function runHumAnswer(args) {
  // `process.execPath`, not "node" — the host has no `node` on its
  // non-interactive PATH. And resolve the binary from THIS file rather than
  // from cwd, so the suite doesn't depend on being run from the repo root.
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/hum-answer");
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: fakeHome },
  });
}

after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

test("hum-answer captures the answer to learnings + hum-responses and clears pending", () => {
  writePending({
    id: "q-1",
    asked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    subject: "Pasta show",
    question: "Did you like the new pasta show?",
    memory_hook: "show_preference",
  });
  const r = runHumAnswer(["q-1", "Loved the second episode"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.learnings_appended, true);
  assert.equal(out.response_logged, true);

  // Learnings logged (the historical question-answer log).
  const learnings = readJsonl("hum-learnings.jsonl");
  assert.equal(learnings.length, 1);
  assert.equal(learnings[0].answer, "Loved the second episode");

  // Canonical capture logged — this is what the overnight hum-consolidate reads.
  const responses = readJsonl("hum-responses.jsonl");
  assert.equal(responses.length, 1);
  assert.equal(responses[0].reply_text, "Loved the second episode");
  assert.equal(responses[0].source, "hum-answer");
  assert.equal(responses[0].lane, "show_preference"); // memory_hook rides along as the lane hint
  assert.equal(responses[0].disposition, "answered");
  assert.equal(responses[0].ping_id, "q-1");

  // Pending cleared.
  const pending = fs.readFileSync(path.join(fakeData, "hum-pending-question.json"), "utf8").trim();
  assert.equal(pending, "null");

  // NO realtime wiki write — the memory dir stays empty (retired routing).
  const memFiles = fs.readdirSync(fakeMemoryDir);
  assert.equal(memFiles.length, 0, `memory dir should be empty, found: ${memFiles.join(", ")}`);
});

test("hum-answer appends a second answer without clobbering the first", () => {
  writePending({
    id: "q-2",
    asked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    subject: "Sketch show",
    question: "Liked the sketch show?",
    memory_hook: "show_preference",
  });
  const r = runHumAnswer(["q-2", "Skipped after one episode"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);

  const responses = readJsonl("hum-responses.jsonl");
  assert.equal(responses.length, 2);
  assert.equal(responses[1].reply_text, "Skipped after one episode");

  const learnings = readJsonl("hum-learnings.jsonl");
  assert.equal(learnings.length, 2);
});

test("hum-answer carries category through to hum-learnings.jsonl when the pending question has one (lane_diagnosis)", () => {
  writePending({
    id: "q-4",
    asked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    category: "lane_diagnosis",
    lane: "ideas",
    subject: "hum ideas decay",
    question: "Hum's ideas lane has gone quiet — what's not working?",
    memory_hook: "hum_improvement_loop",
  });
  const r = runHumAnswer(["q-4", "Timing is off, they land too late in the day"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);

  const learnings = readJsonl("hum-learnings.jsonl");
  const row = learnings.find((l) => l.id === "q-4");
  assert.ok(row, "expected a hum-learnings.jsonl row for q-4");
  assert.equal(row.category, "lane_diagnosis");
});

test("hum-answer omits category entirely (not null) for an ordinary question with no category field", () => {
  writePending({
    id: "q-5",
    asked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    subject: "Sushi place",
    question: "How was dinner?",
    memory_hook: "restaurant_preference",
  });
  const r = runHumAnswer(["q-5", "Great, would go back"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);

  const learnings = readJsonl("hum-learnings.jsonl");
  const row = learnings.find((l) => l.id === "q-5");
  assert.ok(row, "expected a hum-learnings.jsonl row for q-5");
  assert.ok(!("category" in row), "category key should be omitted, not present as null");
});

test("hum-answer rejects an id mismatch and writes nothing new", () => {
  writePending({
    id: "q-3",
    asked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    subject: "x", question: "y?", memory_hook: "general_preference",
  });
  const before = readJsonl("hum-responses.jsonl").length;
  const r = runHumAnswer(["q-WRONG", "whatever"]);
  assert.equal(r.status, 3, `expected exit 3 (id mismatch), got ${r.status}`);
  assert.equal(readJsonl("hum-responses.jsonl").length, before);
});

test("hum-answer refuses an expired question, but --late files it (an answer that came after the window)", () => {
  const expired = (id) => writePending({
    id, asked_at: new Date(Date.now() - 3600e3).toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString(),
    subject: "hum pings", question: "How would you want quiet hours to work?", memory_hook: "hum_improvement:x",
  });
  const before = readJsonl("hum-learnings.jsonl").length;
  expired("q-late-1");
  assert.equal(runHumAnswer(["q-late-1", "whatever"]).status, 4);
  assert.equal(readJsonl("hum-learnings.jsonl").length, before); // refused: nothing filed

  expired("q-late-2");
  const r = runHumAnswer(["q-late-2", "--late", "Quiet after 10pm, except anything urgent"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const rows = readJsonl("hum-learnings.jsonl");
  assert.equal(rows.length, before + 1);
  assert.equal(rows.at(-1).answer, "Quiet after 10pm, except anything urgent");
  assert.equal(rows.at(-1).late, true);
  assert.equal(readJsonl("hum-responses.jsonl").at(-1).reply_text, "Quiet after 10pm, except anything urgent");
});
