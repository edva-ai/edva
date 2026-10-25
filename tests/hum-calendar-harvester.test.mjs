// hum-calendar-harvester.test.mjs — unit tests for the calendar hum harvester's
// overlap + filter helpers — the pieces that once over-flagged conflicts
// (adjacent events tagged as conflicts, free-transparency events and another
// person's prefixed events not filtered, no per-day dedup).
//
// Run: node --test tests/hum-calendar-harvester.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: the summary prefixes that mark someone else's
// events come from agent/local/config/hum-calendar.json.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "hum-calendar-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "hum-calendar.json"), JSON.stringify({ ignore_summary_prefixes: ["[Shared]"] }));
process.env.EDVA_LOCAL_DIR = LOCAL;
test.after(() => fs.rmSync(LOCAL, { recursive: true, force: true }));
const {
  overlaps,
  filterScannableEvents,
  pairKey,
} = await import("../agent/scripts/hum-harvesters/calendar.mjs");

// Helper: build an event with dateTime start/end (UTC; any fixed offset works
// for predicate tests).
function ev(summary, startIso, endIso, extra = {}) {
  return {
    summary,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    ...extra,
  };
}

function ms(iso) {
  return new Date(iso).getTime();
}

test("overlaps: true when intervals truly intersect", () => {
  // Event A 17:00–18:30, Event B 18:00–19:00 → overlap 18:00–18:30
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:30:00Z");
  const b1 = ms("2030-03-11T18:00:00Z");
  const b2 = ms("2030-03-11T19:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), true);
  // Symmetric
  assert.equal(overlaps(b1, b2, a1, a2), true);
});

test("overlaps: false when events are adjacent (touching edges)", () => {
  // Event A ends 18:15, Event B starts 18:30 — gap, no overlap.
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:15:00Z");
  const b1 = ms("2030-03-11T18:30:00Z");
  const b2 = ms("2030-03-11T19:30:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), false);
});

test("overlaps: false when events exactly abut (end == start)", () => {
  // Back-to-back: A ends exactly when B starts. Must NOT count as conflict.
  const a1 = ms("2030-03-11T17:00:00Z");
  const a2 = ms("2030-03-11T18:00:00Z");
  const b1 = ms("2030-03-11T18:00:00Z");
  const b2 = ms("2030-03-11T19:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), false);
});

test("overlaps: true for containment (one event inside another)", () => {
  // A 14:00–18:00 contains B 15:00–16:00.
  const a1 = ms("2030-03-11T14:00:00Z");
  const a2 = ms("2030-03-11T18:00:00Z");
  const b1 = ms("2030-03-11T15:00:00Z");
  const b2 = ms("2030-03-11T16:00:00Z");
  assert.equal(overlaps(a1, a2, b1, b2), true);
});

test("overlaps: false for missing / zero timestamps", () => {
  assert.equal(overlaps(0, 0, 1000, 2000), false);
  assert.equal(overlaps(1000, 2000, 0, 0), false);
});

test("filterScannableEvents: drops transparency=transparent events", () => {
  const input = [
    ev(
      "Quarterly planning",
      "2030-03-11T16:00:00Z",
      "2030-03-11T18:00:00Z",
    ),
    ev(
      "Focus block",
      "2030-03-11T17:00:00Z",
      "2030-03-11T19:00:00Z",
      { transparency: "transparent" },
    ),
  ];
  const out = filterScannableEvents(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "Quarterly planning");
});

// The prefix below is the synthetic installation's configured one.
test("filterScannableEvents: drops summaries starting with a configured prefix", () => {
  const input = [
    ev(
      "Weekly sync",
      "2030-03-11T10:00:00Z",
      "2030-03-11T11:00:00Z",
    ),
    ev(
      "[Shared] Book the team offsite",
      "2030-03-11T10:30:00Z",
      "2030-03-11T11:30:00Z",
    ),
  ];
  const out = filterScannableEvents(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "Weekly sync");
});

test("filterScannableEvents: drops events missing start/end timestamps", () => {
  const bad = { summary: "broken", start: {}, end: {} };
  const good = ev(
    "ok",
    "2030-03-11T10:00:00Z",
    "2030-03-11T11:00:00Z",
  );
  const out = filterScannableEvents([bad, good]);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, "ok");
});

test("filterScannableEvents: preserves opaque (undefined transparency)", () => {
  // Most real events don't have a transparency field — they default to busy.
  const e = ev(
    "Weekly sync",
    "2030-03-11T10:00:00Z",
    "2030-03-11T11:00:00Z",
  );
  const out = filterScannableEvents([e]);
  assert.equal(out.length, 1);
  assert.equal(out[0].transparency, undefined);
  assert.ok(out[0]._start > 0);
  assert.ok(out[0]._end > out[0]._start);
});

test("pairKey: stable regardless of ordering + case / whitespace", () => {
  assert.equal(
    pairKey("Water plants", "Take out Trash"),
    pairKey("Take out Trash", "Water plants"),
  );
  assert.equal(
    pairKey("  Foo  ", "bar"),
    pairKey("FOO", "Bar"),
  );
});
