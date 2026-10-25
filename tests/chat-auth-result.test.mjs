// Regression guard: during a Max-auth outage, a user asked a question and
// chat-supervisor.mjs's safety net posted the CLI's error string to them as
// their reply:
//   "Failed to authenticate: OAuth session expired and could not be refreshed"
// The chat supervisor also never logged "AUTH ERROR", so watchdog.sh's scan of
// chat-supervisor.log could not see a chat-side outage.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_ERROR_RE,
  AUTH_RESULT_MAX_CHARS,
  CHAT_AUTH_OFFLINE_REPLY,
  authFailureText,
} from "../agent/supervisor/auth-result.mjs";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SUP = path.join(ROOT, "agent/supervisor");
const OBSERVED = "Failed to authenticate: OAuth session expired and could not be refreshed";

test("the observed chat turn is recognised as an auth failure", () => {
  assert.equal(authFailureText({ result: OBSERVED, num_turns: 1, duration_ms: 77 }), OBSERVED);
  assert.equal(authFailureText({ result: OBSERVED, is_error: true, num_turns: 0 }), OBSERVED);
  assert.equal(authFailureText({ result: "Not logged in · Please run /login", num_turns: 0 }), "Not logged in · Please run /login");
});

test("a real reply that merely discusses an auth outage is never swallowed", () => {
  // Multi-turn, not an error: the agent explaining the outage to the user.
  const reply = `Max auth was down for about an hour - the ops log shows "${OBSERVED}" from 23:10.`;
  assert.equal(authFailureText({ result: reply, num_turns: 6, is_error: false }), null);
  // Too long to be a CLI error line, even on a one-turn result.
  assert.equal(authFailureText({ result: OBSERVED + " " + "x".repeat(AUTH_RESULT_MAX_CHARS), num_turns: 1 }), null);
  assert.equal(authFailureText({ result: "Here's today's plan.", num_turns: 1 }), null);
  assert.equal(authFailureText({}), null);
  assert.equal(authFailureText(null), null);
});

test("both supervisors agree on what an auth failure is", () => {
  const ops = fs.readFileSync(path.join(SUP, "index.mjs"), "utf8");
  assert.ok(
    ops.includes(`const AUTH_ERROR_RE = ${AUTH_ERROR_RE.toString()};`),
    "AUTH_ERROR_RE in auth-result.mjs has drifted from index.mjs - keep them identical",
  );
});

// index.mjs once tested AUTH_ERROR_RE against the whole result, so a real
// multi-turn hum summary (6 turns, ~1000 characters; paraphrased here) that
// quoted another job's error was logged as AUTH ERROR #1 and watchdog.sh paged
// a false Max-auth outage.
const HUM_SUMMARY = [
  "This hum tick sent one question to the user's chat and logged it.",
  "",
  "- **What went out:** the day's decision card, asking whether a 10-minute refresh job should run under launchd, because it fails under cron with \"Not logged in\". `decision-ask` exited 0.",
  "- **Left unsent:** a cadence question (0.5), the tasks, email follow-up and watchdog candidates, and the weather one.",
  "- **State:** I updated `hum-state.json` (`last_question_at`, `last_run_at`, question count) and appended the tick trace with `hum-run-log append`; that command printed nothing, so I haven't confirmed the row landed.",
].join("\n");

test("a multi-turn summary that quotes a CLI auth phrase is not an auth failure", () => {
  assert.ok(AUTH_ERROR_RE.test(HUM_SUMMARY), "fixture must still contain the phrase that tripped the old check");
  assert.equal(authFailureText({ result: HUM_SUMMARY, num_turns: 6, is_error: false, duration_ms: 114133 }), null);
  // Even a one-turn result that long is an agent's text, not a CLI error line.
  assert.equal(authFailureText({ result: HUM_SUMMARY, num_turns: 1, is_error: false }), null);
});

test("every real ops-supervisor auth failure on record still counts", () => {
  // Shapes from ops-light / ops-haiku logs:
  // one short CLI line, turns=1, ~50-130 ms.
  for (const result of [OBSERVED, `Error during compaction: ${OBSERVED}`, "Not logged in · Please run /login"]) {
    assert.equal(authFailureText({ result, num_turns: 1, is_error: false, duration_ms: 61 }), result);
  }
});

test("the ops supervisor counts auth failures through authFailureText, not the bare regex", () => {
  const ops = fs.readFileSync(path.join(SUP, "index.mjs"), "utf8");
  assert.ok(ops.includes('import { authFailureText } from "./auth-result.mjs";'), "index.mjs must import authFailureText");
  assert.ok(ops.includes("const authFail = authFailureText(ev);"));
  assert.ok(
    !ops.includes("AUTH_ERROR_RE.test(ev.result)"),
    "index.mjs tests AUTH_ERROR_RE against the whole result again - a summary quoting 'Not logged in' would page a false outage",
  );
  // watchdog.sh greps for this exact prefix and strips it to quote the error.
  assert.ok(ops.includes("AUTH ERROR #${this.authErrorCount}: ${authFail.slice(0, 160)}"));
});

test("the offline notice is plain language and is not itself an auth-error string", () => {
  assert.ok(!AUTH_ERROR_RE.test(CHAT_AUTH_OFFLINE_REPLY));
  assert.ok(!CHAT_AUTH_OFFLINE_REPLY.includes(OBSERVED));
  assert.ok(CHAT_AUTH_OFFLINE_REPLY.includes("claude /login"));
});

test("chat-supervisor wires the guard in front of the safety net", () => {
  const src = fs.readFileSync(path.join(SUP, "chat-supervisor.mjs"), "utf8");
  assert.ok(src.includes('from "./auth-result.mjs"'), "chat-supervisor must import auth-result.mjs");
  assert.ok(src.includes("const authFail = authFailureText(ev);"));
  // watchdog.sh greps chat-supervisor.log for exactly these two phrases.
  assert.ok(src.includes("AUTH ERROR #${this.authErrorCount}: "), "log line must match watchdog.sh's 'AUTH ERROR #n: ' parse");
  assert.ok(src.includes("auth restored"), "must log 'auth restored' so watchdog clears the incident");
  assert.ok(src.includes("this._postOrphanedReply(CHAT_AUTH_OFFLINE_REPLY)"));
  // The auth branch must come before the generic orphaned-text post.
  assert.ok(src.indexOf("!t.replyCalled && authFail") < src.indexOf("this._postOrphanedReply(orphaned)"));
  const watchdog = fs.readFileSync(path.join(ROOT, "agent/scripts/watchdog.sh"), "utf8");
  assert.ok(watchdog.includes("{ops,ops-light,ops-haiku,chat}-supervisor.log"), "watchdog no longer scans chat-supervisor.log - this guard is then unobserved");
});
