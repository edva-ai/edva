#!/usr/bin/env node
// hum-tick — what is left of the hum code tick runner: the reservoir-health
// gate the live hum turn calls on a long silent streak (jobs/hum.md § silent,
// step 3).
//
//   hum-tick reservoir-health [--json]  live ideas vs the low-water mark
//                                       (exit 0 = refill warranted, 1 = not).
//
// The shadow ranker, `compare`, the cutover bar and `run` (the code-only hum
// turn) were removed by a user decision (keep the model ranker; drop the
// code-only shadow/switch-over comparison). The live
// Sonnet hum turn following jobs/hum.md is the only ranker. Background:
// lib/hum-tick-core.mjs header.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reservoirLiveCount, shouldRefill, RESERVOIR_LOW_WATER } from "../../lib/hum-tick-core.mjs";

import { installTools } from "../../lib/root.cjs";
const DATA = installTools("data");
const F = {
  state: path.join(DATA, "hum-state.json"),
  ideas: path.join(DATA, "hum-ideas.jsonl"),
};

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
function readJsonl(p) {
  let lines;
  try { lines = fs.readFileSync(p, "utf8").split("\n"); } catch { return []; }
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* tolerant: one bad line never hides the rest */ }
  }
  return out;
}
const has = (name) => process.argv.includes(`--${name}`);

function cmdReservoirHealth() {
  const live = reservoirLiveCount(readJsonl(F.ideas));
  const streak = readJson(F.state, {})?.silent_streak || 0;
  const refill = shouldRefill(streak, live);
  const out = { live_ideas: live, low_water: RESERVOIR_LOW_WATER, silent_streak: streak, refill };
  console.log(has("json") ? JSON.stringify(out) : `live ideas ${live} (low water ${RESERVOIR_LOW_WATER}), silent streak ${streak} → ${refill ? "REFILL" : "no refill"}`);
  process.exitCode = refill ? 0 : 1;
}

const cmd = process.argv[2];
if (cmd !== "reservoir-health") {
  console.error("usage: hum-tick reservoir-health [--json]   (shadow/compare/run were retired 2026-10-22)");
  process.exit(2);
}
cmdReservoirHealth();
