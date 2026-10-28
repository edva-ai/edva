// auth-outage-replay.test.mjs — after a Max sign-in outage, only the missed jobs
// on the approved safe-to-run-late list are re-run, each at most once, and one
// plain line says what happened.
//
// Every case runs the real bin/auth-outage-replay against a throwaway
// installation (EDVA_HOME): its own agent/logs, its own approved list
// in agent/local/config, and a stand-in launchctl that records each call.
//
// Run: node --test tests/auth-outage-replay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");
const BIN = path.join(KERNEL, "bin/auth-outage-replay");

const HOUR = 3600;
const NOW = Math.floor(Date.UTC(2026, 9, 21, 7, 0, 0) / 1000);
// The runners stamp local time: render an epoch the way `date '+%Y-%m-%d %H:%M:%S'` does.
const stamp = (epoch) => {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const SIGNED_OUT = "REFUSED: not on the Max subscription (loggedIn=false authMethod=none apiProvider=firstParty subscription=) (confirmed Max sign-in outage — watchdog.sh owns that page; not paged)";
const WRONG_PLAN = "REFUSED: not on the Max subscription (loggedIn=true authMethod=claude.ai apiProvider=firstParty subscription=pro)";

const LIST = [
  { job: "cost-efficiency-review", label: "ai.claude.cost-efficiency-review", name: "the nightly cost review", max_late_hours: 12 },
  { job: "nightly-review", label: "ai.claude.improvement-review", name: "the weekly review", max_late_hours: 12 },
];

function install({ list = LIST, launchctlFails = false } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "auth-replay-"));
  const tools = path.join(h, KERNEL_SUBDIR);
  const logs = path.join(tools, "agent", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(tools, "agent", "local", "config"), { recursive: true });
  fs.mkdirSync(path.join(tools, "data"), { recursive: true });
  if (list) fs.writeFileSync(path.join(tools, "agent", "local", "config", "auth-outage-replay.json"), JSON.stringify({ jobs: list }));
  const calls = path.join(h, "launchctl.txt");
  const fake = path.join(h, "launchctl");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n${launchctlFails ? 'echo "Could not find service" >&2; exit 113' : "exit 0"}\n`);
  fs.chmodSync(fake, 0o755);
  const log = (job, lines) => fs.appendFileSync(path.join(logs, `${job}.log`), lines.map(([t, rest]) => `${stamp(t)} [${job}] ${rest}\n`).join(""));
  const run = (extra = []) => spawnSync(process.execPath, [BIN, "--since", String(NOW - 10 * HOUR), "--now", String(NOW), ...extra], {
    encoding: "utf8", timeout: 20_000,
    env: { ...process.env, EDVA_HOME: h, EDVA_LOCAL_DIR: "", AUTH_OUTAGE_REPLAY_LAUNCHCTL: fake },
  });
  const kicks = () => { try { return fs.readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const ledger = () => { try { return fs.readFileSync(path.join(tools, "data", "auth-outage-replay.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { h, log, run, kicks, ledger, cleanup: () => fs.rmSync(h, { recursive: true, force: true }) };
}

test("a listed job refused during the outage, with no run since, is started once and named", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 30 * HOUR, "start (ephemeral opus-5-5, xhigh, 25m cap)"], [NOW - 4 * HOUR, SIGNED_OUT]]);
    const r = i.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(i.kicks(), [`kickstart gui/${process.getuid()}/ai.claude.cost-efficiency-review`]);
    assert.equal(r.stdout.trim(), "✅ The Claude sign-in outage made the nightly cost review miss its run, so I started it again just now.");
    assert.equal(i.ledger()[0].action, "kickstarted");

    const again = i.run();
    assert.equal(i.kicks().length, 1, "a second call started the same missed run again");
    assert.equal(again.stdout, "");
  } finally { i.cleanup(); }
});

test("a job that has started since its refusal is not missed", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 4 * HOUR, SIGNED_OUT], [NOW - 1 * HOUR, "start (ephemeral opus-5-5, xhigh, 25m cap)"]]);
    const r = i.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(i.kicks(), []);
    assert.equal(r.stdout, "");
  } finally { i.cleanup(); }
});

test("a job not on the list is only named, never started", () => {
  const i = install();
  try {
    i.log("example-unlisted-job", [[NOW - 4 * HOUR, SIGNED_OUT]]);
    const r = i.run();
    assert.deepEqual(i.kicks(), []);
    assert.equal(r.stdout.trim(), "The Claude sign-in outage made example-unlisted-job miss a run; it isn't on your safe-to-run-late list, so it waits for the next scheduled run.");
    assert.ok(!r.stdout.startsWith("✅"), "a green check only when something was re-run");
  } finally { i.cleanup(); }
});

test("one line covers what ran and what was left alone", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 4 * HOUR, SIGNED_OUT]]);
    i.log("nightly-review", [[NOW - 2 * HOUR, SIGNED_OUT]]);
    i.log("system-issue-review", [[NOW - 5 * HOUR, SIGNED_OUT], [NOW - 3 * HOUR, SIGNED_OUT]]);
    const r = i.run();
    assert.equal(i.kicks().length, 2);
    const out = r.stdout.trim();
    assert.equal(out.split("\n").length, 1);
    assert.equal(out, "✅ The Claude sign-in outage made the nightly cost review and the weekly review miss their runs, so I started them again just now. Also missed, and not on your safe-to-run-late list, so left for the next scheduled run: system-issue-review.");
  } finally { i.cleanup(); }
});

test("only signed-out refusals inside the window count", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 30 * HOUR, SIGNED_OUT]]);   // an older outage
    i.log("nightly-review", [[NOW - 2 * HOUR, WRONG_PLAN]]);              // not an outage
    const r = i.run();
    assert.deepEqual(i.kicks(), []);
    assert.equal(r.stdout, "");
  } finally { i.cleanup(); }
});

test("a refusal older than the job's limit is reported, not re-run", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 9 * HOUR, SIGNED_OUT]]);
    const r = spawnSync(process.execPath, [BIN, "--since", String(NOW - 10 * HOUR), "--now", String(NOW + 4 * HOUR)], {
      encoding: "utf8", env: { ...process.env, EDVA_HOME: i.h, EDVA_LOCAL_DIR: "", AUTH_OUTAGE_REPLAY_LAUNCHCTL: "/nonexistent" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the nightly cost review miss its run too long ago to re-run safely/); // lang-regex-ok: the tool's own fixed line, not a person's words
    assert.equal(i.ledger()[0].action, "too_late");
  } finally { i.cleanup(); }
});

test("a start launchd refuses is said plainly", () => {
  const i = install({ launchctlFails: true });
  try {
    i.log("cost-efficiency-review", [[NOW - 4 * HOUR, SIGNED_OUT]]);
    const r = i.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "The Claude sign-in outage made the nightly cost review miss its run, and I couldn't start it again, so it waits for the next scheduled run.");
    assert.equal(i.ledger()[0].action, "kickstart_failed");
  } finally { i.cleanup(); }
});

test("--dry-run starts nothing and writes nothing", () => {
  const i = install();
  try {
    i.log("cost-efficiency-review", [[NOW - 4 * HOUR, SIGNED_OUT]]);
    const r = i.run(["--dry-run", "--json"]);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(i.kicks(), []);
    assert.deepEqual(i.ledger(), []);
    assert.equal(out.results[0].action, "would_kickstart");
  } finally { i.cleanup(); }
});

test("with no approved list (the kernel default) nothing is ever started", () => {
  const i = install({ list: null });
  try {
    i.log("cost-efficiency-review", [[NOW - 4 * HOUR, SIGNED_OUT]]);
    const r = i.run();
    assert.deepEqual(i.kicks(), []);
    assert.match(r.stdout, /isn't on your safe-to-run-late list/); // lang-regex-ok: the tool's own fixed line
  } finally { i.cleanup(); }
});

test("usage: --since is required", () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(r.status, 64);
});
