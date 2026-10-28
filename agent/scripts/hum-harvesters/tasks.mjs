#!/usr/bin/env node
// Tasks lane: ONE candidate per tick, for the single best open task that is due
// or overdue and not in its 3-day cooldown. dedup_key is the task id, so it
// does not change when other tasks move in or out of the overdue count.
import { execFileSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun, readTopicState, writeTopicState, GOG_ACCOUNT } from "./_common.mjs";

const COOLDOWN_MS = 3 * 24 * 3600 * 1000;
const P1_MARKER = "[edva-p1";

await readStdinJson();

try {
  const args = ["tasks", "list", "@default", "-j", ...(GOG_ACCOUNT ? ["-a", GOG_ACCOUNT] : [])];
  const out = execFileSync("/opt/homebrew/bin/gog", args, { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  const tasks = (JSON.parse(out).tasks || []).filter((t) => t && t.id && t.status !== "completed" && t.due);

  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  // Cooldown ledger: task id -> ISO of last emit; entries older than 3 days are pruned.
  const prev = readTopicState("tasks").emitted || {};
  const emitted = {};
  for (const [id, at] of Object.entries(prev)) {
    if (now - new Date(at).getTime() < COOLDOWN_MS) emitted[id] = at;
  }

  const ranked = [];
  let overdueN = 0, dueTodayN = 0;
  for (const t of tasks) {
    const day = String(t.due).slice(0, 10);
    if (day > today) continue;
    const isOverdue = day < today;
    if (isOverdue) overdueN++; else dueTodayN++;
    const p1 = String(t.notes || "").includes(P1_MARKER);
    // Google Tasks due values are date-only (midnight UTC); a non-midnight time is a real due time.
    const hasTime = !/T00:00:00(\.0+)?Z$/.test(String(t.due));
    let urgency;
    if (p1 || (!isOverdue && hasTime)) urgency = 0.7;
    else urgency = isOverdue ? 0.35 : 0.4;
    ranked.push({ t, day, isOverdue, p1, hasTime, urgency });
  }

  if (ranked.length === 0) { stampRun("tasks", false); writeTopicState("tasks", { emitted }); emitNull("no due"); process.exit(0); }

  const pick = ranked
    .filter((r) => !emitted[r.t.id])
    .sort((a, b) => b.urgency - a.urgency || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0];

  if (!pick) { stampRun("tasks", false); writeTopicState("tasks", { emitted }); emitNull("all due tasks in cooldown"); process.exit(0); }

  emitted[pick.t.id] = new Date().toISOString();
  writeTopicState("tasks", { emitted });
  stampRun("tasks", true);
  emit({
    topic: "tasks",
    signal: `${pick.isOverdue ? "Overdue" : "Due today"}: ${String(pick.t.title || "").slice(0, 200)}`,
    urgency: pick.urgency,
    freshness_min: 0,
    dedup_key: `tasks:${pick.t.id}`,
    supporting_data: {
      task_id: pick.t.id,
      title: pick.t.title,
      due: pick.t.due,
      overdue: pick.isOverdue,
      p1_linked: pick.p1,
      other_due_count: ranked.length - 1,
      overdue_total: overdueN,
      due_today_total: dueTodayN,
    },
  });
} catch (e) {
  emitNull(`gog tasks failed: ${e.message}`);
}
