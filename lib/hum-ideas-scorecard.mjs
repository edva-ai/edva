// hum-ideas-scorecard — the per-category reaction scorecard hum-ideation plans
// its generation mix from (jobs/hum-ideation.md Step 2).
//
// Until 2026-10-04 the ideation agent rebuilt this by hand every run: join
// hum-feedback.jsonl reactions to the ideas whose consumed record carries the
// same ping_id, tally per category, apply the score formula. All of it is a
// join and arithmetic, so it now runs inside hum-reservoir-prune (nightly and
// after every prune) and the agent just reads hum-ideas-scorecard.json.
//
// Reaction vocabulary is the canonical one `edva hum feedback` stores
// (HUM_REACTION_ALIASES): ❤️/heart → more, 👍 → helpful (counted as `up`),
// 👎 → skip, 💤 → snooze. `heart` and `down` stay in the schema at zero because
// the aliasing folds them into `more` / `skip`.
//
// score = (heart*1.0 + up*0.6 + more*1.2 − skip*0.8 − down*1.0) / (sent + 1)
// silent = no reaction 6h+ after sent_at (zero weight, tracked).
// rejected_patterns: a category with silent/sent > 0.7 at sent >= 5 (surfaced, never auto-demoted).

import { createRequire } from "node:module";

const FEEDBACK_WINDOW_MS = 30 * 86400000;

// The fields an idea's lens (one of the seven ideation lenses) can be under:
// `idea_lens`, then any older name an installation's stored ideas still carry,
// listed in agent/local/config/hum-ideas.json `extend_lens_fields`.
export function lensFields() {
  return createRequire(import.meta.url)("./instance.cjs").localConfig("hum-ideas", { lens_fields: ["idea_lens"] }).lens_fields;
}

/** An idea's lens, or undefined. */
export function lensOf(idea, fields = lensFields()) {
  for (const f of fields) if (idea && idea[f] != null && idea[f] !== "") return idea[f];
  return undefined;
}
const SILENT_AFTER_MS = 6 * 3600000;

function emptyRow() { return { sent: 0, heart: 0, up: 0, more: 0, skip: 0, down: 0, snooze: 0, silent: 0, score: 0, last: null }; }

function bump(row, reaction, sentMs, nowMs, sentAt) {
  row.sent += 1;
  if (!row.last || sentAt > row.last) row.last = sentAt;
  switch (reaction) {
    case "helpful": row.up += 1; break;
    case "more": row.more += 1; break;
    case "skip": row.skip += 1; break;
    case "snooze": row.snooze += 1; break;
    default:
      if (!reaction && nowMs - sentMs >= SILENT_AFTER_MS) row.silent += 1;
  }
}

function finish(row) {
  row.score = Number(((row.heart * 1.0 + row.up * 0.6 + row.more * 1.2 - row.skip * 0.8 - row.down * 1.0) / (row.sent + 1)).toFixed(3));
  return row;
}

/**
 * @param ideasById Map<id, collapsed idea>  (reservoir ∪ archive)
 * @param feedback  hum-feedback.jsonl rows
 */
export function buildScorecard(ideasById, feedback, nowMs = Date.now()) {
  const ideaByPing = new Map();
  for (const idea of ideasById.values()) if (idea.ping_id) ideaByPing.set(idea.ping_id, idea);

  const byCategory = {};
  const byCategoryLens = {};
  const fields = lensFields();
  for (const f of feedback) {
    const sentMs = Date.parse(f.sent_at || "");
    if (!Number.isFinite(sentMs) || nowMs - sentMs > FEEDBACK_WINDOW_MS) continue;
    const idea = ideaByPing.get(f.ping_id);
    if (!idea) continue;
    const cat = idea.category || "uncategorized";
    bump(byCategory[cat] ||= emptyRow(), f.reaction, sentMs, nowMs, f.sent_at);
    const cl = `${cat}×${lensOf(idea, fields) || "none"}`;
    bump(byCategoryLens[cl] ||= emptyRow(), f.reaction, sentMs, nowMs, f.sent_at);
  }
  for (const r of Object.values(byCategory)) finish(r);
  for (const r of Object.values(byCategoryLens)) finish(r);

  const rejected = Object.entries(byCategory)
    .filter(([, r]) => r.sent >= 5 && r.silent / r.sent > 0.7)
    .map(([cat, r]) => ({ pattern: `category:${cat} mostly silent`, skips: r.skip, silent: r.silent, sent: r.sent, last: r.last }));

  const ranked = Object.entries(byCategory).sort((a, b) => b[1].score - a[1].score);
  return {
    updated_at: new Date(nowMs).toISOString(),
    window_days: 30,
    by_category: byCategory,
    by_category_lens: byCategoryLens,
    top: ranked.slice(0, 2).map(([c, r]) => ({ category: c, score: r.score, sent: r.sent })),
    bottom: ranked.slice(-2).reverse().map(([c, r]) => ({ category: c, score: r.score, sent: r.sent })),
    rejected_patterns: rejected,
  };
}
