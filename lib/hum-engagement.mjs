// hum-engagement.mjs — deterministic per-lane engagement weighting for hum.
//
// Computes a multiplier for each DISCRETIONARY lane from hum-feedback.jsonl:
// lanes the user engages with (👍 / "more" / "helpful" / any reply) get boosted,
// lanes the user ignores or 👎/💤s get suppressed. Operational / important / safety
// lanes (exercise, tasks, calendar, ideas, project lanes, travel,
// stocks, health, situation, watchdog, …) are NEVER weighted — they keep 1.0,
// so this can only re-rank discretionary recommendations, never silence
// something that matters.
//
// Applied to `candidate.urgency` in hum-harvest-all.mjs before the ranker sees
// it, so the weighting is deterministic at the rank input — not a soft prompt
// hint. Added at the user's request: prioritize topics the user upvotes, loves
// or responds to, deprioritize those downvoted or ignored, scoped to discretionary
// lanes. The hum.md FEEDBACK-bias instruction is now backed by this number.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const HOME = process.env.HOME;
const FEEDBACK = installTools("data/hum-feedback.jsonl");

// The only lanes this re-ranks. `watchlist-approval` and `watchlist` are the
// same lane for engagement purposes (normalized below). An installation adds
// its own discretionary lanes with extend_discretionary in
// agent/local/config/hum-lanes.json.
export const DISCRETIONARY_LANES = new Set(createRequire(import.meta.url)("./instance.cjs").localConfig("hum-lanes", {
  discretionary: [
    "dining", "art", "music", "talks", "news", "serendipity",
    "watchlist", "watchlist-approval",
  ],
}).discretionary);

export function normLane(l) {
  return l === "watchlist-approval" ? "watchlist" : l;
}

const POS = /^(👍|more|more of these|helpful|love|loved|yes|y)$/i;
const NEG = /^(👎|skip|skip this|snooze|💤|no|n|stop|less)$/i;

const WINDOW_DAYS = 30;
const DECAY_DAYS = 15;                      // recent reactions weigh more
const IGNORED_GRACE_MS = 6 * 3600 * 1000;   // a null reaction older than this counts as "ignored"
const IGNORED_WEIGHT = 0.3;                 // an ignore is a mild negative vs an explicit 👎 (1.0)
const NEUTRAL_REPLY_WEIGHT = 0.5;           // any other non-null reaction = the user engaged (mild positive)
const SPREAD = 0.35;                        // multiplier range = [1-SPREAD, 1+SPREAD] = [0.65, 1.35]
const MIN_SIGNAL = 0.5;                     // below this much decayed evidence → stay neutral

// computeEngagementWeights() -> { <lane>: multiplier }  (only lanes with signal)
export function computeEngagementWeights(opts = {}) {
  const weights = {};
  for (const [lane, { pos, neg }] of Object.entries(laneEvidence(opts))) {
    const total = pos + neg;
    if (total < MIN_SIGNAL) { weights[lane] = 1.0; continue; }
    const ratio = (pos - neg) / total; // [-1, 1]
    weights[lane] = +(1.0 + ratio * SPREAD).toFixed(3);
  }
  return weights;
}

// laneEvidence() -> { <lane>: { pos, neg } } — the decayed evidence behind the
// weights. hum-explore-run reads it to tell a lane whose taste is already
// clear from one where hum is still guessing.
export function laneEvidence({ now = Date.now(), feedbackPath = FEEDBACK } = {}) {
  let lines;
  try { lines = fs.readFileSync(feedbackPath, "utf8").trim().split("\n"); }
  catch { return {}; } // no feedback yet → every lane neutral
  const cutoff = now - WINDOW_DAYS * 86400_000;
  const acc = {}; // lane -> { pos, neg }
  for (const line of lines) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    let lane = r.lane || r.topic || (r.findings && r.findings[0] && r.findings[0].topic);
    if (!lane) continue;
    lane = normLane(lane);
    if (!DISCRETIONARY_LANES.has(lane)) continue;
    const sentAt = Date.parse(r.sent_at || r.ts || "");
    if (!Number.isFinite(sentAt) || sentAt < cutoff) continue;
    const decay = Math.exp(-((now - sentAt) / 86400_000) / DECAY_DAYS);
    const reaction = (r.reaction == null ? "" : String(r.reaction)).trim();
    acc[lane] = acc[lane] || { pos: 0, neg: 0 };
    if (POS.test(reaction)) acc[lane].pos += decay;
    else if (NEG.test(reaction)) acc[lane].neg += decay;
    else if (reaction) acc[lane].pos += NEUTRAL_REPLY_WEIGHT * decay; // engaged (replied) — mild positive
    else if (now - sentAt > IGNORED_GRACE_MS) acc[lane].neg += IGNORED_WEIGHT * decay; // ignored
    // else: null reaction, too recent to judge → no signal
  }
  return acc;
}
