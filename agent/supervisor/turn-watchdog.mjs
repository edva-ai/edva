// turn-watchdog.mjs — per-turn hang recovery, shared by the chat + ops
// supervisors.
//
// A turn is the window between a dispatcher "dispatching" event and the
// session's "result". A turn that goes fully silent, or outlives its window
// without recent progress, is hung (deadlocked tool call, an MCP/network wait
// with no timeout, resumed-session corruption) and the whole queue behind it
// stalls. `arm(item)` starts the per-turn timer; `touch(ev)` records child
// activity; `clear()` cancels on result / restart / interrupt; if it fires,
// `onFire(item, ms, info)` runs the supervisor's recovery (SIGKILL the child →
// session "exit" → requeueInFlight → restart, plus a system-channel alert).
// Activity-aware — see "Hybrid detection" below.
//
// Ops first carried an inline version of this (a multi-hour hang let cron keep
// enqueuing behind one stuck turn); chat had only the 15-min process-level
// SIGKILL in process-manager.mjs. This module unifies the two so
// both get identical, tested, per-source-tunable hang recovery. Timers are
// injectable so the logic is testable without real time.
//
// ---------------------------------------------------------------------------
// Why there are TWO defaults
//
// A 10-minute window is a fine number for an interactive turn and a wrong
// number for a background job. With one default, TURN_WATCHDOG_MS_BY_SOURCE
// (supervisor/index.mjs) grows into a hand-maintained allowlist of "jobs
// permitted to be slow", each entry added after a healthy job ran past
// 10 minutes, got SIGKILLed mid-work (sometimes seconds into a file write),
// false-paged the system channel as "hung with no result", and was re-run from
// the top while queued items waited behind it. Such jobs are not hung; the
// kill lands because the window measures total elapsed time rather than
// whether anything is still happening.
//
// So the default is inverted rather than extended: an UNRECOGNISED source is
// assumed to be a background job and gets TURN_WATCHDOG_MS_JOB_DEFAULT, and the
// short 10-minute leash is reserved for the small, explicit set of sources where
// somebody is actually waiting on the answer (INTERACTIVE_SOURCES). A new cron
// job now costs nothing to add. TURN_WATCHDOG_MS_BY_SOURCE keeps working exactly
// as before and still wins outright — it is now a list of genuine exceptions
// (nightly-review really does need 55 minutes) instead of the price of admission.
//
// That elapsed time is a poor proxy for "wedged" is addressed separately; see
// "Hybrid detection" below.
// ---------------------------------------------------------------------------
// Hybrid detection
//
// The supervisors call touch(ev) on every child stream event and the watchdog
// keeps two clocks: lastActivityAt (any event) and lastProgressAt (any event
// EXCEPT system/thinking_tokens, which the API keeps trickling even from a
// stalled stream). Four outcomes, measured against 3,489 completed turns in
// supervisor-{ops,ops-light}/events.ndjson (rotated logs included):
//
//   idle    — no event at all for TURN_WATCHDOG_IDLE_MS (12 min). The longest
//             any-event silence inside a healthy turn was 6.0 min (p99.9 4.2).
//             A fully silent hung turn is caught at 12 rather than at the
//             20-min window.
//   window  — the existing watchdogMsFor(source) elapsed window, unchanged,
//             EXCEPT it is deferred while progress is recent (< 3 min,
//             TURN_WATCHDOG_PROGRESS_GRACE_MS) and re-checked as the grace runs
//             out. A turn emitting progress nearly every minute (last one
//             1.6 min before the window) is spared; a stalled turn trickling
//             only thinking_tokens every ~4.5 min (last progress 4.5 min old)
//             is still killed at its window (its retry finishing in seconds
//             shows the kill was right). That
//             is why thinking_tokens refresh idle but never progress; ignoring
//             them for idle instead would be unsafe (one healthy turn had an
//             18.8-min gap between non-thinking events).
//   ceiling — CEILING_FACTOR x window, a hard bound on a turn that keeps
//             making "progress" forever (a tool loop is not progress).
//
// Never worse than the old elapsed window on any of the three real kills. One
// timer per turn: touch() only records timestamps (it runs thousands of times
// per turn, so it never reschedules); the timer wakes at the nearest deadline
// and either fires or re-arms for the remainder. onFire(item, windowMs, info) —
// the first two arguments are unchanged; info = {reason: "idle"|"window"|
// "ceiling", silentMs, sinceProgressMs, elapsedMs, idleMs, graceMs, ceilingMs}.
// ---------------------------------------------------------------------------

// 20 min, not 10: 10 minutes is under the normal runtime of real chat work
// (e.g. reverting live file edits so a change can go through the Face-ID
// flow). A kill there also restarts the chat supervisor, whose phone-channel
// handover false-pages the system channel; a turn killed between "apply" and
// "revert" leaves the working tree edited; and after a second hang the user's
// request is dropped outright.
export const TURN_WATCHDOG_MS_DEFAULT = 20 * 60 * 1000;

// Applies to any source not in TURN_WATCHDOG_MS_BY_SOURCE and not interactive.
// 25 min sits above every unregistered runtime actually observed (~12-19 min
// for the slowest watchers and ideation jobs) with headroom, while staying well under the
// 30h hard session rotation. Genuinely longer jobs still declare an override.
export const TURN_WATCHDOG_MS_JOB_DEFAULT = 25 * 60 * 1000;

// Early silence kill: no child stream event of ANY kind for this long. 2x the
// 6.0-min longest any-event silence in 3,489 completed turns (p99.9 4.2), and
// above a full 10-minute Bash tool timeout, which emits nothing while it runs.
export const TURN_WATCHDOG_IDLE_MS = 12 * 60 * 1000;

// The elapsed window is deferred while the last PROGRESS event (anything but
// system/thinking_tokens) is younger than this (calibrated: a working turn's
// last progress 1.6 min before the window is spared; a stalled one at 4.5 min
// is not).
export const TURN_WATCHDOG_PROGRESS_GRACE_MS = 3 * 60 * 1000;

// A turn that keeps making progress is still bounded at this multiple of its
// watchdogMsFor(source) window (20 min interactive → 60, 25 min job → 75).
export const TURN_WATCHDOG_CEILING_FACTOR = 3;

// thinking_tokens is a heartbeat the API emits even from a stalled stream: it
// proves the connection is alive, not that the turn is advancing. The chat
// supervisor also runs with partial messages, where the same stalled thinking
// phase arrives as stream_event thinking_delta chunks instead. Those are
// classed the same way, so a trickling chat turn cannot hold the user's queue
// to the 60-min ceiling.
export function isProgressEvent(ev) {
  if (!ev) return true;
  if (ev.type === "system" && ev.subtype === "thinking_tokens") return false;
  if (ev.type === "stream_event" && ev.event?.delta?.type === "thinking_delta") return false;
  return true;
}

// Sources where a human is waiting on the turn, so a stalled queue is felt
// immediately and the short leash is worth its false-positive rate:
//   edva     — the user's live phone-channel messages (chat supervisor)
//   gmail:<id>  — a single email triage; runs in seconds, and the dispatcher's
//                 poison-message guard already drops it after two hangs
// Everything else — cron jobs, watchers, digests, supervisor maintenance — is
// background work that nothing is blocking on beyond the queue itself.
// chat-agent is deliberately NOT on this list. "Work the chat agent routed to
// ops on the user's behalf, so somebody is waiting" is backwards: the chat
// agent routes work to ops exactly BECAUSE it is too heavy to answer inline.
// The user already has the chat reply; nothing is blocked on the ops queue. On
// the short leash such an item (busy the whole time) is killed mid-work, the
// retry is killed again and dropped, and the request is lost; these turns
// routinely run 5-6 minutes and longer, so 10 minutes is under the normal
// runtime of the work.
export const INTERACTIVE_SOURCES = new Set(["edva"]);

export function isInteractiveSource(source) {
  // A missing source is a bug, not a job: keep it on the short leash so it can
  // never quietly hold the queue for the longer job window.
  if (!source) return true;
  if (INTERACTIVE_SOURCES.has(source)) return true;
  if (String(source).startsWith("gmail:")) return true;
  return false;
}

export function watchdogMsFor(
  source,
  {
    thresholds = {},
    defaultMs = TURN_WATCHDOG_MS_DEFAULT,
    jobDefaultMs = TURN_WATCHDOG_MS_JOB_DEFAULT,
  } = {},
) {
  // An explicit per-source override always wins, unchanged.
  const override = thresholds[source];
  if (override) return override;
  return isInteractiveSource(source) ? defaultMs : jobDefaultMs;
}

// The clause both supervisors append to the hang alert, after the unchanged
// "...hung for Nmin with no result — killing + restarting to retry" wording
// that system-issue-review clusters on. Empty for "window" (the classic case,
// text unchanged) and for a legacy two-argument fire.
export function hangReasonClause(info) {
  if (!info) return "";
  if (info.reason === "idle") return ` (no activity for ${Math.round(info.silentMs / 60000)}min)`;
  if (info.reason === "ceiling") return ` (still making progress, past the ${Math.round(info.ceilingMs / 60000)}min ceiling)`;
  return "";
}

export class TurnWatchdog {
  constructor({
    thresholds = {},
    defaultMs = TURN_WATCHDOG_MS_DEFAULT,
    jobDefaultMs = TURN_WATCHDOG_MS_JOB_DEFAULT,
    idleMs = TURN_WATCHDOG_IDLE_MS,
    graceMs = TURN_WATCHDOG_PROGRESS_GRACE_MS,
    ceilingFactor = TURN_WATCHDOG_CEILING_FACTOR,
    onFire = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
  } = {}) {
    this.thresholds = thresholds;
    this.defaultMs = defaultMs;
    this.jobDefaultMs = jobDefaultMs;
    this.idleMs = idleMs;
    this.graceMs = graceMs;
    this.ceilingFactor = ceilingFactor;
    this.onFire = onFire;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._now = now;
    this.timer = null;
    this._resetTurn();
  }

  _resetTurn() {
    this.armedItem = null;
    this.windowMs = null;
    this.ceilingMs = null;
    this.armedAt = null;
    this.lastActivityAt = null;
    this.lastProgressAt = null;
  }

  msFor(source) {
    return watchdogMsFor(source, {
      thresholds: this.thresholds,
      defaultMs: this.defaultMs,
      jobDefaultMs: this.jobDefaultMs,
    });
  }

  // Start (or restart) the per-turn timer for `item`. Returns the window ms
  // (watchdogMsFor(source)), as before.
  arm(item) {
    this.clear();
    if (!item) return null;
    const ms = this.msFor(item.source);
    const t = this._now();
    this.armedItem = item;
    this.windowMs = ms;
    this.ceilingMs = ms * this.ceilingFactor;
    this.armedAt = t;
    this.lastActivityAt = t;
    this.lastProgressAt = t;
    this._schedule(Math.min(this.idleMs, ms, this.ceilingMs));
    return ms;
  }

  // Record child activity for the armed turn. `ev` is the child stream event
  // (classified by isProgressEvent) or a boolean isProgress; omitted = progress.
  // O(1) and timer-free: called on every child stream event. A no-op when
  // nothing is armed (between turns, during a restart's init handshake).
  touch(ev) {
    if (this.armedItem === null) return;
    const t = this._now();
    this.lastActivityAt = t;
    const progress = typeof ev === "boolean" ? ev : ev === undefined ? true : isProgressEvent(ev);
    if (progress) this.lastProgressAt = t;
  }

  _schedule(delay) {
    this.timer = this._setTimer(() => this._wake(), Math.max(0, delay));
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  _wake() {
    this.timer = null;
    const item = this.armedItem;
    if (item === null) return;
    const t = this._now();
    const silentMs = t - this.lastActivityAt;
    const sinceProgressMs = t - this.lastProgressAt;
    const elapsedMs = t - this.armedAt;
    let reason = null;
    if (silentMs >= this.idleMs) reason = "idle";
    else if (elapsedMs >= this.windowMs && sinceProgressMs >= this.graceMs) reason = "window";
    else if (elapsedMs >= this.ceilingMs) reason = "ceiling";
    if (!reason) {
      // Not due yet — sleep until whichever deadline is now nearest. Past the
      // window, that deadline is the moment the current progress goes stale.
      const untilIdle = this.lastActivityAt + this.idleMs - t;
      const untilWindow = elapsedMs < this.windowMs
        ? this.armedAt + this.windowMs - t
        : this.lastProgressAt + this.graceMs - t;
      const untilCeiling = this.armedAt + this.ceilingMs - t;
      this._schedule(Math.min(untilIdle, untilWindow, untilCeiling));
      return;
    }
    const ms = this.windowMs;
    const info = { reason, silentMs, sinceProgressMs, elapsedMs, idleMs: this.idleMs, graceMs: this.graceMs, ceilingMs: this.ceilingMs };
    // Teardown before firing, so onFire()'s recovery (which may re-enter
    // arm/clear via restart) starts from a clean slate.
    this._resetTurn();
    try { this.onFire(item, ms, info); } catch { /* recovery is best-effort */ }
  }

  clear() {
    if (this.timer) {
      try { this._clearTimer(this.timer); } catch {}
      this.timer = null;
    }
    this._resetTurn();
  }

  get armed() {
    return this.timer !== null;
  }
}
