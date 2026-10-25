// hum-idea-locality.mjs — is a reservoir idea actionable from where the user
// will actually BE?
//
// The problem it closes. `claim-facts.mjs` answers "does this candidate assert
// something the travel timeline refutes?" — a truth question. It deliberately
// treats a merely MENTIONED place as soft/advisory, because "a guest checks
// into the user's home" is perfectly true writing while the user is abroad.
//
// That leaves a second, different failure completely uncaught: an idea that is
// TRUE but UNREACHABLE. A restaurant pick for a city dropped from the trip
// asserts nothing false — the restaurant is real and the take is right — but
// the user will not be there, so it can never be acted on. That class burned
// the ideas lane's single nomination slot on several ticks: the harvester
// nominated other-city ideas, the Sonnet ranker correctly deboosted them to
// ~0.28 as "location-stale", and the lane published nothing — while fresh,
// unconsumed ideas for the current city sat in the reservoir.
//
// So the question here is not "is this claim false" but "can the user do this thing".
// Only place-BOUND categories are judged: acting on a dining or exhibition idea
// requires standing there, whereas a remote-work idea or a
// `stuck-task` about a utility bill is done from a phone anywhere.
// Judging the second class on geography is exactly the false positive that
// makes a gate like this worse than none.
//
// Read-only, fail-open by construction: no timeline, no place, or an
// unresolvable presence all return `ok`.

import { extractPlaces, presenceProvider } from "./claim-facts.mjs";

// The installation's presence provider (claim-facts.mjs; lib/_ext/presence.mjs).
const P = presenceProvider();

// Categories whose ideas require the user's physical presence to act on. Kept
// deliberately narrow — every category NOT listed here is exempt from the gate,
// which is the safe direction: a missed geo-stale idea costs one deboosted
// nomination, a false geo-drop silently deletes a valid idea.
export const PLACE_BOUND_CATEGORIES = new Set([
  "dining",
  "taste-match",
  "weekend-planning",
  "seasonal-closing",
  "event-prep",
]);

// How far ahead to look. Deliberately long, and deliberately NOT the idea's own
// window.
//
// The first draft used a 14-day horizon and flagged good ideas in the same
// pass (a call overlapping a landing, a show whose tickets buy fine from
// abroad, arrival items for the home area) — all real, all naming a place the
// user genuinely returns to, none of them stale.
//
// The distinction that actually matters is not "is the user there during the
// idea's window" but "is that place still part of the user's life at all". A
// city swapped off an itinerary never comes back; the home area is on the
// timeline within weeks. So: reachable ANYWHERE in the next quarter
// → the idea is live. Only a place that has fallen off the timeline entirely
// gets retired.
const HORIZON_DAYS = 90;
const MAX_SAMPLES = 45;

/**
 * Can this idea be acted on somewhere the user will be between now and the end of
 * its window?
 *
 * @param {object} idea      collapsed reservoir record
 * @param {object} timeline  from claim-facts loadTimelineSync()/loadTimeline()
 * @param {object} [opts]    {now: ms, horizonDays: number}
 * @returns {{status: "ok"|"stale"|"n/a", places: string[], reason: string}}
 *   `stale`  — every place the idea names is somewhere the user won't be in the window
 *   `n/a`    — not a place-bound category, no timeline, or no place named
 *   `ok`     — at least one named place is reachable (or presence is unknown)
 */
export function localityVerdict(idea, timeline, opts = {}) {
  const now = opts.now ?? Date.now();
  const horizonDays = opts.horizonDays ?? HORIZON_DAYS;
  const na = (reason) => ({ status: "n/a", places: [], reason });

  if (!idea || !timeline) return na("no timeline");
  if (!PLACE_BOUND_CATEGORIES.has(idea.category)) return na(`category ${idea.category || "?"} is not place-bound`);

  const { segments, flights, gazetteer } = timeline;

  // The SUBJECT decides where the user has to be; the rationale merely explains.
  // An idea headlined "<market> open in <city A>" whose rationale happens to
  // mention <city B> is a <city A> idea, and scoring it on
  // the union of both places would clear it. So judge on the subject when the
  // subject names a place at all, and fall back to the full text only when it
  // doesn't.
  const subjectPlaces = namedPlaces(idea.subject || "", idea.supporting_data, gazetteer);
  const places = subjectPlaces.length
    ? subjectPlaces
    : namedPlaces(`${idea.rationale || ""} ${idea.why_now || ""}`, idea.supporting_data, gazetteer);
  if (!places.length) return na("no place named");

  const horizonEnd = now + horizonDays * 86400000;
  const reachable = reachableTokens(segments, flights, now, horizonEnd);
  // Nothing resolvable across the whole horizon → no authority to judge with.
  if (!reachable.size) return { status: "ok", places, reason: "presence unknown across horizon" };

  let comparable = false;
  for (const place of places) {
    const tokens = placeTokens(place);
    if (tokens.some((t) => reachable.has(t))) {
      return { status: "ok", places, reason: `${place} is on the timeline within ${horizonDays}d` };
    }
    // A place the timeline has never heard of in any form isn't evidence of
    // staleness, it's evidence of ignorance — a venue name, a neighborhood we
    // don't index. Only places we could actually have matched count.
    if (tokens.some((t) => gazetteer.has(t))) comparable = true;
  }
  if (!comparable) return { status: "ok", places, reason: "no place the timeline can compare against" };

  return {
    status: "stale",
    places,
    reason: `names ${places.join(", ")}; nowhere on the travel timeline through ${new Date(horizonEnd).toISOString().slice(0, 10)}`,
  };
}

function namedPlaces(text, supportingData, gazetteer) {
  const { asserted, mentioned } = extractPlaces(text, supportingData || null, gazetteer);
  return [...new Set([...asserted, ...mentioned])];
}

// Every string form a place might legitimately be written as: the raw name, its
// leading city ("Springfield, Illinois" → "springfield"), and its slug. Matching on the SET
// rather than on normalizeMetro alone is what stops the head word of the
// user's own lodging label (a neighbourhood name) from reading as a city the
// user isn't in. That false positive would have retired a local idea while
// the user was standing in that very city.
function placeTokens(place) {
  const out = new Set();
  const add = (s) => {
    const v = String(s || "").trim().toLowerCase();
    if (v.length < 3) return;
    out.add(v);
    try { out.add(P.slugify(v)); } catch { /* ignore */ }
  };
  add(place);
  add(String(place).split(/[,(]/)[0]);
  try {
    const m = P.normalizeMetro(place);
    if (m) out.add(m);
  } catch { /* ignore */ }
  return [...out];
}

// Where the user can be between now and the horizon, in every form a place name in an
// idea might match: the metro key, and each stay's own label.
function reachableTokens(segments, flights, now, horizonEnd) {
  const tokens = new Set();
  const add = (s) => {
    const v = String(s || "").trim().toLowerCase();
    if (v.length < 3) return;
    tokens.add(v);
    const head = v.split(/[,(]/)[0].trim();
    if (head.length >= 3) tokens.add(head);
    try { tokens.add(P.slugify(v)); } catch { /* ignore */ }
  };

  // Sampled presence — covers gaps the segment list expresses implicitly.
  const stamps = [now];
  const step = Math.max(86400000, Math.ceil((horizonEnd - now) / MAX_SAMPLES));
  for (let t = now + step; t <= horizonEnd; t += step) stamps.push(t);
  for (const t of stamps) {
    let res;
    try { res = P.resolvePresenceAt(t, segments, flights); } catch { continue; }
    if (!res || !res.metro || res.source === "unknown" || res.metro === "transit") continue;
    add(res.metro);
    add(res.label);
  }
  // Plus every segment that overlaps the horizon at all — a two-day stop
  // between daily samples is still somewhere the user will be.
  for (const s of segments || []) {
    const arr = new Date(s.arrive_at || 0).getTime();
    const dep = s.depart_at ? new Date(s.depart_at).getTime() : Infinity;
    if (!Number.isFinite(arr) || arr > horizonEnd || dep < now) continue;
    add(s.metro);
    add(s.place_label);
  }
  // Flights inside the horizon name cities no segment may cover yet.
  for (const f of flights || []) {
    const dep = new Date(f.depart || 0).getTime();
    if (!Number.isFinite(dep) || dep <= 0 || dep > horizonEnd || dep < now - 86400000) continue;
    add(f.to_city); add(f.from_city); add(f.to); add(f.from);
    add(f.destination); add(f.origin);
  }
  return tokens;
}
