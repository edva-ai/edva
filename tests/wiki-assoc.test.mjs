// wiki-assoc.test.mjs — the pure graph half of associative recall
// (lib/wiki-assoc.mjs). No SQLite, no embedder: graphs are built from
// plain arrays, so each test states the exact shape it is about.
// Run: node --test tests/wiki-assoc.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const A = await import(path.resolve("lib/wiki-assoc.mjs"));
const {
  buildAssocGraph, spreadActivation, personalizedPageRank, associate,
  pageDateSpan, inDateWindow, softGate, decayedHebbian, EDGE_W,
} = A;

// A small personal corpus with the two properties that broke the old
// expansion: a hub everything links to, and people reached only BACKWARDS
// (day pages link to them, they link to nothing).
function corpus({ extraLinks = [], hebbian = [], fillers = 40 } = {}) {
  const nodes = [
    { id: "travel", type: "reference" },
    { id: "user_biscuit", type: "user" },
    { id: "user_victor", type: "user" },
    { id: "restaurant_corner_cafe", type: "reference" },
    { id: "day_2026-08-01", type: "day" },
    { id: "day_2026-08-02", type: "day" },
    { id: "day_2026-08-03", type: "day" },
    { id: "day_2026-08-05", type: "day" },
  ];
  const links = [
    { src: "day_2026-08-02", dst: "user_biscuit", kind: "wikilink" },
    { src: "day_2026-08-02", dst: "restaurant_corner_cafe", kind: "wikilink" },
    { src: "day_2026-08-05", dst: "user_biscuit", kind: "wikilink" },
    { src: "day_2026-08-03", dst: "user_victor", kind: "wikilink" },
    ...extraLinks,
  ];
  // Filler pages, all linking to the hub, so its fan dwarfs everything else.
  for (let i = 0; i < fillers; i++) {
    nodes.push({ id: `filler_${i}`, type: "reference" });
    links.push({ src: `filler_${i}`, dst: "travel", kind: "wikilink" });
  }
  for (const d of ["day_2026-08-01", "day_2026-08-02", "day_2026-08-03", "day_2026-08-05"]) {
    links.push({ src: d, dst: "travel", kind: "wikilink" });
  }
  return buildAssocGraph({ nodes, links, hebbian });
}

test("backlinks are walked: a person seeds the days that mention them", () => {
  const g = corpus();
  const out = spreadActivation(g, new Map([["user_biscuit", 1]]));
  const ids = out.map((r) => r.id);
  assert.ok(ids.includes("day_2026-08-02"), "day linking to Biscuit is reached");
  assert.ok(ids.includes("day_2026-08-05"), "the other day linking to Biscuit is reached");
  const r = out.find((x) => x.id === "day_2026-08-02");
  assert.equal(r.via, "backlink");
  assert.equal(r.from, "user_biscuit");
});

test("a hub carries ~nothing: fan normalization replaces the hard cutoff", () => {
  const g = corpus();
  const hub = g.idx.get("travel");
  assert.ok(g.spec[hub] < 0.05, `hub specificity is near zero (got ${g.spec[hub]})`);
  const out = spreadActivation(g, new Map([["day_2026-08-02", 1]]), { minShare: 0 });
  const travel = out.find((r) => r.id === "travel");
  const biscuit = out.find((r) => r.id === "user_biscuit");
  assert.ok(biscuit, "the specific neighbour is reached");
  assert.ok(!travel || travel.activation < biscuit.activation * 0.2, "the hub is drowned out, not admitted");
  // No step function: the hub still has a defined, tiny, non-negative weight.
  assert.ok(g.spec[hub] >= 0);
});

test("two-hop: Biscuit's day reaches the restaurant eaten at that day", () => {
  const g = corpus();
  const out = spreadActivation(g, new Map([["user_biscuit", 1]]), { steps: 2 });
  const w = out.find((r) => r.id === "restaurant_corner_cafe");
  assert.ok(w, "the restaurant two hops away is reached");
  assert.equal(w.hops, 2);
  assert.equal(w.from, "user_biscuit");
});

test("convergence: a page tied to BOTH cues outranks one tied to a single cue", () => {
  // day_08-02 links Biscuit AND the cafe; day_08-05 links only Biscuit.
  const g = corpus();
  const out = spreadActivation(g, new Map([["user_biscuit", 1], ["restaurant_corner_cafe", 1]]), { steps: 1 });
  const both = out.find((r) => r.id === "day_2026-08-02");
  const one = out.find((r) => r.id === "day_2026-08-05");
  assert.ok(both && one);
  assert.ok(both.activation > one.activation * 1.5, "pattern completion favours the intersection");
});

test("a seed's own mass is not counted, and activation does not echo back to it", () => {
  const g = corpus();
  const out = spreadActivation(g, new Map([["user_biscuit", 1]]), { steps: 2 });
  assert.ok(!out.some((r) => r.id === "user_biscuit"), "a lone seed never ranks itself");
});

test("day contiguity: consecutive days are joined, forward stronger, gaps not bridged", () => {
  const g = corpus();
  const i1 = g.idx.get("day_2026-08-01");
  const i2 = g.idx.get("day_2026-08-02");
  const i3 = g.idx.get("day_2026-08-03");
  const i5 = g.idx.get("day_2026-08-05");
  const edge = (a, b) => g.adj[a].find((e) => e.j === b);
  assert.equal(edge(i1, i2).kind, "next_day");
  assert.equal(edge(i2, i1).kind, "prev_day");
  assert.ok(edge(i1, i2).w > edge(i2, i1).w, "forward contiguity is stronger (lag-CRP)");
  assert.equal(edge(i3, i5), undefined, "08-03 → 08-05 skips a missing day: no edge");
});

test("the soft gate scales activation down without zeroing it", () => {
  const g = corpus();
  const cos = { "day_2026-08-02": 0.46, "day_2026-08-05": 0.62 };
  const gate = (id) => softGate(cos[id] ?? 0.5);
  const out = spreadActivation(g, new Map([["user_biscuit", 1]]), { gate, steps: 1 });
  const lo = out.find((r) => r.id === "day_2026-08-02");
  const hi = out.find((r) => r.id === "day_2026-08-05");
  assert.ok(lo, "a day at cosine 0.46 — below the old 0.62 floor — is still reached");
  assert.ok(hi.activation > lo.activation, "but the closer page wins");
  assert.ok(softGate(0.46) > 0.3 && softGate(0.46) < 0.5);
  assert.equal(softGate(null), 0.5, "an unembedded page is neutral, not buried");
});

test("Hebbian weight amplifies an existing edge and adds a weak one where none exists", () => {
  const plain = corpus();
  const heb = corpus({ hebbian: [
    { a: "user_biscuit", b: "day_2026-08-02", w: 1 },
    { a: "user_biscuit", b: "user_victor", w: 0.8 },
  ] });
  const e = (g, a, b) => g.adj[g.idx.get(a)].find((x) => x.j === g.idx.get(b));
  assert.ok(e(heb, "user_biscuit", "day_2026-08-02").w > e(plain, "user_biscuit", "day_2026-08-02").w);
  assert.equal(e(plain, "user_biscuit", "user_victor"), undefined);
  assert.equal(e(heb, "user_biscuit", "user_victor").kind, "hebbian");
  assert.ok(e(heb, "user_biscuit", "user_victor").w <= EDGE_W.hebbian);
});

test("fact edges join both ends and name their relation", () => {
  const g = corpus({ extraLinks: [{ src: "user_biscuit", dst: "user_victor", kind: "fact", rel: "friend_of" }] });
  const out = spreadActivation(g, new Map([["user_victor", 1]]), { steps: 1 });
  const biscuit = out.find((r) => r.id === "user_biscuit");
  assert.ok(biscuit);
  assert.equal(biscuit.via, "fact:friend_of");
});

test("PPR reaches the same neighbourhood and does not pool in the hub", () => {
  const g = corpus();
  const out = personalizedPageRank(g, new Map([["user_biscuit", 1]]), { minShare: 0 });
  const ids = out.map((r) => r.id);
  assert.ok(ids.includes("day_2026-08-02"));
  assert.ok(ids.includes("day_2026-08-05"));
  const travel = out.find((r) => r.id === "travel");
  const day = out.find((r) => r.id === "day_2026-08-02");
  assert.ok(!travel || travel.activation < day.activation, "fan-corrected: the hub does not win");
  assert.ok(!ids.includes("user_biscuit") || out.find((r) => r.id === "user_biscuit").activation < day.activation);
});

test("associate() dispatches by method, and exclude/limit are honoured", () => {
  const g = corpus();
  const seeds = new Map([["user_biscuit", 1]]);
  const sa = associate(g, seeds, { method: "sa", limit: 2 });
  const ppr = associate(g, seeds, { method: "ppr", limit: 2 });
  assert.ok(sa.length <= 2 && ppr.length <= 2);
  const noDays = associate(g, seeds, { exclude: (id) => id.startsWith("day_") });
  assert.ok(!noDays.some((r) => r.id.startsWith("day_")));
});

test("empty and unknown seeds are a no-op, not a throw", () => {
  const g = corpus();
  assert.deepEqual(spreadActivation(g, new Map()), []);
  assert.deepEqual(spreadActivation(g, new Map([["no_such_page", 1]])), []);
  assert.deepEqual(personalizedPageRank(g, new Map([["no_such_page", 1]])), []);
  assert.deepEqual(spreadActivation(buildAssocGraph({}), new Map([["x", 1]])), []);
});

test("episodic date spans come from the id shape", () => {
  assert.deepEqual(pageDateSpan("day_2026-08-02"), ["2026-08-02", "2026-08-02"]);
  assert.deepEqual(pageDateSpan("week_2026-08-03"), ["2026-08-03", "2026-08-09"]);
  assert.deepEqual(pageDateSpan("month_2026-02"), ["2026-02-01", "2026-02-28"]);
  assert.equal(pageDateSpan("user_biscuit"), null);
});

test("date window scopes episodic pages by overlap and never filters curated ones", () => {
  assert.equal(inDateWindow("day_2026-08-02", "2026-08-01", "2026-08-03"), true);
  assert.equal(inDateWindow("day_2026-07-30", "2026-08-01", null), false);
  assert.equal(inDateWindow("week_2026-07-27", "2026-08-01", "2026-08-31"), true, "the week overlaps Aug 1-2");
  assert.equal(inDateWindow("month_2026-07", "2026-08-01", null), false);
  assert.equal(inDateWindow("user_biscuit", "2030-01-01", "2030-01-02"), true);
  assert.equal(inDateWindow("day_2026-08-02"), true, "no window, no filter");
});

test("Hebbian decay halves over its half-life and never goes negative", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const w0 = decayedHebbian(1, "2026-10-24T00:00:00Z", now);
  const w46 = decayedHebbian(1, "2026-09-08T00:00:00Z", now);
  assert.equal(w0, 1);
  assert.ok(w46 > 0.45 && w46 < 0.55, `~half after 46 days at 0.985/day (got ${w46})`);
  assert.equal(decayedHebbian(0.5, "garbage", now), 0.5, "an unparseable stamp is not decayed");
});
