// suggestion-history.mjs — append-only ledger of every hum suggestion event.
//
// SOURCE OF TRUTH for "what have we surfaced, and how did the user respond?"
// Read by recall (scout prompts + pre-send filter), written by hum-ping (at
// surface time) and by phone-channel (at reaction/classification time).
//
// File: data/suggestion-history.jsonl  (append-only JSONL).
// Each line is one event. Three event kinds:
//
//   {kind:"surfaced",   ts, subject_key, lane, display, attrs, ping_id, message_id}
//   {kind:"reaction",   ts, subject_key, disposition, reason, reason_detail,
//                       source, evidence, message_id}
//   {kind:"visit",      ts, subject_key, source, evidence}
//
// Dispositions: positive | negative | visited | snoozed | deferred | neutral.
// Reasons (for negative): price | already_seen | cuisine_mismatch | timing |
//   not_interested_topic | explicit_no | duplicate | unknown.
// `disposition_until` (optional) lets a deferred/timing-based negative expire.
//
// Derived state lives in suggestion_state (memory-index.db). Rebuild any time
// from the JSONL — JSONL is the source of truth.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEDGER_PATH = path.join(os.homedir(), "dev/merlin/data/suggestion-history.jsonl");
const LOCK_PATH = path.join(os.homedir(), "dev/merlin/data/.suggestion-history.lock");

export const LEDGER_FILE = LEDGER_PATH;

export const DISPOSITIONS = ["positive", "negative", "visited", "snoozed", "deferred", "neutral"];
export const REASONS = [
  "price",
  "already_seen",
  "cuisine_mismatch",
  "timing",
  "not_interested_topic",
  "explicit_no",
  "duplicate",
  "unknown",
];

// TTL defaults per reason. null = indefinite. Used by recall to compute
// `effective_until` on derived rows.
export const REASON_TTL_DAYS = {
  price: null,
  already_seen: null,
  cuisine_mismatch: null,
  not_interested_topic: 180,
  explicit_no: null,
  timing: 30,
  duplicate: null,
  unknown: 90,
};

function acquireLock(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { fs.mkdirSync(LOCK_PATH); return true; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
        if (age > 30_000) { fs.rmdirSync(LOCK_PATH); continue; }
      } catch {}
      const until = Date.now() + 20 + Math.floor(Math.random() * 30);
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false;
}
function releaseLock() { try { fs.rmdirSync(LOCK_PATH); } catch {} }

export function appendEvent(event) {
  if (!event || !event.kind || !event.subject_key) {
    throw new Error("appendEvent: kind and subject_key are required");
  }
  if (!event.ts) event.ts = new Date().toISOString();
  const line = JSON.stringify(event) + "\n";
  if (!acquireLock()) {
    // POSIX append for sub-PIPE_BUF lines is atomic enough that a missed lock
    // isn't catastrophic; surface the warning and continue.
    console.error("[suggestion-history] WARNING — could not acquire lock, appending anyway");
  }
  try { fs.appendFileSync(LEDGER_PATH, line); }
  finally { releaseLock(); }
  return event;
}

export function appendSurfaced({ subject_key, lane, display, attrs, ping_id, message_id, ts }) {
  return appendEvent({
    kind: "surfaced",
    ts: ts || new Date().toISOString(),
    subject_key,
    lane,
    display: display || "",
    attrs: attrs || {},
    ping_id: ping_id || null,
    message_id: message_id || null,
  });
}

export function appendReaction({ subject_key, disposition, reason, reason_detail, source, evidence, message_id, ts, disposition_until }) {
  if (!DISPOSITIONS.includes(disposition)) {
    throw new Error(`appendReaction: invalid disposition ${disposition}`);
  }
  return appendEvent({
    kind: "reaction",
    ts: ts || new Date().toISOString(),
    subject_key,
    disposition,
    reason: reason || null,
    reason_detail: reason_detail || null,
    source: source || "unknown",
    evidence: evidence || null,
    message_id: message_id || null,
    disposition_until: disposition_until || null,
  });
}

export function appendVisit({ subject_key, source, evidence, ts }) {
  return appendEvent({
    kind: "visit",
    ts: ts || new Date().toISOString(),
    subject_key,
    source: source || "unknown",
    evidence: evidence || null,
  });
}

// Read all events. Returns []  if the file is missing.
export function readAllEvents() {
  let raw;
  try { raw = fs.readFileSync(LEDGER_PATH, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Fold events into per-subject derived state. Last reaction wins; visited is
// sticky-positive (overrides nothing else, but is recorded). Surfaced count
// and last_surfaced_at are aggregated.
//
// Returns Map<subject_key, {lane, display, attrs, surface_count,
//                            first_seen_at, last_surfaced_at, last_message_id,
//                            disposition, reason, reason_detail,
//                            disposition_at, disposition_until,
//                            evidence_excerpt, visited_at}>
export function deriveState(events) {
  const map = new Map();
  // Merge short keys (e.g. "dining:little-pine") into their longer variants
  // (e.g. "dining:little-pine:lower-east-side") before folding, so reactions
  // recorded against the short key propagate to the long key's derived state.
  const all = mergeShortKeysToLong(events || readAllEvents());
  for (const e of all) {
    if (!e.subject_key) continue;
    let s = map.get(e.subject_key);
    if (!s) {
      s = {
        subject_key: e.subject_key,
        lane: null, display: "", attrs: {},
        surface_count: 0,
        first_seen_at: null, last_surfaced_at: null, last_message_id: null,
        disposition: null, reason: null, reason_detail: null,
        disposition_at: null, disposition_until: null,
        evidence_excerpt: null, visited_at: null,
      };
      map.set(e.subject_key, s);
    }
    if (e.kind === "surfaced") {
      s.lane = s.lane || e.lane;
      if (e.display) s.display = e.display;
      if (e.attrs && Object.keys(e.attrs).length) s.attrs = { ...s.attrs, ...e.attrs };
      s.surface_count += 1;
      if (!s.first_seen_at || e.ts < s.first_seen_at) s.first_seen_at = e.ts;
      if (!s.last_surfaced_at || e.ts > s.last_surfaced_at) s.last_surfaced_at = e.ts;
      if (e.message_id) s.last_message_id = e.message_id;
    } else if (e.kind === "reaction") {
      const isFirst = !s.disposition_at;
      const isLater = !isFirst && e.ts >= s.disposition_at;
      if (!isFirst && !isLater) continue; // older event, ignore

      // When the new reaction matches the existing disposition and the
      // existing reason is more specific, KEEP the specific reason — a later
      // generic 👎 confirming a prior price-rejection shouldn't downgrade
      // the explanation to "explicit_no".
      const sameDisp = !isFirst && s.disposition === e.disposition;
      const newGeneric = !e.reason || ["explicit_no", "unknown"].includes(e.reason);
      const existingSpecific = s.reason && !["explicit_no", "unknown"].includes(s.reason);
      const keepReason = sameDisp && newGeneric && existingSpecific;

      s.disposition = e.disposition;
      if (!keepReason) {
        s.reason = e.reason;
        s.reason_detail = e.reason_detail;
      }
      s.disposition_at = e.ts;
      s.disposition_until = e.disposition_until;
      if (e.evidence) s.evidence_excerpt = String(e.evidence).slice(0, 200);
    } else if (e.kind === "visit") {
      s.visited_at = e.ts;
      // A visit sets a positive note alongside any prior reaction; it doesn't
      // overwrite an explicit negative (the user might have hated it after).
      if (!s.disposition) {
        s.disposition = "visited";
        s.disposition_at = e.ts;
        s.evidence_excerpt = e.evidence ? String(e.evidence).slice(0, 200) : s.evidence_excerpt;
      }
    }
  }
  return map;
}

// Merge "short" subject keys into "long" ones when both exist. Example:
// `dining:kidilum` (legacy, no neighborhood) merges into `dining:kidilum:flatiron`.
// Rule: a short key X is merged into a long key Y iff Y starts with `${X}:`.
// All events for X are rewritten to use Y. Used during backfill to clean up
// rows that pre-date the canonicalizer.
export function mergeShortKeysToLong(events) {
  const keys = new Set(events.map((e) => e.subject_key).filter(Boolean));
  const aliasMap = new Map(); // short → long
  for (const k of keys) {
    // candidate longs: any other key that starts with `${k}:`
    let bestLong = null;
    for (const other of keys) {
      if (other === k) continue;
      if (other.startsWith(k + ":")) {
        if (!bestLong || other.length > bestLong.length) bestLong = other;
      }
    }
    if (bestLong) aliasMap.set(k, bestLong);
  }
  if (aliasMap.size === 0) return events;
  return events.map((e) => {
    const target = aliasMap.get(e.subject_key);
    if (!target) return e;
    return { ...e, subject_key: target, _merged_from: e.subject_key };
  });
}
