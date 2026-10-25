// wiki-dedup.test.mjs — the full-corpus wiki duplicate sweep.
//
// Isolation: MEMORY_INDEX_DB is pointed at a tmp DB BEFORE importing the module
// (the landed event-fts/hybrid-recall pattern — the module resolves its path at
// import time). No Ollama, no `claude -p`: embeddings are hand-written vectors
// and the judge is an injected runner, so this suite asserts the pipeline and
// the fail-soft contract, never model output.

import { test, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TMP_DB = path.join(os.tmpdir(), `wiki-dedup-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;

const dedup = await import("../../lib/wiki-dedup.mjs");
const { packF32 } = await import("../../lib/hybrid-recall.mjs");

// Three orthogonal "topics" in a tiny vector space, so similarity is exact and
// readable rather than an artifact of a real embedder.
const V = {
  cooking:     [1, 0, 0, 0],
  cookingIsh:  [0.97, 0.24, 0, 0],     // ~0.97 cosine with cooking
  travel:      [0, 1, 0, 0],
  travelIsh:   [0.05, 0.998, 0, 0],
  finance:     [0, 0, 1, 0],
};

// Candidate generation needs BOTH signals, so fixtures need real vocabulary —
// a page body of "body text" shares no distinctive tokens with anything and is
// correctly filtered out. These bodies give each topic its own rare words.
const B = {
  sourdough1: "Alex keeps a sourdough levain at seventy percent hydration and bakes in a preheated dutchoven.",
  sourdough2: "The levain hydration for sourdough sits around seventy percent; bake covered in the dutchoven.",
  bikeTune1:  "Robin tunes the bicycle derailleur every fortnight and waxes the chain with ceramicwax.",
  bikeTune2:  "Every fortnight the bicycle derailleur gets tuned by Robin; the chain is waxed with ceramicwax.",
  stargazing: "Observatory logbook entry records nightly telescope seeing conditions and planetary transits.",
  unrelated:  "Notes about printer firmware upgrades and the xerox toner replacement schedule.",
};

function seed(pages) {
  const db = new DatabaseSync(TMP_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY, basename TEXT, type TEXT, title TEXT, description TEXT,
      status TEXT NOT NULL DEFAULT 'active', pinned INTEGER DEFAULT 0, pin_locked INTEGER DEFAULT 0,
      raw_md TEXT DEFAULT '', body_md TEXT DEFAULT '', frontmatter_json TEXT DEFAULT '{}',
      body_hash TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS page_embeddings (
      page_id TEXT PRIMARY KEY, model TEXT, dim INTEGER, body_hash TEXT, embedding BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS supersession (
      new_basename TEXT NOT NULL, old_basename TEXT NOT NULL, PRIMARY KEY (new_basename, old_basename));
  `);
  for (const p of pages) {
    db.prepare(`INSERT INTO pages (id, basename, type, title, description, status, pinned, pin_locked, body_md, body_hash, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.id, p.type ?? "reference", p.title ?? p.id, p.description ?? "",
           p.status ?? "active", p.pinned ?? 0, p.pin_locked ?? 0,
           p.body ?? "body text", p.hash ?? `h-${p.id}`, p.updated_at ?? "2026-07-01T00:00:00Z");
    if (p.vec) {
      db.prepare(`INSERT INTO page_embeddings (page_id, model, dim, body_hash, embedding) VALUES (?,?,?,?,?)`)
        .run(p.id, "test", p.vec.length, p.embHash ?? p.hash ?? `h-${p.id}`, packF32(p.vec));
    }
  }
  db.close();
}

function cleanup() {
  dedup._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

// The rare-token ceiling is a FRACTION of the corpus, so a 4-page fixture makes
// every token look rare and a 3-page cluster look like boilerplate. Tests that
// exercise the lexical gate need a realistic corpus size; these fillers supply
// it. Each has a unique vocabulary (so it pairs with nothing) but an identical
// vector (so it can't be passing on cosine grounds either).
function fillerPages(n, { vec = [0, 0, 0, 1] } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `filler_${i}`,
    vec,
    body: `Filler page about topic${i} with subject${i} and detail${i} recorded once.`,
  }));
}

// The pathology this whole gate exists for: a family of `travel_city_*` pages that
// are one boilerplate paragraph with a city name swapped in. Identical
// embeddings, zero shared distinctive vocabulary, not duplicates.
function travelCityStubs(cities) {
  return cities.map((city) => ({
    id: `travel_city_freedonia_${city.toLowerCase()}`,
    title: `${city}, Freedonia`,
    vec: [1, 0, 0, 0],
    body: `This is the city directory page for ${city}, Freedonia. Use travelplaces for the country roster and travel for the index of every destination recorded so far.`,
  }));
}

describe("wiki-dedup candidate generation", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("pairs only pages above the similarity floor", () => {
    seed([
      { id: "a_cooking", vec: V.cooking, body: B.sourdough1 },
      { id: "b_cooking", vec: V.cookingIsh, body: B.sourdough2 },
      { id: "c_travel", vec: V.travel, body: B.bikeTune1 },
      { id: "d_finance", vec: V.finance, body: B.stargazing },
    ]);
    const pages = dedup.loadPages();
    assert.equal(pages.length, 4);
    const pairs = dedup.findCandidatePairs(pages, { threshold: 0.9 });
    assert.equal(pairs.length, 1, "only the two cooking pages are close enough");
    assert.equal(pairs[0].key, dedup.pairKey("a_cooking", "b_cooking"));
  });

  it("excludes episodic day/week/month pages entirely", () => {
    seed([
      { id: "day_2026-07-01", type: "day", vec: V.cooking, body: B.sourdough1 },
      { id: "day_2026-07-02", type: "day", vec: V.cookingIsh, body: B.sourdough2 },
      { id: "week_2026-06-29", type: "week", vec: V.cooking, body: B.sourdough1 },
      { id: "month_2026-07", type: "month", vec: V.cooking, body: B.sourdough1 },
      { id: "ref_one", type: "reference", vec: V.travel, body: B.bikeTune1 },
    ]);
    const pages = dedup.loadPages();
    assert.deepEqual(pages.map((p) => p.id), ["ref_one"],
      "consecutive days look alike to an embedder and are never duplicates of each other");
  });

  it("skips a page whose embedding is stale relative to its body", () => {
    seed([
      { id: "fresh", vec: V.cooking, hash: "h1", body: B.sourdough1 },
      { id: "edited", vec: V.cookingIsh, hash: "h2", embHash: "h-old", body: B.sourdough2 },
    ]);
    const pages = dedup.loadPages();
    assert.deepEqual(pages.map((p) => p.id), ["fresh"],
      "comparing against a vector for an older body would be worse than waiting a month");
  });

  it("ignores inactive pages", () => {
    seed([
      { id: "live", vec: V.cooking, body: B.sourdough1 },
      { id: "gone", vec: V.cookingIsh, status: "superseded", body: B.sourdough2 },
    ]);
    assert.deepEqual(dedup.loadPages().map((p) => p.id), ["live"]);
  });

  it("does not re-propose a pair already recorded as a supersession", () => {
    seed([
      { id: "a_cooking", vec: V.cooking, body: B.sourdough1 },
      { id: "b_cooking", vec: V.cookingIsh, body: B.sourdough2 },
    ]);
    const db = new DatabaseSync(TMP_DB);
    db.prepare(`INSERT INTO supersession (new_basename, old_basename) VALUES (?,?)`).run("a_cooking", "b_cooking");
    db.close();
    const pages = dedup.loadPages();
    const pairs = dedup.findCandidatePairs(pages, { threshold: 0.9, skip: dedup.loadResolvedPairs() });
    assert.equal(pairs.length, 0, "that relationship is already resolved");
  });
});

describe("wiki-dedup clustering", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("unions transitively so a trio is judged once, not three times", () => {
    seed([
      { id: "a", vec: [1, 0, 0, 0], body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], body: B.sourdough2 },
      { id: "c", vec: [0.98, 0.2, 0, 0], body: `${B.sourdough1} Levain hydration notes.` },
      { id: "z", vec: V.finance, body: B.stargazing },
      ...fillerPages(80),
    ]);
    const pairs = dedup.findCandidatePairs(dedup.loadPages(), { threshold: 0.9 });
    const clusters = dedup.clusterPairs(pairs);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].members.map((m) => m.id).sort(), ["a", "b", "c"]);
  });
});

describe("wiki-dedup lexical-distinctiveness gate", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("a template family with identical embeddings produces no pairs", () => {
    seed([...travelCityStubs(["Alderton", "Brookfield", "Cedarville", "Dunmore", "Easton", "Fairhaven",
                              "Glenwood", "Hillcrest", "Ironwood", "Juniper", "Kingsley", "Linden"]),
          ...fillerPages(80)]);
    const pages = dedup.loadPages();
    const pairs = dedup.findCandidatePairs(pages, { threshold: 0.9 });
    assert.equal(pairs.length, 0,
      "Alderton and Brookfield embed identically but share only boilerplate — they are different cities, not duplicates");
  });

  it("a genuine duplicate still survives inside that same noisy corpus", () => {
    seed([
      ...travelCityStubs(["Alderton", "Brookfield", "Cedarville", "Dunmore", "Easton", "Fairhaven",
                          "Glenwood", "Hillcrest", "Ironwood", "Juniper", "Kingsley", "Linden"]),
      ...fillerPages(80),
      { id: "user_bike_tuning", vec: [0, 1, 0, 0], body: B.bikeTune1 },
      { id: "user_bike_tune_schedule", vec: [0.05, 0.998, 0, 0], body: B.bikeTune2 },
    ]);
    const pairs = dedup.findCandidatePairs(dedup.loadPages(), { threshold: 0.9 });
    assert.equal(pairs.length, 1, "the gate must not be so strict it kills the real signal");
    assert.equal(pairs[0].key, dedup.pairKey("user_bike_tuning", "user_bike_tune_schedule"));
    assert.ok(pairs[0].lex > 0.18);
  });

  it("high rare-token overlap alone is not enough — the pages must also embed close", () => {
    seed([
      { id: "p1", vec: [1, 0, 0, 0], body: B.bikeTune1 },
      { id: "p2", vec: [0, 0, 1, 0], body: B.bikeTune2 },   // same words, orthogonal vectors
      ...fillerPages(80),
    ]);
    assert.equal(dedup.findCandidatePairs(dedup.loadPages(), { threshold: 0.9 }).length, 0);
  });
});

describe("wiki-dedup verdict parsing", () => {
  it("reads a bare JSON object", () => {
    const v = dedup.parseVerdict('{"verdict":"duplicate","keep_id":"a","supersede_ids":["b"],"rationale":"same fact"}');
    assert.equal(v.verdict, "duplicate");
    assert.deepEqual(v.supersede_ids, ["b"]);
  });

  it("reads a fenced object with surrounding chatter", () => {
    const v = dedup.parseVerdict('Sure!\n```json\n{"verdict":"overlap","keep_id":"a","supersede_ids":[],"rationale":"partial"}\n```\n');
    assert.equal(v.verdict, "overlap");
  });

  it("returns null on garbage or an unknown verdict, rather than inventing one", () => {
    assert.equal(dedup.parseVerdict("no idea"), null);
    assert.equal(dedup.parseVerdict('{"verdict":"merge-them","keep_id":null}'), null);
    assert.equal(dedup.parseVerdict(""), null);
  });
});

describe("wiki-dedup judging is fail-soft", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  function twoClusters() {
    seed([
      { id: "a", vec: [1, 0, 0, 0], body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], body: B.sourdough2 },
      { id: "c", vec: [0, 1, 0, 0], body: B.bikeTune1 },
      { id: "d", vec: [0.05, 0.998, 0, 0], body: B.bikeTune2 },
    ]);
    return dedup.clusterPairs(dedup.findCandidatePairs(dedup.loadPages(), { threshold: 0.9 }));
  }

  it("a judge that throws degrades that cluster to distinct, and the others still run", async () => {
    let n = 0;
    const runner = async () => {
      if (n++ === 0) throw new Error("claude -p died");
      return '{"verdict":"duplicate","keep_id":"c","supersede_ids":["d"],"rationale":"same"}';
    };
    const judged = await dedup.judgeClusters(twoClusters(), { runner, concurrency: 1 });
    assert.equal(judged.length, 2);
    assert.equal(judged[0].verdict.verdict, "distinct", "a failed judge proposes nothing");
    assert.ok(judged[0].verdict.failed);
    assert.equal(judged[1].verdict.verdict, "duplicate");
  });

  it("an unparseable reply becomes distinct, never a guessed merge", async () => {
    const judged = await dedup.judgeClusters(twoClusters(), { runner: async () => "I think they're similar?", concurrency: 2 });
    assert.ok(judged.every((c) => c.verdict.verdict === "distinct"));
  });
});

describe("wiki-dedup state suppression", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("a settled 'distinct' pair is not re-judged while both pages are unchanged", () => {
    seed([
      { id: "a", vec: [1, 0, 0, 0], hash: "ha", body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], hash: "hb", body: B.sourdough2 },
    ]);
    const pages = dedup.loadPages();
    const state = { judged: { [dedup.pairKey("a", "b")]: { verdict: "distinct", hash_a: "ha", hash_b: "hb" } } };
    assert.equal(dedup.suppressedPairs(state, pages).size, 1);
  });

  it("editing either page re-opens the pair", () => {
    seed([
      { id: "a", vec: [1, 0, 0, 0], hash: "ha-NEW", body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], hash: "hb", body: B.sourdough2 },
    ]);
    const state = { judged: { [dedup.pairKey("a", "b")]: { verdict: "distinct", hash_a: "ha", hash_b: "hb" } } };
    assert.equal(dedup.suppressedPairs(state, dedup.loadPages()).size, 0);
  });

  it("an actionable verdict keeps resurfacing until it is actually resolved", () => {
    seed([
      { id: "a", vec: [1, 0, 0, 0], hash: "ha", body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], hash: "hb", body: B.sourdough2 },
    ]);
    const state = { judged: { [dedup.pairKey("a", "b")]: { verdict: "duplicate", hash_a: "ha", hash_b: "hb" } } };
    assert.equal(dedup.suppressedPairs(state, dedup.loadPages()).size, 0,
      "ignoring a duplicate is not the same as deciding it isn't one");
  });

  it("records how many times a cluster has been reported", () => {
    const state = { last_run: "2026-08-01T00:00:00Z", judged: {}, reported: {} };
    const cluster = {
      id: "a+b",
      members: [{ id: "a", body_hash: "ha" }, { id: "b", body_hash: "hb" }],
      verdict: { verdict: "duplicate", keep_id: "a", supersede_ids: ["b"], rationale: "" },
    };
    dedup.recordVerdicts(state, [cluster]);
    assert.equal(state.reported["a+b"].times, 1);
    const c2 = { ...cluster, verdict: { ...cluster.verdict } };
    state.last_run = "2026-09-01T00:00:00Z";
    dedup.recordVerdicts(state, [c2]);
    assert.equal(state.reported["a+b"].times, 2);
    assert.equal(state.reported["a+b"].first_reported, "2026-08-01T00:00:00Z");
    assert.equal(c2.reportedBefore.times, 1, "the report can say 'still open since August'");
  });
});

describe("wiki-dedup sweep + report", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("caps clusters per run and reports the drop instead of hiding it", async () => {
    // Four separate 2-page clusters, cap of 2.
    seed([
      { id: "a1", vec: [1, 0, 0, 0], body: B.sourdough1 },   { id: "a2", vec: [0.99, 0.14, 0, 0], body: B.sourdough2 },
      { id: "b1", vec: [0, 1, 0, 0], body: B.bikeTune1 },    { id: "b2", vec: [0.05, 0.998, 0, 0], body: B.bikeTune2 },
      { id: "c1", vec: [0, 0, 1, 0], body: "Community garden compost turning and quarterly mulch delivery." },
      { id: "c2", vec: [0, 0.05, 0.998, 0], body: "Quarterly mulch delivery and compost turning for the community garden." },
      { id: "d1", vec: [0, 0, 0, 1], body: "Chess club ladder rankings reshuffle at the tournament anniversary." },
      { id: "d2", vec: [0, 0, 0.05, 0.998], body: "Tournament anniversary reshuffle of the chess club ladder rankings." },
    ]);
    const res = await dedup.sweep({
      runner: async () => '{"verdict":"distinct","keep_id":null,"supersede_ids":[],"rationale":"different"}',
      threshold: 0.9, maxClusters: 2, state: { judged: {}, reported: {} },
    });
    assert.equal(res.stats.clusters, 4);
    assert.equal(res.stats.judged, 2);
    assert.equal(res.stats.clustersDropped, 2);
    assert.match(dedup.renderReportHtml(res), /were not judged this run/);
  });

  it("surfaces a duplicate with a ready-to-run supersede command", async () => {
    seed([
      { id: "user_tea", title: "Tea", vec: [1, 0, 0, 0], body: "Alex brews rooibos, never smoky lapsang souchong." },
      { id: "user_tea_pref", title: "Tea preference", vec: [0.99, 0.14, 0, 0], body: "Tea preference: rooibos over smoky lapsang souchong." },
    ]);
    const res = await dedup.sweep({
      runner: async () => '{"verdict":"duplicate","keep_id":"user_tea","supersede_ids":["user_tea_pref"],"rationale":"identical"}',
      threshold: 0.9, state: { judged: {}, reported: {} },
    });
    assert.equal(res.actionable.length, 1);
    const text = dedup.renderReportText(res);
    assert.match(text, /wiki supersede user_tea_pref user_tea/);
    assert.match(dedup.renderReportHtml(res), /wiki supersede user_tea_pref user_tea/);
  });

  it("a clean corpus yields nothing actionable (so the job stays silent)", async () => {
    seed([
      { id: "a", vec: V.cooking, body: B.sourdough1 },
      { id: "b", vec: V.travel, body: B.bikeTune1 },
      { id: "c", vec: V.finance, body: B.stargazing },
    ]);
    const res = await dedup.sweep({ runner: async () => { throw new Error("should not be called"); }, threshold: 0.9, state: { judged: {}, reported: {} } });
    assert.equal(res.stats.pairs, 0);
    assert.equal(res.actionable.length, 0);
  });
});

// These cover a failure mode: every judge returned
// "Not logged in · Please run /login" — printed to stdout with exit 0, so not a
// throw — and the sweep reported "Nothing actionable" while writing every pair
// into the state file as "distinct". That is the worst possible outcome: an
// outage silently and permanently retires real duplicates, and the report says
// the corpus is clean.
describe("wiki-dedup treats a failed judge as failure, not as a clean bill of health", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  function twoPairCorpus() {
    seed([
      { id: "a", vec: [1, 0, 0, 0], body: B.sourdough1 },
      { id: "b", vec: [0.99, 0.14, 0, 0], body: B.sourdough2 },
      ...fillerPages(80),
    ]);
  }

  it("recognizes an unauthenticated claude -p reply, which arrives as text and not as an error", () => {
    assert.equal(dedup.isAuthFailure("Not logged in · Please run /login"), true);
    assert.equal(dedup.isAuthFailure("Invalid API key"), true);
    assert.equal(dedup.isAuthFailure('{"verdict":"distinct"}'), false);
  });

  it("counts failed judges instead of reporting them as distinct", async () => {
    twoPairCorpus();
    const res = await dedup.sweep({
      runner: async () => "Not logged in · Please run /login",
      state: { judged: {}, reported: {} },
    });
    assert.equal(res.stats.judged, 1);
    assert.equal(res.stats.failed, 1);
    assert.equal(res.stats.authFailed, 1);
    assert.equal(res.actionable.length, 0);
  });

  it("never writes a verdict the judge did not actually make", async () => {
    twoPairCorpus();
    const state = { judged: {}, reported: {} };
    await dedup.sweep({ runner: async () => "Not logged in · Please run /login", state });
    assert.deepEqual(state.judged, {},
      "recording the fail-soft 'distinct' would suppress this pair forever — an outage must not retire real duplicates");
  });

  it("a genuine distinct verdict IS recorded, so the suppression still works normally", async () => {
    twoPairCorpus();
    const state = { judged: {}, reported: {} };
    await dedup.sweep({
      runner: async () => '{"verdict":"distinct","keep_id":null,"supersede_ids":[],"rationale":"different subjects"}',
      state,
    });
    assert.equal(Object.keys(state.judged).length, 1);
    assert.equal(state.judged[dedup.pairKey("a", "b")].verdict, "distinct");
  });
});

// A run can find real clusters and then fail to email them: `email-send`
// blocks em/en dashes on the agent-to-user email route, and wiki titles are
// full of them ("Harbor Notes — chapter one"), as was our own &mdash; markup.
describe("wiki-dedup report survives the em-dash gate", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("strips em and en dashes from both renderers, including ones inside page titles", async () => {
    seed([
      { id: "a", title: "Harbor Notes — chapter one", vec: [1, 0, 0, 0], body: B.sourdough1 },
      { id: "b", title: "Harbor Notes – film reference", vec: [0.99, 0.14, 0, 0], body: B.sourdough2 },
      ...fillerPages(80),
    ]);
    const res = await dedup.sweep({
      runner: async () => '{"verdict":"overlap","keep_id":"a","supersede_ids":["b"],"rationale":"one is the novel — the other the film"}',
      state: { judged: {}, reported: {} },
    });
    assert.equal(res.actionable.length, 1);
    for (const out of [dedup.renderReportHtml(res), dedup.renderReportText(res)]) {
      assert.ok(!/[—–]/.test(out), "no literal em/en dash");
      assert.ok(!/&mdash;|&ndash;/.test(out), "no dash entities either — email-send checks rendered bytes");
    }
  });
});
