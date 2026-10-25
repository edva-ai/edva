#!/usr/bin/env node
// hum-wiki-recall — "what has the user already told us about these candidates?"
//
// The honest implementation of "hum generation consults the entire wiki." For
// each candidate the harvesters produced this tick, search the WHOLE pages
// table (same FTS index wiki_search uses) for anything the user has already said
// — a preference, a decision, a "we did that / it's handled" — and surface it
// to the ranker. Also pull TODAY'S replies that the overnight `hum-consolidate`
// job hasn't folded into the wiki yet, so an answer the user gave this afternoon
// suppresses a re-ask on the very next tick.
//
// Used two ways:
//   1. As a library: `import { recallForCandidates } from "./hum-wiki-recall.mjs"`
//      — hum-harvest-all calls this and splices `wiki_recall` onto its output.
//   2. As a CLI: `echo '<candidates JSON>' | hum-wiki-recall` → recall JSON on
//      stdout. `<candidates JSON>` may be a bare array or `{candidates:[...]}`.
//      Handy for the playbook and for tests.
//
// Output shape:
//   {
//     per_candidate: [
//       { topic, subject, dedup_key,
//         wiki_hits: [{ page_id, title, snippet }] }   // [] when nothing matched
//     ],
//     today_replies: [
//       { ts, lane, subject, subject_key, reply_text, disposition }
//     ],
//     today_chat: [
//       { role, content, created_at, day_tag }
//       // day_tag: "today" | "yesterday" | "N days ago" — computed HERE, in
//       // code, from created_at (home-timezone calendar day). The ranker
//       // must use this tag for any relative-day language it writes; it must
//       // never infer same-day/same-night from a message's mere presence in
//       // this block. See dayOffsetTag() below.
//     ]
//   }
//
// Read-only. Never writes.

import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { recentChat } from "../../lib/chat-recall.mjs";

import { installTools } from "../../lib/root.cjs";
const require = createRequire(import.meta.url);
const HOME = os.homedir();

// The home tz (lib/instance.cjs), kept consistent with the other
// day-boundary logic in this file (readTodayDirect below) and in hum-state.
const CHAT_TZ = require("../../lib/instance.cjs").instance().tz;

function localDateStr(d, tz = CHAT_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// Day-offset arithmetic — deterministic, computed in code (Rule #0b: code
// owns geometry/dates, a model owns language; never hand a model a raw
// timestamp and ask it to infer "today" vs "last night"). Compares LOCAL
// CALENDAR days, not a raw hour delta, so a message at 23:50 one night and one
// at 00:10 the next morning land on the correct sides even though they're 20
// minutes apart.
//
// today_chat's ~36h window spans more than one night. Under a block label
// with no per-message date, the ranker assumes "same night" and can attach a
// true fact from the PRIOR night to the wrong day. Tagging each message here
// closes the hole: the ranker no longer has to derive the date itself, so it
// has nothing to get wrong.
function dayOffsetTag(iso) {
  if (!iso) return "unknown day";
  const msgDay = Date.parse(localDateStr(new Date(iso)) + "T00:00:00Z");
  const today = Date.parse(localDateStr(new Date()) + "T00:00:00Z");
  if (Number.isNaN(msgDay) || Number.isNaN(today)) return "unknown day";
  const diffDays = Math.round((today - msgDay) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}

// Pull a short, search-worthy subject string off a harvester candidate. They
// vary in shape, so check the usual fields in priority order.
function candidateSubject(c) {
  if (!c || typeof c !== "object") return "";
  return String(
    c.subject ||
    c.supporting_data?.subject ||
    c.supporting_data?.title ||
    c.signal ||
    c.topic ||
    "",
  ).trim();
}

// Build the recall query for a candidate.
//
// Prepending the `topic` ("dining <restaurant> …") on the theory that it pulls
// in the matching preference page does the opposite twice over: under FTS5's
// implicit AND it adds one more token that every page has to contain, and
// under semantic search it drags the query toward Edva's own hum-machinery
// pages instead of anything about the subject. Subject only.
export function candidateQuery(c) {
  return candidateSubject(c).slice(0, 120);
}

// Minimum cosine for a semantic-only hit to count as "the user has said
// something about this."
//
// Calibrated against the live wiki corpus (~900 pages), top-3 cosine:
//   irrelevant ("quantum chromodynamics", "mitochondrial electron transport")
//     → 0.447–0.462
//   relevant   (a named restaurant, a city's lodging, an appointment's
//     status) → 0.550–0.714
// 0.52 sits in the gap with headroom on both sides.
//
// What this floor does NOT do: a subject with no matching page at all
// (a contractor arriving at a job site) still scores ~0.563 and passes,
// because KNN always returns its nearest neighbours no matter how far away
// they are. That residual noise is why `jobs/hum.md` treats a wiki hit as a
// LEAD to be read, not as proof a subject is settled. A floor removes the
// absurd; only the ranker can judge the plausible.
// Maximum BM25 score for a hit to count. SQLite's bm25() is NEGATIVE and more
// negative means a stronger match, so this is an upper bound: keep `score <=
// MAX_BM25`.
//
// Calibrated over 14 distinct real hum candidate signals, top hit each,
// against the live wiki corpus: kept hits scored -30.7 to -14.7 (a travel
// schedule, a taste page, a project page, an email-memory page), dropped hits
// -9.9 to -7.4 (a band name landing on an old trip, a weather reading landing
// on a day page).
//
// -12 sits in the gap. Everything kept is genuinely on-topic; everything
// dropped is a vague candidate ("Clear, 72F, rain 0%") landing on an
// unrelated page.
//
// WHY BM25 AND NOT COSINE. A semantic-cosine floor is inert: calibrated against absurd queries (quantum
// chromodynamics scored 0.447-0.462) it looked like it separated signal from
// noise, but every REAL candidate is ordinary English about the user's life and
// so is the whole corpus, so they all land 0.55-0.72 and nearly every hit is
// semantic-only noise. A margin-over-background variant fails too (noise
// margins can EXCEED a relevant query's). Page-level cosine cannot separate
// "this page is about this subject" from "this page and this subject are both
// about the user." BM25 can,
// because it scores by term RARITY: a vague candidate has no rare terms to
// match and scores weakly by construction.
export const MAX_BM25 = -12;

// Should this hit reach the ranker?
export function keepHit(row) {
  if (!row) return false;
  if (typeof row.score !== "number") return false;
  return row.score <= MAX_BM25;
}

export async function recallForCandidates(candidates, { limitPerCandidate = 3 } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const per_candidate = [];
  let today_replies = [];
  let today_chat = [];

  // Lexical BM25 with OR semantics, floored. NOT semantic search.
  //
  // Both wrong answers are instructive. `searchPages(topic + subject,
  // {mode:"fts"})` builds an FTS5 expression that ANDs every token — a 6-10
  // token candidate subject demands all of it on one page, so it returns ZERO
  // hits for nearly every candidate. Semantic hybrid search produces hits but
  // the wrong ones: almost all semantic-only, and a weather reading
  // ("Clear, 72F, rain 0%") pulls several wiki pages. See MAX_BM25 above for
  // why no cosine floor can fix that.
  //
  // The actual issue is not FTS-vs-semantic, it is the AND. With OR, BM25
  // ranks by term rarity and lands on the right pages (an appointment's
  // status -> that appointment's page) while scoring vague candidates too
  // weakly to clear the floor. Measured: AND found a hit for 1/14 real
  // candidates, OR for 14/14, and the floor keeps 9 of those 14 — the 9 that
  // are actually about something.
  let ws = null;
  try {
    ws = require(installTools("lib/wiki-store.js"));
  } catch (e) {
    console.error(`hum-wiki-recall: wiki-store unavailable: ${e.message}`);
  }

  // Always emit one row per candidate (with empty wiki_hits when the wiki is
  // unavailable) so the ranker still sees the full candidate list — a wiki
  // hiccup must degrade recall, never drop candidates.
  for (const c of list) {
    let hits = [];
    const query = candidateQuery(c);
    if (ws && query) {
      try {
        // Pull wider than needed so the floor selects the best rows rather than
        // merely truncating an already-cut list.
        const rows = ws.searchPages(query, {
          mode: "fts",
          match: "or",
          limit: limitPerCandidate * 4,
        });
        hits = rows
          .filter(keepHit)
          .slice(0, limitPerCandidate)
          .map((r) => ({
            page_id: r.id,
            title: r.title || r.id,
            snippet: (r.snippet || r.description || "").replace(/\s+/g, " ").slice(0, 200),
            bm25: typeof r.score === "number" ? Number(r.score.toFixed(1)) : null,
          }));
      } catch (e) {
        console.error(`hum-wiki-recall: search failed for "${query.slice(0, 40)}": ${e.message}`);
      }
    }
    per_candidate.push({
      topic: c?.topic || null,
      subject: candidateSubject(c) || null,
      dedup_key: c?.dedup_key || c?.supporting_data?.idea_id || null,
      wiki_hits: hits,
    });
  }
  if (ws) { try { ws.closeDb(); } catch {} }

  // Today's replies to hum pings, not yet consolidated into the wiki.
  today_replies = readTodayDirect();

  // What the user typed in ordinary CHAT recently (last ~36h) — the gap this
  // closes: a fact mentioned in conversation (not as a hum reply) that the
  // overnight consolidator hasn't folded into the wiki yet. Fetched once (small
  // volume), fail-soft → [] so a Supabase hiccup never blocks the tick. The
  // ranker uses it to suppress re-asking about something the user just brought up.
  //
  // Each message is tagged with its own calendar day HERE, in code — see
  // dayOffsetTag() above for why. The ranker brief (hum.md) instructs the
  // model to use day_tag for any relative-day language, never to infer it
  // from the block itself.
  try {
    const raw = await recentChat({ hours: 36, role: "user", limit: 40 });
    today_chat = raw.map((m) => ({ ...m, day_tag: dayOffsetTag(m.created_at) }));
  } catch {
    today_chat = [];
  }

  return { per_candidate, today_replies, today_chat };
}

function normReply(r) {
  return {
    ts: r.ts,
    lane: r.lane || null,
    subject: r.subject || null,
    subject_key: r.subject_key || null,
    reply_text: r.reply_text || "",
    disposition: r.disposition || null,
  };
}

// Dependency-light fallback reader (hum-responses.mjs is ESM and can't be
// require()'d). Mirrors readToday() in the home timezone.
function readTodayDirect() {
  const fs = require("node:fs");
  const p = installTools("data/hum-responses.jsonl");
  let raw = "";
  try { raw = fs.readFileSync(p, "utf8"); } catch { return []; }
  const tz = CHAT_TZ;
  const fmt = (d) => new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
  const todayLocal = fmt(new Date());
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.ts) continue;
    if (fmt(new Date(r.ts)) === todayLocal) out.push(normReply(r));
  }
  return out;
}

// CLI entry — read candidates from stdin, print recall JSON.
async function mainCli() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim() || "[]";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = []; }
  const candidates = Array.isArray(parsed) ? parsed : (parsed.candidates || []);
  const out = await recallForCandidates(candidates);
  console.log(JSON.stringify(out));
}

// Run as CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`hum-wiki-recall fatal: ${e.message}`);
    console.log(JSON.stringify({ per_candidate: [], today_replies: [], today_chat: [] }));
  });
}
