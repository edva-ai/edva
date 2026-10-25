// claim-facts — the entity-driven replacement for the regex validator
// treadmill. The property under test: a stale premise is caught because of the
// ENTITY it names, not because someone anticipated the sentence shape.
//
// The failure it guards: an idea froze "you're in <city> till <date>" when it
// was written; that leg of the trip was later swapped for another city, and the
// idea kept surfacing its authoring-time wording for days.

import test from "node:test";
import assert from "node:assert";
import { checkClaims, extractPlaces, extractDates, buildGazetteer, NO_PRESENCE } from "../lib/claim-facts.mjs";

// A synthetic presence provider (timeline.provider), so these tests run the same
// whether or not the checkout has an installation provider: the segment that
// covers the instant wins (latest arrival); nothing covering = unknown. A bare
// date means midday UTC on that date.
const SEGMENT_PRESENCE = {
  ...NO_PRESENCE,
  parseWhen: (s) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? `${s}T12:00:00Z` : s), // lang-regex-ok: an ISO date shape, not language
  resolvePresenceAt: (ms, segs) => {
    const win = (segs || []).filter((x) => Date.parse(x.arrive_at) <= ms && (!x.depart_at || ms < Date.parse(x.depart_at)))
      .sort((a, b) => Date.parse(a.arrive_at) - Date.parse(b.arrive_at)).pop();
    return win ? { metro: win.metro, label: win.place_label || win.metro, source: "db", segment_id: win.id } : null;
  },
};

// Synthetic timeline: the user is in Northport Jan 26 → Feb 10, then
// Southvale. No Eastham segment exists — it was swapped out, which is the whole
// point: a gazetteer built from the CURRENT timeline has never heard of
// "Eastham", so a gazetteer-only check would look right past the one city that
// matters.
const segments = [
  { id: "s1", metro: "northport", place_label: "Northport — harbor loft", arrive_at: "2026-01-26T12:00:00Z", depart_at: "2026-02-10T09:00:00Z", source: "manual" },
  { id: "s2", metro: "southvale", place_label: "Southvale", arrive_at: "2026-02-10T18:00:00Z", depart_at: null, source: "flights" },
];
const timeline = { segments, flights: [], gazetteer: buildGazetteer(segments, []), provider: SEGMENT_PRESENCE };

const REF = "2026-01-20T00:00:00Z"; // when the idea was authored

function verdict(text, supporting_data = null) {
  const { contradictions } = checkClaims({ text, supporting_data, reference_iso: REF }, timeline);
  return {
    hard: [...new Set(contradictions.filter((c) => c.severity === "hard").map((c) => c.place))],
    soft: [...new Set(contradictions.filter((c) => c.severity === "soft").map((c) => c.place))],
  };
}

test("catches the stale city across phrasings the old regex would miss", () => {
  // The shipped regex was /you(?:'re| are|'ll be| will be)\s+in\s+City/.
  // Only the first of these matched it.
  const phrasings = [
    "Jordan Lee checks into the Southvale flat Jan 31 — you're in Eastham till Feb 6",
    "Jordan checks in Jan 31 while you are in Eastham",
    "Your Eastham stretch runs through Feb 6",
    "You're away in Eastham on Jan 31, so she needs a key",
  ];
  for (const p of phrasings) {
    assert.deepStrictEqual(verdict(p).hard, ["Eastham"], `should hard-flag: ${p}`);
  }
});

test("catches a claim carried as structured data with no prose cue at all", () => {
  // The end state (hum-ideation.md): ideas store the premise as data so the
  // renderer re-derives the sentence. No wording to regex.
  const v = verdict("Guest arriving at the apartment — coordinate access", {
    location_claim: { city: "Eastham", on: "2026-01-31" },
  });
  assert.deepStrictEqual(v.hard, ["Eastham"]);
});

test("a correct claim passes", () => {
  assert.deepStrictEqual(verdict("You're in Northport till Feb 6 — harbor loft").hard, []);
});

test("mentioning a place is NOT asserting presence there", () => {
  // "Southvale" is a place the timeline knows and the user is in Northport —
  // but "Jordan checks into the Southvale flat" is perfectly correct writing.
  // This must never auto-drop; it goes to the adjudicator as soft.
  const v = verdict("Jordan Lee checks into the Southvale flat Jan 31 at 3pm — does she have a way in?");
  assert.deepStrictEqual(v.hard, [], "an innocent venue mention must not be a hard drop");
  assert.deepStrictEqual(v.soft, ["Southvale"], "but it should still be flagged for adjudication");
});

test("an unrelated presence cue elsewhere does not contaminate a venue mention", () => {
  // Regression on the first draft: it hard-flagged the venue because a presence
  // cue about another city appeared in the same sentence.
  const v = verdict("Jordan checks into the Southvale flat Jan 31 — you're in Eastham till Feb 6");
  assert.deepStrictEqual(v.hard, ["Eastham"]);
  assert.ok(!v.hard.includes("Southvale"));
});

test("a TRUE presence claim is not hard-dropped by an unrelated date in the same text", () => {
  // Date extraction is text-wide and cannot bind a date to the place it
  // belongs with. "You're in Northport on Apr 10" is true; "the Westbrook
  // closing is Apr 20" contributes a second date on which the user is in
  // Southvale. Probing the
  // asserted place against BOTH dates and hard-dropping on any single mismatch
  // killed a correct candidate before ranking, with no adjudication — a worse
  // failure than the stale-premise bug this module exists to catch.
  const segs = [
    { id: "p", metro: "northport", place_label: "Northport", arrive_at: "2026-04-01T00:00:00Z", depart_at: "2026-04-15T00:00:00Z", source: "manual" },
    { id: "n", metro: "southvale", place_label: "Southvale", arrive_at: "2026-04-15T00:00:00Z", depart_at: null, source: "manual" },
  ];
  const tl = { segments: segs, flights: [], gazetteer: buildGazetteer(segs, []), provider: SEGMENT_PRESENCE };
  const out = checkClaims(
    { text: "You're in Northport on Apr 10 — and the Westbrook closing is set for Apr 20.", reference_iso: "2026-04-01T00:00:00Z" },
    tl,
  );
  const hard = out.contradictions.filter((c) => c.severity === "hard");
  assert.deepEqual(hard, [], "a claim that holds on at least one probed date must not hard-drop");
  // It should still be visible to the adjudicator rather than vanishing.
  assert.ok(
    out.contradictions.some((c) => c.severity === "soft" && c.place === "Northport"),
    "the partial mismatch should surface as soft",
  );
});

test("an asserted claim wrong on EVERY probed date is still a hard drop", () => {
  const segs = [
    { id: "p", metro: "northport", place_label: "Northport", arrive_at: "2026-04-01T00:00:00Z", depart_at: "2026-04-15T00:00:00Z", source: "manual" },
    { id: "n", metro: "southvale", place_label: "Southvale", arrive_at: "2026-04-15T00:00:00Z", depart_at: null, source: "manual" },
  ];
  const tl = { segments: segs, flights: [], gazetteer: buildGazetteer(segs, []), provider: SEGMENT_PRESENCE };
  const out = checkClaims(
    { text: "You're in Eastham on Apr 10 through Apr 20.", reference_iso: "2026-04-01T00:00:00Z" },
    tl,
  );
  const hard = out.contradictions.filter((c) => c.severity === "hard");
  assert.equal(hard.length, 1);
  assert.equal(hard[0].place, "Eastham");
});

test("fails open when no authority is reachable", () => {
  const out = checkClaims({ text: "You're in Eastham till Feb 6" }, null);
  assert.deepStrictEqual(out.contradictions, []);
});

test("fails open when presence at the claimed date is unresolvable", () => {
  // Well before any segment and with no flights — resolvePresenceAt returns
  // unknown, so we must not invent a contradiction.
  const out = checkClaims({ text: "You're in Eastham on Jan 3", reference_iso: "2020-01-01T00:00:00Z" }, timeline);
  assert.deepStrictEqual(out.contradictions, []);
});

test("in transit is never a contradiction", () => {
  const gap = [
    { id: "a", metro: "northport", place_label: "Northport", arrive_at: "2026-03-01T00:00:00Z", depart_at: "2026-03-05T00:00:00Z", source: "manual" },
    { id: "b", metro: "southvale", place_label: "Southvale", arrive_at: "2026-03-08T00:00:00Z", depart_at: null, source: "manual" },
  ];
  const tl = { segments: gap, flights: [], gazetteer: buildGazetteer(gap, []), provider: SEGMENT_PRESENCE };
  const out = checkClaims({ text: "You're in Eastham on Mar 6", reference_iso: "2026-03-01T00:00:00Z" }, tl);
  assert.deepStrictEqual(out.contradictions, []);
});

test("extracts dates from prose, ISO, and structured fields", () => {
  assert.ok(extractDates("Jan 31 at 3pm", null, REF).includes("2026-01-31"));
  assert.ok(extractDates("on 2026-02-06", null, REF).includes("2026-02-06"));
  assert.ok(extractDates("6 Feb", null, REF).includes("2026-02-06"));
  assert.ok(extractDates("", { location_claim: { on: "2026-09-01" } }, REF).includes("2026-09-01"));
  assert.ok(extractDates("", { friend_birthday: "2026-06-23" }, REF).includes("2026-06-23"));
});

test("a bare 'Jan 3' resolves to the year nearest the reference, not blindly this year", () => {
  // Authored late December, referring to early January = next year.
  assert.ok(extractDates("Jan 3", null, "2025-12-28T00:00:00Z").includes("2026-01-03"));
});

test("does not treat capitalized non-places as places", () => {
  const { asserted, mentioned } = extractPlaces(
    "Jordan Lee and Sam arrive Monday", null, timeline.gazetteer,
  );
  assert.deepStrictEqual(asserted, []);
  assert.deepStrictEqual(mentioned, []);
});

test("no place in the text means no work and no facts", () => {
  const out = checkClaims({ text: "The build took 5.8 minutes — target is 7." }, timeline);
  assert.deepStrictEqual(out.facts, []);
  assert.deepStrictEqual(out.contradictions, []);
});

// The presence provider is an installation hook (lib/_ext/presence.mjs);
// without one, claim-facts falls back to NO_PRESENCE: an empty timeline, so
// every check fails open. Both expose the same interface.
test("presence provider: the installed one and the fallback share one interface", async () => {
  const { NO_PRESENCE, presenceProvider } = await import("../lib/claim-facts.mjs");
  const P = presenceProvider();
  for (const p of [NO_PRESENCE, P]) {
    for (const fn of ["fetchSegments", "loadFlights", "slugify", "normalizeMetro", "parseWhen", "resolvePresenceAt"]) assert.equal(typeof p[fn], "function", fn);
    assert.ok(Array.isArray(p.METRO_DEFS));
    assert.equal(typeof p.AMBIGUOUS_SEP, "string");
  }
  assert.deepEqual(await NO_PRESENCE.fetchSegments(), []);
  assert.deepEqual(NO_PRESENCE.loadFlights(), []);
  assert.equal(NO_PRESENCE.resolvePresenceAt(Date.now(), [], []), null);
  assert.equal(NO_PRESENCE.normalizeMetro(""), null);
});
