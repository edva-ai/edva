// context-floor — the floor reported must describe the system running NOW, not
// an average across a window in which the floor itself changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { estimateFloor } = require(path.join(import.meta.dirname, '../lib/context-floor.cjs'));

const rep = (v, n) => Array.from({ length: n }, (_, i) => v + i * 7); // tiny jitter, as real starts have

// ---------------------------------------------------------------------------
// The regression that motivated this: a commit moved the email
// triage rules out of the always-loaded CLAUDE.md chain, cutting ~23k off the
// floor of all three ops supervisors. The next morning's cost-efficiency-review
// ran on a 24h window that STRADDLED the commit, and the window-median said the
// floor had not moved on two of the three. Actual session-start counts and
// prefix sizes from agent/logs/supervisor-*/job-costs.ndjson.
// ---------------------------------------------------------------------------

test('ops-light: 20 pre-change starts then 13 post — reports the NEW floor', () => {
  const floors = [...rep(151_186, 20), ...rep(128_305, 13)];
  const e = estimateFloor(floors);
  assert.ok(Math.abs(e.floor - 128_305) < 8_000, `got ${e.floor}, expected ~128.3k`);
  // The old estimator returned this, i.e. "the floor did not move" — the bug.
  assert.ok(Math.abs(e.windowMedian - 151_186) < 8_000);
  assert.ok(e.shift < -15_000, 'the shift must be visible, not averaged away');
});

test('ops-haiku: only 9 starts (5 pre / 4 post) — a fixed last-8 would straddle', () => {
  // The specific case a "median of the last 8" rule still got wrong: the window
  // spans 4 pre and 4 post, and the even-length median breaks toward the stale
  // half. Walking back only while the value agrees stops exactly at the change.
  const floors = [...rep(109_808, 5), ...rep(93_225, 4)];
  const e = estimateFloor(floors);
  assert.equal(e.samplesUsed, 4, 'must use only the post-change run');
  assert.ok(Math.abs(e.floor - 93_225) < 8_000, `got ${e.floor}, expected ~93.2k`);
});

test('ops: 4 pre / 5 post — right for the right reason, not by luck', () => {
  const floors = [...rep(149_032, 4), ...rep(126_150, 5)];
  const e = estimateFloor(floors);
  assert.equal(e.samplesUsed, 5);
  assert.ok(Math.abs(e.floor - 126_150) < 8_000);
});

// --- the ordinary cases the estimator must not disturb ---------------------

test('stable system: degrades to median of the last N, and reports no shift', () => {
  const floors = rep(128_300, 30);
  const e = estimateFloor(floors);
  assert.equal(e.samplesUsed, 8, 'no change in window -> every sample agrees -> capped at recentN');
  assert.ok(Math.abs(e.floor - e.windowMedian) < 8_000);
  assert.ok(Math.abs(e.shift) < 5_000, 'jitter must not read as a shift');
});

test('a floor that GREW is reported and flagged, same as one that shrank', () => {
  const floors = [...rep(128_300, 12), ...rep(151_000, 9)]; // someone re-added a big always-loaded section
  const e = estimateFloor(floors);
  assert.ok(Math.abs(e.floor - 151_000) < 8_000, `got ${e.floor}`);
  assert.ok(e.shift > 15_000, 'growth must surface — this is the regression the review job watches for');
});

test('per-job payload spread does not fragment the run', () => {
  // Real starts vary by which job opened the session: session-handoff ~128.3k,
  // location-enrich ~133.4k. A ~5k spread must still count as one floor.
  const floors = [128_305, 133_394, 128_346, 128_397, 133_400, 128_328, 128_278, 128_261];
  const e = estimateFloor(floors);
  assert.equal(e.samplesUsed, 8, 'a 5k spread is the same floor, not a change');
  assert.ok(Math.abs(e.floor - 128_400) < 5_000, `got ${e.floor}`);
});

test('degenerate inputs do not throw', () => {
  for (const v of [[], null, undefined]) {
    const e = estimateFloor(v);
    assert.equal(e.floor, 0);
    assert.equal(e.samples, 0);
  }
  const one = estimateFloor([126_150]);
  assert.equal(one.floor, 126_150);
  assert.equal(one.samplesUsed, 1);
  assert.equal(one.shift, 0, 'a single sample cannot show a shift');
});
