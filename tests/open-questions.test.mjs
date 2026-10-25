// open-questions.test.mjs — the unanswered-question ledger.
//
// Design: an open question is re-asked until it is answered or it expires;
// questions tied to a single day (location questions) expire with that day.
// The failures that matter: a question that
// silently drops out of the ledger (never re-asked), a location question that
// keeps coming back the next day, a re-ask that files as a new question, and a
// late answer that hum-answer refuses.
//
// Run: node --test tests/open-questions.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-questions-"));
process.env.EDVA_DATA_DIR = dir;
process.env.SUPABASE_SERVICE_ROLE_KEY = ""; // stampRows must stay offline
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const OQ = await import("../lib/open-questions.mjs");
const { resolveHumTarget, humStateBlock } = await import("../lib/hum-reply-target.mjs");
const H = 3600e3;
const iso = (t) => new Date(t).toISOString();
const reset = () => fs.writeFileSync(OQ.LEDGER(), "");

test("an asked question stays open until answered, and folds re-asks into one", () => {
  reset();
  const t0 = Date.now() - 30 * H;
  OQ.recordAsked({ id: "q-1", question: "Sourdough baking?", lane: "dream_asks", msg_id: "m1", at: iso(t0) });
  OQ.recordAsked({ id: "q-1", question: "Coming back to this: Sourdough baking?", lane: "dream_asks", msg_id: "m2", at: iso(t0 + 21 * H) });
  const [q] = OQ.openQuestions();
  assert.equal(q.id, "q-1");
  assert.equal(q.asks, 2);
  assert.deepEqual(q.msg_ids, ["m1", "m2"]);
  assert.equal(q.original_question, "Sourdough baking?");
  assert.equal(OQ.questionForMessage("m1").id, "q-1");
  assert.ok(OQ.recordAnswered("q-1"));
  assert.equal(OQ.openQuestions().length, 0);
  assert.equal(OQ.recordAnswered("q-1"), null, "answering twice is a no-op");
});

test("re-ask schedule backs off: next day, then 2 days, then 4, then weekly", () => {
  reset();
  const now = Date.now();
  OQ.recordAsked({ id: "q-a", question: "a", lane: "ideas", at: iso(now - 19 * H) });
  OQ.recordAsked({ id: "q-b", question: "b", lane: "ideas", at: iso(now - 21 * H) });
  assert.deepEqual(OQ.dueForReask(now).map((q) => q.id), ["q-b"]);
  // q-b re-asked once: next one due 44h after that.
  OQ.recordAsked({ id: "q-b", question: "b again", lane: "ideas", at: iso(now - 40 * H) });
  assert.ok(!OQ.dueForReask(now).some((q) => q.id === "q-b"));
});

test("location questions lapse at the end of their day and are never re-asked", () => {
  reset();
  const tz = "Asia/Tokyo";
  const asked = "2026-10-16T01:00:00.000Z"; // 10:00 local
  const until = OQ.relevantUntilFor("location_context", asked, tz);
  assert.ok(until.startsWith("2026-10-16T14:59"), `end of Oct 16 local, got ${until}`);
  assert.equal(OQ.relevantUntilFor("dream_asks", asked, tz), null);
  OQ.recordAsked({ id: "q-loc", question: "Where were you at 3?", lane: "location_context", at: asked, relevant_until: until });
  const later = Date.parse("2026-10-17T03:00:00Z");
  assert.equal(OQ.openQuestions(later).length, 0);
  assert.equal(OQ.dueForReask(later).length, 0);
});

test("hum_asks and hum-improvement questions are kept but not re-asked from here", () => {
  reset();
  const now = Date.now();
  OQ.recordAsked({ id: "q-h", question: "h", lane: "hum_asks", at: iso(now - 50 * H) });
  OQ.recordAsked({ id: "q-i", question: "i", lane: "ideas", memory_hook: "hum_improvement:x", at: iso(now - 50 * H) });
  assert.equal(OQ.openQuestions(now).length, 2);
  assert.equal(OQ.dueForReask(now).length, 0);
});

test("retired questions close; the chat agent sees every open one and its route", () => {
  reset();
  const now = Date.now();
  OQ.recordAsked({ id: "q-x", question: "Old one?", lane: "ideas", msg_id: "mx", at: iso(now - 72 * H) });
  OQ.recordAsked({ id: "q-y", question: "Dropped one?", lane: "ideas", msg_id: "my", at: iso(now - 72 * H) });
  assert.ok(OQ.recordRetired("q-y", "event passed"));
  const block = humStateBlock(dir, now);
  assert.match(block, /q-x/);
  assert.doesNotMatch(block, /q-y/);
  const t = resolveHumTarget("mx", dir, now);
  assert.equal(t.kind, "question");
  assert.equal(t.route, 'hum-answer q-x "<their answer>"');
  assert.equal(resolveHumTarget("my", dir, now), null);
});

test("hum-answer files a late answer to an open question with no slot", () => {
  reset();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oq-home-"));
  const data = path.join(home, "Dev/edva/data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "hum-pending-question.json"), "null\n");
  const env = { ...process.env, HOME: home, EDVA_DATA_DIR: data, SUPABASE_SERVICE_ROLE_KEY: "" };
  fs.writeFileSync(path.join(data, "open-questions.jsonl"),
    JSON.stringify({ ev: "asked", id: "q-old", at: iso(Date.now() - 80 * H), question: "Learn to sail?", lane: "dream_asks", msg_id: "m9" }) + "\n");
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/hum-answer");
  const r = spawnSync(process.execPath, [bin, "q-old", "Maybe next summer"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.open_question_closed, true);
  const learn = JSON.parse(fs.readFileSync(path.join(data, "hum-learnings.jsonl"), "utf8").trim());
  assert.equal(learn.late, true);
  assert.equal(learn.question, "Learn to sail?");
  fs.rmSync(home, { recursive: true, force: true });
});
