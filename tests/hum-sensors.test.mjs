// Tests for the hum sensor layer — registry integrity and the sensor contract.
//
// Sensors talk to the outside world (location, gog, ioreg), so these tests
// cover what can be verified without it: every sensor file honours the
// contract, and the pure-logic sensors behave on the edges that matter. The
// installation's registry (data/hum-sensors.json) agreeing with the
// directory is checked in hum-sensors-local.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { sensorErrorLog } from "../lib/hum-events.mjs";
import { installTools } from "../lib/root.cjs";

const SENSOR_DIR = installTools("agent/scripts/hum-sensors");
const files = fs.readdirSync(SENSOR_DIR).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

// (This installation's sensor registry and its own sensors: hum-sensors-local.test.mjs.)

test("every sensor default-exports a detect function", async () => {
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(SENSOR_DIR, f)).href);
    assert.equal(typeof mod.default, "function", `${f}: no default export`);
  }
});

// ── daypart: the one sensor with meaningful pure logic ────────────────────

async function daypart(local, memo) {
  const mod = await import(pathToFileURL(path.join(SENSOR_DIR, "daypart.mjs")).href);
  let saved = null;
  const events = await mod.default({ local, memo, setMemo: (m) => { saved = m; }, nowMs: Date.now() });
  return { events, memo: saved };
}

const AT = (h, m = 0) => ({ hour: h, minute: m, minutes_of_day: h * 60 + m, weekday: "wed", date: "2026-08-05" });

test("daypart fires a boundary once and never again that day", async () => {
  const first = await daypart(AT(12, 20), {});
  assert.ok(first.events.some((e) => e.type === "daypart.lunch"), "lunch should fire just after 12:15");

  const second = await daypart(AT(12, 40), first.memo);
  assert.equal(second.events.length, 0, "the same boundary must not fire twice");
});

test("daypart does not retro-fire a boundary the daemon slept through", async () => {
  // Cold start at 16:00: lunch is 3h45m past. Firing "lunch window open" then
  // would be noise, so it is marked consumed silently.
  const { events, memo } = await daypart(AT(16, 0), {});
  assert.equal(events.filter((e) => e.type === "daypart.lunch").length, 0);
  assert.ok(memo.fired.includes("lunch"), "the stale boundary is still consumed, not left to fire later");
  assert.ok(events.some((e) => e.type === "daypart.afternoon"), "the boundary within the window still fires");
});

test("daypart resets across the date boundary", async () => {
  const day1 = await daypart(AT(12, 20), {});
  const day2 = await daypart({ ...AT(12, 20), date: "2026-08-06" }, day1.memo);
  assert.ok(day2.events.some((e) => e.type === "daypart.lunch"), "a new day re-arms every boundary");
});

test("the weekend boundary is Friday-only", async () => {
  const fri = await daypart({ ...AT(16, 10), weekday: "fri" }, {});
  assert.ok(fri.events.some((e) => e.type === "daypart.weekend_open"));
  const wed = await daypart({ ...AT(16, 10), weekday: "wed" }, {});
  assert.ok(!wed.events.some((e) => e.type === "daypart.weekend_open"));
});

test("daypart events carry lanes and a stable per-day dedup key", async () => {
  const { events } = await daypart(AT(12, 20), {});
  const lunch = events.find((e) => e.type === "daypart.lunch");
  assert.ok(lunch.lanes.includes("dining"));
  assert.equal(lunch.dedup_key, "daypart:lunch:2026-08-05");
});

// ── sensor error logging: transitions, not one line per poll ──────────────
//
// 2026-10-10..13: 96% of hum-sense.log was "sensor excursion error: location
// feed stale — newest fix is Nm old", once a minute, every minute the phone had
// nothing new to report. `last_error` (what status reads) must still be set on
// every run; the log must not repeat it every poll.

const T0 = new Date("2026-08-02T18:00:00Z").getTime();

function simulate(runs, { start = T0 } = {}) {
  let entry = {};
  const lines = [];
  runs.forEach((r, i) => {
    const nowMs = start + i * 60_000;
    const { line, fields } = sensorErrorLog(entry, { name: "excursion", ...r }, nowMs);
    entry = { ...entry, last_error: r.error ?? null, ...fields };
    if (line) lines.push(line);
  });
  return { lines, entry };
}

const stale = (m) => ({ error: `location feed stale — newest fix is ${m}m old (> 25m); position unknown`, error_key: "location_feed_stale" });

test("an hour of minute-by-minute stale-feed errors logs twice, not 61 times", () => {
  const { lines, entry } = simulate(Array.from({ length: 61 }, (_, i) => stale(26 + i)));
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.equal(lines[0], "sensor excursion error: location feed stale — newest fix is 26m old (> 25m); position unknown");
  assert.match(lines[1], /^sensor excursion error: location feed stale — newest fix is 86m old .*still failing since 2026-08-02T18:00:00\.000Z; 59 repeat\(s\) not logged/);
  assert.equal(entry.error_key, "location_feed_stale");
});

test("recovery is logged once, and the next failure is logged as new", () => {
  const { lines, entry } = simulate([stale(26), stale(27), { error: null }, { error: null }, stale(26)]);
  assert.equal(lines.length, 3, lines.join("\n"));
  assert.match(lines[1], /^sensor excursion recovered after 2m \(was: location feed stale/);
  assert.match(lines[2], /^sensor excursion error: location feed stale/);
  assert.equal(entry.error_repeats, 0);
});

test("a different error is logged immediately, even inside the hour", () => {
  const { lines } = simulate([stale(26), stale(27), { error: "location_history returned no rows — source unreachable" }]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "sensor excursion error: location_history returned no rows — source unreachable");
});

test("without a repeat_key, an identical message is still logged once, a changed one at once", () => {
  const same = { error: "gog calendar returned nothing (auth or network?)" };
  const { lines } = simulate([same, same, same, { error: "timeout after 20000ms" }]);
  assert.deepEqual(lines, ["sensor excursion error: gog calendar returned nothing (auth or network?)", "sensor excursion error: timeout after 20000ms"]);
});

test("a healthy sensor with no error history logs nothing", () => {
  const { lines, entry } = simulate([{ error: null }, { error: null }]);
  assert.equal(lines.length, 0);
  assert.equal(entry.error_key, null);
});

// ── questions: turns a waiting queue into ticks, backs off when they send nothing ──

async function questionsSensor({ waiting = 0, sends = [], pending = null, memo = {}, hour = 14, nowMs = Date.now() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q-sensor-"));
  process.env.HUM_QUESTION_BACKLOG_DIR = path.join(dir, "backlog");
  process.env.HUM_QUESTION_SENDS_PATH = path.join(dir, "sends.jsonl");
  process.env.HUM_PENDING_QUESTION_PATH = path.join(dir, "pending.json");
  process.env.HUM_QUESTION_SCALE = "3";
  fs.mkdirSync(process.env.HUM_QUESTION_BACKLOG_DIR);
  fs.writeFileSync(path.join(process.env.HUM_QUESTION_BACKLOG_DIR, "dream_asks.json"),
    JSON.stringify({ lane: "dream_asks", waiting, at: new Date(nowMs).toISOString() }));
  fs.writeFileSync(process.env.HUM_QUESTION_SENDS_PATH, sends.map((t) => JSON.stringify({ sent_at: new Date(t).toISOString() })).join("\n"));
  if (pending) fs.writeFileSync(process.env.HUM_PENDING_QUESTION_PATH, JSON.stringify(pending));
  const mod = await import(pathToFileURL(path.join(SENSOR_DIR, "questions.mjs")).href);
  let saved = null;
  const events = await mod.default({ config: { quiet_hours: { end: 9 } }, local: { hour }, nowMs, memo, setMemo: (m) => { saved = m; } });
  fs.rmSync(dir, { recursive: true, force: true });
  return { events, memo: saved };
}

test("questions fires when questions wait and the pool has room, unramped and focused on the waiting lanes", async () => {
  assert.equal((await questionsSensor({ waiting: 0 })).events.length, 0, "an empty queue is quiet");
  const { events, memo } = await questionsSensor({ waiting: 5 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "questions.waiting");
  assert.equal(events[0].no_ramp, true);
  assert.deepEqual(events[0].lanes, ["dream_asks"]);
  assert.ok(memo.fired_at);
});

test("questions stays quiet overnight and while a question holds the slot", async () => {
  assert.equal((await questionsSensor({ waiting: 5, hour: 7 })).events.length, 0);
  const pending = { id: "q1", expires_at: new Date(Date.now() + 600_000).toISOString() };
  assert.equal((await questionsSensor({ waiting: 5, pending })).events.length, 0);
});

test("questions ticks every 5 minutes while anything waits", async () => {
  const now = Date.now();
  assert.equal((await questionsSensor({ waiting: 5, nowMs: now, memo: { fired_at: new Date(now - 3 * 60_000).toISOString() } })).events.length, 0);
  const again = await questionsSensor({ waiting: 5, nowMs: now, memo: { fired_at: new Date(now - 5 * 60_000).toISOString() } });
  assert.equal(again.events.length, 1);
});
