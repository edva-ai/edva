// Regression guard: live match_patterns in system-issue-review-state.json
// carried a DOUBLED backslash, so they compiled cleanly and then matched
// nothing at all.
//
// The alert shapes these defend against come from the system channel:
//   ⚠️ 58 calendar event(s) with attendees Edva cannot account for: ...
//   ⚠️ ... gmail.googleapis.com unreachable ...
// Neither had ever matched its own cluster. A cluster sat in `verifying` and
// due for closure while its flagship wording went unrecognised — a silent
// false "fixed", plus a duplicate cluster for the next firing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesCluster,
  deadPatterns,
  isBeingWorked,
  selectCriticalEscalations,
} from "../lib/system-issue-gate.mjs";

// Verbatim shapes as they sit in the state file today.
const OVER_ESCAPED_CALENDAR = "calendar event\\\\(s\\\\) with attendees Edva cannot account for";
const OVER_ESCAPED_DNS = "gmail\\\\.googleapis\\\\.com unreachable";
const CORRECT_DNS = "gmail\\.googleapis\\.com unreachable";

const CALENDAR_ALERT =
  "⚠️ 58 calendar event(s) with attendees Edva cannot account for:\n\n" +
  "• Team sync — guest@example.com (no row in the write log covers this event)";
const DNS_ALERT = "⚠️ p1 unstar-scan: gmail.googleapis.com unreachable (getaddrinfo ENOTFOUND)";

test("the bug: an over-escaped pattern compiles and matches nothing", () => {
  // This is WHY the de-escaped reading exists. A doubled backslash demands a
  // literal backslash in the alert text, and alerts never contain one.
  assert.doesNotThrow(() => new RegExp(OVER_ESCAPED_CALENDAR, "i"));
  assert.equal(new RegExp(OVER_ESCAPED_CALENDAR, "i").test(CALENDAR_ALERT), false);
  assert.equal(new RegExp(OVER_ESCAPED_DNS, "i").test(DNS_ALERT), false);
});

test("matchesCluster recovers the intended reading of an over-escaped pattern", () => {
  assert.equal(matchesCluster(CALENDAR_ALERT, { match_patterns: [OVER_ESCAPED_CALENDAR] }), true);
  assert.equal(matchesCluster(DNS_ALERT, { match_patterns: [OVER_ESCAPED_DNS] }), true);
});

test("a correctly escaped pattern is untouched, and still means what it says", () => {
  assert.equal(matchesCluster(DNS_ALERT, { match_patterns: [CORRECT_DNS] }), true);
  // The dot stays escaped: it must not match an arbitrary separator.
  assert.equal(
    matchesCluster("gmailXgoogleapisXcom unreachable", { match_patterns: [CORRECT_DNS] }),
    false,
  );
});

test("the de-escaped reading never widens a pattern that has no doubled backslash", () => {
  const clean = { match_patterns: ["unstar-scan", "backup-schedule.*occurrences"] };
  assert.equal(matchesCluster("⚠️ unstar-scan fetch failed", clean), true);
  assert.equal(matchesCluster("⚠️ something entirely unrelated", clean), false);
});

test("malformed patterns still fall back to substring instead of throwing", () => {
  const broken = { match_patterns: ["unclosed ( group"] };
  assert.doesNotThrow(() => matchesCluster("an unclosed ( group appears here", broken));
  assert.equal(matchesCluster("an unclosed ( group appears here", broken), true);
});

test("deadPatterns names the over-escaped ones and leaves clean ones alone", () => {
  assert.deepEqual(
    deadPatterns({ match_patterns: [OVER_ESCAPED_CALENDAR, "calendar-attendee-audit", CORRECT_DNS] }),
    [OVER_ESCAPED_CALENDAR],
  );
  assert.deepEqual(deadPatterns({ match_patterns: ["unstar-scan"] }), []);
  assert.deepEqual(deadPatterns({}), []);
  assert.deepEqual(deadPatterns(null), []);
});

test("end to end: a repeat critical alert no longer buys a duplicate same-day dispatch", () => {
  // The harm the missed match caused. The cluster is already `verifying`, so
  // isBeingWorked() should suppress — but only if the alert matches it at all.
  const cluster = {
    id: "sic-calendar-audit-unexplained-invites",
    status: "verifying",
    match_patterns: [OVER_ESCAPED_CALENDAR],
  };
  assert.equal(isBeingWorked(cluster), true);

  const critical = "🔴 58 calendar event(s) with attendees Edva cannot account for: • Team sync";
  const { escalate, suppressed } = selectCriticalEscalations({
    rows: [{ role: "assistant", content: critical, created_at: "2026-09-20T09:17:02Z" }],
    cursor: "2026-09-19T00:00:00Z",
    clusters: [cluster],
    now: Date.parse("2026-09-20T10:00:00Z"),
  });
  assert.equal(escalate.length, 0);
  assert.equal(suppressed.being_worked, 1);
});
