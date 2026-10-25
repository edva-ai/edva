// skill-health.test.mjs — the nightly browsing-skill health check
// (browsing-skills/tools/skill-health.js), run end to end.
//
// Regression: it once pushed "<site>/list-active failing N days in a row"
// nightly while every run of that site had worked — the job's log still held
// two undated not_logged_in lines from months earlier, re-read whole each night.
//
// Isolation: the script is copied into a temp tree shaped like the repo, so the
// logs, state and edva-notify it derives from its own location are all in
// that tree; its edva-notify is a stub that only records argv. Nothing is sent.
//
// Run: node --test tests/skill-health.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { KERNEL_SUBDIR } from "../lib/root.cjs";

const SCRIPT = path.resolve(import.meta.dirname, "..", "browsing-skills", "tools", "skill-health.js");
const TC = "tickets.example/list-active/list-active";
const BD = "draws.example/list-active/list-active";
const HOUR = 3600_000;

const NOTIFY_STUB = `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.SKILL_HEALTH_TEST_NOTIFY_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`;

const pad = (n) => String(n).padStart(2, "0");
/** run_script_job's `date '+%Y-%m-%d %H:%M:%S'` header stamp (local time). */
const localStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const skillLine = (skill, error) => JSON.stringify({ skill, action: "list-active", error, showCount: 0 });
const runHeader = (ms) => `${localStamp(ms)} [draw-check] start: /Users/x/Dev/edva/bin/draw-check-run --platform tickets`;

const REPAIR_LIB = path.resolve(import.meta.dirname, "..", "lib", "skill-repair.mjs");

function sandbox({ logs, state, repairLib = false, queue = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-health-"));
  const tools = path.join(dir, KERNEL_SUBDIR); // the kernel tree, in this checkout's layout
  fs.mkdirSync(path.join(tools, "browsing-skills", "tools"), { recursive: true });
  fs.mkdirSync(path.join(tools, "data", "logs"), { recursive: true });
  fs.mkdirSync(path.join(tools, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tools, "browsing-skills", "package.json"), JSON.stringify({ type: "module" }));
  fs.copyFileSync(SCRIPT, path.join(tools, "browsing-skills", "tools", "skill-health.js"));
  fs.writeFileSync(path.join(tools, "bin", "edva-notify"), NOTIFY_STUB, { mode: 0o755 });
  fs.mkdirSync(path.join(tools, "lib"), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(REPAIR_LIB), "root.cjs"), path.join(tools, "lib", "root.cjs")); // the script's root helper
  for (const [name, lines] of Object.entries(logs)) fs.writeFileSync(path.join(tools, "data", "logs", name), lines.join("\n") + "\n");
  if (state) fs.writeFileSync(path.join(tools, "data", "skill-health-state.json"), JSON.stringify(state));
  if (repairLib) {
    fs.copyFileSync(REPAIR_LIB, path.join(tools, "lib", "skill-repair.mjs"));
  }
  if (queue) fs.writeFileSync(path.join(tools, "data", "skill-repair-queue.json"), JSON.stringify(queue));
  return dir;
}

/** Run the copied script as cron does; return what it printed, pushed and saved. */
function run(opts) {
  const dir = sandbox(opts);
  const r = spawnSync(process.execPath, [path.join(dir, KERNEL_SUBDIR, "browsing-skills", "tools", "skill-health.js")], {
    cwd: dir, env: { PATH: process.env.PATH, ...(process.env.TZ ? { TZ: process.env.TZ } : {}), EDVA_ROOT: dir, SKILL_REPAIR_NO_KICK: "1", SKILL_HEALTH_TEST_NOTIFY_LOG: path.join(dir, "notify.jsonl") }, encoding: "utf8", timeout: 30_000,
  });
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  const out = {
    status: r.status, stdout: r.stdout, stderr: r.stderr,
    pushes: read("notify.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    state: JSON.parse(read("data/skill-health-state.json") || "{}"),
    queue: JSON.parse(read("data/skill-repair-queue.json") || "null"),
    files: fs.readdirSync(dir),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 0, `script exited ${out.status}\n${out.stdout}\n${out.stderr}`);
  return out;
}

test("a log touched today that still holds months-old failure lines: nothing counted, nothing pushed", () => {
  const now = Date.now();
  // Old lines (two undated not_logged_in after an old stamp), then a working run.
  const r = run({
    logs: {
      "draw-check.log": [
        `2026-03-02T04:00:00Z ${skillLine("tickets.example/list-active", null)}`,
        skillLine("tickets.example/list-active", "not_logged_in"),
        skillLine("tickets.example/list-active", "not_logged_in"),
        `{"ts": "2026-03-04T13:00:00Z", "skill": "draws.example/list-active", "action": "list-active", "error": null, "showCount": 5}`,
        runHeader(now - 22 * HOUR),
        "[cdp] load fired",
        JSON.stringify({ skill: "tickets.example/list-active", action: "list-active", error: null, showCount: 12 }),
        `[${new Date(now - 22 * HOUR).toISOString()}] every candidate date skipped — no summary`,
      ],
      // A log with failure lines and no stamp at all can't be placed in the window.
      "undated.log": [skillLine("example.com/thing", "boom")],
    },
    // A v1 state built by the old scanner.
    state: { version: 1, runs: { [TC]: { consecutive: 8, lastDay: utcDay(now - 24 * HOUR), lastError: "not_logged_in" } } },
  });
  assert.deepEqual(r.pushes, [], r.stdout);
  assert.match(r.stdout, /0 failure-line\(s\) today/);
  assert.equal(r.state.version, 2);
  assert.deepEqual(r.state.runs, {}, "the old scanner's 8-day streak is discarded, not carried forward");
});

test("a real failure inside the window extends the streak; day 3 pushes once, as one plain argument", () => {
  const now = Date.now();
  const r = run({
    logs: { "draw-check.log": [runHeader(now - 2 * HOUR), "[cdp] load fired", skillLine("tickets.example/list-active", "not_logged_in")] },
    state: { version: 2, runs: { [TC]: { consecutive: 2, lastDay: utcDay(now - 24 * HOUR), lastError: "not_logged_in" } } },
  });
  assert.equal(r.state.runs[TC].consecutive, 3);
  assert.equal(r.pushes.length, 1, r.stdout);
  assert.deepEqual(r.pushes[0], [
    `Browsing-skill health alert: 1 action(s) repeatedly failing\n\n${TC} failing 3 days in a row — last error: not_logged_in\n\nInvestigate: data/logs/ and browsing-skills/skills/<site>/`,
  ], "edva-notify has no --source/--task flags: they used to land in the push text, with literal \\n");
});

test("a failure its caller kept quiet (an expected-failure day) still counts but is not pushed", () => {
  const now = Date.now();
  const r = run({
    logs: {
      "draw-check.log": [
        runHeader(now - 2 * HOUR),
        skillLine("tickets.example/list-active", "not_logged_in"),
        `[${new Date(now - 2 * HOUR).toISOString()}] blocker not reported — every date … is skipped: session is signed out`,
        JSON.stringify({ skill_health: "quiet", reason: "expected", skills: [TC], ts: new Date(now - 2 * HOUR).toISOString() }),
      ],
    },
    state: { version: 2, runs: { [TC]: { consecutive: 2, lastDay: utcDay(now - 24 * HOUR), lastError: "not_logged_in" } } },
  });
  assert.deepEqual(r.pushes, [], r.stdout);
  assert.equal(r.state.runs[TC].consecutive, 3, "the streak stays truthful while quiet");
  assert.match(r.stdout, /1 kept quiet by their caller/);
});

test("a quiet line covers only the skills it names", () => {
  const now = Date.now();
  const r = run({
    logs: {
      "draw-check.log": [
        runHeader(now - 3 * HOUR),
        skillLine("tickets.example/list-active", "not_logged_in"),
        JSON.stringify({ skill_health: "quiet", reason: "expected", skills: [TC], ts: new Date(now - 3 * HOUR).toISOString() }),
        runHeader(now - 2 * HOUR),
        skillLine("draws.example/list-active", "list_timeout"),
      ],
    },
    state: { version: 2, runs: {
      [TC]: { consecutive: 2, lastDay: utcDay(now - 24 * HOUR), lastError: "not_logged_in" },
      [BD]: { consecutive: 2, lastDay: utcDay(now - 24 * HOUR), lastError: "list_timeout" },
    } },
  });
  assert.equal(r.pushes.length, 1, r.stdout);
  assert.ok(r.pushes[0][0].includes(BD), r.pushes[0][0]);
  assert.ok(!r.pushes[0][0].includes(TC), "the quieted failure is not in the push");
});

test("an error code from a log line never reaches a shell", () => {
  const now = Date.now();
  const r = run({
    logs: { "x.log": [runHeader(now - HOUR), skillLine("example.com/thing", "x$(touch PWNED)")] },
    state: { version: 2, runs: { "example.com/thing/list-active": { consecutive: 5, lastDay: utcDay(now - 24 * HOUR), lastError: "x" } } },
  });
  assert.equal(r.pushes.length, 1);
  assert.ok(r.pushes[0][0].includes("x$(touch PWNED)"));
  assert.ok(!r.files.includes("PWNED"), "command substitution ran");
});

test("lineTime reads the stamps the producers actually write", async () => {
  const dir = sandbox({ logs: {} });
  try {
    const { lineTime } = await import(pathToFileURL(path.join(dir, KERNEL_SUBDIR, "browsing-skills", "tools", "skill-health.js")).href);
    assert.equal(lineTime("[2030-03-12T13:15:24.351Z] every candidate date skipped"), Date.parse("2030-03-12T13:15:24.351Z"));
    assert.equal(lineTime(`{"ts": "2030-03-23T12:42:02Z", "skill": "a/b"}`), Date.parse("2030-03-23T12:42:02Z"));
    assert.equal(lineTime(`2030-03-30T13:58:22Z {"skill":"tickets.example/availability"}`), Date.parse("2030-03-30T13:58:22Z"));
    assert.equal(lineTime("2030-03-13 00:01:00 [draw-check] start: x"), new Date(2030, 2, 13, 0, 1, 0).getTime(), "header stamps are local time");
    assert.equal(lineTime("2030-03-13T00:01:00+0200 x"), Date.parse("2030-03-12T22:01:00Z"));
    assert.equal(lineTime(skillLine("a/b", "c")), null);
    assert.equal(lineTime("[cdp] load fired"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Same-day repair: the nightly scan queues a repair for a markup
// break on its FIRST failure day; login walls, quieted lines and write actions
// are never queued; the 3-day push is unchanged.
test("first-day markup break on a read action is queued for repair, with its diagnostic and url", () => {
  const now = Date.now();
  const line = JSON.stringify({ ts: new Date(now - HOUR).toISOString(), skill: "league.example", action: "schedule", error: "zero_rows",
    diagnostic: "page fetched (400000 bytes) but no event rows parsed", url: "https://league.example/schedule/" });
  const r = run({ logs: { "sports-watch.log": [line] }, repairLib: true });
  assert.deepEqual(r.pushes, [], "day 1 never pushes");
  assert.equal(r.queue?.pending?.length, 1, r.stdout);
  const q = r.queue.pending[0];
  assert.deepEqual([q.skill, q.action, q.error, q.url, q.producer], ["league.example", "schedule", "zero_rows", "https://league.example/schedule/", "skill-health"]);
  assert.match(q.diagnostic, /no event rows/);
  assert.equal(q.log_file, "data/logs/sports-watch.log");
  assert.match(r.stdout, /1 repair\(s\) queued/);
});

test("login walls, write actions and quieted lines are not queued; a second run the same day does not re-queue", () => {
  const now = Date.now();
  const ts = new Date(now - HOUR).toISOString();
  const logs = { "mixed.log": [
    JSON.stringify({ ts, skill: "tickets.example/list-active", action: "list-active", error: "not_logged_in" }),
    JSON.stringify({ ts, skill: "draws.example/draw-enter", action: "draw-enter", error: "not_observed_in_dom" }),
    JSON.stringify({ ts, skill: "example.com/quiet", action: "quiet", error: "zero_rows" }),
    JSON.stringify({ ts, skill_health: "quiet", skills: ["example.com/quiet/quiet"], reason: "expected" }),
  ] };
  const r = run({ logs, repairLib: true });
  assert.equal(r.queue, null, `nothing should be queued:\n${r.stdout}`);

  const zero = { "x.log": [JSON.stringify({ ts, skill: "example.com", action: "list", error: "zero_rows" })] };
  const queued = { pending: [{ id: "sr-1", skill: "example.com", action: "list", error: "zero_rows", requested_at: ts, status: "pending" }], history: [] };
  const again = run({ logs: zero, repairLib: true, queue: queued });
  assert.equal(again.queue.pending.length, 1, "already queued, not duplicated");
});

test("without the repair library (older checkout) the scan still runs", () => {
  const now = Date.now();
  const r = run({ logs: { "x.log": [JSON.stringify({ ts: new Date(now - HOUR).toISOString(), skill: "example.com", action: "list", error: "zero_rows" })] } });
  assert.equal(r.queue, null);
  assert.match(r.stdout, /0 repair\(s\) queued/);
});
