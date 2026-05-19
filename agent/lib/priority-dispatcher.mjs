// priority-dispatcher.mjs — dispatch queue with priority levels and interruption.
//
// Three priority levels: high (0), normal (1), low (2).
// High-priority items go to front of queue. Within same priority, FIFO order.
// Emits "interrupt_requested" when a high-priority item arrives and the
// in-flight turn has been running > INTERRUPT_THRESHOLD_MS on a lower-priority task.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const PRIORITY = { high: 0, normal: 1, low: 2 };
const INTERRUPT_THRESHOLD_MS = 30_000;

export class PriorityDispatcher extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.queue = [];
    this.inFlight = null;
    this.completed = 0;
    this._seenMsgIds = new Set();
    this._maxSeenIds = 500;

    session.on("result", (ev) => {
      const done = this.inFlight;
      this.inFlight = null;
      this.completed++;
      if (done?.msgId) this._seenMsgIds.delete(done.msgId);
      this.emit("turn_complete", { message: done, result: ev });
      this._drain();
    });
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

  _drain() {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = { ...next, dispatchedAt: Date.now() };
    this.emit("dispatching", this.inFlight);
    try {
      this.session.send(this.inFlight.content);
    } catch (err) {
      this.emit("dispatch_error", { item: this.inFlight, error: err.message });
      this.inFlight = null;
    }
  }

  requeueInFlight() {
    if (!this.inFlight) return null;
    const item = this.inFlight;
    this.inFlight = null;
    // Re-insert at correct priority position.
    let insertIdx = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > item.priority) {
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
    };
  }
}
