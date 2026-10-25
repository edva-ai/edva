// edva-logs: the --last window must actually widen, and a malformed
// timestamp must not kill the run.
//
// Two defects, both invisible to an acceptance-only test:
//
//  1. `--last 7d` was rejected outright (parseDuration knew only s/m/h), which
//     blinded nightly-review's own watchdog query. `--last 7d` entered
//     nightly-review.md long after parseDuration was written as [smh]?, so
//     many more weekly runs were blind than the review reported. Simply
//     accepting "d" would have been WORSE than the rejection: the SOURCES table
//     points at one live file per source, rotate-agent-logs.sh copytruncates it
//     nightly, so --last 1d / 7d / 52w returned byte-identical output. A loud
//     exit-2 would have become a silent empty result, and nightly-review reads
//     a non-empty match as an incident — i.e. empty reads as a clean bill of
//     health on auth outages and hung turns. So these tests assert the window's
//     MAGNITUDE (7d finds what 1h cannot; 7d == --since now-7d), never just
//     that the unit parses.
//
//  2. parseNdjsonTs returned Date.parse(e.ts) unvalidated. Rows in a live
//     hum-runs.jsonl carried stamps like "2026-04-25T21:41:21.3NZ" -> NaN, which
//     survives every window comparison (NaN < since is false) and then throws
//     RangeError at new Date(NaN).toISOString() — after most of the output had
//     already been printed.
//
// Every case runs the real binary in a temp HOME so it reads fixture logs, and
// no case passes --limit 0, so emit() is genuinely exercised.

// Run: node --test tests/edva-logs-window.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "edva-logs");

function iso(msAgo) { return new Date(Date.now() - msAgo).toISOString(); }
function spaceStamp(msAgo) { return iso(msAgo).slice(0, 19).replace("T", " "); }

/** A temp HOME laid out the way edva-logs expects, with rotated siblings. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "edva-logs-test-"));
  const logdir = path.join(home, "Dev/edva/agent/logs");
  const datadir = path.join(home, "Dev/edva/data");
  fs.mkdirSync(logdir, { recursive: true });
  fs.mkdirSync(datadir, { recursive: true });
  return { home, logdir, datadir };
}

function run(home, args) {
  try {
    return { out: execFileSync(BIN, args, {
      encoding: "utf8", env: { ...process.env, HOME: home }, maxBuffer: 16 * 1024 * 1024,
    }), code: 0 };
  } catch (e) {
    return { out: e.stdout || "", err: e.stderr || "", code: e.status };
  }
}

function lines(out) { return out.split("\n").filter(Boolean); }

test("--last 7d reads rotated siblings that --last 1h cannot see", () => {
  const { home, logdir } = makeHome();
  // Live file: today only (what copytruncate leaves behind after midnight).
  fs.writeFileSync(path.join(logdir, "watchdog.log"),
    `${spaceStamp(30 * 60_000)} [live] line-from-today\n`);
  // Rotated plain sibling, 3 days back. The stamp in the NAME runs a day ahead
  // of the content, exactly as rotate-agent-logs.sh writes it.
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
  const stampName = new Date(threeDaysAgo.getTime() + 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logdir, `watchdog-${stampName}.log`),
    `${spaceStamp(3 * 86_400_000)} [rotated] line-from-three-days-ago\n`);
  // Rotated + gzipped sibling, 5 days back.
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
  const gzName = new Date(fiveDaysAgo.getTime() + 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logdir, `watchdog-${gzName}.log.gz`),
    zlib.gzipSync(`${spaceStamp(5 * 86_400_000)} [gz] line-from-five-days-ago\n`));

  const wide = run(home, ["--last", "7d", "--source", "watchdog", "--no-color"]);
  assert.equal(wide.code, 0);
  assert.match(wide.out, /line-from-today/);
  assert.match(wide.out, /line-from-three-days-ago/, "plain rotated sibling must be read");
  assert.match(wide.out, /line-from-five-days-ago/, "gzipped rotated sibling must be read");

  const narrow = run(home, ["--last", "1h", "--source", "watchdog", "--no-color"]);
  assert.equal(narrow.code, 0);
  assert.match(narrow.out, /line-from-today/);
  assert.doesNotMatch(narrow.out, /three-days-ago/, "1h must not reach back three days");
  assert.doesNotMatch(narrow.out, /five-days-ago/);

  // The magnitude assertion the previous attempt lacked: a wider unit has to
  // return strictly more, not merely be accepted.
  assert.ok(lines(wide.out).length > lines(narrow.out).length,
    `7d (${lines(wide.out).length}) must return more than 1h (${lines(narrow.out).length})`);
});

test("--last 7d is identical to --since (now - 7d)", () => {
  const { home, logdir } = makeHome();
  fs.writeFileSync(path.join(logdir, "watchdog.log"),
    `${spaceStamp(60 * 60_000)} [live] recent\n`);
  const name = new Date(Date.now() - 2 * 86_400_000 + 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logdir, `watchdog-${name}.log`),
    `${spaceStamp(2 * 86_400_000)} [rotated] older\n`);

  const a = run(home, ["--last", "7d", "--source", "watchdog", "--no-color"]);
  const b = run(home, ["--since", iso(7 * 86_400_000), "--source", "watchdog", "--no-color"]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.out, b.out, "the duration form and the explicit --since form must agree");
  assert.match(a.out, /older/);
});

test("2w parses as two weeks and a nonsense unit is still rejected loudly", () => {
  const { home, logdir } = makeHome();
  const name = new Date(Date.now() - 10 * 86_400_000 + 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logdir, "watchdog.log"), `${spaceStamp(60_000)} [live] now\n`);
  fs.writeFileSync(path.join(logdir, `watchdog-${name}.log`),
    `${spaceStamp(10 * 86_400_000)} [rotated] ten-days-back\n`);

  const twoWeeks = run(home, ["--last", "2w", "--source", "watchdog", "--no-color"]);
  assert.equal(twoWeeks.code, 0);
  assert.match(twoWeeks.out, /ten-days-back/, "2w must reach ten days back");

  const oneWeek = run(home, ["--last", "1w", "--source", "watchdog", "--no-color"]);
  assert.doesNotMatch(oneWeek.out, /ten-days-back/, "1w must not");

  // The loud rejection is load-bearing: nightly-review reads an empty result as
  // "no incidents", so a typo must fail, not return nothing.
  const bad = run(home, ["--last", "9x", "--source", "watchdog"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /bad --last value/);
});

test("a malformed NDJSON timestamp is dropped instead of killing the run", () => {
  const { home, datadir } = makeHome();
  // The exact shape found in the live hum-runs.jsonl (84 rows of it).
  fs.writeFileSync(path.join(datadir, "hum-runs.jsonl"),
    `{"ts":"2026-04-25T21:41:21.3NZ","note":"malformed-stamp"}\n`
    + `{"ts":"${iso(60_000)}","note":"good-row"}\n`);

  const r = run(home, ["--last", "1h", "--source", "hum", "--no-color"]);
  assert.equal(r.code, 0, `must not crash; stderr was: ${r.err}`);
  assert.doesNotMatch(r.err || "", /RangeError/);
  assert.match(r.out, /good-row/, "the valid row must still be emitted");
  assert.doesNotMatch(r.out, /malformed-stamp/, "the unparseable row is dropped, not guessed at");
});

test("an ISO-shaped stamp that Date.parse rejects is dropped too", () => {
  const { home, logdir } = makeHome();
  // Shape-valid, unparseable: \d{2} happily matches month 13 / day 45 / hour 99,
  // and Date.parse returns NaN for it. (A merely impossible-but-rollable date
  // like 2026-02-30 is NOT a useful case — V8 rolls it over to Mar 2, so it
  // never reaches the guard.) The ops/chat parser had no NaN check either; the
  // crash was only ever observed via the NDJSON parser above, so this pins the
  // sibling hole before it is the one that bites.
  fs.writeFileSync(path.join(logdir, "ops-supervisor.log"),
    `2026-13-45T99:99:99Z [bogus] impossible-date\n`
    + `${iso(60_000)} [ok] real-line\n`);

  const r = run(home, ["--last", "1h", "--source", "ops", "--no-color"]);
  assert.equal(r.code, 0, `must not crash; stderr was: ${r.err}`);
  assert.match(r.out, /real-line/);
  assert.doesNotMatch(r.out, /impossible-date/);
});
