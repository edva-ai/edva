// hybrid-recall.test.mjs — pure fusion helpers + the event-fts hybrid path.
//
// Run: node --test agent/test/hybrid-recall.test.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packF32, unpackF32, cosine, knn, rrfFuse } from "../../lib/hybrid-recall.mjs";

const TMP_DB = path.join(os.tmpdir(), `hybrid-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const { indexEvent, embedPending, searchEventsHybrid, embeddingStats, _closeForTest } = await import("../../lib/event-fts.mjs");

// Deterministic toy embedder (8-dim bag-of-chars), L2-normalized.
function toy(t) {
  const v = new Array(8).fill(0);
  for (const c of (t || "")) v[c.charCodeAt(0) % 8] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function cleanup() {
  _closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

describe("hybrid-recall pure helpers", () => {
  it("packF32/unpackF32 round-trips a vector", () => {
    const v = [0.1, -0.5, 1.25, 0, 3.14];
    const back = unpackF32(packF32(v));
    assert.equal(back.length, 5);
    for (let i = 0; i < 5; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
  });

  it("cosine is 1 for identical, ~0 for orthogonal", () => {
    assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  });

  it("knn returns nearest first with scores", () => {
    const rows = [
      { id: "a", embedding: Float32Array.from([1, 0, 0]) },
      { id: "b", embedding: Float32Array.from([0, 1, 0]) },
      { id: "c", embedding: Float32Array.from([0.9, 0.1, 0]) },
    ];
    const out = knn(rows, [1, 0, 0], 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "a");
    assert.equal(out[1].id, "c");
    assert.ok(out[0].score >= out[1].score);
  });

  it("rrfFuse merges rankings and rewards agreement", () => {
    const lexical = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const semantic = [{ id: 3 }, { id: 1 }, { id: 9 }];
    const fused = rrfFuse([lexical, semantic], (r) => r.id, { limit: 4 });
    const ids = fused.map((f) => f.id);
    // 1 and 3 appear in both lists → should top the fused ranking.
    assert.ok(ids.slice(0, 2).includes(1) && ids.slice(0, 2).includes(3));
    assert.ok(ids.includes(9)); // singletons still present, ranked lower
  });
});

describe("event-fts hybrid path", () => {
  before(cleanup);
  after(cleanup);

  it("embeds high-value events, searches hybrid, and degrades to fts", async () => {
    indexEvent({ ts: "2026-07-08T09:00:00Z", kind: "result", result: "Quarterly budget memo emailed with a rebalance of project buckets" }, { agent: "ops" });
    indexEvent({ ts: "2026-07-08T09:10:00Z", kind: "dispatcher.dispatching", item: { id: "2", source: "gmail:1", content: "Triage Shipment notice" } }, { agent: "ops" });
    // system firehose event must NOT be embedded (not a high-value kind).
    indexEvent({ ts: "2026-07-08T09:15:00Z", kind: "system", subtype: "init" }, { agent: "ops" });

    const res = await embedPending({ embedFn: async (t) => toy(t), limit: 50 });
    assert.equal(res.embedded, 2, "only the 2 high-value events embed, not the system event");
    assert.equal(res.remaining, 0);

    const st = embeddingStats();
    assert.equal(st.embedded, 2);
    assert.equal(st.embeddable, 2);

    const hy = await searchEventsHybrid("rebalance memo", { limit: 3, embedQuery: async (t) => toy(t) });
    assert.ok(hy.length >= 1);
    assert.equal(hy[0].via, "hybrid");

    // No embedder → pure FTS, same result shape.
    const deg = await searchEventsHybrid("rebalance", { limit: 3, embedQuery: null });
    assert.ok(deg.length >= 1);
    assert.equal(deg[0].via, "fts");
  });
});
