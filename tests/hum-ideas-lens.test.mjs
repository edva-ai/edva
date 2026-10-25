// An idea's ideation lens is `idea_lens`. Ideas an installation stored under an
// older field name stay readable when its local config hum-ideas.json lists that
// name in `extend_lens_fields` (lib/hum-ideas-scorecard.mjs lensOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hum-lens-"));
process.env.EDVA_LOCAL_DIR = tmp;
fs.mkdirSync(path.join(tmp, "config"));
const { lensOf, lensFields, buildScorecard } = await import("../lib/hum-ideas-scorecard.mjs");
const setLegacy = (names) => fs.writeFileSync(path.join(tmp, "config", "hum-ideas.json"), JSON.stringify({ extend_lens_fields: names }));

test("lensOf: idea_lens only, by default", () => {
  fs.rmSync(path.join(tmp, "config", "hum-ideas.json"), { force: true });
  assert.deepEqual(lensFields(), ["idea_lens"]);
  assert.equal(lensOf({ idea_lens: "adapt" }), "adapt");
  assert.equal(lensOf({ old_lens: "adapt" }), undefined);
});

test("lensOf: an older field listed in local config is read; idea_lens wins", () => {
  setLegacy(["old_lens"]);
  assert.deepEqual(lensFields(), ["idea_lens", "old_lens"]);
  assert.equal(lensOf({ old_lens: "reverse" }), "reverse");
  assert.equal(lensOf({ idea_lens: "combine", old_lens: "reverse" }), "combine");
});

test("the scorecard's category × lens cells read both names", () => {
  setLegacy(["old_lens"]);
  const now = Date.parse("2026-10-04T18:00:00Z");
  const sent = new Date(now - 10 * 3600e3).toISOString();
  const ideas = new Map([
    ["a", { id: "a", category: "c", idea_lens: "adapt", ping_id: "p1" }],
    ["b", { id: "b", category: "c", old_lens: "adapt", ping_id: "p2" }],
    ["n", { id: "n", category: "c", ping_id: "p3" }],
  ]);
  const fb = ["p1", "p2", "p3"].map((ping_id) => ({ ping_id, sent_at: sent, reaction: "more" }));
  const sc = buildScorecard(ideas, fb, now);
  assert.equal(sc.by_category_lens["c×adapt"].sent, 2);
  assert.equal(sc.by_category_lens["c×none"].sent, 1);
});

test("hum-ideas-append validates the lens under either name", async () => {
  setLegacy(["old_lens"]);
  const { validate } = await import("../bin/hum-ideas-append");
  const lensErr = (idea) => validate({ id: "idea-x", subject: "s", rationale: "r", why_now: "w", category: "family", urgency: 0.5, draws_on: [], confidence: "high", ...idea }).filter((e) => /lens/.test(e));
  assert.deepEqual(lensErr({ idea_lens: "adapt" }), []);
  assert.deepEqual(lensErr({ old_lens: "adapt" }), []);
  assert.deepEqual(lensErr({ idea_lens: "sideways" }), ['idea_lens "sideways" invalid']);
  assert.deepEqual(lensErr({}), ['idea_lens "undefined" invalid']);
});
