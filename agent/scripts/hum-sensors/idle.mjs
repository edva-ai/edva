// idle — the demoted clock.
//
// This is the ONLY thing left of the old 20-minute tick: a push mechanism
// active only when the user is completely idle and there is no additional
// info (a user requirement).
//
// It fires when nothing else has fired for `idle_fallback_min`, and — unlike
// the old cron — it is still situational: it will not fire when the user is
// away from the desk AND moving (driving, walking, mid-something), because an
// idle-fallback ping only makes sense when the user is reachable and unoccupied. It
// also carries the lowest salience of any sensor, so any real event that lands
// in the same window outranks it.
//
// Slow-moving lanes (news, watchlist, ideas, art) reach the user through this
// path. Removing it entirely would mean hum only ever spoke about things that
// just happened — which is a different, worse product.

import { event } from "./_common.mjs";

export const meta = { name: "idle", lanes: [] };

export default async function detect(ctx) {
  const { config, state, nowMs, memo, setMemo } = ctx;
  const idleMin = config.idle_fallback_min ?? 75;
  const last = state.last_dispatch_at ? (nowMs - new Date(state.last_dispatch_at).getTime()) / 60000 : Infinity;
  if (last < idleMin) return [];

  // Don't stack idle events: one per idle window, re-armed by the next dispatch.
  if (memo?.armed_for === state.last_dispatch_at) return [];
  setMemo({ armed_for: state.last_dispatch_at ?? null });

  // Deliberately no lanes: an idle tick is the one dispatch that SHOULD fan out
  // over the full harvest at normal cadence, because there is no situational
  // hint to focus on. Empty lanes is the signal for "harvest everything due".
  return [event("idle", "quiet", {
    subject: "quiet",
    summary: `Nothing has come up in ${Number.isFinite(last) ? Math.round(last) : idleMin} min`,
    salience: 0.36,
    lanes: [],
    dedup_key: "idle:quiet",
    ttl_min: 20,
    cooldown_min: Math.max(30, Math.round(idleMin * 0.8)),
    data: { idle_min: Number.isFinite(last) ? Math.round(last) : null },
  })];
}
