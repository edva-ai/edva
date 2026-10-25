// hybrid-recall.mjs — pure helpers for lexical+semantic hybrid retrieval.
//
// Shared, dependency-free primitives used by the events recall path (and any
// future page path) to fuse an FTS/BM25 ranking with a vector-KNN ranking.
// Kept pure so it's trivially unit-testable and reusable across ESM callers.
//
// Vectors from nomic-embed-text are ~L2-normalized, so a dot product is a fine
// cosine proxy; we normalize defensively anyway so a non-normalized provider
// still behaves.

// Pack a JS number[] into a little-endian Float32 BLOB (Buffer) for SQLite.
export function packF32(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

// Unpack a Float32 BLOB back to a Float32Array. Accepts Buffer/Uint8Array.
export function unpackF32(blob) {
  if (!blob) return new Float32Array(0);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Copy into an aligned ArrayBuffer (BLOB byteOffset may be non-4-aligned).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Brute-force KNN. rows: [{...fields, embedding: Float32Array|Buffer}]. Returns
// the top-k rows (shallow-copied) with a `score` (cosine) field, best first.
// Fine at a few-thousand vectors — sub-10ms in JS; upgrade to sqlite-vec only if
// the corpus outgrows that.
// A single reusable landing pad for BLOB rows. `unpackF32` allocates a fresh
// ArrayBuffer per row purely to fix alignment; scoring only ever needs ONE row
// materialized at a time, so we copy into a scratch buffer instead and keep the
// allocation count independent of corpus size. Safe to share: the scoring loop
// below is fully synchronous, so no interleaved caller can observe it mid-scan.
let _scratchU8 = null;
let _scratchF32 = null;
function scratchVector(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const floats = buf.byteLength >> 2;
  if (!floats) return null;
  const need = floats << 2;
  if (!_scratchU8 || _scratchU8.byteLength < need) {
    const ab = new ArrayBuffer(need);
    _scratchU8 = new Uint8Array(ab);
    _scratchF32 = new Float32Array(ab);
  }
  _scratchU8.set(buf.subarray(0, need));
  return _scratchF32.subarray(0, floats);
}

export function knn(rows, queryVec, k = 30) {
  const raw = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec || []);
  // Normalize the query once instead of re-deriving its magnitude per row.
  let qn = 0;
  for (let i = 0; i < raw.length; i++) qn += raw[i] * raw[i];
  const qInv = qn > 0 ? 1 / Math.sqrt(qn) : 0;

  // Bounded insertion: only the k winners are ever materialized, where this
  // used to build one object per row and sort the whole corpus.
  const top = [];
  let floor = -Infinity;
  for (const r of rows) {
    const v = r.embedding instanceof Float32Array ? r.embedding : scratchVector(r.embedding);
    if (!v || !v.length) continue;
    let score;
    if (v.length === raw.length) {
      // Fast path: same width, so the once-normalized query is exact.
      let dot = 0;
      let vn = 0;
      for (let i = 0; i < raw.length; i++) {
        dot += raw[i] * v[i];
        vn += v[i] * v[i];
      }
      // Preserves the old contract: a zero-magnitude row still participates, at
      // score 0, rather than being dropped.
      score = qn === 0 || vn === 0 ? 0 : dot * qInv * (1 / Math.sqrt(vn));
    } else {
      // Ragged widths: `cosine` normalizes the query over the OVERLAPPING
      // PREFIX only, so a query-wide magnitude would give a different answer.
      // Rare enough (it means the embedding model changed mid-corpus) to be
      // worth exactness over speed.
      score = cosine(raw, v);
    }
    if (top.length >= k && score <= floor) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].score < score) pos--;
    top.splice(pos, 0, { row: r, score });
    if (top.length > k) top.pop();
    if (top.length >= k) floor = top[top.length - 1].score;
  }
  return top.map(({ row, score }) => {
    const { embedding, ...rest } = row;
    return { ...rest, score };
  });
}

// ── Packed vector index (allocation-free KNN) ─────────────────────────────
//
// `knn` above is correct but pays the whole corpus per query: the caller
// SELECTs every BLOB, `unpackF32` copies each one into a fresh ArrayBuffer, and
// both the caller's `.map` and `knn` itself spread every row into a new object.
// On the live 889-page wiki that is ~1,800 allocations and ~2.7 MB copied
// before any arithmetic runs, on every single recall — and the mail corpus is
// larger. None of it depends on the query.
//
// So: unpack once into ONE contiguous Float32Array, L2-normalize at build time
// (cosine then collapses to a dot product), and keep the scratch score buffer
// on the index. A query becomes a flat loop with zero allocation, and only the
// k rows actually returned are ever materialized.
//
// Scoring is fully synchronous, so the shared scratch buffer cannot be observed
// mid-pass by an interleaved caller.

// rows: [{ id, embedding: Float32Array|Buffer, ...meta }]. Returns an index
// object consumed by `knnIndex`. Rows with an empty or odd-sized vector are
// dropped (a dimension change mid-corpus must not corrupt the matrix).
export function buildVectorIndex(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let dims = 0;
  for (const r of list) {
    const v = r.embedding instanceof Float32Array ? r.embedding : unpackF32(r.embedding);
    if (v.length) { dims = v.length; break; }
  }
  if (!dims) return { n: 0, dims: 0, mat: new Float32Array(0), meta: [], scores: new Float64Array(0) };

  const meta = [];
  const mat = new Float32Array(list.length * dims);
  let n = 0;
  for (const r of list) {
    const v = r.embedding instanceof Float32Array ? r.embedding : unpackF32(r.embedding);
    if (v.length !== dims) continue;
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += v[i] * v[i];
    if (norm === 0) continue;
    const inv = 1 / Math.sqrt(norm);
    const off = n * dims;
    for (let i = 0; i < dims; i++) mat[off + i] = v[i] * inv;
    const { embedding, ...rest } = r;
    meta.push(rest);
    n++;
  }
  return { n, dims, mat, meta, scores: new Float64Array(n) };
}

// Top-k over a prebuilt index. `allow(metaRow)` optionally restricts the
// candidate set (a type/date filter) without rebuilding the matrix. Returns
// [{ ...meta, score }] best-first — k objects, not n.
export function knnIndex(index, queryVec, k = 30, { allow = null } = {}) {
  if (!index || !index.n || !index.dims) return [];
  const raw = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec || []);
  if (raw.length !== index.dims) return [];
  let qn = 0;
  for (let i = 0; i < index.dims; i++) qn += raw[i] * raw[i];
  if (qn === 0) return [];
  const inv = 1 / Math.sqrt(qn);
  const q = new Float32Array(index.dims);
  for (let i = 0; i < index.dims; i++) q[i] = raw[i] * inv;

  const { n, dims, mat, meta, scores } = index;
  // Both sides are unit vectors, so the dot product IS the cosine.
  for (let r = 0; r < n; r++) {
    if (allow && !allow(meta[r])) { scores[r] = -Infinity; continue; }
    const off = r * dims;
    let dot = 0;
    for (let i = 0; i < dims; i++) dot += mat[off + i] * q[i];
    scores[r] = dot;
  }

  // Bounded insertion beats sorting n rows when k << n (k is ~30, n is ~900).
  const top = [];
  let floor = -Infinity;
  for (let r = 0; r < n; r++) {
    const s = scores[r];
    if (s === -Infinity || (top.length >= k && s <= floor)) continue;
    let pos = top.length;
    while (pos > 0 && top[pos - 1].score < s) pos--;
    top.splice(pos, 0, { row: r, score: s });
    if (top.length > k) top.pop();
    if (top.length >= k) floor = top[top.length - 1].score;
  }
  return top.map((t) => ({ ...meta[t.row], score: t.score }));
}

// Module-scope cache so a long-lived process (MCP server, phone-channel) builds
// the matrix once and reuses it. `version` is any cheap token that changes when
// the underlying rows change; a mismatch rebuilds. Deliberately a plain Map: one
// entry per corpus, and the corpora are few and named.
const _indexCache = new Map();

export function cachedVectorIndex(name, version, loadRows) {
  const hit = _indexCache.get(name);
  if (hit && hit.version === version) return hit.index;
  const index = buildVectorIndex(loadRows());
  _indexCache.set(name, { version, index });
  return index;
}

// The most recently built matrix for `name`, whatever its version, or null.
// For a caller that needs SOME index to score against (the association gate in
// wiki_associate) right after a search has built the current one.
export function peekVectorIndex(name) {
  return _indexCache.get(name)?.index || null;
}

// Test/ops hook — drop a cached matrix (or all of them).
export function clearVectorIndexCache(name = null) {
  if (name == null) _indexCache.clear();
  else _indexCache.delete(name);
}

// Collapse a ranked list to one entry per key, keeping the BEST-ranked (i.e.
// first) occurrence. Written for multi-vector indexes: when a page is indexed
// through several cue anchors, `knnIndex` returns one row PER CUE, so the same
// page can occupy several of the top-k slots. Collapsing after the KNN (rather
// than trying to pre-filter) is what keeps "best cue wins" true — the winning
// row carries the cue that actually matched, which is the useful provenance.
//
// Order is preserved, so a list sorted by score stays sorted by score. Rows
// with a null/undefined key are dropped (they cannot be deduped meaningfully).
export function collapseByKey(rows, keyOf, { limit = Infinity } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Best score per key over EVERY row of a prebuilt index — one flat sweep, no
// top-k. Written for the association retriever's soft gate (wiki-embed.mjs):
// it has to know how much each page REACHED BY A LINK resembles the query, and
// those pages are by construction the ones a top-k cut off. A page indexed
// through several cue rows gets its best cue's score, matching collapseByKey's
// "best cue wins". Returns Map<key, cosine>; empty on a dimension mismatch.
export function bestScoreByKey(index, queryVec, keyOf = (m) => m.id) {
  const out = new Map();
  if (!index || !index.n || !index.dims) return out;
  const raw = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec || []);
  if (raw.length !== index.dims) return out;
  let qn = 0;
  for (let i = 0; i < index.dims; i++) qn += raw[i] * raw[i];
  if (qn === 0) return out;
  const inv = 1 / Math.sqrt(qn);
  const { n, dims, mat, meta } = index;
  for (let r = 0; r < n; r++) {
    const off = r * dims;
    let dot = 0;
    for (let i = 0; i < dims; i++) dot += mat[off + i] * raw[i];
    const s = dot * inv;
    const k = keyOf(meta[r]);
    if (k == null) continue;
    const cur = out.get(k);
    if (cur === undefined || s > cur) out.set(k, s);
  }
  return out;
}

// Reciprocal Rank Fusion — parameter-free, no score normalization needed.
// lists: array of ranked arrays. keyOf(item) → stable id used to merge across
// lists. Returns [{ id, rrf, sources:{listIndex:rank} }] sorted by rrf desc.
// rrfK dampens the contribution of low ranks (60 is the standard default).
// `weights` (optional, one per list, default 1) scales a list's whole
// contribution — how a secondary opinion (association, a recency prior) joins
// the fusion without being allowed to outvote the lexical and semantic halves.
export function rrfFuse(lists, keyOf, { rrfK = 60, limit = 20, weights = null } = {}) {
  const acc = new Map();
  lists.forEach((list, li) => {
    const wt = weights && Number.isFinite(weights[li]) ? weights[li] : 1;
    list.forEach((item, i) => {
      const id = keyOf(item);
      if (id == null) return;
      const cur = acc.get(id) || { id, rrf: 0, sources: {}, item };
      cur.rrf += wt / (rrfK + i + 1);
      cur.sources[li] = i + 1;
      // Keep the richest item snapshot we've seen for this id.
      if (!cur.item) cur.item = item;
      acc.set(id, cur);
    });
  });
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}
