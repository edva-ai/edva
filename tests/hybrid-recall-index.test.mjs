// hybrid-recall-index.test.mjs — the packed vector index behind recall's
// semantic half. Run: node --test tests/hybrid-recall-index.test.mjs
//
// Pure functions over synthetic vectors — no DB, no Ollama, no network.
//
// The contract that matters: knnIndex must rank IDENTICALLY to the original
// per-row knn(). It is a performance rewrite of a ranking used in production
// recall, so parity is the test, not "looks about right".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  packF32,
  unpackF32,
  cosine,
  knn,
  buildVectorIndex,
  knnIndex,
  cachedVectorIndex,
  clearVectorIndexCache,
} from "../lib/hybrid-recall.mjs";

// The original knn(), verbatim, as the reference oracle. `knn` was rewritten to
// be allocation-free (one scratch vector, bounded top-k, only the k winners
// materialized) and it backs the inbox + event recall paths, so it needs a
// check independent of knnIndex — otherwise the two could drift together and
// the parity test above would happily pass.
function referenceKnn(rows, queryVec, k = 30) {
  const q = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec);
  const scored = [];
  for (const r of rows) {
    const v = r.embedding instanceof Float32Array ? r.embedding : unpackF32(r.embedding);
    if (!v.length) continue;
    const { embedding, ...rest } = r;
    scored.push({ ...rest, score: cosine(q, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Deterministic pseudo-vectors — a tiny LCG so the corpus is reproducible
// without pulling in a seeded-random dependency.
function makeVec(seed, dims = 16) {
  const v = new Float32Array(dims);
  let s = seed >>> 0;
  for (let i = 0; i < dims; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = (s / 0xffffffff) * 2 - 1;
  }
  return v;
}

function corpus(n, dims = 16) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    type: i % 3 === 0 ? "user" : "reference",
    embedding: makeVec(i + 1, dims),
  }));
}

test("the allocation-free knn matches the original implementation exactly", () => {
  for (const seed of [1, 77, 4242]) {
    const rows = corpus(60).map((r) => ({ ...r, embedding: packF32(r.embedding) }));
    const q = makeVec(seed);
    const got = knn(rows.map((r) => ({ ...r })), q, 12);
    const want = referenceKnn(rows.map((r) => ({ ...r })), q, 12);
    assert.deepEqual(got.map((r) => r.id), want.map((r) => r.id), `ids @ seed ${seed}`);
    for (let i = 0; i < want.length; i++) {
      assert.ok(Math.abs(got[i].score - want[i].score) < 1e-6, `score ${i} @ seed ${seed}`);
    }
    assert.equal(got[0].embedding, undefined, "the vector is still stripped from results");
  }
});

test("knn keeps a zero-magnitude row at score 0 rather than dropping it", () => {
  // The old implementation let cosine() return 0 for a dead vector, so the row
  // survived into the ranking. Dropping it instead would silently change what
  // the inbox path returns when an embedding is bad.
  const rows = [
    { id: "live", embedding: makeVec(5) },
    { id: "dead", embedding: new Float32Array(16) },
  ];
  const got = knn(rows.map((r) => ({ ...r })), makeVec(5), 10);
  assert.deepEqual(
    got.map((r) => r.id).sort(),
    referenceKnn(rows.map((r) => ({ ...r })), makeVec(5), 10).map((r) => r.id).sort(),
  );
  assert.equal(got.find((r) => r.id === "dead").score, 0);
});

test("knn handles ragged widths the way cosine() defines them", () => {
  // cosine() normalizes the query over the OVERLAPPING PREFIX only, so a
  // query-wide magnitude would give a different answer here.
  const rows = [
    { id: "wide", embedding: makeVec(3, 16) },
    { id: "narrow", embedding: makeVec(4, 8) },
  ];
  const q = makeVec(11, 16);
  const got = knn(rows.map((r) => ({ ...r })), q, 5);
  const want = referenceKnn(rows.map((r) => ({ ...r })), q, 5);
  assert.deepEqual(got.map((r) => r.id), want.map((r) => r.id));
  for (let i = 0; i < want.length; i++) {
    assert.ok(Math.abs(got[i].score - want[i].score) < 1e-6, `ragged score ${i}`);
  }
});

test("knn reuses one scratch buffer across rows of differing widths", () => {
  // The scratch pad grows on demand and is shared between calls; a narrow row
  // following a wide one must read only its own bytes, not the tail of the
  // previous row still sitting in the buffer.
  const wide = [{ id: "w", embedding: packF32(makeVec(2, 32)) }];
  knn(wide.map((r) => ({ ...r })), makeVec(2, 32), 1);
  const narrow = [{ id: "n", embedding: packF32(makeVec(6, 8)) }];
  const got = knn(narrow.map((r) => ({ ...r })), makeVec(6, 8), 1);
  const want = referenceKnn(narrow.map((r) => ({ ...r })), makeVec(6, 8), 1);
  assert.ok(Math.abs(got[0].score - want[0].score) < 1e-6);
  assert.ok(got[0].score > 0.99, "a vector against itself is ~1");
});

test("knnIndex ranks identically to the per-row knn it replaces", () => {
  const rows = corpus(50);
  const q = makeVec(9999);

  const oldRank = knn(rows.map((r) => ({ ...r })), q, 10).map((r) => r.id);
  const newRank = knnIndex(buildVectorIndex(rows), q, 10).map((r) => r.id);

  assert.deepEqual(newRank, oldRank, "same ids in the same order");
});

test("scores match cosine to floating-point tolerance", () => {
  const rows = corpus(20);
  const q = makeVec(4242);
  const oldTop = knn(rows.map((r) => ({ ...r })), q, 5);
  const newTop = knnIndex(buildVectorIndex(rows), q, 5);
  for (let i = 0; i < oldTop.length; i++) {
    assert.ok(
      Math.abs(oldTop[i].score - newTop[i].score) < 1e-5,
      `score ${i}: ${oldTop[i].score} vs ${newTop[i].score}`,
    );
  }
});

test("meta travels with the row and the embedding does not", () => {
  const out = knnIndex(buildVectorIndex(corpus(5)), makeVec(7), 3);
  assert.ok(out.length === 3);
  for (const r of out) {
    assert.ok(typeof r.id === "string");
    assert.ok(typeof r.type === "string");
    assert.equal(r.embedding, undefined, "the vector must not ride along");
    assert.equal(typeof r.score, "number");
  }
});

test("allow() scopes the candidate set without rebuilding the matrix", () => {
  const rows = corpus(30);
  const index = buildVectorIndex(rows);
  const q = makeVec(1234);

  const scoped = knnIndex(index, q, 10, { allow: (r) => r.type === "user" });
  assert.ok(scoped.length > 0, "the filter keeps some rows");
  assert.ok(scoped.every((r) => r.type === "user"), "only the allowed type survives");

  // And the filtered ranking is the unfiltered ranking with the others removed —
  // filtering must not reorder anything.
  const unscoped = knnIndex(index, q, 30).filter((r) => r.type === "user");
  assert.deepEqual(
    scoped.map((r) => r.id),
    unscoped.slice(0, scoped.length).map((r) => r.id),
  );
});

test("BLOB rows are accepted, and rows of the wrong dimension are dropped", () => {
  const rows = [
    { id: "a", embedding: packF32(makeVec(1)) }, // Buffer, as SQLite returns
    { id: "b", embedding: makeVec(2) }, // Float32Array
    { id: "short", embedding: packF32(makeVec(3, 8)) }, // 8 dims, not 16
    { id: "empty", embedding: null },
  ];
  const index = buildVectorIndex(rows);
  assert.equal(index.n, 2, "only the two full-width rows are indexed");
  const ids = knnIndex(index, makeVec(1), 5).map((r) => r.id);
  assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("a zero-magnitude query returns nothing rather than NaN scores", () => {
  const index = buildVectorIndex(corpus(5));
  assert.deepEqual(knnIndex(index, new Float32Array(16), 5), []);
});

test("a query of the wrong dimension returns nothing rather than garbage", () => {
  const index = buildVectorIndex(corpus(5));
  assert.deepEqual(knnIndex(index, makeVec(1, 8), 5), []);
});

test("an empty corpus is a no-op, not a throw", () => {
  const index = buildVectorIndex([]);
  assert.equal(index.n, 0);
  assert.deepEqual(knnIndex(index, makeVec(1), 5), []);
});

test("k is respected and results are ordered best-first", () => {
  const out = knnIndex(buildVectorIndex(corpus(40)), makeVec(77), 7);
  assert.equal(out.length, 7);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].score >= out[i].score, "descending by score");
  }
});

test("the cache reuses one matrix per version and rebuilds when it changes", () => {
  clearVectorIndexCache();
  let builds = 0;
  const load = (n) => () => {
    builds++;
    return corpus(n);
  };

  const a = cachedVectorIndex("t", "v1", load(10));
  const b = cachedVectorIndex("t", "v1", load(10));
  assert.equal(builds, 1, "same version → no rebuild");
  assert.equal(a, b, "and the very same object is handed back");

  const c = cachedVectorIndex("t", "v2", load(12));
  assert.equal(builds, 2, "changed version → rebuild");
  assert.equal(c.n, 12, "and the rebuild sees the new rows");

  // The staleness bug this guards: a re-embed that leaves the row COUNT
  // unchanged must still invalidate, which is why the caller's token carries
  // MAX(rowid) and data_version too, not just a count.
  const d = cachedVectorIndex("t", "v3", load(12));
  assert.equal(builds, 3, "same size, new version → still rebuilds");
  assert.notEqual(c, d);

  clearVectorIndexCache("t");
  cachedVectorIndex("t", "v3", load(12));
  assert.equal(builds, 4, "explicit clear forces the next build");
});
