// phantom-result.mjs — recognize the zero-work `result` event that
// `claude -p --resume` emits when it restores a session whose previous turn was
// SIGKILLed mid-flight, so a dispatcher doesn't mistake it for the completion of
// the turn it just sent.
//
// WHY THIS EXISTS
//
// The turn-watchdog hang-recovery path was self-defeating. On a hang it does:
// SIGKILL child → session "exit" → requeueInFlight() → restart() → respawn with
// `--resume <same session>` → transfer the queue → dispatch the requeued item.
// The dispatch is written to the child's stdin within a millisecond of spawn,
// but the child needs ~2s to finish restoring the session — and as it finishes,
// it emits a `result` closing out the turn that was killed:
//
//   {"type":"result","subtype":"success","is_error":false,"duration_ms":83,
//    "num_turns":0,"result":"","total_cost_usd":0,...}
//
// Both dispatchers treated any `result` as "the in-flight item finished", so
// that event consumed the retry: the item was marked complete, the turn
// watchdog disarmed, and the job stopped being tracked ~2s after being
// re-dispatched. Observed end to end:
//
//   T+0s   TURN WATCHDOG: no result in 10min — requeue + kill child
//   T+16s  disp <id> → <job>                          (the retry)
//   T+18s  disp <id> done ... 83ms $0.0000 turns=0    (the phantom ate it)
//
// So a hang was never actually retried: two hangs in a row ended in "dropping
// it" (hang #2 drops by design) rather than a successful second attempt. The
// recovery path could not recover.
//
// THE DISCRIMINATOR
//
// Zero-turn results are NOT inherently phantom — `/compact` and context-guard
// turns legitimately report `num_turns: 0`. Cost separates them cleanly. Every
// legitimate zero-turn result measured (11 of them in one day, all context-guard
// compactions) billed $0.22–$3.80 and ran 61–131 s; the phantom billed exactly
// $0 and ran 83 ms, because the child made no API call at all. Note
// `duration_api_ms` is 0 for both and is NOT usable as a discriminator.
//
// Errors are deliberately excluded: a genuine turn that fails with zero turns
// and zero cost (auth outage, immediate refusal) must flow through the normal
// path so the crash-loop / auth-outage detectors see it.

/**
 * True when `ev` is the resume handshake's trailing result rather than the
 * completion of a dispatched turn.
 *
 * Callers should respond by leaving `inFlight` untouched — the real turn is
 * still running in the child, the turn watchdog should stay armed, and the
 * genuine `result` will arrive later and complete the item normally.
 */
export function isPhantomResult(ev) {
  if (!ev) return false;
  if (ev.is_error) return false;              // real failure — let it through
  if ((ev.num_turns || 0) !== 0) return false; // real turn ran
  if ((ev.total_cost_usd || 0) > 0) return false; // real tokens were billed
  return true;
}
