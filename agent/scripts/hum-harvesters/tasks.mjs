#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;

try {
  const plain = execSync("gog tasks list @default --plain", {
    encoding: "utf8", timeout: 10000,
  });
  // gog plain output is TSV; find overdue + due-today lines
  const today = new Date().toISOString().slice(0, 10);
  const lines = plain.split("\n").filter(Boolean);
  // Lines include due dates; find any "due <YYYY-MM-DD>" <= today and status != completed
  const overdue = [];
  const dueToday = [];
  for (const line of lines) {
    const m = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const due = m[1];
    if (line.includes("completed")) continue;
    if (due < today) overdue.push(line.slice(0, 120));
    else if (due === today) dueToday.push(line.slice(0, 120));
  }
  const count = overdue.length + dueToday.length;
  if (count === 0) { stampRun("tasks", false); emitNull("no due"); process.exit(0); }

  const urgency = overdue.length >= 3 ? 0.7 : (overdue.length >= 1 ? 0.5 : 0.3);
  stampRun("tasks", true);
  emit({
    topic: "tasks",
    signal: `${overdue.length} overdue, ${dueToday.length} due today`,
    urgency,
    freshness_min: 0,
    dedup_key: `tasks:${today}:${overdue.length}:${dueToday.length}`,
    supporting_data: { overdue: overdue.slice(0, 5), due_today: dueToday.slice(0, 5) },
  });
} catch (e) {
  emitNull(`gog tasks failed: ${e.message}`);
}
