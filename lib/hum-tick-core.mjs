// hum-tick-core.mjs — the pure helpers left from the hum code tick runner:
// the reservoir-refill gate (hum.md § silent step 3, via `hum-tick
// reservoir-health`) and the run-log candidate shape (`traceCandidate`, used
// by bin/hum-run-log and lib/hum-explore.mjs). No I/O.
//
// What is gone, and why (the user's decision D16 of a Self Improvement Review:
// keep the current model ranker; drop the code-only shadow/switch-over
// comparison). For a few weeks a code tick runner ranked
// every harvest in shadow beside the live Sonnet hum turn, and a daily cron
// (shadow-cutover-check) would have switched hum over to it once the two
// agreed. They never did — 47% decision agreement over 138 ticks in five days,
// partly because the code path copied a Haiku ranker the live turn had stopped
// using. The live hum turn (jobs/hum.md) stays the only ranker; the
// shadow run, the comparison, the cutover bar and the live switch were removed.
//
// Rule #0b: counts and structured fields only. Nothing here reads language.

// Refill the ideas reservoir on a long silent streak only when it is actually
// running low. In event mode silence is the designed norm, so a streak alone
// says nothing about the reservoir (2026-10-04).
export const SILENT_STREAK_REFILL = 6;
export const RESERVOIR_LOW_WATER = 15;

/** Live (unconsumed, unexpired) ideas in the reservoir, from collapsed rows. */
export function reservoirLiveCount(rows) {
  const byId = new Map();
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
  }
  let live = 0;
  for (const idea of byId.values()) if (!idea.consumed && !idea.expired) live++;
  return live;
}

/** Should a silent streak trigger an extra ideation run? Gated on reservoir health. */
export function shouldRefill(silentStreak, liveIdeas, { streak = SILENT_STREAK_REFILL, lowWater = RESERVOIR_LOW_WATER } = {}) {
  return silentStreak >= streak && liveIdeas < lowWater;
}

// Where each harvester puts the item's own link, in its structured fields
// (agent/scripts/hum-harvesters/<lane>.mjs). Read in this order.
const LINK_FIELDS = [
  (c) => c.url,
  (c) => c.supporting_data?.url,              // talks
  (c) => c.supporting_data?.candidate?.url,   // art, music, dining (new places)
  (c) => c.supporting_data?.top?.link,        // news (the NYT RSS item)
  (c) => c.supporting_data?.maps_url,         // saved-places, dining (the user's own tagged spots)
  (c) => c.supporting_data?.candidate?.maps_url,
];

export const isWebLink = (v) => typeof v === "string" && v.length <= 500
  && (v.startsWith("https://") || v.startsWith("http://"))
  && !v.includes(" ") && !v.includes("\n");

/** A harvest candidate's own web link, or null. Structured fields only. */
export function candidateLink(c) {
  for (const get of LINK_FIELDS) {
    let v = null;
    try { v = get(c || {}); } catch { /* odd shape: no link */ }
    if (isWebLink(v)) return v;
  }
  return null;
}

export const TRACE_SIGNAL_MAX = 240;

/**
 * One harvest candidate as the run log keeps it — the same shape from both
 * writers (fillHarvestKeys in bin/hum-run-log, and the code tick runner until 2026-10-22). `url`
 * is kept so a later send built from the log (hum-explore's borderline pick)
 * can carry the link: a news headline once went out bare, with no context and
 * no link. The signal limit was 120, which cut an earlier pick off mid-word.
 */
export function traceCandidate(c) {
  const url = candidateLink(c);
  return {
    topic: c?.topic, urgency: c?.urgency ?? null, freshness_min: c?.freshness_min ?? null, dedup_key: c?.dedup_key ?? null,
    signal: String(c?.signal || "").slice(0, TRACE_SIGNAL_MAX),
    ...(url ? { url } : {}),
  };
}
