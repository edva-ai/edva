// comms — inbound mail pressure.
//
// Deliberately narrow. The email triage agent already owns "this specific email
// needs you"; hum's interest is one level up — a WAVE of mail arriving while the user
// was away is a situational fact ("you have a pile to get through") that pairs
// with the desk/return and calendar lanes.
//
// This is also the intended extension point for richer inbound triggers: a
// classifier that decides "this one email is a hum-worthy moment" only has to
// spool an event with the same shape, and nothing else in the framework changes.
//
// Reads a local log file. No network, no Gmail API.

import fs from "node:fs";
import path from "node:path";
import { event, EDVA } from "./_common.mjs";

export const meta = { name: "comms", lanes: ["email_followups", "tasks", "situation"] };

const TRIAGE_LOG = path.join(EDVA, "logs/triage.log");
const WAVE_THRESHOLD = 5;

export default async function detect(ctx) {
  const { memo, setMemo, nowMs } = ctx;
  let received = [];
  try {
    // Only the tail matters and the file rotates daily, so a bounded read is
    // always enough — never slurp an unbounded log on a 90-second interval.
    const raw = fs.readFileSync(TRIAGE_LOG, "utf8");
    received = raw.split("\n").filter((l) => l.includes("| EMAIL-RECEIVED")).slice(-400);
  } catch { return []; }

  const lastTs = memo?.last_ts || null;
  const fresh = received.filter((l) => {
    const ts = l.slice(0, 24);
    return lastTs ? ts > lastTs : false;
  });
  const newest = received.length ? received[received.length - 1].slice(0, 24) : lastTs;
  setMemo({ last_ts: newest });

  // First run just establishes the watermark — never fire on a cold start,
  // or a daemon restart would look like a mail wave every time.
  if (!lastTs || fresh.length < WAVE_THRESHOLD) return [];

  return [event("comms", "email_wave", {
    subject: `${fresh.length} emails`,
    summary: `${fresh.length} emails landed since the last check`,
    salience: Math.min(0.55, 0.3 + 0.03 * fresh.length),
    lanes: ["email_followups", "tasks", "situation"],
    dedup_key: `comms:email_wave:${new Date(nowMs).toISOString().slice(0, 13)}`,
    ttl_min: 30,
    cooldown_min: 120,
    data: { count: fresh.length },
  })];
}
