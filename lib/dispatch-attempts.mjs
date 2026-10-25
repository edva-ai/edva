// dispatch-attempts.mjs — per-messageId dispatch counters, kept by the SUPERVISOR.
//
// Both loop-breakers on the email path used to depend on the ops agent writing
// `data/reclassify-tracking.json` itself:
//   - gmail-source's auto-phantom-skip (≥4 triage dispatches of one messageId in
//     30 min → stop re-dispatching), and
//   - ops-agent/CLAUDE.md § Reclassify-flap detection (≥3 RECLASSIFY dispatches
//     of one messageId in 30 min → stop re-deriving, ask the user).
// A counter the counted party has to remember to increment is not a counter. The
// supervisor makes every one of these dispatches, so it counts them here:
// gmail-source records each `gmail:<messageId>` triage dispatch, the dispatcher
// records each `RECLASSIFY: <messageId>`. (2026-10-04 determinism review.)
//
// Same file and shape the agent already reads — `{ <messageId>: { attempts:
// [{ts, kind}], first_at, phantom_skip?, phantom_reason? } }` — so the phantom
// checks and the playbook keep working unchanged. Entries older than 24h are
// pruned on write. Every function is fail-soft: a counter must never block a
// dispatch.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { installTools } from "./root.cjs";
export const WINDOW_MS = 30 * 60 * 1000;
const PRUNE_MS = 24 * 3600 * 1000;

export function trackingFile() {
  return process.env.RECLASSIFY_TRACKING_FILE || installTools("data/reclassify-tracking.json");
}

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

function save(file, data) {
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch {}
}

function prune(data, now) {
  for (const [id, e] of Object.entries(data)) {
    if (!e || typeof e !== "object") { delete data[id]; continue; }
    const atts = Array.isArray(e.attempts) ? e.attempts : [];
    const last = atts.length ? Date.parse(atts[atts.length - 1].ts) : Date.parse(e.first_at || 0);
    if (!e.phantom_skip && Number.isFinite(last) && now - last > PRUNE_MS) delete data[id];
  }
}

/** Record one dispatch of `messageId`. Returns the count of `kind` attempts in the window. */
export function recordAttempt(messageId, kind, { now = Date.now(), file = trackingFile(), extra = {} } = {}) {
  if (!messageId) return 0;
  const data = load(file);
  prune(data, now);
  const e = (data[messageId] ||= { attempts: [], first_at: new Date(now).toISOString() });
  if (!Array.isArray(e.attempts)) e.attempts = [];
  e.attempts.push({ ts: new Date(now).toISOString(), kind, ...extra });
  save(file, data);
  return countRecent(e, kind, now);
}

export function countRecent(entry, kind, now = Date.now(), windowMs = WINDOW_MS) {
  const atts = Array.isArray(entry?.attempts) ? entry.attempts : [];
  return atts.filter((a) => (!kind || (a.kind || "triage") === kind) && now - Date.parse(a.ts) < windowMs).length;
}

export function recentAttempts(messageId, kind, { now = Date.now(), file = trackingFile() } = {}) {
  return countRecent(load(file)[messageId], kind, now);
}

export function isPhantom(messageId, { file = trackingFile() } = {}) {
  return load(file)[messageId]?.phantom_skip === true;
}

export function markPhantom(messageId, reason, { file = trackingFile() } = {}) {
  const data = load(file);
  const e = (data[messageId] ||= { attempts: [], first_at: new Date().toISOString() });
  e.phantom_skip = true;
  e.phantom_reason = reason;
  save(file, data);
}

// RECLASSIFY payloads carry a Gmail messages.id (hex). Structural parse of a
// machine-generated command token, not of anything the user wrote.
export function reclassifyMessageId(content) {
  if (typeof content !== "string" || !content.startsWith("RECLASSIFY:")) return null;
  const tok = content.slice("RECLASSIFY:".length).trim().split(/\s+/)[0] || ""; // lang-regex-ok: whitespace split of a machine command token
  return /^[0-9a-f]{12,32}$/i.test(tok) ? tok : null; // lang-regex-ok: Gmail message id shape
}
