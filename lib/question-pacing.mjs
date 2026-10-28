// question-pacing.mjs — questions go first, and go faster when they pile up.
//
// Two rules, both code (Rule #0b — counts, timestamps, lane names; nothing here
// reads what the user said):
//
// 1. QUESTION FIRST. A hum candidate that is a question (any lane: a decision
//    card, a dream or hum-improvement question, a re-ask, a location "were you
//    at X?", a low-confidence idea that must be verified) is offered ahead of
//    every info candidate. `orderQuestionsFirst` puts them at the head of the
//    ranker's list and marks them; jobs/hum.md makes the eligible question the
//    winner. Only the existing carve-outs stay ahead of a question: a
//    high-urgency candidate (>= 0.9) and a protected lane.
//
// 2. QUESTIONS HAVE THEIR OWN BUDGET, AND IT SCALES WITH THE BACKLOG. Questions
//    no longer draw on the shared info budget (ping-budget.mjs); they draw on a
//    question pool, logged in hum-question-sends.jsonl. Every question lane
//    reports how many questions it has waiting (`reportBacklog`); the sum sets
//    a pacing scale (1, 2 or 3) that multiplies each lane's daily cap and the
//    pool's daily cap, and divides their spacing. An empty queue keeps the base
//    pace; a full one releases up to three times as many, closer together.
//
// Fail-open everywhere: an unreadable file is a backlog of 0 and a budget that
// lets the question through.

import fs from "node:fs";
import path from "node:path";
import { installTools } from "./root.cjs";
import { budgetVerdict, localDateIn } from "./ping-budget.mjs";
import { userTz } from "./hum-events.mjs";

const DATA = () => process.env.EDVA_DATA_DIR || installTools("data");
export const BACKLOG_DIR = () => process.env.HUM_QUESTION_BACKLOG_DIR || path.join(DATA(), "question-backlog");
export const SENDS_PATH = () => process.env.HUM_QUESTION_SENDS_PATH || path.join(DATA(), "hum-question-sends.jsonl");

/** Lanes whose every candidate is a question. */
export const QUESTION_LANES = new Set(["dream_asks", "hum_asks", "open_questions", "decisions"]);
/** A lane's backlog report older than this is ignored (the lane stopped running). */
export const BACKLOG_FRESH_H = 12;
/** Waiting questions at which the pace doubles, and triples. */
export const SCALE_STEPS = [4, 10];
/** The question pool: base daily cap, and spacing (minutes) at scale 1, 2, 3. */
export const BASE_QUESTIONS_PER_DAY = 6;
// Questions go out at most 5 minutes apart at any backlog (the user, 2026-10-27:
// "make ticks 5 minutes apart unless the queue is empty"); the daily caps scale.
export const QUESTION_SPACING_MIN = [5, 5, 5];

/** Is this hum candidate a question? Structure only: lane, key prefix, flags. */
export function isQuestionCandidate(c) {
  if (!c || typeof c !== "object") return false;
  const lane = String(c.topic || "").toLowerCase();
  const sd = c.supporting_data || {};
  if (QUESTION_LANES.has(lane)) return true;
  if (String(c.dedup_key || "").startsWith("location_ask:")) return true;
  if (sd.ask_kind || sd.kind === "decision" || sd.kind === "question") return true;
  // An idea the ideation agent was unsure of is asked, never stated (hum.md CONFIDENCE→ASK).
  if (sd.confidence === "low" && typeof sd.verify_question === "string" && sd.verify_question.trim()) return true;
  return false;
}

/** Time-bound questions (a location ask is about where the user just was) go first among questions. */
function perishable(c) {
  return String(c.dedup_key || "").startsWith("location_ask:") || c.supporting_data?.priority_lane === true;
}

/**
 * Does sending this question hold hum's single pending-question slot
 * (hum-ask)? A decision card and a location ask do not.
 */
export function usesQuestionSlot(c) {
  return isQuestionCandidate(c) && String(c.topic || "").toLowerCase() !== "decisions"
    && !String(c.dedup_key || "").startsWith("location_ask:");
}

/** Is an unanswered question still holding the slot (hum-pending-question.json)? */
export function questionSlotBusy({ now = Date.now(), file = process.env.HUM_PENDING_QUESTION_PATH || path.join(DATA(), "hum-pending-question.json") } = {}) {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const exp = Date.parse(p?.expires_at || "");
    return Boolean(p && p.id && Number.isFinite(exp) && exp > now);
  } catch { return false; }
}

/**
 * Questions to the head of the list (perishable first, then by urgency), each
 * marked `supporting_data.question_first = true`; the rest keep their order.
 * While the pending-question slot is busy, a question that needs it cannot go
 * this tick, so it is not put first (it would only end the tick silent).
 * Returns the new array and how many questions lead it.
 */
export function orderQuestionsFirst(candidates, { slotBusy = false } = {}) {
  const qs = [];
  const rest = [];
  for (const c of candidates || []) (isQuestionCandidate(c) && !(slotBusy && usesQuestionSlot(c)) ? qs : rest).push(c);
  qs.sort((a, b) => Number(perishable(b)) - Number(perishable(a)) || (Number(b.urgency) || 0) - (Number(a.urgency) || 0));
  for (const c of qs) c.supporting_data = { ...(c.supporting_data || {}), question_first: true };
  return { candidates: [...qs, ...rest], questions: qs.length };
}

// ── The backlog ──

/** A question lane says how many questions it has waiting right now. */
export function reportBacklog(lane, waiting, { now = Date.now(), dir = BACKLOG_DIR() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${String(lane).replace(/[^a-z0-9_-]/gi, "_")}.json`);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ lane, waiting: Math.max(0, Number(waiting) || 0), at: new Date(now).toISOString() }) + "\n");
    fs.renameSync(tmp, p);
  } catch { /* fail-open: a missing report is a backlog of 0 */ }
}

/** Every fresh lane report, and their sum. */
export function questionBacklog({ now = Date.now(), dir = BACKLOG_DIR() } = {}) {
  const lanes = {};
  let total = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return { total: 0, lanes }; }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const at = Date.parse(r.at || "");
      if (!Number.isFinite(at) || now - at > BACKLOG_FRESH_H * 3600e3) continue;
      lanes[r.lane] = r.waiting;
      total += Number(r.waiting) || 0;
    } catch { /* skip */ }
  }
  return { total, lanes };
}

/** 1 for a short queue, 2 once SCALE_STEPS[0] are waiting, 3 from SCALE_STEPS[1]. */
export function pacingScale(total) {
  const n = Number(total) || 0;
  return n >= SCALE_STEPS[1] ? 3 : n >= SCALE_STEPS[0] ? 2 : 1;
}

/** The scale right now, from the lanes' reports. */
export function currentScale(opts = {}) {
  if (process.env.HUM_QUESTION_SCALE) return Math.max(1, Math.min(3, Number(process.env.HUM_QUESTION_SCALE) || 1));
  return pacingScale(questionBacklog(opts).total);
}

/** A lane's own pacing at a scale: cap × scale, spacing ÷ scale. */
export function scaledLanePacing({ maxPerDay, spacingH }, scale = currentScale()) {
  return { maxPerDay: maxPerDay * scale, spacingH: spacingH / scale, scale };
}

/** The question pool's caps at a scale. */
export function questionCaps(scale = currentScale()) {
  const s = Math.max(1, Math.min(3, scale));
  return { maxPerDay: BASE_QUESTIONS_PER_DAY * s, minIntervalMin: QUESTION_SPACING_MIN[s - 1], scale: s };
}

// ── Rotation: a held question steps aside ──

/** Hours a question offered but not sent steps aside for the ones behind it. */
export const ROTATE_AFTER_H = 6;

/**
 * dedup_keys a lane offered in the last `hours` that did not go out: any hum
 * run that carried them as a candidate, a claim-check drop or a pre-rank veto,
 * minus the run's own winner when that run sent. A lane offers one question a
 * tick, so without this a question that keeps being held (the precheck, the
 * claim check, the resolve-first gate) blocks every one behind it.
 */
export function recentlyOffered(lane, { now = Date.now(), hours = ROTATE_AFTER_H, runs = null,
  file = process.env.HUM_RUNS_FILE || path.join(DATA(), "hum-runs.jsonl") } = {}) {
  const keys = new Set();
  let rows = runs;
  if (!rows) {
    try {
      rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return keys; }
  }
  for (const r of rows) {
    const t = Date.parse(r.ts || "");
    if (!Number.isFinite(t) || now - t > hours * 3600e3 || t > now) continue;
    const h = r.harvest || {};
    const offered = [...(Array.isArray(h.candidates) ? h.candidates : []),
      ...(Array.isArray(h.claim_check?.dropped) ? h.claim_check.dropped : []),
      ...(Array.isArray(h.pre_rank_vetoes) ? h.pre_rank_vetoes : [])];
    const sentKey = r.outcome?.sent ? r.sonnet?.winner_dedup_key || null : null;
    for (const c of offered) if (c?.topic === lane && c.dedup_key && c.dedup_key !== sentKey) keys.add(c.dedup_key);
  }
  return keys;
}

/** The list with recently-offered items moved behind the rest (order otherwise kept). */
export function rotateOffered(list, keyOf, offered) {
  const fresh = [];
  const held = [];
  for (const x of list) (offered.has(keyOf(x)) ? held : fresh).push(x);
  return [...fresh, ...held];
}

// ── The question pool ──

function readSends(p = SENDS_PATH()) {
  try {
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Log one question that reached the user (hum-ask exit 0, decision-ask sent, a location ask). */
export function recordQuestionSend({ lane = null, id = null, now = new Date(), file = SENDS_PATH() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ sent_at: new Date(now).toISOString(), lane, id }) + "\n");
  } catch { /* fail-open */ }
}

/** Would one more question fit the question pool now? */
export function checkQuestionBudget({ now = new Date(), tz = null, file = SENDS_PATH(), scale = null, sends = null } = {}) {
  const zone = tz || userTz();
  const caps = questionCaps(scale ?? currentScale());
  const today = localDateIn(zone, now);
  const nowMs = new Date(now).getTime();
  let count = 0;
  let last = null;
  for (const r of sends || readSends(file)) {
    const t = Date.parse(r.sent_at || "");
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (last === null || t > last) last = t;
    if (localDateIn(zone, t) === today) count++;
  }
  const v = budgetVerdict({ count, lastPingAt: last === null ? null : new Date(last).toISOString(), now, caps });
  return { ...v, count, caps, pool: "question" };
}
