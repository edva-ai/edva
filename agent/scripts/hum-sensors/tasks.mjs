// tasks — the moment a commitment changes state.
//
// "You have 4 overdue tasks" is a standing fact and belongs to the harvester.
// "One just went overdue" is an event. Only the transition is emitted here.

import { event, sh, GOG_ACCOUNT } from "./_common.mjs";

export const meta = { name: "tasks", lanes: ["tasks", "situation"] };

export default async function detect(ctx) {
  const { memo, setMemo, local } = ctx;
  const plain = await sh("/opt/homebrew/bin/gog",
    ["tasks", "list", "@default", "--plain", ...(GOG_ACCOUNT ? ["-a", GOG_ACCOUNT] : [])], { timeout: 12000 });
  // Same reasoning as the calendar sensor: `gog tasks` prints something even
  // for an empty list, so empty output means the probe failed rather than
  // "no tasks". Surface it instead of going quietly blind.
  if (!plain) throw new Error("gog tasks returned nothing (auth or network?)");

  const today = local.date;
  let overdue = 0, dueToday = 0;
  for (const line of plain.split("\n")) {
    if (!line || line.includes("completed")) continue;
    const m = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    if (m[1] < today) overdue++;
    else if (m[1] === today) dueToday++;
  }

  const out = [];
  // Cold start (memo empty) establishes the baseline silently — a daemon
  // restart must never look like four tasks going overdue at once.
  if (memo?.overdue !== undefined && overdue > memo.overdue) {
    out.push(event("tasks", "newly_overdue", {
      subject: `${overdue} overdue`,
      summary: `${overdue - memo.overdue} task${overdue - memo.overdue === 1 ? "" : "s"} just went overdue (${overdue} total)`,
      salience: overdue >= 4 ? 0.6 : 0.48,
      lanes: ["tasks", "situation"],
      dedup_key: `tasks:overdue:${today}:${overdue}`,
      ttl_min: 90,
      cooldown_min: 180,
      data: { overdue, due_today: dueToday, delta: overdue - memo.overdue },
    }));
  }

  setMemo({ overdue, due_today: dueToday, date: today });
  return out;
}
