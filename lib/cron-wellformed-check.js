"use strict";
// cron-wellformed-check — is every ACTIVE crontab entry still a well-formed
// 5-field schedule followed by a real command?
//
// Consumed by `edva doctor` (check 8d3). Sibling of cron-interpreter-check:
// both are STATIC scans, because the failure they catch never reaches the
// ledger. Extracted so the logic is unit-testable — a false negative re-ships
// a silently unrunnable job, a false positive puts permanent noise in a health
// dashboard.
//
// THE BUG THIS CATCHES. On 2026-09-05T04:05Z `cron-tz-sync` rewrote a DISABLED
// entry it had matched by its `--label`. Its rewrite is positional (tokens
// 0/1/4), so it overwrote the `#HUMPAUSE#` marker with the minute field and
// shifted every remaining field one place right:
//
//   before:  #HUMPAUSE# 0 23 * * * /…/cron-run --label trigger-hum-daily -- …
//   after:   0 23 23 * * * /…/cron-run --label trigger-hum-daily -- …
//
// Six fields. cron reads the first five as the schedule (23:00 on the 23rd of
// each month) and the sixth — a bare `*` — as the command, which cannot run.
// The pause marker is gone too, so lifting the pause by deleting the markers
// restores every OTHER lane and leaves this one dead.
//
// WHY NOTHING ELSE SEES IT.
//   - cron-tz-sync's own guards (added the same day) stop it happening AGAIN.
//     They do not repair the line already damaged, and nothing else looked.
//   - doctor (8c) is ledger-based: a job that never runs never fails, so it
//     produces no row to notice. This entry fires once a month at most.
//   - doctor (8d/8d2) resolve the COMMAND's script and interpreter. Here the
//     command is `*`, which is not a path, so neither has anything to resolve.
//   - The corruption was written in plain text to cron-tz-sync.log and no
//     alert fired. It was found a day later only by diffing the live crontab
//     against a hand-made backup.
//
// THE DISCRIMINATOR. A schedule field is glyphs only — digits, `*`, `,`, `-`,
// `/`. A command ALWAYS contains a letter: an absolute path, an env
// assignment, a bare binary name. So "token 5 has no letter in it" separates
// the two with no judgement call, and scores zero false positives against all
// 238 lines of the live crontab. Deliberately narrower than "does it look like
// a path" — `bash`, `python3` and `cd` are all legal commands.

// lang-regex-ok: matches a crontab SCHEDULE FIELD, machine-generated structure
// (digits, * , - / and the JAN/MON name forms), never natural language.
const CRON_FIELD = /^[A-Za-z0-9*,/-]+$/;
// lang-regex-ok: same — a token made only of schedule glyphs, no letters.
const SCHEDULE_GLYPHS_ONLY = /^[0-9*,/-]+$/;

/**
 * Find active crontab entries whose schedule/command boundary is broken.
 *
 * @param {string[]} cronLines  Non-comment, non-blank crontab lines.
 * @returns {{bad: Array<{line: string, reason: string, label: string|null}>, scanned: number}}
 */
function findMalformedCronEntries(cronLines) {
  const bad = [];
  let scanned = 0;

  for (const raw of cronLines) {
    const line = raw.trim();
    if (!line) continue;

    const toks = line.split(/\s+/);

    // Environment assignment (PATH=…, MAILTO=…): not a schedule entry at all.
    if (toks[0].includes("=")) continue;

    // @reboot / @daily / @yearly …: one schedule token, command follows.
    const scheduleLen = toks[0].startsWith("@") ? 1 : 5;
    if (toks.length <= scheduleLen) {
      bad.push({ line, reason: `only ${toks.length} token(s) — no command follows the schedule`, label: labelOf(toks) });
      continue;
    }
    scanned++;

    if (scheduleLen === 5) {
      const offender = toks.slice(0, 5).findIndex((t) => !CRON_FIELD.test(t));
      if (offender !== -1) {
        bad.push({ line, reason: `schedule field ${offender + 1} is not a cron field: "${toks[offender]}"`, label: labelOf(toks) });
        continue;
      }
    }

    const command = toks[scheduleLen];
    if (SCHEDULE_GLYPHS_ONLY.test(command)) {
      bad.push({
        line,
        reason: `command position holds "${command}" — a schedule glyph, not a command (schedule shifted right?)`,
        label: labelOf(toks),
      });
    }
  }

  return { bad, scanned };
}

/** The `--label` a cron-run entry carries, when it has one — the readable name. */
function labelOf(toks) {
  const i = toks.indexOf("--label");
  return i !== -1 && toks[i + 1] ? toks[i + 1] : null;
}

/** One-line human summary for doctor's failure text. */
function describeMalformed(bad) {
  return bad
    .map((b) => `${b.label || b.line.slice(0, 40)}: ${b.reason}`)
    .join("; ");
}

module.exports = { findMalformedCronEntries, describeMalformed };
