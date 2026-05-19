#!/usr/bin/env node
// Watchdog — unresolved system-watchdog issues in the last 60 min.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;
const LOG = path.join(os.homedir(), "dev/merlin/agent/logs/watchdog.log");

let issues = [];
try {
  const tail = fs.readFileSync(LOG, "utf8").split("\n").slice(-400);
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const line of tail) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) .*Watchdog issues:(.+)$/);
    if (!m) continue;
    const ts = new Date(m[1]).getTime();
    if (ts >= cutoff) issues.push(m[2].trim());
  }
} catch {}

// Dedup — if the same issue string repeats, just count it
const counts = {};
for (const i of issues) counts[i] = (counts[i] || 0) + 1;
const topEntry = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

if (!topEntry) { stampRun("watchdog", false); emitNull("no issues in last 60 min"); process.exit(0); }

const [issue, count] = topEntry;
stampRun("watchdog", true);
emit({
  topic: "watchdog",
  signal: `Watchdog: ${issue} (${count}× last hour)`,
  urgency: count >= 10 ? 0.7 : 0.4,
  freshness_min: 0,
  dedup_key: `health:${issue}`,
  supporting_data: { issues_counts: counts, total: issues.length },
});
