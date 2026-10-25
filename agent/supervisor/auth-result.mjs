// Recognising a Max-auth failure in a `claude -p` result event, for both
// supervisors (the ops supervisors use it too, so a hum summary that merely
// quotes "Not logged in" never pages a false Max-auth outage).
//
// What this fixes. When the host's Claude login lapses, a chat turn ends in
// ~80ms with the CLI's error as its only text. chat-supervisor.mjs's safety
// net, which exists to rescue a real answer the agent forgot to send through
// reply(), would treat that string as the answer, and the user would get back,
// as the reply to a question:
//   "Failed to authenticate: OAuth session expired and could not be refreshed"
// Without an auth check the chat supervisor also never writes the
// "AUTH ERROR" line that watchdog.sh greps chat-supervisor.log for,
// so a chat-only outage would page nobody.
//
// The regex is a copy of index.mjs:268 so both supervisors agree on what an
// auth failure is. tests/chat-auth-result.test.mjs fails if they drift.

// lang-regex-ok: matches the Claude CLI's own machine-generated auth error strings, not anyone's words
import { createRequire } from "node:module";

export const AUTH_ERROR_RE = /Failed to authenticate|authentication_error|Not logged in|Please run \/?(login|`?claude login`?)|[Kk]eychain (cannot be found|[Nn]ot [Ff]ound)/;

// A CLI auth error is one short line. Anything longer is an agent's own text,
// which may well discuss an auth outage and must never be swallowed.
export const AUTH_RESULT_MAX_CHARS = 400;

// What the user sees instead of the raw error. A reply, not an alert: the user
// asked something and is waiting, so is told plainly why there's no answer.
// The machine is named by the instance's host_label ("the host" by default).
const HOST_LABEL = createRequire(import.meta.url)("../../lib/instance.cjs").instance().host_label;
export const CHAT_AUTH_OFFLINE_REPLY =
  `I can't get to this right now. My Claude sign-in on ${HOST_LABEL} has lapsed, so I'm offline until it's restored. ` +
  `Running \`claude /login\` on ${HOST_LABEL} brings me back, and once I'm back, ask me again and I'll pick it up.`;

// Returns the auth error text if this result event is a failed-auth turn,
// otherwise null. Only a short result from a turn that errored or never got
// past its first step qualifies, so a real multi-turn reply that happens to
// quote "Failed to authenticate" is left alone.
export function authFailureText(ev) {
  if (!ev || typeof ev.result !== "string") return null;
  const text = ev.result.trim();
  if (!text || text.length > AUTH_RESULT_MAX_CHARS) return null;
  if (!AUTH_ERROR_RE.test(text)) return null; // lang-regex-ok: CLI error string, see AUTH_ERROR_RE
  if (ev.is_error !== true && (ev.num_turns || 0) > 1) return null;
  return text;
}
