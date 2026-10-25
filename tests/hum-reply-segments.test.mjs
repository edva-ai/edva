// hum-reply-segments.test.mjs — one reply, several answers (2026-07-27;
// attribution moved to a model 2026-10-04, Rule #0b).
//
// The catch-up reply is the case this exists for: the user was busy, four pings
// stacked up, and one message answers three of them. Code owns WHERE the reply
// splits; a model owns WHICH item each part answers. These tests pin the
// structural half exactly and the plumbing around the model pick with a stub —
// never attribute without a pick, never enter multi-mode on one target, and
// never fall back to word matching when the model is unavailable.
//
// Run: node --test tests/hum-reply-segments.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  segmentReply, attributeSegments, distinctTargets, splitMultiAnswer, soleTarget, mayAnswerSeveral,
} from "../lib/hum-reply-segments.mjs";

const ITEMS = [
  { key: "ping:p-1", subject: "Cafe Uno has a 1pm table Saturday" },
  { key: "ping:p-2", subject: "City museum painting exhibit closing" },
  { key: "approval:Night Desk", subject: "Night Desk" },
  { key: "question:q-1", subject: "hum exercise lane decay" },
];

/** A stub model: picks by an explicit segment → index table. */
const stub = (table) => async (segments) => segments.map((s) => (s in table ? table[s] : null));

test("segments split on lines, sentences, semicolons and bullets", () => {
  assert.deepEqual(segmentReply("a\nb"), ["a", "b"]);
  assert.deepEqual(segmentReply("Loved it. Skip that."), ["Loved it.", "Skip that."]);
  assert.deepEqual(segmentReply("one; two"), ["one", "two"]);
  assert.deepEqual(segmentReply("- first\n- second"), ["first", "second"]);
});

test("the numbered-verdict reply protocol splits per verdict", () => {
  assert.deepEqual(segmentReply("1 yes 2 no 3 skip"), ["yes", "no", "skip"]);
});

test("ordinary numbers in prose never trigger an enumeration split", () => {
  assert.deepEqual(segmentReply("I paid 20 bucks for 3 tickets"), ["I paid 20 bucks for 3 tickets"]);
});

test("a catch-up reply attributes each part where the model points it", async () => {
  const pick = stub({ "Loved Cafe Uno.": 0, "Skip the museum thing.": 1, "And yes to Night Desk.": 2 });
  const multi = await splitMultiAnswer("Loved Cafe Uno. Skip the museum thing. And yes to Night Desk.", ITEMS, { pick });
  assert.equal(multi.length, 3);
  const byKey = Object.fromEntries(multi.map((t) => [t.item.key, t.segments.join(" ")]));
  assert.equal(byKey["ping:p-1"], "Loved Cafe Uno.");
  assert.equal(byKey["ping:p-2"], "Skip the museum thing.");
});

test("a single-segment reply never calls the model and is never multi", async () => {
  let called = 0;
  const pick = async (s) => { called++; return s.map(() => 0); };
  assert.equal(await splitMultiAnswer("Cafe Uno was too expensive", ITEMS, { pick }), null);
  assert.equal(await splitMultiAnswer("yes", ITEMS, { pick }), null);
  assert.equal(called, 0);
});

test("two segments about the SAME item collapse into one target, not multi", async () => {
  const pick = stub({ "Cafe Uno was great.": 0, "Uno again next week please.": 0 });
  assert.equal(await splitMultiAnswer("Cafe Uno was great. Uno again next week please.", ITEMS, { pick }), null);
});

test("a model that is unavailable attributes NOTHING — no word-match fallback", async () => {
  const pick = async () => null;
  const attrs = await attributeSegments(["Loved Cafe Uno.", "Skip the museum."], ITEMS, { pick });
  assert.deepEqual(attrs.map((a) => a.item), [null, null]);
  const thrower = async () => { throw new Error("gateway down"); };
  assert.equal(await splitMultiAnswer("Loved Cafe Uno. Skip the museum.", ITEMS, { pick: thrower }), null);
  assert.equal(await soleTarget("Loved Cafe Uno.", ITEMS, { pick: thrower }), null);
});

test("an out-of-range pick is ignored rather than mis-filed", async () => {
  const attrs = await attributeSegments(["x"], ITEMS, { pick: async () => [99] });
  assert.equal(attrs[0].item, null);
});

test("soleTarget returns the one item a reply names", async () => {
  const pick = stub({ "The castle was too expensive.": 3 });
  assert.equal((await soleTarget("The castle was too expensive.", ITEMS, { pick })).key, "question:q-1");
});

test("unmatched segments are dropped, not attached to a neighbor", () => {
  const attrs = [{ text: "a", item: ITEMS[0] }, { text: "b", item: null }];
  assert.equal(distinctTargets(attrs).length, 1);
});

test("mayAnswerSeveral is structural: 2+ segments and 2+ items", () => {
  assert.equal(mayAnswerSeveral("one. two.", ITEMS), true);
  assert.equal(mayAnswerSeveral("just one sentence", ITEMS), false);
  assert.equal(mayAnswerSeveral("one. two.", ITEMS.slice(0, 1)), false);
});

test("empty and whitespace input degrade quietly", async () => {
  assert.deepEqual(segmentReply(""), []);
  assert.deepEqual(segmentReply("   \n  \n"), []);
  assert.equal(await splitMultiAnswer("", ITEMS), null);
  assert.equal(await splitMultiAnswer("anything. else.", []), null);
});
