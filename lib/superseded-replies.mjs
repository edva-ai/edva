// superseded-replies.mjs — a reply that gets rewritten keeps its first draft.
//
// THE INCIDENT (from a Self Improvement Review). The user asked a money
// question and the phone showed a wrong figure before the row was replaced by
// the correct one. The chat table holds only the corrected text, so the wrong
// figure existed in no log; the review only knew about it because the user
// typed it back afterwards. A self-correction
// mechanism that overwrites in place is also an evidence-destruction
// mechanism: no weekly review can find this class of error on its own.
//
// THE DESIGN (the user's pick of the two offered): a LOCAL append-only JSONL, not
// a column on the synced Supabase message table — superseded money and health
// drafts stay on the host and out of the replicated store. It keeps ALL
// superseded reply text rather than trying to decide in code which ones are
// money or health: that decision is language, and Rule #0b says a model owns
// language. The weekly review (jobs/nightly-review.md) reads the file and does
// the classifying. Each row carries a machine `reason` saying which mechanism
// replaced it, plus whatever the mechanism already knew about why.
//
// Gitignored (data/*.jsonl). Append BEFORE the replacing write, so a
// crash between the two loses nothing. Never throws — bookkeeping must not be
// what stops a correction from landing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTools } from "./root.cjs";
export const SUPERSEDED_FILE = process.env.EDVA_SUPERSEDED_REPLIES
  || installTools("data/superseded-replies.jsonl");

/**
 * Record a reply's text before it is replaced.
 *   {row_id, original, replacement, reason, source?, details?}
 * reason: the mechanism, e.g. "freshness_rewrite". details: structured context
 * the mechanism already had (gate reasons, claims) — never re-derived here.
 * Returns true when the row was written.
 */
export function recordSuperseded({ row_id = null, original, replacement = null, reason, source = null, details = null } = {}) {
  try {
    if (typeof original !== "string" || !original) return false;
    if (replacement === original) return false; // nothing was superseded
    const row = {
      ts: new Date().toISOString(),
      row_id, reason: reason || "unspecified", source,
      original, replacement,
      ...(details ? { details } : {}),
    };
    fs.mkdirSync(path.dirname(SUPERSEDED_FILE), { recursive: true });
    fs.appendFileSync(SUPERSEDED_FILE, JSON.stringify(row) + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Rows since an ISO timestamp (inclusive), oldest first. For reviews and tests. */
export function readSuperseded({ sinceIso = null } = {}) {
  let text;
  try { text = fs.readFileSync(SUPERSEDED_FILE, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!sinceIso || String(r.ts) >= sinceIso) out.push(r);
    } catch {}
  }
  return out;
}
