// hum-explore — pure selection + gating for bin/hum-explore-run.
//
// Replaced the weekly hum canary. The canary asked the user, once
// a week, "would you have wanted these pings?" about items that were stale by
// then — homework with no payoff. Exploration asks nothing: once or twice a
// week it SENDS the best item hum held back, while it is still actionable, as
// an ordinary ping. The user's reaction (👍 / reply / 👎 / ignore) lands in
// hum-feedback.jsonl through the normal path and hum-engagement re-weights the
// lane — which is the only thing the canary was ever for.
//
// Every rule below keeps that send useful and rare:
//   * only DISCRETIONARY lanes — the lanes hum-engagement re-weights;
//   * only lanes where hum is still guessing — a lane with enough decayed
//     evidence pointing one way already has its answer;
//   * only JUDGMENT silences on recent ticks — items blocked by a dedup /
//     settled / already-sent gate were blocked by construction, not taste;
//   * nothing that went out as a ping (by dedup_key; keyless items are never
//     sent, since their identity can't be checked); nothing the ranker scored
//     below 0.40;
//   * fresh: from the last few hours of ticks, so it is still actionable;
//   * at most MAX_PER_WEEK sends, MIN_GAP_H apart, one per lane per week;
//   * never while the latest tick was holding for a protected event or a
//     pending question.
// Identity is structural (dedup_key, else exact lane + normalised signal) —
// never word overlap.

import { DISCRETIONARY_LANES, normLane } from "./hum-engagement.mjs";
import { TRACE_SIGNAL_MAX, isWebLink } from "./hum-tick-core.mjs";

export const MIN_SCORE = 0.40;
export const FRESH_MS = 3 * 3600 * 1000;
export const SENT_LOOKBACK_MS = 8 * 24 * 3600 * 1000;
export const MAX_PER_WEEK = 2;
export const MIN_GAP_H = 48;
export const LANE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;
export const LATEST_TICK_MAX_AGE_MS = 60 * 60 * 1000;
// A lane is "settled" once this much decayed evidence points clearly one way.
export const SETTLED_EVIDENCE = 3.0;
export const SETTLED_RATIO = 0.6;

// Silences that are structural blocks, not judgment calls — never explored.
export const STRUCTURAL_SILENCES = new Set([
  "cross_send_dedup", "novelty_duplicate", "recent_runs_dedup", "history_blocked",
  "wiki_settled", "pre_rank_vetoed", "pending_question_active", "protected_event",
  // The records already answered it (hum-resolve-first).
  "resolved_first",
]);
// If the most recent tick was holding for one of these, now is not the moment.
const HOLD_NOW = new Set(["protected_event", "pending_question_active"]);

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const WEEK_MS = 7 * 24 * 3600 * 1000;

export const candKey = (c) => (c?.dedup_key ? `k:${c.dedup_key}` : `t:${normLane(c?.topic || "")}|${norm(c?.signal)}`);

/** Identities of every finding that went out as a ping. */
export function sentKeysFrom(feedbackRows, nowMs) {
  const since = nowMs - SENT_LOOKBACK_MS;
  const keys = new Set();
  for (const r of feedbackRows || []) {
    const t = Date.parse(r?.sent_at || r?.ts || "");
    if (!Number.isFinite(t) || t < since) continue;
    for (const f of Array.isArray(r.findings) ? r.findings : []) {
      if (!f) continue;
      if (f.dedup_key) keys.add(`k:${f.dedup_key}`);
      if (f.signal) keys.add(`t:${normLane(f.topic || r.lane || "")}|${norm(f.signal)}`);
    }
  }
  return keys;
}

/** Lanes whose taste is already clear from engagement evidence. */
export function settledLanes(evidence) {
  const out = new Set();
  for (const [lane, { pos = 0, neg = 0 } = {}] of Object.entries(evidence || {})) {
    const total = pos + neg;
    if (total >= SETTLED_EVIDENCE && Math.abs(pos - neg) / total >= SETTLED_RATIO) out.add(lane);
  }
  return out;
}

/**
 * Cadence gate over hum-feedback rows. Returns { ok, reason, coolLanes }.
 * coolLanes = lanes explored inside the last week (not eligible again yet).
 */
export function cadenceGate(feedbackRows, nowMs) {
  const explores = (feedbackRows || [])
    .filter((r) => r?.explore)
    .map((r) => ({ t: Date.parse(r.sent_at || r.ts || ""), lane: normLane(r.lane || "") }))
    .filter((e) => Number.isFinite(e.t) && e.t <= nowMs);
  const week = explores.filter((e) => e.t > nowMs - WEEK_MS);
  const coolLanes = new Set(explores.filter((e) => e.t > nowMs - LANE_COOLDOWN_MS).map((e) => e.lane));
  if (week.length >= MAX_PER_WEEK) return { ok: false, reason: `${week.length} explore sends this week`, coolLanes };
  const last = Math.max(-Infinity, ...explores.map((e) => e.t));
  if (nowMs - last < MIN_GAP_H * 3600 * 1000) return { ok: false, reason: `last explore send ${Math.round((nowMs - last) / 3600000)}h ago`, coolLanes };
  return { ok: true, reason: null, coolLanes };
}

/** Is now a moment hum itself would consider interruptible? (latest tick) */
export function momentGate(records, nowMs) {
  let latest = null;
  for (const r of records) {
    if (r.mode) continue; // canary/explore/log rows, not ticks
    const t = Date.parse(r.ts || "");
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (!latest || t > latest.t) latest = { t, r };
  }
  if (!latest || nowMs - latest.t > LATEST_TICK_MAX_AGE_MS) return { ok: false, reason: "no recent hum tick (hum may be paused or in quiet hours)" };
  const cause = latest.r.sonnet?.silent_root_cause;
  if (cause && HOLD_NOW.has(cause)) return { ok: false, reason: `latest tick holding: ${cause}` };
  return { ok: true, reason: null };
}

// The ranker's score for a harvest candidate, when one of its near-misses is
// that candidate: same dedup_key, or the tick's ONLY candidate in that lane
// (two in one lane = ambiguous → no ranker score, never guessed).
function rankerScore(h, nearMisses, harvestCands) {
  for (const nm of nearMisses) {
    if (!nm || typeof nm.score !== "number") continue;
    if (nm.dedup_key && h.dedup_key) { if (nm.dedup_key === h.dedup_key) return nm.score; continue; }
    if (nm.topic === h.topic && harvestCands.filter((c) => c.topic === h.topic).length === 1) return nm.score;
  }
  return null;
}

/**
 * Pool = discretionary-lane harvest candidates on fresh judgment-silenced
 * ticks (most never reach the ranker's top-3 near-misses — operational lanes
 * take those slots), scored by the ranker where it scored them, else by
 * harvest urgency. Ranker-scored first, then by score.
 */
export function selectCandidates(records, nowMs, { sentKeys = new Set(), excludeLanes = new Set(), freshMs = FRESH_MS } = {}) {
  const since = nowMs - freshMs;
  const best = new Map();
  for (const r of records) {
    if (r.mode) continue;
    const t = Date.parse(r.ts || "");
    if (!Number.isFinite(t) || t < since || t > nowMs) continue;
    const s = r.sonnet || {};
    if (s.silent_root_cause && STRUCTURAL_SILENCES.has(s.silent_root_cause)) continue;
    const sentLane = r.outcome && r.outcome.sent ? normLane(s.based_on_topic || "") : null;
    const nearMisses = Array.isArray(s.near_miss_candidates) ? s.near_miss_candidates : [];
    const harvestCands = Array.isArray(r.harvest?.candidates) ? r.harvest.candidates : [];
    for (const h of harvestCands) {
      const lane = normLane(h?.topic || "");
      if (!DISCRETIONARY_LANES.has(lane) || excludeLanes.has(lane)) continue;
      if (sentLane === lane) continue; // that lane fired this tick — may be this very item
      const summary = norm(h.signal);
      if (!summary) continue;
      // No dedup_key → no way to prove it was never sent (older traces omit
      // it, and the signal's wording drifts between ticks: "8-min walk" vs
      // "7-min walk"). A real send must be provably new, so skip it.
      if (!h.dedup_key) continue;
      const key = candKey(h);
      if (sentKeys.has(key)) continue;
      const ranked = rankerScore(h, nearMisses, harvestCands);
      const score = ranked ?? (typeof h.urgency === "number" ? h.urgency : null);
      if (score == null) continue;
      if (ranked != null && ranked < MIN_SCORE) continue; // the ranker looked and passed
      const prev = best.get(key);
      if (!prev || score > prev.score) {
        best.set(key, {
          topic: h.topic, lane, score, ranked: ranked != null, summary, headline: headlineOf(h.signal),
          // A trace hum-run-log could not refill is model-written: check its link too.
          url: (isWebLink(h.url) ? h.url : null) || linkFromKey(h.dedup_key), dedup_key: h.dedup_key || null, urgency: h.urgency ?? null, ts: r.ts,
        });
      }
    }
  }
  return [...best.values()].sort((a, b) => (b.ranked - a.ranked) || (b.score - a.score));
}

// ─── the message ───────────────────────────────────────────────────────────
//
// A pick that arrived as a bare headline had no context and no link. A pick
// now says what the item is, why it was sent, and carries its
// link (the app shows the link's preview card):
//
//   Borderline pick: <the item>
//   <what it is, where the lane knows> <why it was sent>
//   <link>

// What the lane's harvester surfaces, for lanes whose item does not say so
// itself (a bare headline, "title @ venue"). Taken from the harvesters
// (agent/scripts/hum-harvesters/<lane>.mjs). Dining and watchlist
// items already read as full sentences; a lane not listed gets no
// clause rather than a guessed one.
export const LANE_SOURCE = {
  // Past tense: the harvester reads a 30-minute RSS cache and a pick can be
  // three hours old, so "right now" may no longer be true when it lands (Rule #2).
  news: "It was the top story on the New York Times when I checked.", // kernel-guard-ok: the kernel news harvester's public source (hum-harvesters/news.mjs reads its home feed)
  talks: "It's an upcoming event from the listings I watch for you.",
  art: "It's an exhibition on near you.",
  music: "It's from the music I keep an eye on for you.",
};

// Why it went out at all: hum held it back as a maybe, and the user's reaction is
// how the lane learns. Three phrasings so twice a week does not read like a
// template (Rule #0); the item's key picks one, so an item always reads the same.
export const WHY_SENT = [
  "I wasn't sure it was worth a ping, so I'm sending it to find out.",
  "It was a close call whether to send it, so how you react tells me whether to send more like it.",
  "I almost held it back, so your reaction tells me whether this kind of thing is worth a ping.",
];

// The news harvester's key is the article's full link (`news:<link>`); other
// lanes cut theirs to 60 characters, so only this one is usable. Covers ticks
// logged before the run log kept `url`.
function linkFromKey(key) {
  const k = String(key || "");
  if (!k.startsWith("news:")) return null;
  const u = k.slice("news:".length);
  return isWebLink(u) ? u : null;
}

// The item's first line (talks put their link on a second one, which the
// message carries separately), and, when the run log's length limit cut it
// off, back to the last whole word with an ellipsis.
function headlineOf(signal) {
  const raw = String(signal || "");
  let head = norm(raw.split("\n")[0]);
  if (raw.length >= TRACE_SIGNAL_MAX && !raw.includes("\n")) {
    const cut = head.lastIndexOf(" ");
    head = `${(cut > 0 ? head.slice(0, cut) : head).trim()}…`;
  }
  return head;
}

function whyIndex(c) {
  const s = String(c?.dedup_key || c?.summary || "");
  let n = 0;
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
  return n % WHY_SENT.length;
}

export function buildMessage(c) {
  const lane = normLane(c?.lane || c?.topic || "");
  const why = [LANE_SOURCE[lane], WHY_SENT[whyIndex(c)]].filter(Boolean).join(" ");
  return [`Borderline pick: ${c?.headline || c?.summary || ""}`, why, c?.url || null].filter(Boolean).join("\n");
}
