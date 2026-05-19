// resilience.test.mjs — failure injection tests for ManagedProcess.
//
// Run: node --test agent/test/resilience.test.mjs

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ManagedProcess } from "../lib/managed-process.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(__dirname, "mock-service.mjs");
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpLog() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "res-test-"));
  const file = path.join(dir, "test.log");
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function mockProc(mockArgs, overrides = {}) {
  const tmp = tmpLog();
  const logs = [];
  const proc = new ManagedProcess({
    name: overrides.name || "test",
    command: NODE,
    args: [MOCK, ...mockArgs],
    cwd: os.tmpdir(),
    logFile: tmp.file,
    log: (msg) => logs.push(msg),
    ...overrides,
  });
  return { proc, logs, tmp };
}

// ─── Crash-loop behavior ────────────────────────────────────────────────

describe("crash-loop", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("escalates backoff on repeated immediate exits", async () => {
    ({ proc, logs, tmp } = mockProc(["--exit-after", "0", "--exit-code", "1"]));
    proc.start();

    // Wait for 3 restart cycles: 0→exit→2s wait→start→exit→4s wait→start→exit
    // Total: ~6s
    await sleep(7000);

    assert.ok(proc.restarts >= 3, `Expected >=3 restarts, got ${proc.restarts}`);
    // Verify backoff progression in logs
    assert.ok(logs.some((l) => l.includes("restart #1 in 2s")));
    assert.ok(logs.some((l) => l.includes("restart #2 in 4s")));
    assert.ok(logs.some((l) => l.includes("restart #3 in 8s")));
  });
});

// ─── Simultaneous crashes ───────────────────────────────────────────────

describe("simultaneous crashes", () => {
  const procs = [];
  const tmps = [];

  afterEach(() => {
    for (const p of procs) p.stop();
    procs.length = 0;
    for (const t of tmps) t.cleanup();
    tmps.length = 0;
  });

  it("all 3 processes restart independently after crashing at the same time", async () => {
    const allLogs = [];
    for (let i = 0; i < 3; i++) {
      const { proc, logs, tmp } = mockProc(
        ["--crash-after", "200", "--exit-code", "1"],
        { name: `svc-${i}` }
      );
      procs.push(proc);
      tmps.push(tmp);
      allLogs.push(logs);
    }

    for (const p of procs) p.start();
    await sleep(3000);

    // All should have restarted at least once.
    for (let i = 0; i < 3; i++) {
      assert.ok(
        procs[i].restarts >= 1,
        `svc-${i} should have restarted, got ${procs[i].restarts}`
      );
    }
    // Each restarted independently (check each has its own restart log).
    for (const logs of allLogs) {
      assert.ok(logs.some((l) => l.includes("scheduling restart #1")));
    }
  });
});

// ─── Cascading isolation ────────────────────────────────────────────────

describe("cascading isolation", () => {
  const procs = [];
  const tmps = [];

  afterEach(() => {
    for (const p of procs) p.stop();
    procs.length = 0;
    for (const t of tmps) t.cleanup();
    tmps.length = 0;
  });

  it("one crashing process does not affect stable ones", async () => {
    const crasher = mockProc(["--crash-after", "100", "--exit-code", "1"], { name: "crasher" });
    const stable1 = mockProc(["--exit-after", "30000"], { name: "stable1" });
    const stable2 = mockProc(["--exit-after", "30000"], { name: "stable2" });
    procs.push(crasher.proc, stable1.proc, stable2.proc);
    tmps.push(crasher.tmp, stable1.tmp, stable2.tmp);

    crasher.proc.start();
    stable1.proc.start();
    stable2.proc.start();

    await sleep(1500);

    assert.ok(crasher.proc.restarts >= 1, "crasher should have restarted");
    assert.equal(stable1.proc.alive, true, "stable1 should still be alive");
    assert.equal(stable2.proc.alive, true, "stable2 should still be alive");
    assert.equal(stable1.proc.restarts, 0, "stable1 should have 0 restarts");
    assert.equal(stable2.proc.restarts, 0, "stable2 should have 0 restarts");
  });
});

// ─── Hung process (SIGTERM ignored → SIGKILL) ──────────────────────────

describe("hung process", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("force-kills after 5s when SIGTERM is ignored", async () => {
    ({ proc, logs, tmp } = mockProc(["--ignore-sigterm"]));
    proc.start();
    await sleep(300);
    assert.equal(proc.alive, true);

    proc.stop();
    // SIGTERM sent immediately, SIGKILL after 5s.
    await sleep(6500);

    assert.equal(proc.alive, false, "process should be dead after force kill");
    assert.ok(logs.some((l) => l.includes("force killing")));
  });
});

// ─── Double-restart guard ───────────────────────────────────────────────

describe("double-restart guard", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("_restartScheduled prevents duplicate restart timers", async () => {
    ({ proc, logs, tmp } = mockProc(["--exit-after", "0", "--exit-code", "1"]));
    proc.start();
    await sleep(500);

    // Count how many "scheduling restart #1" messages there are.
    // Should be exactly 1 (not 2 from both error and exit).
    const restart1Logs = logs.filter((l) => l.includes("scheduling restart #1"));
    assert.equal(restart1Logs.length, 1, `Expected 1 restart #1 log, got ${restart1Logs.length}`);
  });
});

// ─── Recovery timing ────────────────────────────────────────────────────

describe("recovery timing", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("restart delays match expected backoff progression", async () => {
    const startTimes = [];
    ({ proc, logs, tmp } = mockProc(["--exit-after", "0", "--exit-code", "1"]));

    // Capture start timestamps by watching for "started pid=" logs.
    const origLog = proc._log;
    proc._log = (msg) => {
      origLog(msg);
      if (msg.includes("started pid=")) {
        startTimes.push(Date.now());
      }
    };

    proc.start();
    // Wait for 3 starts: initial + 2 restarts (need ~6s: 2s + 4s backoff).
    await sleep(7000);

    assert.ok(startTimes.length >= 3, `Expected >=3 starts, got ${startTimes.length}`);

    // Gap between start 1 and 2 should be ~2s (backoff #1).
    const gap1 = startTimes[1] - startTimes[0];
    assert.ok(gap1 >= 1800 && gap1 <= 3000, `First restart gap should be ~2s, got ${gap1}ms`);

    // Gap between start 2 and 3 should be ~4s (backoff #2).
    const gap2 = startTimes[2] - startTimes[1];
    assert.ok(gap2 >= 3500 && gap2 <= 5500, `Second restart gap should be ~4s, got ${gap2}ms`);
  });
});

// ─── Backoff cap ────────────────────────────────────────────────────────

describe("backoff cap", () => {
  it("backoffDelay never exceeds 60s regardless of attempt count", () => {
    for (let attempt = 1; attempt <= 200; attempt++) {
      const delay = ManagedProcess.backoffDelay(attempt);
      assert.ok(delay <= 60_000, `attempt ${attempt}: delay ${delay} exceeds 60s`);
    }
  });

  it("reaches 60s cap at attempt 6", () => {
    assert.equal(ManagedProcess.backoffDelay(5), 32000);
    assert.equal(ManagedProcess.backoffDelay(6), 60000);
  });
});

// ─── Backoff reset ──────────────────────────────────────────────────────

describe("backoff reset after healthy run", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("resets restart count when process ran >5 minutes", async () => {
    ({ proc, logs, tmp } = mockProc(["--exit-after", "50", "--exit-code", "1"]));

    // Simulate prior restarts.
    proc.restarts = 10;
    proc.start();
    // Backdate startedAt so uptime looks like 6 minutes.
    proc.startedAt = Date.now() - 6 * 60_000;
    await sleep(300);

    // After exit, restarts should have been reset to 0, then incremented to 1.
    assert.equal(proc.restarts, 1);
    assert.ok(logs.some((l) => l.includes("resetting backoff")));
  });
});

