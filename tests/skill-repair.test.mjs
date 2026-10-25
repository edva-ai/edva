// skill-repair.test.mjs — admission rules of the same-day repair queue. (The
// installation's own ingest signal that feeds it: skill-repair-local.test.mjs.)
//
// The rules that matter most: a write action is NEVER queued (verifying a
// repaired draw-enter would enter the draw), a login wall or a 403 is not
// a markup break, one action is tried at most once a day and twice a week, and
// the whole loop is capped per day so a site-wide outage can't fan out into a
// dozen agent dispatches.
//
// Run: node --test tests/skill-repair.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admit, requestRepair, loadQueue, claimNext, finish, releaseStale, isWriteAction, isRepairableError, DAILY_CAP } from "../lib/skill-repair.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const H = 3600e3;
const empty = () => ({ pending: [], history: [] });
const req = (o = {}) => ({ skill: "listing-ingest", action: "example-site", error: "went_quiet", ...o });

test("only markup breaks on read actions are admitted", () => {
  assert.equal(admit(empty(), req(), NOW).ok, true);
  for (const error of ["not_logged_in", "captcha_challenge", "access_denied", "fetch_failed", "timeout", "no_api_key"]) {
    assert.equal(admit(empty(), req({ error }), NOW).ok, false, error);
  }
  for (const action of ["draw-enter", "book-slot", "ticket-claim", "submit-comment", "add-to-cart", "vote-post", "cancel-slot"]) {
    assert.equal(isWriteAction(action), true, action);
    assert.equal(admit(empty(), req({ action, error: "zero_rows" }), NOW).ok, false, action);
  }
  for (const action of ["draw-list-active", "availability", "club-text-calendar", "schedule", "page-outline"]) {
    assert.equal(isWriteAction(action), false, action);
  }
  assert.equal(isRepairableError("ZERO_ROWS"), true);
});

test("one attempt per action per day, two per week, never twice in the queue", () => {
  const q = empty();
  q.pending.push({ ...req(), requested_at: new Date(NOW - H).toISOString() });
  assert.match(admit(q, req(), NOW).reason, /already queued/);
  const h1 = { ...empty(), history: [{ ...req(), requested_at: new Date(NOW - 5 * H).toISOString() }] };
  assert.match(admit(h1, req(), NOW).reason, /24h/);
  const h2 = { ...empty(), history: [
    { ...req(), requested_at: new Date(NOW - 50 * H).toISOString() },
    { ...req(), requested_at: new Date(NOW - 100 * H).toISOString() },
  ] };
  assert.match(admit(h2, req(), NOW).reason, /2 attempts/);
  const old = { ...empty(), history: [{ ...req(), requested_at: new Date(NOW - 8 * 24 * H).toISOString() }] };
  assert.equal(admit(old, req(), NOW).ok, true);
});

test("daily cap across all actions", () => {
  const q = empty();
  for (let i = 0; i < DAILY_CAP; i++) q.history.push({ ...req({ action: `src-${i}` }), requested_at: new Date(NOW - H).toISOString() });
  assert.match(admit(q, req({ action: "another" }), NOW).reason, /daily cap/);
});

test("request → claim → finish round trip on a real file, no kick", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-repair-"));
  const file = path.join(dir, "q.json");
  const log = () => {};
  const id = requestRepair(req({ url: "https://example.com/calendar/" }), { file, kick: false, now: NOW, log });
  assert.ok(id);
  assert.equal(requestRepair(req(), { file, kick: false, now: NOW, log }), false, "duplicate refused");
  const q = loadQueue(file);
  const item = claimNext(q, null, NOW);
  assert.equal(item.id, id);
  assert.equal(claimNext(q, null, NOW), null, "nothing else pending");
  assert.equal(finish(q, id, "repaired", "139 rows", "abc123", NOW).status, "repaired");
  assert.deepEqual(q.pending, []);
  fs.rmSync(dir, { recursive: true });
});

test("a dead dispatch's claim is released once, then failed", () => {
  const q = empty();
  q.pending.push({ ...req(), id: "sr-1", status: "in_progress", claimed_at: new Date(NOW - 3 * H).toISOString(), requested_at: new Date(NOW - 3 * H).toISOString() });
  releaseStale(q, NOW);
  assert.equal(q.pending[0].status, "pending");
  q.pending[0].status = "in_progress"; q.pending[0].claimed_at = new Date(NOW - 3 * H).toISOString();
  releaseStale(q, NOW + 3 * H);
  assert.deepEqual(q.pending, []);
  assert.equal(q.history[0].status, "failed");
});
