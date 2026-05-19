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

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, "dev/merlin/data/hum-cache");
const STATE_FILE = path.join(HOME, "dev/merlin/data/hum-interests-state.json");
const RUNS_FILE = path.join(HOME, "dev/merlin/data/hum-runs.jsonl");

const SILENCE_LIMIT_PER_DAY = 3;

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
 * Contract (post 2026-04-14): the wrapper writes ONE JSON object:
 *   { situation, context }
 * where:
 *   situation = output of `merlin hum situation --json`
 *   context   = output of `merlin context --json` (profile/tastes/projects/knowledge/recent)
 *
 * Backward-compat: if the payload lacks the envelope shape (older callers
 * passed situation directly), treat the whole payload as situation + build
 * context lazily in-process.
 */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return { situation: {}, context: {} };
  let payload;
  try { payload = JSON.parse(raw); } catch { return { situation: {}, context: {} }; }
  if (payload && typeof payload === "object" && ("situation" in payload || "context" in payload)) {
    return { situation: payload.situation || {}, context: payload.context || {} };
  }
  // legacy: caller passed situation directly
  return { situation: payload, context: {} };
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
  };
  console.log(JSON.stringify(shaped));
}

export function emitNull(reason) {
  if (reason) console.error(`[${path.basename(process.argv[1])}] null: ${reason}`);
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
