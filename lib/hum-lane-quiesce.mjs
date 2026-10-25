// hum-lane-quiesce.mjs — auto-quiesce a hum lane after 2 consecutive
// expired-unanswered lane_diagnosis (decay-diagnosis) questions.
//
// WHY: hum-metrics-collect queues a qualitative-diagnosis question
// (data/hum-qual-delivery-queue.json) whenever a lane decays silently;
// bin/hum-deliver-qual delivers it into data/hum-pending-question.json
// with a 24h TTL (see data/hum-improvement-loop.md § Qualitative
// diagnosis). If the user never answers, the question just expires and the lane
// keeps generating candidates that never surface — noise into both silence
// AND a non-answer. This module watches for that pattern and pauses the lane
// (same idiom a project topic already uses for a manual pause in
// data/hum-interests.json: `enabled:false` + `_paused_reason`/
// `_paused_at`) until either a positive reaction lands on that lane again or
// someone re-enables it explicitly (`edva hum lane enable <name>`).
//
// Called from bin/hum-sense's pass() as a housekeeping step, the same
// shape as reconcile() there: runs on every tick, cheap, fail-isolated (a
// throw here must never take the sensor engine down).
//
// 2026-09 fix: hum-pending-question.json is a SHARED slot
// — every hum Q&A (tick questions, lane diagnoses, anything else) writes
// through it. The original checkExpiredLaneDiagnosis() only ever inspected
// whatever currently occupied that slot, so the instant a lane_diagnosis
// question got superseded by any other question before its own 24h TTL
// elapsed, its expiry became permanently invisible — this mechanism had
// auto-quiesced nothing in 4+ months live. The fix: bin/hum-deliver-qual
// now calls recordLaneDiagnosisDelivered() at the moment it writes a
// lane_diagnosis question into the shared slot, stamping a DURABLE per-lane
// record (question id + its own expires_at) into hum-lane-quiesce-state.json
// itself — a copy that survives the shared slot being overwritten.
// checkExpiredLaneDiagnosis() now checks that durable record as the primary
// path; the original shared-slot check remains as a secondary/back-compat
// path (still correct when the slot hasn't been superseded, and exercised by
// callers/tests that write hum-pending-question.json directly without going
// through hum-deliver-qual). Dedup is by `last_seen_id`, shared between both
// paths, so a question caught by the durable record is never double-counted
// if the shared slot still happens to hold it too.
//
// Rule #0b note: this module only ever touches machine-generated STRUCTURE —
// `qual-<lane>-<YYYYMMDD>` ids the code itself minted, and a fixed vocabulary
// of tapback reaction tokens (helpful/more/skip/snooze, see
// HUM_REACTION_ALIASES in bin/edva). It never parses or judges the
// free-text CONTENT of a question or a reply — that stays a model's job
// wherever it already is (chat-agent's hum-answer routing, suggestion-classify).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readJson, writeJsonAtomic, tailLines } from "./hum-events.mjs";

import { installTools } from "./root.cjs";
const DATA = installTools("data");

export const PATHS = {
  pendingQuestion: path.join(DATA, "hum-pending-question.json"),
  learnings: path.join(DATA, "hum-learnings.jsonl"),
  feedback: path.join(DATA, "hum-feedback.jsonl"),
  interests: path.join(DATA, "hum-interests.json"),
  interventions: path.join(DATA, "hum-interventions.jsonl"),
  quiesceState: path.join(DATA, "hum-lane-quiesce-state.json"),
};

// "2 consecutive unanswered decay-diagnosis questions" per the action item.
export const EXPIRE_QUIESCE_THRESHOLD = 2;

// Canonical positive tapback tokens (hum-improvement-loop.md § signal_score:
// love=2x, up=1x). Matched as exact tokens against the normalized value
// bin/edva's cmdHumFeedback already writes into hum-feedback.jsonl —
// never parsed from free text.
const POSITIVE_REACTION_TOKENS = new Set(["helpful", "more", "up", "love", "heart", "thumbs_up"]);

function nowIso(now) { return new Date(now).toISOString(); }
function compactDate(now) { return nowIso(now).slice(0, 10).replace(/-/g, ""); }
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

// `qual-<lane>-<YYYYMMDD>` is the id shape hum-metrics-collect's
// dispatch_qualitative_question() mints (see bin/hum-metrics-collect).
// Lane names in hum-interests.json never contain a hyphen, so this reliably
// recovers the lane from a machine-generated id — structure, not language.
function parseQualId(id) {
  if (typeof id !== "string") return null;
  const m = id.match(/^qual-(.+)-(\d{8})$/);
  if (!m) return null;
  return { lane: m[1], dateStr: m[2] };
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function loadQuiesceState(paths) {
  const s = readJson(paths.quiesceState, null);
  return s && typeof s === "object" ? s : { lanes: {} };
}

function laneEntry(state, lane) {
  if (!state.lanes) state.lanes = {};
  if (!state.lanes[lane]) state.lanes[lane] = { consecutive_expired: 0, last_seen_id: null, quiesced: false };
  return state.lanes[lane];
}

function loadInterests(paths) {
  const j = readJson(paths.interests, null);
  return j && Array.isArray(j.topics) ? j : { topics: [] };
}

function findTopic(interests, lane) {
  return interests.topics.find((t) => t.name === lane) || null;
}

function makeIntervention({ id, lane, hypothesis, action, now, predicted_effect = {}, measurable = false }) {
  return {
    id,
    applied_at: nowIso(now),
    commit: null,
    lane,
    hypothesis,
    predicted_effect,
    baseline_window: measurable ? { start: isoDate(now - 7 * 86400000), end: isoDate(now) } : null,
    measure_at: measurable ? new Date(now + 7 * 86400000).toISOString() : null,
    trigger: action === "disabled" ? "auto_lane_quiesce" : "auto_lane_reenable",
    action,
    status: "applied",
  };
}

/**
 * Disable a lane's harvester (mirrors the manual topic-pause idiom).
 * Returns:
 *   null              — unknown lane (no matching topic in hum-interests.json)
 *   {changed:false}    — lane was already disabled; state noted, nothing re-logged
 *   {changed:true, intervention}
 */
function quiesceLaneInternal(state, lane, reason, now, paths) {
  const interests = loadInterests(paths);
  const topic = findTopic(interests, lane);
  if (!topic) return null;

  const entry = laneEntry(state, lane);
  if (topic.enabled === false) {
    entry.quiesced = true;
    entry.quiesced_at = entry.quiesced_at || nowIso(now);
    entry.quiesced_reason = entry.quiesced_reason || reason;
    return { changed: false };
  }

  topic.enabled = false;
  topic._paused_reason = reason;
  topic._paused_at = nowIso(now);
  writeJsonAtomic(paths.interests, interests);

  const intervention = makeIntervention({
    id: `hum-lane-quiesce-${lane}-${compactDate(now)}`,
    lane,
    hypothesis: reason,
    action: "disabled",
    now,
    predicted_effect: { surface_rate: "-0.03", signal_per_surfaced: "+0.05" },
    measurable: true,
  });
  appendJsonl(paths.interventions, intervention);

  entry.quiesced = true;
  entry.quiesced_at = intervention.applied_at;
  entry.quiesced_reason = reason;
  return { changed: true, intervention };
}

/**
 * Re-enable a previously quiesced lane. Same return shape as quiesceLaneInternal.
 */
function reenableLaneInternal(state, lane, reason, now, paths) {
  const interests = loadInterests(paths);
  const topic = findTopic(interests, lane);
  if (!topic) return null;

  const entry = laneEntry(state, lane);
  if (topic.enabled !== false) {
    entry.quiesced = false;
    entry.consecutive_expired = 0;
    return { changed: false };
  }

  topic.enabled = true;
  delete topic._paused_reason;
  delete topic._paused_at;
  topic._resumed_reason = reason;
  topic._resumed_at = nowIso(now);
  writeJsonAtomic(paths.interests, interests);

  const intervention = makeIntervention({
    id: `hum-lane-reenable-${lane}-${compactDate(now)}`,
    lane,
    hypothesis: reason,
    action: "enabled",
    now,
  });
  appendJsonl(paths.interventions, intervention);

  entry.quiesced = false;
  entry.consecutive_expired = 0;
  entry.last_seen_id = null;
  entry.reenabled_at = intervention.applied_at;
  entry.reenabled_reason = reason;
  return { changed: true, intervention };
}

/**
 * Record the durable delivery of a lane_diagnosis question. Called by
 * bin/hum-deliver-qual at the exact moment it writes the question into
 * the shared hum-pending-question.json slot — this is the copy that survives
 * that slot later being overwritten by an unrelated question, which is what
 * made the original expiry check permanently blind (see file header).
 *
 * Additive only: never touches consecutive_expired/quiesced/etc, just stamps
 * the (id, expires_at) this lane is currently waiting on.
 *
 * No-ops (returns null) for the global lane or missing fields — global
 * lane_diagnosis questions are never quiesced (see checkExpiredLaneDiagnosis).
 */
export function recordLaneDiagnosisDelivered({ lane, id, expiresAt, now = Date.now(), paths = PATHS } = {}) {
  if (!lane || lane === "global" || !id || !expiresAt) return null;
  const state = loadQuiesceState(paths);
  const entry = laneEntry(state, lane);
  entry.outstanding = { id, expires_at: expiresAt, delivered_at: nowIso(now) };
  writeJsonAtomic(paths.quiesceState, state);
  return entry.outstanding;
}

/**
 * Shared "count one expired-unanswered occurrence, quiesce at threshold"
 * step. Mutates `state` and `actions` in place; idempotent per (lane, id) via
 * `last_seen_id`, the same dedup key used for the answered-reset pass above,
 * so a given question id is never counted twice regardless of which of the
 * two expiry sources (durable record vs. shared pending slot) noticed it.
 */
function recordExpiredOccurrence(state, lane, id, now, paths, actions) {
  const entry = laneEntry(state, lane);
  if (entry.last_seen_id === id) return; // already accounted for
  entry.last_seen_id = id;
  entry.consecutive_expired = (entry.consecutive_expired || 0) + 1;
  entry.last_resolution = "expired_unanswered";
  actions.push({ type: "expired_unanswered", lane, id, consecutive: entry.consecutive_expired });

  if (entry.consecutive_expired >= EXPIRE_QUIESCE_THRESHOLD && !entry.quiesced) {
    const reason = `Auto-quiesced by hum-lane-quiesce: ${entry.consecutive_expired} consecutive ` +
      `expired-unanswered lane_diagnosis questions (latest ${id}). Re-enables on any ` +
      `positive reaction to a ${lane} ping, or manually via ` +
      `'edva hum lane enable ${lane} <reason>'.`;
    const result = quiesceLaneInternal(state, lane, reason, now, paths);
    if (result && result.changed) {
      actions.push({ type: "quiesced", lane, reason, intervention_id: result.intervention.id });
    }
  }
}

/**
 * Housekeeping step — call every hum-sense pass(), mirroring reconcile().
 *
 * 1. Reset a lane's consecutive-expired streak on any lane_diagnosis answer
 *    found since we last looked (an answered question breaks the streak —
 *    "consecutive" means consecutive). Also clears a matching durable
 *    outstanding record so it isn't later mistaken for an unanswered expiry.
 * 2. Durable per-lane delivery records (see recordLaneDiagnosisDelivered) —
 *    the primary path. Any lane with an `outstanding` record whose own
 *    expires_at has passed, and that hasn't already been accounted for
 *    (answered, or already counted here), counts as expired_unanswered. At
 *    EXPIRE_QUIESCE_THRESHOLD, quiesce the lane. This is what makes expiry
 *    detection survive the shared pending-question slot being overwritten by
 *    an unrelated question before this lane's own TTL elapses.
 * 3. Legacy/back-compat: the live pending slot, still checked directly for
 *    any lane_diagnosis question sitting there without a durable record
 *    (e.g. a caller that writes hum-pending-question.json directly). Dedup
 *    via the same `last_seen_id` key means this never double-counts a lane
 *    already handled by step 2.
 *
 * Never throws — any read/parse failure degrades to "nothing to do" for that
 * lane, same fail-open posture as the rest of hum-sense's gates.
 *
 * Returns an array of action records (for the caller to log); never null.
 */
export function checkExpiredLaneDiagnosis({ now = Date.now(), paths = PATHS } = {}) {
  const actions = [];
  const state = loadQuiesceState(paths);

  // 1. Answered-in-between resets. Bounded tail read — lane_diagnosis
  // questions are rare (14-day per-lane cooldown at the source).
  for (const line of tailLines(paths.learnings, 200)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const parsed = parseQualId(row && row.id);
    if (!parsed || parsed.lane === "global") continue;
    const entry = laneEntry(state, parsed.lane);
    if (entry.last_seen_id === row.id) continue; // already accounted for
    entry.last_seen_id = row.id;
    entry.consecutive_expired = 0;
    entry.last_resolution = "answered";
    if (entry.outstanding && entry.outstanding.id === row.id) entry.outstanding = null;
  }

  // 2. Durable per-lane delivery records — primary path (see header note).
  for (const [lane, entry] of Object.entries(state.lanes || {})) {
    const outstanding = entry.outstanding;
    if (!outstanding || !outstanding.id || !outstanding.expires_at) continue;
    if (lane === "global") { entry.outstanding = null; continue; }
    const expiresAt = Date.parse(outstanding.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt >= now) continue; // not expired yet
    if (entry.last_seen_id === outstanding.id) { entry.outstanding = null; continue; } // already accounted for
    recordExpiredOccurrence(state, lane, outstanding.id, now, paths, actions);
    entry.outstanding = null; // consumed — delivery-time record's job is done
  }

  // 3. Legacy fallback: live pending slot.
  const pending = readJson(paths.pendingQuestion, null);
  if (
    pending && typeof pending === "object" &&
    pending.category === "lane_diagnosis" &&
    pending.lane && pending.lane !== "global" &&
    pending.id && pending.expires_at
  ) {
    const expiresAt = Date.parse(pending.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt < now) {
      recordExpiredOccurrence(state, pending.lane, pending.id, now, paths, actions);
    }
  }

  writeJsonAtomic(paths.quiesceState, state);
  return actions;
}

/**
 * Housekeeping step — re-enable any quiesced lane that's earned a positive
 * reaction since it was quiesced. Call every hum-sense pass() alongside
 * checkExpiredLaneDiagnosis().
 */
export function checkPositiveReactionReenable({ now = Date.now(), paths = PATHS } = {}) {
  const actions = [];
  const state = loadQuiesceState(paths);
  const quiescedLanes = Object.entries(state.lanes || {}).filter(([, e]) => e && e.quiesced);
  if (!quiescedLanes.length) return actions;

  const feedbackLines = tailLines(paths.feedback, 400);
  for (const [lane, entry] of quiescedLanes) {
    const quiescedAtMs = entry.quiesced_at ? Date.parse(entry.quiesced_at) : 0;
    const hit = feedbackLines.some((line) => {
      let row;
      try { row = JSON.parse(line); } catch { return false; }
      if (!row || row.lane !== lane) return false;
      if (!POSITIVE_REACTION_TOKENS.has(row.reaction)) return false;
      const reactedAt = row.reaction_at ? Date.parse(row.reaction_at) : NaN;
      return Number.isFinite(reactedAt) ? reactedAt >= quiescedAtMs : true;
    });
    if (hit) {
      const result = reenableLaneInternal(state, lane, "Positive reaction received — auto re-enabled.", now, paths);
      if (result && result.changed) {
        actions.push({ type: "reenabled", lane, reason: "positive_reaction", intervention_id: result.intervention.id });
      }
    }
  }

  writeJsonAtomic(paths.quiesceState, state);
  return actions;
}

/** Explicit manual disable — e.g. `edva hum lane disable <name>`. */
export function quiesceLane(lane, reason, { now = Date.now(), paths = PATHS } = {}) {
  const state = loadQuiesceState(paths);
  const result = quiesceLaneInternal(state, lane, reason || "Manually disabled.", now, paths);
  writeJsonAtomic(paths.quiesceState, state);
  return result;
}

/** Explicit manual re-enable — e.g. The user says "bring back talks". */
export function reenableLane(lane, reason, { now = Date.now(), paths = PATHS } = {}) {
  const state = loadQuiesceState(paths);
  const result = reenableLaneInternal(state, lane, reason || "Manually re-enabled.", now, paths);
  writeJsonAtomic(paths.quiesceState, state);
  return result;
}

/** Per-lane status for `edva hum lane status`. */
export function laneQuiesceStatus({ paths = PATHS } = {}) {
  const interests = loadInterests(paths);
  const state = loadQuiesceState(paths);
  return interests.topics.map((t) => ({
    lane: t.name,
    enabled: t.enabled !== false,
    consecutive_expired: (state.lanes && state.lanes[t.name] && state.lanes[t.name].consecutive_expired) || 0,
    quiesced_reason: (state.lanes && state.lanes[t.name] && state.lanes[t.name].quiesced_reason) || null,
    quiesced_at: (state.lanes && state.lanes[t.name] && state.lanes[t.name].quiesced_at) || null,
  }));
}
