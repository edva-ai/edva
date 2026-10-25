// context-guard.mjs — thresholds + the decision rule for the supervisor's
// context-size guard. Split out of index.mjs so the rule is
// importable without starting a supervisor (index.mjs is a CLI entrypoint and
// calls main() on import).
//
// WHY THE RULE IS SHAPED THIS WAY (it answers a measured cost runaway).
//
// A session's context FLOOR — the system prompt, the CLAUDE.md chain, and the
// MCP tool schemas — is re-sent verbatim on every turn, and no `/compact` can
// shrink it. Only the CONVERSATION above the floor is compactable. The original
// guard only asked "is context big?", which is the wrong question once the floor
// approaches the threshold: it fires on a near-empty session, recovers almost
// nothing, invalidates the prompt cache, and the next dispatch pays a full cold
// cache-write of the entire prefix.
//
// Measured over one overnight window of a few hundred dispatches:
//   cache-write 45% · cache-read 40% · output 13% · input 2%
// i.e. 85% of the budget bought context, not work. Floors were ops 149k,
// ops-light 151k, ops-haiku 110k — against a compact threshold of 150k. So
// ops-light was born ABOVE its own trigger; the guard fired ~90s into every
// fresh session, a representative compact recovered 6k (157448 → 151160), and
// the supervisor compacted every few minutes and rotated far more often than it
// needed to.
//
// So the guard now asks two questions, not one: "is context big" AND "is any of
// it mine to compact". Below MIN_COMPACTABLE_TOKENS of real conversation, the
// compact is a no-op that costs a cache invalidation, so we skip it.
//
// THE SKIP HAS NO FALLBACK, AND THAT IS THE RIGHT ANSWER — DO NOT "FIX" IT.
// This comment used to say the skip defers to the rotate threshold, "which at
// least genuinely resets the window". It does not, and cannot. The guard ticks
// only when the dispatcher is idle (see startContextGuard), and nothing raises
// ctx while it is idle — so a session parked in the DEAD ZONE
//   ctx in [COMPACT_THRESHOLD, ROTATE_THRESHOLD)  AND  ctx - floor < MIN_COMPACTABLE
// can never reach the rotate threshold on its own. It sits there re-emitting an
// identical skip every tick until real work arrives, and that work is what
// pushes it over. The band is non-empty for any session whose floor exceeds
// COMPACT_THRESHOLD - MIN_COMPACTABLE (145k today), and for a floor above
// ROTATE_THRESHOLD - MIN_COMPACTABLE (160k) the WHOLE band is dead: such a
// session can never compact at all.
//
// Measured over 7 days: five episodes, all on ops/ops-light,
// 196 minutes parked in total, the longest 141 min at ctx=182,785 / floor=167,472
// / compactable=15,313 — 2,215 tokens short of the rotate threshold. Every one
// ended when a dispatch arrived and pushed ctx past 185k.
//
// The tempting fix is to rotate on skip instead of parking. It LOSES MONEY.
// A rotate costs a cold cache-write of the whole prefix (a few tens of cents,
// counting the next dispatch's cold read); parking costs the excess cache-read
// on whatever work arrives, measured at ~47k extra tokens/turn (about a cent a
// turn on ops-light). Break-even is 23-35 turns, and the parked sessions did
// 2-11 turns before rotating anyway. The total measured excess across all five
// episodes came to pennies a day.
//
// So parking is correct, it is cheap, and the only thing wrong here was the
// comment claiming a mechanism that does not exist. The genuine remedy is
// unchanged and is stated below: cut the floor.
//
// The real fix is always to cut the floor (an always-loaded CLAUDE.md section,
// an MCP server a tier never calls, an always-on skill). Every token removed
// there is repaid on every dispatch, forever. The `cost-efficiency-review` job
// exists to watch exactly that number.

// ~85% of a 200k window → inject /compact. Raised from 150_000:
// at 150k it sat at or below the measured floor on two of three supervisors.
export const CONTEXT_COMPACT_THRESHOLD_TOKENS =
  Number(process.env.OPS_CONTEXT_COMPACT_TOKENS) || 170_000;

// ~92% of 200k → hard rotate (the fallback when a compact can't help).
export const CONTEXT_ROTATE_THRESHOLD_TOKENS =
  Number(process.env.OPS_CONTEXT_ROTATE_TOKENS) || 185_000;

// Minimum conversation above the floor before a /compact is worth its cache
// invalidation. See the header for how this number earns its keep.
export const MIN_COMPACTABLE_TOKENS =
  Number(process.env.OPS_MIN_COMPACTABLE_TOKENS) || 25_000;

// CRON-ONLY TIERS ROTATE INSTEAD OF COMPACTING. `allowCompact`
// is false for ops-light and ops-haiku (agents.json `compactOnContext: false`).
// Their jobs carry state in playbooks and state files, not in conversation
// history, so a /compact pays ~9.5k output tokens to summarize a conversation
// no later dispatch reads (hundreds of compacts a fortnight) —
// and the next dispatch pays a cold cache-write anyway. A plain rotation gets
// the same reset for only the cold write, and with the session handoff now
// model-free it costs no extra turn. ops keeps /compact: it carries Gmail
// threads across dispatches. The skip-compact dead-zone reasoning above is
// unchanged — when there is nothing to compact, we still park.

/**
 * The context-guard decision, as a pure function.
 *
 * @param {number} ctx   current measured context size (input + cache-read + cache-create)
 * @param {number} floor this session's measured floor, or 0 if not yet measured
 * @param {object} [opts] thresholds, plus `allowCompact` (false → "rotate" where
 *   the rule would otherwise compact)
 * @returns {"rotate"|"compact"|"skip-compact"|"none"}
 */
export function contextGuardDecision(ctx, floor, {
  compactThreshold = CONTEXT_COMPACT_THRESHOLD_TOKENS,
  rotateThreshold = CONTEXT_ROTATE_THRESHOLD_TOKENS,
  minCompactable = MIN_COMPACTABLE_TOKENS,
  allowCompact = true,
} = {}) {
  if (ctx >= rotateThreshold) return "rotate";
  if (ctx < compactThreshold) return "none";
  // An unmeasured floor (0) means a freshly rotated child that hasn't made a
  // usage-bearing call yet. Fall back to the plain threshold check rather than
  // guessing — guessing a floor there would be worse than the old behavior.
  if (floor > 0 && (ctx - floor) < minCompactable) return "skip-compact";
  return allowCompact ? "compact" : "rotate";
}

// ─── Chat: compact only when there is something to compact AND the user is idle ───
//
// Compact only when idle (a user rule). Measured over 14 days, the chat
// supervisor ran about one /compact per user message — each ~65s and a few
// dollars — and ~8% of messages queued 50–110s behind one. Two causes, and this rule answers both:
//
//   1. Timing. The guard ticks whenever the dispatcher is idle, which on chat is
//      the gap BETWEEN two user messages — the exact moment the next one is
//      most likely. A compact waits for IDLE_MS of conversational
//      silence, measured from the user's last message or the last reply to it.
//   2. Futility. The chat floor (system prompt + CLAUDE.md chain + tool schemas
//      + SessionStart bundle) measured 157k on a fresh session — ABOVE the 150k
//      compact trigger — so a compact had almost nothing to remove and the guard
//      re-fired on the next turn. The ops rule above (skip below
//      MIN_COMPACTABLE) applies to chat as well.
//
// Rotation still guards the 200k window (see the header at the top of
// chat-supervisor.mjs on why the session must stay under it). It also prefers
// idle, but past CHAT_ROTATE_HARD_TOKENS it runs at the next gap between turns
// regardless — a rotate is a few seconds, crossing 200k is not recoverable.
export const CHAT_COMPACT_THRESHOLD_TOKENS = 150_000;
// Rotate earlier than ops: one chat turn can add 15–40k (tool results), and a
// burst of messages under a purely idle-gated rule took a session from 185k
// to 199.9k before a gap long enough to rotate. 185k is the forced ceiling,
// checked at every gap between turns.
export const CHAT_ROTATE_THRESHOLD_TOKENS = 175_000;
export const CHAT_ROTATE_HARD_TOKENS = 185_000;
export const CHAT_IDLE_MS = Number(process.env.CHAT_CONTEXT_IDLE_MS) || 2 * 60_000;

/**
 * @param {object} p
 * @param {number} p.ctx      current context size
 * @param {number} p.floor    this session's measured floor, 0 if unmeasured
 * @param {number} p.idleMs   ms since the user's last message / the last reply to one
 * @returns {"rotate"|"compact"|"skip-compact"|"wait"|"none"}
 */
export function chatContextGuardDecision({
  ctx, floor = 0, idleMs = Infinity,
  compactThreshold = CHAT_COMPACT_THRESHOLD_TOKENS,
  rotateThreshold = CHAT_ROTATE_THRESHOLD_TOKENS,
  rotateHard = CHAT_ROTATE_HARD_TOKENS,
  minCompactable = MIN_COMPACTABLE_TOKENS,
  idleRequiredMs = CHAT_IDLE_MS,
} = {}) {
  const idle = idleMs >= idleRequiredMs;
  if (ctx >= rotateHard) return "rotate";
  if (ctx >= rotateThreshold) return idle ? "rotate" : "wait";
  if (ctx < compactThreshold) return "none";
  if (floor > 0 && (ctx - floor) < minCompactable) return "skip-compact";
  return idle ? "compact" : "wait";
}

// IDLE-COLD ROTATION. The prompt cache
// lives one hour. A session idle longer than that has no warm cache left, so
// the next dispatch re-writes its WHOLE context cold: the prefix plus every
// earlier job's conversation. Rotating while idle costs nothing extra (a
// rotation makes no model call, and the cache is gone either
// way), and the next dispatch then writes only the prefix plus the short
// handoff note. Measured over 14 days: ops and ops-light each resumed cold a
// couple of times a day, most of those carrying >= 20k stale tokens (mean ~40k);
// e.g. a nightly launch re-wrote ~163k tokens after hours idle to run one
// command. Under a dollar a day across the two tiers.
//
// This is NOT Claude Code's own idle compaction (switched off):
// that fires at ~54 min, while the cache is still warm, and spends a
// summarising turn. This fires only after the cache has expired and spends
// nothing. The default is 61 minutes (not 65): the idle clock
// starts at the session's last event, which comes after the last request that
// refreshed the cache, so one minute past the hour is already past the TTL.
// Measured over two weeks on ops + ops-light: all 10 resumes after 55-60
// idle minutes found the cache warm, 12 of 14 after 60-65 found it cold (the
// 65-minute bar let those through, about 1 in 6 of all cold resumes). It also ends a
// session parked in the dead zone above once it has sat idle that long. The
// idle clock is the child's last event of any kind, so a background-task wake
// (a turn with no dispatch in flight) resets it; a background task tracked as
// live defers the rotation, as every other rotate path here does.
// OPS_IDLE_COLD_ROTATE_MS=0 turns it off.
const idleColdEnv = process.env.OPS_IDLE_COLD_ROTATE_MS;
export const IDLE_COLD_ROTATE_MS =
  idleColdEnv === undefined || idleColdEnv === "" ? 61 * 60_000 : Number(idleColdEnv);

// Below this much conversation above the floor, a cold resume costs little
// more than a fresh session does, so the session is kept.
export const IDLE_COLD_MIN_STALE_TOKENS =
  Number(process.env.OPS_IDLE_COLD_MIN_STALE_TOKENS) || 20_000;

/**
 * Should an idle session be rotated because its prompt cache has expired?
 *
 * @param {number} ctx    current measured context size
 * @param {number} floor  this session's measured floor, or 0 if not yet measured
 * @param {number} idleMs ms since the session last showed any activity (a child
 *   event or a finished turn)
 * @param {object} [opts] `idleColdMs` (<= 0 disables) and `minStale`
 * @returns {boolean}
 */
export function idleColdRotate(ctx, floor, idleMs, {
  idleColdMs = IDLE_COLD_ROTATE_MS,
  minStale = IDLE_COLD_MIN_STALE_TOKENS,
} = {}) {
  if (!(idleColdMs > 0)) return false;       // switched off
  if (!(floor > 0)) return false;            // unmeasured: a fresh session has nothing stale
  if (!(idleMs >= idleColdMs)) return false; // the cache may still be warm
  return ctx - floor >= minStale;
}
