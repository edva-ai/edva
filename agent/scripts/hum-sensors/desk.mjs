// desk — is the user actually at the Mac, and did that just change?
//
// HID idle time is the cheapest high-quality attention signal on the machine:
// it distinguishes "typing right now" (a ping will be read in seconds) from
// "away for an hour" (a ping will be stale by the time it is seen). The edge
// that matters is the return: sitting back down after a long absence is a
// natural moment for "here's what happened while you were out".
//
// One `ioreg` call, ~15ms.

import { event, sh, localConfig } from "./_common.mjs";

// The lanes a desk return wakes; an instance adds its own lanes in
// agent/local/config/hum-lanes.json (`desk_lanes`, `desk_return_lanes`).
const LANES = localConfig("hum-lanes", {
  desk_lanes: ["situation", "tasks", "watchdog"],
  desk_return_lanes: ["situation", "tasks", "watchdog"],
});

export const meta = { name: "desk", lanes: LANES.desk_lanes };

const AWAY_MIN = 25;       // idle beyond this counts as away
const LONG_AWAY_MIN = 60;  // a return only counts as an event after this long

export default async function detect(ctx) {
  const { memo, setMemo } = ctx;
  const raw = await sh("/bin/sh", ["-c", "ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}'"], { timeout: 6000 });
  const ns = parseInt(raw, 10);
  if (!Number.isFinite(ns)) return [];
  const idleMin = ns / 1e9 / 60;
  const away = idleMin >= AWAY_MIN;
  const out = [];

  // ── back at the desk after a long absence ──
  if (memo?.away === true && !away && (memo.peak_idle_min ?? 0) >= LONG_AWAY_MIN) {
    out.push(event("desk", "returned", {
      subject: "back at the Mac",
      summary: `Back at the Mac after ${Math.round(memo.peak_idle_min)}m away`,
      salience: 0.5,
      lanes: LANES.desk_return_lanes,
      dedup_key: `desk:returned:${new Date().toISOString().slice(0, 13)}`,
      ttl_min: 15,
      cooldown_min: 90,
      data: { away_min: Math.round(memo.peak_idle_min) },
    }));
  }

  setMemo({
    away,
    // Track the deepest idle of the current absence so the return event can
    // report how long the user was gone; reset once back.
    peak_idle_min: away ? Math.max(memo?.peak_idle_min ?? 0, idleMin) : 0,
    idle_min: Math.round(idleMin),
  });
  return out;
}
