// dispatcher.mjs — serialized dispatch queue over ClaudeSession.
// Guarantees: one turn at a time. Messages queued behind in-flight work.
// Each enqueued message gets {id, source, content, enqueuedAt}.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { isPhantomResult } from "../lib/phantom-result.mjs";
import { recordAttempt, reclassifyMessageId, WINDOW_MS as ATTEMPT_WINDOW_MS } from "../../lib/dispatch-attempts.mjs";
import { createRequire } from "node:module";

// The operator's name for agent-facing text (lib/instance.cjs).
const OWNER_NAME = createRequire(import.meta.url)("../../lib/instance.cjs").instance().owner_name;

// Reclassify-flap threshold (ops-agent/CLAUDE.md § Reclassify-flap detection).
// The dispatcher COUNTS; the agent only acts on the count it is handed.
export const RECLASSIFY_FLAP_THRESHOLD = 3;

/**
 * Count a RECLASSIFY dispatch and, once the same messageId has been
 * reclassified RECLASSIFY_FLAP_THRESHOLD times inside the window, append the
 * count to the task so the agent follows the flap procedure instead of
 * re-deriving. Returns the (possibly annotated) content. Fail-soft.
 */
export function annotateReclassify(content, deps = {}) {
  try {
    const id = reclassifyMessageId(content);
    if (!id) return content;
    const n = (deps.recordAttempt || recordAttempt)(id, "reclassify");
    if (n < RECLASSIFY_FLAP_THRESHOLD) return content;
    return `${content}\n\n[supervisor] FLAP: this messageId has had ${n} RECLASSIFY dispatches in the last ${Math.round(ATTEMPT_WINDOW_MS / 60000)} min (counted by the supervisor in reclassify-tracking.json — do not append attempts yourself). Follow ops-agent/CLAUDE.md § Reclassify-flap detection: do not re-derive; set phantom_skip and ask ${OWNER_NAME} which priority they want.`;
  } catch { return content; }
}

// Compact-race guard. A context-guard `/compact` dispatch and the
// very next real dispatch are correctly serialized at this layer (inFlight
// gates send()) — but claude -p's CLI still folds the compact's own
// local-command echo into the *content* of whatever turn follows it with zero
// delay, because that's how it represents a slash command with no
// conversational reply of its own (there's nothing else to attach the
// "Compacted" confirmation to). If that echo happens to read as adversarial —
// stale/garbled text surfaced by the compaction summary itself — the very next
// dispatched turn can spend its one turn refusing what looks like an embedded
// instruction, correctly per prompt-injection policy, and never touch the
// job it was actually sent to run. Confirmed live: a cron dispatch landed in
// ~2s/1 turn right next to a /compact and never called the API it existed to
// call, so a calendar sync sat stale for over a day with zero error anywhere
// (dispatcher.dispatching/turn_complete both looked like a normal, if oddly
// short, successful run). The sessionNotFound guard below covers a different
// mechanism with the same shape — this is the second class of "turn nominally
// completed but the job never ran."
//
// Mitigation is two-layered:
//   1. Prevention: delay draining the next item for POST_COMPACT_DRAIN_DELAY_MS
//      after a context-guard turn completes, instead of draining in the same
//      tick — gives the child time to settle its post-compact state before
//      the next real content arrives.
//   2. Safety net: if a turn immediately following a compact (within
//      COMPACT_ADJACENCY_WINDOW_MS) still finishes suspiciously fast/cheap
//      (real cost was billed — this is not the sessionNotFound/phantom-result
//      zero-cost case — but very low turns/duration relative to the generous
//      floor below), don't trust it as "done": requeue it once. A second
//      suspect result for the SAME item is no longer a timing fluke, so it's
//      let through as completed (the queue must not wedge) but flagged loudly
//      via a distinct event so the supervisor can page the user.
// Both knobs are env-overridable for tuning without a code change.
const COMPACT_ADJACENCY_WINDOW_MS   = Number(process.env.DISPATCHER_COMPACT_ADJACENCY_MS) || 5_000;
const COMPACT_RACE_MAX_TURNS        = Number(process.env.DISPATCHER_COMPACT_RACE_MAX_TURNS) || 1;
const COMPACT_RACE_MAX_DURATION_MS  = Number(process.env.DISPATCHER_COMPACT_RACE_MAX_DURATION_MS) || 10_000;
const POST_COMPACT_DRAIN_DELAY_MS   = Number(process.env.DISPATCHER_POST_COMPACT_DRAIN_DELAY_MS) || 3_000;

// Quota-refusal guard. When the Max allowance is used up,
// claude -p answers every turn in well under a second without doing anything:
// the stream carries a rate_limit_event with status "rejected" ~3ms before an
// ordinary-looking result (turns=1, no new cost). Marking that turn done
// records dozens of dispatches as finished work that never ran (Gmail triages,
// every-15-min jobs, digests...) over one outage, and nothing tells anyone.
//
// So a refused turn is put back at the head of the queue and dispatch holds
// until the window the event names resets (+1 min). Only the FIRST refused
// turn of an outage reliably carries the event — later ones in the same
// outage often arrive with no rate_limit_event at all — which is exactly why
// the response is to stop dispatching rather than to inspect each result.
//
// The hold is separate from `paused` (the Max-auth outage switch): auth
// recovery must not release a quota hold, and the hold must not clear an auth
// pause. A rejection while overage is actually in use is NOT a refusal — the
// turn runs on overage, so it completes normally.
const RATE_LIMIT_RESUME_GRACE_MS    = 60_000;
const RATE_LIMIT_FALLBACK_HOLD_MS   = Number(process.env.DISPATCHER_RATE_LIMIT_FALLBACK_HOLD_MS) || 15 * 60_000;
const RATE_LIMIT_MAX_HOLD_MS        = 8 * 86_400_000;
// The reset a refusal names is when the window is due back, not a promise that
// it stays shut until then: an allowance can come back early, and a hold that
// trusts the named reset keeps every job dark with the allowance available. So
// no single hold runs longer than this. When a capped hold runs out, the next
// real job is the probe (see the refusal guard below): refused again, it goes
// back to the head of the queue and the hold re-arms (a refused turn bills
// nothing); served, dispatch resumes. Shared by the chat supervisor.
export const RATE_LIMIT_REPROBE_MS  = Number(process.env.DISPATCHER_RATE_LIMIT_REPROBE_MS) || 60 * 60_000;

/** True when a rate_limit_info means this turn was refused, not merely warned. */
export function isQuotaRefusal(info) {
  return !!info && info.status === "rejected" && !info.isUsingOverage && !info.overageInUse;
}

/**
 * A turn that never got past its first call and billed nothing — how a refusal
 * ends when the CLI does not announce it. The reason string has changed across
 * CLI versions ("completed", "blocking_limit", "api_error"), so the
 * version-proof signal is the cost: total_cost_usd is cumulative per CLI
 * process and stays flat on a refused turn (identical across a whole run of
 * refusals). With no earlier result to compare against (a fresh process), a
 * refused turn reports 0.
 * The cost test needs exactly one turn: every refusal on record reports
 * num_turns 1, while a /compact reports 0 and often comes back as an instant
 * no-op with a flat total, which must never read as a refusal. Only ever asked about the first turn after a hold.
 */
export function isSilentRefusal(ev, prevCost = null) {
  if (!ev || (ev.num_turns || 0) > 1) return false;
  if (ev.terminal_reason === "api_error" || ev.terminal_reason === "blocking_limit") return true;
  if ((ev.num_turns || 0) !== 1) return false;
  const cost = Number(ev.total_cost_usd);
  if (!Number.isFinite(cost)) return false;
  return prevCost == null ? cost === 0 : cost <= prevCost;
}

/**
 * When dispatch may resume after a refusal: the named window's reset plus a
 * minute's grace. Some rejections carry no resetsAt; those retry
 * after a fallback interval, and the next refused turn re-holds.
 */
export function rateLimitHoldUntil(info, now = Date.now(), fallbackMs = RATE_LIMIT_FALLBACK_HOLD_MS) {
  const resetMs = Number(info?.resetsAt) * 1000;
  if (Number.isFinite(resetMs) && resetMs > now) {
    return Math.min(resetMs + RATE_LIMIT_RESUME_GRACE_MS, now + RATE_LIMIT_MAX_HOLD_MS);
  }
  return now + fallbackMs;
}

// Live email triage should preempt background/cron work waiting in the queue —
// otherwise an inbound email sits behind a 10-minute background job during the
// morning cron batch (an unread pile-up). Identified by source
// (Gmail push `gmail:<historyId>`, inbound email) or a RECLASSIFY catch-up task
// (watchdog re-triage of stuck unread). This only reorders the QUEUE; it never
// preempts the in-flight turn (a running turn can't be interrupted safely).
export function isHighPriority(source, content) {
  return (
    (typeof source === "string" && (source.startsWith("gmail:") || source === "email-inbound")) ||
    // A perishable hum moment — an arrival, a departure. Same argument as live
    // email triage, only sharper: the value of "here is what is around you"
    // decays to nothing within a few minutes, so waiting behind a ten-minute
    // cron job doesn't delay the ping, it destroys it. Ordinary cadence/idle
    // hum ticks stay `hum` and stay in line. (In line, arrivals can fail to
    // become a turn at all, or start twenty minutes late.)
    (typeof source === "string" && source.startsWith("hum:")) ||
    (typeof content === "string" && content.startsWith("RECLASSIFY:"))
  );
}

/** Every hum-originated source: the plain cadence tick and the `hum:<class>` moments. */
export function isHumSource(source) {
  return typeof source === "string" && (source === "hum" || source.startsWith("hum:"));
}

export class Dispatcher extends EventEmitter {
  constructor(session, options = {}) {
    super();
    this.session = session;
    // Optional persistence hook — called after every state-changing operation
    // (dispatch, drain shift, turn complete, requeue, error). The supervisor
    // wires this to a QueuePersist so a whole-process restart can replay
    // queued/inFlight work. Default no-op keeps the dispatcher useful in
    // tests and any caller that doesn't care about durability.
    this.persist = options.persist || (() => {});
    // Optional per-turn preamble hook — called at SEND time with the item about
    // to be dispatched; returns a short string prepended to the message content
    // the child receives (live dynamic state: time, etc.). Prepended at send,
    // NOT at enqueue, so the stored item.content stays clean — dedup keys,
    // persistence, and event-log records are unaffected. Default: no preamble.
    this.preamble = options.preamble || (() => null);
    this.queue = [];
    this.inFlight = null;
    this.completed = 0;
    // When true, _drain stops dispatching. Used during auth outages so the
    // queue doesn't burn through 401-returning turns. Cleared when the
    // supervisor detects creds refresh.
    this.paused = false;
    // Compact-race guard state — see the module comment above. Overridable so
    // tests can run with zero delay instead of real timers.
    this.lastContextGuardCompleteAt = 0;
    this.postCompactDrainDelayMs = options.postCompactDrainDelayMs ?? POST_COMPACT_DRAIN_DELAY_MS;
    // Quota-refusal hold — see isQuotaRefusal above. holdUntil is an epoch-ms
    // deadline (0 = no hold); _refusal remembers which in-flight item the
    // rejection arrived during, so it is only ever charged to that turn.
    this.holdUntil = 0;
    this._holdTimer = null;
    this._refusal = null;
    this._probing = false;   // true from a hold's release until the next real result
    this._lastCost = null;   // last result's cumulative total_cost_usd (this CLI process)
    this.rateLimitFallbackHoldMs = options.rateLimitFallbackHoldMs ?? RATE_LIMIT_FALLBACK_HOLD_MS;
    this.rateLimitReprobeMs = options.rateLimitReprobeMs ?? RATE_LIMIT_REPROBE_MS;
    // The last refusal that named its window. A silent refusal on a probe
    // (no event, see isSilentRefusal) re-holds against that window's reset
    // rather than the short fallback, while that reset is still ahead.
    this._lastRefusalInfo = null;

    session.on("rate_limit", (ev) => {
      const info = ev?.rate_limit_info;
      if (this.inFlight && isQuotaRefusal(info)) this._refusal = { itemId: this.inFlight.id, info };
    });

    session.on("result", (ev) => {
      const done = this.inFlight;
      // Resume-failure guard: `claude -p --resume <id>` for a session claude
      // never persisted emits a turns=0 result ("No conversation found with
      // session ID") right before the child exits code=1. That is NOT a
      // completed turn — the dispatch never ran. Marking it done here drops it:
      // by the time session.on("exit") → requeueInFlight() runs, inFlight is
      // already null, so the job is lost silently (e.g. a cron dispatched into a
      // turn-count rotation whose fresh session id was SIGKILLed before it flushed,
      // leaving the calendar it syncs stale). Re-queue instead, and DON'T drain — the
      // session is invalid; restart() will force a fresh one and transfer the
      // queue to it. Gated on sessionNotFound (set from stderr ~2ms before this
      // result) so legitimate turns=0 results (/compact, context-guard) are
      // unaffected. The stderr line reliably precedes the result in practice.
      if (done && session.sessionNotFound && (ev.num_turns || 0) === 0) {
        this._refusal = null;   // the item re-runs; a stale refusal must not follow it
        this.inFlight = null;
        this.queue.unshift(done);
        this.persist();
        this.emit("requeued", done);
        return;
      }
      // Resume-handshake guard: after a turn-watchdog SIGKILL, the respawned
      // `--resume` child emits a zero-work result closing out the killed turn
      // ~2s after we've already dispatched the retry into it. Attributing that
      // to the retry silently un-tracks the job — which is why hang recovery
      // never actually recovered. Leave inFlight alone: the real turn IS
      // running, the watchdog should stay armed, and the genuine result lands
      // later. Full rationale + the cost discriminator: lib/phantom-result.mjs.
      if (done && isPhantomResult(ev)) {
        this.emit("phantom_result", { item: done, result: ev });
        return;   // not this turn's result — any pending refusal waits for the real one
      }
      // Quota-refusal guard — see the module comment. Either the CLI said so
      // (a rejected rate_limit_event during this turn), or this is the first
      // turn after a hold and it failed the same way without saying so: the
      // CLI emits the event once per process, and the 15-minute retry after a
      // hold with no reset time lands in that same process (one event can be
      // followed by many silent refusals). See isSilentRefusal for how one is
      // recognised. Outside that probe nothing here second-guesses a result.
      const refusal = this._refusal;
      this._refusal = null;
      // A context-guard /compact proves nothing about the limit either way, so
      // only a real job's result settles the probe.
      const probe = this._probing && !!done && done.source !== "context-guard";
      if (probe) this._probing = false;
      const prevCost = this._lastCost;
      if (Number.isFinite(Number(ev?.total_cost_usd))) this._lastCost = Number(ev.total_cost_usd);
      const refused = done && ((refusal && refusal.itemId === done.id) || (probe && isSilentRefusal(ev, prevCost)));
      if (probe && !refused) this._lastRefusalInfo = null;
      if (refused) {
        if (refusal?.info) this._lastRefusalInfo = refusal.info;
        const last = this._lastRefusalInfo;
        const info = refusal?.info || (Number(last?.resetsAt) * 1000 > Date.now() ? { ...last, inferred: true } : null) || { status: "rejected", inferred: true };
        const until = rateLimitHoldUntil(info, Date.now(), this.rateLimitFallbackHoldMs);
        this.hold(until);
        if ((ev.num_turns || 0) <= 1) {
          this.inFlight = null;
          this.queue.unshift(done);
          this.persist();
          this.emit("rate_limited", { item: done, info, until, result: ev, requeued: true });
          return;
        }
        // The limit landed partway through a turn that had already done work
        // (tool calls ran). Re-running it after the reset could repeat what it
        // already did (a sent email, a filed label), so it completes as it
        // always has; only the hold applies.
        this.emit("rate_limited", { item: done, info, until, result: ev, requeued: false });
      }
      // Compact-race guard — see module comment. Only ever considers items
      // that aren't themselves the /compact turn, and only within a tight
      // window right after one completed. Real cost must have been billed
      // (rules out the zero-cost sessionNotFound/phantom-result cases above,
      // which are already handled and mean something different).
      if (
        done &&
        done.source !== "context-guard" &&
        this.lastContextGuardCompleteAt &&
        Date.now() - this.lastContextGuardCompleteAt <= COMPACT_ADJACENCY_WINDOW_MS &&
        !ev.is_error &&
        (ev.total_cost_usd || 0) > 0 &&
        (ev.num_turns || 0) <= COMPACT_RACE_MAX_TURNS &&
        (ev.duration_ms || 0) <= COMPACT_RACE_MAX_DURATION_MS
      ) {
        const retryCount = (done.compactRaceRetryCount = (done.compactRaceRetryCount || 0) + 1);
        if (retryCount === 1) {
          this.inFlight = null;
          this.queue.unshift(done);
          this.persist();
          this.emit("compact_race_requeue", { item: done, result: ev });
          setTimeout(() => this._drain(), this.postCompactDrainDelayMs);
          return;
        }
        // Exhausted the one retry — the same item raced twice, which is no
        // longer a timing fluke. Let it stand (don't loop the queue forever)
        // but flag it loudly so a human looks at whether the job actually ran.
        this.emit("compact_race_exhausted", { item: done, result: ev });
      }
      this.inFlight = null;
      this.persist();
      this.completed++;
      if (done && done.source === "context-guard") this.lastContextGuardCompleteAt = Date.now();
      this.emit("turn_complete", { message: done, result: ev });
      if (done && done.source === "context-guard") {
        // Give the child a moment to settle its post-compact state before the
        // next real dispatch lands right behind it — see module comment.
        setTimeout(() => this._drain(), this.postCompactDrainDelayMs);
      } else {
        this._drain();
      }
    });
  }

  dispatch(content, source = "unknown") {
    // During a quota hold nothing drains, so a cron job that fires every 15
    // minutes would otherwise stack up ~150 identical copies over a weekly
    // reset and run them back to back when it lifts. While held, a dispatch
    // identical (same source, same text) to one already waiting joins it.
    if (this.isHeld()) {
      const waiting = this.queue.find((q) => q.source === source && (q.rawContent ?? q.content) === content);
      if (waiting) {
        this.emit("coalesced", { source, content, held: true });
        return waiting.id;
      }
    }
    // Coalesce duplicate RECLASSIFY catch-ups. The watchdog re-dispatches one
    // RECLASSIFY per still-unread email every 2 min; without dedup they pile up
    // far faster than they drain (dozens of copies for a dozen emails). If an identical RECLASSIFY is already in-flight or queued, drop
    // this one and return the existing item's id (mirrors the hum coalescing in
    // http-server.mjs, but at the dispatcher so it covers every source).
    let rawContent;
    if (typeof content === "string" && content.startsWith("RECLASSIFY:")) {
      const raw = (q) => q.rawContent ?? q.content;
      if (this.inFlight && raw(this.inFlight) === content) {
        this.emit("coalesced", { source, content });
        return this.inFlight.id;
      }
      const existing = this.queue.find((q) => raw(q) === content);
      if (existing) {
        this.emit("coalesced", { source, content });
        return existing.id;
      }
      // Coalesced copies are not new attempts; only an enqueued one is counted.
      rawContent = content;
      content = annotateReclassify(content);
    }
    const item = { id: randomUUID(), source, content, enqueuedAt: Date.now() };
    if (rawContent !== undefined && rawContent !== content) item.rawContent = rawContent;
    if (isHighPriority(source, content)) {
      // Insert ahead of the first normal (non-high-priority) queued item, after
      // any already-queued high-priority items (FIFO among peers). The in-flight
      // turn is untouched — this just lets triage skip the cron backlog.
      const idx = this.queue.findIndex((q) => !isHighPriority(q.source, q.content));
      if (idx === -1) this.queue.push(item);
      else this.queue.splice(idx, 0, item);
    } else {
      this.queue.push(item);
    }
    this.persist();
    this.emit("enqueued", item);
    this._drain();
    return item.id;
  }

  /**
   * Move an already-queued item into the high-priority region of the queue.
   *
   * Needed because urgency can arrive AFTER the item does: a hum turn queues as
   * ordinary cadence work, and then an arrival lands and folds into it. Without
   * this the promoted item keeps its original place behind the cron backlog and
   * the promotion means nothing. No-op if the item is in-flight or gone — a
   * running turn is never reordered.
   */
  promote(id) {
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx === -1) return false;
    const [item] = this.queue.splice(idx, 1);
    const at = this.queue.findIndex((q) => !isHighPriority(q.source, q.content));
    if (at === -1) this.queue.push(item);
    else this.queue.splice(at, 0, item);
    this.persist();
    return true;
  }

  _drain() {
    if (this.inFlight) return;
    if (this.paused) return;
    if (this.isHeld()) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.persist();
    this.emit("dispatching", next);
    try {
      // Prepend the live-state preamble at send time only (item.content stays
      // clean). Fail-soft: a throwing/empty preamble sends the bare content.
      let content = next.content;
      try {
        const pre = this.preamble(next);
        if (pre) content = pre + content;
      } catch { /* preamble is best-effort — never block a dispatch */ }
      this.session.send(content);
    } catch (err) {
      // Session went away between shift() and send(). Put the item back at
      // the head so it isn't lost — the supervisor's exit handler will
      // restart and re-drain. The previous "drop and rely on log recovery"
      // comment was a bug: nothing actually replays dropped items.
      this.emit("dispatch_error", { item: next, error: err.message });
      this.queue.unshift(next);
      this.inFlight = null;
      this.persist();
    }
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (!this.paused) this._drain();
  }

  isHeld(now = Date.now()) {
    return this.holdUntil > now;
  }

  // Hold dispatch until `until` (epoch ms), but never longer than
  // rateLimitReprobeMs at a stretch (see RATE_LIMIT_REPROBE_MS), then drain.
  // Extends, never shortens, an existing hold. Also used by the supervisor to
  // carry a hold onto the replacement dispatcher after a restart.
  hold(until) {
    const capped = Math.min(until, Date.now() + this.rateLimitReprobeMs);
    if (!(capped > Date.now()) || capped <= this.holdUntil) return;
    this.holdUntil = capped;
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(() => this.releaseHold(), capped - Date.now());
    this._holdTimer.unref?.();
  }

  releaseHold() {
    clearTimeout(this._holdTimer);
    this._holdTimer = null;
    if (!this.holdUntil) return;
    this.holdUntil = 0;
    this._probing = true;
    if (this.disposed) return;
    this.emit("hold_released");
    this._drain();
  }

  // Called on the dispatcher being replaced (supervisor restart). Its queue is
  // copied, not moved, to the new one, so a hold timer firing here later must
  // not drain those copies into a dead session.
  dispose() {
    this.disposed = true;
    clearTimeout(this._holdTimer);
    this._holdTimer = null;
  }

  // Re-queue the in-flight item at the head (called when session dies mid-turn).
  requeueInFlight() {
    if (!this.inFlight) return null;
    const item = this.inFlight;
    this.inFlight = null;
    this.queue.unshift(item);
    this.persist();
    this.emit("requeued", item);
    return item;
  }

  // Restore state from a persisted snapshot. Called once at supervisor boot
  // before any dispatches happen. The previous inFlight (if any) is moved
  // to the head of the queue — that turn never completed, so it must re-run.
  restore(persisted) {
    if (!persisted) return;
    this.queue = [...(persisted.queue || [])];
    if (persisted.inFlight) this.queue.unshift(persisted.inFlight);
    this.inFlight = null;
    // Re-save the consolidated state so a crash before the first dispatch
    // doesn't replay the old inFlight again (and duplicate it at the head).
    this.persist();
  }

  snapshot() {
    return {
      queueDepth: this.queue.length,
      inFlight: this.inFlight ? { id: this.inFlight.id, source: this.inFlight.source, enqueuedAt: this.inFlight.enqueuedAt } : null,
      completed: this.completed,
      holdUntil: this.isHeld() ? this.holdUntil : null,
    };
  }
}
