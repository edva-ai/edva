// hum-ideas — the one reading of data/hum-improvement-ideas.jsonl, and the
// one answer to "how does this idea reach the user, if at all?".
//
// The routing policy (the user's): questions about hum are
// floated through hum in the chat; hum improvements are applied automatically
// where possible; higher-risk ones go to the Improvements channel; larger,
// structural changes go in the weekly improvement email. `routeFor` is that
// sentence as code, so the executor, the harvester and the weekly brief cannot
// drift apart on who owns what.
//
// The ledger is append-style JSONL: a later row for the same id carries the
// newer fields, so the merged LAST row per id is the idea's current state.
// Field comparisons only — nothing here interprets language.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const require = createRequire(import.meta.url);

/**
 * The scope of an idea that waits for the user's yes: `manual_<owner_id>`
 * (manual_user by default; lib/instance.cjs owner_id). Stored on every
 * ledger row and written by the improvement-ideation job, so an installation
 * keeps the value its ledger already holds.
 */
export function manualScope() {
  return `manual_${require("./instance.cjs").instance().owner_id}`;
}

export const LEDGER = process.env.HUM_IDEAS_FILE
  || installTools("data/hum-improvement-ideas.jsonl");

/** Efforts one executor run can design and land. Anything bigger is structural. */
export const SMALL_EFFORT = new Set(["quick", "half-day"]);

const TERMINAL = new Set(["applied", "superseded", "no_change_recommended", "declined"]);

export function readRows(file = LEDGER) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function latestById(rows) {
  const latest = new Map();
  for (const r of rows) if (r && r.id) latest.set(r.id, { ...(latest.get(r.id) || {}), ...r });
  return latest;
}

export function loadLatest(file = LEDGER) {
  return [...latestById(readRows(file)).values()];
}

export function appendRow(row, file = LEDGER) {
  if (!row || !row.id) throw new Error("appendRow: row needs an id");
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

/**
 * Which lane an idea travels.
 *   done          terminal; nothing to do
 *   reconcile     a Face-ID card was filed; the ledger still says awaiting
 *   weekly_email  too big for one run (effort beyond half-day): the weekly review
 *   build         the user said yes in chat: design it, land it (auto, or a card if risky)
 *   ask_in_chat   needs the user's taste or a decision: hum asks, in the chat (the
 *                 `hum_asks` harvester paces asks and re-asks from hum-runs.jsonl;
 *                 the question may be open-ended, the answer need not be yes/no)
 *   build_auto   low/moderate, autonomous: design and land it on its own
 *   build_card    high risk, autonomous: design it, file one card
 *   none          not actionable (unknown shape)
 */
export function routeFor(idea) {
  const { status, scope, risk, effort } = idea || {};
  if (TERMINAL.has(status)) return "done";
  if (status === "awaiting_approval") return "reconcile";
  if (!SMALL_EFFORT.has(effort)) return "weekly_email";
  if (status === "approved") return "build";
  if (scope === manualScope() && status === "proposed") return "ask_in_chat";
  if (scope === "edva_autonomous" && status === "proposed") return risk === "high" ? "build_card" : "build_auto";
  return "none";
}

// ── Asking in the chat ────────────────────────────────────────────────────────

// Pacing — the user welcomes questions that make hum better: they can come
// more often (even a couple a day) and need not require a yes/no answer.
// Supersedes the first cut (one ask per 48h, re-ask after 7 days). Ceiling: two
// a day, spaced out; the shared ping budget (6/day, 45 min apart) still applies on top.
/** Hours between any two improvement asks, so two never land back to back. */
export const ASK_COOLDOWN_H = 6;
/** Improvement asks allowed in any rolling 24 hours. */
export const ASK_MAX_PER_DAY = 2;
/** An unanswered ask about the same idea waits this long before it is asked again. */
export const REASK_AFTER_DAYS = 3;

const RISK_RANK = { low: 0, moderate: 1, high: 2 };

/**
 * When each idea was last asked about, from hum-runs.jsonl. A tick that SENT a
 * question carries dedup_key `hum_asks:<idea-id>` (set by the hum_asks lane), so
 * the trace is the record — nothing has to be written at send time.
 * @returns {{ byIdea: Map<string, number>, lastAnyMs: number, allMs: number[] }}
 */
export function lastAsks(runsRaw) {
  const byIdea = new Map();
  const allMs = [];
  let lastAnyMs = 0;
  for (const line of String(runsRaw || "").split("\n")) {
    if (!line || !line.includes("hum_asks:")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.outcome?.sent !== true) continue;
    const key = String(row?.sonnet?.dedup_key || row?.outcome?.dedup_key || "");
    if (!key.startsWith("hum_asks:")) continue;
    const ts = Date.parse(row.ts || "");
    if (!Number.isFinite(ts)) continue;
    const id = key.slice("hum_asks:".length);
    byIdea.set(id, Math.max(byIdea.get(id) || 0, ts));
    allMs.push(ts);
    lastAnyMs = Math.max(lastAnyMs, ts);
  }
  return { byIdea, lastAnyMs, allMs };
}

/**
 * The one idea worth asking about now, or why none. Easiest yes first (lowest
 * risk), then oldest. Pure: ideas are merged ledger rows, runsRaw the raw
 * hum-runs.jsonl text.
 */
export function pickAsk(ideas, runsRaw, now = Date.now(), { scale = 1 } = {}) {
  const { byIdea, lastAnyMs, allMs } = lastAsks(runsRaw);
  const open = ideas
    .filter((i) => routeFor(i) === "ask_in_chat")
    .filter((i) => !byIdea.has(i.id) || now - byIdea.get(i.id) >= REASK_AFTER_DAYS * 86400000)
    .sort((a, b) => (RISK_RANK[a.risk] ?? 3) - (RISK_RANK[b.risk] ?? 3)
      || String(a.proposed_at || "").localeCompare(String(b.proposed_at || "")));
  // A long question backlog (lib/question-pacing.mjs) multiplies the cap and divides the cooldown.
  const s = Math.max(1, Number(scale) || 1);
  const cooldownH = ASK_COOLDOWN_H / s;
  const maxPerDay = ASK_MAX_PER_DAY * s;
  if (lastAnyMs && now - lastAnyMs < cooldownH * 3600000) {
    return { none: `asked ${Math.round((now - lastAnyMs) / 3600000)}h ago (cooldown ${cooldownH}h)`, waiting: open.length };
  }
  const today = allMs.filter((t) => now - t < 86400000).length;
  if (today >= maxPerDay) {
    return { none: `${today} asked in the last 24h (max ${maxPerDay})`, waiting: open.length };
  }
  if (!open.length) return { none: "no hum improvement is waiting on a question", waiting: 0 };
  return { idea: open[0], waiting: open.length };
}
