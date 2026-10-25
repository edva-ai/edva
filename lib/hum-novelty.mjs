// hum-novelty.mjs — semantic near-duplicate gate for the hum.
//
// Motivation (Moon, Green & Kushlev 2025, "Homogenizing effect of LLMs on
// creative diversity", Computers in Human Behavior: Artificial Humans):
// LLM-generated outputs add little *new* collective diversity as they
// accumulate — lots of surface variety, low marginal signal, a diversity
// growth rate that saturates fast. hum-ping's exit-8 dedup catches an *exact*
// repeat (same `dedup_key` within 24h). It does NOT catch the harder case the
// paper is actually about: a *different* subject that restates information
// already surfaced recently ("you have lunch with <name> at 1" ↔ "don't forget
// the 1pm lunch with <name>"). That near-duplicate is what erodes trust in every
// ping.
//
// This module is the semantic sibling of exit-8. It embeds the headline's
// substantive text with the same local nomic-embed-text (Ollama) embedder the
// memory index already uses, and compares (max cosine) against a rolling
// window of recently-sent pings cached in a JSONL sidecar. No API, no cost,
// ~10-30ms/embed on the production host.
//
// FAIL-OPEN BY CONTRACT: any embedder or I/O failure yields "no duplicate"
// (embed() returns null, recentVectors() returns []). A down Ollama can never
// silence the hum — it only disables the gate until the embedder is back.
//
// Enforcement lives in bin/hum-ping (§0d, exit 9). This file is pure
// logic + sidecar I/O so it can be unit-tested and the threshold tuned from
// the novelty_max_sim values hum-ping logs onto every feedback row.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTools } from "./root.cjs";
const HOME = os.homedir();

// Env-overridable so tests use isolated fixtures and tuning is a config change,
// not a code change.
export const SIDECAR_PATH =
  process.env.HUM_NOVELTY_SIDECAR ||
  installTools("data/hum-ping-vectors.jsonl");
// Window is wider than exit-8's 24h: homogenization is about the *accumulated*
// feel of many pings, not just back-to-back repeats.
export const WINDOW_H = Number(process.env.HUM_NOVELTY_WINDOW_H || 72);
// Threshold calibrated on the production host against real nomic-embed-text output
// (2026-07-09). KEY FINDING: cosine over the full signal text CANNOT cleanly
// separate restatements from distinct pings, because structurally-templated
// pings defeat it. Measured on the live embedder:
//     same restaurant restated ............ 0.886   (DUP — want blocked)
//     same flight restated ................ 0.790   (DUP — want blocked)
//     two flights, DIFFERENT routes ....... 0.897   (DIFF — must NOT block)
//     two different dining recs ........... 0.570   (DIFF)
//     distinct topics ..................... 0.55-0.68
// The different-route flight alerts (0.897) outscore a real restatement (0.790)
// because the sentence template dominates the entities (route/amount/date).
// So any threshold low enough to catch soft restatements also kills genuinely-
// new templated pings. The only FALSE-POSITIVE-SAFE block is near-verbatim,
// above the templated-DIFF ceiling → default 0.93. This enforces on true
// near-duplicates while never suppressing distinct signal. novelty_max_sim is
// logged on EVERY ping so we can (a) set a data-driven threshold if one ever
// separates and (b) build the real fix: an ENTITY-OVERLAP gate (block only when
// cosine is high AND the concrete tokens — numbers, proper nouns, dates —
// substantially overlap). See the 2026-07-09 changelog.md entry.
export const THRESHOLD = Number(process.env.HUM_NOVELTY_THRESHOLD || 0.93);

// Per-lane threshold (2026-10-06) — the data-driven calibration the comment
// above was waiting for, now that the logged sims separate.
//
// The `nearby` lane keys its dedup_key on a standing SUBJECT, so all facts about
// one landmark share a key and the exit-8 window cannot tell a NEW fact from a
// RESTATED one. That is this gate's job, not exit-8's. (The "This is a repeat."
// complaint quoted further up this file belongs to an earlier incident, a
// different defect; the evidence below is sims and tapbacks, not a quote.)
//
// What the logged novelty_max_sim actually says about five nearby sends over
// three days (two landmarks), with the user's own tapbacks beside them:
//     day 1  landmark A  0.6446  "more"
//     day 1  street B    0.6366  —
//     day 2  landmark A  0.9047  —        <- the repeat
//     day 3  street B    0.8181  "more"
//     day 3  landmark A  0.8597  "more"   (a new fact about it)
// The one send the user ignored is the only one above 0.90, and it missed the global
// 0.93 by 0.025. A 0.90 threshold for this lane blocks exactly that one and
// keeps all three the user liked.
//
// This was chosen over widening the exit-8 dedup window, which was tried first
// and measured: 168h would have suppressed three sends, TWO of them carrying a
// "more" reaction — a third of the lane's positive engagement for the week, on
// the lane the finding says must not be down-weighted. A window cannot
// distinguish a new fact about a landmark from a repeat of an old one; cosine
// similarity can, and on this evidence does.
//
// WHY 0.90 IS SAFE HERE AND NOT IN GENERAL. The 2026-07-09 entry that asked for
// this calibration also measured the case AGAINST lowering: two flight alerts
// for DIFFERENT routes scored 0.897, genuinely-new info that must not be
// blocked. 0.90 sits 0.003 above that, so it is not a safe global. It is safe
// for THIS lane on this lane's own distribution: across 53 nearby sends with a
// logged sim (back to August), exactly one reaches 0.90 — the repeat — and the
// highest non-repeat is 0.8597, leaving ~4 points of headroom. The 0.897 case
// was a different lane's templated diff. Do not generalise this number.
//
// Precedence is specific-beats-general: per-lane env, then this table, then the
// global env, then the default. An operator tightening the global must not
// silently LOOSEN a lane that was deliberately tuned.
export const THRESHOLD_BY_LANE = { nearby: 0.90 };

/** The novelty threshold that applies to one lane. */
export function thresholdFor(lane) {
  const key = String(lane || "").toLowerCase();
  const envName = `HUM_NOVELTY_THRESHOLD_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`; // lang-regex-ok: normalises a lane id into a shell-legal env var name; both are machine-generated identifiers, no language judgement
  // `> 0`, not merely finite. Number("") is 0 and Number.isFinite(0) is true,
  // and `HUM_NOVELTY_THRESHOLD=` with no value is exactly how a dotenv line or
  // a shell export "unsets" a variable. A threshold of 0 makes EVERY candidate
  // carrying a vector a novelty duplicate — vetoed pre-rank and refused at
  // exit 9, on every lane — and it throws nothing, so neither the try/catch in
  // hum-vetoes.mjs nor this module's documented fail-open property would catch
  // it. Hum would simply go silent. The old `Number(env || 0.93)` module
  // constant could not reach 0; reading the env per call can, so the guard has
  // to be explicit.
  const ok = (x) => Number.isFinite(x) && x > 0;
  const perLane = Number(process.env[envName]);
  if (ok(perLane)) return perLane;
  if (Object.prototype.hasOwnProperty.call(THRESHOLD_BY_LANE, key)) return THRESHOLD_BY_LANE[key];
  const global = Number(process.env.HUM_NOVELTY_THRESHOLD);
  if (ok(global)) return global;
  return 0.93;
}
// Hard cap on sidecar rows regardless of window, so a burst can't grow it
// unbounded.
const MAX_ROWS = 400;

// Pick the substantive text to embed. We deliberately use the finding's
// signal/summary — NOT the rendered message — because greeting/boilerplate in
// the message inflates cosine similarity and would make every ping look alike.
export function signalText(headline, message) {
  if (headline) {
    const t = headline.signal || headline.summary || headline.subject_display || "";
    if (t && String(t).trim()) return String(t).trim();
  }
  return String(message || "").trim();
}

// Embed via the same Ollama nomic-embed-text helper the memory index uses.
// Returns a float array, or null on empty text / any embedder failure.
export async function embed(text) {
  if (!text || !String(text).trim()) return null;
  try {
    const { localLlmEmbed } = await import("./local-llm.mjs");
    const vec = await localLlmEmbed(String(text));
    if (!Array.isArray(vec) || !vec.length) return null;
    return vec;
  } catch {
    return null; // fail-open
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Rows sent within `windowH` hours. Best-effort: [] on any failure (missing
// file, unreadable, etc.). The sidecar is bounded (MAX_ROWS), so we scan the
// whole file and filter by timestamp rather than assuming strict chronological
// append order — robust to a clock adjustment or an out-of-order backfill.
export function recentVectors(nowMs = Date.now(), windowH = WINDOW_H) {
  let raw;
  try {
    raw = fs.readFileSync(SIDECAR_PATH, "utf8");
  } catch {
    return [];
  }
  const since = nowMs - windowH * 3600_000;
  const out = [];
  for (const ln of raw.split("\n")) {
    if (!ln || !ln.trim()) continue;
    let row;
    try { row = JSON.parse(ln); } catch { continue; }
    if (!row.sent_at || !Array.isArray(row.vec)) continue;
    const t = new Date(row.sent_at).getTime();
    if (!Number.isFinite(t) || t < since) continue;
    out.push(row);
  }
  return out;
}

// Max cosine of `vec` against recent rows. Returns { maxSim, nearest }.
export function nearestDuplicate(vec, rows) {
  let maxSim = 0, nearest = null;
  if (!vec) return { maxSim, nearest };
  for (const r of rows) {
    const sim = cosine(vec, r.vec);
    if (sim > maxSim) { maxSim = sim; nearest = r; }
  }
  return { maxSim, nearest };
}

// Append one sent-ping vector row, then opportunistically prune to
// (2×window ∪ MAX_ROWS). Append is atomic (POSIX, sub-PIPE_BUF); the prune
// rewrite is best-effort and only trims history, so a rare concurrent-write
// clobber degrades the gate momentarily rather than corrupting correctness.
export function record(row, nowMs = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(SIDECAR_PATH), { recursive: true });
    fs.appendFileSync(SIDECAR_PATH, JSON.stringify(row) + "\n");

    let raw;
    try { raw = fs.readFileSync(SIDECAR_PATH, "utf8"); } catch { return; }
    const allLines = raw.split("\n").filter((x) => x.trim());
    // Cheap guard: only rewrite when the file has clearly grown past its bound.
    if (allLines.length <= MAX_ROWS) return;
    const since = nowMs - 2 * WINDOW_H * 3600_000;
    const kept = [];
    for (const ln of allLines) {
      let r;
      try { r = JSON.parse(ln); } catch { continue; }
      const t = r.sent_at ? new Date(r.sent_at).getTime() : 0;
      if (Number.isFinite(t) && t >= since) kept.push(ln);
    }
    const trimmed = kept.slice(-MAX_ROWS);
    fs.writeFileSync(SIDECAR_PATH, trimmed.join("\n") + "\n");
  } catch {
    // best-effort — never let a caching failure affect the send
  }
}
