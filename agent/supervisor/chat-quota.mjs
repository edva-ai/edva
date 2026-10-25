// Chat's half of the quota-refusal guard. The ops half is in
// dispatcher.mjs; chat reuses its isQuotaRefusal and
// rateLimitHoldUntil, and this file holds only what chat adds on top.
//
// What this fixes. When the Max weekly allowance is used up, the CLI refuses
// a chat turn in well under a second: a rate_limit_event {status "rejected",
// rateLimitType "seven_day"}, then a synthetic assistant message (model
// "<synthetic>", error "rate_limit") reading "You've hit your weekly limit ·
// resets …", then an is_error result. Without this, the safety net in
// chat-supervisor.mjs posts that string to the user as the answer, and the
// message is marked done and never answered.
//
// Recognition is structural only: the event's status, or the CLI's own error
// class on its synthetic message. No text is read.

/** The CLI's own usage-limit message: not the agent's words, never an answer. */
export function isCliQuotaMessage(ev) {
  return ev?.type === "assistant" && ev.error === "rate_limit";
}

const WINDOW = { seven_day: "this week's Claude limit", five_hour: "my five-hour Claude limit" };

/** "at 11pm", "tomorrow at 7:30am", "Thursday at 11pm" — in `tz`, relative to `now`. */
export function resetLabel(ms, tz, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const clock = `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`}${String(p.dayPeriod || "").toLowerCase()}`;
  const day = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: tz });
  if (day(ms) === day(now)) return `at ${clock}`;
  if (day(ms) === day(now + 86_400_000)) return `tomorrow at ${clock}`;
  const wd = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  return `${wd(ms) === wd(now) ? "next " : ""}${wd(ms)} at ${clock}`;
}

function parts(info, tz, now) {
  const resetMs = Number(info?.resetsAt) * 1000;
  return {
    which: WINDOW[info?.rateLimitType] || "my Claude usage limit",
    reset: Number.isFinite(resetMs) && resetMs > now ? `${resetLabel(resetMs, tz, now)} your time` : null,
  };
}

/**
 * The one line the user gets per outage, kept across a supervisor restart.
 * `requeued` false means the limit landed partway through a turn that had
 * already done work, which is not re-run.
 */
export function chatQuotaNotice({ info, until, tz, now = Date.now(), requeued = true }) {
  const { which, reset } = parts(info, tz, now);
  if (!requeued) {
    return `I've hit ${which} partway through your last message, so I couldn't finish it. ` +
      (reset ? `It resets ${reset}; ask me again then if anything's missing.` : "Ask me again in a little while if anything's missing.");
  }
  const mins = Math.max(1, Math.round((until - now) / 60_000));
  return `I've hit ${which}, so I can't answer right now. ` +
    (reset ? `It resets ${reset}, and I'll pick your message up then.` : `I'll try again in about ${mins === 1 ? "a minute" : `${mins} minutes`} and pick your message up then.`);
}

/**
 * A message refused again on its one retry is set aside, and the user is told so,
 * once per outage (the supervisor's _maybeQuotaDroppedNotice).
 * `several`: messages the user sent during the hold merged into that retry.
 */
export function chatQuotaDroppedNotice({ info, tz, now = Date.now(), several = false }) {
  const { which, reset } = parts(info, tz, now);
  const [msg, it] = several ? ["your messages", "them"] : ["your message", "it"];
  return `Sorry, I tried ${msg} again but I'm still over ${which}, so I've had to set ${it} aside. ` +
    (reset ? `It resets ${reset}; please send ${it} again then.` : `Please send ${it} again in a little while.`);
}

// Prepended to a requeued message: it runs late, and the [Current time] stamp
// phone-channel put in it no longer says what time it is.
export const QUOTA_RETRY_HEADER =
  "[supervisor] This message waited for a Claude usage limit to reset, so it is being answered late and the time stamps in it are out of date. Check the current time before saying anything time-sensitive.";
