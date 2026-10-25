// hum-novelty.test.mjs — unit tests for the hum semantic novelty gate lib
// (lib/hum-novelty.mjs), the semantic sibling of hum-ping's exit-8 dedup.
// Motivated by the LLM-homogenization paper (Moon/Green/Kushlev 2025): block a
// *different* subject that restates something surfaced recently.
//
// Covers the pure pieces (text selection, cosine ranking, window filtering,
// sidecar round-trip, fail-open). The real embed path (Ollama nomic-embed-text)
// and the exit-9 wiring in hum-ping are verified on the host where the embedder
// lives — see the deploy checklist. These tests set HUM_NOVELTY_SIDECAR to a
// fixture so they never touch the live sidecar.
//
// Run: node --test tests/hum-novelty.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-nov-"));
const sidecar = path.join(fixtureDir, "vectors.jsonl");
process.env.HUM_NOVELTY_SIDECAR = sidecar;

let N;
before(async () => {
  N = await import("../lib/hum-novelty.mjs");
});
after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function resetSidecar() {
  try { fs.rmSync(sidecar); } catch {}
}

test("signalText prefers signal > summary > display, falls back to message", () => {
  assert.equal(N.signalText({ signal: "a", summary: "b" }, "m"), "a");
  assert.equal(N.signalText({ summary: "b", subject_display: "c" }, "m"), "b");
  assert.equal(N.signalText({ subject_display: "c" }, "m"), "c");
  assert.equal(N.signalText({}, "m"), "m");
  assert.equal(N.signalText(null, "m"), "m");
  assert.equal(N.signalText({ signal: "   " }, "m"), "m"); // blank signal ignored
});

test("nearestDuplicate ranks by cosine and returns the nearest row", () => {
  const rows = [
    { ping_id: "parallel", sent_at: new Date().toISOString(), vec: [0.99, 0.01, 0] },
    { ping_id: "orthogonal", sent_at: new Date().toISOString(), vec: [0, 1, 0] },
  ];
  const near = N.nearestDuplicate([1, 0, 0], rows);
  assert.ok(near.maxSim > 0.99, `near-parallel ~1, got ${near.maxSim}`);
  assert.equal(near.nearest.ping_id, "parallel");

  const far = N.nearestDuplicate([0, 0, 1], rows);
  assert.ok(far.maxSim < 0.1, `orthogonal ~0, got ${far.maxSim}`);
});

test("nearestDuplicate on null vec or empty corpus yields no duplicate", () => {
  assert.equal(N.nearestDuplicate(null, [{ vec: [1, 0] }]).maxSim, 0);
  assert.equal(N.nearestDuplicate([1, 0], []).maxSim, 0);
  assert.equal(N.nearestDuplicate([1, 0], []).nearest, null);
});

test("embed fails open (returns null) on empty text", async () => {
  assert.equal(await N.embed(""), null);
  assert.equal(await N.embed(null), null);
  assert.equal(await N.embed("   "), null);
});

test("record + recentVectors round-trip; window excludes stale rows", () => {
  resetSidecar();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  N.record({ ping_id: "fresh", sent_at: iso(1000), vec: [1, 0, 0] }, now);
  N.record({ ping_id: "old", sent_at: iso(80 * 3600_000), vec: [0, 1, 0] }, now); // >72h
  const ids = N.recentVectors(now).map((r) => r.ping_id).sort();
  assert.deepEqual(ids, ["fresh"], `only fresh in 72h window, got ${ids}`);
});

test("recentVectors is order-independent (robust to non-monotonic append)", () => {
  resetSidecar();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  // Append an old row AFTER a fresh one — a naive newest-first-then-break scan
  // would wrongly stop at the old row and drop the fresh one.
  N.record({ ping_id: "fresh", sent_at: iso(1000), vec: [1, 0, 0] }, now);
  N.record({ ping_id: "old", sent_at: iso(90 * 3600_000), vec: [0, 1, 0] }, now);
  const ids = N.recentVectors(now).map((r) => r.ping_id);
  assert.deepEqual(ids, ["fresh"], `window filter must ignore append order, got ${ids}`);
});

test("recentVectors returns [] when the sidecar is missing (fail-open read)", () => {
  resetSidecar();
  assert.deepEqual(N.recentVectors(Date.now()), []);
});

test("the gate predicate: block only when not-protected, low-urgency, and above threshold", () => {
  // Mirrors hum-ping §0d exactly so a change to the predicate breaks a test.
  // The threshold is PER-LANE since 2026-10-06 (N.thresholdFor(lane)), so the
  // predicate takes a lane; passing an untuned one reproduces the old global.
  const decide = (maxSim, score, isProtected, lane = "dining") =>
    !isProtected && score < 0.9 && maxSim >= N.thresholdFor(lane);
  assert.equal(decide(0.95, 0.5, false), true, "clear near-dup, normal urgency → block");
  assert.equal(decide(0.95, 0.95, false), false, "high-urgency resend bypasses");
  assert.equal(decide(0.95, 0.5, true), false, "Rule #1 lane bypasses");
  assert.equal(decide(0.5, 0.5, false), false, "distinct topic → send");
  // The lane is load-bearing: 0.91 is a duplicate for `nearby` and distinct
  // signal for every other lane.
  assert.equal(decide(0.91, 0.5, false, "nearby"), true, "nearby is tuned to 0.90");
  assert.equal(decide(0.91, 0.5, false, "dining"), false, "an untuned lane keeps 0.93");
  assert.equal(decide(N.THRESHOLD, 0.5, false), true, "exactly at threshold → block");
});
