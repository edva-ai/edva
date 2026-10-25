// Shared helpers for hum harvester scripts.
//
// Each harvester:
//   1. reads JSON situation from stdin (use readStdinJson)
//   2. reads/writes its per-topic cache via readCache / writeCache
//   3. emits ONE candidate JSON on stdout, or the literal string "null"
//
// Candidates must be `{topic, signal, urgency, freshness_min, dedup_key, supporting_data}`.
// Fail-closed: any error in a harvester → emit "null" and a warning on stderr.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { installTools } from "../../../lib/root.cjs";
import { optionalBin } from "../../../lib/ext-hooks.mjs";
const HOME = os.homedir();

// Per-instance values (lib/instance.cjs). GOG_ACCOUNT: the Google account
// gog reads (the operator's own address; empty → gog's default account).
const { instance, localConfig } = createRequire(import.meta.url)("../../../lib/instance.cjs");
export const GOG_ACCOUNT = instance().owner_email;
// The operator's name for ranker-facing text, and the home timezone.
export const OWNER_NAME = instance().owner_name;
export const HOME_TZ = instance().tz;
export { localConfig };
const BIN_DIR = installTools("bin");
const CACHE_DIR = installTools("data/hum-cache");
const STATE_FILE = installTools("data/hum-interests-state.json");
const RUNS_FILE = installTools("data/hum-runs.jsonl");

const SILENCE_LIMIT_PER_DAY = 3;

// ─── Preview mode ───────────────────────────────────────────────────────────
//
// `hum-harvest-all --preview` runs the harvest to SEE what candidates exist
// without committing anything — the hum-sense gate uses it to decide whether
// an idle tick has anything eligible at all before waking a model. Harvesters
// write state all over data (cadence stamps, caches, seen-sets,
// suggestion-history, ping-media); a preview that stamped `last_run_at` would
// push every lane's real run back by a whole cadence. Rather than teach thirty
// harvesters a flag, every in-process write under data becomes a no-op
// here, before any harvester body runs (this module is imported first by all
// of them). syncBuiltinESMExports() propagates the patch to named imports
// (`import { writeFileSync } from "node:fs"`) as well as `fs.writeFileSync`.
// Writes outside data (os.tmpdir() scratch) still go through.
// Child processes a harvester spawns are NOT covered — which is why preview
// also skips the model-forking lanes entirely (hum-harvest-all MODEL_LANES).
export const PREVIEW = process.env.HUM_HARVEST_PREVIEW === "1";
if (PREVIEW) {
  const { syncBuiltinESMExports } = await import("node:module");
  const DATA_DIR = installTools("data");
  const guarded = (p) => {
    try { return path.resolve(String(p instanceof URL ? p.pathname : p)).startsWith(DATA_DIR); } catch { return false; }
  };
  for (const name of ["writeFileSync", "appendFileSync", "renameSync", "unlinkSync", "rmSync", "mkdirSync", "copyFileSync"]) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function previewGuard(p, ...rest) { return guarded(p) ? undefined : orig.call(fs, p, ...rest); };
  }
  for (const name of ["writeFile", "appendFile", "rename", "unlink", "rm", "mkdir", "copyFile"]) {
    const orig = fs.promises[name];
    if (typeof orig !== "function") continue;
    fs.promises[name] = async function previewGuard(p, ...rest) { return guarded(p) ? undefined : orig.call(fs.promises, p, ...rest); };
  }
  syncBuiltinESMExports();
}

/**
 * Count how many times a dedup_key has appeared as a candidate AND been
 * silenced (outcome.sent === false) in today's hum-runs. Used by emit() to
 * suppress signals Sonnet has already declined ≥3 times today — repeating
 * them another 5+ ticks adds noise without adding decision value.
 */
function countSilencedToday(dedupKey) {
  if (!dedupKey) return 0;
  let raw;
  try { raw = fs.readFileSync(RUNS_FILE, "utf8"); } catch { return 0; }
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (!line.includes(`"${dedupKey}"`)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = String(row.ts || "").slice(0, 10);
    if (ts !== today) continue;
    const cands = row?.harvest?.candidates || [];
    const matched = cands.some((c) => c?.dedup_key === dedupKey);
    if (!matched) continue;
    const sent = row?.outcome?.sent;
    if (sent === false) count++;
  }
  return count;
}

/**
 * Read the harvester input envelope from stdin.
 * Contract: the wrapper writes ONE JSON object:
 *   { situation, context }
 * where:
 *   situation = output of `edva hum situation --json`
 *   context   = output of `edva context --json` (profile/tastes/projects/knowledge/recent)
 *
 * Backward-compat: if the payload lacks the envelope shape (older callers
 * passed situation directly), treat the whole payload as situation + build
 * context lazily in-process.
 */
export async function readStdinJson() {
  const empty = { situation: {}, context: {}, moment: null, intent: null };
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return empty;
  let payload;
  try { payload = JSON.parse(raw); } catch { return empty; }
  if (payload && typeof payload === "object" && ("situation" in payload || "context" in payload)) {
    return {
      situation: payload.situation || {},
      context: payload.context || {},
      // `moment` — the event(s) this turn was woken for, with their data (an
      // arrival's lat/lon) and how stale they are. `intent` — today's agreed
      // plan plus the user's own recent messages. Harvesters that predate
      // these fields simply ignore them.
      moment: payload.moment || null,
      intent: payload.intent || null,
    };
  }
  // legacy: caller passed situation directly
  return { ...empty, situation: payload };
}

export function readCache(topic) {
  const p = path.join(CACHE_DIR, `${topic}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const ageMin = Math.round((Date.now() - new Date(raw._cached_at).getTime()) / 60000);
    return { ...raw, _age_min: ageMin };
  } catch {
    return null;
  }
}

export function writeCache(topic, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, `${topic}.json`),
      JSON.stringify({ ...data, _cached_at: new Date().toISOString() }, null, 2)
    );
  } catch (e) {
    console.error(`[${topic}] cache write failed: ${e.message}`);
  }
}

export function cacheIsFresh(topic, ttlMinutes) {
  const c = readCache(topic);
  if (!c) return false;
  return c._age_min < ttlMinutes;
}

/**
 * Emit a candidate (validated) or null. Always writes exactly one JSON document
 * on stdout so the parallel wrapper can parse each harvester's output cleanly.
 */
export function emit(candidate) {
  if (!candidate) { console.log("null"); return; }
  const dedupKey = candidate.dedup_key || `${candidate.topic}:${Date.now()}`;
  const silenced = countSilencedToday(dedupKey);
  if (silenced >= SILENCE_LIMIT_PER_DAY) {
    console.error(`[${candidate.topic}] suppressed: dedup_key silenced ${silenced}× today`);
    console.log("null");
    return;
  }
  const shaped = {
    topic: candidate.topic,
    signal: String(candidate.signal || "").slice(0, 1500),
    urgency: clamp01(candidate.urgency ?? 0),
    freshness_min: Math.max(0, Math.round(candidate.freshness_min ?? 0)),
    dedup_key: dedupKey,
    supporting_data: candidate.supporting_data || {},
    // Optional temporal_fit metadata. Lets the ranker score WHEN a candidate is best
    // surfaced relative to the user's current situation, not just whether
    // it's interesting. Harvesters can pass this verbatim; omitted = the
    // ranker treats it as "no temporal preference" (anytime). Schema:
    //   { relative_to: "calendar_event"|"time_of_day"|"transition"|"working_on"|"free_window"|"commitment"|"always",
    //     anchor: <descriptor> (e.g. event id, HH:MM range, commitment text),
    //     boost_during: ["pre_event_30min"|"post_event_15min"|"evening_wind_down"|...],
    //     expires_after_iso: <ISO> }
    // The situation harvester (hum-harvesters/situation.mjs) sets this
    // aggressively; domain harvesters fill it lazily as they get retrofitted.
    temporal_fit: candidate.temporal_fit || null,
    // Optional act_fit metadata. The
    // companion to temporal_fit: where temporal_fit captures WHEN to surface,
    // act_fit captures whether the user can ACT on the suggestion. Heavy-lift
    // candidates (art / music / new restaurant requiring research) get a
    // small ranker deboost AND trigger a post-rank evaluator that bundles
    // decision_aids inline so the surfaced ping is yes/no instead of a
    // research project. Schema:
    //   { effort_to_act: "quick_win" | "moderate" | "heavy_lift",
    //     steps_to_act: [...],    (ordered, concrete)
    //     decision_aids: {        (populated lazily by post-rank evaluator
    //                             for moderate/heavy_lift winners; absent ok)
    //       for: ["why yes"], against: ["why no"], primer: "<research bundle>"
    //     }
    //   }
    // Harvester self-tags effort_to_act per its domain; doesn't pre-compute
    // decision_aids (that's the evaluator's job, fires only on the chosen
    // winner). Omitted entirely = ranker treats as "moderate" (neutral).
    act_fit: candidate.act_fit || null,
  };
  console.log(JSON.stringify(shaped));
}

export function emitNull(reason) {
  if (reason) console.error(`[${path.basename(process.argv[1])}] null: ${reason}`);
  console.log("null");
}

/**
 * Emit an explicit BENIGN no-op — an expected, non-error reason to have no
 * candidate this tick (e.g. a geo-gate decline while traveling). Writes a stable
 * `[noop]` marker so hum-harvest-all's classifier scores it as a noop
 * DETERMINISTICALLY instead of regex-guessing from the prose (which mis-scored
 * "gated: away…" as a harvester error). Use this instead
 * of emitNull for outcomes that must never count against the error scorecard.
 * (Genuine fetch failures stay on emitNull — a real outage should stay visible.)
 */
export function emitNoop(reason) {
  console.error(`[${path.basename(process.argv[1])}] noop [noop]: ${reason || ""}`);
  console.log("null");
}

export function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Minutes since an ISO timestamp, or Infinity if invalid.
 */
export function minsSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.round((Date.now() - t) / 60000);
}

/**
 * Read/update per-topic state in hum-interests-state.json atomically.
 * Used for last_run_at, last_signal_at, hit-rate accounting.
 */
export function readTopicState(topic) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s[topic] || {};
  } catch { return {}; }
}

export function writeTopicState(topic, updates) {
  try {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
    s[topic] = { ...(s[topic] || {}), ...updates };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error(`[topic-state] write failed: ${e.message}`);
  }
}

/**
 * Quick cadence-based skip. Returns true if this topic has run within
 * cadence_minutes and should be skipped this tick.
 */
export function insideCadence(topic, cadenceMinutes) {
  const st = readTopicState(topic);
  if (!st.last_run_at) return false;
  return minsSince(st.last_run_at) < cadenceMinutes;
}

export function stampRun(topic, hadSignal) {
  const now = new Date().toISOString();
  const updates = { last_run_at: now };
  if (hadSignal) updates.last_signal_at = now;
  writeTopicState(topic, updates);
}

/**
 * City-on-date geo-gate for event recommendations. Returns { suppress, reason }.
 *
 * Suppress when the user will NOT be in `metro` on `dateStr` — UNLESS `artist` is
 * on the installation's own always-worth-it list (an optional `headliner` CLI:
 * `headliner check <name>`, exit 0 = on the list). Where the user will be comes
 * from an optional travel-timeline CLI (`travel in-city <metro> <date>`: exit 0 =
 * there or unknown, 1 = away); an installation without one never suppresses.
 * Fail-open everywhere: any error, unknown location, or missing metro/date → do
 * NOT suppress (never silence a lane for a plumbing hiccup).
 *
 * @param {string} metro    city / venue / metro string (normalized by `travel`)
 * @param {string} dateStr  event date "YYYY-MM-DD" (or any when-string)
 * @param {string} [artist] performer / event title for the headliner bypass
 */
export function geoGate(metro, dateStr, artist) {
  if (!metro || !dateStr) return { suppress: false, reason: "no metro/date — gate skipped" };
  const headlinerBin = artist ? optionalBin(BIN_DIR, "headliner", "EDVA_HEADLINER_BIN") : null;
  if (headlinerBin) {
    try {
      execFileSync(headlinerBin, ["check", String(artist)], { stdio: "ignore", timeout: 8000 });
      return { suppress: false, reason: `headliner bypass (${artist})` };
    } catch { /* exit 1 = not a headliner → fall through to the geo-gate */ }
  }
  const travelBin = optionalBin(BIN_DIR, "travel", "EDVA_TRAVEL_BIN");
  if (!travelBin) return { suppress: false, reason: "no travel timeline — gate skipped" };
  try {
    execFileSync(travelBin, ["in-city", String(metro), String(dateStr)], { stdio: "ignore", timeout: 10000 });
    return { suppress: false, reason: `in ${metro} on ${dateStr}` }; // exit 0 = in (or unknown→fail-open)
  } catch (e) {
    if (e && e.status === 1) return { suppress: true, reason: `away — not in ${metro} on ${dateStr}` };
    return { suppress: false, reason: `gate error (${e && e.message}) — fail-open` };
  }
}
