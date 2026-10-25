// hum-wiki-recall — the hum tick's "has the user already said something about
// this?" lookup.
//
// Regression cover for the 2026-07-29 finding: this path had been returning
// ZERO hits for every realistic candidate since it was built on 2026-06-28.
// Two causes, both guarded here.
//
//   1. The query prepended the candidate's `topic` ("dining Casa Verde …").
//      Under FTS5's implicit AND that was one more token every page had to
//      contain; under semantic search it drags the query toward Edva's own
//      hum-machinery pages. Subject only.
//
//   2. FTS5 ANDs its terms, so a sentence-shaped query demanded every token on
//      one page. Fixed by opting this caller into `match: "or"`, where BM25
//      ranks by term rarity instead.
//
// A third mistake is worth recording because the tests that replaced these
// asserted it confidently: the first fix for (2) was semantic hybrid search
// with a COSINE floor. It produced hits but the wrong ones — 41 of 42
// semantic-only, a weather reading pulling three wiki pages — because the floor
// had been calibrated against absurd queries (quantum chromodynamics) rather
// than real candidates. Page-level cosine cannot separate "about this subject"
// from "about the user", which is all this corpus contains. BM25 can, since a
// vague candidate has no rare terms to match. The band assertion below is what
// that mistake cost.
//
// The live end-to-end behaviour (real corpus) can't be asserted here; these
// guard the pure decisions that made it break.

import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateQuery, keepHit, MAX_BM25 } from "../agent/scripts/hum-wiki-recall.mjs";

test("the query is the subject alone — never prefixed with the topic", () => {
  const q = candidateQuery({ topic: "dining", subject: "Casa Verde uptown taqueria worth a return" });
  assert.equal(q, "Casa Verde uptown taqueria worth a return");
  assert.ok(!q.includes("dining"), "the topic must not enter the query");
});

test("falls back through the candidate's other subject-ish fields", () => {
  assert.equal(candidateQuery({ topic: "ideas", supporting_data: { subject: "from supporting_data" } }), "from supporting_data");
  assert.equal(candidateQuery({ topic: "news", signal: "headline text" }), "headline text");
  assert.equal(candidateQuery({}), "");
  assert.equal(candidateQuery(null), "");
});

test("a long subject is capped but not truncated to nothing", () => {
  const long = "word ".repeat(60);
  const q = candidateQuery({ topic: "x", subject: long });
  assert.ok(q.length <= 120 && q.length > 0);
});

test("weak BM25 hits are dropped, strong ones kept", () => {
  // bm25() is negative; more negative = stronger. Values below are the real
  // top-hit scores measured over 14 live hum candidates.
  assert.equal(keepHit({ score: -25.4 }), true, "a trip question -> the schedule page");
  assert.equal(keepHit({ score: -16.3 }), true, "a hobby -> the user's preference page");
  assert.equal(keepHit({ score: -7.4 }), false, "weather -> an unrelated day page");
  assert.equal(keepHit({ score: -8.8 }), false, "a finance word -> an unrelated reference page");
  assert.equal(keepHit({ score: -9.9 }), false, "a band name -> an old day page");
});

test("a hit with no score is not evidence", () => {
  assert.equal(keepHit({ score: null }), false);
  assert.equal(keepHit({}), false);
  assert.equal(keepHit(null), false);
});

test("the floor stays inside its calibrated band", () => {
  // Guards both directions of drift, using the measured gap. Relax it past
  // -10 and the noise returns (the three noise hits sat at -7.4 to
  // -9.9). Tighten it past -14 and real hits start disappearing (the weakest
  // genuinely-relevant top hit was a month page at -14.7).
  assert.ok(MAX_BM25 <= -10, "must exclude the measured noise range");
  assert.ok(MAX_BM25 >= -14, "must not exclude the measured relevant range");
});
