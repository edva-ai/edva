// The freshness gate reads the travel timeline as the authority for travel
// dates: a stale date in memory rewrote a true flight date after the
// airline moved it. These pin the rendering the adjudicators see
// and that the rule actually reaches the prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTimeline, ADJUDICATE_PROMPT, TIMELINE_RULE } from "../lib/claim-freshness.mjs";

const NOW = Date.parse("2026-02-14T08:00:00Z");
const SEGS = [
  { metro: "northport", place_label: "Northport", arrive_at: "2026-03-01T06:15:00+00:00", depart_at: "2026-03-12T19:30:00+00:00", source: "flights" },
  { metro: "home_city", place_label: "Home City", arrive_at: "2026-02-01T07:10:00+00:00", depart_at: "2026-02-28T17:40:00+00:00", source: "flights", note: "refunded $100.00" },
  { metro: "transit", place_label: "AAA→BBB (Example Air)", arrive_at: "2026-02-28T17:40:00+00:00", depart_at: "2026-03-01T06:15:00+00:00", source: "flights" },
  { metro: "oldtown", place_label: "Old stay", arrive_at: "2025-11-01T00:00:00+00:00", depart_at: "2025-11-30T00:00:00+00:00", source: "manual" },
];

test("segments render start→end in order, flight legs named, old stays and notes left out", () => {
  const out = renderTimeline(SEGS, NOW).split("\n");
  assert.equal(out.length, 3);
  assert.match(out[0], /2026-02-01 07:10Z → 2026-02-28 17:40Z  home_city/);
  assert.match(out[1], /IN TRANSIT \(flight\)  "AAA→BBB \(Example Air\)"/);
  assert.match(out[2], /2026-03-01 06:15Z → 2026-03-12 19:30Z  northport/);
  assert.ok(!out.join("\n").includes("100.00"), "booking notes never reach the gate");
});

test("an empty window says so rather than reading as no travel", () => {
  assert.match(renderTimeline([], NOW), /no segments/);
});

test("the timeline and its rule reach the adjudicator only when read", () => {
  const withT = ADJUDICATE_PROMPT("msg", null, "2026-02-14", "claims", false, "  - x");
  assert.ok(withT.includes("TRAVEL TIMELINE (live, authoritative") && withT.includes(TIMELINE_RULE));
  const without = ADJUDICATE_PROMPT("msg", null, "2026-02-14", "claims", false);
  assert.ok(!without.includes("TRAVEL TIMELINE ("));
});
