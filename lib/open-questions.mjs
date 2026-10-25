// open-questions — the ledger of every question Edva has asked the user in
// chat that the user has not answered yet, so none of them is lost.
//
// WHY. Questions deserve a response. Because they are floated via the hum they
// may arrive at a time the user can't answer and later be hidden by the flow of
// messages, so they are repeated until answered. No question goes unanswered
// unless it is no longer relevant (a "where were you today?" is not going to
// be relevant tomorrow).
//
// Before this, hum held ONE question in hum-pending-question.json with a
// 15-minute window; when the window closed the question was cleared and simply
// vanished. Now every question hum-ask sends is recorded here and stays OPEN
// until one of:
//   - answered  — hum-answer filed the user's answer (any time, any re-ask);
//   - retired   — no longer relevant: the hum ranker judged it so on a re-ask
//                 tick, or the resolve-first gate found the answer in the user's
//                 records before re-asking;
//   - lapsed    — a time-bound question (the location lanes) past its
//                 relevant_until, the end of the local day it was asked on.
// The `open_questions` hum lane (agent/scripts/hum-harvesters/open_questions.mjs)
// re-asks what is still open on a backing-off schedule, reusing the question's
// original id so a late answer to any copy files against the same question.
//
// Each sent copy's edva_messages row carries metadata.question_id (and
// question_until for time-bound ones); answering or retiring stamps
// metadata.question_state on every copy, so the app colours a question while it
// is open and stops once it is settled (client/Edva/ContentView.swift).
//
// Storage: append-only data/open-questions.jsonl, one event per line —
//   {ev:"asked", id, at, question, subject, lane, memory_hook, rationale, msg_id, relevant_until}
//   {ev:"answered", id, at, via}
//   {ev:"retired", id, at, why}
// Folded in code; nothing here reads what the user said (Rule #0b).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

const DATA = () => process.env.EDVA_DATA_DIR || installTools("data");
export const LEDGER = () => path.join(DATA(), "open-questions.jsonl");
const ROOT = installTools();
const SUPABASE_URL = `https://${createRequire(import.meta.url)("./instance.cjs").instance().supabase_project}.supabase.co`;

// Lanes whose questions are about one moment of one day ("where were you at
// 3pm?"). They lapse at the end of the local day they were asked on and are
// never re-asked.
export const TIME_BOUND_LANES = new Set(["location_context", "location_context_edge"]);
// Lanes that already repeat their own questions until settled (hum_asks:
// REASK_AFTER_DAYS in lib/hum-ideas.mjs) — recorded for colour and late
// answers, but not re-asked from here, so the user is never asked twice.
export const SELF_REASKING_LANES = new Set(["hum_asks"]);
// Hours after the latest ask before the next re-ask: the next day, then two
// days, four, then weekly until it is settled.
export const REASK_AFTER_H = [20, 44, 92, 164];

function readEvents(file = LEDGER()) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** The ledger's events from a given data dir (tests, hum-reply-target's `dir`). */
export function readLedger(dir) {
  return readEvents(dir ? path.join(dir, "open-questions.jsonl") : LEDGER());
}

function append(ev, file = LEDGER()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ev) + "\n");
}

/** End of the local day containing `iso`, in `tz`, as an ISO instant. */
export function endOfLocalDay(iso, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = fmt.format(new Date(iso));
  // Walk forward by hours, then minutes, while still on the same local date (DST-safe).
  let t = Date.parse(iso);
  while (fmt.format(new Date(t + 3600e3)) === day) t += 3600e3;
  while (fmt.format(new Date(t + 60_000)) === day) t += 60_000;
  return new Date(t + 59_999).toISOString();
}

export function userTz() {
  try {
    const tz = JSON.parse(fs.readFileSync(path.join(DATA(), "user-timezone.json"), "utf8")).timezone;
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch { return instanceTz(); }
}

/** The relevant_until a question asked now on `lane` gets (null = until settled). */
export function relevantUntilFor(lane, atIso, tz = userTz()) {
  return TIME_BOUND_LANES.has(lane) ? endOfLocalDay(atIso, tz) : null;
}

/** Fold the event log into one record per question id. */
export function foldQuestions(events = readEvents()) {
  const byId = new Map();
  for (const e of events) {
    if (!e?.id) continue;
    let q = byId.get(e.id);
    if (e.ev === "asked") {
      if (!q) {
        q = { id: e.id, status: "open", first_asked_at: e.at, original_question: e.question, asks: 0, msg_ids: [],
          subject: e.subject ?? null, lane: e.lane ?? null, memory_hook: e.memory_hook ?? null, rationale: e.rationale ?? null,
          relevant_until: e.relevant_until ?? null };
        byId.set(e.id, q);
      }
      q.asks += 1;
      q.last_asked_at = e.at;
      q.question = e.question;
      if (e.msg_id) q.msg_ids.push(e.msg_id);
    } else if (q && q.status === "open" && (e.ev === "answered" || e.ev === "retired")) {
      q.status = e.ev;
      q.closed_at = e.at;
      if (e.why) q.why = e.why;
      if (e.via) q.via = e.via;
    }
  }
  return byId;
}

const lapsed = (q, now) => q.relevant_until && Date.parse(q.relevant_until) < now;

/** Open questions, oldest first. Time-bound ones past their day are excluded. */
export function openQuestions(now = Date.now(), events) {
  return [...foldQuestions(events).values()]
    .filter((q) => q.status === "open" && !lapsed(q, now))
    .sort((a, b) => String(a.first_asked_at).localeCompare(String(b.first_asked_at)));
}

export function getQuestion(id, events) {
  return foldQuestions(events).get(id) || null;
}

/** Find the question a chat message id was sent as (any copy). */
export function questionForMessage(msgId, events) {
  if (!msgId) return null;
  for (const q of foldQuestions(events).values()) if (q.msg_ids.includes(msgId)) return q;
  return null;
}

/** Open questions due for a re-ask now, oldest first. */
export function dueForReask(now = Date.now(), events) {
  return openQuestions(now, events).filter((q) => {
    if (TIME_BOUND_LANES.has(q.lane) || SELF_REASKING_LANES.has(q.lane)) return false;
    if (String(q.memory_hook || "").startsWith("hum_improvement:")) return false;
    const wait = REASK_AFTER_H[Math.min(q.asks - 1, REASK_AFTER_H.length - 1)];
    return now - Date.parse(q.last_asked_at) >= wait * 3600e3;
  });
}

export function recordAsked({ id, question, subject = null, lane = null, memory_hook = null, rationale = null, msg_id = null, relevant_until = null, at = new Date().toISOString() }) {
  append({ ev: "asked", id, at, question, subject, lane, memory_hook, rationale, msg_id, relevant_until });
}

export function recordAnswered(id, via = "hum-answer") {
  const q = getQuestion(id);
  if (!q || q.status !== "open") return null;
  append({ ev: "answered", id, at: new Date().toISOString(), via });
  return q;
}

export function recordRetired(id, why) {
  const q = getQuestion(id);
  if (!q || q.status !== "open") return null;
  append({ ev: "retired", id, at: new Date().toISOString(), why: String(why || "no longer relevant").slice(0, 300) });
  return q;
}

function supabaseKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) return line.slice("SUPABASE_SERVICE_ROLE_KEY=".length).trim();
    }
  } catch {}
  return null;
}

/**
 * Stamp metadata.question_state on every chat row a question was sent as, so
 * the app stops colouring it. Merges into the row's existing metadata (a choice
 * card's `choices` must survive). Best-effort: returns the count stamped.
 */
export async function stampRows(msgIds, state, fetchFn = fetch) {
  const key = supabaseKey();
  if (!key || !msgIds?.length) return 0;
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  let n = 0;
  for (const id of msgIds) {
    try {
      const r = await fetchFn(`${SUPABASE_URL}/rest/v1/edva_messages?id=eq.${encodeURIComponent(id)}&select=metadata`, { headers: h, signal: AbortSignal.timeout(8000) });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) continue;
      const metadata = { ...(rows[0].metadata || {}), question_state: state };
      const u = await fetchFn(`${SUPABASE_URL}/rest/v1/edva_messages?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify({ metadata }), signal: AbortSignal.timeout(8000),
      });
      if (u.ok) n += 1;
    } catch { /* best-effort */ }
  }
  return n;
}
