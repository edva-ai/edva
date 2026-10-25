// share-bundle.mjs — one share-sheet send is one message to the agent.
//
// The share extension (client/EdvaShare) posts a share as back-to-back
// edva_messages rows with metadata.source "share": one bare attachment-URL
// row per photo, then one row with the user's note, text and links. Dispatched
// row by row, whichever reaches the supervisor first starts a turn alone and
// the other queues as a turn of its own: a photo answered without its caption
// ("This is the same photo I just answered…"), then the caption again from the
// 2-minute sweep (see laterTimestamp); or a note saved from the caption, then
// a second turn that cannot read the photo and contradicts it.
//
// ShareBundler holds share rows until none has arrived for gapMs, then hands
// them over as ONE row: contents oldest first, under the newest member's id and
// created_at. Membership is structural: metadata.source, and a created_at within
// gapMs of a row already held. One share's rows land well under a second apart
// (a few hundred ms); two separate shares each need the sheet, the composer
// and an upload, so they are never that close, except when the app flushes
// shares it parked while its token was stale (they then arrive as one message,
// oldest first). Non-share rows never wait, and flush an open bundle first.
//
// Member ids stay "consumed" for consumedTtlMs (= phone-channel's pending TTL)
// so the realtime feed and the sweep, which deliver the same rows, cannot
// resend one alone; a dispatch that failed outright is retried after the same
// 10 minutes as a single message. Across a restart the persisted cursor does
// that job: it moves to the newest member once the bundle is accepted, never
// backwards. A restart mid-collection loses nothing: the cursor has not passed
// those rows, so the startup sweep delivers them again and they re-bundle.

export const SHARE_BUNDLE_GAP_MS = 3_000;
export const SHARE_CONSUMED_TTL_MS = 10 * 60 * 1000;

export function isShareRow(row) {
  return row?.metadata?.source === "share";
}

/**
 * The later of two created_at cursors. A sweep cursor that takes whichever
 * message finished dispatching last goes BACKWARDS when an older message
 * finishes second, and the sweep (`created_at > cursor`) re-sends the newer,
 * already-answered one (a third reply to the same caption).
 */
export function laterTimestamp(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const a = Date.parse(current);
  const b = Date.parse(candidate);
  if (Number.isNaN(b)) return current;
  if (Number.isNaN(a)) return candidate;
  if (b !== a) return b > a ? candidate : current;
  // Same millisecond: Postgres keeps microseconds, and two rows from one
  // insert stream share the "…+00:00" form, so the string order is the order.
  return candidate > current ? candidate : current;
}

/** One row standing for a whole share. `shareBundleIds` lists every member, oldest first. */
export function mergeShareRows(rows) {
  const sorted = [...rows].sort((x, y) => (Date.parse(x.created_at) || 0) - (Date.parse(y.created_at) || 0));
  const head = sorted[sorted.length - 1];
  return {
    ...head,
    content: sorted.map((r) => r.content ?? "").join("\n\n"),
    shareBundleIds: sorted.map((r) => r.id),
  };
}

export class ShareBundler {
  constructor({ onFlush, gapMs = SHARE_BUNDLE_GAP_MS, consumedTtlMs = SHARE_CONSUMED_TTL_MS, maxRows = 20,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { _onFlush: onFlush || (() => {}), _gapMs: gapMs, _ttlMs: consumedTtlMs, _maxRows: maxRows,
      _now: now, _setTimer: setTimer, _clearTimer: clearTimer });
    this._rows = [];
    this._timer = null;
    this._consumed = new Map(); // id -> handed-over-at (ms)
  }

  /** Buffered now, or handed over within the TTL. */
  has(id) {
    if (this._rows.some((r) => r.id === id)) return true;
    const at = this._consumed.get(id);
    if (at === undefined) return false;
    if (this._now() - at > this._ttlMs) {
      this._consumed.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Take a share row. Returns false for a row that is not a share (the caller
   * handles it right away), true when the row is buffered or already known.
   */
  add(row) {
    if (!isShareRow(row)) return false;
    if (this.has(row.id)) return true;
    if (this._rows.length && (!this._fits(row) || this._rows.length >= this._maxRows)) this.flush();
    this._rows.push(row);
    if (this._timer) this._clearTimer(this._timer);
    this._timer = this._setTimer(() => this.flush(), this._gapMs);
    return true;
  }

  /** Hand the open bundle over now (also called when a non-share message arrives). */
  flush() {
    if (this._timer) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
    if (!this._rows.length) return null;
    const rows = this._rows;
    this._rows = [];
    const at = this._now();
    for (const [id, t] of this._consumed) if (at - t > this._ttlMs) this._consumed.delete(id);
    for (const r of rows) this._consumed.set(r.id, at);
    const merged = mergeShareRows(rows);
    this._onFlush(merged);
    return merged;
  }

  _fits(row) {
    const t = Date.parse(row.created_at);
    if (Number.isNaN(t)) return true;
    const times = this._rows.map((r) => Date.parse(r.created_at)).filter((x) => !Number.isNaN(x));
    if (!times.length) return true;
    return t >= Math.min(...times) - this._gapMs && t <= Math.max(...times) + this._gapMs;
  }
}
