// hum-responses.mjs — canonical append-only log of every reply the user makes to
// a hum ping, regardless of lane or whether the ping was a question.
//
// SOURCE OF TRUTH for "what did the user tell us in response to a ping, and have
// we folded it into the wiki yet?" Three consumers:
//   1. Realtime writers — hum-answer (question replies) and suggestion-classify
//      (free-text / reaction replies to any open ping) both call appendResponse.
//   2. Overnight consolidation — `hum-consolidate` reads readSince(watermark)
//      and folds durable preferences/facts into the general wiki.
//   3. Generation consult — hum-wiki-recall reads readToday() so a reply made
//      this afternoon protects against a re-ask on the next tick, before the
//      overnight consolidation has run.
//
// File: data/hum-responses.jsonl  (append-only JSONL, one reply per line).
// This is deliberately dumb: capture is lane-agnostic and never tries to route
// to the "right" memory page in realtime — that brittleness (the old hum-answer
// memory_hook routing) is exactly what this design retired. Routing into the
// wiki is the overnight job's judgment call. (Added 2026-06-28.)
//
// Row shape:
//   {
//     ts:          ISO8601,
//     ping_id:     string | null,   // the ping/question this replies to
//     lane:        string | null,   // hum lane (dining, exercise, ideas, …)
//     subject:     string | null,   // human-readable subject of the ping
//     subject_key: string | null,   // canonical dedup key when available
//     ping_text:   string | null,   // what hum asked/said (for consolidation context)
//     reply_text:  string,          // the user's reply (the payload)
//     disposition: string | null,   // positive|negative|visited|deferred|neutral|answered|...
//     source:      string,          // hum-answer | phone_rule | phone_gemma | chat-sweep | …
//   }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { installTools } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

const RESPONSES_PATH = installTools("data/hum-responses.jsonl");
const LOCK_PATH = installTools("data/.hum-responses.lock");

export const RESPONSES_FILE = RESPONSES_PATH;

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

// Append one reply. `reply_text` is the only required field; everything else is
// best-effort context. Never throws on a missing optional — capture must be
// robust (a dropped reply is the bug we're fixing). Returns the written row.
export function appendResponse({
  ping_id = null,
  lane = null,
  subject = null,
  subject_key = null,
  ping_text = null,
  reply_text,
  disposition = null,
  source = "unknown",
  ts = null,
} = {}) {
  if (!reply_text || !String(reply_text).trim()) {
    throw new Error("appendResponse: reply_text is required");
  }
  const row = {
    ts: ts || new Date().toISOString(),
    ping_id,
    lane,
    subject,
    subject_key,
    ping_text: ping_text ? String(ping_text).slice(0, 500) : null,
    reply_text: String(reply_text).slice(0, 1000),
    disposition,
    source,
  };
  const line = JSON.stringify(row) + "\n";
  if (!acquireLock()) {
    console.error("[hum-responses] WARNING — could not acquire lock, appending anyway");
  }
  try {
    fs.mkdirSync(path.dirname(RESPONSES_PATH), { recursive: true });
    // Idempotency guard (2026-07-19): a single tapback can reach this log twice
    // — the phone-channel UPDATE handler re-fires `edva hum feedback` →
    // appendResponse for the same reaction (Realtime redelivery, or a later
    // UPDATE on the ping's message row that the oldRow.reaction guard misses
    // because payload.old carries only the PK). Under the lock, skip an append
    // that exactly matches a row already written for the same ping within a
    // short window. Requires ping_id set AND identical reply_text, so two
    // genuinely-different free-text replies to the same ping are both kept.
    if (row.ping_id) {
      const DEDUP_WINDOW_MS = 10 * 60 * 1000;
      const nowMs = Date.parse(row.ts) || Date.now();
      const isDup = readAll().some((r) =>
        r.ping_id === row.ping_id &&
        r.source === row.source &&
        (r.disposition ?? null) === (row.disposition ?? null) &&
        String(r.reply_text) === String(row.reply_text) &&
        (nowMs - (Date.parse(r.ts) || 0)) <= DEDUP_WINDOW_MS
      );
      if (isDup) return row; // idempotent no-op; do not append a duplicate
    }
    fs.appendFileSync(RESPONSES_PATH, line);
  } finally { releaseLock(); }
  return row;
}

// Read all rows. Tolerant of malformed lines (skips them).
function readAll() {
  let raw;
  try { raw = fs.readFileSync(RESPONSES_PATH, "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Rows with ts strictly after the given ISO timestamp (the consolidation
// watermark). A null/empty cutoff returns everything.
export function readSince(iso) {
  const cutoff = iso ? new Date(iso).getTime() : 0;
  if (!Number.isFinite(cutoff)) return readAll();
  return readAll().filter((r) => {
    const t = new Date(r.ts || 0).getTime();
    return Number.isFinite(t) && t > cutoff;
  });
}

// Rows captured today in the user's local timezone (the instance zone). Used by
// the generation-time consult so a same-day reply suppresses a re-ask before
// the overnight consolidation folds it into the wiki.
export function readToday(tz = instanceTz()) {
  // Local-midnight boundary as an ISO instant.
  const now = new Date();
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // YYYY-MM-DD in tz
  return readAll().filter((r) => {
    if (!r.ts) return false;
    const rowLocal = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(r.ts));
    return rowLocal === localDate;
  });
}

export function readAllResponses() { return readAll(); }
