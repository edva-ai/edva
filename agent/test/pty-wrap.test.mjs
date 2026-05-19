// pty-wrap.test.mjs — tests for the Python PTY wrapper.
//
// IMPORTANT: These tests require PTY device access, which is blocked by
// sandbox environments. They will skip gracefully when PTY is unavailable.
// Run on the Mac Mini directly for full coverage.
//
// Run: node --test agent/test/pty-wrap.test.mjs

import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(__dirname, "mock-service.mjs");
const PTY_WRAP = path.join(__dirname, "..", "bin", "pty-wrap.py");
const PYTHON = "/opt/homebrew/bin/python3";
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Check if PTY allocation works in this environment.
function canAllocatePty() {
  try {
    execSync(`${PYTHON} -c "import pty; pty.openpty()"`, {
      stdio: "pipe",
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

// Helper: spawn pty-wrap with mock-service and collect output.
function spawnPty(mockArgs) {
  const proc = spawn(PYTHON, [PTY_WRAP, "--", NODE, MOCK, ...mockArgs], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  proc.stdout.on("data", (buf) => stdout.push(buf.toString()));
  proc.stderr.on("data", (buf) => stderr.push(buf.toString()));

  const waitForExit = (timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitForExit timed out")), timeoutMs);
      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

  const waitForOutput = (pattern, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for "${pattern}". Got: ${stdout.join("")}`)),
        timeoutMs
      );
      const check = () => {
        if (stdout.join("").includes(pattern)) {
          clearTimeout(timer);
          resolve();
        }
      };
      check();
      proc.stdout.on("data", check);
    });

  return { proc, stdout, stderr, waitForExit, waitForOutput };
}

describe("pty-wrap.py", () => {
  let active = null;
  let ptyAvailable = false;

  before(() => {
    ptyAvailable = canAllocatePty();
    if (!ptyAvailable) {
      console.log("  ⚠ PTY allocation unavailable (sandbox?) — skipping PTY tests");
    }
  });

  afterEach(() => {
    if (active?.proc?.exitCode === null && active?.proc?.signalCode === null) {
      active.proc.kill("SIGKILL");
    }
    active = null;
  });

  it("child process sees a real TTY", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--report-tty", "--exit-after", "500"]);
    await active.waitForOutput("TTY=");
    const out = active.stdout.join("");
    assert.ok(out.includes("TTY=true"), `Expected TTY=true, got: ${out}`);
    await active.waitForExit();
  });

  it("proxies stdout from child to parent", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--output", "hello-pty-test", "--exit-after", "500"]);
    await active.waitForOutput("hello-pty-test");
    assert.ok(active.stdout.join("").includes("hello-pty-test"));
    await active.waitForExit();
  });

  it("proxies stdin from parent to child", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--echo-stdin", "--exit-on-stdin", "quit"]);
    await sleep(500);
    active.proc.stdin.write("roundtrip-test\n");
    await active.waitForOutput("roundtrip-test");
    active.proc.stdin.write("quit\n");
    await active.waitForExit();
    assert.ok(active.stdout.join("").includes("roundtrip-test"));
  });

  it("forwards SIGTERM to child", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--output", "started"]);
    await active.waitForOutput("started");
    active.proc.kill("SIGTERM");
    const { code, signal } = await active.waitForExit();
    assert.ok(
      code !== null || signal !== null,
      `Expected pty-wrap to exit, got code=${code} signal=${signal}`
    );
  });

  it("propagates child exit code", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--exit-after", "200", "--exit-code", "42"]);
    const { code } = await active.waitForExit();
    assert.equal(code, 42);
  });

  it("handles child crash cleanly", { skip: !canAllocatePty() && "PTY unavailable" }, async () => {
    active = spawnPty(["--crash-after", "200", "--exit-code", "7"]);
    const { code } = await active.waitForExit();
    assert.equal(code, 7);
  });
});
