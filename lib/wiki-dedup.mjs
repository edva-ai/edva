// wiki-dedup.mjs — full-corpus duplicate / staleness sweep over the wiki pages.
//
// WHY THIS EXISTS (and why it isn't part of memory-consolidation):
// the weekly `memory-consolidation` job is deliberately DIFF-mode — it audits
// pages changed in the last 7 days plus their semantic neighbors. That is the
// right shape for hygiene on a moving corpus, but it structurally cannot see a
// duplicate pair created weeks apart: neither page is "recently changed" in the
// same week, so the two are never compared. On a corpus of hundreds of pages those long-standing
// duplicates are the residue nothing sweeps.
//
// This module does the complementary pass: compare EVERY active curated page
// against every other one, once a month. It is mechanically cheap because the
// pages are already embedded (`page_embeddings`, nomic-embed-text, written by
// the nightly `wiki-embed` cron) — so candidate generation is pure local vector
// math, no model calls and no page bodies in anyone's context window. Only the
// handful of clusters that survive the similarity filter get a model verdict,
// and each verdict runs in its own fresh one-shot context (core/one-shot.mjs +
// core/stateless-executor.mjs) rather than accumulating in a conversation.
//
// This is the Conway substrate's "buffers outside the context window + cheap
// fan-out to judge" pattern doing a job nothing else can do — see
// system/conway-substrate-plan.md.
//
// POSTURE: propose, never act. This module has NO write path to the wiki — it
// cannot delete, supersede, or edit a page. It emits clusters and a suggested
// `wiki supersede` command for a human (or a later, separately-authorized step)
// to run. A full-corpus auto-prune is far too blunt to be the first act-on-
// memory capability.

import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { unpackF32, cosine } from "./hybrid-recall.mjs";

import { installTools } from "./root.cjs";
const HOME = os.homedir();

export const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

// Episodic pages (`day_2026-07-04`, `week_*`, `month_*`) are a per-date record,
// regenerated from `daily_summaries`. Consecutive days legitimately look alike
// to an embedder (same people, same places, same routine) and they are NEVER
// duplicates of each other — a day page's whole purpose is to exist once per
// day. memory-consolidation carries the same exclusion (its rule 4).
export const EXCLUDED_TYPES = new Set(["day", "week", "month"]);

// GENERATED DIRECTORY PAGES — most of the otherwise-in-scope pages.
//
// A travel pipeline emits one index page per entity, in families that all open
// the same way: "This is the canonical page for [[…]]", "…the city directory
// page for…", "…the airline page for…", "…the country directory page for…".
// Below those families, groups of same-shaped pages in a curated corpus are
// small — so this one regex is the line between generated scaffolding and
// curated memory.
//
// They are out of scope for a semantic duplicate sweep for two independent
// reasons:
//
//   1. They are REGENERATED. `wiki supersede` on one is undone the next time the
//      travel job runs, so a proposal against them is not actionable.
//   2. They defeat both candidate gates at once. Identical boilerplate makes the
//      embeddings identical, and a country page shares ALL its distinctive
//      vocabulary with its own city pages — the trip slugs they both link to.
//      `travel_country_<country>` and `travel_city_<country>_<city>` score
//      cosine ~0.97 and rare-token Jaccard 1.0, and they are not duplicates;
//      they are a country and a city in it.
//
// Detected by SHAPE rather than by an id prefix, so a future generator that
// writes the same kind of page is excluded automatically.
//
// NOT YET BUILT (deliberate): calibration surfaced real redundancy INSIDE this
// family — a city page under two spellings of its name, a city filed under
// the wrong country, a postcode used as a city name. Those are
// name-normalization bugs in the travel generator, fixable
// mechanically with no model in the loop, and they belong to that job, not to
// this sweep. Tracked as a follow-up; excluding the family here does not make
// them go away.
const GENERATED_DIRECTORY_RE = /^This is the [\w ]{0,40}page for \[\[/i;

export function isGeneratedDirectory(page) {
  return GENERATED_DIRECTORY_RE.test((page.body_md || "").trim());
}

// Cosine floor for two pages to be considered a candidate pair. Calibrated
// against the live corpus rather than guessed — `wiki-dedup-sweep calibrate`
// prints the joint survivor grid. On the raw page set cosine alone is
// hopeless: tens of thousands of pairs above 0.80 and dozens at a flat 1.000.
// With generated pages excluded and the lexical gate applied, the curated pages
// yield a few dozen pairs here and about a third as many at 0.90 — so this is
// deliberately the LOOSER end. A verdict of
// "distinct" is remembered (see suppressedPairs), so casting wide costs one
// first run and then settles; casting narrow silently misses duplicates forever.
export const DEFAULT_THRESHOLD = 0.85;

// THE SECOND, LOAD-BEARING SIGNAL.
//
// The generated-page exclusion above removes the worst offenders, but template
// similarity is a general hazard, not a travel-specific one: the
// `travel_city_*` stubs that motivated this gate were ~500 chars of identical
// boilerplate with a city name swapped in, and two unrelated cities scored
// 1.000 against each other. Any family of same-shaped pages does this, and the next one will not
// match the regex above. The gate is the durable defense; the exclusion is the
// specific one.
//
// So a pair must also share DISTINCTIVE vocabulary: tokens that are rare across
// the corpus as a whole. Boilerplate tokens appear on hundreds of pages and are
// dropped; two city names are rare but they don't overlap, so the pair
// dies. Two pages that really do restate one fact share their rare tokens (the
// person, the place, the project) and survive. This is the same intuition as
// the BM25-half of the hybrid recall already used elsewhere in the repo —
// semantics finds the neighborhood, lexical distinctiveness confirms the subject.
export const RARE_DF_FRACTION = 0.05;   // a token on >5% of pages is boilerplate
export const DEFAULT_RARE_JACCARD = 0.15;

// Hard ceiling on clusters sent for a model verdict in one run. Judging is one
// `claude -p` spawn per cluster, so this bounds both wall-clock and spend. When
// it bites, the sweep says so in its own output — a silent truncation would
// read as "the corpus is clean" when it isn't.
export const DEFAULT_MAX_CLUSTERS = 30;

// How much of each page the judge sees. Enough to tell "same fact restated"
// from "adjacent topics", short enough that a 4-page cluster stays a small
// prompt.
const BODY_HEAD_CHARS = 1200;

let _db = null;
export function db() {
  if (!_db) _db = new DatabaseSync(DB_PATH);
  return _db;
}
export function _closeForTest() {
  try { _db?.close(); } catch {}
  _db = null;
}

// ---------------------------------------------------------------------------
// Candidate generation (mechanical — no model, no network)
// ---------------------------------------------------------------------------

/**
 * Active, non-episodic pages that have a current embedding.
 *
 * The `body_hash` join matters: pages are mutable, and `wiki-embed` re-embeds
 * on change. A page whose stored embedding is for an older body is skipped
 * rather than compared against a stale vector — it'll be picked up next month
 * once the nightly embed catches up.
 */
export function loadPages({ includeTypes = null, includeGenerated = false } = {}) {
  const rows = db().prepare(`
    SELECT p.id, p.basename, p.type, p.title, p.description, p.body_md,
           p.pinned, p.pin_locked, p.updated_at, p.body_hash,
           e.embedding AS embedding
      FROM pages p
      JOIN page_embeddings e ON e.page_id = p.id AND e.body_hash = p.body_hash
     WHERE p.status = 'active'
  `).all();

  return rows
    .filter((r) => !EXCLUDED_TYPES.has(r.type || ""))
    .filter((r) => (includeGenerated ? true : !isGeneratedDirectory(r)))
    .filter((r) => (includeTypes ? includeTypes.includes(r.type || "") : true))
    .map((r) => ({ ...r, vec: unpackF32(r.embedding), embedding: undefined }));
}

/** Pairs already recorded as supersession edges — a resolved relationship. */
export function loadResolvedPairs() {
  const out = new Set();
  try {
    for (const r of db().prepare(`SELECT new_basename, old_basename FROM supersession`).all()) {
      out.add(pairKey(r.new_basename, r.old_basename));
    }
  } catch { /* table absent in a bare test DB — nothing resolved yet */ }
  return out;
}

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Words shorter than 4 chars carry no subject signal and blow up the df map.
const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "here", "when", "what", "which", "they",
  "them", "then", "than", "into", "over", "your", "yours", "about", "would",
  "could", "should", "there", "their", "these", "those", "been", "being", "were",
  "also", "only", "just", "more", "most", "some", "such", "each", "page", "pages",
  "note", "notes", "list", "full", "used", "using", "does", "doesn", "will",
]);

export function tokenize(text) {
  const out = new Set();
  for (const t of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 4 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Document frequency across the corpus — how many pages each token appears on.
 * Computed once per sweep; this is what lets us tell boilerplate from subject.
 */
export function documentFrequency(pages) {
  const df = new Map();
  for (const p of pages) {
    for (const t of tokenize(`${p.title} ${p.description} ${p.body_md}`)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return df;
}

/** The tokens on this page that the corpus as a whole does NOT use. */
export function rareTokens(page, df, nPages, { maxFraction = RARE_DF_FRACTION } = {}) {
  const ceiling = Math.max(2, Math.floor(nPages * maxFraction));
  const out = new Set();
  for (const t of tokenize(`${page.title} ${page.description} ${page.body_md}`)) {
    if ((df.get(t) || 0) <= ceiling) out.add(t);
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * All-pairs candidate generation: cosine above `threshold` AND rare-token
 * Jaccard above `rareJaccard`. O(n²) on ~800 pages = ~300k comparisons — a
 * couple of seconds, entirely local. Deliberately not approximated: the whole
 * point of a full-corpus sweep is that it misses nothing a cheap index would.
 *
 * Both gates are required. Cosine alone drowns in template families (see
 * RARE_JACCARD); rare-token overlap alone would pair any two pages that happen
 * to mention the same uncommon word.
 */
export function findCandidatePairs(pages, {
  threshold = DEFAULT_THRESHOLD,
  rareJaccard = DEFAULT_RARE_JACCARD,
  skip = new Set(),
} = {}) {
  const df = documentFrequency(pages);
  const rare = new Map(pages.map((p) => [p.id, rareTokens(p, df, pages.length)]));

  const pairs = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const key = pairKey(pages[i].id, pages[j].id);
      if (skip.has(key)) continue;
      const score = cosine(pages[i].vec, pages[j].vec);
      if (score < threshold) continue;
      const lex = jaccard(rare.get(pages[i].id), rare.get(pages[j].id));
      if (lex < rareJaccard) continue;
      pairs.push({ key, a: pages[i], b: pages[j], score, lex });
    }
  }
  // Rank by the weaker of the two signals, so a pair that is strong on both
  // outranks one that merely maxes out cosine on shared boilerplate.
  return pairs.sort((x, y) => Math.min(y.score, y.lex + 0.5) - Math.min(x.score, x.lex + 0.5));
}

/**
 * Union-find the surviving pairs into clusters, so three pages all restating
 * one fact are judged once as a trio rather than three times as pairs.
 */
export function clusterPairs(pairs) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); };

  const byId = new Map();
  for (const p of pairs) {
    byId.set(p.a.id, p.a);
    byId.set(p.b.id, p.b);
    union(p.a.id, p.b.id);
  }

  const groups = new Map();
  for (const id of byId.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(byId.get(id));
  }

  // Top score inside a cluster drives ordering — the most-similar clusters are
  // the most likely to be real duplicates and should be judged first when the
  // per-run cap bites.
  const topScore = new Map();
  for (const p of pairs) {
    for (const root of [find(p.a.id)]) {
      topScore.set(root, Math.max(topScore.get(root) || 0, p.score));
    }
  }

  return [...groups.entries()]
    .map(([root, members]) => ({
      id: members.map((m) => m.id).sort().join("+"),
      members: members.sort((a, b) => (a.updated_at || "").localeCompare(b.updated_at || "")),
      topScore: topScore.get(root) || 0,
    }))
    .sort((a, b) => b.topScore - a.topScore);
}

// ---------------------------------------------------------------------------
// Judging (one fresh one-shot context per cluster)
// ---------------------------------------------------------------------------

export const JUDGE_SYSTEM = `You audit a personal knowledge wiki for redundancy. You are shown a small cluster of pages that a vector search found unusually similar. Decide whether they actually say the same thing.

Answer with ONE JSON object and nothing else:
{"verdict":"duplicate"|"overlap"|"distinct","keep_id":"<page id to keep, or null>","supersede_ids":["<page ids the keeper makes redundant>"],"rationale":"<one or two sentences>"}

Definitions — be strict, a false duplicate is worse than a missed one:
- "duplicate": the pages state the SAME fact(s) about the same subject. One could be deleted with no information lost.
- "overlap": they share a subject and some content, but each holds something the other does not. Worth merging by hand; NOT safe to delete either.
- "distinct": same topic area, different facts. This is the correct answer for most clusters — related pages are supposed to exist.

Rules:
- Pages of different kinds (a preference vs a project status vs an external pointer) are almost never duplicates even when they name the same subject.
- A newer page that strictly extends an older one is "overlap" with the newer as keep_id, not "duplicate".
- Prefer keeping the page that is pinned, or has the richer body, or is newer.
- If you are unsure, answer "distinct".`;

export function renderCluster(cluster) {
  return cluster.members.map((m, i) => {
    const body = (m.body_md || "").slice(0, BODY_HEAD_CHARS);
    return [
      `--- PAGE ${i + 1} ---`,
      `id: ${m.id}`,
      `type: ${m.type || "(none)"}${m.pinned ? " (pinned)" : ""}${m.pin_locked ? " (pin-locked, identity core)" : ""}`,
      `title: ${m.title || ""}`,
      `description: ${m.description || ""}`,
      `updated: ${m.updated_at || "?"}`,
      `body:\n${body}${(m.body_md || "").length > BODY_HEAD_CHARS ? "\n…(truncated)" : ""}`,
    ].join("\n");
  }).join("\n\n");
}

/** Pull the verdict object out of a model reply that may be fenced or chatty. */
// `claude -p` reports an unauthenticated session by printing this to stdout and
// exiting 0 — it is not a spawn error and not a throw. Without an explicit check
// it parses as "no JSON found" → an ordinary unparseable verdict, which is how
// the first live run reported a clean corpus after all 16 judges
// failed. Distinguish "the judge said these pages differ" from "there was no
// judge" — they must never produce the same outcome.
const NOT_AUTHENTICATED_RE = /not logged in|please run \/login|invalid api key|credit balance/i;

export function isAuthFailure(text) {
  return NOT_AUTHENTICATED_RE.test(String(text || ""));
}

export function parseVerdict(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    if (!["duplicate", "overlap", "distinct"].includes(v.verdict)) return null;
    return {
      verdict: v.verdict,
      keep_id: v.keep_id || null,
      supersede_ids: Array.isArray(v.supersede_ids) ? v.supersede_ids : [],
      rationale: String(v.rationale || "").trim(),
    };
  } catch { return null; }
}

/**
 * Judge clusters with a bounded fan-out. `runner(prompt)` returns the model's
 * text — injected so tests never spawn a real `claude -p`. An unparseable or
 * failed verdict degrades to "distinct" (propose nothing) rather than throwing:
 * this job's failure mode must be under-reporting, never a bogus merge.
 */
export async function judgeClusters(clusters, { runner, concurrency = 3, onProgress = null } = {}) {
  const out = new Array(clusters.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= clusters.length) return;
      const cluster = clusters[i];
      let verdict = null;
      try {
        const reply = await runner(renderCluster(cluster));
        if (isAuthFailure(reply)) {
          verdict = { verdict: "distinct", keep_id: null, supersede_ids: [], rationale: "judge unauthenticated", failed: true, authFailed: true };
        } else {
          verdict = parseVerdict(reply);
        }
      } catch (err) {
        verdict = { verdict: "distinct", keep_id: null, supersede_ids: [], rationale: `judge failed: ${err.message}` , failed: true };
      }
      out[i] = { ...cluster, verdict: verdict || { verdict: "distinct", keep_id: null, supersede_ids: [], rationale: "unparseable verdict", failed: true } };
      onProgress?.(i + 1, clusters.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, clusters.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// State — so a cluster the user has already seen doesn't read as news
// ---------------------------------------------------------------------------

export const STATE_PATH =
  process.env.WIKI_DEDUP_STATE ||
  installTools("data/wiki-dedup-state.json");

export function loadState(fs, statePath = STATE_PATH) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { last_run: null, judged: {}, reported: {} }; }
}

/**
 * A pair judged "distinct" stays judged — unless one of the two pages has been
 * edited since (hash change), in which case the old verdict no longer describes
 * the pages and it gets re-judged. This is what keeps a monthly full-corpus
 * sweep from re-spending on the same ~hundreds of settled neighbors forever.
 */
export function suppressedPairs(state, pages) {
  const hashById = new Map(pages.map((p) => [p.id, p.body_hash]));
  const skip = new Set();
  for (const [key, rec] of Object.entries(state.judged || {})) {
    if (rec.verdict !== "distinct") continue;          // actionable verdicts keep resurfacing
    const [a, b] = key.split("|");
    if (hashById.get(a) === rec.hash_a && hashById.get(b) === rec.hash_b) skip.add(key);
  }
  return skip;
}

/** Record this run's verdicts, keyed per PAIR so a re-clustered group still matches. */
export function recordVerdicts(state, judged) {
  state.judged = state.judged || {};
  state.reported = state.reported || {};
  for (const cluster of judged) {
    // A failed judge produced no opinion. Recording its fail-soft "distinct"
    // would suppress the pair on every future run (see suppressedPairs) — an
    // outage would silently and permanently retire real duplicates.
    if (cluster.verdict?.failed) continue;
    const ms = cluster.members;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const key = pairKey(ms[i].id, ms[j].id);
        state.judged[key] = {
          verdict: cluster.verdict.verdict,
          hash_a: (ms[i].id < ms[j].id ? ms[i] : ms[j]).body_hash,
          hash_b: (ms[i].id < ms[j].id ? ms[j] : ms[i]).body_hash,
          judged_at: state.last_run,
        };
      }
    }
    if (cluster.verdict.verdict !== "distinct") {
      const prev = state.reported[cluster.id];
      state.reported[cluster.id] = {
        first_reported: prev?.first_reported || state.last_run,
        times: (prev?.times || 0) + 1,
      };
      cluster.reportedBefore = prev ? { ...prev } : null;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// An outbound no-dash rule judges the RENDERED bytes of an email, so both our
// own markup and the page titles we quote have to be clean. Wiki titles
// routinely contain em dashes ("<Title> — <date range>"), which is what
// bounced the first successful run's email. Sanitize at the boundary rather
// than reaching for EMAIL_SEND_ALLOW_DASHES, which exists for passing through a
// third party's verbatim quote, not for our own formatting.
export function stripDashes(text) {
  return String(text ?? "")
    .replace(/&mdash;|&ndash;/g, "-")
    .replace(/[\u2014\u2013]/g, "-");
}

export function renderReportHtml(result) {
  return stripDashes(renderReportHtmlRaw(result));
}

function renderReportHtmlRaw(result) {
  const { actionable, stats } = result;
  const dupes = actionable.filter((c) => c.verdict.verdict === "duplicate");
  const overlaps = actionable.filter((c) => c.verdict.verdict === "overlap");

  const section = (title, clusters, blurb) => {
    if (!clusters.length) return "";
    const items = clusters.map((c) => {
      const keep = c.verdict.keep_id;
      const rows = c.members.map((m) => {
        const tag = m.id === keep ? " &larr; keep" : (c.verdict.supersede_ids.includes(m.id) ? " &larr; redundant" : "");
        return `<li><code>${esc(m.id)}</code> &mdash; ${esc(m.title || "")} <span style="color:#888">(${esc(m.type || "untyped")}, updated ${esc((m.updated_at || "").slice(0, 10))})</span><b>${tag}</b></li>`;
      }).join("");
      const cmds = c.verdict.supersede_ids
        .filter((old) => keep && old !== keep)
        .map((old) => `wiki supersede ${old} ${keep}`)
        .join("\n");
      const seen = c.reportedBefore
        ? `<div style="color:#a15c00;font-size:13px">Reported ${c.reportedBefore.times}&times; before, first on ${esc((c.reportedBefore.first_reported || "").slice(0, 10))} &mdash; still open.</div>`
        : "";
      return `<div style="margin:0 0 18px 0;padding:12px;border:1px solid #e3e3e3;border-radius:8px">
        <div style="color:#666;font-size:13px">similarity ${c.topScore.toFixed(3)}</div>
        <ul style="margin:6px 0">${rows}</ul>
        <div style="margin:6px 0">${esc(c.verdict.rationale)}</div>
        ${seen}
        ${cmds ? `<pre style="background:#f6f6f6;padding:8px;border-radius:6px;overflow-x:auto">${esc(cmds)}</pre>` : ""}
      </div>`;
    }).join("");
    return `<h2 style="margin:24px 0 4px">${esc(title)} (${clusters.length})</h2><p style="color:#666;margin:0 0 12px">${esc(blurb)}</p>${items}`;
  };

  const capNote = stats.clustersDropped > 0
    ? `<p style="color:#a15c00"><b>${stats.clustersDropped} cluster(s) over the per-run cap of ${stats.maxClusters} were not judged this run</b> and will be picked up next month. Raise <code>--max-clusters</code> to go deeper now.</p>`
    : "";

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;line-height:1.5">
    <h1 style="margin:0 0 4px">Wiki duplicate sweep</h1>
    <p style="color:#666;margin:0 0 16px">Full-corpus pass over ${stats.pages} active pages &mdash; every page compared against every other, not just the week's changes. ${stats.pairs} pair(s) above ${stats.threshold} similarity formed ${stats.clusters} cluster(s); ${stats.judged} judged.</p>
    ${capNote}
    ${section("Duplicates", dupes, "These say the same thing. Superseding the redundant one loses nothing.")}
    ${section("Overlaps", overlaps, "Same subject, but each holds something the other does not. Merge by hand, do not delete.")}
    ${!dupes.length && !overlaps.length ? "<p>Nothing actionable this run.</p>" : ""}
    <p style="color:#888;font-size:13px;margin-top:24px">Proposals only &mdash; this sweep has no write path to the wiki. Run the commands above to act, or ignore and they will resurface next month.</p>
  </div>`;
}

export function renderReportText(result) {
  return stripDashes(renderReportTextRaw(result));
}

function renderReportTextRaw(result) {
  const { actionable, stats } = result;
  const lines = [
    `Wiki duplicate sweep — ${stats.pages} pages, ${stats.pairs} similar pairs, ${stats.clusters} clusters, ${stats.judged} judged`,
  ];
  if (stats.clustersDropped) lines.push(`!! ${stats.clustersDropped} cluster(s) over the cap of ${stats.maxClusters} were NOT judged this run`);
  for (const c of actionable) {
    lines.push("", `[${c.verdict.verdict}] sim=${c.topScore.toFixed(3)}`);
    for (const m of c.members) {
      const tag = m.id === c.verdict.keep_id ? " <- keep" : (c.verdict.supersede_ids.includes(m.id) ? " <- redundant" : "");
      lines.push(`  ${m.id} — ${m.title || ""} (${m.type || "untyped"})${tag}`);
    }
    lines.push(`  ${c.verdict.rationale}`);
    for (const old of c.verdict.supersede_ids) {
      if (c.verdict.keep_id && old !== c.verdict.keep_id) lines.push(`  $ wiki supersede ${old} ${c.verdict.keep_id}`);
    }
  }
  if (!actionable.length) lines.push("", "Nothing actionable this run.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function sweep({
  runner,
  threshold = DEFAULT_THRESHOLD,
  rareJaccard = DEFAULT_RARE_JACCARD,
  maxClusters = DEFAULT_MAX_CLUSTERS,
  concurrency = 3,
  state = { judged: {}, reported: {} },
  onProgress = null,
} = {}) {
  const pages = loadPages();
  const skip = new Set([...loadResolvedPairs(), ...suppressedPairs(state, pages)]);
  const pairs = findCandidatePairs(pages, { threshold, rareJaccard, skip });
  const allClusters = clusterPairs(pairs);
  const clusters = allClusters.slice(0, maxClusters);

  const judged = clusters.length ? await judgeClusters(clusters, { runner, concurrency, onProgress }) : [];
  recordVerdicts(state, judged);

  const failed = judged.filter((c) => c.verdict?.failed);
  return {
    judged,
    actionable: judged.filter((c) => c.verdict.verdict !== "distinct" && !c.verdict.failed),
    stats: {
      failed: failed.length,
      authFailed: failed.filter((c) => c.verdict.authFailed).length,
      pages: pages.length,
      pairs: pairs.length,
      clusters: allClusters.length,
      judged: judged.length,
      clustersDropped: Math.max(0, allClusters.length - clusters.length),
      maxClusters,
      threshold,
      rareJaccard,
      suppressed: skip.size,
    },
    state,
  };
}
