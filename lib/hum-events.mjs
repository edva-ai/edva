// hum-events — the event bus + admission gate behind hum's situational trigger
// framework (2026-08-02 rewrite of the 20-min tick model).
//
// The old model: a flat cron tick every 20 min asked "is there anything to say?"
// Situational signal was a bonus layered on top of a cadence that would have
// fired regardless. The correction: situational awareness should DRIVE the
// hum, and the clock should only be the fallback for when the user is genuinely idle
// and nothing else is known.
//
// The new model, in three parts:
//
//   sensors  →  events  →  gate  →  dispatch
//
//   * SENSORS (agent/scripts/hum-sensors/*.mjs) are cheap edge detectors.
//     Each one answers exactly one question — "did X just change?" — and emits
//     zero or more events. They never reason, never call an LLM, never decide
//     whether the user should be pinged. Poll sensors are run in-process by the
//     `hum-sense` daemon on their own interval; push sources (phone-channel's
//     realtime location subscription, gmail ingress, anything else) drop an
//     event into the spool file and the daemon picks it up within one tick.
//
//   * EVENTS are a single normalized shape (see normalizeEvent). The important
//     fields are `salience` (0-1, how much this moment warrants attention) and
//     `lanes` (which hum harvest lanes this event makes relevant — the thing
//     that lets an event-driven tick harvest 3 lanes instead of all 30).
//
//   * The GATE (`evaluate`) is a PURE function: events + state + config +
//     situation gates in, a decision out. No I/O, no clock reads, no network —
//     everything it needs is passed in. That is what makes it testable
//     (tests/hum-events.test.mjs) and what keeps it fast: a full gate
//     evaluation is sub-millisecond, so the daemon can afford to run it on
//     every tick without ever waking an agent.
//
// Nothing in this file talks to an LLM. The gate's only job is to decide
// whether this moment is worth spending an agent turn on; the hum playbook
// still owns what to actually say (or, most of the time, not say).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFileAtomic } from "./atomic-write.js";
import { createRequire } from "node:module";
import { installRoot } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

const HOME = os.homedir();
const EDVA = installRoot();
export const PATHS = {
  registry: path.join(EDVA, "data/hum-sensors.json"),
  state: path.join(EDVA, "data/hum-sense-state.json"),
  inbox: path.join(EDVA, "data/hum-events-inbox.jsonl"),
  ledger: path.join(EDVA, "data/hum-events.jsonl"),
  heartbeat: path.join(EDVA, "data/hum-sense-heartbeat.json"),
  // Written at dispatch, read by hum-harvest-all.mjs so the focused harvest
  // doesn't depend on the agent remembering to pass HUM_FOCUS_LANES.
  dispatchContext: path.join(EDVA, "data/hum-dispatch-context.json"),
  userTz: path.join(EDVA, "data/user-timezone.json"),
  humState: path.join(EDVA, "data/hum-state.json"),
  pendingQuestion: path.join(EDVA, "data/hum-pending-question.json"),
  jobRouting: path.join(EDVA, "agent/config/job-routing.json"),
  webhookToken: path.join(EDVA, "secrets/webhook-token"),
  sensorDir: path.join(EDVA, "agent/scripts/hum-sensors"),
  // An installation's own sensors (an overlay drop); a kernel sensor wins on a name.
  sensorExtDir: path.join(EDVA, "agent/scripts/hum-sensors/_ext"),
};

// Defaults are the source of truth for shape; hum-sensors.json only overrides.
// Keeping them here means a corrupt/missing registry degrades to a working
// engine rather than a dead one.
export const DEFAULT_CONFIG = {
  tick_sec: 10,                        // daemon master tick (drains spool, runs due sensors)
  coalesce_sec: 25,                    // hold a fresh event this long to let correlated ones join it
  global_refractory_min: 10,           // min gap between dispatches, overridable by high salience
  question_refractory_min: 5,          // the same gap for a questions-waiting-only bundle
  base_salience_threshold: 0.35,       // floor a moment must clear to be worth an agent turn
  salience_ramp_per_recent_dispatch: 0.08, // each recent dispatch makes the next one harder
  recent_window_min: 120,
  salience_threshold_max: 0.9,
  urgent_salience: 0.9,                // bypasses soft gates (meeting, pending question, refractory)
  // Local wall clock. `start`–`wake_floor` is an unconditional drop (the user is
  // asleep and nothing is worth it). `wake_floor`–`end` is the soft shoulder:
  // quiet *unless* something proves the user is already up. See applyQuietHours.
  quiet_hours: { start: 0, end: 9, wake_floor: 7 },
  default_ttl_min: 30,                 // an event nobody dispatched on goes stale
  default_cooldown_min: 45,            // per dedup_key
  max_pending: 40,
  ledger_max_rows: 4000,
};

// ─── small io helpers ──────────────────────────────────────────────────────

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// Atomic: the daemon and any CLI invocation can race on the state file, and a
// half-written hum-sense-state.json would silently reset every cooldown.
// Now on the shared helper (lib/atomic-write.js, D15), which also fsyncs.
export function writeJsonAtomic(p, obj) {
  try {
    writeFileAtomic(p, JSON.stringify(obj, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function userTz() {
  const tz = readJson(PATHS.userTz, null)?.timezone;
  if (!tz) return instanceTz();
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; }
  catch { return instanceTz(); }
}

export function localHour(tz = userTz(), now = new Date()) {
  return parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "2-digit", hour12: false }), 10);
}

export function localParts(tz = userTz(), now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    hour: parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10),
    weekday: String(p.weekday || "").toLowerCase(),
    date: `${p.year}-${p.month}-${p.day}`,
    minutes_of_day: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
  };
}

// ─── registry / config ─────────────────────────────────────────────────────

export function loadRegistry() {
  const raw = readJson(PATHS.registry, null);
  const config = { ...DEFAULT_CONFIG, ...(raw?.config || {}) };
  const sensors = Array.isArray(raw?.sensors) ? raw.sensors : [];
  return { config, sensors, schema_version: raw?.schema_version ?? 1 };
}

// ─── state ─────────────────────────────────────────────────────────────────

export function emptyState() {
  return {
    schema_version: 1,
    last_dispatch_at: null,
    dispatches: [],   // ISO strings, pruned to recent_window_min * 2
    dedup: {},        // dedup_key -> ISO of last time it was ACCEPTED for dispatch
    sensors: {},      // name -> {last_run_at, last_error, memo}
    pending: [],      // events awaiting a dispatchable moment
  };
}

export function loadState() {
  const s = readJson(PATHS.state, null);
  if (!s || typeof s !== "object") return emptyState();
  return { ...emptyState(), ...s };
}

export function saveState(state) {
  return writeJsonAtomic(PATHS.state, state);
}

// Drop bookkeeping we will never read again. Called before every save so the
// state file stays small enough to parse in under a millisecond.
export function pruneState(state, config = DEFAULT_CONFIG, nowMs = Date.now()) {
  const dispatchCutoff = nowMs - Math.max(config.recent_window_min * 2, 240) * 60000;
  state.dispatches = (state.dispatches || [])
    .filter((iso) => new Date(iso).getTime() > dispatchCutoff)
    .slice(-200);
  const dedupCutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, iso] of Object.entries(state.dedup || {})) {
    if (!(new Date(iso).getTime() > dedupCutoff)) delete state.dedup[k];
  }
  state.pending = (state.pending || [])
    .filter((e) => !isExpired(e, config, nowMs))
    .slice(-config.max_pending);
  return state;
}

// ─── sensor error logging ──────────────────────────────────────────────────
//
// A sensor that throws keeps `last_error` on every run — that is what
// `hum-sense status` reads, and blindness must stay visible there. The log is a
// different reader and wants transitions, not a copy per poll: the excursion
// sensor throws "location feed stale" every minute that the user's phone has had
// nothing new to report (a night's sleep, an hour in a cafe), which was 96% of
// hum-sense.log over several days and buried every line worth reading.
//
// So the log gets: the first occurrence, a reminder once an hour while the same
// error persists (with how many repeats went unlogged), and one line when the
// sensor recovers. "The same error" is the sensor's `err.repeat_key` when it
// sets one (messages that embed a changing number need it), else the message.
export const SENSOR_ERROR_REPEAT_MIN = 60;

/**
 * prev   — the sensor's state entry BEFORE this run (may be {}).
 * result — { name, error, error_key } from one run.
 * Returns { line, fields }: `line` is what to log (or null), `fields` go into
 * the sensor's state entry so the next run can tell a repeat from a new error.
 */
export function sensorErrorLog(prev, result, nowMs, repeatMin = SENSOR_ERROR_REPEAT_MIN) {
  const p = prev || {};
  const name = result?.name || "?";
  const nowIso = new Date(nowMs).toISOString();
  const clear = { error_key: null, error_since: null, error_logged_at: null, error_repeats: 0 };
  if (!result?.error) {
    if (!p.error_key) return { line: null, fields: clear };
    const sinceMs = Date.parse(p.error_since);
    const mins = Number.isFinite(sinceMs) ? Math.max(0, Math.round((nowMs - sinceMs) / 60000)) : null;
    return { line: `sensor ${name} recovered${mins != null ? ` after ${mins}m` : ""} (was: ${p.last_error ?? p.error_key})`, fields: clear };
  }
  const key = result.error_key || result.error;
  if (p.error_key !== key) {
    return { line: `sensor ${name} error: ${result.error}`, fields: { error_key: key, error_since: nowIso, error_logged_at: nowIso, error_repeats: 0 } };
  }
  const loggedMs = Date.parse(p.error_logged_at);
  const repeats = (Number(p.error_repeats) || 0) + 1;
  if (Number.isFinite(loggedMs) && nowMs - loggedMs < repeatMin * 60000) {
    return { line: null, fields: { error_key: key, error_since: p.error_since ?? nowIso, error_logged_at: p.error_logged_at, error_repeats: repeats } };
  }
  return {
    line: `sensor ${name} error: ${result.error} (still failing since ${p.error_since ?? "?"}; ${repeats - 1} repeat(s) not logged)`,
    fields: { error_key: key, error_since: p.error_since ?? nowIso, error_logged_at: nowIso, error_repeats: 0 },
  };
}

// ─── event shape ───────────────────────────────────────────────────────────

/**
 * Normalize whatever a sensor (or an external push source) hands us into the
 * canonical event shape. Unknown fields are dropped on purpose — the gate and
 * the dispatch payload are a contract, and a sensor that wants to pass more
 * detail through puts it in `data`.
 */
export function normalizeEvent(raw, sensorName = null) {
  if (!raw || typeof raw !== "object") return null;
  const sensor = String(raw.sensor || sensorName || "unknown");
  const type = String(raw.type || sensor);
  const ts = raw.ts && !Number.isNaN(new Date(raw.ts).getTime())
    ? new Date(raw.ts).toISOString()
    : new Date().toISOString();
  return {
    id: raw.id || `evt_${new Date(ts).getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts,
    sensor,
    // `type` is namespaced <sensor>.<edge> by convention — "location.arrival",
    // "calendar.meeting_ended". Cooldowns and telemetry key off it.
    type: type.includes(".") ? type : `${sensor}.${type}`,
    subject: raw.subject == null ? null : String(raw.subject).slice(0, 200),
    summary: String(raw.summary || raw.subject || type).slice(0, 400),
    salience: clamp01(raw.salience ?? 0.5),
    lanes: Array.isArray(raw.lanes) ? raw.lanes.map(String).slice(0, 8) : [],
    dedup_key: String(raw.dedup_key || `${type}:${raw.subject || ""}`).slice(0, 200),
    ttl_min: numOr(raw.ttl_min, null),
    cooldown_min: numOr(raw.cooldown_min, null),
    // Rare and deliberate: a genuinely time-critical event (a flight leaving,
    // a lock left unlocked) may cross the quiet-hours gate. Sensors must opt in.
    override_quiet: raw.override_quiet === true,
    // "Worth nothing if it arrives late." An arrival is the canonical case: a
    // note about what is around the user is useful for the few minutes before they
    // sits down and worthless after. Perishable events are dispatched at
    // higher priority (they jump a cron backlog rather than queue behind a
    // 10-minute job) and the harvest declines to build a moment-bound
    // suggestion once the dispatch has gone stale — better silent than a
    // twenty-minute-late "there's a good bakery on this corner".
    perishable: raw.perishable === true,
    // An event whose own pacing is already code (the questions sensor: the
    // question pool's cap and spacing) skips the chattiness ramp below.
    no_ramp: raw.no_ramp === true,
    data: raw.data && typeof raw.data === "object" ? raw.data : {},
  };
}

export function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// Note the explicit null/"" guard: Number(null) is 0, not NaN, so a naive
// Number()-and-check would silently turn "no ttl specified" into "ttl of zero
// minutes" — i.e. every re-normalized event expiring the instant it is read.
function numOr(v, fallback) {
  if (v == null || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function ageMin(iso, nowMs) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 60000;
}

function isExpired(e, config, nowMs) {
  return ageMin(e.ts, nowMs) > (e.ttl_min ?? config.default_ttl_min);
}

// ─── the gate (pure) ───────────────────────────────────────────────────────

/**
 * Decide whether the events on hand justify waking the hum agent right now.
 *
 * PURE: no clock reads, no file reads, no network. Everything it needs arrives
 * in `input`. That is deliberate — this is the one piece of the framework whose
 * behaviour has to be provable, and it is the piece that runs most often.
 *
 * @param {object} input
 *   @param {object[]} input.events    freshly-emitted events this tick
 *   @param {object}   input.state     hum-sense-state.json (read-only here)
 *   @param {object}   input.config    merged registry config
 *   @param {number}   input.nowMs
 *   @param {object}   input.gates     situational hard/soft gates, all optional:
 *      {local_hour, paused, activity_state, in_meeting, pending_question,
 *       hum_disabled}
 * @returns {{decision:"dispatch"|"hold"|"idle", reason:string,
 *            accepted:object[], held:object[], dropped:{event,reason}[],
 *            threshold:number, score:number, lanes:string[]}}
 */
export function evaluate(input) {
  const config = { ...DEFAULT_CONFIG, ...(input.config || {}) };
  const state = input.state || emptyState();
  const nowMs = input.nowMs ?? Date.now();
  const gates = input.gates || {};
  const dropped = [];

  // Everything still in flight: this tick's new events plus anything the gate
  // held earlier and hasn't expired. Held events are how correlated signals
  // ("meeting ended" + "arrived home") end up in ONE ping instead of two, and
  // how a signal that arrived mid-meeting still gets its moment afterwards.
  const incoming = (input.events || []).map((e) => normalizeEvent(e)).filter(Boolean);
  const carried = (state.pending || []).map((e) => normalizeEvent(e)).filter(Boolean);
  const byId = new Map();
  for (const e of [...carried, ...incoming]) byId.set(e.id, e);
  let live = [...byId.values()];

  // 1. Expiry — a stale edge is not a moment. Drop rather than hold.
  live = live.filter((e) => {
    if (!isExpired(e, config, nowMs)) return true;
    dropped.push({ event: e, reason: "expired" });
    return false;
  });

  // 2. Per-dedup_key cooldown. Keyed on the last time this key was ACCEPTED
  //    (not merely seen), so a suppressed event doesn't extend its own cooldown.
  live = live.filter((e) => {
    const last = state.dedup?.[e.dedup_key];
    if (!last) return true;
    const cd = e.cooldown_min ?? config.default_cooldown_min;
    if (ageMin(last, nowMs) >= cd) return true;
    dropped.push({ event: e, reason: `cooldown:${e.dedup_key}` });
    return false;
  });

  const summarize = (decision, reason, accepted = [], held = [], threshold = 0, score = 0) => ({
    decision, reason, accepted, held, dropped, threshold, score,
    lanes: [...new Set(accepted.flatMap((e) => e.lanes || []))],
  });

  if (!live.length) return summarize("idle", "no live events");

  // 3. HARD gates — nothing survives these, and nothing is held for later
  //    either: if the user is asleep, the fact that a shop opened at 03:00 is not
  //    worth resurfacing at 09:00 (the sensor will re-detect anything that
  //    still matters). The one exception is an explicit override_quiet event.
  if (gates.hum_disabled) return summarize("idle", "hum disabled");
  if (gates.paused) {
    for (const e of live) dropped.push({ event: e, reason: "paused" });
    return summarize("idle", "hum paused");
  }
  const { inQuiet } = applyQuietHours(config, gates, live);
  const asleep = gates.activity_state === "sleeping" || gates.activity_state === "winding_down";
  if (inQuiet || asleep) {
    const survivors = live.filter((e) => e.override_quiet);
    for (const e of live) {
      if (!e.override_quiet) dropped.push({ event: e, reason: inQuiet ? "quiet_hours" : `activity:${gates.activity_state}` });
    }
    if (!survivors.length) return summarize("idle", inQuiet ? "quiet hours" : `activity=${gates.activity_state}`);
    live = survivors;
  }

  // Combined salience: the strongest event carries the bundle, with a small
  // bonus for corroboration. Two independent signals pointing at the same
  // moment really are more interesting than one — but three weak ones should
  // never add up to an interruption, hence the additive-not-multiplicative form.
  const top = live.reduce((a, b) => (b.salience > a.salience ? b : a));
  const score = clamp01(top.salience + 0.05 * (live.length - 1));

  // 4. SOFT gates — hold, don't drop. The moment isn't wrong, it's just badly
  //    timed; re-evaluate next tick.
  const urgent = score >= config.urgent_salience;
  if (!urgent && gates.in_meeting) return summarize("hold", "in a meeting", [], live, 0, score);
  if (!urgent && gates.pending_question) return summarize("hold", "a hum question is already outstanding", [], live, 0, score);

  // 5. Global refractory — however interesting the world is, don't ping twice
  //    inside this window unless something is genuinely urgent.
  //    A bundle of only `no_ramp` events (questions waiting) uses the shorter
  //    question refractory: the user wants the queue drained 5 minutes apart.
  const sinceDispatch = state.last_dispatch_at ? ageMin(state.last_dispatch_at, nowMs) : Infinity;
  const refractory = live.every((e) => e.no_ramp)
    ? (config.question_refractory_min ?? DEFAULT_CONFIG.question_refractory_min)
    : config.global_refractory_min;
  if (!urgent && sinceDispatch < refractory) {
    return summarize("hold", `refractory (${Math.round(sinceDispatch)}m < ${refractory}m)`, [], live, 0, score);
  }

  // 6. Coalesce — give a very fresh event a moment for correlated siblings to
  //    land, so an arrival + the calendar event it belongs to ship as one tick.
  //    Skipped when something else in the bundle has already waited.
  const youngest = Math.min(...live.map((e) => ageMin(e.ts, nowMs)));
  const oldest = Math.max(...live.map((e) => ageMin(e.ts, nowMs)));
  if (!urgent && oldest * 60 < config.coalesce_sec && youngest * 60 < config.coalesce_sec) {
    return summarize("hold", "coalescing window", [], live, 0, score);
  }

  // 7. Dynamic threshold — the bar rises with how much hum has already said
  //    recently. This is the rate limiter, and it is intentionally a slope
  //    rather than a hard daily cap: a quiet day stays responsive, a busy one
  //    self-throttles without ever hard-refusing something important.
  const recent = (state.dispatches || []).filter((iso) => ageMin(iso, nowMs) <= config.recent_window_min).length;
  // A PERISHABLE moment does not ramp.
  //
  // The ramp is a chattiness control, and chattiness is the wrong thing to
  // control here: what matters is not the number of pings but whether there is
  // anything relevant and interesting to suggest.
  //
  // Ramped, a few dispatches earlier in the hour push the bar high enough that
  // a fresh location edge (the user out somewhere new) is held — not because
  // there is nothing worth saying, but because hum answered an unrelated
  // question an hour before. Bookkeeping beats a real moment.
  //
  // The quality bar for these lives downstream instead, where it can actually
  // see the content: `nearby` scores its own candidate and discards anything
  // under a floor that rises while the user is walking, and a tick with nothing worth
  // saying ends in silence that costs nothing. The global refractory below
  // still stops two pings landing on top of each other.
  // A `no_ramp` event (questions waiting) is paced by the question pool instead.
  const unramped = live.some((e) => e.perishable || e.no_ramp);
  const threshold = unramped
    ? config.base_salience_threshold
    : Math.min(
      config.salience_threshold_max,
      config.base_salience_threshold + config.salience_ramp_per_recent_dispatch * recent
    );
  if (score < threshold) {
    return summarize("hold", `below threshold (${score.toFixed(2)} < ${threshold.toFixed(2)}, ${recent} recent)`, [], live, threshold, score);
  }

  return summarize("dispatch", `score ${score.toFixed(2)} ≥ ${threshold.toFixed(2)}`, live, [], threshold, score);
}

/**
 * Quiet hours, in two bands rather than one.
 *
 * A single blanket window (say 00:00–09:00 local) costs exactly the hour
 * worth the most: it drops location edges from the user heading out for the
 * day just because they land a few minutes before the window ends. The
 * morning arrival is the single best moment hum has for saying something
 * locally useful, and a blanket window makes it structurally unreachable.
 *
 * So: `start`–`wake_floor` stays an unconditional drop (03:00 is 03:00).
 * `wake_floor`–`end` becomes a shoulder that yields to evidence the user is up:
 *
 *   - the activity model says anything other than sleeping/winding_down, or
 *   - the events themselves are proof — a location edge, the desk waking, a
 *     workout. Someone walking down the street at 08:51 is awake, and the event
 *     that says so should not be dropped for being early.
 *
 * With no evidence either way the shoulder stays quiet, so the failure mode is
 * the old behaviour rather than a 07:15 ping on a morning the user slept in.
 *
 * PURE, like the rest of the gate.
 */
const WAKE_EVIDENCE_SENSORS = new Set(["location", "desk", "workout"]);

export function applyQuietHours(config, gates, live = []) {
  const qh = config.quiet_hours || DEFAULT_CONFIG.quiet_hours;
  const hour = gates.local_hour;
  if (!Number.isFinite(hour)) return { inQuiet: false, band: "unknown" };

  const floor = qh.wake_floor ?? qh.end;
  const inHardQuiet = inHourWindow(hour, qh.start, floor);
  if (inHardQuiet) return { inQuiet: true, band: "asleep" };

  const inShoulder = inHourWindow(hour, floor, qh.end);
  if (!inShoulder) return { inQuiet: false, band: "day" };

  const activityAwake = Boolean(gates.activity_state) &&
    gates.activity_state !== "sleeping" && gates.activity_state !== "winding_down";
  const eventEvidence = live.some((e) => WAKE_EVIDENCE_SENSORS.has(e.sensor));
  const awake = gates.awake === true || activityAwake || eventEvidence;
  return { inQuiet: !awake, band: awake ? "shoulder:awake" : "shoulder:no-evidence" };
}

// Hour windows wrap midnight (0-9 doesn't, 22-6 does) — both forms are valid
// in the registry, so handle them uniformly.
export function inHourWindow(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ─── post-decision state transitions ───────────────────────────────────────

export function applyDecision(state, verdict, config = DEFAULT_CONFIG, nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString();
  if (verdict.decision === "dispatch") {
    state.last_dispatch_at = iso;
    state.dispatches = [...(state.dispatches || []), iso];
    for (const e of verdict.accepted) state.dedup[e.dedup_key] = iso;
    state.pending = [];
  } else {
    state.pending = verdict.held || [];
  }
  return pruneState(state, config, nowMs);
}

// ─── ledger ────────────────────────────────────────────────────────────────

/**
 * One line per event with the verdict that met it. This is the audit trail
 * `hum-review` reads to answer "why didn't hum say anything all afternoon?" —
 * which the old model could only answer with "the tick found nothing."
 */
export function appendLedger(rows, config = DEFAULT_CONFIG) {
  if (!rows.length) return;
  try {
    fs.mkdirSync(path.dirname(PATHS.ledger), { recursive: true });
    fs.appendFileSync(PATHS.ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {}
  // Cheap bounded truncation: only rewrite when we're meaningfully over.
  try {
    const stat = fs.statSync(PATHS.ledger);
    if (stat.size < 2_000_000) return;
    const lines = fs.readFileSync(PATHS.ledger, "utf8").split("\n").filter(Boolean);
    if (lines.length <= config.ledger_max_rows) return;
    fs.writeFileSync(PATHS.ledger, lines.slice(-config.ledger_max_rows).join("\n") + "\n");
  } catch {}
}

/**
 * Read the last `n` lines of a file without slurping it. The run trace grows
 * unbounded; the reconciler only ever cares about the last few minutes of it.
 */
export function tailLines(file, n = 200, maxBytes = 512 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // A partial first line is likely when we started mid-file — drop it.
    if (start > 0) lines.shift();
    return lines.slice(-n);
  } catch { return []; }
}

/** One row per dispatch: which events went, where, and under what score. */
export function dispatchLedgerRow(payload, verdict, result, nowIso = new Date().toISOString()) {
  return {
    ts: nowIso,
    kind: "dispatch",
    dispatch_id: payload.dispatch_id,
    trigger: payload.trigger,
    event_ids: verdict.accepted.map((e) => e.id),
    types: verdict.accepted.map((e) => e.type),
    summary: payload.focus,
    lanes: payload.lanes,
    score: verdict.score,
    threshold: verdict.threshold,
    delivered: Boolean(result?.ok),
    // "dispatched" (a turn of its own) vs "folded"/"folded+promoted" (merged
    // into a hum turn already waiting). A folded dispatch legitimately has no
    // run of its own, so the reconciler must not report it as a missing turn.
    delivery: result?.delivery ?? null,
    perishable: payload.perishable === true,
    port: result?.port ?? null,
    error: result?.error ?? null,
  };
}

/**
 * Close the loop: find what hum actually DID with each dispatch and write it
 * back to the ledger.
 *
 * The run trace (`hum-runs.jsonl`) is authored by the agent turn, so it carries
 * no dispatch_id we can rely on — we learned today not to depend on the agent
 * threading a field through. Instead this joins on time: the first run whose
 * timestamp falls after the dispatch and inside `windowMin`. That is a real
 * inference rather than a fact, so every row records `match` and the observed
 * lag, and a dispatch with no run in the window is recorded as `no-run` rather
 * than silently forgotten — an agent turn that never happened is exactly the
 * kind of failure this log exists to make visible.
 *
 * PURE: takes the candidate runs, returns rows + the still-pending list.
 */
export function reconcileOutcomes(pending, runs, { nowMs = Date.now(), windowMin = 20 } = {}) {
  const rows = [];
  const stillPending = [];
  for (const p of pending) {
    const dispatchMs = new Date(p.ts).getTime();
    const candidates = runs
      .filter((r) => {
        const t = new Date(r.ts).getTime();
        return Number.isFinite(t) && t >= dispatchMs && t - dispatchMs <= windowMin * 60000;
      })
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const run = candidates[0];
    if (run) {
      rows.push({
        ts: new Date(nowMs).toISOString(),
        kind: "outcome",
        dispatch_id: p.dispatch_id,
        tick_id: run.tick_id ?? null,
        run_ts: run.ts,
        lag_sec: Math.round((new Date(run.ts).getTime() - dispatchMs) / 1000),
        decision: run.sonnet?.decision ?? null,
        based_on_topic: run.sonnet?.based_on_topic ?? null,
        subject: run.sonnet?.subject ?? null,
        sent: run.outcome?.sent ?? null,
        ping_id: run.outcome?.ping_id ?? run.outcome?.question_id ?? null,
        rationale: String(run.sonnet?.rationale || "").slice(0, 400),
        focus_source: run.harvest?.focus_source ?? null,
        attempted: run.harvest?.attempted?.length ?? null,
        match: "time",
      });
      continue;
    }
    // No run yet. Keep waiting until the window closes, then record the gap.
    if (nowMs - dispatchMs <= windowMin * 60000) { stillPending.push(p); continue; }
    rows.push({
      ts: new Date(nowMs).toISOString(),
      kind: "outcome",
      dispatch_id: p.dispatch_id,
      decision: null,
      sent: null,
      match: "no-run",
      note: `no hum run appeared within ${windowMin}m of dispatch — the agent turn may never have run`,
    });
  }
  return { rows, stillPending };
}

export function ledgerRow(event, verdict, nowIso = new Date().toISOString()) {
  const outcome = verdict.accepted.some((a) => a.id === event.id) ? "dispatched"
    : verdict.held.some((h) => h.id === event.id) ? "held"
    : (verdict.dropped.find((d) => d.event.id === event.id)?.reason ?? "unknown");
  return {
    ts: nowIso,
    kind: "event",
    id: event.id,
    sensor: event.sensor,
    type: event.type,
    subject: event.subject,
    summary: event.summary,
    salience: event.salience,
    lanes: event.lanes,
    outcome,
    verdict: verdict.decision,
    reason: verdict.reason,
    score: verdict.score,
    threshold: verdict.threshold,
  };
}

// ─── spool (push sources) ──────────────────────────────────────────────────

/**
 * How anything outside the daemon injects an event: append one JSON line.
 * A file rather than a socket on purpose — no port to allocate or authenticate,
 * it survives a daemon restart (events queue up and drain on the next tick),
 * and any process or shell script can write to it with one line of code.
 */
export function spoolEvent(raw, sensorName = "external") {
  const e = normalizeEvent(raw, sensorName);
  if (!e) return null;
  try {
    fs.mkdirSync(path.dirname(PATHS.inbox), { recursive: true });
    fs.appendFileSync(PATHS.inbox, JSON.stringify(e) + "\n");
    return e;
  } catch { return null; }
}

/** Read and clear the spool. Rename-then-read so a concurrent write is never lost. */
export function drainSpool() {
  let raw;
  const tmp = `${PATHS.inbox}.draining.${process.pid}`;
  try {
    if (!fs.existsSync(PATHS.inbox)) return [];
    fs.renameSync(PATHS.inbox, tmp);
    raw = fs.readFileSync(tmp, "utf8");
    fs.unlinkSync(tmp);
  } catch { return []; }
  return raw.split("\n").filter(Boolean)
    .map((l) => { try { return normalizeEvent(JSON.parse(l)); } catch { return null; } })
    .filter(Boolean);
}

// ─── dispatch ──────────────────────────────────────────────────────────────

/**
 * Mirror of webhook-auth.sh's tier routing: hum is a sonnet-tier job, so it
 * belongs on ops-light (:9082) with ops (:9092) as the degrade-upward fallback.
 * Resolved from job-routing.json rather than hardcoded so a tier change in one
 * place moves both the shell triggers and this engine.
 */
export function resolveWebhookChain(job = "hum") {
  // Kernel job-routing.json + this installation's agent/local/job-routing.json.
  let routing = null;
  try { routing = createRequire(import.meta.url)("./registry.cjs").loadRegistry("job-routing", { root: EDVA }); } catch {}
  const model = routing?.jobs?.[job]?.model;
  if (model === "haiku") return [{ webhook: 9072, health: 9073 }, { webhook: 9082, health: 9083 }, { webhook: 9092, health: 9093 }];
  if (model && model !== "opus") return [{ webhook: 9082, health: 9083 }, { webhook: 9092, health: 9093 }];
  return [{ webhook: 9092, health: 9093 }];
}

export function webhookToken() {
  try { return fs.readFileSync(PATHS.webhookToken, "utf8").trim(); } catch { return ""; }
}

export async function supervisorHealthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    const body = await r.text();
    // A supervisor that has deliberately paused its dispatcher (auth outage)
    // is not a place to send work, even though the child is alive.
    if (body.includes('"dispatcherPaused":true')) return false;
    return body.includes('"childAlive":true');
  } catch { return false; }
}

/**
 * Build the payload the hum playbook receives. `lanes` is the load-bearing
 * field: it tells the playbook which harvest lanes this moment made relevant,
 * so an event tick can force those lanes and let the other ~27 stay on their
 * normal cadence instead of fanning out over everything.
 */
export function buildPayload(verdict, extra = {}) {
  const events = verdict.accepted.map((e) => ({
    type: e.type, sensor: e.sensor, subject: e.subject, summary: e.summary,
    salience: e.salience, ts: e.ts, perishable: e.perishable, data: e.data,
  }));
  const perishable = verdict.accepted.some((e) => e.perishable);
  return {
    job: "hum",
    trigger: "event",
    dispatch_id: newDispatchId(),
    // `source` is what the supervisor's dispatcher sees, and `hum:moment`
    // is what makes a perishable dispatch jump the cron backlog instead of
    // waiting behind a ten-minute batch job. A plain cadence/idle tick
    // stays ordinary `hum` — it has waited 75 minutes already and can wait
    // another two.
    source: perishable ? "hum:moment" : "hum",
    perishable,
    events,
    lanes: verdict.lanes,
    focus: events.map((e) => e.summary).join(" · ").slice(0, 400),
    salience: verdict.score,
    ...extra,
  };
}

/**
 * Write the dispatch context where `hum-harvest-all.mjs` can find it.
 *
 * The playbook is *told* to pass the payload's `lanes` through as
 * HUM_FOCUS_LANES, and on the first day live it simply didn't — a
 * `location.started_moving` dispatch produced a harvest that attempted
 * two unrelated lanes while every lane the event implicated sat in
 * `skipped_cadence`. The situational trigger fired and the harvest then
 * ignored what triggered it, which defeats the entire design.
 *
 * So the focus no longer depends on an agent remembering an instruction:
 * the dispatcher records it, the harvester reads it, and the env var stays
 * as an explicit override. Freshness-gated on the read side so a stale file
 * can never focus an unrelated later tick.
 */
function writeDispatchContext(payload) {
  const entry = {
    ts: new Date().toISOString(),
    dispatch_id: payload.dispatch_id ?? null,
    trigger: payload.trigger ?? null,
    lanes: payload.lanes ?? [],
    focus: payload.focus ?? null,
    salience: payload.salience ?? null,
    perishable: payload.perishable === true,
    // `data` rides along now (it used to be dropped here): the arrival event's
    // lat/lon is the entire input to the `nearby` lane, and re-deriving it from
    // findme inside the harvest would race against the user walking on.
    events: (payload.events || []).map((e) => ({
      type: e.type, summary: e.summary, salience: e.salience,
      perishable: e.perishable === true, data: e.data || {},
    })),
    consumed_at: null,
  };
  // A LIST, not a single record. The file used to hold only the newest
  // dispatch, which was fine when at most one hum turn could exist — but a
  // perishable dispatch can now be queued behind an in-flight one, and with a
  // single slot the older turn would harvest against the NEWER moment's lanes
  // and the newer turn would find its own context already "used". Each turn
  // now consumes the oldest unconsumed entry, i.e. the moment it was actually
  // dispatched for.
  const prev = readJson(PATHS.dispatchContext, null);
  const contexts = Array.isArray(prev?.contexts) ? prev.contexts.slice(-7) : [];
  contexts.push(entry);
  writeJsonAtomic(PATHS.dispatchContext, { schema: 2, ...entry, contexts });
}

/**
 * A correlation id threaded through the whole chain: event → dispatch →
 * harvest → what hum actually did. Without it the ledger can say an event was
 * dispatched but never what came of it, which is only half the story anyone
 * debugging a quiet afternoon actually wants.
 */
export function newDispatchId(nowMs = Date.now()) {
  return `d_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function dispatch(payload, { job = "hum" } = {}) {
  writeDispatchContext(payload);
  const chain = resolveWebhookChain(job);
  const headers = { "content-type": "application/json" };
  const token = webhookToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  for (const { webhook, health } of chain) {
    if (!(await supervisorHealthy(health))) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${webhook}`, {
        method: "POST", headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      // 200 = a turn of its own. 202 = folded into a hum turn already waiting.
      // The distinction has to reach the ledger: before this, the supervisor
      // answered 200 to a dispatch it had thrown away, so the ledger recorded
      // `delivered: true` and then `no run appeared` for the same dispatch —
      // which reads as a mysterious agent failure rather than the deliberate
      // drop it actually was.
      if (r.ok) {
        const delivery = r.status === 202
          ? String(await r.text().catch(() => "folded")).trim().toLowerCase()
          : "dispatched";
        return { ok: true, port: webhook, delivery };
      }
    } catch { /* try the next tier */ }
  }
  return { ok: false, port: null, error: "no healthy supervisor in chain" };
}

// ─── heartbeat ─────────────────────────────────────────────────────────────

/**
 * The daemon stamps this every tick. trigger-hum.sh reads it: a live daemon
 * means the cron has nothing to do and exits; a stale one means the event path
 * is down and the cron reverts to being the plain fallback tick it used to be.
 * That is the whole failsafe — no supervision tree, one file.
 */
export function stampHeartbeat(extra = {}) {
  writeJsonAtomic(PATHS.heartbeat, { ts: new Date().toISOString(), pid: process.pid, ...extra });
}

export function heartbeatAgeMin() {
  const hb = readJson(PATHS.heartbeat, null);
  if (!hb?.ts) return Infinity;
  return ageMin(hb.ts, Date.now());
}
