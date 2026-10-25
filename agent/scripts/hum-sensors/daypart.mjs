// daypart — the clock, but only where the clock is genuinely situational.
//
// Not a tick. This fires once, on the crossing of a boundary that changes what
// a useful suggestion looks like: the day starting, a meal window opening, the
// work day ending. Everything in between is silence — the whole point of the
// rewrite is that "it is now 14:40" is not an event.
//
// Zero I/O, so it is free to run on every daemon tick.

import { event, edge, localConfig } from "./_common.mjs";

// An instance can name its own lanes for the sensor and for a boundary
// (agent/local/config/hum-lanes.json `daypart_lanes`,
// `daypart_boundary_lanes: { <key>: [...] }`, each replacing the default).
const LANES = localConfig("hum-lanes", { daypart_lanes: ["situation", "dining", "exercise", "tasks"], daypart_boundary_lanes: {} });
const lanesFor = (key, dflt) => LANES.daypart_boundary_lanes[key] || dflt;

export const meta = {
  name: "daypart",
  lanes: LANES.daypart_lanes,
};

// minutes-of-day → boundary. A boundary fires when the local clock first
// crosses it on a given day; `memo` remembers which ones today already used.
const BOUNDARIES = [
  { key: "day_start",   at: 9 * 60,        salience: 0.42, lanes: ["situation", "tasks", "weather", "calendar"], summary: "Day starting" },
  { key: "midmorning",  at: 10 * 60 + 45,  salience: 0.30, lanes: ["situation", "tasks"],                        summary: "Mid-morning" },
  { key: "lunch",       at: 12 * 60 + 15,  salience: 0.52, lanes: lanesFor("lunch", ["dining", "situation"]), summary: "Lunch window open" },
  { key: "afternoon",   at: 15 * 60,       salience: 0.32, lanes: ["situation", "tasks", "ideas"],               summary: "Afternoon" },
  { key: "day_end",     at: 18 * 60,       salience: 0.45, lanes: ["situation", "ideas", "watchlist", "family"], summary: "Work day winding down" },
  { key: "dinner",      at: 19 * 60,       salience: 0.44, lanes: lanesFor("dinner", ["dining", "watchlist"]), summary: "Dinner window open" },
  { key: "evening",     at: 21 * 60,       salience: 0.34, lanes: ["watchlist", "screen", "music"],              summary: "Evening" },
];

// Friday afternoon is its own kind of boundary — the weekend becomes plannable.
const WEEKEND_OPEN = { key: "weekend_open", at: 16 * 60, salience: 0.5, lanes: ["ideas", "experiences", "travel", "dining"], summary: "Weekend opening up" };

export default async function detect(ctx) {
  const { local, memo, setMemo } = ctx;
  const fired = memo?.date === local.date ? (memo.fired || []) : [];
  const candidates = local.weekday === "fri" ? [...BOUNDARIES, WEEKEND_OPEN] : BOUNDARIES;

  const out = [];
  const nowFired = [...fired];
  for (const b of candidates) {
    if (fired.includes(b.key)) continue;
    if (local.minutes_of_day < b.at) continue;
    // Don't retro-fire a boundary the daemon slept through by more than an
    // hour — a "lunch window open" event at 16:00 is noise, not a moment.
    if (local.minutes_of_day - b.at > 60) { nowFired.push(b.key); continue; }
    nowFired.push(b.key);
    out.push(event("daypart", b.key, {
      subject: b.key,
      summary: b.summary,
      salience: b.salience,
      lanes: b.lanes,
      dedup_key: `daypart:${b.key}:${local.date}`,
      ttl_min: 45,
      cooldown_min: 12 * 60,
      data: { date: local.date, weekday: local.weekday, local_time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}` },
    }));
  }
  void edge;
  setMemo({ date: local.date, fired: nowFired });
  return out;
}
