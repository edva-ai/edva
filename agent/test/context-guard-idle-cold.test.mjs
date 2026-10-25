// context-guard-idle-cold.test.mjs — the idle-cold rotation rule.
//
// A supervisor session idle past the one-hour prompt cache is resumed cold: the
// next dispatch re-writes its whole context, prefix plus every earlier job's
// conversation. idleColdRotate() says when rotating first is cheaper; the
// wiring checks keep index.mjs calling it from the guard tick with a real idle
// clock (any child event, so a background-task wake with no dispatch in flight
// is activity too).
//
// Run: node --test agent/test/context-guard-idle-cold.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { idleColdRotate, IDLE_COLD_ROTATE_MS, IDLE_COLD_MIN_STALE_TOKENS } from "../supervisor/context-guard.mjs";

const MIN = 60_000;
const FLOOR = 115_000;

describe("idleColdRotate", () => {
  it("ships with a 61-minute idle bar and a 20k stale-token bar", () => {
    assert.equal(IDLE_COLD_ROTATE_MS, 61 * MIN);
    assert.equal(IDLE_COLD_MIN_STALE_TOKENS, 20_000);
  });

  it("rotates a cold session carrying stale conversation (a cold daily-summary case)", () => {
    assert.equal(idleColdRotate(163_486, FLOOR, 339 * MIN), true);
  });

  it("keeps a session whose cache may still be warm", () => {
    assert.equal(idleColdRotate(163_486, FLOOR, 30 * MIN), false);
    assert.equal(idleColdRotate(163_486, FLOOR, 60 * MIN), false);
  });

  it("rotates a session just past the hour (63 idle minutes)", () => {
    // A job arriving 63 minutes after the last one re-wrote ~290k tokens cold;
    // a 65-minute bar let it through.
    assert.equal(idleColdRotate(170_000, FLOOR, 63 * MIN), true);
    assert.equal(idleColdRotate(170_000, FLOOR, 61 * MIN), true);
  });

  it("keeps a cold session with little above its floor", () => {
    assert.equal(idleColdRotate(FLOOR + 19_999, FLOOR, 300 * MIN), false);
    assert.equal(idleColdRotate(FLOOR + 20_000, FLOOR, 300 * MIN), true);
  });

  it("never rotates a fresh session whose floor is not measured yet", () => {
    assert.equal(idleColdRotate(0, 0, 999 * MIN), false);
    assert.equal(idleColdRotate(180_000, 0, 999 * MIN), false);
  });

  it("is switched off by a non-positive idle bar", () => {
    assert.equal(idleColdRotate(163_486, FLOOR, 339 * MIN, { idleColdMs: 0 }), false);
    assert.equal(idleColdRotate(163_486, FLOOR, 339 * MIN, { idleColdMs: NaN }), false);
  });

  it("also ends a cold session parked in the compact dead zone", () => {
    // Observed: floor 164,087, ctx 170,598 — only 6.5k above the floor, so it stays (below 20k)…
    assert.equal(idleColdRotate(170_598, 164_087, 256 * MIN), false);
    // …while a parked session with 20k+ above its floor is rotated once cold.
    assert.equal(idleColdRotate(182_785, 160_000, 141 * MIN), true);
  });
});

describe("index.mjs wiring", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../supervisor/index.mjs"), "utf8");

  it("imports the rule", () => {
    assert.match(src, /import \{[^}]*\bidleColdRotate\b[^}]*\} from "\.\/context-guard\.mjs"/);
  });

  it("starts the idle clock in the constructor and resets it on every child event and turn_complete", () => {
    assert.match(src, /this\.lastActivityAt = Date\.now\(\); \/\/ idle clock/);
    for (const anchor of ['this.dispatcher.on("turn_complete"', 'this.session.on("event"']) {
      const i = src.indexOf(anchor);
      assert.ok(i >= 0, anchor);
      assert.match(src.slice(i, i + 400), /this\.lastActivityAt = Date\.now\(\);/, anchor);
    }
  });

  it("checks the rule in the guard tick before the size decision, through _rotateForContext", () => {
    const start = src.indexOf("startContextGuard() {");
    const body = src.slice(start, src.indexOf("stopContextGuard()", start));
    const a = body.indexOf("idleColdRotate(ctx, this.sessionFloorTokens, idleMs)");
    const b = body.indexOf("contextGuardDecision(ctx");
    assert.ok(a > 0 && b > a, "idle-cold check must come before contextGuardDecision");
    assert.match(body.slice(a, b), /hasLiveBackgroundTasks\(\)\) return;/);
    assert.match(body.slice(a, b), /this\._rotateForContext\(`idle-cold /);
  });
});
