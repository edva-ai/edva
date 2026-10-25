#!/usr/bin/env node
// ideas — surfaces pre-computed ideas from data/hum-ideas.jsonl.
// Fills the gap when live harvesters have no new signal. See
// system/hum-ideas-reservoir.md for the full design.
//
// Emits the highest-scoring unconsumed, still-time-valid idea as a candidate.
// `dedup_key` is the idea id, so hum.md step 4 can look up the winning idea
// and mark it consumed with the ping_id.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun, minsSince, readCache, writeCache, GOG_ACCOUNT, localConfig } from "./_common.mjs";
import { loadTimelineSync, checkClaims } from "../../../lib/claim-facts.mjs";
import { localityVerdict } from "../../../lib/hum-idea-locality.mjs";

import { installTools } from "../../../lib/root.cjs";
const HOME = os.homedir();
const RESERVOIR = installTools("data/hum-ideas.jsonl");
const FEEDBACK = installTools("data/hum-feedback.jsonl");

// Per-idea nomination cooldown. Urgency alone lets one
// high-urgency-but-not-yet-imminent idea (a real trip week, but 2+ weeks out)
// dominate every tick's pick and re-nominate itself over and over (several
// ticks in one week), starving fresher ideas of a chance to surface. After
// COOLDOWN_THRESHOLD unconsumed nominations within COOLDOWN_HOURS, skip the
// idea in favor of the next-best eligible one; deliberately short (not
// permanent) so a genuinely time-sensitive idea still gets through once
// nothing fresher is competing.
//
// Tracked in this harvester's own cache (hum-cache/ideas.json), not derived
// from hum-runs.jsonl — the tick trace's harvest.candidates entries don't
// carry dedup_key (only topic/urgency/freshness_min/signal), and sonnet's
// own `subject` field inconsistently logs either the short slug or the full
// idea id depending on decision type, so neither is a reliable join key.
// This harvester is the one deciding what to nominate each tick, so it's the
// natural, self-contained place to remember that decision's history.
const NOMINATION_COOLDOWN_HOURS = 60;
const NOMINATION_COOLDOWN_THRESHOLD = 2;
const NOMINATION_LOG_RETENTION_DAYS = 7;

function loadNominationLog() {
  const cache = readCache("ideas");
  const log = Array.isArray(cache?.nominations) ? cache.nominations : [];
  const cutoff = Date.now() - NOMINATION_LOG_RETENTION_DAYS * 86400 * 1000;
  return log.filter((n) => n && typeof n.at === "number" && n.at >= cutoff);
}

function recentNominationCount(log, ideaId, windowHours) {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  return log.filter((n) => n.id === ideaId && n.at >= cutoff).length;
}

// Entrypoint guard: only read stdin + run the harvester when this file is
// executed directly (`node ideas.mjs`), not when imported for unit testing
// (e.g. travelPremiseValid in tests/). Behavior when run as a CLI
// harvester is unchanged.
const isMain = import.meta.url === `file://${process.argv[1]}`;
const { situation: sit, context } = isMain ? await readStdinJson() : { situation: {}, context: {} };
void sit; void context;

// DOW validation: if an idea subject bakes in "Mon Apr 7" or "Sat Jun 28" etc,
// verify the stated weekday matches the actual calendar date. Prevents the
// ideation agent's wrong-day-of-week hallucination. Fail-open: returns true on parse failure.
const DOW_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DOW_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTH_SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
export function dowValid(idea) {
  const text = `${idea.subject || ""} ${idea.rationale || ""}`;
  // Match patterns like "Sat Jun 28", "Mon Apr 7", "Friday Jun 27"
  const re = /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\w+)\s+(\d{1,2})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const statedDow = m[1];
    const statedMonth = MONTH_SHORT.indexOf(String(m[2]).slice(0, 3).toLowerCase());
    const statedDay = parseInt(m[3], 10);
    const until = idea.time_sensitive_until ? new Date(idea.time_sensitive_until) : null;
    const ref = until && Number.isFinite(until.getTime()) ? until : new Date();
    // The date the text means. With a month named ("Sat Oct 17") it is that
    // month, in whichever year sits nearest the idea's window. Without one it
    // is the stated day-of-month NEAREST the window. Scanning from -31 and
    // taking the first hit lands on the previous month's day ("Sat Oct 17"
    // checked against Thu Sep 17) and expires ideas whose weekday is correct.
    let date = null;
    if (statedMonth >= 0) {
      date = [-1, 0, 1].map((dy) => new Date(ref.getFullYear() + dy, statedMonth, statedDay))
        .filter((d) => d.getDate() === statedDay)
        .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0] || null;
    } else {
      for (let k = 0; k <= 31 && !date; k++) {
        for (const delta of k ? [-k, k] : [0]) {
          const candidate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + delta);
          if (candidate.getDate() === statedDay) { date = candidate; break; }
        }
      }
    }
    if (!date) continue;
    const statedIdx = DOW_SHORT.indexOf(statedDow) >= 0
      ? DOW_SHORT.indexOf(statedDow)
      : DOW_LONG.indexOf(statedDow);
    if (statedIdx >= 0 && statedIdx !== date.getDay()) return false;
  }
  return true;
}

function readJsonl(p) {
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Collapse append-only records per id: later records merge onto earlier.
// Initial record has full fields; later markers add consumed/reaction state.
function collapseIdeas(records) {
  const byId = new Map();
  for (const r of records) {
    if (!r.id) continue;
    byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
  }
  return Array.from(byId.values());
}

// Ideas whose *category* has been skipped/snoozed repeatedly in the last 7
// days are filtered out — a weak form of reinforcement even before the full
// scorecard system is wired up. If a category has ≥2 skip/snooze/👎 reactions
// and zero positive reactions in the window, suppress it for this tick.
function categoryBlacklist() {
  const records = readJsonl(FEEDBACK);
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const counts = new Map(); // category -> {pos, neg}
  const ideas = collapseIdeas(readJsonl(RESERVOIR));
  const pingToCategory = new Map();
  for (const i of ideas) {
    if (i.ping_id && i.category) pingToCategory.set(i.ping_id, i.category);
  }
  for (const r of records) {
    const ts = new Date(r.reacted_at || r.sent_at || 0).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const cat = pingToCategory.get(r.ping_id);
    if (!cat) continue;
    const c = counts.get(cat) || { pos: 0, neg: 0 };
    const reac = String(r.reaction || "").toLowerCase();
    if (["heart", "up", "thumbs_up", "helpful", "more", "👍", "❤️"].includes(reac)) c.pos++;
    else if (["skip", "snooze", "down", "thumbs_down", "👎", "💤"].includes(reac)) c.neg++;
    counts.set(cat, c);
  }
  const bad = new Set();
  for (const [cat, c] of counts) {
    if (c.neg >= 2 && c.pos === 0) bad.add(cat);
  }
  return bad;
}

// Airline names an idea may mention, matched as lowercase substrings against
// the idea text and flights.json. A generic default; an installation sets the
// carriers it flies in agent/local/config/hum-ideas.json `airlines`.
const AIRLINES = (localConfig("hum-ideas", {
  airlines: ["aer lingus", "air canada", "air france", "alaska", "american", "british airways", "delta", // kernel-guard-ok: generic list of major carriers
    "emirates", "frontier", "iberia", "jetblue", "klm", "lufthansa", "qantas", "southwest", "spirit", // kernel-guard-ok: generic list of major carriers
    "tap", "turkish", "united"], // kernel-guard-ok: generic list of major carriers
}).airlines || []).map((a) => String(a).toLowerCase());

// Flight-date validation: an idea about a specific airline (e.g. "<airline>
// form 48h before departure") is invalid if no matching flight departs within
// 7 days of the idea's time_sensitive_until. This catches the class of error
// where the ideation agent confuses a task's due date with the actual flight
// departure date (a prep task due weeks before the flight read as the flight
// date).
//
// Fail-open: if flights.json is missing or unreadable, returns true.
function flightDateValid(idea) {
  if (!idea.time_sensitive_until) return true;
  const category = idea.category || "";
  if (!["travel-prep", "travel", "event-prep"].includes(category)) return true;
  const text = `${idea.subject || ""} ${idea.rationale || ""} ${JSON.stringify(idea.supporting_data || {})}`.toLowerCase();
  const mentionsAirline = AIRLINES.some((a) => text.includes(a));
  if (!mentionsAirline) return true;
  // Only validate when time_sensitive_until is within 14 days (beyond that,
  // the validation window is too far out to matter for the near-miss class).
  const until = new Date(idea.time_sensitive_until).getTime();
  if (!Number.isFinite(until)) return true;
  const daysUntil = (until - Date.now()) / 86400000;
  if (daysUntil < -1 || daysUntil > 14) return true;
  // Load flights.json
  try {
    const flightsPath = installTools("data/flights.json");
    const flights = JSON.parse(fs.readFileSync(flightsPath, "utf8"));
    if (!Array.isArray(flights) || flights.length === 0) return true;
    // Find any flight whose airline text appears in the idea AND whose departure
    // is within 7 days of time_sensitive_until in either direction.
    const match = flights.find((f) => {
      if (f.type !== "flight") return false;
      const airline = String(f.airline || f.number || "").toLowerCase();
      if (!AIRLINES.some((a) => airline.includes(a) || text.includes(airline.split(" ")[0]))) return false;
      const dep = new Date(f.depart || 0).getTime();
      if (!Number.isFinite(dep) || dep <= 0) return false;
      return Math.abs(dep - until) < 7 * 86400000;
    });
    // If any matching flights exist in flights.json but NONE depart near
    // time_sensitive_until, the idea's date framing is wrong — invalidate it.
    const anyAirlineMatch = flights.some((f) => {
      if (f.type !== "flight") return false;
      const airline = String(f.airline || f.number || "").toLowerCase();
      return AIRLINES.some((a) => airline.includes(a) || text.includes(airline.split(" ")[0]));
    });
    if (anyAirlineMatch && !match) return false;
  } catch { /* fail-open */ }
  return true;
}

// Arrival-time validation: flightDateValid only bounds the DATE of a
// mentioned flight's DEPARTURE, with a loose 7-day tolerance, and only for
// "travel-prep"/"travel"/"event-prep" categories — none of which catches an
// idea that gets a specific ARRIVAL/landing clock time wrong. That's exactly
// a recurring failure: the ideation LLM turn takes a calendar event's arrival
// dateTime displayed in the device timezone at the time (e.g. +02:00 while
// travelling) and relabels the same clock digits with the home offset
// instead of converting, landing hours off (a morning arrival that was really
// late the night before) — in "cross-topic" ideas flightDateValid's category
// filter never reaches.
//
// Cross-checks any arrival/landing ISO timestamp embedded in supporting_data
// against the matching flight's real `arrive` field in flights.json, with a
// tight (90 min) tolerance — a genuine estimate still passes; a mislabeled
// timezone (always off by whole hours, often plus a date rollover) does not.
// Runs for every category, on purpose — the incident idea was "cross-topic".
//
// Fail-open: no flights.json, no embedded arrival-shaped field, or no
// matching flight found close enough to check against → true.
export function arrivalTimeValid(idea) {
  const sd = idea.supporting_data || {};
  const text = `${idea.subject || ""} ${idea.rationale || ""} ${idea.why_now || ""} ${JSON.stringify(sd)}`.toLowerCase();
  const norm = text.replace(/\s+/g, "");

  // Look under any supporting_data key that plausibly means arrival/landing —
  // the ideation agent doesn't use a fixed field name across runs.
  const ARRIVAL_KEYS = ["arrival", "arrive", "land", "landing"];
  const candidates = [];
  for (const [k, v] of Object.entries(sd)) {
    if (typeof v !== "string") continue;
    if (ARRIVAL_KEYS.some((ak) => k.toLowerCase().includes(ak))) candidates.push(v);
  }
  if (!candidates.length) return true;

  try {
    const flightsPath = installTools("data/flights.json");
    const flights = JSON.parse(fs.readFileSync(flightsPath, "utf8"));
    if (!Array.isArray(flights) || flights.length === 0) return true;
    // Airline full names, only needed for the fallback matcher below — ideas
    // usually reference a flight by its number ("XY123"), not the airline
    // name, and the flight number does not contain the name as a substring, so
    // this list (AIRLINES, above) must never gate whether the number-match path
    // even runs.

    for (const raw of candidates) {
      const claimedMs = new Date(raw).getTime();
      if (!Number.isFinite(claimedMs)) continue;
      // Prefer an exact flight-number match ("xy123" appearing in the idea
      // text) to disambiguate between legs of the same trip on the same
      // airline; fall back to airline-name + nearest-real-arrival-within-48h,
      // wide enough that a wrong claimed time (bounded by a UTC-offset
      // difference, at most ~26h) still finds the right flight to check
      // against.
      let match = flights.find((f) => {
        if (f.type !== "flight" || !f.arrive) return false;
        const num = String(f.number || "").replace(/\s+/g, "").toLowerCase();
        return num && norm.includes(num);
      });
      if (!match && AIRLINES.some((a) => text.includes(a))) {
        match = flights.find((f) => {
          if (f.type !== "flight" || !f.arrive) return false;
          const airline = String(f.airline || f.number || "").toLowerCase();
          if (!AIRLINES.some((a) => airline.includes(a))) return false;
          const arr = new Date(f.arrive).getTime();
          return Number.isFinite(arr) && Math.abs(arr - claimedMs) < 2 * 86400000;
        });
      }
      if (!match) continue; // nothing in flights.json ties this candidate to a real flight
      const actualMs = new Date(match.arrive).getTime();
      if (!Number.isFinite(actualMs)) continue;
      if (Math.abs(actualMs - claimedMs) > 90 * 60000) return false;
    }
  } catch { /* fail-open */ }
  return true;
}

// Premise validation: an idea citing a specific calendar event ("Sat 4/25
// 5pm planning session") becomes nonsense if that event has been
// deleted, but the idea record doesn't update itself. Re-check the calendar
// before re-emitting. Returns true if premise still holds (or if there's no
// calendar premise to validate against).
//
// Failure modes are fail-open: if the calendar lookup errors, we pass the
// idea through rather than silencing real signal on a transient gog issue.
function premiseValid(idea) {
  const draws = Array.isArray(idea.draws_on) ? idea.draws_on : [];
  const calRef = draws.find((d) => typeof d === "string" && /^calendar\(/.test(d));
  if (!calRef) return true;
  const dm = calRef.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dm) return true;
  const date = dm[1];
  // Only validate if the cited date is today or within the next 7 days —
  // beyond that, calendar churn isn't the failure mode and the lookup is
  // wasted overhead per tick.
  const todayMs = Date.now();
  const targetMs = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(targetMs)) return true;
  const daysOut = (targetMs - todayMs) / 86400000;
  if (daysOut < -1 || daysOut > 7) return true;
  // Subject without a clock time = no specific event to verify (e.g.,
  // "holiday dinner host decision" cites a date but not a time-bound slot).
  const hasClock = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(am|pm)\b/i.test(idea.subject || "");
  if (!hasClock) return true;
  try {
    const out = execSync(`/opt/homebrew/bin/gog calendar events --from="${date}" --to="${date}" -j${GOG_ACCOUNT ? ` --account=${GOG_ACCOUNT}` : ""} --no-input 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    const items = Array.isArray(parsed) ? parsed : (parsed?.items || []);
    if (!Array.isArray(items) || items.length === 0) return false;
    const haystack = items.map((e) => String(e.summary || e.title || "").toLowerCase()).join(" | ");
    const tokens = String(idea.subject || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !/^\d+$/.test(t) && !["with", "from", "this", "that", "they", "your", "what", "when", "have", "into"].includes(t));
    if (tokens.length === 0) return true;
    return tokens.some((t) => haystack.includes(t));
  } catch {
    return true;
  }
}

// Travel-location premise validation: an idea like "you're in <city> till
// Aug 6" bakes in a location claim read from the travel timeline at generation
// time. Unlike calendar-cited premises (premiseValid) and flight dates
// (flightDateValid), nothing re-checks that claim against the travel
// timeline before re-nominating the idea on a later tick — so a leg swap
// after the idea was created leaves it wrong indefinitely (the idea keeps
// re-dispatching its original wording and reaches the user days after the
// travel timeline was corrected).
//
// Delegates to lib/claim-facts.mjs. Matching ONE phrasing —
// /you(?:'re| are|'ll be| will be) in <City>/ — is the same trap
// premiseValid/flightDateValid/dowValid fell into: it would sail past
// "your <city> stretch", "while you're away in <city>", or
// "you won't be back until Aug 6". claim-facts triggers on the ENTITY instead:
// any place the travel timeline knows about, paired with any date in the text,
// gets checked no matter how the sentence is built.
//
// Fail-open by design (matches premiseValid/flightDateValid): no place claim,
// or an unreachable timeline, and the idea passes through unchanged. Only a
// `hard` contradiction — the idea states the premise structurally
// (`supporting_data.location_claim`) or with an explicit presence cue — blocks
// here. `soft` mismatches survive to the surfacing gate, where claim-check's
// adjudicator sees them with full memory context rather than guessing.
export function travelPremiseValid(idea, timeline = loadTimelineSync()) {
  if (!timeline) return true; // no authority reachable → fail open
  const text = `${idea.subject || ""} ${idea.rationale || ""} ${idea.why_now || ""}`;
  const { contradictions } = checkClaims({
    text,
    supporting_data: idea.supporting_data || null,
    reference_iso: idea.time_sensitive_until || idea.created_at || null,
  }, timeline);
  return !contradictions.some((c) => c.severity === "hard");
}

function scoreIdea(idea, now) {
  // Base urgency + a freshness penalty for ideas >3d old without
  // time_sensitive_until, + boost if we're inside the time-sensitive window.
  const ageMin = minsSince(idea.created_at);
  const ageDays = ageMin / 1440;
  let score = Number(idea.urgency) || 0.3;
  if (!idea.time_sensitive_until && ageDays > 3) {
    // A decay cap of −0.2 lets a month-old idea keep two thirds of its urgency
    // and out-sort ideas written this morning (old undated ideas nominated tick
    // after tick while same-day ideas wait). The cap is −0.35 and reached later: an undated idea is worth
    // meaningfully less than a fresh one by the end of its second week, which
    // is what "the reservoir should feel current" means in scoring terms.
    score -= Math.min(0.35, (ageDays - 3) * 0.03);
  }
  if (idea.time_sensitive_until) {
    const until = new Date(idea.time_sensitive_until).getTime();
    if (Number.isFinite(until)) {
      const daysUntil = (until - now) / 86400000;
      if (daysUntil <= 2) score += 0.1; // imminent boost
    }
  }
  return score;
}

function run() {
  const now = Date.now();
  const raw = readJsonl(RESERVOIR);
  if (raw.length === 0) { stampRun("ideas", false); emitNull("reservoir empty"); return; }

  const ideas = collapseIdeas(raw);
  const blacklist = categoryBlacklist();

  const eligible = ideas.filter((i) => {
    if (!i.subject || !i.urgency) return false;
    if (i.consumed) return false;
    // The dream's questions belong to the dream_asks lane, which floats them
    // the day after (a user decision); here they would only compete for the
    // single slot at low urgency.
    if (i.source === "dream" && i.confidence === "low") return false;
    // Retired by the nightly `hum-reservoir-prune` — past its window, gone
    // stale undated, or anchored to a city the user won't be in. Distinct from
    // `consumed` (which means it became a ping) so the scorecard never counts
    // an expired idea as sent.
    if (i.expired) return false;
    if (i.time_sensitive_until) {
      const t = new Date(i.time_sensitive_until).getTime();
      if (Number.isFinite(t) && t < now) return false;
    }
    if (i.category && blacklist.has(i.category)) return false;
    return true;
  });

  if (eligible.length === 0) {
    stampRun("ideas", false);
    emitNull(`no eligible ideas (total=${ideas.length}, blacklisted cats=${blacklist.size})`);
    return;
  }

  // Pick the single best — Sonnet will make the final pick vs other harvester
  // candidates at the rank stage.
  eligible.sort((a, b) => scoreIdea(b, now) - scoreIdea(a, now));
  // Walk the sorted list and skip ideas whose premise no longer holds, and
  // (separately) ideas that have monopolized recent ticks — collect the
  // latter so we can still fall back to one if nothing else clears.
  let top = null;
  let score = 0;
  let onCooldown = false;
  let geoSkipped = 0;
  const cooledDown = [];
  const nominationLog = loadNominationLog();
  // One timeline for the whole walk (loadTimelineSync memoizes per process, so
  // this is the same object travelPremiseValid uses).
  const timeline = loadTimelineSync();
  for (const candidate of eligible) {
    if (!premiseValid(candidate)) continue;
    if (!flightDateValid(candidate)) continue;
    if (!arrivalTimeValid(candidate)) continue;
    if (!travelPremiseValid(candidate)) continue;
    if (!dowValid(candidate)) continue;
    // Unreachable ≠ untrue. travelPremiseValid catches an idea that ASSERTS a
    // false location; this catches one that is entirely true but can only be
    // acted on somewhere the user won't be (e.g. a restaurant in a city already
    // left), which would burn this lane's one nomination per tick, get
    // deboosted by the ranker, and publish nothing. Skipping it
    // here hands the slot to the next idea instead of to silence.
    if (localityVerdict(candidate, timeline).status === "stale") { geoSkipped++; continue; }
    if (recentNominationCount(nominationLog, candidate.id, NOMINATION_COOLDOWN_HOURS) >= NOMINATION_COOLDOWN_THRESHOLD) {
      cooledDown.push(candidate);
      continue;
    }
    top = candidate;
    score = scoreIdea(candidate, now);
    break;
  }
  // Every valid candidate was on cooldown — the cooldown is a short delay to
  // let fresher ideas compete, not a permanent block, so fall back to the
  // best cooled-down one (still pre-sorted, so [0] is the highest-scoring)
  // rather than going silent.
  if (!top && cooledDown.length > 0) {
    top = cooledDown[0];
    score = scoreIdea(top, now);
    onCooldown = true;
  }
  if (!top) {
    stampRun("ideas", false);
    emitNull(`no eligible ideas survived premise validation (total=${eligible.length}, geo_stale=${geoSkipped})`);
    return;
  }

  nominationLog.push({ id: top.id, at: now });
  writeCache("ideas", { nominations: nominationLog });

  stampRun("ideas", true);
  emit({
    topic: "ideas",
    signal: top.subject,
    urgency: Math.max(0, Math.min(1, score)),
    freshness_min: minsSince(top.created_at),
    dedup_key: top.id,
    supporting_data: {
      idea_id: top.id,
      category: top.category,
      rationale: top.rationale,
      why_now: top.why_now,
      time_sensitive_until: top.time_sensitive_until,
      draws_on: top.draws_on,
      reservoir_size: eligible.length,
      geo_stale_skipped: geoSkipped || undefined,
      cooldown_bypassed: onCooldown || undefined,
      confidence: top.confidence || null,
      verify_question: top.verify_question || null,
      // Pass through task_id + wiki_scope from the idea so precheck and sibling-sweep
      // can use them (hum-ideation Rule 9 sets task_id; precheck Pass 3 reads wiki_scope).
      task_id: top.supporting_data?.task_id || null,
      wiki_scope: top.supporting_data?.wiki_scope || null,
      // Pre-show dining enrichment populated by hum-ideation for event-prep ideas.
      // Sonnet ranker renders these as clickable card lines in the ping text.
      nearby_restaurants: top.supporting_data?.nearby_restaurants || null,
    },
  });
}

if (isMain) {
  try { run(); } catch (e) {
    emitNull(`ideas harvester failed: ${e.message}`);
  }
}
