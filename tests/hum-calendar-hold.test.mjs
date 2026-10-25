// Which calendar events hold hum (the `in_meeting` gate).
//
// hum-sense treated ANY timed busy event as "in a meeting", so a 09:00–19:00
// day block named after a city held most of a day's hum events. Events up to
// three hours still hold as before. Over three hours, "a thing the user attends"
// (flight, wedding, conference) vs "a container for the day" is language, so a
// model decides (Rule #0b), off the sensor's clock, cached per event; no
// verdict holds. Fixtures are shaped like `gog calendar list --json`; every
// model is faked; modules are imported next to this test, not the live tree.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Jev runs for real through decide(), against a stubbed endpoint and temp
// config/log dirs; the Claude ladder is a fake. Set before any jev import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hum-cal-hold-jev-"));
process.env.JEV_CONFIG_FILE = path.join(tmp, "jev-config.json");
process.env.JEV_QUESTIONS_DIR = path.join(tmp, "q");
process.env.JEV_SHADOW_DIR = path.join(tmp, "log");
process.env.JEV_NO_ALERT = "1";
process.env.TYPESAFE_API_KEY = "test-key";
fs.mkdirSync(process.env.JEV_QUESTIONS_DIR, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const QUESTION = JSON.parse(fs.readFileSync(new URL("../agent/config/jev-questions/calendar-hold.json", import.meta.url), "utf8"));

const SENSOR = new URL("../agent/scripts/hum-sensors/calendar.mjs", import.meta.url);
const cal = await import(SENSOR.href);

const at = (hhmm, day = "2026-03-09") => `${day}T${hhmm}:00-06:00`; // Mountain wall clock
const ms = (hhmm, day) => new Date(at(hhmm, day)).getTime();
const ME = { email: "owner@example.com", self: true, responseStatus: "accepted" };
const g = ({ start, end, tz = "America/Denver", ...rest }) =>
  ({ updated: "2026-03-02T07:34:03Z", organizer: { email: ME.email, self: true }, ...rest,
    start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } });

const CALL = g({ id: "sync", summary: "Jordan <> Alex", tz: "America/Chicago", start: at("00:00", "2026-03-10"),
  end: at("00:30", "2026-03-10"), location: "https://example.zoom.us/j/1234567890?pwd=abc", organizer: { email: "jordan@vendor.example" } });
const DAYTRIP = g({ id: "trip", summary: "Springfield", start: at("09:00"), end: at("19:00") });
const SOCCER = g({ id: "soccer", summary: "Soccer game", start: at("20:00"), end: at("22:00") });
const TRASH = g({ id: "trash", summary: "Take out the trash at the office", tz: "America/Chicago", start: at("01:30", "2026-03-10"),
  end: at("01:55", "2026-03-10"), location: "12 Main St, Springfield, IL 62701, USA" });
const FLIGHT = g({ id: "xy123", summary: "Flight XY123 — NPT → SVL", tz: "Etc/GMT-2", start: "2026-04-01T00:05:00+02:00",
  end: "2026-04-01T11:55:00+02:00", location: "Northport NPT" });
const WEDDING = g({ id: "wed", summary: "Riley's wedding", start: at("12:00", "2026-03-14"), end: at("16:00", "2026-03-14"),
  hangoutLink: "https://meet.google.com/x", organizer: { email: "sam@example.org" }, attendees: [ME] });
const DENTAL = g({ id: "dental", summary: "Dental appointment", tz: "UTC", start: "2026-04-20T17:00:00+02:00",
  end: "2026-04-20T18:00:00+02:00", location: "Example Dental, 40 Oak Ave, Springfield, IL" });

// The fake model: what a sensible reader says about each long title.
const FAKE = { "Springfield": "container", "Flight XY123 — NPT → SVL": "attending", "Riley's wedding": "attending" };
const fakeClassify = (calls = []) => async (ev) => { calls.push(ev.summary); return FAKE[ev.summary] ? { verdict: FAKE[ev.summary], used: "fake" } : null; };
const one = (raw) => cal.parseEvents({ events: [raw] })[0];
const key = (raw) => cal.verdictKey(one(raw));
const said = (raw, verdict) => ({ [key(raw)]: { verdict, at: "2026-03-09T06:00:00Z" } });
const holds = (raw, verdicts = {}) => cal.holdVerdict(one(raw), { verdicts }).hold;

/** Run the sensor's post-fetch step twice, letting background asks settle in between. */
async function twoRuns(events, nowMs, classify) {
  const rt = cal.createRuntime();
  let memo = {};
  const run = () => { const out = cal.fromPayload({ events }, { memo, nowMs, classify, rt, setMemo: (m) => { memo = m; } }); return { out, memo }; };
  const first = run();
  await Promise.all([...rt.pending.values()]);
  return { first, second: run(), rt };
}

test("a real meeting holds: a Zoom call, written in another zone's time", () => {
  assert.equal(holds(CALL), true);
});

test("events up to three hours hold exactly as before, wherever their clock was written", () => {
  assert.equal(holds(TRASH), true);
  assert.equal(holds(SOCCER), true);
  assert.equal(holds(DENTAL), true);
});

test("a 10-hour day block the model calls a container does not hold", () => {
  assert.deepEqual(cal.holdVerdict(one(DAYTRIP), { verdicts: said(DAYTRIP, "container") }),
    { hold: false, why: "planning block (600 min)" });
});

test("a long event with no verdict, or attending/unclear, holds (fail-safe)", () => {
  assert.equal(holds(DAYTRIP), true);
  assert.equal(holds(FLIGHT, said(FLIGHT, "attending")), true);
  assert.equal(holds(WEDDING, said(WEDDING, "attending")), true);
  assert.equal(holds(DAYTRIP, said(DAYTRIP, "unclear")), true);
  assert.equal(holds(DAYTRIP, { [key(DAYTRIP)]: { verdict: null, at: "x" } }), true);
});

test("a verdict belongs to one version of the event: an edit asks again", () => {
  const edited = { ...DAYTRIP, updated: "2026-03-09T07:00:00Z" };
  assert.equal(holds(edited, said(DAYTRIP, "container")), true);
});

test("all-day and marked-free events never reach the gate; a declined one does not hold", () => {
  const allDay = { id: "a", summary: "Company offsite", start: { date: "2026-03-09" }, end: { date: "2026-03-10" } };
  assert.equal(cal.parseEvents({ events: [allDay, { ...TRASH, transparency: "transparent" }] }).length, 0);
  assert.equal(holds({ ...CALL, attendees: [{ ...ME, responseStatus: "declined" }] }), false);
});

test("the sensor asks once in the background, holds meanwhile, then releases the day block", async () => {
  const calls = [];
  const { first, second, rt } = await twoRuns([DAYTRIP], ms("11:00"), fakeClassify(calls));
  assert.equal(first.memo.hold_id, "trip", "no verdict yet: holds, as before");
  assert.equal(second.memo.hold_id, null);
  assert.equal(second.memo.current_id, "trip", "current (the meeting_ended edge) is unchanged");
  assert.equal(second.memo.verdicts[key(DAYTRIP)].verdict, "container");
  assert.deepEqual(calls, ["Springfield"], "one model call per event, not per tick");
  cal.fromPayload({ events: [DAYTRIP] }, { memo: second.memo, nowMs: ms("12:00"), classify: fakeClassify(calls), rt, setMemo: () => {} });
  assert.equal(rt.pending.size, 0, "the cached verdict is not re-asked");
});

test("a flight and a wedding stay held after the model answers", async () => {
  for (const [ev, now] of [[FLIGHT, new Date("2026-04-01T03:00:00+02:00").getTime()], [WEDDING, ms("13:00", "2026-03-14")]]) {
    const { second } = await twoRuns([ev], now, fakeClassify());
    assert.equal(second.memo.hold_id, ev.id, ev.summary);
  }
});

test("a classifier that throws leaves the event held and is retried after 30 minutes", async () => {
  const boom = async () => { throw new Error("model down"); };
  const { second, rt } = await twoRuns([DAYTRIP], ms("11:00"), boom);
  assert.equal(second.memo.hold_id, "trip");
  const later = (dt) => { cal.fromPayload({ events: [DAYTRIP] }, { memo: second.memo, nowMs: ms("11:00") + dt, classify: boom, rt, setMemo: () => {} }); return rt.pending.size; };
  assert.equal(later(10 * 60e3), 0, "not re-asked inside 30 min");
  assert.equal(later(31 * 60e3), 1, "re-asked after 30 min");
});

test("a day replayed: held only through the evening's soccer game", async () => {
  const events = [DAYTRIP, SOCCER, CALL];
  const verdicts = said(DAYTRIP, "container");
  const parsed = cal.parseEvents({ events });
  let held = 0;
  for (let t = ms("09:00"); t < ms("23:55"); t += 5 * 60000) if (cal.calendarSituation(parsed, { nowMs: t, verdicts }).hold) held++;
  assert.equal(held, 24); // 20:00–22:00
});

test("a place is any location that is not nothing-but-call-links", () => {
  assert.equal(cal.placeOf("https://example.zoom.us/j/1234567890?pwd=abc"), null);
  assert.equal(cal.placeOf("https://meet.google.com/abc-defg-hij"), null);
  assert.equal(cal.placeOf("https://zoom.us/j/1, https://teams.microsoft.com/l/x"), null);
  const diner = "Maple Diner Northport (https://maps.app.goo.gl/AbC123xyz)";
  assert.equal(cal.placeOf(diner), diner);
  assert.equal(cal.placeOf("https://maps.app.goo.gl/AbC123xyz"), "https://maps.app.goo.gl/AbC123xyz");
  assert.equal(cal.placeOf("Zoom: https://zoom.us/j/1"), "Zoom: https://zoom.us/j/1", "words left over: treated as a place");
  assert.equal(cal.placeOf("Οδός Παραδείγματος 12"), "Οδός Παραδείγματος 12");
  assert.equal(cal.placeOf("   "), null);
  assert.equal(one(CALL).call, true);
});

test("the maps-link venue still gets its leave-now nudge", () => {
  const ev = g({ id: "diner", summary: "Dinner", tz: "America/Chicago", start: "2026-11-20T19:30:00-06:00", end: "2026-11-20T21:00:00-06:00",
    location: "Maple Diner Northport (https://maps.app.goo.gl/AbC123xyz)" });
  const out = cal.fromPayload({ events: [ev] }, { memo: {}, nowMs: Date.parse("2026-11-20T19:00:00-06:00"), classify: fakeClassify(), rt: cal.createRuntime(), setMemo: () => {} });
  const d = out.find((e) => e.type === "calendar.departure_window");
  assert.ok(d);
  assert.equal(d.data.location, ev.location);
});

test("departure warnings: a Zoom link is not a place; the dental appointment still gets one", async () => {
  const before = (ev, min) => cal.fromPayload({ events: [ev] }, { memo: {}, nowMs: new Date(ev.start.dateTime).getTime() - min * 60e3,
    classify: fakeClassify(), rt: cal.createRuntime(), setMemo: () => {} });
  assert.equal(before(CALL, 30).filter((e) => e.type === "calendar.departure_window").length, 0);
  const d = before(DENTAL, 30).find((e) => e.type === "calendar.departure_window");
  assert.ok(d, "a real address within 40 min still gets the leave-now nudge");
  assert.equal(d.data.location, DENTAL.location);
});

// ── release takes two models: the cautious answer always wins ──
const DAY = 864e5;
function jevWorld({ shadowWeek, jev }) {
  fs.rmSync(process.env.JEV_SHADOW_DIR, { recursive: true, force: true });
  const until = new Date(Date.now() + (shadowWeek ? DAY : -DAY)).toISOString();
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: until, privacy_exclusions: false, sites: {} }));
  fs.writeFileSync(path.join(process.env.JEV_QUESTIONS_DIR, "calendar-hold.json"), JSON.stringify({ ...QUESTION, shadow_until: until }));
  globalThis.fetch = async () => (jev.error
    ? new Response("boom", { status: 500 })
    : new Response(JSON.stringify({ answers: { kind: { type: "choice", choice: jev.choice,
        probabilities: { attending: 0, container: 0, unclear: 1 - jev.p, [jev.choice]: jev.p } } } }), { status: 200 }));
}
async function classify(world, claudeSays) {
  jevWorld(world);
  let claudeCalls = 0;
  const ladder = async (state, q) => {
    claudeCalls++;
    assert.ok(q.criteria.container && state.title, "the ladder gets the same question and entry");
    if (claudeSays instanceof Error) throw claudeSays;
    return claudeSays;
  };
  const r = await cal.classifyLongEvent(one(DAYTRIP), { ladder });
  return { r, claudeCalls };
}

test("shadow week: Jev container but Sonnet attending or unclear → hold", async () => {
  const a = await classify({ shadowWeek: true, jev: { choice: "container", p: 0.95 } }, "attending");
  assert.deepEqual(a.r, { verdict: "attending", used: "cautious" });
  assert.equal(holds(DAYTRIP, { [key(DAYTRIP)]: a.r }), true);
  const dis = fs.readFileSync(path.join(process.env.JEV_SHADOW_DIR, "disagreements.jsonl"), "utf8");
  assert.ok(dis.includes("calendar-hold"), "the disagreement is logged for jev-disagreement-review");
  const u = await classify({ shadowWeek: true, jev: { choice: "container", p: 0.95 } }, "unclear");
  assert.equal(u.r.verdict, "unclear");
});

test("both saying container releases, in and after the shadow week", async () => {
  for (const shadowWeek of [true, false]) {
    const { r, claudeCalls } = await classify({ shadowWeek, jev: { choice: "container", p: 0.95 } }, "container");
    assert.deepEqual(r, { verdict: "container", used: "jev+claude" });
    assert.equal(claudeCalls, 1, "Sonnet runs once, shared by the shadow and the confirmation");
  }
});

test("after the shadow week a confident Jev container still needs Sonnet's agreement", async () => {
  const { r } = await classify({ shadowWeek: false, jev: { choice: "container", p: 0.97 } }, "attending");
  assert.equal(r.verdict, "attending");
  const down = await classify({ shadowWeek: false, jev: { choice: "container", p: 0.97 } }, new Error("not_logged_in"));
  assert.equal(down.r, null, "Jev's container alone never releases");
});

test("a confident Jev attending holds without asking Sonnet", async () => {
  const { r, claudeCalls } = await classify({ shadowWeek: false, jev: { choice: "attending", p: 0.95 } }, "container");
  assert.deepEqual(r, { verdict: "attending", used: "jev" });
  assert.equal(claudeCalls, 0);
});

test("an unsure Jev leaning attending vetoes Sonnet's container; Jev down → Sonnet alone", async () => {
  const unsure = await classify({ shadowWeek: false, jev: { choice: "attending", p: 0.6 } }, "container");
  assert.equal(unsure.r.verdict, "attending");
  const jevDown = await classify({ shadowWeek: false, jev: { error: true } }, "container");
  assert.deepEqual(jevDown.r, { verdict: "container", used: "claude" });
});

test("no question file → no verdict → hold", async () => {
  assert.equal(await cal.classifyLongEvent(one(DAYTRIP), { siteDef: null }), null);
});

test("trigger-hum.sh's fallback tick uses the same verdict and the daemon's cached answers", () => {
  const sh = fs.readFileSync(new URL("../agent/scripts/trigger-hum.sh", import.meta.url), "utf8");
  const a = sh.indexOf("node --input-type=module -e '");
  assert.ok(a > 0, "the cron calendar gate runs the sensor's calendarSituation");
  const code = sh.slice(a + "node --input-type=module -e '".length, sh.indexOf("' \"$HOME", a));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hum-cal-hold-"));
  try {
    const now = Date.now();
    const iso = (d) => new Date(now + d * 60e3).toISOString();
    const block = { ...DAYTRIP, start: { dateTime: iso(-120) }, end: { dateTime: iso(480) } };
    const stateFile = path.join(dir, "state.json");
    const run = (events, verdicts) => {
      fs.writeFileSync(stateFile, JSON.stringify({ sensors: { calendar: { memo: { verdicts } } } }));
      return spawnSync(process.execPath, ["--input-type=module", "-e", code, SENSOR.pathname, stateFile],
        { input: JSON.stringify(events), encoding: "utf8" }).stdout.trim();
    };
    assert.equal(run([block], {}), "1", "no cached verdict: holds, as before");
    assert.equal(run([block], { [key(block)]: { verdict: "container", at: iso(0) } }), "0");
    assert.equal(run([{ ...CALL, start: { dateTime: iso(-10) }, end: { dateTime: iso(20) } }], {}), "1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
