// queue-alarm.mjs — queue-backlog alarm with hysteresis, shared by the chat +
// ops supervisors.
//
// A deep dispatch queue means the turn engine is wedged and work is piling up
// behind one stuck turn — the operator needs to know. `check(depth)` fires
// `onHigh` ONCE when the queue crosses `high`, then stays quiet (armed=false)
// until it drains below `clear`, which fires `onClear` once and re-arms. The
// hysteresis gap (high > clear) prevents alarm flapping while the depth hovers
// near a single threshold.
//
// Ops has carried an inline version since it alarmed at depth 20; chat had NONE
// (a wedged chat turn could silently pile a deep queue with no page). This module
// unifies the pattern so both get identical, tested backlog alarms. Notifiers are
// injected so the logic is testable without a live supervisor / channel.

export const CHAT_QUEUE_ALARM_HIGH = 12;
export const CHAT_QUEUE_ALARM_CLEAR = 4;

export class QueueAlarm {
  constructor({
    high = CHAT_QUEUE_ALARM_HIGH,
    clear = CHAT_QUEUE_ALARM_CLEAR,
    onHigh = () => {},
    onClear = () => {},
  } = {}) {
    if (!(high > clear)) throw new Error(`QueueAlarm needs high (${high}) > clear (${clear})`);
    this.high = high;
    this.clear = clear;
    this.onHigh = onHigh;
    this.onClear = onClear;
    this.armed = true;   // ready to fire onHigh
    this.active = false; // currently in an alarmed state (fired, not yet cleared)
  }

  // Evaluate the current queue depth. Idempotent between threshold crossings —
  // safe to call on every enqueue and every drain.
  check(depth) {
    if (depth > this.high && this.armed) {
      this.armed = false;
      this.active = true;
      try { this.onHigh(depth); } catch { /* notify is best-effort */ }
    } else if (depth < this.clear) {
      if (this.active) {
        this.active = false;
        try { this.onClear(depth); } catch { /* best-effort */ }
      }
      this.armed = true;
    }
  }
}
