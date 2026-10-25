// hum-topic-match.mjs — "is this idea about the same topic as that one?" by
// EMBEDDING similarity, for the hum ideas reservoir (2026-10-04).
//
// Replaces three keyword rules that did arithmetic on language (Rule #0b):
//   - hum-ideation Rule 10 (≥2 shared content words with a resolved topic),
//   - hum-ideation Rule 11 (≥4 shared content words with a recently-consumed
//     subject),
//   - hum-reservoir-review's keyword sweep (word-equality against
//     subject+rationale+supporting_data — the 2026-08-04 version consumed 49
//     unrelated ideas off one substring).
// Word overlap both over-fires (common words) and under-fires (paraphrase:
// "<name>'s birthday is Tuesday" vs "…tomorrow"). An embedding compares
// meaning without anyone writing a rule about words.
//
// Embedder: the local nomic-embed-text via lib/hum-novelty.mjs — no API,
// no cost. FAIL-SAFE in the direction each caller needs: when the embedder is
// down, `nearest()` reports unavailable and the caller decides (the ideation
// gate skips the rule and writes; the reservoir sweep consumes nothing).

import { embed, cosine } from "./hum-novelty.mjs";

// Thresholds are deliberately separate and env-tunable; every caller logs the
// score it saw so they can be tuned from data.
export const RESOLVED_THRESHOLD = Number(process.env.HUM_TOPIC_RESOLVED_THRESHOLD || 0.8);
export const CONSUMED_THRESHOLD = Number(process.env.HUM_TOPIC_CONSUMED_THRESHOLD || 0.86);
export const SWEEP_THRESHOLD = Number(process.env.HUM_TOPIC_SWEEP_THRESHOLD || 0.8);
// A sweep that would consume more than this many ideas is almost certainly a
// too-broad topic, not a resolution — refuse rather than empty the reservoir.
export const SWEEP_MAX = Number(process.env.HUM_TOPIC_SWEEP_MAX || 6);

/** Embed a list of {id, text} once. Returns {rows:[{...,vec}], available}. */
export async function embedAll(items, { embedFn = embed } = {}) {
  const rows = [];
  for (const it of items || []) {
    const text = String(it?.text || "").trim();
    if (!text) continue;
    const vec = await embedFn(text);
    if (!vec) {
      if (!rows.length) return { rows: [], available: false }; // embedder down — don't hammer it
      continue;
    }
    rows.push({ ...it, vec });
  }
  return { rows, available: rows.length > 0 || (items || []).length === 0 };
}

/** Max-cosine neighbour of vec among rows. */
export function nearest(vec, rows) {
  let best = null, sim = 0;
  for (const r of rows || []) {
    const s = cosine(vec, r.vec);
    if (s > sim) { sim = s; best = r; }
  }
  return { best, sim };
}

/** The text an idea is compared on: its subject, which is what the user saw. */
export const ideaText = (idea) => String(idea?.subject || "").trim();

/** The text a resolved-topics row is compared on. */
export function resolvedText(row) {
  return String(row?.topic || (Array.isArray(row?.keywords) ? row.keywords.join(" ") : "") || "").trim();
}

/**
 * Which unconsumed ideas are about `topic`? Pure over pre-embedded rows.
 * Returns {matched:[{id, subject, sim}], refused: reason|null}.
 */
export function sweepMatches(topicVec, ideaRows, { threshold = SWEEP_THRESHOLD, max = SWEEP_MAX } = {}) {
  const matched = (ideaRows || [])
    .map((r) => ({ id: r.id, subject: r.subject ?? r.text, sim: cosine(topicVec, r.vec) }))
    .filter((m) => m.sim >= threshold)
    .sort((a, b) => b.sim - a.sim);
  if (matched.length > max) return { matched, refused: `topic too broad: ${matched.length} ideas ≥ ${threshold} (max ${max})` };
  return { matched, refused: null };
}
