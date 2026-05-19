// suggestion-recall.mjs — read-side helpers for hum's suggestion ledger.
//
// Two consumers:
//   1. Scout/harvester prompts. Call `recallForLane(lane)` to get a structured
//      block listing past subjects + dispositions. Inject verbatim into the
//      LLM brief so the model can avoid resurfacing rejected items and lean
//      into positives.
//   2. Pre-send filter (in hum-ping). Call `lookupDisposition(subject_key)`
//      to get the current state for one candidate, then drop / downgrade
//      based on disposition.
//
// Both consumers share the same fold via deriveState() — single source of
// truth.

import {
  readAllEvents,
  deriveState,
  REASON_TTL_DAYS,
} from "./suggestion-history.mjs";

// Compute effective_until (when a negative disposition stops blocking) given
// the disposition_at timestamp and reason. null = no expiry, indefinite block.
function effectiveUntil(state) {
    // positive is handled separately in isBlocking (lane-specific cooldown)
  if (!state.disposition || state.disposition === "positive" || state.disposition === "visited") return null;
  if (state.disposition_until) return state.disposition_until;
  const ttlDays = state.reason ? REASON_TTL_DAYS[state.reason] : REASON_TTL_DAYS.unknown;
  if (ttlDays == null) return null;
  if (!state.disposition_at) return null;
  const t = new Date(state.disposition_at).getTime();
  return new Date(t + ttlDays * 24 * 3600 * 1000).toISOString();
}

// True iff the disposition is currently active (i.e. blocks resurface).
function isBlocking(state, now = new Date()) {
  if (!state.disposition) return false;
  // For advisory dining/art/talks: a "helpful" (positive) reaction means the user
  // noted the suggestion and may act on it. Don't resurface for 7 days — they
  // know about it already. Without this cooldown, the same restaurant could
  // surface again hours later if the subject_key drifted.
  if (state.disposition === "positive") {
    const POSITIVE_COOLOFF_DAYS = { dining: 7, art: 14, talks: 14, music: 3, concerts: 14 };
    const days = POSITIVE_COOLOFF_DAYS[state.lane] ?? 0;
    if (days > 0 && state.disposition_at) {
      const cooloffUntil = new Date(new Date(state.disposition_at).getTime() + days * 24 * 3600 * 1000);
      return now < cooloffUntil;
    }
    return false;
  }
  if (state.disposition === "visited") return false;
  // negative / snoozed / deferred / neutral all reduce eligibility, but only
  // negative + snoozed are "do not surface". Deferred reduces score (caller
  // decides). Neutral never blocks.
  if (state.disposition === "neutral" || state.disposition === "deferred") return false;
  const until = effectiveUntil(state);
  if (!until) return true;
  return new Date(until) > now;
}

// Look up the current state for a single subject_key. Returns the derived row
// or null if we've never surfaced/seen the subject.
export function lookupSubject(subject_key) {
  if (!subject_key) return null;
  const state = deriveState(readAllEvents());
  return state.get(subject_key) || null;
}

// Convenience: should this candidate be filtered out before send? Returns
// {block: bool, reason: string, state}.
export function shouldFilter(subject_key, now = new Date()) {
  const state = lookupSubject(subject_key);
  if (!state) return { block: false, reason: null, state: null };
  if (isBlocking(state, now)) {
    return {
      block: true,
      reason: `prior_${state.disposition}${state.reason ? `_${state.reason}` : ""}`,
      state,
    };
  }
  return { block: false, reason: null, state };
}

// Build the recall block for a scout LLM prompt. Returns a string ready to
// inline. Format is intentionally compact — Haiku/Sonnet both parse it fine.
//
// Options:
//   lane:        filter to one lane (default: all advisory lanes)
//   max_rows:    cap output (default: 50)
//   window_days: only include subjects last touched within N days
//                (default: 365 for negative, unlimited for positive/visited)
//   include_neutral: include rows with no disposition / surface_count > 1
//                (default: true; helps surface "we showed this 3x but no
//                reaction — down-weight")
export function recallForLane({ lane, max_rows = 50, window_days = 365, include_neutral = true } = {}) {
  const state = deriveState(readAllEvents());
  const now = Date.now();
  const cutoff = window_days ? now - window_days * 24 * 3600 * 1000 : 0;

  const rows = [...state.values()]
    .filter((s) => !lane || s.lane === lane)
    .filter((s) => {
      const t = new Date(s.disposition_at || s.last_surfaced_at || s.first_seen_at || 0).getTime();
      // Always keep blocking rows regardless of window — those are the rules
      // the LLM most needs to see. Window applies only to neutral/positive.
      if (isBlocking(s)) return true;
      return t >= cutoff;
    })
    .filter((s) => include_neutral || s.disposition);

  // Sort: blocking first (most important to NOT resurface), then by
  // last_surfaced_at desc.
  rows.sort((a, b) => {
    const aBlock = isBlocking(a) ? 1 : 0;
    const bBlock = isBlocking(b) ? 1 : 0;
    if (aBlock !== bBlock) return bBlock - aBlock;
    const aT = new Date(a.last_surfaced_at || a.disposition_at || 0).getTime();
    const bT = new Date(b.last_surfaced_at || b.disposition_at || 0).getTime();
    return bT - aT;
  });

  const limited = rows.slice(0, max_rows);

  const lines = limited.map((s) => formatRow(s));
  return {
    block: lines.length
      ? `Past suggestions in this lane and how the user responded (filter your candidates against this — DO NOT propose any with status REJECTED or VISITED unless you have explicit reasoning that the rejection is obsolete):\n${lines.join("\n")}`
      : "(no prior suggestions on record yet)",
    rows: limited,
    total: rows.length,
  };
}

function formatRow(s) {
  const status = s.disposition === "negative"
    ? `REJECTED${s.reason ? `:${s.reason}` : ""}`
    : s.disposition === "positive"
    ? "LIKED"
    : s.disposition === "visited"
    ? "VISITED"
    : s.disposition === "snoozed"
    ? "SNOOZED"
    : s.disposition === "deferred"
    ? "DEFERRED"
    : `surfaced ${s.surface_count}× — no reaction`;
  const detail = s.reason_detail ? ` (${s.reason_detail})` : "";
  const display = s.display || s.subject_key;
  return `- ${display} [${s.subject_key}] — ${status}${detail}`;
}

// Pre-send filter for an array of candidates. Each candidate must have a
// pre-computed `subject_key` field. Returns {kept, dropped[]} where dropped
// rows have `_filter_reason`.
export function filterCandidates(candidates, now = new Date()) {
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    const key = c.subject_key || c._subject_key;
    if (!key) { kept.push(c); continue; }
    const { block, reason, state } = shouldFilter(key, now);
    if (block) {
      dropped.push({ ...c, _filter_reason: reason, _filter_state: state });
    } else {
      kept.push(c);
    }
  }
  return { kept, dropped };
}

export { isBlocking, effectiveUntil };
