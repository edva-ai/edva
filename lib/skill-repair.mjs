// skill-repair.mjs — the same-day repair queue for browser actions and page parsers.
//
// Why (2026-10-16): when a site changed its markup, a registry action or parser
// went on returning nothing until skill-health crossed 3 consecutive failure
// days or an ingest job's 3-run streak paged the system channel, and then waited
// for the nightly system-issue review. One source's listing was blind 10+ nights
// (a zero-rows cluster). Anchor's "Action Index" sells exactly the
// missing piece: replay a cached path deterministically, and let a model step
// in only when the site changed. We already had the cached paths; this adds the
// step-in. A producer that sees a repairable failure calls requestRepair(); the
// `skill-repair` job (jobs/skill-repair.md) opens the live page, rewrites the
// one broken action, verifies it returns rows again, and lands the fix through
// self-improve-auto-apply.
//
// Only READ actions are repaired. Verifying a repaired write action would mean
// performing the write (submitting a form, booking a table, posting), so a
// broken write action keeps the existing alert path.
//
// Queue: data/skill-repair-queue.json  { pending: [], history: [] }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { installRoot } from "./root.cjs";

const ROOT = process.env.EDVA_ROOT || installRoot();
export const QUEUE = path.join(ROOT, "data", "skill-repair-queue.json");
const TRIGGER = path.join(ROOT, "agent", "scripts", "trigger-skill-repair.sh");

export const DAILY_CAP = 4;           // repair dispatches per UTC day, all skills together
export const RETRY_AFTER_H = 24;      // one attempt per skill/action per day
export const MAX_ATTEMPTS_7D = 2;     // then leave it to skill-health's 3-day alert / system-issue-review

// Error codes that mean "the page is there but the action no longer reads it".
// Everything else (login lapsed, captcha, 403/429/5xx, network, missing key) is
// not something rewriting a selector fixes, and keeps the existing alert path.
const REPAIRABLE = new Set([
  "zero_rows", "went_quiet", "unexpected_shape", "parse_failed", "unparseable_result",
  "not_observed_in_dom", "runtime_exception", "selector_not_found", "schema_invalid",
  "no_rows", "empty_result",
]);

// Action ids that change external state. These are machine identifiers from
// the registry, not language.
const WRITE_ACTION = /(^|-)(enter|book|claim|submit|vote|add-to-cart|cancel|purchase|buy|post|comment|reply|send|checkout)(-|$)/; // lang-regex-ok: registry action identifiers

export const isRepairableError = (code) => REPAIRABLE.has(String(code || "").toLowerCase());
export const isWriteAction = (action) => WRITE_ACTION.test(String(action || "").toLowerCase());
export const repairKey = (r) => `${r.skill}/${r.action}`;

export function loadQueue(file = QUEUE) {
  try {
    const q = JSON.parse(fs.readFileSync(file, "utf8"));
    q.pending ||= []; q.history ||= [];
    return q;
  } catch { return { pending: [], history: [] }; }
}

export function saveQueue(q, file = QUEUE) {
  const cutoff = Date.now() - 30 * 86400e3;
  q.history = q.history.filter((h) => Date.parse(h.requested_at || h.finished_at || 0) > cutoff);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Decide whether a request is admitted. Pure, so the rules are testable.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function admit(q, req, now = Date.now()) {
  if (!req?.skill || !req?.action) return { ok: false, reason: "missing skill/action" };
  if (!isRepairableError(req.error)) return { ok: false, reason: `error ${req.error} is not a markup break` };
  if (isWriteAction(req.action)) return { ok: false, reason: "write action: never auto-repaired" };
  const key = repairKey(req);
  if (q.pending.some((p) => repairKey(p) === key)) return { ok: false, reason: "already queued" };
  const mine = q.history.filter((h) => repairKey(h) === key);
  if (mine.some((h) => now - Date.parse(h.requested_at) < RETRY_AFTER_H * 3600e3)) return { ok: false, reason: "attempted in the last 24h" };
  if (mine.filter((h) => now - Date.parse(h.requested_at) < 7 * 86400e3).length >= MAX_ATTEMPTS_7D) {
    return { ok: false, reason: `${MAX_ATTEMPTS_7D} attempts this week: left to skill-health / system-issue-review` };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const today = [...q.pending, ...q.history].filter((h) => String(h.requested_at).startsWith(day)).length;
  if (today >= DAILY_CAP) return { ok: false, reason: `daily cap ${DAILY_CAP} reached` };
  return { ok: true };
}

/**
 * Queue a repair and (by default) kick the trigger. Never throws: a producer's
 * own run must not fail because the repair queue could not be written.
 *
 * req: { skill, action, error, diagnostic?, url?, action_file?, producer, log_file? }
 *   skill        registry site or parser family ("<venue>.com", "<team>.com", "_events-generic")
 *   action       the action id ("<venue>-text-calendar", "schedule")
 *   action_file  repo-relative path of the code to fix, when the producer knows it
 *   url          the live page the action reads
 *   producer     the job that saw it (an ingest job, "skill-health", ...)
 */
export function requestRepair(req, { kick = true, file = QUEUE, now = Date.now(), log = (m) => console.error(`[skill-repair] ${m}`) } = {}) {
  try {
    const q = loadQueue(file);
    const verdict = admit(q, req, now);
    if (!verdict.ok) { log(`${repairKey(req)} not queued: ${verdict.reason}`); return false; }
    const item = {
      id: `sr-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${Math.random().toString(16).slice(2, 6)}`, // lang-regex-ok: ISO timestamp compaction
      skill: req.skill, action: req.action, error: req.error,
      diagnostic: req.diagnostic ? String(req.diagnostic).slice(0, 600) : null,
      url: req.url || null, action_file: req.action_file || null,
      producer: req.producer || null, log_file: req.log_file || null,
      requested_at: new Date(now).toISOString(), status: "pending",
    };
    q.pending.push(item);
    saveQueue(q, file);
    log(`queued ${item.id} ${repairKey(item)} (${item.error})`);
    if (kick && fs.existsSync(TRIGGER)) {
      const child = spawn("bash", [TRIGGER], { detached: true, stdio: "ignore" });
      child.unref();
    }
    return item.id;
  } catch (e) {
    log(`queue write failed: ${e.message}`);
    return false;
  }
}

/** Move the head (or a given id) from pending to in_progress; returns it or null. */
export function claimNext(q, id = null, now = Date.now()) {
  const i = id ? q.pending.findIndex((p) => p.id === id) : q.pending.findIndex((p) => p.status === "pending");
  if (i < 0) return null;
  q.pending[i] = { ...q.pending[i], status: "in_progress", claimed_at: new Date(now).toISOString() };
  return q.pending[i];
}

/** Close an item: outcome repaired | not_repairable | transient | failed. */
export function finish(q, id, outcome, note = "", commit = null, now = Date.now()) {
  const i = q.pending.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [item] = q.pending.splice(i, 1);
  const done = { ...item, status: outcome, note: String(note).slice(0, 600), commit, finished_at: new Date(now).toISOString() };
  q.history.push(done);
  return done;
}

/** A claim older than 2h is a dead dispatch; put it back to pending once. */
export function releaseStale(q, now = Date.now()) {
  let n = 0;
  for (const p of q.pending) {
    if (p.status === "in_progress" && now - Date.parse(p.claimed_at) > 2 * 3600e3) {
      if (p.reclaimed) { p.status = "stale"; } else { p.status = "pending"; p.reclaimed = true; }
      n++;
    }
  }
  q.pending = q.pending.filter((p) => {
    if (p.status !== "stale") return true;
    q.history.push({ ...p, status: "failed", note: "dispatch died twice", finished_at: new Date(now).toISOString() });
    return false;
  });
  return n;
}
