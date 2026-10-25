"use strict";
// cron-interpreter-check — does every script cron exec's DIRECTLY name an
// interpreter that actually exists on cron's PATH?
//
// Consumed by `edva doctor` (check 8d2). Extracted from the monolith so the
// logic is unit-testable: a false negative here re-ships a silent nightly
// failure, and a false positive puts permanent noise in a health dashboard.
//
// THE BUG THIS CATCHES. `#!/usr/bin/env node` is a syntactically perfect
// shebang that still dies with exit 127 under cron, because cron runs with a
// bare compiled-in PATH (/usr/bin:/bin — verified on the production host 2026-08-05: no
// PATH= line in the crontab, and the logged failure was literally
// "env: node: No such file or directory") while Homebrew's node lives in
// /opt/homebrew/bin.
//
// WHY THE EXISTING CHECKS MISS IT.
//   - doctor (8c) is ledger-based: it only sees a job after it has already
//     failed, and only for jobs run via `cron-run --label`. 31 of 123 entries
//     bypass cron-run entirely and never reach cron-runs.jsonl at all.
//   - doctor (8d) scans only *.sh targets. Both real instances
//     (calendar-attendee-audit, hum-channel-audit) were EXTENSIONLESS node
//     scripts, so it never looked at them. hum-channel-audit fires once a year
//     with no --label: a 12-month-invisible breakage.
// Only a static scan closes this class, which is why this is a sibling of (8d).
//
// THE CENTRAL DISTINCTION. A shebang only matters when the file is exec'd
// DIRECTLY. Most Homebrew-node scripts under cron are safe precisely because
// their crontab line names /opt/homebrew/bin/node explicitly, so the shebang is
// never consulted. Flagging those would be wrong — hence the preceding-token
// rule below.
//
// THE THIRD SAFE FORM (2026-09-08). There are two ways a line can be safe and
// this knew only two: an explicit interpreter, and a redirect target. The third
// is an env-assignment prefix immediately before the script --
//
//     bash -c 'PATH=/opt/homebrew/bin:$PATH /.../some-scan --since ...'
//
// which puts node on PATH before the shebang is ever consulted. Two daily jobs
// ran that way and exited 0 every morning, while this
// check called them unrunnable for two weeks running and the weekly review
// escalated the phantom twice. A permanently-red entry in a health dashboard is
// how a real one gets scrolled past.
//
// SCOPED DELIBERATELY NARROWLY. Only assignments in an unbroken run immediately
// BEFORE the script token count, and only absolute components of PATH. A
// "PATH=" sitting after the script, or belonging to another command on the same
// line, changes nothing about how this script resolves.
//
// AND NOT VIA THE WRAPPER. cron-run also repairs its child's PATH, which would
// clear these two as a side effect -- deliberately not modelled. The headline
// regression below (calendar-attendee-audit, dead nightly until 2026-08-05) is
// itself a cron-run-wrapped line, so trusting the wrapper would disarm this
// detector for most of the crontab and couple it to the very fix it exists to
// catch a regression in. A script that would otherwise rely on the wrapper gets
// its shebang hardcoded instead.
//
// BUT SAY WHICH (2026-10-20). Not modelling the wrapper decides the VERDICT; it
// does not make "exit 127" true of a wrapped line. daily-summary-fix's hourly
// sweep runs `#!/usr/bin/env node` under cron-run and exits 0 every hour, while
// doctor's text said it dies with 127. Each finding now carries
// `wrapperRescued`: true when every line that reaches the script starts with
// cron-run AND the shebang is `env node`, the one name cron-run puts on PATH
// (it appends node's own directory), so it runs only while cron-run keeps doing
// that. Still a finding, still red; only the sentence changes. One bare line,
// or any other interpreter, makes it false.

const fs = require("fs");
const path = require("path");
const os = require("os");

// macOS cron's compiled-in PATH. Deliberately NOT process.env.PATH: doctor runs
// from an interactive shell (or an agent turn) whose PATH is far richer than
// cron's, and checking against it would declare every broken script healthy —
// the precise blind spot this exists to remove.
const CRON_PATH_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const IS_INTERP = /(^|\/)(node|bash|sh|zsh|python3?|ruby|perl|osascript)$/;

function stripQuotes(s) {
  return String(s || "").replace(/^['"]+|['"]+$/g, "");
}

// lang-regex-ok: shell VAR=value syntax is machine-written structure, not language.
const IS_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Absolute dirs an env-assignment prefix puts on PATH for THIS script token.
 * Walks back from the token before the script over an unbroken run of
 * VAR=value assignments, stopping at the first token that is not one. That
 * adjacency is what makes it safe: it cannot be fooled by a PATH= later in the
 * line, or by one belonging to a different command.
 */
function assignedPathDirs(toks, scriptIdx) {
  const dirs = [];
  for (let j = scriptIdx - 1; j >= 0; j--) {
    const t = stripQuotes(toks[j]);
    if (!IS_ASSIGNMENT.test(t)) break;
    if (!t.startsWith("PATH=")) continue;
    for (const d of t.slice(5).split(":")) if (d.startsWith("/")) dirs.push(d);
  }
  return dirs;
}

/**
 * Find scripts a crontab exec's directly whose shebang interpreter will not
 * resolve under cron.
 *
 * @param {string[]} cronLines  Non-comment, non-blank crontab lines.
 * @param {object}  [opts]
 * @param {string}  [opts.homedir]       For `~/` expansion. Defaults to os.homedir().
 * @param {string[]}[opts.cronPathDirs]  Override cron's PATH (tests).
 * @param {string}  [opts.repoMarker]    Only scan paths containing this. Scoping to
 *                                       the repo keeps false positives at zero — a
 *                                       system binary's interpreter is not ours to police.
 * @param {object}  [opts.fsImpl]        Injectable fs (tests).
 * @returns {{bad: Array<{file: string, shebang: string, wrapperRescued: boolean}>, scanned: string[]}}
 *   `wrapperRescued`: it runs today only because cron-run puts node on PATH (see BUT SAY WHICH).
 */
function findUnresolvableInterpreters(cronLines, opts = {}) {
  const homedir = opts.homedir || os.homedir();
  const dirs = opts.cronPathDirs || CRON_PATH_DIRS;
  const marker = opts.repoMarker || "/edva/";
  const F = opts.fsImpl || fs;

  const bad = [];
  const badByPath = new Map();
  // Keyed by path AND the PATH context it was reached with, because the verdict
  // is now context-dependent: the same script can be safe on a line that sets
  // PATH and broken on a bare one, and whichever came first must not vouch for
  // the other. Both outputs are de-duplicated by path on the way out.
  const seen = new Set();
  const scanned = new Set();

  for (const line of cronLines) {
    // Drop the 5 schedule fields, then split on whitespace. A quoted
    // `bash -c '…'` body tokenizes fine here: the only question asked of each
    // token is whether it is an executable file, and what precedes it.
    const toks = line.replace(/^\s*(\S+\s+){5}/, "").split(/\s+/);
    // The command cron runs: the first token that is not a VAR=value prefix.
    const head = toks.map(stripQuotes).find((x) => x && !IS_ASSIGNMENT.test(x)) || "";
    const wrapped = path.basename(head) === "cron-run";

    for (let i = 0; i < toks.length; i++) {
      let t = stripQuotes(toks[i]);
      if (t.startsWith("~/")) t = path.join(homedir, t.slice(2));
      if (!t.startsWith("/") || !t.includes(marker)) continue;

      let st;
      try { st = F.statSync(t); } catch { continue; }
      if (!st.isFile() || !(st.mode & 0o111)) continue;

      const prev = stripQuotes(toks[i - 1]);
      if (IS_INTERP.test(prev)) continue;                     // interpreter named explicitly
      if (/^\d*>>?$/.test(prev) || prev === "2>&1") continue; // redirect target, not an exec

      const extraDirs = assignedPathDirs(toks, i);
      // ...and by whether cron-run wraps it, so a bare sighting is never skipped.
      const key = t + "\u0000" + extraDirs.join(":") + "\u0000" + (wrapped ? "w" : "");
      if (seen.has(key)) continue;
      seen.add(key);
      scanned.add(t);

      let first = "";
      try { first = F.readFileSync(t, "utf8").split("\n", 1)[0]; } catch { continue; }
      // lang-regex-ok: a shebang is machine-generated structure, not language.
      const m = first.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
      if (!m) continue; // a missing "#!" is doctor check (8d)'s job, not this one

      const searchDirs = extraDirs.length ? [...extraDirs, ...dirs] : dirs;
      const ok = /\/env$/.test(m[1])
        ? Boolean(m[2]) && searchDirs.some((d) => F.existsSync(path.join(d, m[2])))
        : F.existsSync(m[1]);
      const rescued = wrapped && /\/env$/.test(m[1]) && m[2] === "node";

      if (!ok) {
        const prior = badByPath.get(t);
        if (!prior) {
          const b = { file: path.basename(t), shebang: first.trim(), wrapperRescued: rescued };
          badByPath.set(t, b);
          bad.push(b);
        } else if (!rescued) {
          prior.wrapperRescued = false; // one bare line is a live exit 127, whatever the others do
        }
      }
    }
  }

  return { bad, scanned: [...scanned] };
}

module.exports = { findUnresolvableInterpreters, CRON_PATH_DIRS };
