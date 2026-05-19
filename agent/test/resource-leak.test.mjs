// resource-leak.test.mjs — detect FD, timer, and memory leaks across restart cycles.
//
// Run: node --expose-gc --test agent/test/resource-leak.test.mjs
//
// The --expose-gc flag enables explicit garbage collection for accurate
// memory measurements. Tests still pass without it but memory assertions
// use a more generous threshold.

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
const gc = typeof globalThis.gc === "function" ? globalThis.gc : () => {};

function tmpLog() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "leak-test-"));
  const file = path.join(dir, "test.log");
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function countResources(type) {
  // process.getActiveResourcesInfo() returns string[] of active resource types.
  if (typeof process.getActiveResourcesInfo !== "function") return -1;
  return process.getActiveResourcesInfo().filter((r) => r === type).length;
}

// ─── File descriptor leaks ──────────────────────────────────────────────

describe("file descriptor leaks", () => {
  it("no FD leak across 30 start/stop cycles", async () => {
    const tmp = tmpLog();
    const logs = [];
    let proc;

    try {
      // Warm up: one full cycle to establish baseline.
      proc = new ManagedProcess({
        name: "fd-test",
        command: NODE,
        args: [MOCK, "--exit-after", "50"],
        cwd: os.tmpdir(),
        logFile: tmp.file,
        log: (msg) => logs.push(msg),
      });
      proc.start();
      await sleep(200);
      proc.stop();
      await sleep(200);

      gc();
      await sleep(100);
      const baselineFDs = countResources("FSReqCallback") + countResources("WriteStream");

      // Run 30 cycles.
      for (let i = 0; i < 30; i++) {
        proc = new ManagedProcess({
          name: "fd-test",
          command: NODE,
          args: [MOCK, "--exit-after", "30"],
          cwd: os.tmpdir(),
          logFile: tmp.file,
          log: () => {},
        });
        proc.start();
        await sleep(100);
        proc.stop();
        await sleep(100);
      }

      gc();
      await sleep(100);
      const finalFDs = countResources("FSReqCallback") + countResources("WriteStream");

      if (baselineFDs >= 0) {
        const growth = finalFDs - baselineFDs;
        assert.ok(growth <= 3, `FD growth of ${growth} across 30 cycles (baseline=${baselineFDs}, final=${finalFDs})`);
      }
    } finally {
      proc?.stop();
      tmp.cleanup();
    }
  });
});

// ─── Timer leaks ────────────────────────────────────────────────────────

describe("timer leaks", () => {
  it("no timer leak across 20 restart cycles", async () => {
    const tmp = tmpLog();
    let proc;

    try {
      gc();
      await sleep(50);
      const baselineTimers = countResources("Timeout");

      proc = new ManagedProcess({
        name: "timer-test",
        command: NODE,
        args: [MOCK, "--exit-after", "30", "--exit-code", "1"],
        cwd: os.tmpdir(),
        logFile: tmp.file,
        log: () => {},
      });

      proc.start();
      // Let it crash and restart 20 times.
      // First 5 restarts: 2+4+8+16+32 = 62s... that's too slow.
      // Instead, manually trigger rapid restarts.
      for (let i = 0; i < 20; i++) {
        await sleep(100); // Let it start and exit.
        // The auto-restart timer will be pending. Stop to clear it.
        proc.stop();
        await sleep(50);
        // Reset for next cycle.
        proc.stopping = false;
        proc._restartScheduled = false;
        proc.start();
      }

      proc.stop();
      await sleep(200);

      gc();
      await sleep(50);
      const finalTimers = countResources("Timeout");

      if (baselineTimers >= 0) {
        const growth = finalTimers - baselineTimers;
        // Allow 2 timers tolerance (test framework's own timers).
        assert.ok(growth <= 2, `Timer growth of ${growth} across 20 cycles (baseline=${baselineTimers}, final=${finalTimers})`);
      }
    } finally {
      proc?.stop();
      tmp.cleanup();
    }
  });
});

// ─── Log stream cleanup ────────────────────────────────────────────────

describe("log stream cleanup", () => {
  it("_logStream is null after every process exit", async () => {
    const tmp = tmpLog();
    let proc;

    try {
      proc = new ManagedProcess({
        name: "stream-test",
        command: NODE,
        args: [MOCK, "--exit-after", "30", "--exit-code", "1"],
        cwd: os.tmpdir(),
        logFile: tmp.file,
        log: () => {},
      });

      for (let i = 0; i < 10; i++) {
        proc.stopping = false;
        proc._restartScheduled = false;
        proc.start();
        await sleep(150); // Let it exit.
        // Log stream should be cleaned up by exit handler.
        assert.equal(proc._logStream, null, `Cycle ${i}: _logStream should be null after exit`);
        proc.stop();
        await sleep(50);
      }
    } finally {
      proc?.stop();
      tmp.cleanup();
    }
  });
});

// ─── Memory stability ──────────────────────────────────────────────────

describe("memory stability", () => {
  it("heap does not grow unboundedly across 30 start/stop cycles", async () => {
    const tmp = tmpLog();
    let proc;

    try {
      gc();
      await sleep(50);
      const baselineHeap = process.memoryUsage().heapUsed;

      for (let i = 0; i < 30; i++) {
        proc = new ManagedProcess({
          name: "mem-test",
          command: NODE,
          args: [MOCK, "--exit-after", "30"],
          cwd: os.tmpdir(),
          logFile: tmp.file,
          log: () => {},
        });
        proc.start();
        await sleep(100);
        proc.stop();
        await sleep(100);
      }

      gc();
      await sleep(100);
      const finalHeap = process.memoryUsage().heapUsed;
      const growthMB = (finalHeap - baselineHeap) / 1024 / 1024;

      // Allow up to 20MB growth (generous for GC non-determinism).
      assert.ok(
        growthMB < 20,
        `Heap grew ${growthMB.toFixed(1)}MB across 30 cycles — possible memory leak`
      );
    } finally {
      proc?.stop();
      tmp.cleanup();
    }
  });
});
