// claim-facts.mjs — attach AUTHORITATIVE FACTS to a proposed candidate before
// it is allowed to reach the user.
//
// The problem it closes. Hum's validators grew one regex per incident:
// `premiseValid` (calendar), `flightDateValid` (flights.json), `dowValid`
// (weekday), `travelPremiseValid` (/you(?:'re| are)\s+in\s+City/). Each matches
// ONE phrasing of ONE failure, and a miss ships the bad claim silently. The
// motivating incident: a reservoir idea froze "you're in <city A> till <date>"
// at authoring time, that trip leg was then swapped for <city B>, and the idea
// kept re-surfacing its authoring-time wording for 9 days while
// `travel in-city <city A> <date>` → {in:false} the whole time; nobody asked.
//
// The inversion this module makes: DON'T pattern-match phrasing to decide
// whether a claim is wrong. Extract the ENTITIES a candidate mentions, ask each
// entity's authority what is actually true, and ATTACH the answer. Deciding
// whether the candidate contradicts that answer is a separate, much easier
// judgment (see bin/claim-check) — and one that no longer depends on
// having anticipated the sentence shape.
//
// Concretely: any place name in the text that the travel timeline knows about,
// paired with any date in the text, becomes
//   {kind:"presence", place:"<city A>", on:"<date>", actual:"<city b>", in:false}
// regardless of how the sentence was worded. "you'll be abroad", "your <city A>
// stretch", and "while you're away in <country>" all produce the same fact — which
// is exactly what the regex approach could never do.
//
// Costs one timeline fetch per call (segments + flights), then resolves every
// (place, date) pair LOCALLY via presence.resolvePresenceAt — so checking 12
// candidates is one network round-trip, not 12.
//
// Read-only. Fail-open by construction: an unreachable authority yields no
// facts, never a false contradiction.

import { createRequire } from "node:module";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { loadHook } from "./ext-hooks.mjs";

const require = createRequire(import.meta.url);

// The PRESENCE PROVIDER: where the user is on a date, from the installation's
// travel timeline — { fetchSegments, loadFlights, slugify, normalizeMetro,
// parseWhen, resolvePresenceAt, METRO_DEFS, AMBIGUOUS_SEP }, returned by the
// optional hook lib/_ext/presence.mjs (export function provider()).
// The same hook may also export listSegmentsSync() (the timeline's segments,
// synchronously, for loadTimelineSync) and AUTHORITY (the name a presence fact
// cites as its source; default "timeline").
// Without one there is no timeline: no segments, no flights, no metro table,
// so every check yields no facts and drops nothing (fail-open).
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const NO_PRESENCE = Object.freeze({
  METRO_DEFS: [],
  AMBIGUOUS_SEP: "|",
  fetchSegments: async () => [],
  loadFlights: () => [],
  slugify: slug,
  normalizeMetro: (s) => (s ? slug(s) || null : null),
  parseWhen: (s) => Date.parse(s),
  resolvePresenceAt: () => null,
});
const PRESENCE_HOOK = await loadHook(path.dirname(fileURLToPath(import.meta.url)), "presence");
const P = (PRESENCE_HOOK && typeof PRESENCE_HOOK.provider === "function" ? PRESENCE_HOOK.provider() : null) || NO_PRESENCE;
const listSegmentsSync = PRESENCE_HOOK && typeof PRESENCE_HOOK.listSegmentsSync === "function" ? PRESENCE_HOOK.listSegmentsSync : () => [];
const AUTHORITY = (PRESENCE_HOOK && PRESENCE_HOOK.AUTHORITY) || "timeline";
/** The installation's presence provider (NO_PRESENCE when none is installed). */
export function presenceProvider() { return P; }
const { instance, localConfig } = require("./instance.cjs");
// The person the timeline is about (agent/local/instance.json owner_name).
const OWNER = instance().owner_name;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Words that survive capitalization but are never places. Keeps the gazetteer
// lookup from wasting a probe on sentence-initial words and known non-places.
// The owner's name is one; an installation adds its other household names
// (people, pets) as extend_not_a_place in agent/local/config/claim-facts.json.
const NOT_A_PLACE = new Set([
  "the", "this", "that", "your", "you", "his", "her", "their", OWNER.toLowerCase(),
  ...localConfig("claim-facts", { not_a_place: [] }).not_a_place,
  "edva", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "today", "tomorrow", "tonight", "yesterday",
  ...MONTHS,
]);

// ─── Timeline snapshot (one fetch, reused for every check) ────────────────

// Fetch segments + flights once. Callers checking many candidates should build
// this ONCE and pass it in, so a full harvest costs one round-trip.
export async function loadTimeline() {
  let segments = [];
  let flights = [];
  try { segments = await P.fetchSegments(); } catch { segments = []; }
  try { flights = P.loadFlights(); } catch { flights = []; }
  return { segments, flights, gazetteer: buildGazetteer(segments, flights) };
}

// Synchronous variant for the harvesters, which run inside a sync `run()` and
// check ~12 candidates in a tight loop. Asks the hook's listSegmentsSync()
// ONCE per process and memoizes — so a full harvest is one read, not one per
// candidate. Fails open to an empty timeline (→ no facts, no false drops).
let _syncTimeline;
export function loadTimelineSync() {
  if (_syncTimeline !== undefined) return _syncTimeline;
  let segments = [];
  try {
    const parsed = listSegmentsSync();
    if (Array.isArray(parsed)) segments = parsed;
  } catch { segments = []; }
  let flights = [];
  try { flights = P.loadFlights(); } catch { flights = []; }
  _syncTimeline = segments.length || flights.length
    ? { segments, flights, gazetteer: buildGazetteer(segments, flights) }
    : null; // null = "no authority reachable" → callers fail open
  return _syncTimeline;
}

// The set of place tokens the travel timeline can actually answer about:
// every metro key and place label it holds, every city named in flights, plus
// the static metro aliases. A token NOT in here gets no probe — that is what
// keeps a person's name from being treated as a city (presence.normalizeMetro
// slugifies ANY string, so it can never be used as a place test on its own).
//
// Self-maintaining: the day a segment for a city exists, that city is checkable;
// no gazetteer edit, no new regex.
export function buildGazetteer(segments = [], flights = []) {
  const g = new Set();
  const add = (s) => {
    const v = String(s || "").trim().toLowerCase();
    if (!v || v.length < 3) return;
    g.add(v);
    // "<City>, <Country>" / "<City> (<Region>)" → also index the leading city.
    const head = v.split(/[,(]/)[0].trim();
    if (head && head.length >= 3) g.add(head);
    g.add(P.slugify(v));
  };
  for (const s of segments) { add(s.metro); add(s.place_label); }
  for (const f of flights) {
    add(f.to_city); add(f.from_city); add(f.to); add(f.from);
    add(f.destination); add(f.origin);
  }
  for (const [key, aliases] of P.METRO_DEFS) { add(key); for (const a of aliases) add(a); }
  return g;
}

// ─── Entity extraction ────────────────────────────────────────────────────

// Presence constructions, each capturing the place that follows. A match means
// the candidate is ASSERTING where the user is — so the place is checkable even
// if the travel timeline has never heard of it. That matters: the gazetteer is
// built from the CURRENT timeline, and the whole failure mode is a city that
// was swapped OUT (a city edited off the itinerary is no longer in it, so a
// gazetteer-only check would never look at it — precisely backwards).
// NOTE: no /i flag — the capture group must stay case-SENSITIVE so it only
// grabs a capitalized place name. The cue words therefore spell out both cases
// explicitly ([Yy]ou); an /i flag here silently made the whole pattern
// case-insensitive and cost the first draft every sentence-initial "You're in
// <city>" — the exact string this module exists to catch.
const PRESENCE_CLAIM_RES = [
  /\b[Yy]ou(?:'re|’re| are|'ll be|’ll be| will be)\s+(?:still\s+|already\s+)?(?:in|at|back in)\s+([A-ZÀ-Þ][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Þ][\wÀ-ÿ'-]+)?)/g,
  /\b[Ww]hile\s+[Yy]ou(?:'re|’re| are)\s+(?:in|at)\s+([A-ZÀ-Þ][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Þ][\wÀ-ÿ'-]+)?)/g,
  /\b[Yy]ou(?:'re|’re| are)\s+(?:away|abroad)\s+in\s+([A-ZÀ-Þ][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Þ][\wÀ-ÿ'-]+)?)/g,
  /\b[Yy]our\s+([A-ZÀ-Þ][\wÀ-ÿ'-]+(?:\s+[A-ZÀ-Þ][\wÀ-ÿ'-]+)?)\s+(?:stay|stretch|leg|trip)\b/g,
];

// Two extraction paths, deliberately asymmetric:
//
//   ASSERTED (hard) — the candidate explicitly says the user is somewhere:
//     a structured `supporting_data.location_claim`, or a presence
//     construction naming the place. These can be dropped automatically,
//     because the candidate's own claim is what the authority refutes.
//
//   MENTIONED (soft) — a place the travel timeline knows about appears
//     anywhere in the text. This is a fact worth ATTACHING, not a verdict:
//     "a guest checks into the user's home" mentions the home city while the
//     user is abroad, and that is perfectly correct writing. Soft mismatches go to the
//     adjudicator with memory context; they never auto-drop.
//
// Splitting these is what keeps the gate from trading one failure mode for
// another — the first draft of this function scored a home's name as a hard
// contradiction because an unrelated presence cue appeared elsewhere in the
// same sentence.
export function extractPlaces(text, supportingData, gazetteer) {
  const asserted = new Map(); // lowercased → display form
  const mentioned = new Map();
  const s = String(text || "");

  const claim = supportingData?.location_claim;
  if (claim?.city) asserted.set(String(claim.city).toLowerCase(), String(claim.city));

  for (const re of PRESENCE_CLAIM_RES) {
    for (const m of s.matchAll(re)) {
      const phrase = (m[1] || "").trim();
      const lc = phrase.toLowerCase();
      if (!phrase || NOT_A_PLACE.has(lc)) continue;
      if (!asserted.has(lc)) asserted.set(lc, phrase);
    }
  }

  const words = s.split(/[^A-Za-zÀ-ÿ'-]+/).filter(Boolean);
  const consider = (phrase) => {
    const lc = phrase.toLowerCase();
    if (NOT_A_PLACE.has(lc) || asserted.has(lc)) return;
    if (!gazetteer.has(lc) && !gazetteer.has(P.slugify(lc))) return;
    if (!mentioned.has(lc)) mentioned.set(lc, phrase);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!/^[A-ZÀ-Þ]/.test(w)) continue;
    // Bigram first so "Los Angeles" wins over "Los".
    if (i + 1 < words.length && /^[A-ZÀ-Þ]/.test(words[i + 1])) consider(`${w} ${words[i + 1]}`);
    consider(w);
  }
  return { asserted: [...asserted.values()], mentioned: [...mentioned.values()] };
}

// Dates the candidate is talking about, newest-intent first. Explicit ISO wins,
// then "Mon DD" / "DD Mon" prose, then the structured claim date, then the
// idea's own time_sensitive_until. `referenceIso` disambiguates a bare "Jul 31"
// to a year.
export function extractDates(text, supportingData, referenceIso = null) {
  const out = [];
  const push = (d) => { if (d && !out.includes(d)) out.push(d); };
  const s = String(text || "");

  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(`${m[1]}-${m[2]}-${m[3]}`);

  const ref = referenceIso ? new Date(referenceIso) : new Date();
  const refMs = Number.isFinite(ref.getTime()) ? ref.getTime() : Date.now();
  const resolveMonthDay = (monIdx, day) => {
    if (monIdx < 0 || !(day >= 1 && day <= 31)) return null;
    const year = new Date(refMs).getUTCFullYear();
    // Pick the year that puts the date nearest the reference instant.
    let best = null, bestGap = Infinity;
    for (const y of [year - 1, year, year + 1]) {
      const cand = new Date(Date.UTC(y, monIdx, day));
      const gap = Math.abs(cand.getTime() - refMs);
      if (gap < bestGap) { bestGap = gap; best = cand; }
    }
    return best ? best.toISOString().slice(0, 10) : null;
  };
  for (const m of s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/gi)) {
    push(resolveMonthDay(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), parseInt(m[2], 10)));
  }
  for (const m of s.matchAll(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/gi)) {
    push(resolveMonthDay(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), parseInt(m[1], 10)));
  }

  const claimOn = supportingData?.location_claim?.on;
  if (claimOn) push(String(claimOn).slice(0, 10));
  for (const [k, v] of Object.entries(supportingData || {})) {
    if (typeof v === "string" && /date|_on$|_at$|birthday|depart|arrive/i.test(k)) {
      const m = v.match(/\d{4}-\d{2}-\d{2}/);
      if (m) push(m[0]);
    }
  }
  return out;
}

// ─── The check ────────────────────────────────────────────────────────────

// Attach facts for one candidate. `timeline` comes from loadTimeline(); pass it
// in when checking a batch. `timeline.provider`, when set, resolves presence
// instead of the installation's provider (a test's synthetic timeline).
//
// Returns { facts, contradictions, checked }. A `contradiction` is a fact whose
// authority disagrees with what the candidate asserts; `severity` is "hard"
// when the candidate states the premise structurally or with a presence cue,
// "soft" otherwise. Callers drop on hard, adjudicate on soft.
export function checkClaims({ text, supporting_data = null, reference_iso = null }, timeline) {
  const facts = [];
  const contradictions = [];
  const checked = { places: [], dates: [] };
  if (!timeline) return { facts, contradictions, checked };

  const { segments, flights, gazetteer } = timeline;
  const PV = timeline.provider || P;
  const { asserted, mentioned } = extractPlaces(text, supporting_data, gazetteer);
  const dates = extractDates(text, supporting_data, reference_iso);
  checked.places = [...asserted, ...mentioned];
  checked.asserted = asserted;
  checked.dates = dates;
  if (!asserted.length && !mentioned.length) return { facts, contradictions, checked };

  // No date in the text = the claim is about now.
  const whens = dates.length ? dates : [new Date().toISOString().slice(0, 10)];

  // Resolve one place against every candidate date. Returns the per-date facts
  // so the caller can reason over the SET — which matters, because dates are
  // extracted from the whole text and are not individually bound to the place
  // that was claimed.
  const probe = (place, asserted) => {
    const wantMetro = PV.normalizeMetro(place);
    const rows = [];
    for (const on of whens) {
      let instantMs;
      try { instantMs = PV.parseWhen(on); } catch { continue; }
      if (!Number.isFinite(instantMs)) continue;

      let res;
      try { res = PV.resolvePresenceAt(instantMs, segments, flights); } catch { continue; }
      if (!res || !res.metro || res.source === "unknown") continue; // fail-open
      // Mid-flight: the user is legitimately neither here nor there. Never a
      // contradiction.
      if (res.metro === "transit") continue;

      const fact = {
        kind: "presence",
        place,
        on,
        asserted,
        authority: AUTHORITY,
        actual_metro: res.metro,
        actual_label: res.label || res.metro,
        in: res.metro === wantMetro,
      };
      facts.push(fact);
      rows.push(fact);
    }
    return rows;
  };

  // ASSERTED — a hard drop requires the claim to be UNSATISFIABLE.
  //
  // Date extraction is text-wide: it cannot tell which date belongs to the
  // presence claim and which belongs to some other fact in the same sentence.
  // So "You're in <city A> on Aug 10 — and the <city C> closing is Aug 20"
  // yields dates [Aug 10, Aug 20], and probing "<city A>" against Aug 20 finds
  // the user at home. Treating any single mismatch as a hard drop killed that
  // candidate even though its claim was TRUE — a false positive worse than the
  // bug this module exists to fix, because a hard drop happens before ranking
  // with no adjudication.
  //
  // The rule: if there is ANY probed date on which the asserted place holds,
  // the claim is satisfiable — do not hard-drop it. Only when the place is
  // wrong on EVERY date we could check is the assertion actually refuted.
  // The swapped-out city stays caught (wrong on every probed date); the
  // true claim survives. A satisfiable-but-partly-mismatched claim still surfaces as
  // `soft`, so the adjudicator sees it.
  for (const place of asserted) {
    const rows = probe(place, true);
    if (!rows.length) continue;
    const holds = rows.some((r) => r.in);
    const missed = rows.filter((r) => !r.in);
    if (!missed.length) continue;
    if (holds) {
      contradictions.push({
        ...missed[0],
        severity: "soft",
        why: `candidate asserts ${OWNER} is in "${place}"; that holds on ${rows.find((r) => r.in).on} but not on ${missed[0].on} (${missed[0].actual_label}) — likely an unrelated date in the same text`,
      });
      continue;
    }
    contradictions.push({
      ...missed[0],
      severity: "hard",
      why: `candidate asserts ${OWNER} is in "${place}" on ${missed[0].on}; travel timeline says ${missed[0].actual_label}`,
    });
  }

  // MENTIONED — advisory only, one row per mismatched date. Never a drop.
  for (const place of mentioned) {
    for (const r of probe(place, false)) {
      if (r.in) continue;
      contradictions.push({
        ...r,
        severity: "soft",
        why: `candidate mentions "${place}" on ${r.on}, but ${OWNER} is in ${r.actual_label} — may or may not be a contradiction`,
      });
    }
  }
  return { facts, contradictions, checked };
}

// Convenience for single-candidate callers: fetches the timeline itself.
export async function checkClaimsStandalone(input) {
  const timeline = await loadTimeline();
  return checkClaims(input, timeline);
}
