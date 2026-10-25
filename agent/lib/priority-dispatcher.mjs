// priority-dispatcher.mjs — dispatch queue with priority levels and interruption.
//
// Three priority levels: high (0), normal (1), low (2).
// High-priority items go to front of queue. Within same priority, FIFO order.
// Emits "interrupt_requested" when a high-priority item arrives and the
// in-flight turn has been running > INTERRUPT_THRESHOLD_MS on a lower-priority task.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { isPhantomResult } from "./phantom-result.mjs";

const PRIORITY = { high: 0, normal: 1, low: 2 };
const INTERRUPT_THRESHOLD_MS = 30_000;

export class PriorityDispatcher extends EventEmitter {
  // `session` is always the turn-complete source of truth — its "result" event
  // is what drains the queue, regardless of send path. `sendFn` optionally
  // overrides HOW a turn is dispatched (e.g. routing through a substrate Agent
  // instead of calling session.send() directly) without touching that wiring.
  // Defaults to session.send(), so every existing caller is unaffected.
  //
  // `coalesce` (default on): when draining, merge the contiguous run of queued
  // items that share the head's (source, priority) into ONE turn — the
  // Claude-Code "type several lines while it's working, they all land in the
  // next turn" behavior. Before this, N rapid Edva messages ran as N separate
  // turns (full startup latency each, and the agent never saw them together);
  // now they're one turn the agent answers holistically. Merging is deliberately
  // conservative — SAME source AND SAME priority only — so a Edva message is
  // never fused with a background triage/cron task (different source, usually
  // different priority), which must stay a distinct turn. `maxCoalesce` caps a
  // single merged turn so a flood can't build one enormous prompt.
  constructor(session, { sendFn, coalesce = true, maxCoalesce = 10, separator = "\n\n" } = {}) {
    super();
    this.session = session;
    this._sendFn = sendFn || ((content) => session.send(content));
    this._coalesce = coalesce;
    this._maxCoalesce = Math.max(1, maxCoalesce);
    this._separator = separator;
    this.queue = [];
    this.inFlight = null;
    this.completed = 0;
    this._seenMsgIds = new Set();
    this._maxSeenIds = 500;
    // Quota hold: nothing is sent before this epoch-ms
    // deadline. The chat supervisor owns it: it sets it when the Max usage
    // limit refuses a turn, carries it onto a replacement dispatcher after a
    // restart, and calls releaseHold() from its own timer. Queued work waits.
    this.holdUntil = 0;

    session.on("result", (ev) => {
      const done = this.inFlight;
      // Resume-handshake guard — see lib/phantom-result.mjs. After a
      // turn-watchdog SIGKILL, the respawned `--resume` child emits a zero-work
      // result closing out the killed turn, ~2s after the retry was already
      // dispatched into it. Swallowing the retry here is worse on chat than on
      // ops: the dropped item is a message from the user that never gets answered.
      if (done && isPhantomResult(ev)) {
        this.emit("phantom_result", { item: done, result: ev });
        return;
      }
      this.inFlight = null;
      this.completed++;
      // Free the msgId of the head item AND every item merged into this turn.
      this._forgetIds(done);
      this.emit("turn_complete", { message: done, result: ev });
      this._drain();
    });
  }

  // Drop an item's msgId (and any merged-in ids) from the dedup set on completion.
  _forgetIds(item) {
    if (!item) return;
    if (item.msgId) this._seenMsgIds.delete(item.msgId);
    for (const m of item.mergedFrom || []) {
      if (m.msgId) this._seenMsgIds.delete(m.msgId);
    }
  }

  dispatch(content, source = "unknown", { priority = "normal", msgId } = {}) {
    // Dedup by msgId if provided.
    if (msgId) {
      if (this._seenMsgIds.has(msgId)) return null;
      if (this.inFlight?.msgId === msgId) return null;
      this._seenMsgIds.add(msgId);
      // Cap the set to prevent unbounded growth.
      if (this._seenMsgIds.size > this._maxSeenIds) {
        const first = this._seenMsgIds.values().next().value;
        this._seenMsgIds.delete(first);
      }
    }

    const p = PRIORITY[priority] ?? PRIORITY.normal;
    const item = { id: randomUUID(), source, content, priority: p, priorityName: priority, enqueuedAt: Date.now(), msgId };

    // Insert at correct position: after all items with same or higher priority.
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > p) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, item);
    this.emit("enqueued", item);

    // Check if we should interrupt the current in-flight turn.
    if (p === PRIORITY.high && this._shouldInterrupt()) {
      this.emit("interrupt_requested", item);
    } else {
      this._drain();
    }

    return item.id;
  }

  _shouldInterrupt() {
    if (!this.inFlight) return false;
    if (this.inFlight.priority === PRIORITY.high) return false;
    const elapsed = Date.now() - this.inFlight.dispatchedAt;
    return elapsed > INTERRUPT_THRESHOLD_MS;
  }

  hold(until) { if (until > this.holdUntil) this.holdUntil = until; }
  isHeld(now = Date.now()) { return this.holdUntil > now; }
  releaseHold() { this.holdUntil = 0; this._drain(); }

  _drain() {
    if (this.inFlight || this.isHeld()) return;
    const head = this.queue.shift();
    if (!head) return;

    // Coalesce the contiguous run of queued items sharing head's (source,
    // priority) into a single turn. The queue is priority-ordered, so this run
    // sits right behind head; anything of a different source/priority stays
    // queued and dispatches as its own turn next.
    const merged = [];
    if (this._coalesce) {
      while (
        merged.length + 1 < this._maxCoalesce &&
        this.queue.length &&
        this.queue[0].source === head.source &&
        this.queue[0].priority === head.priority
      ) {
        merged.push(this.queue.shift());
      }
    }

    let content = head.content;
    let mergedFrom;
    if (merged.length) {
      content = [head, ...merged].map((it) => it.content).join(this._separator);
      // Provenance for dedup cleanup on completion + observability.
      mergedFrom = merged.map((it) => ({ id: it.id, msgId: it.msgId, source: it.source }));
      this.emit("coalesced", { head, mergedCount: merged.length, source: head.source, priorityName: head.priorityName });
    }

    this.inFlight = { ...head, content, mergedFrom, mergedCount: merged.length, dispatchedAt: Date.now() };
    this.emit("dispatching", this.inFlight);
    try {
      this._sendFn(this.inFlight.content);
    } catch (err) {
      this.emit("dispatch_error", { item: this.inFlight, error: err.message });
      this.inFlight = null;
    }
  }

  // `front`: ahead of the items already queued at its priority instead of
  // behind them (a refused turn keeps its place in line).
  requeueInFlight({ front = false } = {}) {
    if (!this.inFlight) return null;
    const item = this.inFlight;
    this.inFlight = null;
    // Re-insert at correct priority position.
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > item.priority || (front && this.queue[i].priority === item.priority)) {
        insertIdx = i;
        break;
      }
    }
    this.queue.splice(insertIdx, 0, item);
    this.emit("requeued", item);
    return item;
  }

  snapshot() {
    const byPriority = { high: 0, normal: 0, low: 0 };
    for (const item of this.queue) {
      byPriority[item.priorityName]++;
    }
    return {
      queueDepth: this.queue.length,
      byPriority,
      inFlight: this.inFlight
        ? { id: this.inFlight.id, source: this.inFlight.source, priority: this.inFlight.priorityName, dispatchedAt: this.inFlight.dispatchedAt, enqueuedAt: this.inFlight.enqueuedAt }
        : null,
      completed: this.completed,
      rateLimitHoldUntil: this.isHeld() ? new Date(this.holdUntil).toISOString() : null,
    };
  }
}
