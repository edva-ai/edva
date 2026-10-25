// wiki-assoc.mjs — associative recall over the wiki graph.
//
// "Recall one thing and the memories associated with it come up." The wiki has
// held the graph for that since it shipped (`page_links`), and the 2026-08-09
// link expansion walked it one hop — and measured zero gain. Reading why (see
// system/associative-memory-research.md § 2) gave four causes, and this
// module is the fix for the three that live in the retriever:
//
//   1. A HARD COSINE FLOOR re-gated every neighbour by its similarity to the
//      query. Association exists to surface what is NOT similar to the cue but
//      is tied to what the cue activated, so the floor removed exactly what
//      expansion was for — and, because day narratives sit at 0.46-0.60 cosine,
//      it blocked every day page outright. Here the gate is SOFT (a sigmoid
//      that scales activation, never zeroes it) and runs on the page's best cue.
//   2. FORWARD-ONLY WIKILINKS and a HARD HUB CUTOFF (in-degree > 60 → nothing).
//      "Everything about <person>" lives on the day pages that link TO that page, i.e.
//      the backward edges. Both directions are walked here, and hubs are tamed
//      the way ACT-R's fan effect does it: a node's contribution scales with its
//      specificity ln(N/fan)/ln(N), so `travel` (fan ≈ 1160) carries nothing,
//      a much-linked person page (a few hundred) carries a little, and one with ten
//      neighbours carries most of its weight. No step function.
//   3. NO CONVERGENCE. The old code kept the best seed per neighbour; here a page
//      reached from several seeds adds up all of them — pattern completion, the
//      page that ties two cues together outranks one tied to a single cue.
//
// (The fourth cause — an eval that cannot see association — is fixed in
// bin/wiki-recall-eval and bin/wiki-recall-eval-gen.)
//
// Two propagation schemes, deliberately both, because the literature does not
// settle which wins on a corpus like this one and the eval should:
//   spreadActivation — ACT-R-style: a fixed number of steps, fan-normalized on
//     both the sending and receiving side, top-M lateral inhibition per step.
//     (SYNAPSE, ACL Findings 2026; Query-Aware SA, arXiv 2606.30133.)
//   personalizedPageRank — HippoRAG's: random walk with restart from the seeds,
//     receiving-side specificity in the transition, final score / fan^0.5 so the
//     stationary mass does not pool in the hubs.
//
// Edges come from four places, each with its own base weight (EDGE_W):
//   page_links          wikilink (forward stronger than backward), related,
//                       supersedes
//   day contiguity      day_D ↔ day_D±1, forward stronger (lag-CRP: recall moves
//                       forward in time more than backward)
//   page_facts          typed fact edges (lib/wiki-facts.mjs), current only
//   page_coactivation   Hebbian co-retrieval weight (lib/wiki-hebbian.mjs):
//                       multiplies an existing edge, or adds a weak one
//
// Pure functions over a loaded graph, so the algorithms are unit-testable with
// no DB; `loadAssocGraph` is the only part that reads SQLite, and it tolerates
// every optional table being absent.

// lang-regex-ok: matches the machine-generated page id shape day_YYYY-MM-DD
const DAY_ID_RE = /^day_(\d{4})-(\d{2})-(\d{2})$/;
// lang-regex-ok: matches the machine-generated page id shape week_YYYY-MM-DD (Monday)
const WEEK_ID_RE = /^week_(\d{4})-(\d{2})-(\d{2})$/;
// lang-regex-ok: matches the machine-generated page id shape month_YYYY-MM
const MONTH_ID_RE = /^month_(\d{4})-(\d{2})$/;
// lang-regex-ok: validates a caller-supplied ISO date argument (structure)
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Base weight per edge kind. Curated statements that two pages belong together
// (related, a fact) are the strongest; a backlink is weaker than the forward
// link because "this day mentions <person>" says more about the day than about that person.
export const EDGE_W = Object.freeze({
  related: 1.0,
  fact: 1.0,
  supersedes: 0.6,
  wikilink: 0.8,
  backlink: 0.5,
  next_day: 0.6,
  prev_day: 0.4,
  hebbian: 0.5,
});

// How much a Hebbian weight (0..1) can amplify an existing edge: ×(1 + γ·h).
const HEBB_GAMMA = 1.0;
// Below this a co-activation pair is noise and adds no edge of its own.
const HEBB_MIN_EDGE = 0.1;

// ── Episodic dates (structure of the page id, never of language) ──────────

// The date span a page covers, as [startISO, endISO] inclusive, or null for a
// page that is not episodic. Day = that day; week = Monday..Sunday; month =
// 1st..last.
export function pageDateSpan(id) {
  const s = String(id || "");
  let m = DAY_ID_RE.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return [d, d];
  }
  m = WEEK_ID_RE.exec(s);
  if (m) {
    const start = `${m[1]}-${m[2]}-${m[3]}`;
    return [start, addDays(start, 6)];
  }
  m = MONTH_ID_RE.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return [`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`];
  }
  return null;
}

export function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

export function isIsoDate(s) {
  return typeof s === "string" && ISO_DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

// Does page `id` fall inside [after, before] (inclusive, either may be null)?
// A non-episodic page has no date and is always inside: a date window scopes
// WHEN something happened, it says nothing about who a person is. An episodic
// page is inside when its span overlaps the window.
export function inDateWindow(id, after = null, before = null) {
  if (!after && !before) return true;
  const span = pageDateSpan(id);
  if (!span) return true;
  if (after && span[1] < after) return false;
  if (before && span[0] > before) return false;
  return true;
}

// ── Graph ──────────────────────────────────────────────────────────────────

// Build an in-memory graph from plain arrays. Exposed separately from the
// loader so tests (and the eval generator) can build one without SQLite.
//
//   nodes: [{ id, type }]
//   links: [{ src, dst, kind }]   kind ∈ wikilink | related | supersedes | fact
//   hebbian: [{ a, b, w }]        w already decayed to "now", 0..∞ (clamped to 1)
//
// Returns { n, ids, idx, type, adj, fan, spec, lnN }. `adj[i]` is an array of
// { j, w, kind } — outgoing in the sense of "activation flows i → j", which for
// most kinds exists in both directions with different weights.
export function buildAssocGraph({ nodes = [], links = [], hebbian = [] } = {}) {
  const ids = [];
  const idx = new Map();
  const type = [];
  for (const nd of nodes) {
    if (!nd || nd.id == null || idx.has(nd.id)) continue;
    idx.set(nd.id, ids.length);
    ids.push(nd.id);
    type.push(nd.type || null);
  }
  const n = ids.length;
  // Edge map per node: j → { w, kind } keeping the STRONGEST kind per pair, so a
  // page linked twice (a wikilink and a related) counts once at the higher weight
  // rather than doubling up and out-shouting genuinely distinct neighbours.
  const em = Array.from({ length: n }, () => new Map());
  const put = (i, j, w, kind) => {
    if (i === j || i == null || j == null) return;
    const cur = em[i].get(j);
    if (!cur || w > cur.w) em[i].set(j, { w, kind });
  };

  for (const l of links) {
    const i = idx.get(l.src);
    const j = idx.get(l.dst);
    if (i === undefined || j === undefined) continue;
    switch (l.kind) {
      case "related":
        put(i, j, EDGE_W.related, "related");
        put(j, i, EDGE_W.related, "related");
        break;
      case "fact":
        put(i, j, EDGE_W.fact, l.rel ? `fact:${l.rel}` : "fact");
        put(j, i, EDGE_W.fact, l.rel ? `fact:${l.rel}` : "fact");
        break;
      case "supersedes":
        put(i, j, EDGE_W.supersedes, "supersedes");
        put(j, i, EDGE_W.supersedes, "supersedes");
        break;
      default: // wikilink
        put(i, j, EDGE_W.wikilink, "wikilink");
        put(j, i, EDGE_W.backlink, "backlink");
    }
  }

  // Day contiguity — computed from the ids, so it needs no rows of its own and
  // can never go stale. Only consecutive calendar days are joined: a gap means
  // a day with no page, and bridging it would invent a "next" that wasn't.
  const days = [];
  for (let i = 0; i < n; i++) {
    const span = type[i] === "day" || DAY_ID_RE.test(ids[i]) ? pageDateSpan(ids[i]) : null;
    if (span && span[0] === span[1]) days.push([span[0], i]);
  }
  days.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let k = 1; k < days.length; k++) {
    const [prevDate, pi] = days[k - 1];
    const [curDate, ci] = days[k];
    if (addDays(prevDate, 1) !== curDate) continue;
    put(pi, ci, EDGE_W.next_day, "next_day");
    put(ci, pi, EDGE_W.prev_day, "prev_day");
  }

  // Hebbian: amplify an existing edge, or add a weak one where none exists.
  for (const h of hebbian) {
    const i = idx.get(h.a);
    const j = idx.get(h.b);
    if (i === undefined || j === undefined || i === j) continue;
    const hw = Math.min(1, Math.max(0, Number(h.w) || 0));
    if (!hw) continue;
    for (const [x, y] of [[i, j], [j, i]]) {
      const cur = em[x].get(y);
      if (cur) cur.w = cur.w * (1 + HEBB_GAMMA * hw);
      else if (hw >= HEBB_MIN_EDGE) em[x].set(y, { w: EDGE_W.hebbian * hw, kind: "hebbian" });
    }
  }

  const adj = em.map((m) => [...m].map(([j, v]) => ({ j, w: v.w, kind: v.kind })));
  // Fan = distinct neighbours (either direction) + 1 for the node itself, as in
  // the ACT-R tutorial. Distinct, not edge rows: page_links carries one row per
  // section a link appears in, and a page mentioned in five sections of one day
  // is still one association.
  const fan = new Float64Array(n);
  const neigh = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i++) for (const e of adj[i]) { neigh[i].add(e.j); neigh[e.j].add(i); }
  for (let i = 0; i < n; i++) fan[i] = neigh[i].size + 1;
  const lnN = Math.log(Math.max(n, 2));
  // Specificity, normalized to 0..1: ln(N/fan)/ln(N), clipped at 0. This is the
  // IDF of a node — S_ji = S − ln(fan_j) with S = ln N, scaled — and it is what
  // replaces the old in-degree cutoff (see the module header).
  const spec = new Float64Array(n);
  for (let i = 0; i < n; i++) spec[i] = Math.max(0, Math.log(Math.max(n, 2) / fan[i]) / lnN);
  return { n, ids, idx, type, adj, fan, spec, lnN };
}

// Which page_facts rows are CURRENT — the one definition every reader shares
// (the graph here, the KNN matrix in wiki-embed.mjs, wiki_read, the CLI). A fact
// stops being current when it expires (its source page no longer says it, or a
// newer fact for a one-valued relation replaced it — system time) or when the
// page itself said it ended (`invalid_at`, event time). Neither deletes it:
// "where did they work in 2024" still has its answer. Table alias must be `f`.
export const CURRENT_FACT_SQL =
  "f.expired_at IS NULL AND (f.invalid_at IS NULL OR f.invalid_at >= date('now'))";

// Read the graph out of memory-index.db. Every optional table is optional:
// a fresh DB with only `pages` + `page_links` yields a link-only graph.
export function loadAssocGraphRows(d, { now = Date.now() } = {}) {
  const nodes = d.prepare("SELECT id, type FROM pages WHERE status = 'active'").all();
  const links = d
    .prepare("SELECT DISTINCT src_id AS src, dst_id AS dst, link_type AS kind FROM page_links")
    .all();
  try {
    for (const f of d
      .prepare(
        `SELECT f.src_id AS src, f.dst_id AS dst, f.rel FROM page_facts f
          WHERE f.dst_id IS NOT NULL AND ${CURRENT_FACT_SQL}`,
      )
      .all()) {
      links.push({ src: f.src, dst: f.dst, kind: "fact", rel: f.rel });
    }
  } catch {}
  let hebbian = [];
  try {
    hebbian = d
      .prepare("SELECT a, b, w, last_ts FROM page_coactivation")
      .all()
      .map((r) => ({ a: r.a, b: r.b, w: decayedHebbian(r.w, r.last_ts, now) }));
  } catch {}
  return { nodes, links, hebbian };
}

// Hebbian weights decay per day since they were last reinforced. Kept here (not
// in wiki-hebbian.mjs) so the reader and the writer cannot disagree: the writer
// imports this.
export const HEBB_DAILY_DECAY = Number(process.env.WIKI_HEBB_DECAY || 0.985);
export function decayedHebbian(w, lastTs, now = Date.now()) {
  const t = Date.parse(lastTs || "");
  const days = Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 0;
  return (Number(w) || 0) * Math.pow(HEBB_DAILY_DECAY, days);
}

const _graphCache = new Map();
// Cached per corpus version, like the vector index: a long-lived MCP process
// loads the graph once (~1k nodes, ~10-20k edges, a few ms) and reuses it.
export function cachedAssocGraph(d, name, version) {
  const hit = _graphCache.get(name);
  if (hit && hit.version === version) return hit.graph;
  const graph = buildAssocGraph(loadAssocGraphRows(d));
  _graphCache.set(name, { version, graph });
  return graph;
}
export function clearAssocGraphCache(name = null) {
  if (name == null) _graphCache.clear();
  else _graphCache.delete(name);
}

// A cheap version token for the graph's inputs. data_version moves when another
// connection commits (the nightly writers are separate processes); the counts
// and max rowids cover same-handle writes and re-inserts.
export function assocGraphVersion(d) {
  const q = (sql) => {
    try {
      const r = d.prepare(sql).get();
      return `${r.n}.${r.mx}`;
    } catch {
      return "x";
    }
  };
  let dv = 0;
  try {
    dv = d.prepare("PRAGMA data_version").get().data_version;
  } catch {}
  return [
    dv,
    q("SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) AS mx FROM pages WHERE status='active'"),
    q("SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) AS mx FROM page_links"),
    q("SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) || '.' || COALESCE(SUM(expired_at IS NOT NULL),0) AS mx FROM page_facts"),
    q("SELECT COUNT(*) AS n, COALESCE(MAX(rowid),0) AS mx FROM page_coactivation"),
  ].join(":");
}

// ── Soft query gate ────────────────────────────────────────────────────────

// g(cos) = σ(κ·(cos − c0)). Scales activation by how much the reached page
// resembles the query; never zeroes it. c0 sits in the middle of the band where
// nomic-embed-text puts loosely related text (~0.5), so a day narrative at 0.46
// keeps ~40% of its activation where the old 0.62 floor kept none of it.
export const GATE_C0 = Number(process.env.WIKI_ASSOC_GATE_C0 || 0.5);
export const GATE_K = Number(process.env.WIKI_ASSOC_GATE_K || 12);
// A page with no vector at all (not embedded yet) is neither boosted nor
// buried: it gets the gate value of a page sitting right at c0.
export function softGate(cos, { c0 = GATE_C0, k = GATE_K } = {}) {
  if (cos == null || !Number.isFinite(cos)) return 0.5;
  return 1 / (1 + Math.exp(-k * (cos - c0)));
}

// ── Spreading activation ───────────────────────────────────────────────────

// seeds: Map<id, weight> (weights need not sum to 1; they are normalized).
// gate:  (id) => 0..1, the soft query gate (default: none).
// Returns [{ id, activation, from, via, hops }] best-first, where `activation`
// is the activation the node RECEIVED (a seed's own starting mass is not
// counted — a seed appears only if other seeds also reach it, which is the
// convergence signal), `from` the seed its strongest contribution traces back
// to, and `via` the kind of the last edge on that path.
export function spreadActivation(
  graph,
  seeds,
  { steps = 2, retention = 0.5, inhibitTop = 40, limit = 20, gate = null, minShare = 0.02, exclude = null } = {},
) {
  if (!graph || !graph.n || !seeds || !seeds.size) return [];
  const { n, adj, spec, ids, idx } = graph;
  let total = 0;
  for (const w of seeds.values()) total += Math.max(0, w);
  if (total <= 0) return [];

  const gateOf = new Float64Array(n).fill(1);
  if (typeof gate === "function") for (let i = 0; i < n; i++) gateOf[i] = gate(ids[i]);

  // Current activation of the frontier, and the running total each node has
  // received over all steps.
  let act = new Map();
  const origin = new Int32Array(n).fill(-1);
  for (const [id, w] of seeds) {
    const i = idx.get(id);
    if (i === undefined || !(w > 0)) continue;
    act.set(i, w / total);
    origin[i] = i;
  }
  const isSeed = new Uint8Array(n);
  for (const i of act.keys()) isSeed[i] = 1;
  const from = new Int32Array(n).fill(-1); // provenance: which seed's activation won
  const received = new Float64Array(n);
  const best = new Float64Array(n); // strongest single contribution, for provenance
  const via = new Array(n).fill(null);
  const hops = new Int32Array(n);

  for (let step = 1; step <= steps; step++) {
    const next = new Map();
    for (const [j, aj] of act) {
      const sj = spec[j];
      if (!(aj > 0) || !(sj > 0)) continue;
      const oj = origin[j] >= 0 ? origin[j] : j;
      for (const e of adj[j]) {
        const i = e.j;
        // No echoes: activation that left a seed must not come straight back
        // to it and be counted as "another cue also points here".
        if (i === oj) continue;
        // Fan-normalized on both ends: a hub neither sends nor collects much.
        const c = aj * e.w * sj * spec[i] * gateOf[i];
        if (!(c > 0)) continue;
        next.set(i, (next.get(i) || 0) + c);
        received[i] += c;
        if (c > best[i]) {
          best[i] = c;
          via[i] = e.kind;
          from[i] = oj;
          hops[i] = step;
          // A seed's own trace stays itself — it is what the echo check keys on.
          if (!isSeed[i]) origin[i] = oj;
        }
      }
    }
    // Lateral inhibition: only the strongest `inhibitTop` nodes keep spreading.
    // This is what stops step 2 from fanning out across the whole graph.
    const ranked = [...next].sort((a, b) => b[1] - a[1]).slice(0, inhibitTop);
    act = new Map(ranked.map(([i, a]) => [i, a * retention]));
    if (!act.size) break;
  }

  return finish(graph, received, from, via, hops, { limit, minShare, exclude });
}

// ── Personalized PageRank ──────────────────────────────────────────────────

// Same inputs and output shape as spreadActivation. α is the restart
// probability (HippoRAG uses 0.5). Transition j → i ∝ w_ji · spec_i · gate_i,
// so a hub is an unattractive place to walk to; and the final score is divided
// by fan^β because a random walk's stationary mass still pools in high-degree
// nodes (with uniform restart on an undirected graph it is proportional to
// degree). Seeds are not ranked (see below), for the same reason
// spreadActivation does not count a seed's own starting mass.
export function personalizedPageRank(
  graph,
  seeds,
  { alpha = 0.5, iterations = 20, beta = 0.5, limit = 20, gate = null, minShare = 0.02, exclude = null } = {},
) {
  if (!graph || !graph.n || !seeds || !seeds.size) return [];
  const { n, adj, spec, ids, idx, fan } = graph;
  const p = new Float64Array(n);
  let total = 0;
  for (const [id, w] of seeds) {
    const i = idx.get(id);
    if (i === undefined || !(w > 0)) continue;
    p[i] += w;
    total += w;
  }
  if (total <= 0) return [];
  for (let i = 0; i < n; i++) p[i] /= total;

  const gateOf = new Float64Array(n).fill(1);
  if (typeof gate === "function") for (let i = 0; i < n; i++) gateOf[i] = gate(ids[i]);
  // Row-normalized transition weights, computed once.
  const tw = adj.map((edges) => {
    const ws = edges.map((e) => e.w * spec[e.j] * gateOf[e.j]);
    const s = ws.reduce((a, b) => a + b, 0);
    return s > 0 ? ws.map((w) => w / s) : null;
  });

  let x = Float64Array.from(p);
  for (let it = 0; it < iterations; it++) {
    const y = new Float64Array(n);
    let dangling = 0;
    for (let j = 0; j < n; j++) {
      const xj = x[j];
      if (!xj) continue;
      const row = tw[j];
      if (!row) { dangling += xj; continue; }
      const edges = adj[j];
      for (let k = 0; k < edges.length; k++) y[edges[k].j] += (1 - alpha) * xj * row[k];
    }
    // Restart + dangling mass both return to the seeds.
    for (let i = 0; i < n; i++) y[i] += (alpha + (1 - alpha) * dangling) * p[i];
    x = y;
  }

  // Seeds are left out of PPR's list altogether. A walk always wanders back to
  // where it restarts, so a seed's surplus over its restart mass is mostly its
  // own echo, and unlike spreading activation there is no clean way to split
  // that from "another seed also points here". The seeds are already in the
  // direct lists, which is where they belong.
  const received = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (p[i] > 0) continue;
    const r = x[i];
    received[i] = r > 0 ? r / Math.pow(fan[i], beta) : 0;
  }
  // Provenance for PPR: the seed among this node's neighbours (or two hops
  // out) contributing the most. Computed cheaply from the seed set only.
  const origin = new Int32Array(n).fill(-1);
  const via = new Array(n).fill(null);
  const hops = new Int32Array(n);
  const seedIdx = [...seeds.keys()].map((id) => idx.get(id)).filter((i) => i !== undefined);
  const bestC = new Float64Array(n);
  for (const s of seedIdx) {
    for (const e of adj[s]) {
      const c = p[s] * e.w;
      if (c > bestC[e.j]) { bestC[e.j] = c; origin[e.j] = s; via[e.j] = e.kind; hops[e.j] = 1; }
    }
  }
  for (let i = 0; i < n; i++) {
    if (origin[i] >= 0 || !(received[i] > 0)) continue;
    // Two hops: attribute through the strongest already-attributed neighbour.
    let bi = -1, bw = 0;
    for (const e of adj[i]) if (origin[e.j] >= 0 && hops[e.j] === 1 && e.w > bw) { bw = e.w; bi = e.j; }
    if (bi >= 0) { origin[i] = origin[bi]; via[i] = via[bi]; hops[i] = 2; }
  }
  return finish(graph, received, origin, via, hops, { limit, minShare, exclude });
}

function finish(graph, received, origin, via, hops, { limit, minShare, exclude }) {
  const { n, ids } = graph;
  let max = 0;
  for (let i = 0; i < n; i++) if (received[i] > max) max = received[i];
  if (!(max > 0)) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!(received[i] > 0) || received[i] < max * minShare) continue;
    if (exclude && exclude(ids[i])) continue;
    out.push({
      id: ids[i],
      activation: received[i],
      from: origin[i] >= 0 && origin[i] !== i ? ids[origin[i]] : null,
      via: via[i],
      hops: hops[i],
    });
  }
  out.sort((a, b) => b.activation - a.activation);
  return out.slice(0, limit);
}

// Dispatch by method name — what the env flag and the MCP tool pass through.
export function associate(graph, seeds, { method = "sa", ...opts } = {}) {
  if (method === "ppr") return personalizedPageRank(graph, seeds, opts);
  return spreadActivation(graph, seeds, opts);
}
