// managed-process.test.mjs — tests for ManagedProcess and ChatPromptHandler.
//
// Run: node --test agent/test/managed-process.test.mjs

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ManagedProcess } from "../lib/managed-process.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper: create a temporary log file path that auto-cleans.
function tmpLog() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "pm-test-"));
  const file = path.join(dir, "test.log");
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Helper: create a ManagedProcess that runs a short-lived command.
function makeProc(overrides = {}) {
  const tmp = tmpLog();
  const logs = [];
  const proc = new ManagedProcess({
    name: "test",
    command: "/bin/sh",
    args: ["-c", 'echo "hello"'],
    cwd: os.tmpdir(),
    logFile: tmp.file,
    log: (msg) => logs.push(msg),
    ...overrides,
  });
  return { proc, logs, tmp };
}

// ─── ManagedProcess.backoffDelay ────────────────────────────────────────

describe("backoffDelay", () => {
  it("starts at 2s for attempt 1", () => {
    assert.equal(ManagedProcess.backoffDelay(1), 2000);
  });

  it("doubles each attempt", () => {
    assert.equal(ManagedProcess.backoffDelay(2), 4000);
    assert.equal(ManagedProcess.backoffDelay(3), 8000);
    assert.equal(ManagedProcess.backoffDelay(4), 16000);
  });

  it("caps at 60s for high attempts", () => {
    // attempt 6: min(2000 * 2^5, 60000) = min(64000, 60000) = 60000
    assert.equal(ManagedProcess.backoffDelay(6), 60000);
    assert.equal(ManagedProcess.backoffDelay(10), 60000);
    assert.equal(ManagedProcess.backoffDelay(100), 60000);
  });

  it("follows correct progression", () => {
    const expected = [2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(
        ManagedProcess.backoffDelay(i + 1),
        expected[i],
        `attempt ${i + 1}`
      );
    }
  });
});

// ─── ManagedProcess.start / lifecycle ───────────────────────────────────

describe("ManagedProcess lifecycle", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("spawns a process and reports alive", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "sleep 10"],
    }));
    proc.start();
    await sleep(100);
    assert.equal(proc.alive, true);
    assert.ok(proc.proc.pid > 0);
    assert.ok(logs.some((l) => l.includes("started pid=")));
  });

  it("reports not alive before start", () => {
    ({ proc, logs, tmp } = makeProc());
    assert.equal(proc.alive, false);
  });

  it("logs stdout to file", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", 'echo "test-output-xyz"'],
    }));
    proc.start();
    await sleep(300);
    const content = fs.readFileSync(tmp.file, "utf8");
    assert.ok(content.includes("test-output-xyz"));
  });

  it("logs stderr to file", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", 'echo "err-output" >&2'],
    }));
    proc.start();
    await sleep(300);
    const content = fs.readFileSync(tmp.file, "utf8");
    assert.ok(content.includes("err-output"));
  });

  it("calls onData with stdout content", async () => {
    const received = [];
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", 'echo "callback-data"'],
      onData: (data) => received.push(data),
    }));
    proc.start();
    await sleep(300);
    assert.ok(received.some((d) => d.includes("callback-data")));
  });

  it("does not call onData for stderr", async () => {
    const received = [];
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", 'echo "secret" >&2'],
      onData: (data) => received.push(data),
    }));
    proc.start();
    await sleep(300);
    assert.equal(received.length, 0);
  });
});

// ─── Restart behavior ───────────────────────────────────────────────────

describe("ManagedProcess restart", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("restarts after process exits", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 1"],
    }));
    proc.start();
    // First exit + restart scheduling happens fast.
    await sleep(500);
    assert.ok(logs.some((l) => l.includes("exited code=1")));
    assert.ok(logs.some((l) => l.includes("restart #1")));
    assert.equal(proc.restarts, 1);
  });

  it("increments restart count on repeated failures", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 1"],
    }));
    proc.start();
    // Wait for first restart attempt (2s backoff) + second exit.
    await sleep(2500);
    assert.ok(proc.restarts >= 2);
  });

  it("does not restart when stopped", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 1"],
    }));
    proc.start();
    await sleep(100);
    proc.stop();
    const countBefore = proc.restarts;
    await sleep(3000);
    assert.equal(proc.restarts, countBefore);
  });

  it("resets restart count after healthy run (>5 min)", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 0"],
    }));
    // Simulate a process that ran for 6 minutes by backdating startedAt.
    proc.start();
    proc.startedAt = Date.now() - 6 * 60_000;
    await sleep(200);
    // After exit, restarts should reset to 0, then increment to 1.
    assert.equal(proc.restarts, 1);
  });
});

// ─── Spawn error handling ───────────────────────────────────────────────

describe("ManagedProcess spawn error", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("handles ENOENT (missing binary) and schedules restart", async () => {
    ({ proc, logs, tmp } = makeProc({
      command: "/nonexistent/binary",
      args: [],
    }));
    proc.start();
    await sleep(300);
    assert.ok(logs.some((l) => l.includes("spawn error")));
    assert.ok(logs.some((l) => l.includes("restart #1")));
  });

  it("closes log stream on spawn error", async () => {
    ({ proc, logs, tmp } = makeProc({
      command: "/nonexistent/binary",
      args: [],
    }));
    proc.start();
    await sleep(300);
    assert.equal(proc._logStream, null);
  });
});

// ─── stop() ─────────────────────────────────────────────────────────────

describe("ManagedProcess stop", () => {
  let proc, logs, tmp;

  afterEach(() => {
    tmp?.cleanup();
  });

  it("sends SIGTERM to running process", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "trap '' TERM; sleep 60"],
    }));
    proc.start();
    await sleep(200);
    assert.equal(proc.alive, true);
    proc.stop();
    // Process traps TERM, so it stays alive until force-kill.
    await sleep(100);
    assert.equal(proc.stopping, true);
  });

  it("force kills after 5s if SIGTERM is ignored", async () => {
    ({ proc, logs, tmp } = makeProc({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    }));
    proc.start();
    await sleep(200);
    assert.equal(proc.alive, true);
    proc.stop();
    // Wait for force kill (5s + margin).
    await sleep(6500);
    assert.equal(proc.alive, false);
    assert.ok(logs.some((l) => l.includes("force killing")));
  });

  it("clears restart timer on stop", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 1"],
    }));
    proc.start();
    await sleep(100); // Let it exit and schedule restart.
    proc.stop();
    const restartsBefore = proc.restarts;
    await sleep(3000);
    // No more restarts should happen.
    assert.equal(proc.restarts, restartsBefore);
  });

  it("is idempotent", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "sleep 10"],
    }));
    proc.start();
    await sleep(100);
    proc.stop();
    proc.stop(); // Should not throw.
    await sleep(200);
  });

  it("handles stop before start", () => {
    ({ proc, logs, tmp } = makeProc());
    proc.stop(); // Should not throw.
    assert.equal(proc.stopping, true);
  });
});

// ─── write() ────────────────────────────────────────────────────────────

describe("ManagedProcess write", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("writes to stdin of child process", async () => {
    const received = [];
    ({ proc, logs, tmp } = makeProc({
      // cat reads stdin and echoes to stdout.
      args: ["-c", "cat"],
      onData: (data) => received.push(data),
    }));
    proc.start();
    await sleep(100);
    proc.write("hello-stdin\n");
    await sleep(200);
    assert.ok(received.some((d) => d.includes("hello-stdin")));
  });

  it("is safe to call before start", () => {
    ({ proc, logs, tmp } = makeProc());
    proc.write("test"); // Should not throw.
  });

  it("is safe to call after stop", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "sleep 10"],
    }));
    proc.start();
    await sleep(100);
    proc.stop();
    await sleep(200);
    proc.write("test"); // Should not throw.
  });
});

// ─── alive getter ───────────────────────────────────────────────────────

describe("ManagedProcess alive", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("is false before start", () => {
    ({ proc, logs, tmp } = makeProc());
    assert.equal(proc.alive, false);
  });

  it("is true while running", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "sleep 10"],
    }));
    proc.start();
    await sleep(100);
    assert.equal(proc.alive, true);
  });

  it("is false after exit", async () => {
    ({ proc, logs, tmp } = makeProc({
      args: ["-c", "exit 0"],
    }));
    proc.start();
    await sleep(300);
    assert.equal(proc.alive, false);
  });
});

// ─── Integration: multiple processes ────────────────────────────────────

describe("multiple independent processes", () => {
  const procs = [];
  let tmp1, tmp2;

  afterEach(() => {
    for (const p of procs) p.stop();
    procs.length = 0;
    tmp1?.cleanup();
    tmp2?.cleanup();
  });

  it("one crashing does not affect the other", async () => {
    const logs = [];
    const log = (msg) => logs.push(msg);

    tmp1 = tmpLog();
    tmp2 = tmpLog();

    const stable = new ManagedProcess({
      name: "stable",
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: os.tmpdir(),
      logFile: tmp1.file,
      log,
    });

    const crasher = new ManagedProcess({
      name: "crasher",
      command: "/bin/sh",
      args: ["-c", "exit 1"],
      cwd: os.tmpdir(),
      logFile: tmp2.file,
      log,
    });

    procs.push(stable, crasher);
    stable.start();
    crasher.start();

    await sleep(500);

    // Crasher should have exited and scheduled a restart.
    assert.ok(logs.some((l) => l.includes("[crasher] exited")));
    // Stable should still be running.
    assert.equal(stable.alive, true);
  });
});

// ─── Log file behavior ─────────────────────────────────────────────────

describe("log file", () => {
  let proc, logs, tmp;

  afterEach(() => {
    proc?.stop();
    tmp?.cleanup();
  });

  it("appends to existing log file", async () => {
    tmp = tmpLog();
    fs.writeFileSync(tmp.file, "existing-content\n");
    const logs2 = [];

    proc = new ManagedProcess({
      name: "test",
      command: "/bin/sh",
      args: ["-c", 'echo "new-content"'],
      cwd: os.tmpdir(),
      logFile: tmp.file,
      log: (msg) => logs2.push(msg),
    });
    proc.start();
    await sleep(300);

    const content = fs.readFileSync(tmp.file, "utf8");
    assert.ok(content.includes("existing-content"));
    assert.ok(content.includes("new-content"));
  });

  it("works without a logFile", async () => {
    logs = [];
    proc = new ManagedProcess({
      name: "test",
      command: "/bin/sh",
      args: ["-c", 'echo "no-log"'],
      cwd: os.tmpdir(),
      log: (msg) => logs.push(msg),
    });
    proc.start();
    await sleep(300);
    // Should not throw, process runs and exits normally.
    assert.ok(logs.some((l) => l.includes("started")));
  });
});
