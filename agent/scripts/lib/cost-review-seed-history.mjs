#!/usr/bin/env node
// cost-review-seed-history.mjs — write today's cost-efficiency-review headline
// row into the state file BEFORE the agent turn runs.
//
// WHY. A review that dispatches but never reaches its Step 6 loses that day's
// measurement outright:
// cost-efficiency-today.json is overwritten by the next run, and the following
// morning's 1-day floor tripwire compared across a two-day gap with nothing in
// the file marking it. Every number in this row is arithmetic over the report
// the trigger has already fetched — none of it needs a model — so capturing it
// here makes the measurement independent of whether the agent turn survives.
// The agent then ANNOTATES this row (job_cost_index, attribution, verdicts).
//
// Idempotent: a row already present for the date is left exactly as it is, so a
// re-run can never clobber an annotated row.
//
// Usage: node cost-review-seed-history.mjs <today.json> <state.json>
// Exits 0 on success AND on any recoverable problem — seeding the history row
// must never be the reason a review does not run.

import fs from "node:fs";
import { createRequire } from "node:module";

const [todayPath, statePath] = process.argv.slice(2);
if (!todayPath || !statePath) {
  console.error("usage: cost-review-seed-history.mjs <today.json> <state.json>");
  process.exit(64);
}

try {
  const r = JSON.parse(fs.readFileSync(todayPath, "utf8"));
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));

  // Entry date = the home-timezone date the run fires on (lib/instance.cjs
  // tz), matching every existing row: the entry for day D covers the window
  // (D-1)T06:37Z..(D)T06:37Z.
  const homeTz = createRequire(import.meta.url)("../../../lib/instance.cjs").instance().tz;
  const date = new Date().toLocaleDateString("en-CA", { timeZone: homeTz });

  if (!Array.isArray(s.history)) s.history = [];
  if (s.history.some((h) => h && h.date === date)) process.exit(0); // never clobber

  const sups = Array.isArray(r.supervisors) ? r.supervisors : [];
  const byTier = (field) => Object.fromEntries(sups.map((x) => [x.supervisor, x[field]]));
  const total = (field) => sups.reduce((a, x) => a + (x[field] || 0), 0);

  s.history.push({
    date,
    window: `${r.since}..${new Date().toISOString()}`,
    dispatches: r.dispatches ?? null,
    context_overhead_pct: r.context_overhead_pct ?? null,
    weighted_cost_usd: r.weighted_cost_usd ?? null,
    usd_per_dispatch:
      r.dispatches ? Math.round((r.weighted_cost_usd / r.dispatches) * 1e4) / 1e4 : null,
    cost_per_1k_output_usd: r.cost_per_1k_output_usd ?? null,
    turns_per_dispatch: r.turns_per_dispatch ?? null,
    total_turns: r.total_turns ?? null,
    floors: byTier("floor_tokens"),
    floor_samples: byTier("floor_samples"),
    working_windows: byTier("working_window_tokens"),
    compacts: total("compacts"),
    rotates: total("rotates"),
    compacts_skipped: total("compacts_skipped"),
    compacts_skipped_episodes: total("compacts_skipped_episodes"),
    // Per tier, not summed: a tier can be complete at 24h and partial at 7d, and
    // a partial tier's churn counts must not be reasoned about at all.
    churn_partial: byTier("churn_partial"),
    // Anthropic's own metering of the Max allowance — the only non-estimated
    // budget number in the report, and the one the event log destroys on
    // rotation. Seeded here for the same reason as everything above it: by the
    // time anyone wants the history, the source is gone.
    max_usage: r.max_usage ?? null,
    written_by: "trigger",
    agent_annotated: false,
  });
  s.history = s.history.slice(-30);

  fs.writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n");
  console.log(`seeded history row for ${date}`);
} catch (e) {
  console.error(`history seed failed (continuing): ${e.message}`);
}
process.exit(0);
