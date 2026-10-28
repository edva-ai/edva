// ping-budget.mjs — the one daily ping budget shared by hum and location-ambient.
//
// 6 pings a day, at least 45 minutes apart (the user's choice in a
// self-improvement review, over the review's suggested 4/90). Every proactive ping
// that reaches the user's phone from hum (`hum-ping`) or the ambient-location lane
// counts against the same budget.
//
// WHY THIS IS CODE, NOT A FIELD IN hum-state.json. The cap used to be
// `max_pings_per_day` / `min_ping_interval_minutes` in data/hum-state.json.
// That file is gitignored runtime state: the watchdog re-seeds it from a schema
// default (which said 999 / 0), and nothing in the send path ever read the two
// fields anyway — so the user once got nine pings in a day, three inside 22 minutes.
// The cap now lives here; HUM_MAX_PINGS_PER_DAY / HUM_MIN_PING_INTERVAL_MIN
// override it (0 disables a gate); `edva hum status` reads the same values.
//
// THE COUNTER. "Pings today" is the larger of two readings of the same day:
//   - hum-state.json `today.pings` (when `today.date` is today) — the live
//     counter the hum turn bumps on every info send and `ping-budget record` bumps
//     on every ambient send. It replaced pulse-state.json, which nothing has
//     written in weeks and which therefore always answered 0.
//   - hum-feedback.jsonl rows sent since local midnight — every `hum-ping` send
//     writes one, so this is the ledger the counter can never fall below.
// Taking the max means neither a missed bump nor a counter reset can reopen the
// budget, and nothing is counted twice. "Last ping" is the newer of the two.
//
// The day is the user's local day (data/user-timezone.json, falling back to
// the installation's zone) — the same clock the sleep window uses.
//
// Carve-outs (same as hum-ping's dedup gate): a Rule #1 lane (exercise /
// health) owns its own cadence and cap, and a high-urgency send (score >= 0.9)
// is never held by the budget. Both still COUNT toward it. A retrospective
// location ask (`location_ask:` key) skips only the 45-min spacing — it is
// perishable — and still meets the daily cap; the callers (hum-ping, hum-vetoes)
// apply that, since this module never sees the candidate.
//
// LOCAL HISTORY HAS ITS OWN POOL. The user asked for local
// explanations — the nearby lane's history factoids, ≤300 m from the user — to
// come more often, as long as they aren't repeats. They are perishable by
// construction (no use once the user has walked on) and they were the best-received
// pings hum sends, so they no longer compete for the shared 6/45: they draw on
// LOCAL_HISTORY caps (10 a day, 15 min apart), and neither count against the
// other. A row is in the pool when hum-ping stamped `budget_pool:
// "local_history"` on it; the hum turn skips the shared state counter for them.
//
// QUESTIONS HAVE THEIR OWN POOL TOO (lib/question-pacing.mjs): a question
// of any lane never counts against, or is held by, this shared budget; its own
// caps scale with how many questions are waiting.
//
// Rule #0b: counts, timestamps, a window. Nothing here reads language.
// Fail-open: an unreadable file contributes 0 / null, never a refusal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { userTz } from "./hum-events.mjs";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

const DATA = installTools("data");
export const STATE_PATH = process.env.HUM_STATE_PATH || path.join(DATA, "hum-state.json");
export const FEEDBACK_PATH = process.env.HUM_FEEDBACK_PATH || path.join(DATA, "hum-feedback.jsonl");

export const DEFAULT_MAX_PINGS_PER_DAY = 6;
export const DEFAULT_MIN_PING_INTERVAL_MIN = 45;
export const DEFAULT_LOCAL_HISTORY_PER_DAY = 10;
export const DEFAULT_LOCAL_HISTORY_INTERVAL_MIN = 15;

/** Is this hum-feedback row (or finding) in the local-history pool? */
export function isLocalHistoryRow(row) {
  return Boolean(row && (row.budget_pool === "local_history"
    || row.findings?.[0]?.supporting_data?.budget_pool === "local_history"
    || row.supporting_data?.budget_pool === "local_history"));
}

/** The local-history pool's caps. 0 disables a gate. */
export function localHistoryCaps(env = process.env) {
  return {
    maxPerDay: numEnv(env, "HUM_LOCAL_HISTORY_PER_DAY", DEFAULT_LOCAL_HISTORY_PER_DAY),
    minIntervalMin: numEnv(env, "HUM_LOCAL_HISTORY_INTERVAL_MIN", DEFAULT_LOCAL_HISTORY_INTERVAL_MIN),
  };
}

function numEnv(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** The enforced caps. 0 disables that gate. */
export function pingCaps(env = process.env) {
  return {
    maxPerDay: numEnv(env, "HUM_MAX_PINGS_PER_DAY", DEFAULT_MAX_PINGS_PER_DAY),
    minIntervalMin: numEnv(env, "HUM_MIN_PING_INTERVAL_MIN", DEFAULT_MIN_PING_INTERVAL_MIN),
  };
}

/** YYYY-MM-DD of `when` in `tz`. */
export function localDateIn(tz, when = new Date()) {
  return new Date(when).toLocaleDateString("en-CA", { timeZone: tz });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** hum-feedback rows, newest first. */
export function readFeedbackRows(feedbackPath = FEEDBACK_PATH, maxLines = 400) {
  let lines;
  try { lines = fs.readFileSync(feedbackPath, "utf8").split("\n"); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && lines.length - i <= maxLines; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Today's ping count + last ping, from the state counter and the send ledger.
 * Pure given its inputs.
 */
export function todaysPings({ state = null, rows = [], now = new Date(), tz = instanceTz(), pool = "shared" } = {}) {
  const today = localDateIn(tz, now);
  // The state counter is the shared pool's; the local-history pool is counted
  // from the ledger alone.
  const st = pool === "shared" && state && typeof state === "object" ? state : {};
  const stateCount = st.today && st.today.date === today && Number.isFinite(st.today.pings) ? st.today.pings : 0;

  let ledgerCount = 0;
  let ledgerLast = null;
  const nowMs = new Date(now).getTime();
  for (const row of rows || []) {
    const t = Date.parse(row?.sent_at || "");
    if (!Number.isFinite(t)) continue;
    if (nowMs - t > 48 * 3600_000) break; // rows are newest-first; nothing older can be today
    if (t > nowMs) continue;
    if (isLocalHistoryRow(row) !== (pool === "local_history")) continue;
    // Questions have their own pool (question-pacing.mjs) and never count here.
    if (row.budget_pool === "question") continue;
    if (ledgerLast === null || t > ledgerLast) ledgerLast = t;
    if (localDateIn(tz, t) === today) ledgerCount++;
  }

  const stateLast = Date.parse(st.last_ping_at || "");
  const candidates = [ledgerLast, Number.isFinite(stateLast) && stateLast <= nowMs ? stateLast : null].filter((x) => x !== null);
  const lastMs = candidates.length ? Math.max(...candidates) : null;
  return {
    date: today,
    count: Math.max(stateCount, ledgerCount),
    state_count: stateCount,
    ledger_count: ledgerCount,
    last_ping_at: lastMs === null ? null : new Date(lastMs).toISOString(),
  };
}

/**
 * Would one more ping fit the budget? Pure.
 * Returns { ok, gate: null | "daily_cap" | "min_interval", detail }.
 */
export function budgetVerdict({ count = 0, lastPingAt = null, now = new Date(), caps = pingCaps(), bypass = false } = {}) {
  if (bypass) return { ok: true, gate: null, detail: "carve-out (Rule #1 lane or score >= 0.9)" };
  if (caps.maxPerDay > 0 && count >= caps.maxPerDay) {
    return { ok: false, gate: "daily_cap", detail: `${count} pings today (cap ${caps.maxPerDay})` };
  }
  if (caps.minIntervalMin > 0 && lastPingAt) {
    const ageMin = (new Date(now).getTime() - Date.parse(lastPingAt)) / 60_000;
    if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < caps.minIntervalMin) {
      return { ok: false, gate: "min_interval", detail: `last ping ${Math.floor(ageMin)}m ago (floor ${caps.minIntervalMin}m)` };
    }
  }
  return { ok: true, gate: null, detail: `${count}/${caps.maxPerDay || "∞"} today` };
}

/** Read the files and decide. `deps` overrides paths/clock/tz for tests. */
export function checkPingBudget({ bypass = false, now = new Date(), statePath = STATE_PATH, feedbackPath = FEEDBACK_PATH, tz = null, caps = null, rows = null, pool = "shared" } = {}) {
  const zone = tz || userTz();
  caps = caps || (pool === "local_history" ? localHistoryCaps() : pingCaps());
  const t = todaysPings({ state: readJson(statePath), rows: rows || readFeedbackRows(feedbackPath), now, tz: zone, pool });
  const v = budgetVerdict({ count: t.count, lastPingAt: t.last_ping_at, now, caps, bypass });
  return { ...v, ...t, caps, tz: zone, pool };
}

/**
 * Count a ping that did NOT go through hum-ping (the ambient lane) into the
 * live counter. Read-modify-write of hum-state.json with an atomic rename;
 * leaves every other field alone.
 */
export function recordPing({ now = new Date(), statePath = STATE_PATH, tz = null } = {}) {
  const zone = tz || userTz();
  const today = localDateIn(zone, now);
  const s = readJson(statePath) || {};
  if (!s.today || s.today.date !== today) s.today = { date: today, runs: 0, pings: 0, questions: 0 };
  s.today.pings = (s.today.pings || 0) + 1;
  s.last_ping_at = new Date(now).toISOString();
  const tmp = `${statePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, statePath);
  return s.today;
}
