// context-guard-floor.test.mjs — the floor-aware context-guard rule.
//
// Covers a cost runaway. A session's context FLOOR (system prompt
// + the CLAUDE.md chain + MCP tool schemas) is re-sent verbatim on every turn
// and no /compact can shrink it; only the conversation ABOVE the floor is
// compactable. When the floor reaches the compact threshold the guard
// degenerates into a thrash loop: it fires on a near-empty session, recovers
// almost nothing, invalidates the prompt cache, and the next dispatch pays a
// full cold write of the whole prefix.
//
// Observed: a tier's floor was 151k against a 150k compact threshold, so the
// guard fired ~90s into every fresh session — dozens of compacts and rotations
// a day on that supervisor alone, with most spend going to cache traffic
// rather than output.
//
// contextGuardDecision() is a pure function precisely so this rule is testable
// here: the ops-rotation tests need to bind HTTP ports and skip in sandboxes,
// which is where this regression would have hidden.
//
// Run: node --test agent/test/context-guard-floor.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextGuardDecision } from "../supervisor/context-guard.mjs";

// Defaults as shipped (compact 170k / rotate 185k / minCompactable 25k).
const O = {};

describe("contextGuardDecision", () => {
  it("does nothing below the compact threshold", () => {
    assert.equal(contextGuardDecision(120_000, 110_000, O), "none");
    assert.equal(contextGuardDecision(169_999, 110_000, O), "none");
  });

  it("compacts when real conversation has accumulated above the floor", () => {
    // 110k floor, 175k context → 65k of actual conversation. Worth compacting.
    assert.equal(contextGuardDecision(175_000, 110_000, O), "compact");
  });

  it("skips the compact when the floor leaves nothing to compact", () => {
    // THE REGRESSION. 168k floor, 175k context → only 7k is conversation.
    // Compacting recovers ~nothing and costs a full cache invalidation.
    assert.equal(contextGuardDecision(175_000, 168_000, O), "skip-compact");
  });

  it("treats exactly-minCompactable as compactable (boundary)", () => {
    assert.equal(contextGuardDecision(175_000, 150_000, O), "compact");      // 25k → compact
    assert.equal(contextGuardDecision(175_000, 150_001, O), "skip-compact"); // 24_999 → skip
  });

  it("rotates above the rotate threshold regardless of floor", () => {
    // A rotation genuinely resets the window, so it is correct even when the
    // floor is huge — that is the fallback the skip path defers to.
    assert.equal(contextGuardDecision(190_000, 180_000, O), "rotate");
    assert.equal(contextGuardDecision(190_000, 0, O), "rotate");
  });

  it("falls back to the plain threshold check when the floor is unmeasured", () => {
    // floor 0 = a freshly rotated child that has not yet made a usage-bearing
    // call. Guessing a floor there would be worse than the old behavior.
    assert.equal(contextGuardDecision(175_000, 0, O), "compact");
    assert.equal(contextGuardDecision(120_000, 0, O), "none");
  });

  it("reproduces the floor-above-threshold thrash under the OLD settings", () => {
    // Old: compact@150k, no floor awareness. A fresh session measured 151k —
    // above its own trigger — so the guard fired immediately, every session.
    const old = { compactThreshold: 150_000, rotateThreshold: 185_000, minCompactable: 0 };
    assert.equal(contextGuardDecision(151_000, 151_000, old), "compact");

    // New settings on the same numbers: nothing fires. The session is left to
    // do real work instead of burning a cache write on a no-op compact.
    assert.equal(contextGuardDecision(151_000, 151_000, O), "none");
  });

  it("still protects a session whose floor was cut (the intended end state)", () => {
    // After the email-triage-rules extraction the floor drops ~15k to ~136k,
    // which restores a real working window: conversation accumulates, and the
    // compact fires on genuine content rather than on the prefix.
    assert.equal(contextGuardDecision(150_000, 136_000, O), "none");     // still room
    assert.equal(contextGuardDecision(172_000, 136_000, O), "compact");  // 36k of talk
  });
});

// Cron-only tiers (ops-light, ops-haiku — agents.json
// `compactOnContext: false`) rotate where ops would compact. A compact there
// summarizes a conversation no later dispatch reads.
describe("contextGuardDecision — allowCompact:false (cron-only tiers)", () => {
  const NC = { allowCompact: false };
  it("rotates instead of compacting once there is real conversation to shed", () => {
    assert.equal(contextGuardDecision(172_000, 136_000, NC), "rotate");
    assert.equal(contextGuardDecision(172_000, 136_000, O), "compact", "ops is unchanged");
  });
  it("leaves the below-threshold and dead-zone answers alone", () => {
    assert.equal(contextGuardDecision(150_000, 136_000, NC), "none");
    assert.equal(contextGuardDecision(180_000, 167_000, NC), "skip-compact");
    assert.equal(contextGuardDecision(190_000, 167_000, NC), "rotate");
  });
});
