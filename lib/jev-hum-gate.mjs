// jev-hum-gate.mjs — Jev in front of the hum agent turn ("hum-ping-gate").
//
// The user asked for the job gates to be wired too, after the five
// decision sites (docs/jev.md). hum is Edva's biggest token consumer,
// and most of its Sonnet turns end silent by design (jobs/hum.md: "Most
// dispatches still end silently"). The deterministic gate in hum-events.mjs
// decides WHEN a moment is eligible; this asks Jev, only after that gate said
// dispatch, whether the moment gives hum a concrete reason to reach out.
//
//   Jev confident "no"  → the turn is SKIPPED (the saving). The bundle's events
//                         are consumed (dedup cooldown) so the same moment does
//                         not re-ask Jev every 10s tick; last_dispatch_at is NOT
//                         touched, so a skip never raises hum's threshold ramp.
//   Jev "yes" / unsure / unavailable / excluded → dispatch exactly as today.
//
// SHADOW (the week): the legacy mechanism is an agent turn that ACTS, so it
// cannot run in-line. Two late comparisons instead, both through
// jev-pending.mjs (each resolved once):
//   * Jev skipped → a DETACHED tool-less Sonnet judgment over the same bundle
//     (`bin/jev-gate-shadow hum-ping-gate <id>`). APPROXIMATION: the real
//     turn also harvests every lane before deciding; the shadow sees only what
//     Jev saw. hum-harvest-all --preview (2026-10-04) is side-effect free but
//     skips the model-forking lanes, so a faithful full replay still does not
//     exist; the preview IS used for idle bundles (§ Preview gate below).
//   * Jev confidently said dispatch → compared with what the turn actually did
//     (hum-runs.jsonl outcome.sent), joined by hum-sense's own reconcile() on
//     dispatch_id. Only CONFIDENT verdicts are compared: low-confidence ones
//     acted identically to legacy, and at hum's volume paging each one would be
//     noise (the decide() row still records them for calibration).
//
// NEVER SENT TO JEV: bundles touching health / exercise / finance / stocks
// lanes or the workout sensor (skipJev), idle-only bundles (also questions-only; their whole value is
// the harvested content Jev cannot see — skipping them would silently starve
// the slow lanes; they go through the side-effect-free PREVIEW gate instead,
// which looks at that content directly), and event `data` payloads (coordinates, biometrics) — Jev
// gets type/summary/lanes only. Everything else still passes the on-device
// privacy screen (privacyScreen). Fail-open everywhere: any error dispatches.

import path from "node:path";
import { execFile } from "node:child_process";
import os from "node:os";
import { decide, siteConfig, recordLateComparison, privacyOn } from "./jev-shadow.mjs";
import { answerConfidence, boolOf } from "./jev.mjs";
import { appendPending, readPending, markResolved, compactPending, spawnGateShadow } from "./jev-pending.mjs";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

export const SITE = "hum-ping-gate";

export const SENSITIVE_LANES = new Set(["health", "exercise", "finance", "stocks"]);
const SENSITIVE_SENSORS = new Set(["workout"]);
// Sensors whose whole value is harvested content Jev cannot see: `idle` (the
// slow lanes) and `questions` (questions waiting, a code-owned count). Bundles
// made only of these take the PREVIEW gate instead of Jev.
const CONTENT_SENSORS = new Set(["idle", "questions"]);

export function exclusionReason(verdict) {
  const events = verdict.accepted || [];
  if (privacyOn()) {
    if (events.some((e) => SENSITIVE_SENSORS.has(e.sensor))) return "health-excluded";
    const lanes = new Set([...(verdict.lanes || []), ...events.flatMap((e) => e.lanes || [])]);
    if (lanes.has("health") || lanes.has("exercise")) return "health-excluded";
    if (lanes.has("finance") || lanes.has("stocks")) return "financial-excluded";
  }
  if (events.length && events.every((e) => CONTENT_SENSORS.has(e.sensor))) return "idle-bundle";
  return null;
}

function localLabel(nowMs, tz) {
  try {
    return new Date(nowMs).toLocaleString("en-US", { timeZone: tz || instanceTz(), weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return new Date(nowMs).toISOString(); }
}

// What Jev (and the shadow) see: no `data`, no ids — situation only.
export function gateState({ verdict, gates = {}, state = {}, nowMs = Date.now(), tz }) {
  const last = state.last_dispatch_at ? Math.round((nowMs - Date.parse(state.last_dispatch_at)) / 60000) : null;
  return {
    local_time: localLabel(nowMs, tz),
    events: (verdict.accepted || []).map((e) => ({
      sensor: e.sensor, type: e.type, summary: String(e.summary || "").slice(0, 200),
      salience: e.salience, perishable: e.perishable === true, lanes: e.lanes || [],
    })),
    context: {
      activity: gates.activity_state || null,
      in_meeting: !!gates.in_meeting,
      minutes_since_last_hum_turn: last,
      bundle_salience: typeof verdict.score === "number" ? Math.round(verdict.score * 100) / 100 : null,
    },
  };
}

export function interpretGate(answers) {
  const a = answers.worth_reaching_out;
  const b = boolOf(a);
  if (b === null) throw new Error("jev: no worth_reaching_out answer");
  return { value: { dispatch: b }, confidence: answerConfidence(a) };
}

const spawnShadow = (id) => spawnGateShadow(SITE, id);

// Per-bundle verdict cache (code review 2026-09-23). hum-sense is a long-lived
// daemon ticking every 10s; when a dispatch FAILS it holds the events and the
// next tick re-evaluates the same bundle. Without this, a supervisor outage
// cost one on-device screen + one Jev call + one pending row per tick (~360/h)
// and stalled each tick. Keyed on the accepted events' dedup keys; a cache hit
// returns the first verdict and writes nothing new (so a re-tick never creates
// a second pending row for the same bundle — the one comparison is the first
// tick's, which reconcile marks no-run if that dispatch never ran).
const VERDICT_TTL_MS = 30 * 60e3;
const verdictCache = new Map();
export function bundleKey(verdict) {
  return (verdict.accepted || []).map((e) => e.dedup_key || `${e.sensor}:${e.type}`).sort().join("|");
}
export function _clearVerdictCache() { verdictCache.clear(); }

// Hard bound on what the gate may add to a tick: screen + Jev are raced against
// this, and a timeout dispatches (fail-open) — a perishable arrival event is
// never held longer than this for Jev's opinion.
export const GATE_BUDGET_MS = 7000;

// ─── Preview gate for idle bundles (2026-10-04) ──────────────────────────
//
// Idle-only bundles never go to Jev (exclusionReason → "idle-bundle"): their
// whole value is the harvested content, which Jev cannot see. That used to mean
// every idle bundle woke a full agent turn. hum-harvest-all now has a pure
// `--preview` mode (no state writes, dispatch context untouched, model lanes
// not run), so the gate can LOOK before dispatching: if a preview finds no
// eligible candidate (after claim-check and the pre-rank vetoes) and no
// model-forking lane was due — those were not looked at, so "nothing found"
// would not be honest — the turn is skipped exactly like a Jev skip.
//
// Conservative by construction: any preview error, timeout, lane error or a
// due model lane dispatches as before. Idle bundles are never perishable, so a
// preview's few seconds cost nothing; it has its own budget, outside Jev's.
// Disable with HUM_PREVIEW_GATE=0.
export const PREVIEW_BUDGET_MS = 30000;
const HARVEST_ALL = installTools("agent/scripts/hum-harvest-all.mjs");
const EDVA = installTools("bin/edva");

function execJson(cmd, args, { input = "", timeoutMs, env }) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) },
        (err, stdout) => {
          if (err && !stdout) return resolve(null);
          try { resolve(JSON.parse(String(stdout).trim().split("\n").pop())); } catch { resolve(null); }
        });
      child.on("error", () => resolve(null));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } catch { resolve(null); }
  });
}

/** Decide from a preview harvest's output. Pure — unit-tested. */
export function previewVerdict(out) {
  if (!out || !out.meta) return { skip: false, reason: "preview unavailable — dispatch" };
  const m = out.meta;
  if (m.error) return { skip: false, reason: `preview error (${String(m.error).slice(0, 80)}) — dispatch` };
  if ((m.preview_skipped_model_lanes || []).length) {
    return { skip: false, reason: `model lanes due (${m.preview_skipped_model_lanes.join(",")}) — dispatch` };
  }
  if ((m.errors || []).length) return { skip: false, reason: `${m.errors.length} lane error(s) in preview — dispatch` };
  const eligible = typeof m.eligible_count === "number" ? m.eligible_count : (out.candidates || []).length;
  if (eligible > 0) return { skip: false, reason: `${eligible} eligible candidate(s) — dispatch` };
  const vetoed = (m.pre_rank_vetoes || []).length;
  return {
    skip: true,
    reason: `preview: nothing eligible (${(m.attempted || []).length} lanes looked, ${vetoed} vetoed, ${(out.claim_check?.dropped || []).length} refuted)`,
  };
}

export async function previewGate({ timeoutMs = PREVIEW_BUDGET_MS, lanes = [] } = {}) {
  const started = Date.now();
  const situation = await execJson(EDVA, ["hum", "situation", "--json"], { timeoutMs: Math.min(20000, timeoutMs) });
  const left = timeoutMs - (Date.now() - started);
  if (left < 2000) return { skip: false, reason: "preview: no time left after situation — dispatch" };
  // A bundle that names its lanes (questions waiting) previews those lanes the
  // way the real dispatch will run them: focused, past their cadence.
  const out = await execJson(process.execPath, [HARVEST_ALL, "--preview"], {
    input: JSON.stringify(situation || {}), timeoutMs: left,
    env: lanes.length ? { ...process.env, HUM_FOCUS_LANES: lanes.join(",") } : undefined,
  });
  return previewVerdict(out);
}

/**
 * @returns {Promise<{dispatch: boolean, reason: string, via?: "preview"|"jev"}>}
 */
export async function humJevGate(args, deps = {}) {
  const key = bundleKey(args.verdict || {});
  const nowMs = args.nowMs ?? Date.now();
  for (const [k, v] of verdictCache) if (nowMs - v.at > VERDICT_TTL_MS) verdictCache.delete(k);
  const hit = key && verdictCache.get(key);
  if (hit) return { ...hit.result, reason: `${hit.result.reason} (cached)` };
  if (process.env.HUM_PREVIEW_GATE !== "0" && deps.previewGate !== false
      && exclusionReason(args.verdict || {}) === "idle-bundle") {
    let pg;
    try { pg = await (deps.previewGate || previewGate)({ lanes: args.verdict?.lanes || [] }); } catch (err) { pg = { skip: false, reason: `preview threw — dispatch: ${err?.message || err}` }; }
    if (pg.skip) {
      const result = { dispatch: false, reason: pg.reason, via: "preview" };
      if (key) verdictCache.set(key, { at: nowMs, result });
      return result;
    }
    // Something to look at → the unchanged path below (Jev excluded as
    // "idle-bundle", legacy dispatch, decide() row recorded as before).
  }
  let timer;
  const ctl = { timedOut: false };
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => { ctl.timedOut = true; resolve({ dispatch: true, reason: `jev-gate over ${GATE_BUDGET_MS}ms budget — fail-open` }); }, deps.budgetMs ?? GATE_BUDGET_MS);
  });
  const result = await Promise.race([humJevGateInner(args, deps, ctl), budget]);
  clearTimeout(timer);
  if (key) verdictCache.set(key, { at: nowMs, result });
  return result;
}

async function humJevGateInner({ verdict, gates, state, nowMs = Date.now(), dispatchId, tz }, deps = {}, ctl = {}) {
  try {
    const s = gateState({ verdict, gates, state, nowMs, tz });
    const skipJev = exclusionReason(verdict) || undefined;
    const r = await (deps.decide || decide)({
      site: SITE,
      id: dispatchId,
      state: s,
      logInput: s,
      interpret: interpretGate,
      // Legacy = today's behavior: the deterministic gate already said dispatch.
      legacy: async () => ({ dispatch: true }),
      // The real legacy verdict (did the turn ping?) only exists later.
      same: () => null,
      skipJev,
      privacyScreen: true,
      jevTimeoutMs: 5000,
    });
    const p = r.jev?.answers?.worth_reaching_out?.probability;
    const jev = r.jev && !r.jev.error ? { dispatch: r.value?.dispatch, confidence: r.jev.confidence, p } : null;
    // Over budget: the caller already dispatched. Record nothing — a late
    // "skipped" row for a turn that actually ran would poison the comparison.
    if (ctl.timedOut) return { dispatch: true, reason: "jev-gate over budget" };
    if (r.used === "jev" && r.value?.dispatch === false) {
      appendPending(SITE, { id: dispatchId, kind: "skipped", jev, state: s });
      if (siteConfig(SITE).inShadow) (deps.spawnShadow || spawnShadow)(dispatchId);
      return { dispatch: false, reason: `jev: nothing worth a turn (p=${typeof p === "number" ? p.toFixed(2) : "?"})` };
    }
    if (r.used === "jev") appendPending(SITE, { id: dispatchId, kind: "dispatched", jev, state: s });
    return { dispatch: true, reason: r.used === "jev" ? "jev: dispatch" : `legacy (${r.reason || "jev not used"})` };
  } catch (err) {
    return { dispatch: true, reason: `jev-gate error — fail-open: ${String(err?.message || err).slice(0, 120)}` };
  }
}

/** A Jev skip consumes the bundle without counting as a dispatch. */
export function applyJevSkip(state, verdict, { pruneState, config, nowMs = Date.now() }) {
  const iso = new Date(nowMs).toISOString();
  state.dedup = state.dedup || {};
  for (const e of verdict.accepted || []) state.dedup[e.dedup_key] = iso;
  state.pending = [];
  return pruneState ? pruneState(state, config, nowMs) : state;
}

/**
 * Outcome record for dispatches Jev confidently let through. `outcomeRows` are
 * the rows hum-sense's reconcile() just computed (kind:"outcome").
 *
 * CALIBRATION, NOT A COMPARISON (jev-disagreement-review, 2026-09-24). Jev is
 * asked whether the moment gives hum a concrete reason to reach out, and by the
 * question's own bar it answers false only when a moment CLEARLY offers nothing
 * (p(true) <= 0.1) -- so a "true" means "plausibly something here", not "the
 * turn will ping". The turn then harvests every lane and stays silent most of
 * the time BY DESIGN (jobs/hum.md; measured over 2026-08-31..09-23: ~17 runs a
 * day, ~6 pings), and it can also end silent because a DOWNSTREAM gate killed
 * the ping (outbound-precheck, claim-freshness) rather than because the moment
 * was empty. `sent:false` after a Jev dispatch is therefore not evidence that
 * either mechanism was wrong. Scoring it as one paged the system channel about
 * ten times a day and pulled the site's agree% toward hum's silence rate. The
 * row is still written -- `outcome_sent` is the real calibration number for the
 * end-of-week report ("of the ticks Jev confidently dispatched, X% pinged") --
 * but it is not a comparison and never pages.
 *
 * The SKIPPED case stays a true comparison: jev-gate-shadow puts the same
 * question to Sonnet over the same bundle, and a Jev skip that Sonnet says was
 * worth a ping IS a disagreement -- and the expensive direction, since a missed
 * ping is invisible.
 */
export function reconcileHumOutcomes(outcomeRows, nowMs = Date.now()) {
  const pending = new Map(readPending(SITE).filter((r) => r.kind === "dispatched").map((r) => [r.id, r]));
  let compared = 0;
  for (const o of outcomeRows || []) {
    const p = pending.get(o.dispatch_id);
    if (!p) continue;
    if (o.match === "no-run" || o.sent === null || o.sent === undefined) { markResolved(SITE, p.id, "no-run"); continue; }
    if (!markResolved(SITE, p.id, "outcome")) continue;
    const sent = !!o.sent;
    recordLateComparison({
      site: SITE, id: p.id,
      jevRow: { used: "jev", input: p.state, jev: { value: p.jev, confidence: p.jev?.confidence } },
      legacyValue: { sent, decision: o.decision ?? null, subject: o.subject ?? null, via: "hum-turn" },
      calibration: true,
      extra: { outcome_sent: sent },
    });
    compared++;
  }
  compactPending(SITE, nowMs);
  return compared;
}
