// dispatcher.mjs — serialized dispatch queue over ClaudeSession.
// Guarantees: one turn at a time. Messages queued behind in-flight work.
// Each enqueued message gets {id, source, content, enqueuedAt}.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

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
    this.queue = [];
    this.inFlight = null;
    this.completed = 0;
    // When true, _drain stops dispatching. Used during auth outages so the
    // queue doesn't burn through 401-returning turns. Cleared when the
    // supervisor detects creds refresh.
    this.paused = false;

    session.on("result", (ev) => {
      const done = this.inFlight;
      this.inFlight = null;
      this.persist();
      this.completed++;
      this.emit("turn_complete", { message: done, result: ev });
      this._drain();
    });
  }

  dispatch(content, source = "unknown") {
    const item = { id: randomUUID(), source, content, enqueuedAt: Date.now() };
    this.queue.push(item);
    this.persist();
    this.emit("enqueued", item);
    this._drain();
    return item.id;
  }

  _drain() {
    if (this.inFlight) return;
    if (this.paused) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    this.persist();
    this.emit("dispatching", next);
    try {
      this.session.send(next.content);
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
    };
  }
}
