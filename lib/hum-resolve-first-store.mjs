// hum-resolve-first-store.mjs — what the resolve-first gate already worked out,
// so the same thing is not floated to the user again.
//
// The gate (lib/hum-resolve-first.mjs) answers a hum question or comment
// from Edva's own records before it is sent. When it settles one, the answer
// is kept here, and two readers use it:
//   - the gate itself, which shows the recent answers to the model as evidence,
//     so a reworded re-ask of something already settled is caught at once;
//   - hum-harvest-all's pre-rank filter (lib/hum-vetoes.mjs), which drops
//     a candidate whose dedup_key was settled within RESOLVED_WINDOW_D days
//     (veto `resolved_first`) before it costs another model call.
//
// Deliberately NOT data/hum-responses.jsonl: every row there is rendered
// as "<user> said: …" (lib/utterance-store.mjs), and these are Edva's
// conclusions, not the user's words. Writing them there would put a quote in the user's mouth.
//
// File: data/hum-resolve-first.jsonl (append-only, gitignored runtime data).
//   answer row: {ts, decision_id, intent, lane, dedup_key, kind, verdict, action,
//                question, answer, remaining_gap, sources, checked, private}
//   forget row: {ts, forget: "<decision_id | dedup_key>", reason}
// A private row (finance / stocks / health lanes) carries no text at all, only
// the key and verdict — enough for the veto, nothing for a log reader.
//
// Pure fs, no model, no network: safe to import from the pre-rank filter.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTools } from "./root.cjs";
export const STORE_FILE = installTools("data/hum-resolve-first.jsonl");
export const RESOLVED_WINDOW_D = Number(process.env.HUM_RESOLVED_WINDOW_D || 7);
const SCAN_ROWS = 2000;

function storePath(p) { return p || process.env.HUM_RESOLVE_FIRST_STORE || STORE_FILE; }

function readRows(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n").slice(-SCAN_ROWS)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* tolerate a torn line */ }
  }
  return out;
}

/** Append one settled answer. Never throws: a lost row costs one re-ask. */
export function recordResolved(row, { file } = {}) {
  try {
    const p = storePath(file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
    return true;
  } catch { return false; }
}

/** Withdraw an answer (the user said it was wrong). Matches a decision_id or a dedup_key. */
export function forgetResolved(idOrKey, { file, reason = "" } = {}) {
  if (!idOrKey) return false;
  return recordResolved({ forget: String(idOrKey), reason }, { file });
}

function liveRows({ file, nowMs = Date.now(), windowD }) {
  const rows = readRows(storePath(file));
  const forgotten = new Set(rows.filter((r) => r && r.forget).map((r) => r.forget));
  const since = nowMs - windowD * 86_400_000;
  return rows.filter((r) => r && !r.forget && r.decision_id
    && !forgotten.has(r.decision_id) && !(r.dedup_key && forgotten.has(r.dedup_key))
    && Date.parse(r.ts || "") >= since);
}

/**
 * dedup_key → {ts, decision_id} for every question settled within the window.
 * Only full resolutions count: a partial one still had a gap worth asking.
 */
export function resolvedKeys({ file, nowMs = Date.now(), windowD = RESOLVED_WINDOW_D } = {}) {
  const out = new Map();
  for (const r of liveRows({ file, nowMs, windowD })) {
    if (r.verdict !== "resolved" || !r.dedup_key) continue;
    out.set(r.dedup_key, { ts: r.ts, decision_id: r.decision_id });
  }
  return out;
}

/** Recent non-private answers, newest first, for the gate's own evidence. */
export function recentResolved({ file, nowMs = Date.now(), windowD = 14, limit = 15 } = {}) {
  return liveRows({ file, nowMs, windowD })
    .filter((r) => !r.private && (r.verdict === "resolved" || r.verdict === "partial") && r.answer)
    .reverse()
    .slice(0, limit);
}
