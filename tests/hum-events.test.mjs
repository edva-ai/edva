// Tests for hum's event-admission gate (lib/hum-events.mjs).
//
// The gate is the one piece of the situational-trigger framework whose
// behaviour has to be provable: it decides whether a moment costs an agent
// turn. It is pure by construction (events + state + config + gates in, a
// verdict out), so everything below is exercised without touching the clock,
// the filesystem, or the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate, applyDecision, normalizeEvent, emptyState, inHourWindow,
  DEFAULT_CONFIG, buildPayload, applyQuietHours,
} from "../lib/hum-events.mjs";

const NOW = new Date("2026-08-02T18:00:00Z").getTime();
const CONFIG = { ...DEFAULT_CONFIG, coalesce_sec: 0 }; // coalescing tested separately

function ev(over = {}) {
  return normalizeEvent({
    type: "location.arrival",
    sensor: "location",
    subject: "the home office",
    summary: "Arrived at the home office",
    salience: 0.6,
    lanes: ["location_context"],
    dedup_key: "location:visit:1:arrival",
    ts: new Date(NOW - 60_000).toISOString(),
    ...over,
  });
}

function run(events, { state = emptyState(), gates = {}, config = CONFIG } = {}) {
  return evaluate({ events, state, config, nowMs: NOW, gates: { local_hour: 14, ...gates } });
}

test("a salient event during waking hours dispatches", () => {
  const v = run([ev()]);
  assert.equal(v.decision, "dispatch");
  assert.equal(v.accepted.length, 1);
  assert.deepEqual(v.lanes, ["location_context"]);
});

test("no events is idle, not a dispatch", () => {
  assert.equal(run([]).decision, "idle");
});

test("quiet hours drop everything without holding it for the morning", () => {
  const v = run([ev()], { gates: { local_hour: 3 } });
  assert.equal(v.decision, "idle");
  assert.equal(v.held.length, 0);
  assert.equal(v.dropped[0].reason, "quiet_hours");
});

test("override_quiet punches through quiet hours", () => {
  const v = run([ev({ override_quiet: true, salience: 0.95 })], { gates: { local_hour: 3 } });
  assert.equal(v.decision, "dispatch");
});

test("sleeping/winding_down activity drops like quiet hours", () => {
  for (const activity_state of ["sleeping", "winding_down"]) {
    const v = run([ev()], { gates: { activity_state } });
    assert.equal(v.decision, "idle", activity_state);
    assert.equal(v.dropped[0].reason, `activity:${activity_state}`);
  }
});

test("pause drops everything", () => {
  const v = run([ev()], { gates: { paused: true } });
  assert.equal(v.decision, "idle");
  assert.equal(v.dropped[0].reason, "paused");
});

test("a meeting HOLDS rather than drops — the moment isn't wrong, the timing is", () => {
  const v = run([ev()], { gates: { in_meeting: true } });
  assert.equal(v.decision, "hold");
  assert.equal(v.held.length, 1);
  assert.equal(v.dropped.length, 0);
});

test("an outstanding hum question holds too", () => {
  assert.equal(run([ev()], { gates: { pending_question: true } }).decision, "hold");
});

test("an urgent event overrides the soft gates", () => {
  const v = run([ev({ salience: 0.95 })], { gates: { in_meeting: true, pending_question: true } });
  assert.equal(v.decision, "dispatch");
});

test("held events are carried forward and ship once the gate clears", () => {
  const state = emptyState();
  const first = run([ev()], { state, gates: { in_meeting: true } });
  assert.equal(first.decision, "hold");
  applyDecision(state, first, CONFIG, NOW);
  assert.equal(state.pending.length, 1);

  const second = evaluate({ events: [], state, config: CONFIG, nowMs: NOW + 60_000, gates: { local_hour: 14 } });
  assert.equal(second.decision, "dispatch");
  assert.equal(second.accepted[0].dedup_key, "location:visit:1:arrival");
});

test("dedup cooldown suppresses a repeat of the same key", () => {
  const state = emptyState();
  const first = run([ev()], { state });
  applyDecision(state, first, CONFIG, NOW);

  const second = evaluate({ events: [ev({ ts: new Date(NOW + 5 * 60_000).toISOString() })], state, config: CONFIG, nowMs: NOW + 5 * 60_000, gates: { local_hour: 14 } });
  assert.equal(second.decision, "idle");
  assert.match(second.dropped[0].reason, /^cooldown:/);
});

test("cooldown expires — the same key is admissible again later", () => {
  const state = emptyState();
  applyDecision(state, run([ev()], { state }), CONFIG, NOW);
  const later = NOW + (CONFIG.default_cooldown_min + 1) * 60_000;
  const v = evaluate({
    events: [ev({ ts: new Date(later).toISOString() })],
    state, config: CONFIG, nowMs: later, gates: { local_hour: 14 },
  });
  assert.equal(v.decision, "dispatch");
});

test("an expired event is dropped, never held", () => {
  const stale = ev({ ts: new Date(NOW - 120 * 60_000).toISOString(), ttl_min: 20 });
  const v = run([stale]);
  assert.equal(v.decision, "idle");
  assert.equal(v.dropped[0].reason, "expired");
});

test("the global refractory window holds a second dispatch", () => {
  const state = emptyState();
  state.last_dispatch_at = new Date(NOW - 2 * 60_000).toISOString();
  const v = run([ev({ dedup_key: "other:key" })], { state });
  assert.equal(v.decision, "hold");
  assert.match(v.reason, /refractory/);
});

test("the refractory window yields to a genuinely urgent event", () => {
  const state = emptyState();
  state.last_dispatch_at = new Date(NOW - 2 * 60_000).toISOString();
  const v = run([ev({ dedup_key: "other:key", salience: 0.95 })], { state });
  assert.equal(v.decision, "dispatch");
});

test("the salience bar rises with recent dispatches (self-throttling)", () => {
  const state = emptyState();
  // Six dispatches in the window: base 0.35 + 6×0.08 = 0.83.
  state.dispatches = Array.from({ length: 6 }, (_, i) => new Date(NOW - (20 + i) * 60_000).toISOString());
  const v = run([ev({ salience: 0.6, dedup_key: "k" })], { state });
  assert.equal(v.decision, "hold");
  assert.match(v.reason, /below threshold/);
  assert.ok(v.threshold > 0.8, `threshold was ${v.threshold}`);

  // A quiet day keeps the same event dispatchable.
  const quiet = run([ev({ salience: 0.6, dedup_key: "k" })], { state: emptyState() });
  assert.equal(quiet.decision, "dispatch");
});

test("the threshold is capped so hum never goes permanently deaf", () => {
  const state = emptyState();
  state.dispatches = Array.from({ length: 50 }, () => new Date(NOW - 60_000).toISOString());
  const v = run([ev({ salience: 1 })], { state });
  assert.ok(v.threshold <= CONFIG.salience_threshold_max);
  assert.equal(v.decision, "dispatch");
});

test("corroborating events raise the combined score, but weak ones never stack into a ping", () => {
  const two = run([ev({ dedup_key: "a", salience: 0.5 }), ev({ dedup_key: "b", salience: 0.5, type: "calendar.meeting_ended" })]);
  assert.equal(two.decision, "dispatch");
  assert.ok(two.score > 0.5 && two.score < 0.6);

  const state = emptyState();
  state.dispatches = Array.from({ length: 4 }, () => new Date(NOW - 30 * 60_000).toISOString()); // threshold 0.67
  const weak = run([
    ev({ dedup_key: "a", salience: 0.3 }),
    ev({ dedup_key: "b", salience: 0.3 }),
    ev({ dedup_key: "c", salience: 0.3 }),
  ], { state });
  assert.equal(weak.decision, "hold");
});

test("the coalescing window holds a very fresh event so siblings can join it", () => {
  const config = { ...DEFAULT_CONFIG, coalesce_sec: 30 };
  const v = run([ev({ ts: new Date(NOW - 5_000).toISOString() })], { config });
  assert.equal(v.decision, "hold");
  assert.equal(v.reason, "coalescing window");
});

test("dispatched lanes are the union of the accepted events' lanes", () => {
  const v = run([
    ev({ dedup_key: "a", lanes: ["dining", "situation"] }),
    ev({ dedup_key: "b", lanes: ["situation", "weather"], type: "weather.precip_incoming" }),
  ]);
  assert.deepEqual([...v.lanes].sort(), ["dining", "situation", "weather"]);
});

test("the payload carries the trigger, the events and the focus lanes", () => {
  const p = buildPayload(run([ev()]));
  assert.equal(p.job, "hum");
  assert.equal(p.trigger, "event");
  assert.equal(p.events.length, 1);
  assert.deepEqual(p.lanes, ["location_context"]);
  assert.match(p.focus, /Arrived at the home office/);
});

test("applyDecision records the dispatch and stamps every accepted dedup key", () => {
  const state = emptyState();
  const v = run([ev({ dedup_key: "a" }), ev({ dedup_key: "b" })], { state });
  applyDecision(state, v, CONFIG, NOW);
  assert.equal(state.dispatches.length, 1);
  assert.ok(state.dedup.a && state.dedup.b);
  assert.equal(state.pending.length, 0);
});

test("normalizeEvent namespaces the type and clamps salience", () => {
  const e = normalizeEvent({ type: "arrival", sensor: "location", salience: 4 });
  assert.equal(e.type, "location.arrival");
  assert.equal(e.salience, 1);
  const already = normalizeEvent({ type: "location.arrival", sensor: "location" });
  assert.equal(already.type, "location.arrival");
});

test("hour windows handle both same-day and midnight-wrapping forms", () => {
  assert.equal(inHourWindow(3, 0, 9), true);
  assert.equal(inHourWindow(14, 0, 9), false);
  assert.equal(inHourWindow(23, 22, 6), true);
  assert.equal(inHourWindow(2, 22, 6), true);
  assert.equal(inHourWindow(12, 22, 6), false);
});

// ── dispatch context ──────────────────────────────────────────────────────
//
// Regression guard for the day-one failure: the playbook was told to pass the
// payload's `lanes` through as HUM_FOCUS_LANES and didn't, so a
// location.started_moving dispatch harvested `music, news` while every
// implicated lane sat in skipped_cadence. The dispatcher now records the focus
// itself. These assert the producing half of that contract.

test("dispatch writes the focus lanes where the harvester can find them", async () => {
  const { PATHS, readJson } = await import("../lib/hum-events.mjs");
  const fs = await import("node:fs");
  const backup = readJson(PATHS.dispatchContext, null);
  try {
    const v = run([ev({ lanes: ["location_context", "weather"] })]);
    // dispatch() writes the context before it tries any supervisor; with none
    // healthy it still returns cleanly, and the file must already be there.
    const { dispatch } = await import("../lib/hum-events.mjs");
    await dispatch(buildPayload(v));
    const ctx = readJson(PATHS.dispatchContext, null);
    assert.ok(ctx, "no dispatch context written");
    assert.deepEqual(ctx.lanes, ["location_context", "weather"]);
    assert.equal(ctx.trigger, "event");
    assert.ok(ctx.events.length >= 1);
    assert.ok(Date.now() - new Date(ctx.ts).getTime() < 60_000, "context timestamp must be fresh");
  } finally {
    if (backup) fs.writeFileSync(PATHS.dispatchContext, JSON.stringify(backup, null, 2));
    else try { fs.unlinkSync(PATHS.dispatchContext); } catch {}
  }
});

test("an idle dispatch records empty lanes, so it can't inherit an earlier focus", async () => {
  const { PATHS, readJson, dispatch } = await import("../lib/hum-events.mjs");
  const fs = await import("node:fs");
  const backup = readJson(PATHS.dispatchContext, null);
  try {
    await dispatch(buildPayload(run([ev({ lanes: ["dining"], dedup_key: "x" })])));
    await dispatch(buildPayload(run([ev({ lanes: [], dedup_key: "y", type: "idle.quiet" })])));
    assert.deepEqual(readJson(PATHS.dispatchContext, null).lanes, []);
  } finally {
    if (backup) fs.writeFileSync(PATHS.dispatchContext, JSON.stringify(backup, null, 2));
    else try { fs.unlinkSync(PATHS.dispatchContext); } catch {}
  }
});

// ── outcome reconciliation ────────────────────────────────────────────────
//
// The ledger used to record an event's FIRST verdict and nothing else, so it
// could say "dispatched" and never what came of it. These cover the join that
// closes the loop — deliberately a pure function over (pending, runs), since
// the time-window matching is the part that can silently mis-attribute.

test("a dispatch is joined to the hum run that followed it", async () => {
  const { reconcileOutcomes } = await import("../lib/hum-events.mjs");
  const pending = [{ dispatch_id: "d_1", ts: new Date(NOW).toISOString() }];
  const runs = [{
    ts: new Date(NOW + 90_000).toISOString(),
    tick_id: "t-1",
    sonnet: { decision: "silent", based_on_topic: "music", rationale: "already settled" },
    outcome: { sent: false, ping_id: null },
    harvest: { focus_source: "dispatch-context", attempted: ["music", "dining"] },
  }];
  const { rows, stillPending } = reconcileOutcomes(pending, runs, { nowMs: NOW + 120_000 });
  assert.equal(stillPending.length, 0);
  assert.equal(rows[0].kind, "outcome");
  assert.equal(rows[0].dispatch_id, "d_1");
  assert.equal(rows[0].decision, "silent");
  assert.equal(rows[0].sent, false);
  assert.equal(rows[0].lag_sec, 90);
  assert.equal(rows[0].focus_source, "dispatch-context");
  assert.equal(rows[0].attempted, 2);
});

test("a run that PRECEDES the dispatch is never claimed as its outcome", async () => {
  const { reconcileOutcomes } = await import("../lib/hum-events.mjs");
  const pending = [{ dispatch_id: "d_1", ts: new Date(NOW).toISOString() }];
  const earlier = [{ ts: new Date(NOW - 60_000).toISOString(), sonnet: { decision: "ping" }, outcome: { sent: true } }];
  const { rows, stillPending } = reconcileOutcomes(pending, earlier, { nowMs: NOW + 60_000 });
  assert.equal(rows.length, 0, "must not attribute an earlier run to a later dispatch");
  assert.equal(stillPending.length, 1, "still waiting for its own run");
});

test("the EARLIEST run after the dispatch wins, not the newest", async () => {
  const { reconcileOutcomes } = await import("../lib/hum-events.mjs");
  const pending = [{ dispatch_id: "d_1", ts: new Date(NOW).toISOString() }];
  const runs = [
    { ts: new Date(NOW + 600_000).toISOString(), tick_id: "late", sonnet: {}, outcome: {} },
    { ts: new Date(NOW + 60_000).toISOString(), tick_id: "first", sonnet: {}, outcome: {} },
  ];
  const { rows } = reconcileOutcomes(pending, runs, { nowMs: NOW + 900_000 });
  assert.equal(rows[0].tick_id, "first");
});

test("a dispatch that produced no run at all is recorded, not forgotten", async () => {
  const { reconcileOutcomes } = await import("../lib/hum-events.mjs");
  const pending = [{ dispatch_id: "d_1", ts: new Date(NOW).toISOString() }];
  // Inside the window it keeps waiting...
  const early = reconcileOutcomes(pending, [], { nowMs: NOW + 60_000, windowMin: 20 });
  assert.equal(early.rows.length, 0);
  assert.equal(early.stillPending.length, 1);
  // ...past it, the gap itself becomes a record. An agent turn that never ran
  // is exactly what this log exists to surface.
  const late = reconcileOutcomes(pending, [], { nowMs: NOW + 21 * 60_000, windowMin: 20 });
  assert.equal(late.rows[0].match, "no-run");
  assert.equal(late.stillPending.length, 0);
});

test("a ping that was actually sent carries its ping id", async () => {
  const { reconcileOutcomes } = await import("../lib/hum-events.mjs");
  const rows = reconcileOutcomes(
    [{ dispatch_id: "d_1", ts: new Date(NOW).toISOString() }],
    [{ ts: new Date(NOW + 30_000).toISOString(), sonnet: { decision: "ping" }, outcome: { sent: true, ping_id: "p-123" } }],
    { nowMs: NOW + 60_000 },
  ).rows;
  assert.equal(rows[0].sent, true);
  assert.equal(rows[0].ping_id, "p-123");
});

test("buildPayload mints a dispatch id so the chain can be correlated", () => {
  const a = buildPayload(run([ev()]));
  const b = buildPayload(run([ev({ dedup_key: "z" })]));
  assert.match(a.dispatch_id, /^d_/);
  assert.notEqual(a.dispatch_id, b.dispatch_id);
});

// ── the quiet-hours shoulder ─────────────────────────────────────────────
//
// A single 00:00–09:00 window cost the hour worth the most: it dropped
// location edges from just before nine — the user already out and about —
// because 08:5x is "before 9". `wake_floor` splits it: hard quiet below,
// evidence-driven above.

test("hard quiet below the wake floor is absolute, even for a location edge", () => {
  const v = run([ev()], { gates: { local_hour: 3 } });
  assert.equal(v.decision, "idle");
  assert.equal(v.dropped[0].reason, "quiet_hours");
});

test("the shoulder yields to the events themselves — someone moving about before nine is awake", () => {
  const v = run([ev()], { gates: { local_hour: 8 } });
  assert.equal(v.decision, "dispatch", "a location edge in the shoulder is its own proof the user is up");
});

test("the shoulder yields to the activity model", () => {
  const v = run([ev({ sensor: "comms", type: "comms.email_wave", salience: 0.6, dedup_key: "comms:wave" })],
    { gates: { local_hour: 8, activity_state: "active" } });
  assert.equal(v.decision, "dispatch");
});

test("the shoulder stays quiet with no evidence either way — failure mode is the old behaviour", () => {
  const v = run([ev({ sensor: "comms", type: "comms.email_wave", salience: 0.6, dedup_key: "comms:wave" })],
    { gates: { local_hour: 8 } });
  assert.equal(v.decision, "idle");
  assert.equal(v.dropped[0].reason, "quiet_hours");
});

test("a sleeping activity state still wins inside the shoulder", () => {
  // The user slept in. An arrival event would otherwise read as evidence, but the
  // activity model saying "sleeping" is the stronger signal and drops it.
  const v = run([ev()], { gates: { local_hour: 8, activity_state: "sleeping" } });
  assert.equal(v.decision, "idle");
  assert.equal(v.dropped[0].reason, "activity:sleeping");
});

test("applyQuietHours reports which band it landed in", () => {
  const g = (local_hour, extra = {}) => ({ local_hour, ...extra });
  assert.equal(applyQuietHours(CONFIG, g(3), []).band, "asleep");
  assert.equal(applyQuietHours(CONFIG, g(14), []).band, "day");
  assert.equal(applyQuietHours(CONFIG, g(8), []).band, "shoulder:no-evidence");
  assert.equal(applyQuietHours(CONFIG, g(8), [ev()]).band, "shoulder:awake");
});

// ── perishable moments ───────────────────────────────────────────────────

test("a perishable event routes the dispatch to the priority source", () => {
  const v = run([ev({ perishable: true })]);
  const p = buildPayload(v);
  assert.equal(p.perishable, true);
  assert.equal(p.source, "hum:moment", "so the supervisor lifts it over the cron backlog");
  assert.equal(p.events[0].perishable, true);
});

test("an ordinary cadence tick stays an ordinary hum dispatch", () => {
  const v = run([ev({ sensor: "idle", type: "idle.quiet", salience: 0.6, dedup_key: "idle:quiet" })]);
  const p = buildPayload(v);
  assert.equal(p.perishable, false);
  assert.equal(p.source, "hum", "an idle tick has waited 75 minutes; it can wait two more");
});

test("normalizeEvent defaults perishable to false and only accepts a real true", () => {
  assert.equal(normalizeEvent({ type: "x.y" }).perishable, false);
  assert.equal(normalizeEvent({ type: "x.y", perishable: "yes" }).perishable, false);
  assert.equal(normalizeEvent({ type: "x.y", perishable: true }).perishable, true);
});

// ── perishable moments don't ramp ────────────────────────────────────────
//
// What matters is whether there is anything relevant and interesting to
// suggest, not the number of pings. The dispatch-count ramp is a
// chattiness control, and it can cost a real moment: a few dispatches earlier
// in the hour push the bar up, so a location edge on a walk is held — not
// for lack of anything to say, but because hum had answered an unrelated
// question earlier.

test("a busy hour raises the bar for ordinary ticks", () => {
  const state = emptyState();
  state.dispatches = Array.from({ length: 4 }, (_, i) => new Date(NOW - (i + 1) * 60_000).toISOString());
  const v = run([ev({ sensor: "idle", type: "idle.quiet", salience: 0.6, dedup_key: "idle:quiet" })], { state });
  assert.equal(v.decision, "hold");
  assert.ok(v.threshold > 0.6, `expected a ramped bar, got ${v.threshold}`);
});

test("...but a perishable moment is judged on its own merit, not the tally", () => {
  const state = emptyState();
  state.dispatches = Array.from({ length: 4 }, (_, i) => new Date(NOW - (i + 1) * 60_000).toISOString());
  const v = run([ev({ perishable: true, salience: 0.48, dedup_key: "excursion:downtown" })], { state });
  assert.equal(v.decision, "dispatch", "the walk, replayed");
  assert.equal(v.threshold, CONFIG.base_salience_threshold);
});

test("a no_ramp event (questions waiting) is held to the base bar, not the tally", () => {
  const state = emptyState();
  state.dispatches = Array.from({ length: 4 }, (_, i) => new Date(NOW - (i + 1) * 60_000).toISOString());
  const v = run([ev({ sensor: "questions", type: "questions.waiting", salience: 0.45, lanes: ["dream_asks"], dedup_key: "questions:waiting", no_ramp: true })], { state });
  assert.equal(v.decision, "dispatch", "the question pool already paces questions");
  assert.equal(v.threshold, CONFIG.base_salience_threshold);
  assert.equal(normalizeEvent({ type: "x.y" }).no_ramp, false);
});

test("a questions-only bundle waits the 5-minute question refractory, not the global one", () => {
  const state = emptyState();
  state.last_dispatch_at = new Date(NOW - 6 * 60_000).toISOString();
  const q = ev({ sensor: "questions", type: "questions.waiting", salience: 0.45, lanes: ["dream_asks"], dedup_key: "questions:waiting", no_ramp: true });
  assert.equal(run([q], { state }).decision, "dispatch");
  state.last_dispatch_at = new Date(NOW - 3 * 60_000).toISOString();
  assert.match(run([q], { state }).reason, /refractory \(3m < 5m\)/);
});

test("the refractory window still stops two pings landing on top of each other", () => {
  const state = emptyState();
  state.last_dispatch_at = new Date(NOW - 60_000).toISOString();
  const v = run([ev({ perishable: true, salience: 0.62 })], { state });
  assert.equal(v.decision, "hold");
  assert.match(v.reason, /refractory/);
});
