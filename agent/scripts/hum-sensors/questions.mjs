// questions — questions are waiting, and the question pool has room.
//
// The user's goal: clear the question queue. The question lanes (dream asks,
// hum asks, decision cards, re-asks) only reach the user when a hum tick runs,
// and since hum-sense took over, a tick runs only when something HAPPENS. A
// quiet morning at home produced almost none, so a 26-deep queue sat still
// while the 18-a-day question pool went unused.
//
// This sensor turns "questions are waiting and one could go now" into a tick.
// It reads only code-owned counts (lib/question-pacing.mjs): the lanes' backlog
// reports, the question pool's cap and spacing, and the pending-question slot.
// The event is `no_ramp`: the question pool is already the rate limiter for
// questions, so the gate's chattiness ramp does not stack on top of it (the
// question refractory (5 min), meetings and quiet hours still apply).
//
// One tick every WAIT_MIN while anything waits (the user, 2026-10-27: "make
// ticks 5 minutes apart unless the queue is empty"). A tick whose lanes have
// nothing they could send is skipped in code by the preview gate, and a lane
// rotates a held question behind the rest, so the next tick tries another.

import { event } from "./_common.mjs";
import { questionBacklog, checkQuestionBudget, questionSlotBusy } from "../../../lib/question-pacing.mjs";

export const meta = { name: "questions", lanes: ["dream_asks", "hum_asks", "decisions", "open_questions"] };

export const WAIT_MIN = 5;

export default async function detect(ctx) {
  const { config, local, nowMs, memo, setMemo } = ctx;
  // Overnight fires would only be dropped by the gate and count as misses.
  if (local && local.hour < (config.quiet_hours?.end ?? 9)) return [];

  const { total, lanes } = questionBacklog({ now: nowMs });
  if (!total) return [];
  if (questionSlotBusy({ now: nowMs })) return [];
  const budget = checkQuestionBudget({ now: new Date(nowMs) });
  if (!budget.ok) return [];

  const firedAt = memo?.fired_at ? Date.parse(memo.fired_at) : 0;
  if (firedAt && nowMs - firedAt < WAIT_MIN * 60000) return [];
  setMemo({ fired_at: new Date(nowMs).toISOString() });

  const waiting = Object.entries(lanes).filter(([, n]) => Number(n) > 0).map(([l]) => l);
  return [event("questions", "waiting", {
    subject: "queue",
    summary: `${total} question${total === 1 ? "" : "s"} waiting (${waiting.join(", ")})`,
    salience: 0.45,
    lanes: waiting,
    dedup_key: "questions:waiting",
    ttl_min: 15,
    cooldown_min: WAIT_MIN,
    no_ramp: true,
    data: { waiting: total, lanes, scale: budget.caps.scale },
  })];
}
