// Chat context guard: compact only when idle AND there is enough
// above the session floor to remove; rotation prefers idle but never lets the
// session cross ~200k. See agent/supervisor/context-guard.mjs § Chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatContextGuardDecision as d, CHAT_IDLE_MS } from "../agent/supervisor/context-guard.mjs";

const IDLE = CHAT_IDLE_MS + 1;
const BUSY = 10_000;

test("below the compact threshold nothing happens", () => {
  assert.equal(d({ ctx: 120_000, floor: 100_000, idleMs: IDLE }), "none");
});

test("mid-conversation a compactable session waits instead of compacting", () => {
  assert.equal(d({ ctx: 160_000, floor: 110_000, idleMs: BUSY }), "wait");
});

test("once idle, a compactable session compacts", () => {
  assert.equal(d({ ctx: 160_000, floor: 110_000, idleMs: IDLE }), "compact");
});

test("the live chat shape (floor 157k) never compacts — nothing to remove", () => {
  // A fresh session measured 157,460; ctx 176k after two messages.
  assert.equal(d({ ctx: 170_000, floor: 157_460, idleMs: IDLE }), "skip-compact");
  assert.equal(d({ ctx: 170_000, floor: 157_460, idleMs: BUSY }), "skip-compact");
});

test("unmeasured floor falls back to the plain threshold, still idle-gated", () => {
  assert.equal(d({ ctx: 160_000, floor: 0, idleMs: BUSY }), "wait");
  assert.equal(d({ ctx: 160_000, floor: 0, idleMs: IDLE }), "compact");
});

test("rotate threshold prefers idle", () => {
  assert.equal(d({ ctx: 178_000, floor: 157_460, idleMs: BUSY }), "wait");
  assert.equal(d({ ctx: 178_000, floor: 157_460, idleMs: IDLE }), "rotate");
});

test("past the hard ceiling it rotates even mid-conversation", () => {
  // One burst reached 199,932 under the old 195k ceiling.
  assert.equal(d({ ctx: 186_000, floor: 157_460, idleMs: BUSY }), "rotate");
});

test("never-seen conversation counts as idle", () => {
  assert.equal(d({ ctx: 160_000, floor: 110_000, idleMs: Date.now() - 0 }), "compact");
});
