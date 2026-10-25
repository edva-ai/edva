// ping-budget.test.mjs — self-improvement review items 8, 9, 14.
//
//   item 8   the shared daily ping budget (6/day, 45 min apart) is enforced in
//            the hum send path: a second ping inside 45 min is refused, a 7th
//            ping in a day is refused.
//   item 9   location-ambient's cap reads the LIVE counter (hum-state.json via
//            bin/ping-budget), not the dead pulse-state.json — the lane
//            skips when today's count is at the cap.
//   item 14  a nearby dedup_key is enforced across days: replaying Mar 2-4 with
//            nearby:old-clock-tower sends it once.
//
// Run: node --test tests/ping-budget.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Sandbox HOME before any lib is imported: every ledger path is HOME-relative.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ping-budget-"));
const DATA = path.join(tmp, "Dev/edva/data");
fs.mkdirSync(DATA, { recursive: true });
process.env.HOME = tmp;
delete process.env.HUM_MAX_PINGS_PER_DAY;
delete process.env.HUM_MIN_PING_INTERVAL_MIN;
delete process.env.HUM_STICKY_DEDUP_WINDOW_D;
delete process.env.HUM_DEDUP_WINDOW_H;
// A synthetic installation whose Rule #1 lane is "practice" (hum-lanes.json protected_lanes).
fs.mkdirSync(path.join(tmp, "local/config"), { recursive: true });
fs.writeFileSync(path.join(tmp, "local/config/hum-lanes.json"), JSON.stringify({ protected_lanes: ["practice"] }));
process.env.EDVA_LOCAL_DIR = path.join(tmp, "local");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

import { REPO_ROOT as REPO } from "../lib/root.cjs";
const pb = await import("../lib/ping-budget.mjs");
const vetoes = await import("../lib/hum-vetoes.mjs");

const TZ = "UTC";
const row = (sent_at, key, lane = "nearby") => ({ sent_at, lane, ping_id: `p-${sent_at}`, findings: key ? [{ topic: lane, dedup_key: key }] : [] });
const newestFirst = (rows) => [...rows].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));

// ─── item 8: the budget ────────────────────────────────────────────────────

test("caps default to 6/day and 45 minutes", () => {
  assert.deepEqual(pb.pingCaps({}), { maxPerDay: 6, minIntervalMin: 45 });
  assert.deepEqual(pb.pingCaps({ HUM_MAX_PINGS_PER_DAY: "0", HUM_MIN_PING_INTERVAL_MIN: "0" }), { maxPerDay: 0, minIntervalMin: 0 });
});

test("a second ping inside 45 minutes is refused", () => {
  const now = new Date("2026-03-04T15:20:00Z");
  const rows = [row("2026-03-04T15:13:00Z", "nearby:harbor-chapel")]; // 7 min earlier
  const v = pb.checkPingBudget({ now, rows, tz: TZ, statePath: path.join(DATA, "none.json") });
  assert.equal(v.ok, false);
  assert.equal(v.gate, "min_interval");
  // ...and allowed once 45 minutes have passed.
  const later = pb.checkPingBudget({ now: new Date("2026-03-04T16:05:01Z"), rows, tz: TZ, statePath: path.join(DATA, "none.json") });
  assert.equal(later.ok, true);
});

test("the 7th ping in a day is refused; the 6th is not", () => {
  const sends = ["13:00", "14:00", "15:00", "16:00", "17:00", "18:00"].map((t) => row(`2026-03-04T${t}:00Z`, `k:${t}`));
  const now = new Date("2026-03-04T20:00:00Z"); // 20:00 local (UTC), same local day, 2h after the last
  const five = pb.checkPingBudget({ now, rows: newestFirst(sends.slice(0, 5)), tz: TZ, statePath: path.join(DATA, "none.json") });
  assert.equal(five.ok, true, "6th ping fits");
  const six = pb.checkPingBudget({ now, rows: newestFirst(sends), tz: TZ, statePath: path.join(DATA, "none.json") });
  assert.equal(six.ok, false, "7th ping refused");
  assert.equal(six.gate, "daily_cap");
  assert.equal(six.count, 6);
  // Next local day the budget is fresh.
  const tomorrow = pb.checkPingBudget({ now: new Date("2026-03-05T14:00:00Z"), rows: newestFirst(sends), tz: TZ, statePath: path.join(DATA, "none.json") });
  assert.equal(tomorrow.ok, true);
});

test("Rule #1 / high-urgency carve-out is not held (but still counted)", () => {
  const v = pb.budgetVerdict({ count: 9, lastPingAt: new Date().toISOString(), bypass: true });
  assert.equal(v.ok, true);
});

test("count = max(state counter, ledger); a counter from another day is ignored", () => {
  const now = new Date("2026-03-06T15:00:00Z");
  const rows = [row("2026-03-06T12:00:00Z", "a"), row("2026-03-06T11:00:00Z", "b")];
  assert.equal(pb.todaysPings({ state: { today: { date: "2026-03-06", pings: 5 } }, rows, now, tz: TZ }).count, 5);
  assert.equal(pb.todaysPings({ state: { today: { date: "2026-03-06", pings: 1 } }, rows, now, tz: TZ }).count, 2);
  assert.equal(pb.todaysPings({ state: { today: { date: "2026-03-05", pings: 6 } }, rows, now, tz: TZ }).count, 2);
});

test("preRankFilter vetoes every non-carve-out candidate once the budget is spent", async () => {
  const fb = path.join(DATA, "fb-budget.jsonl");
  const sends = ["13:00", "14:00", "15:00", "16:00", "17:00", "18:00"].map((t) => row(`2026-03-04T${t}:00Z`, `situation:${t}`, "situation"));
  fs.writeFileSync(fb, sends.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { eligible, vetoed } = await vetoes.preRankFilter(
    [{ topic: "ideas", dedup_key: "idea-x", signal: "x", urgency: 0.6 }, { topic: "practice", dedup_key: "pr-1", signal: "go", urgency: 0.6 }],
    { feedbackPath: fb, statePath: path.join(DATA, "none.json"), tz: TZ, nowMs: Date.parse("2026-03-04T21:00:00Z"), embed: async () => null, recentVectors: () => [] },
  );
  assert.deepEqual(vetoed.map((v) => [v.dedup_key, v.gate]), [["idea-x", "rate_limited"]]);
  assert.deepEqual(eligible.map((c) => c.topic), ["practice"], "Rule #1 lane keeps its own cadence");
});

// ─── item 9: the live counter (the location-ambient lane that reads it:
// ping-budget-local.test.mjs) ───────────────────────────────────────────

test("ping-budget record bumps the live counter the gate reads", () => {
  const statePath = path.join(DATA, "rec-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ today: { date: "2020-01-01", pings: 6 }, max_pings_per_day: 6 }));
  const t = pb.recordPing({ statePath, tz: TZ });
  assert.equal(t.pings, 1, "stale day resets before counting");
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(s.max_pings_per_day, 6, "other fields preserved");
  assert.ok(s.last_ping_at);
});

test("pulse-state.json is retired from the dispatch preamble", () => {
  for (const f of ["agent/supervisor/dispatch-preamble.mjs"]) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("#")).join("\n");
    assert.ok(!code.includes("pulse-state.json"), `${f} still reads pulse-state.json`);
  }
});

// ─── item 14: nearby keys are deduped across days ──────────────────────────

test("replaying Mar 2-4 with nearby:old-clock-tower sends it once", () => {
  // Three send times (the middle one is 24h20m
  // after the first — just outside the old 24h window).
  const attempts = ["2026-03-02T09:10:00Z", "2026-03-03T09:30:00Z", "2026-03-04T15:20:00Z"];
  const ledger = [];
  let sent = 0;
  for (const at of attempts) {
    const dup = vetoes.findRecentDedupSend("nearby:old-clock-tower", { rows: newestFirst(ledger), nowMs: Date.parse(at) });
    if (!dup) { sent++; ledger.push(row(at, "nearby:old-clock-tower")); }
  }
  assert.equal(sent, 1);
});

test("the same replay through preRankFilter vetoes days 2 and 3, even at high urgency", async () => {
  const fb = path.join(DATA, "fb-nearby.jsonl");
  fs.writeFileSync(fb, JSON.stringify(row("2026-03-02T09:10:00Z", "nearby:old-clock-tower")) + "\n");
  for (const at of ["2026-03-03T09:30:00Z", "2026-03-04T15:20:00Z"]) {
    for (const urgency of [0.87, 0.95]) {
      const { eligible, vetoed } = await vetoes.preRankFilter(
        [{ topic: "nearby", dedup_key: "nearby:old-clock-tower", signal: "1900 clock tower", urgency }],
        { feedbackPath: fb, statePath: path.join(DATA, "none.json"), tz: TZ, nowMs: Date.parse(at), embed: async () => null, recentVectors: () => [] },
      );
      assert.equal(eligible.length, 0, `${at} @ ${urgency}`);
      assert.equal(vetoed[0].gate, "cross_send_dedup");
    }
  }
});

test("non-nearby keys keep the 24h window", () => {
  const rows = [row("2026-03-02T12:00:00Z", "situation:NEXT:weekly-call", "situation")];
  assert.ok(vetoes.findRecentDedupSend("situation:NEXT:weekly-call", { rows, nowMs: Date.parse("2026-03-03T06:00:00Z") }));
  assert.equal(vetoes.findRecentDedupSend("situation:NEXT:weekly-call", { rows, nowMs: Date.parse("2026-03-03T12:30:00Z") }), null);
  assert.equal(vetoes.dedupWindowFor("nearby:x"), 180 * 24);
  assert.equal(vetoes.dedupWindowFor("ideas:x"), 24);
});
