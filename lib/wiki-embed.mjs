// wiki-embed.mjs — semantic embeddings + hybrid recall for the wiki pages.
//
// wiki-store.js (searchPages) gives the agent a great LEXICAL layer over the
// curated memory pages: FTS5/BM25 with type-weighting. But BM25 only matches
// on shared terms — a paraphrased query ("where does the user like to eat?")
// misses a page that says "restaurant preferences" unless the words overlap.
// As the corpus grows 10x/100x, that gap widens: the agent can't be expected
// to guess the exact vocabulary of a page it's never read.
//
// This module adds the SAME hybrid recall the event stream already got on
// 2026-07-08 (see event-fts.mjs) to the wiki page store:
//   - a `page_embeddings` table in the SAME memory-index.db (nomic-embed-text,
//     768-dim, local Ollama), one row per active page keyed by page id;
//   - `embedPendingPages()` — a backfill that (re)embeds pages whose stored
//     body_hash no longer matches `pages.body_hash` (pages are MUTABLE, unlike
//     the append-only event log, so freshness is hash-tracked, not rowid-fixed);
//   - `searchPagesHybrid()` — fuses the wiki's BM25 ranking (from
//     wiki-store.searchPages, so the type-weighting/pinned-boost is preserved)
//     with a vector-KNN ranking via Reciprocal Rank Fusion (hybrid-recall.mjs).
//
// 2026-08-09 — CUE ANCHORS (`page_cues`). One vector per page was the binding
// constraint on recall: a page is found only if the query resembles the WHOLE
// page, so a many-topic page is diluted out of reach of a query about any one
// of its topics. Each page is now ALSO indexed through several short cues (its
// description, its section headings, later LLM-generated aspects), each its own
// row in the same matrix; the KNN ranks cues and we collapse to the best cue per
// page. Adapted from Memora (Microsoft Research, ICML 2026, arXiv 2602.03315) —
// see § Cue anchors below. Purely additive: with `page_cues` empty the results
// are byte-identical to the pre-2026-08-09 behaviour, which is the rollback.
//
// Design mirrors event-fts.mjs deliberately (one memory store, one backup, one
// set of pure fusion primitives):
//   - Same DB as wiki-store; a SEPARATE DatabaseSync handle (WAL makes the
//     in-process co-existence with wiki-store's handle safe — the MCP server
//     already holds both a wiki-store and an event-fts handle at once).
//   - Everything is fail-soft. A DB that can't be opened DISABLES the semantic
//     layer rather than throwing; hybrid search then returns the pure-FTS list.
//   - Embeddings are populated OUT of band (the `wiki-embed` CLI / nightly
//     cron), never on the savePage hot path — embedding via Ollama is far too
//     slow to sit in a write. If the embedder is down or nothing is embedded
//     yet, recall silently degrades to exactly what wiki_search returns today.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import {
  packF32,
  cachedVectorIndex,
  knnIndex,
  clearVectorIndexCache,
  collapseByKey,
  rrfFuse,
  bestScoreByKey,
  peekVectorIndex,
} from "./hybrid-recall.mjs";
import {
  CURRENT_FACT_SQL,
  associate,
  assocGraphVersion,
  cachedAssocGraph,
  clearAssocGraphCache,
  inDateWindow,
  softGate,
} from "./wiki-assoc.mjs";
import { quoteIn } from "./quote-check.mjs";

import { installTools } from "./root.cjs";
const require = createRequire(import.meta.url);
// wiki-store owns the authoritative FTS ranking (type-weighting + pinned
// boost). We reuse it for the lexical half of the fusion rather than
// re-implementing the SQL — keeps the two paths from drifting.
const ws = require("./wiki-store.js");

const HOME = os.homedir();

const DB_PATH =
  process.env.MEMORY_INDEX_DB ||
  installTools("data/memory-index.db");

const EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "nomic-embed-text";

// Pages are longer than events; embed title + description + the head of the
// body. nomic-embed-text's context window is 2048 tokens — long day/week
// narratives blow past that and Ollama 500s ("input length exceeds the context
// length"). ~5k chars keeps prose comfortably under the window (the
// highest-signal "what is this page about" content is almost always early); a
// page that still overflows is retried truncated in embedPendingPages.
const MAX_TEXT = 5000;
// Fallback head length when the model rejects even MAX_TEXT as too long.
const OVERFLOW_RETRY_TEXT = 1500;

// How many FTS + semantic candidates to pull before fusing. Wide enough that a
// page ranked mediocre by one method but strong by the other still surfaces.
// Overridable so the eval harness can sweep it and tests can shrink it — with
// a candidate window wider than the corpus, the flat KNN returns everything and
// link expansion has nothing left to add, which is correct in production and
// untestable on a fixture.
const CANDIDATES = Number(process.env.WIKI_RECALL_CANDIDATES || 60);

// The semantic index holds one row per CUE, not per page (see § Cue anchors
// below), so the raw KNN has to be pulled wider than CANDIDATES: several cues
// of the same page can legitimately occupy consecutive slots, and we only find
// out after collapsing. 4x is empirically past the point where widening it
// further changes the collapsed top-60 on the live corpus.
const CUE_CANDIDATES = CANDIDATES * 4;

// Most cues we will store for one page. Raised 8 → 20 on 2026-08-09: eval v2
// showed the old cap was the main reason day pages got nothing out of the cue
// tier. A 17-stop day was truncated to its earliest 8 headings, so every evening
// stop was simply unindexed — three evening stops in the eval set were all cut,
// and all three were eval misses. Short pages are naturally bounded well under this.
const MAX_CUES_PER_PAGE = 20;

// A cue is an ENTRY POINT, so it is short by construction. Anything longer is a
// paragraph that wandered into a heading and would just dilute its own vector.
const MAX_CUE_TEXT = 200;

// Bump when `cuesForPage` changes what it emits. Cue freshness is otherwise
// keyed on body_hash alone, so a page whose BODY is unchanged would keep cues
// built by the old logic forever — which is exactly what happened when heading
// cues gained their title qualifier (v1 → v2), and again when day pages got
// stop-aware extraction and the cap rose to 20 (v2 → v3), and again when the
// backfill was found not to SELECT p.type at all, so `cuesForPage` saw
// type=undefined and no day page ever took the episodic branch (v3 → v4). Rows
// carrying an
// older version are re-cued on the next pass, no manual reindex.
const CUE_LOGIC_VERSION = 4;

// Cue anchors off with WIKI_USE_CUES=0 — the rollback switch, and what lets
// `wiki-recall-eval` measure the cue tier's contribution in isolation.
const USE_CUES = process.env.WIKI_USE_CUES !== "0";

// ── Associative recall tuning (see § Associative recall below) ────────────
//
// The 2026-08-09 one-hop link expansion (forward wikilinks only, in-degree > 60
// dropped, neighbours re-gated by a hard 0.62 cosine floor) measured zero gain
// and was retired on 2026-10-24 in favour of lib/wiki-assoc.mjs, which
// fixes the three retriever-side reasons it could not work (module header
// there; research write-up in system/associative-memory-research.md).
//
// WIKI_ASSOC selects the propagation scheme for the THIRD fused list:
//   off  — two lists only (lexical + semantic). The DEFAULT until the
//          associative eval set (data/wiki-recall-eval-assoc.json) has
//          been run against the live corpus: a change that re-ranks every
//          consumer (hum, triage, auto-recall) earns its default on the
//          measurement, the same bar cues and expansion were held to.
//   sa   — fan-normalized spreading activation (ACT-R / SYNAPSE).
//   ppr  — personalized PageRank (HippoRAG), fan-corrected.
// WIKI_EXPAND_LINKS=1, the old switch, now means `sa` so a stale env does not
// silently turn association off.
const ASSOC_METHOD = (() => {
  const v = String(process.env.WIKI_ASSOC || "").toLowerCase();
  if (v === "sa" || v === "ppr") return v;
  if (v === "off" || v === "0") return "off";
  return process.env.WIKI_EXPAND_LINKS === "1" ? "sa" : "off";
})();
// How many top fused hits seed the propagation. Their weights are their RRF
// scores, so a #1 hit spreads more than a #10.
const ASSOC_SEEDS = Number(process.env.WIKI_ASSOC_SEEDS || 10);
// Most association hits admitted to the third list.
const ASSOC_CAP = Number(process.env.WIKI_ASSOC_CAP || 20);
// RRF weight of the association list relative to lexical/semantic (1.0 each).
//
// Every system that kept its association gains kept the direct retrievers
// dominant (SYNAPSE: semantic 0.5 / activation 0.3), and the one that did not
// (SuperLocalMemory V3.3) lost 14.9pp on single-hop questions. In RRF that
// dominance is structural rather than a matter of weight: a page BOTH direct
// lists found scores ~2/61, and an association-only page can never exceed
// w/61. So the weight decides only where association-only pages land among the
// SINGLE-list hits, and the arithmetic leaves little room: the direct lists are
// CANDIDATES (60) long, so at 0.6 an association-only page at association rank
// 1 scores 0.6/61 — the same as a lexical-only page at rank ~41, i.e. it could
// never reach a top-10 (found by the first end-to-end smoke run, 2026-10-24).
// At 1.0 it ranks with the top single-list hits and below every page both
// direct retrievers agree on. Sweep it with WIKI_ASSOC_WEIGHT in the eval.
const ASSOC_WEIGHT = Number(process.env.WIKI_ASSOC_WEIGHT || 1.0);

// Base-level activation prior (lib/wiki-activation.mjs): an ACT-R
// recency x frequency score per page from what was actually USED (judge-kept
// recalls, deliberate reads). A weak fourth list, reordering only pages the
// other lists already found. Off by default for the same reason as WIKI_ASSOC.
const USE_PRIOR = process.env.WIKI_PRIOR === "1";
const PRIOR_WEIGHT = Number(process.env.WIKI_PRIOR_WEIGHT || 0.2);

// The two GENERATED entry-point kinds — trigger cues (page_cues kind
// 'trigger') and typed fact sentences (lib/wiki-facts.mjs) — are written
// nightly but join the shared KNN matrix only behind these flags, DEFAULT OFF.
// Every consumer of searchPagesHybrid (hum, triage, auto-recall) would be
// re-ranked by them, and short situation-shaped strings are exactly the
// "sharp but promiscuous" vector the 2026-08-09 eval caught a bare heading
// being. So they earn the default on `wiki-recall-eval` (configs +triggers,
// +facts), the bar cues were held to. Facts still feed wiki_read and the
// association graph regardless.
const USE_TRIGGERS = process.env.WIKI_USE_TRIGGERS === "1";
const USE_FACTS = process.env.WIKI_USE_FACTS === "1";

let _db = null;
let _disabled = false;

// Open (once) and ensure the page_embeddings table exists. Returns the db
// handle or null when unavailable — callers must tolerate null.
function db() {
  if (_db) return _db;
  if (_disabled) return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const d = new DatabaseSync(DB_PATH);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA synchronous=NORMAL");
    d.exec("PRAGMA busy_timeout=3000");
    // One embedding per page, keyed by page id. body_hash mirrors
    // pages.body_hash (sha256 of raw_md) so the backfill can detect a changed
    // page and re-embed it — this is the key difference from event_embeddings,
    // whose events never change once appended.
    d.exec(`
      CREATE TABLE IF NOT EXISTS page_embeddings (
        page_id     TEXT PRIMARY KEY,
        model       TEXT,
        dim         INTEGER,
        body_hash   TEXT,
        embedding   BLOB NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);
    // Cue anchors — SEVERAL indexed entry points per page, alongside the single
    // whole-page vector above. See § Cue anchors in the module header for why.
    // `body_hash` mirrors pages.body_hash exactly as page_embeddings does, so
    // the same hash-tracked freshness logic re-cues a page when its body moves.
    d.exec(`
      CREATE TABLE IF NOT EXISTS page_cues (
        page_id     TEXT NOT NULL,
        cue_idx     INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        cue_text    TEXT NOT NULL,
        model       TEXT,
        dim         INTEGER,
        body_hash   TEXT,
        cue_ver     INTEGER NOT NULL DEFAULT 1,
        embedding   BLOB NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (page_id, cue_idx)
      )
    `);
    // Additive migration for a table created before cue_ver existed.
    try {
      const cols = d.prepare("PRAGMA table_info(page_cues)").all();
      if (!cols.some((c) => c.name === "cue_ver")) {
        d.exec("ALTER TABLE page_cues ADD COLUMN cue_ver INTEGER NOT NULL DEFAULT 1");
      }
    } catch {}
    d.exec(
      "CREATE INDEX IF NOT EXISTS idx_page_cues_fresh ON page_cues(page_id, body_hash, cue_ver)",
    );
    _db = d;
    return _db;
  } catch {
    _disabled = true;
    _db = null;
    return null;
  }
}

// The text we embed for a page: title + description + body head. Kept in one
// place so the backfill and any future re-embed agree byte-for-byte.
function embedTextForPage(row) {
  const parts = [row.title, row.description, row.body_md].filter(
    (s) => typeof s === "string" && s.trim(),
  );
  let text = parts.join("\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return text;
}

// ── Cue anchors ───────────────────────────────────────────────────────────
//
// One vector per page is one ENTRY POINT per page, and that is the binding
// constraint on recall as the corpus grows. A person page's single vector is
// smeared across their work, their hobbies and their food preferences, so "who
// handles the supplier emails" has nothing sharp to match — the page is about
// that, but only ~15% about that.
//
// So we index each page through several short cues as well. Each cue is its own
// row in the same matrix; the KNN returns cues, and `searchPagesHybrid`
// collapses them back to pages taking the best cue per page. A page is found if
// ANY of its aspects matches, and the matched cue comes back as provenance.
//
// This is Memora's (Microsoft Research, ICML 2026) primary-abstraction + cue-
// anchor split. Two things we already had map onto it exactly: `description` IS
// the primary abstraction (6-8 words; the live corpus averages 72 chars), and
// the `[[wikilink]]` graph is the cue-to-cue connection the retriever walks.
//
// `kind` records where a cue came from:
//   description — the frontmatter one-liner. Free, already curated, and the
//                 single highest-signal cue on almost every page.
//   heading     — a markdown section heading. Free, structural, and on long
//                 pages it is the only thing that names the page's minor topics.
//   aspect      — LLM-generated paraphrase-shaped entry points (phase 3). The
//                 ones a heading never says: "who handles the supplier emails".
// The table is indifferent to the source, which is what lets the free tiers
// ship first and the generated tier land later without a migration.

// Markdown ATX headings, level 2-4. Level 1 is skipped: it is the page title
// restated, which `description` already covers better.
// lang-regex-ok: matches markdown ATX syntax (machine-generated document
// structure), not natural language — it decides nothing about what anyone meant.
const ATX_HEADING_RE = /^[ \t]{0,3}(#{2,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

// ── Day-page headings are a machine-generated record shape, not prose ─────
//
// `daily-summary-build` emits one heading per stop, always the same way:
//   ### 19:13-19:42 · **<place name>** · 28 min · with [[user_<name>|<Name>]]
// Left alone, those make terrible cues, and eval v2 measured all three reasons:
// the leading timestamp is the bulk of the short string (so every cue on a page
// embeds to roughly "a time on a date" and they are all mutual near-duplicates),
// the trailing duration and companion links add more of the same, and stops the
// builder could not name ("unlabeled", "walking, not a stop") occupy slots that
// a real venue should have had.
//
// So for these, keep the middle: the venue. Parsing it is structure work — the
// producer is a script and the shape is fixed — not a judgment about meaning.

// lang-regex-ok: strips the leading HH:MM-HH:MM stamp emitted by daily-summary-build
const STOP_TIME_PREFIX_RE = /^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*·\s*/;
// lang-regex-ok: strips the trailing "· 28 min" / "· 1h 21m" duration field
const STOP_DURATION_RE = /\s*·\s*\d+\s*h(\s*\d+\s*m)?\s*$|\s*·\s*\d+\s*min\s*$/;
// lang-regex-ok: strips the trailing "· with [[user_<name>|<Name>]]" companion field
const STOP_COMPANION_RE = /\s*·\s*with\s+.*$/i;
// lang-regex-ok: unwraps markdown bold/tilde emphasis around a venue name
const EMPHASIS_RE = /[*~]+/g;
// lang-regex-ok: matches [[id|Display]] / [[id]] wikilink syntax
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Stops the day builder could not name. These are placeholders it writes, not
// things anyone will ever search for.
const UNNAMEABLE_STOPS = new Set([
  "unlabeled",
  "walking, not a stop",
  "walking",
  "mostly walked around",
  "passing through",
  "walked home",
]);

// Section headings that structure the page rather than name a stop.
const DAY_SECTION_HEADINGS = new Set([
  "day's other anchors",
  "corrections & follow-ups",
  "key events",
  "more photos",
  "events not matched to a location",
]);

// Reduce one day-page heading to the venue, or null if there is nothing there.
function stopCueFromHeading(h) {
  let t = String(h || "")
    .replace(STOP_TIME_PREFIX_RE, "")
    .replace(STOP_COMPANION_RE, "")
    .replace(STOP_DURATION_RE, "")
    .replace(WIKILINK_RE, (_m, id, display) => display || id)
    .replace(EMPHASIS_RE, "")
    .trim();
  // A trailing unconfirmed marker the builder adds, e.g. "Bar Example? · unconfirmed".
  const bar = t.indexOf(" · ");
  if (bar > 0) t = t.slice(0, bar).trim();
  // The builder marks an unconfirmed venue as "Bar Example?". Drop that: it is
  // its uncertainty, not part of the name, and a trailing "?" is exactly the
  // question shape rejected elsewhere as a promiscuous cue.
  t = t.replace(/[?.]+$/, "").trim(); // lang-regex-ok: trailing punctuation on a generated venue field
  const key = t.toLowerCase();
  if (!t || t.length < 3) return null;
  if (UNNAMEABLE_STOPS.has(key) || DAY_SECTION_HEADINGS.has(key)) return null;
  return t;
}

// Structural cues for a page: the description, then its section headings.
// Deterministic, free, and runs with no model — the LLM `aspect` tier writes
// into the same table later and is deliberately not required for this to work.
//
// Always returns at least one cue. That is load-bearing for freshness: the
// presence of a cue row carrying the current body_hash is what marks a page as
// cued, so a page that yields no description and no headings must still leave a
// marker or it would be reconsidered on every single pass, forever.
export function cuesForPage(row) {
  const cues = [];
  const seen = new Set();
  // `dedupeOn` is the UNQUALIFIED text when a cue carries a title prefix —
  // otherwise a heading that merely restates the description stops looking like
  // a duplicate the moment the qualifier is glued on, and every such page gets
  // two cues saying the same thing.
  const push = (kind, text, dedupeOn = null) => {
    const t = String(text || "").trim().slice(0, MAX_CUE_TEXT);
    if (t.length < 3) return;
    const keys = [t.toLowerCase(), String(dedupeOn || t).trim().toLowerCase()];
    if (keys.some((k) => seen.has(k))) return;
    for (const k of keys) seen.add(k);
    cues.push({ kind, cue_text: t });
  };

  push("description", row.description);
  // The title is only worth a cue of its own when there is no description to
  // carry the page's identity; otherwise it is near-duplicate signal.
  if (!cues.length) push("description", row.title);

  // Headings are QUALIFIED BY THE PAGE TITLE, and that is not cosmetic — it is
  // the fix for the failure the first live eval exposed (2026-08-09). A bare
  // 2-word heading embeds to a short, high-magnitude vector that scores well
  // against any short query sharing one word, so `project_thermostat_control` ranked
  // #1 for "how do I ship a new version of the iphone app" on the strength of a
  // heading reading "Client app", and `reference_<company>_contract` placed on
  // "Compensation". A diluted whole-page vector is robust; a tiny cue is sharp
  // but promiscuous. "Thermostat Control and Thermostat Server — Client app" keeps the aspect
  // signal while carrying enough of the page's identity to lose honestly.
  // Episodic pages are the exception to the qualifier rule, for the same reason
  // the rule exists. On a curated page the title adds identity to a generic
  // heading. On a day page the title IS a date, so prefixing every stop with
  // "<Weekday, Month D, YYYY> — " makes all of that page's cues near-identical to
  // each other AND to all 106 other day pages — the exact promiscuity the
  // qualifier was introduced to prevent, manufactured by the qualifier itself.
  // A venue name ("<restaurant name>") is already specific; it needs
  // no help. The date stays searchable through the description cue and `pages`.
  const episodic = row.type === "day" || row.type === "week" || row.type === "month";
  const qualifier = episodic ? "" : String(row.title || row.id || "").trim();
  const body = String(row.body_md || "");
  ATX_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = ATX_HEADING_RE.exec(body)) !== null) {
    if (cues.length >= MAX_CUES_PER_PAGE) break;
    const raw = m[2].trim();
    if (raw.length < 3) continue;
    if (episodic) {
      const stop = stopCueFromHeading(raw);
      if (stop) push("heading", stop, stop);
      continue;
    }
    push("heading", qualifier ? `${qualifier} — ${raw}` : raw, raw);
  }

  // Last-resort marker (see the freshness note above): a page with no
  // description, no title and no headings still gets one row.
  if (!cues.length) push("description", row.id);
  return cues.slice(0, MAX_CUES_PER_PAGE);
}

// ── Trigger cues (the generated tier) ─────────────────────────────────────
//
// Structural cues are free but bounded by what the page says about ITSELF. The
// biggest recall failure measured across 2026's memory benchmarks is not a
// missing hop but a missing cue: the situation that should bring a memory up
// shares no words with it. "Planning dinner Friday" should bring up a guest's
// dietary restriction; "<child>'s birthday is coming" should bring up what they are into. Keep It
// InMind (arXiv 2607.24368) measured six vector, graph and agentic memory
// systems answering at most 14.4% of such indirect-cue queries; no query-time
// traversal fixes it, because there is nothing in the query to traverse FROM.
//
// T-Mem (Tencent, arXiv 2606.15405) fixes it at WRITE time, and this is that:
// for each page a model writes TRIGGER cues — the future situations in which
// this page should be recalled, phrased the way that situation would come up —
// and they are indexed as entry points like any other cue (`kind = 'trigger'`).
// Query time is unchanged; the whole cost is the nightly write.
//
// History. This slot held "aspect" cues (2026-08-09): paraphrases of what the
// page says. Built, never enabled, because a 13-page sample had gemma3:1b write
// meta-questions ("What is the primary destination for this travel plan?") and
// invented tasks ("Check for overlapping flights between flights from <airport> to
// <airport>", which the page never said) — and the second kind is well-formed, so no
// shape check caught it. Two changes make the tier shippable:
//   1. Every trigger must carry `evidence`: the words on the page that make it
//      relevant, quoted VERBATIM (checked in code, model-ladder.quoteIn). An
//      invented task has nothing to quote. A reply where more triggers fail
//      than pass fails validation, which is what climbs the ladder.
//   2. The ask is "when should this come up?" rather than "rephrase this",
//      which is what an entry point is for.
//
// Rule #0b ladder: local first, Sonnet only on validation failure, Sonnet calls
// capped per run (TRIGGER_ESCALATION_CAP) because a pass over ~900 pages must
// not fork Sonnet 900 times on a bad local night. Pages that miss the cap keep
// their structural cues and are retried on the next pass.
//
// Only curated types get triggers (TRIGGER_TYPES). A day page records what
// happened; "when should this come up" is a question about who someone is and
// what they want, which is what user / feedback / project / reference hold.

// Sonnet escalations per embedPendingPages call.
const TRIGGER_ESCALATION_CAP = Number(process.env.WIKI_TRIGGER_ESCALATION_CAP || process.env.WIKI_ASPECT_ESCALATION_CAP || 25);
// Body head handed to the cue writer. Enough to see what a page is about
// without paying for a 45k-char narrative.
const TRIGGER_BODY_CHARS = 3000;
export const TRIGGER_TYPES = (process.env.WIKI_TRIGGER_TYPES || "user,feedback,project,reference")
  .split(",").map((t) => t.trim()).filter(Boolean);

function triggerPrompt(row, existing) {
  const avoid = existing.length
    ? `\nAlready indexed under these, so do NOT repeat them:\n${existing.map((c) => `- ${c}`).join("\n")}`
    : "";
  return `You are building the memory of a personal assistant. Below is one page of what it knows about the person it works for.

Write 3 to 6 TRIGGER cues for this page: future situations in which the assistant should remember this page, written the way that situation would come up in conversation or planning.

Rules:
- A trigger names a SITUATION, not the page's topic.
  Good (page: "allergic to shellfish"): "booking a restaurant for dinner", "hosting friends at home", "ordering room service on a trip"
  Bad: "shellfish allergy", "their allergies"
- Each trigger covers a DIFFERENT situation.
- Under 12 words each. Not a question. No numbering, no punctuation at the end.
- For each trigger, "evidence" is the exact words from the page that make it relevant (at least 3 words). Copy them, never paraphrase.
- Only situations the page supports. Never invent a fact.${avoid}

Return ONLY this JSON, nothing else:
{"cues": [{"cue": "...", "evidence": "..."}]}

TITLE: ${row.title || row.id}
DESCRIPTION: ${row.description || "(none)"}
BODY:
${String(row.body_md || "").slice(0, TRIGGER_BODY_CHARS)}`;
}

// Pull the JSON object out of a model reply that may be fenced or prefaced.
// Brace-scanning rather than a pattern: this is structure, and a slice cannot
// misread it the way a greedy match can.
function parseJsonObject(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

// One trigger's problem, or null. Exported via validateTriggers for tests.
//
// The question guard is not stylistic: a question is query-shaped, so an
// indexed one matches any question-shaped query about anything — the same
// promiscuity failure as a bare 2-word heading, arrived at from the other side.
function triggerProblem(c, source) {
  if (!c || typeof c !== "object") return "not an object";
  const cue = typeof c.cue === "string" ? c.cue.trim() : "";
  if (cue.length < 3) return "empty cue";
  if (cue.length > MAX_CUE_TEXT) return "cue too long";
  if (cue.endsWith("?")) return `cue is a question: "${cue}"`;
  if (!quoteIn(c.evidence, source)) return `evidence not on the page: "${String(c.evidence || "").slice(0, 60)}"`;
  return null;
}

// Returns an error string, or null when the payload is usable: the right
// shape, at least two triggers that pass, and no more failing than passing.
export function validateTriggers(parsed, source) {
  if (!parsed || typeof parsed !== "object") return "not an object";
  if (!Array.isArray(parsed.cues)) return "cues is not an array";
  const problems = parsed.cues.map((c) => triggerProblem(c, source));
  const ok = problems.filter((p) => p == null).length;
  const bad = problems.filter(Boolean);
  if (ok < 2) return `only ${ok} usable trigger(s)${bad.length ? `: ${bad[0]}` : ""}`;
  if (bad.length > ok) return `${bad.length} of ${problems.length} triggers failed: ${bad[0]}`;
  return null;
}

// Generate trigger cues for one page via the ladder. `chatFn(prompt)` is the
// local rung and `escalateFn(prompt)` the Sonnet one; either may be null, and a
// page that produces nothing simply keeps its structural cues. Only triggers
// that individually pass are returned.
export async function generateTriggerCues(row, { chatFn, escalateFn = null, existing = [] } = {}) {
  const prompt = triggerPrompt(row, existing);
  const source = [row.title, row.description, row.body_md].filter(Boolean).join("\n");
  const seen = new Set(existing.map((c) => c.toLowerCase()));
  const rungs = [chatFn, escalateFn].filter((f) => typeof f === "function");

  for (const run of rungs) {
    let parsed = null;
    try {
      parsed = parseJsonObject(await run(prompt));
    } catch {
      continue; // rung unavailable (Ollama down, fork failed) — try the next
    }
    if (validateTriggers(parsed, source)) continue; // failed validation — climb
    const out = [];
    for (const c of parsed.cues) {
      if (triggerProblem(c, source)) continue;
      const t = c.cue.trim().slice(0, MAX_CUE_TEXT);
      if (seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push({ kind: "trigger", cue_text: t });
    }
    if (out.length) return out;
  }
  return [];
}

// Replace every cue for one page, in a transaction. Called from
// embedPendingPages once the cue vectors are in hand.
function writeCues(d, pageId, bodyHash, model, cues) {
  const del = d.prepare("DELETE FROM page_cues WHERE page_id = ?");
  const ins = d.prepare(
    `INSERT OR REPLACE INTO page_cues(page_id, cue_idx, kind, cue_text, model, dim, body_hash, cue_ver, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  d.exec("BEGIN IMMEDIATE");
  try {
    del.run(pageId);
    cues.forEach((c, i) => {
      ins.run(pageId, i, c.kind, c.cue_text, model, c.vec.length, bodyHash,
              CUE_LOGIC_VERSION, packF32(c.vec));
    });
    d.exec("COMMIT");
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// Embed one text, retrying with a shorter head if the model rejects it as too
// long for its context window. Salvages long day/week narratives (their gist is
// early) instead of dropping them from semantic recall entirely.
async function embedWithOverflowRetry(embedFn, text) {
  try {
    return await embedFn(text);
  } catch (e) {
    const msg = String(e?.message || e);
    // lang-regex-ok: matches Ollama/HTTP error strings, not natural language
    if (/context length|too (long|large)|exceeds|maximum context|413/i.test(msg)) {
      return await embedFn(text.slice(0, OVERFLOW_RETRY_TEXT));
    }
    throw e;
  }
}

// Drop embeddings whose page no longer exists (deleted/renamed). Cheap hygiene;
// keeps KNN from scanning dead rows. Returns rows removed.
function pruneOrphans(d) {
  let n = 0;
  try {
    n += d
      .prepare(
        "DELETE FROM page_embeddings WHERE page_id NOT IN (SELECT id FROM pages)",
      )
      .run().changes || 0;
  } catch {}
  try {
    // Cues are per-page too, so a deleted page orphans a whole cluster of them.
    n += d
      .prepare("DELETE FROM page_cues WHERE page_id NOT IN (SELECT id FROM pages)")
      .run().changes || 0;
  } catch {}
  return n;
}

// Embed active pages that are missing an embedding OR whose body changed since
// they were last embedded. `embedFn` is an async (text) => number[] (prod:
// localLlmEmbed via Ollama; tests: a toy). Never on the savePage hot path — run
// from the `wiki-embed` CLI or the nightly cron. Returns { embedded, remaining,
// pruned, errors }. Bails early if the embedder starts failing (Ollama down).
export async function embedPendingPages({
  embedFn,
  limit = 300,
  model = EMBED_MODEL,
  // Trigger-cue tier. Off by default: it costs a model call per page, so it
  // belongs to the nightly launchd run and never to an ad-hoc one. The
  // `aspect*` names are the 2026-08-09 spelling, still accepted.
  triggers = false,
  triggerChatFn = null,
  triggerEscalateFn = null,
  aspects = false,
  aspectChatFn = null,
  aspectEscalateFn = null,
} = {}) {
  const genOn = !!(triggers || aspects);
  const genLocal = triggerChatFn || aspectChatFn;
  const genSonnet = triggerEscalateFn || aspectEscalateFn;
  const d = db();
  if (!d || typeof embedFn !== "function") {
    return { embedded: 0, cued: 0, triggered: 0, remaining: 0, pruned: 0, errors: ["no db or embedFn"] };
  }
  const pruned = pruneOrphans(d);

  // When the trigger tier is on, "cued" means cued INCLUDING a trigger row for
  // the types that get triggers — otherwise turning it on over an already-
  // structurally-cued corpus would select no pages at all and silently do
  // nothing. Expressed in the freshness predicate rather than as a --recue
  // flag so it stays self-tracking and idempotent: each pass makes real
  // progress and the loop terminates. Types outside TRIGGER_TYPES are never
  // selected for triggers, or they would be reconsidered every pass forever.
  //
  // Known cost of this shape: a page the cue writer never produces triggers for
  // stays pending and is retried nightly (one local call, plus Sonnet within
  // the cap). That is deliberate — the alternative is a sentinel row polluting
  // the index — and it is visible, because a systematically failing prompt
  // shows up as `triggered: 0`.
  const triggerTypesSql = TRIGGER_TYPES.map((t) => `'${t.split("'").join("")}'`).join(",") || "''";
  const cuedPredicate = genOn
    ? `(NOT EXISTS (SELECT 1 FROM page_cues c
                     WHERE c.page_id = p.id AND c.body_hash = p.body_hash
                       AND c.cue_ver = ${CUE_LOGIC_VERSION})
        OR (p.type IN (${triggerTypesSql})
            AND NOT EXISTS (SELECT 1 FROM page_cues c
                             WHERE c.page_id = p.id AND c.body_hash = p.body_hash
                               AND c.kind = 'trigger')))`
    : `NOT EXISTS (SELECT 1 FROM page_cues c
                    WHERE c.page_id = p.id AND c.body_hash = p.body_hash
                       AND c.cue_ver = ${CUE_LOGIC_VERSION})`;
  const stalePredicate =
    `((e.page_id IS NULL OR e.body_hash IS NULL OR e.body_hash <> p.body_hash) OR ${cuedPredicate})`;

  let rows;
  try {
    // A page needs work when its whole-page embedding is missing/stale, OR its
    // cues are (both keyed on body_hash, so a body edit invalidates both). The
    // two are tracked separately because cues were added after page_embeddings:
    // on the first pass over an already-embedded corpus every page needs cues
    // and none needs re-embedding.
    rows = d
      .prepare(
        `SELECT p.id, p.type, p.title, p.description, p.body_md, p.body_hash,
                (e.page_id IS NULL OR e.body_hash IS NULL OR e.body_hash <> p.body_hash) AS need_page,
                ${cuedPredicate} AS need_cues
         FROM pages p
         LEFT JOIN page_embeddings e ON e.page_id = p.id
         WHERE p.status = 'active' AND ${stalePredicate}
         ORDER BY p.updated_at DESC
         LIMIT ?`,
      )
      .all(limit);
  } catch (e) {
    return { embedded: 0, cued: 0, triggered: 0, remaining: 0, pruned, errors: [e.message] };
  }

  const ins = d.prepare(
    `INSERT OR REPLACE INTO page_embeddings(page_id, model, dim, body_hash, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  const errors = [];
  let embedded = 0;
  let cued = 0;
  let triggered = 0;
  let escalations = 0; // Sonnet forks spent this run (see TRIGGER_ESCALATION_CAP)
  // Every Sonnet call counts against the cap — including the ones that
  // succeed. (The 2026-08-09 version only counted pages where BOTH rungs
  // failed, so a local rung failing on every page forked Sonnet uncapped.)
  const cappedSonnet = genSonnet
    ? async (prompt) => {
        escalations++;
        return genSonnet(prompt);
      }
    : null;
  let connErrors = 0; // consecutive Ollama-down errors → bail
  // A connection failure means Ollama is down: bail rather than hammer it. Any
  // other error is this page's problem alone and must not abort the backfill.
  const isConnError = (msg) =>
    // lang-regex-ok: matches Node/undici transport error strings, not language
    /fetch failed|ECONNREFUSED|ENOTFOUND|network|socket|abort|timed? ?out/i.test(msg);

  outer: for (const r of rows) {
    if (r.need_page) {
      const text = embedTextForPage(r);
      if (text) {
        try {
          const vec = await embedWithOverflowRetry(embedFn, text);
          if (!Array.isArray(vec) || !vec.length) {
            errors.push(`page ${r.id}: empty embedding`);
          } else {
            ins.run(r.id, model, vec.length, r.body_hash, packF32(vec));
            embedded++;
            connErrors = 0;
          }
        } catch (e) {
          const msg = String(e?.message || e);
          errors.push(`page ${r.id}: ${msg}`);
          if (isConnError(msg) && ++connErrors >= 3) break outer;
        }
      }
    }

    if (r.need_cues) {
      // Cues are short by construction (MAX_CUE_TEXT), so no overflow retry is
      // needed — but one bad cue must not cost the page its other entry points,
      // so each is embedded independently and the page is written with whatever
      // succeeded.
      const structural = cuesForPage(r);
      let cues = structural;
      if (genOn && TRIGGER_TYPES.includes(r.type)) {
        // Generated cues ADD to the structural ones rather than replacing them:
        // the description is still the single highest-signal cue on most pages,
        // and a model having a bad night must not cost a page its known-good
        // entry points.
        const gen = await generateTriggerCues(r, {
          chatFn: genLocal,
          escalateFn: escalations < TRIGGER_ESCALATION_CAP ? cappedSonnet : null,
          existing: structural.map((c) => c.cue_text),
        }).catch(() => []);
        if (gen.length) {
          triggered++;
          cues = [...structural, ...gen].slice(0, MAX_CUES_PER_PAGE + gen.length);
        }
      }
      const withVecs = [];
      let cueConnFailed = false;
      for (const c of cues) {
        try {
          const vec = await embedFn(c.cue_text);
          if (Array.isArray(vec) && vec.length) withVecs.push({ ...c, vec });
        } catch (e) {
          const msg = String(e?.message || e);
          errors.push(`cue ${r.id}[${c.kind}]: ${msg}`);
          if (isConnError(msg)) {
            cueConnFailed = true;
            break;
          }
        }
      }
      if (cueConnFailed) {
        if (++connErrors >= 3) break outer;
      } else if (withVecs.length) {
        try {
          writeCues(d, r.id, r.body_hash, model, withVecs);
          cued++;
          connErrors = 0;
        } catch (e) {
          errors.push(`cue-write ${r.id}: ${e.message}`);
        }
      }
    }
  }

  let remaining = 0;
  try {
    remaining = d
      .prepare(
        `SELECT COUNT(*) AS n
         FROM pages p
         LEFT JOIN page_embeddings e ON e.page_id = p.id
         WHERE p.status = 'active' AND ${stalePredicate}`,
      )
      .get().n;
  } catch {}
  // This process just changed the vectors, and same-handle writes do not move
  // `PRAGMA data_version` — so drop the packed matrix explicitly rather than
  // leaning on the rowid backstop in the version token.
  if (embedded || cued || pruned) clearVectorIndexCache(`wiki:${DB_PATH}`);
  return { embedded, cued, triggered, sonnet_calls: escalations, remaining, pruned, errors };
}

// ── Associative recall ────────────────────────────────────────────────────
//
// The graph and the propagation live in lib/wiki-assoc.mjs (pure, tested
// without SQLite). This module supplies what only it has: the DB handle, the
// packed vector matrix the soft gate scores against, and the fused seeds.

function assocGraph(d) {
  return cachedAssocGraph(d, `wiki-assoc:${DB_PATH}`, assocGraphVersion(d));
}

// Seed map from a fused list: id → RRF score (the propagation normalizes).
function seedsFrom(fused, n) {
  const m = new Map();
  for (const f of fused.slice(0, n)) if (f.id != null) m.set(f.id, f.rrf || 1);
  return m;
}

// The association list for one query. `cosByPage` is the best cue cosine per
// page (one sweep of the matrix); null means "no query vector" and disables
// the gate rather than burying every page.
function associationList(d, seeds, { method, cosByPage, type, after, before, limit }) {
  if (!seeds.size || method === "off") return [];
  const graph = assocGraph(d);
  const gate = cosByPage ? (id) => softGate(cosByPage.get(id)) : null;
  return associate(graph, seeds, {
    method,
    gate,
    limit,
    exclude: (id) =>
      (type && graph.type[graph.idx.get(id)] !== type) || !inDateWindow(id, after, before),
  });
}

// Base-level prior as a ranked list, restricted to `candidates` (it may only
// reorder what the direct retrievers found, never add).
function priorList(d, candidates) {
  if (!candidates.size) return [];
  let rows = [];
  try {
    const ids = [...candidates];
    const ph = ids.map(() => "?").join(",");
    rows = d
      .prepare(`SELECT page_id AS id, base_level FROM page_activation WHERE page_id IN (${ph})`)
      .all(...ids);
  } catch {
    return [];
  }
  return rows.sort((a, b) => b.base_level - a.base_level);
}

function hasTable(d, name) {
  try {
    return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

// Hybrid recall: fuse the wiki's BM25 ranking (wiki-store.searchPages, so the
// type-weighting + pinned boost is preserved) with a vector-KNN ranking via
// RRF. `embedQuery` is an async (text) => number[] used to embed the query
// once. Degrades gracefully: if embedQuery is missing/throws, the db is
// unavailable, or nothing is embedded, returns the pure-FTS result (same shape
// as searchPages). Result rows carry an added `via` tag ("hybrid"|"fts").
//
// `after` / `before` (YYYY-MM-DD, inclusive) scope EPISODIC pages (day / week /
// month) to a date window and leave every other page alone. Interpreting "last
// spring" is language and belongs to the calling agent (Rule #0b); this only
// applies the dates it was handed.
//
// `assoc` overrides WIKI_ASSOC for one call ("off" | "sa" | "ppr") — how the
// eval harness and the wiki_associate tool reach the association list without
// changing the default for every other consumer.
export async function searchPagesHybrid(
  query,
  { limit = 10, type = null, embedQuery = null, match = "auto", after = null, before = null, assoc = null, prior = null } = {},
) {
  if (!query || !query.trim()) return [];
  const method = assoc === "sa" || assoc === "ppr" || assoc === "off" ? assoc : ASSOC_METHOD;
  const usePrior = prior == null ? USE_PRIOR : !!prior;
  const inWin = (r) => inDateWindow(r.id, after, before);

  // Lexical half — authoritative ranking from wiki-store. Pull a wide
  // candidate set so a page the vector side loves can still be fused in.
  //
  // `match` is passed straight through (see wiki-store.searchPages). The
  // default is now "auto" — AND, then topped up from OR — which closes the hole
  // this comment used to describe: under a bare "and" a sentence-shaped query
  // yielded NO lexical rows, leaving the fused result semantic-only and
  // unfloorable. eval v2 measured that as a flat 0% hit@5 for pure FTS.
  const ftsRows = ws
    .searchPages(query, { mode: "fts", limit: CANDIDATES, type, match })
    .filter(inWin);

  const d = db();
  const factsOn = USE_FACTS && d ? hasTable(d, "page_facts") : false;
  // One COUNT, doing double duty: the "is anything embedded at all" gate below,
  // and half the cache-version token for the packed matrix. (It used to be a
  // per-query count whose only job was the gate.)
  //
  // Counted across EVERY vector source — the whole-page embeddings, the cue
  // anchors and the fact rows — because any one alone can be what changed.
  const embStat = d
    ? (() => {
        try {
          const p = d
            .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS mx FROM page_embeddings")
            .get();
          const c = d
            .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS mx FROM page_cues")
            .get();
          const f = factsOn
            ? d
                .prepare(
                  `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS mx,
                          COALESCE(SUM(f.expired_at IS NOT NULL), 0) AS ex
                     FROM page_facts f WHERE f.embedding IS NOT NULL`,
                )
                .get()
            : { n: 0, mx: 0 };
          // `ex` too: expiring a fact changes what the matrix may hold
          // without changing any row count or rowid.
          return { n: p.n + c.n + f.n, mx: `${p.mx}.${c.mx}.${f.mx}.${f.ex || 0}` };
        } catch {
          return { n: 0, mx: 0 };
        }
      })()
    : { n: 0, mx: 0 };
  const embCount = embStat.n;

  let qVec = null;
  if (typeof embedQuery === "function" && embCount > 0) {
    try {
      qVec = await embedQuery(query);
    } catch {
      qVec = null;
    }
  }
  if (!d || !qVec || !qVec.length) {
    // No vectors. Association still works off the lexical seeds — the graph
    // needs no embedding — it just runs ungated.
    if (d && method !== "off" && ftsRows.length) {
      try {
        const seeds = seedsFrom(rrfFuse([ftsRows], (r) => r.id, { limit: ASSOC_SEEDS }), ASSOC_SEEDS);
        const assocRows = associationList(d, seeds, {
          method, cosByPage: null, type, after, before, limit: ASSOC_CAP,
        });
        if (assocRows.length) return fuseAndShape([ftsRows, [], assocRows], { limit, via: "fts" });
      } catch {}
    }
    return ftsRows.slice(0, limit).map((r) => ({ ...r, via: "fts" }));
  }

  // Semantic half — KNN over a packed matrix of embedded active pages, built
  // once per corpus version rather than unpacked per query (see
  // hybrid-recall.buildVectorIndex for the measurement that motivated it).
  //
  // Version token, three cheap signals because each covers a different writer:
  //   PRAGMA data_version — bumps when ANOTHER connection commits, which is how
  //     the out-of-band `wiki-embed` cron and the `wiki` CLI reach this DB from
  //     a long-lived MCP/phone-channel process. It does NOT move for writes on
  //     this same handle.
  //   COUNT(*)            — pages added or pruned.
  //   MAX(rowid)          — a RE-embed of an existing page. The upsert is
  //     `INSERT OR REPLACE`, so a refreshed row is deleted and reinserted with a
  //     fresh rowid; count is unchanged but max moves. `embedPendingPages` also
  //     clears the cache explicitly, so this is the backstop, not the contract.
  // All err toward rebuilding: a spurious rebuild costs a few ms, a missed one
  // serves stale vectors until restart.
  //
  // The matrix spans every ACTIVE page regardless of `type`; the caller's type
  // filter is applied per query through `allow`, so one matrix serves every
  // scoping without a rebuild.
  let semRanked = [];
  let vecIndex = null; // hoisted: the association gate scores against it
  try {
    const dataVersion = (() => {
      try {
        return d.prepare("PRAGMA data_version").get().data_version;
      } catch {
        return 0;
      }
    })();
    // USE_CUES belongs in the token because `hybrid-recall`'s index cache is
    // module-scoped and therefore SHARED across re-imports of this module —
    // without it, an eval run that re-imports with cues off would silently be
    // served the cues-on matrix and report a meaningless delta. Same for facts.
    const version = `${dataVersion}:${embCount}:${embStat.mx}:c${USE_CUES ? 1 : 0}t${USE_TRIGGERS ? 1 : 0}f${factsOn ? 1 : 0}`;
    const index = cachedVectorIndex(
      `wiki:${DB_PATH}`,
      version,
      () =>
        // One matrix, three sources: the whole-page vector (cue_kind='page'),
        // every cue anchor, and every CURRENT fact row (a fact is an entry
        // point into its subject page — "<person> handles the supplier
        // emails" is a far sharper target than the page it lives on). They
        // are deliberately NOT weighted differently here — a row that beats
        // the whole-page vector on cosine has genuinely matched the aspect the
        // query was about, and that is the entire point.
        d
          .prepare(
            `SELECT p.id, p.basename, p.type, p.title, p.description, p.status, p.pinned,
                    NULL AS cue, 'page' AS cue_kind, e.embedding AS embedding
             FROM page_embeddings e
             JOIN pages p ON p.id = e.page_id
             WHERE p.status = 'active'` +
              (USE_CUES
                ? `
             UNION ALL
             SELECT p.id, p.basename, p.type, p.title, p.description, p.status, p.pinned,
                    c.cue_text AS cue, c.kind AS cue_kind, c.embedding AS embedding
             FROM page_cues c
             JOIN pages p ON p.id = c.page_id
             WHERE p.status = 'active'${USE_TRIGGERS ? "" : " AND c.kind <> 'trigger'"}`
                : "") +
              (factsOn
                ? `
             UNION ALL
             SELECT p.id, p.basename, p.type, p.title, p.description, p.status, p.pinned,
                    f.fact_text AS cue, 'fact' AS cue_kind, f.embedding AS embedding
             FROM page_facts f
             JOIN pages p ON p.id = f.src_id
             WHERE p.status = 'active' AND f.embedding IS NOT NULL
               AND ${CURRENT_FACT_SQL}`
                : ""),
          )
          .all(),
    );
    // The KNN ranks CUES; several can belong to one page, so pull wide and
    // collapse to the best cue per page to get back to a page-level ranking.
    semRanked = collapseByKey(
      knnIndex(index, qVec, CUE_CANDIDATES, {
        allow:
          type || after || before
            ? (r) => (!type || r.type === type) && inDateWindow(r.id, after, before)
            : null,
      }),
      (r) => r.id,
      { limit: CANDIDATES },
    );
    vecIndex = index;
  } catch {
    semRanked = [];
  }

  // ── Association (third ranking list) ────────────────────────────────────
  // Seeds are the top of a provisional [lexical, semantic] fusion — the pages
  // both halves already believe in — weighted by their fused score. What comes
  // back is every page those seeds' activation reached, scaled by fan (hubs
  // carry little) and by a SOFT gate on how much the page resembles the query.
  let assocRows = [];
  if (method !== "off" && (ftsRows.length || semRanked.length)) {
    try {
      const seeds = seedsFrom(
        rrfFuse([ftsRows, semRanked], (r) => r.id, { limit: ASSOC_SEEDS }),
        ASSOC_SEEDS,
      );
      const cosByPage = vecIndex ? bestScoreByKey(vecIndex, qVec) : null;
      assocRows = associationList(d, seeds, {
        method, cosByPage, type, after, before, limit: ASSOC_CAP,
      }).map((r) => ({ ...r, score: cosByPage?.get(r.id) ?? null }));
    } catch {
      assocRows = [];
    }
  }

  let priorRows = [];
  if (usePrior) {
    try {
      priorRows = priorList(d, new Set([...ftsRows, ...semRanked].map((r) => r.id)));
    } catch {
      priorRows = [];
    }
  }

  return fuseAndShape([ftsRows, semRanked, assocRows, priorRows], { limit, via: "hybrid" });
}

// Fuse [lexical, semantic, association, prior] by page id and shape the rows
// every consumer reads. Factored out so the no-vector path (association off
// lexical seeds only) returns exactly the same shape.
function fuseAndShape([ftsRows, semRanked, assocRows = [], priorRows = []], { limit, via }) {
  // Prefer the FTS row as the display base (it carries the matched-span
  // snippet); fall back to the semantic row, then the association row, which
  // carries no page fields of its own and is completed from `pages` below.
  const byId = new Map();
  for (const r of semRanked) byId.set(r.id, r);
  for (const r of ftsRows) byId.set(r.id, r); // FTS overwrites — has snippet
  // Keep the cosine separately: `byId` is overwritten by the FTS row for any
  // page both halves found, which silently discarded the semantic score for
  // exactly the strongest hits.
  const cosById = new Map();
  for (const r of assocRows) if (r.score != null) cosById.set(r.id, r.score);
  for (const r of semRanked) cosById.set(r.id, r.score);
  // Which cue actually won for this page — the useful half of the provenance.
  // Same reason `cosById` exists: the FTS row overwrites the semantic row in
  // `byId`, so the cue would otherwise be lost on exactly the strongest hits.
  const cueById = new Map();
  for (const r of semRanked) {
    if (r.cue) cueById.set(r.id, { cue: r.cue, cue_kind: r.cue_kind });
  }
  const assocById = new Map(assocRows.map((r) => [r.id, r]));
  const ftsIds = new Set(ftsRows.map((r) => r.id));
  const semIds = new Set(semRanked.map((r) => r.id));
  // Four lists, fused in one pass so the RRF ranks stay mutually consistent.
  // Association is a genuine third opinion, not a post-hoc append: a page that
  // the seeds' activation converges on AND the query resembles outranks one
  // with only a mediocre showing on a single list.
  const fused = rrfFuse([ftsRows, semRanked, assocRows, priorRows], (r) => r.id, {
    limit,
    weights: [1, 1, ASSOC_WEIGHT, PRIOR_WEIGHT],
  });
  // Association-only hits arrive as bare {id, activation, ...}; fill in their
  // page fields from the store so a consumer sees a normal row.
  const missing = fused.filter((f) => !byId.has(f.id)).map((f) => f.id);
  if (missing.length) {
    for (const id of missing) {
      const p = ws.getPage(id);
      if (p) byId.set(id, { id: p.id, basename: p.basename, type: p.type, title: p.title,
        description: p.description, status: p.status, pinned: p.pinned });
    }
  }
  return fused.map((f) => {
    const base = byId.get(f.id) || {};
    const lexical = ftsIds.has(f.id);
    const semantic = semIds.has(f.id);
    const a = assocById.get(f.id);
    return {
      id: base.id ?? f.id,
      basename: base.basename,
      type: base.type,
      title: base.title,
      description: base.description,
      status: base.status,
      pinned: !!base.pinned,
      // NOTE: two different scales, deliberately kept apart rather than
      // blended. `score` is BM25 (negative; nearer 0 = weaker) and exists only
      // for pages the lexical half matched. `cosine` is 0..1 and exists only
      // for pages the semantic half ranked (or the association gate scored).
      // A caller that wants a relevance FLOOR must threshold them separately —
      // there is no single comparable number here, and inventing one is how
      // you end up suppressing real hits.
      // (Before 2026-07-29 neither survived into unified-recall at all, so no
      // consumer could threshold anything; that is what made the hum tick's
      // wiki recall unfixable from the outside.)
      // `score` is BM25 ONLY. It must not carry a cosine: `base` is the
      // semantic row for any page the lexical half didn't match, and that row's
      // `.score` is its cosine (0..1, positive) — so the un-guarded version
      // emitted positive "bm25" values of 0.6-0.7 to consumers that reasonably
      // read `score` as BM25 (which is always negative). Any BM25 floor built
      // on this field would have silently inverted. Caught 2026-07-29 while
      // giving auto-recall a floor; the comment below already claimed this
      // invariant while the code broke it.
      score: lexical && base.score != null ? base.score : null,
      cosine: cosById.has(f.id) ? cosById.get(f.id) : null,
      matched: lexical
        ? semantic
          ? "both"
          : "lexical"
        : semantic
          ? "semantic"
          : a
            ? "linked"
            : "prior",
      // Set only on a page the direct search did NOT find — it is here because
      // the seeds' activation reached it through the graph. `expanded_from`
      // names the seed its strongest path started at, `assoc_via` the kind of
      // the last edge on that path (wikilink, backlink, next_day, fact:…,
      // hebbian…), and `activation` how much it received.
      expanded_from: !lexical && !semantic && a ? a.from : null,
      assoc_via: a ? a.via : null,
      activation: a ? a.activation : null,
      // Which cue anchor the semantic half matched on, when it was a cue rather
      // than the whole-page vector. Null means the page matched as a whole (or
      // lexically only) — NOT that cues are absent.
      cue: cueById.get(f.id)?.cue ?? null,
      cue_kind: cueById.get(f.id)?.cue_kind ?? null,
      heading: null,
      snippet:
        base.snippet ||
        // A cue-only hit has no FTS snippet, and the cue explains the match far
        // better than the page description does — it IS the matched span.
        (cueById.has(f.id) ? `«${cueById.get(f.id).cue}»` : "") ||
        (base.description ? `«${base.description}»` : ""),
      via,
      rrf: f.rrf,
    };
  });
}

// "Recall this and bring up what's associated with it." The direct entry point
// behind the wiki_associate tool — opt-in by nature, so it uses association
// whatever WIKI_ASSOC says.
//
//   ids    seed pages, equal weight (e.g. "everything tied to user_<person>")
//   query  seeds from a hybrid search instead (or as well), and gates the
//          spread by resemblance to the query
//
// Returns { seeds:[id], results:[{ id, type, title, description, activation,
// from, via, hops }] } — the seeds themselves excluded unless several seeds
// converge on one another.
export async function associatePages({
  ids = [],
  query = null,
  limit = 15,
  type = null,
  after = null,
  before = null,
  method = "sa",
  embedQuery = null,
} = {}) {
  const d = db();
  if (!d) return { seeds: [], results: [] };
  const seeds = new Map();
  for (const id of ids || []) if (ws.getPage(id)) seeds.set(id, 1);
  let cosByPage = null;
  if (query && String(query).trim()) {
    const hits = await searchPagesHybrid(query, { limit: ASSOC_SEEDS, embedQuery, assoc: "off" });
    for (const h of hits) if (!seeds.has(h.id)) seeds.set(h.id, h.rrf || 1);
    if (typeof embedQuery === "function") {
      try {
        const qVec = await embedQuery(query);
        const idx = cachedVectorIndexForGate(d);
        if (idx && qVec?.length) cosByPage = bestScoreByKey(idx, qVec);
      } catch {}
    }
  }
  if (!seeds.size) return { seeds: [], results: [] };
  const rows = associationList(d, seeds, {
    method: method === "ppr" ? "ppr" : "sa",
    cosByPage,
    type,
    after,
    before,
    limit: limit + seeds.size,
  });
  const results = [];
  for (const r of rows) {
    if (seeds.has(r.id) && !r.from) continue;
    const p = ws.getPage(r.id);
    if (!p) continue;
    results.push({
      id: r.id,
      type: p.type,
      title: p.title,
      description: p.description,
      activation: r.activation,
      from: r.from,
      via: r.via,
      hops: r.hops,
      cosine: cosByPage?.get(r.id) ?? null,
    });
    if (results.length >= limit) break;
  }
  return { seeds: [...seeds.keys()], results };
}

// episode_search with association: FTS over day pages (the measured-best
// episodic retriever, 79% hit@5 against wiki_search hybrid's 64%) as the seeds
// AND the first list, then spreading activation scoped to day pages as the
// second. That is context reinstatement: the days the words matched pass their
// activation through the people, places and trips they link to, and on to the
// OTHER days those link to, and through contiguity to the day before and
// after. "Which outing did <friend> come along to" lands on a day with that friend even when
// the page never says "outing" in the words used.
//
// Pure FTS + graph — no embedder, so it keeps episode_search's instant, local
// character. Returns rows shaped like wiki-store.searchPages, plus `matched`
// ("lexical" | "linked" | "both") and, for linked rows, `expanded_from`/`via`.
export function searchDaysAssociative(query, { limit = 8, after = null, before = null, method = "sa" } = {}) {
  const fts = ws
    .searchPages(query, { mode: "fts", limit: Math.max(limit * 3, CANDIDATES), type: "day" })
    .filter((r) => inDateWindow(r.id, after, before));
  const d = db();
  if (!d || !fts.length) return fts.slice(0, limit).map((r) => ({ ...r, matched: "lexical" }));
  let assocRows = [];
  try {
    const seeds = seedsFrom(rrfFuse([fts], (r) => r.id, { limit: ASSOC_SEEDS }), ASSOC_SEEDS);
    assocRows = associationList(d, seeds, {
      method: method === "ppr" ? "ppr" : "sa", cosByPage: null, type: "day", after, before, limit: ASSOC_CAP,
    });
  } catch {
    assocRows = [];
  }
  const ftsById = new Map(fts.map((r) => [r.id, r]));
  const assocById = new Map(assocRows.map((r) => [r.id, r]));
  const fused = rrfFuse([fts, assocRows], (r) => r.id, { limit, weights: [1, ASSOC_WEIGHT] });
  return fused.map((f) => {
    const lex = ftsById.get(f.id);
    const a = assocById.get(f.id);
    if (lex) return { ...lex, matched: a ? "both" : "lexical", rrf: f.rrf };
    const p = ws.getPage(f.id);
    return {
      id: f.id,
      basename: p?.basename,
      type: "day",
      title: p?.title,
      description: p?.description,
      snippet: p?.description ? `«${p.description}»` : "",
      matched: "linked",
      expanded_from: a?.from ?? null,
      via: a?.via ?? null,
      rrf: f.rrf,
    };
  });
}

// The gate needs the packed matrix even when the caller did not run a search
// first; searchPagesHybrid has just built (and cached) it, so this is a cache
// read keyed the same way. Null when nothing is cached yet.
function cachedVectorIndexForGate(d) {
  return peekVectorIndex(`wiki:${DB_PATH}`);
}

export function embeddingStats() {
  const d = db();
  if (!d) return { available: false };
  try {
    const embedded = d
      .prepare("SELECT COUNT(*) AS n FROM page_embeddings")
      .get().n;
    const embeddable = d
      .prepare("SELECT COUNT(*) AS n FROM pages WHERE status = 'active'")
      .get().n;
    const pending = d
      .prepare(
        `SELECT COUNT(*) AS n
         FROM pages p
         LEFT JOIN page_embeddings e ON e.page_id = p.id
         WHERE p.status = 'active'
           AND ((e.page_id IS NULL OR e.body_hash IS NULL OR e.body_hash <> p.body_hash)
                OR NOT EXISTS (SELECT 1 FROM page_cues c
                                WHERE c.page_id = p.id AND c.body_hash = p.body_hash
                       AND c.cue_ver = ${CUE_LOGIC_VERSION}))`,
      )
      .get().n;
    const cueRow = d
      .prepare(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT page_id) AS pages FROM page_cues",
      )
      .get();
    const cuesByKind = d
      .prepare("SELECT kind, COUNT(*) AS n FROM page_cues GROUP BY kind ORDER BY n DESC")
      .all();
    return {
      available: true,
      embedded,
      embeddable,
      pending,
      cues: cueRow.n,
      cued_pages: cueRow.pages,
      cues_by_kind: Object.fromEntries(cuesByKind.map((r) => [r.kind, r.n])),
      model: EMBED_MODEL,
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// Test/maintenance helper — close the handle so a fresh DB_PATH can be opened.
export function _closeForTest() {
  try {
    _db?.close();
  } catch {}
  _db = null;
  _disabled = false;
  clearAssocGraphCache();
}

export const WIKI_EMBED_DB_PATH = DB_PATH;
export const WIKI_EMBED_MODEL = EMBED_MODEL;
