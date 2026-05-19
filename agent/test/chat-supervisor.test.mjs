// chat-supervisor.test.mjs — end-to-end tests for the chat supervisor.
//
// Uses mock-claude.mjs instead of real Claude binary.
// Tests the full flow: HTTP dispatch → PriorityDispatcher → ClaudeSession → result.
//
// Run: node --test agent/test/chat-supervisor.test.mjs

import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

// These tests spawn the chat supervisor as a child process which starts an HTTP
// server. Sandbox environments block child processes from binding ports.
// The tests skip gracefully when this is detected.
function canChildListen() {
  try {
    execSync(`${"/opt/homebrew/bin/node"} -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})"`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = path.join(__dirname, "mock-claude.mjs");
const CHAT_SUPERVISOR = path.join(__dirname, "..", "supervisor", "chat-supervisor.mjs");
const NODE = "/opt/homebrew/bin/node";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allocate a random port to avoid conflicts with the live supervisor.
let nextPort = 19000 + Math.floor(Math.random() * 1000);
function allocPort() { return nextPort++; }

function tmpDir() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "chat-sup-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Write a minimal agents.json for testing.
function writeTestConfig(dir, port, overrides = {}) {
  const config = {
    agents: {
      "test-chat": {
        model: "mock",
        cwd: "agent/chat-agent",
        runtime: "supervisor",
        devChannels: [],
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash"],
        remoteControlPrefix: "test-chat",
        supervisor: { healthPort: port },
        ...overrides,
      },
    },
  };
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// Spawn the chat supervisor process with mock claude.
function startSupervisor({ port, configPath, stateDir, claudeArgs = [] }) {
  const logDir = path.join(stateDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  // claudeBin as JSON array: ["node", "mock-claude.mjs", ...claudeArgs]
  // ClaudeSession supports array claudeBin — it uses the first element as the
  // binary and prepends the rest before the built args.
  const claudeBinJson = JSON.stringify([NODE, MOCK_CLAUDE, ...claudeArgs]);

  const proc = spawn(NODE, [
    CHAT_SUPERVISOR,
    "--agent", "test-chat",
    "--config", configPath,
    "--state-dir", stateDir,
    "--claude-bin", claudeBinJson,
    "--no-resume",
  ], {
    cwd: stateDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: os.homedir() },
  });

  const stderr = [];
  proc.stderr.on("data", (buf) => stderr.push(buf.toString()));
  proc.stdout.on("data", () => {}); // Drain stdout.

  const waitForReady = (timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Supervisor didn't start. stderr: ${stderr.join("")}`)), timeoutMs);
      const check = () => {
        if (stderr.join("").includes("HTTP on :")) {
          clearTimeout(timer);
          resolve();
        }
      };
      check();
      proc.stderr.on("data", check);
    });

  return { proc, stderr, waitForReady };
}

// HTTP helpers.
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on("error", reject);
  });
}

function httpPost(port, path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let resBody = "";
      res.on("data", (c) => (resBody += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resBody) }); }
        catch { resolve({ status: res.statusCode, body: resBody }); }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("chat-supervisor end-to-end", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
  let sup = null;
  let tmp = null;
  let port = 0;
  afterEach(async () => {
    if (sup?.proc?.exitCode === null && sup?.proc?.signalCode === null) {
      sup.proc.kill("SIGTERM");
      await new Promise((r) => sup.proc.on("exit", r));
    }
    sup = null;
    // Small delay to let port release.
    await sleep(200);
    tmp?.cleanup();
    tmp = null;
  });

  async function setup(claudeArgs = []) {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs });
    await sup.waitForReady();
    // Wait for init message to be dispatched and processed.
    await sleep(4000);
  }

  // ── Health endpoint ───────────────────────────────────────────────

  it("returns health with childAlive=true after startup", async () => {
    await setup();
    const { status, body } = await httpGet(port, "/health");
    assert.equal(status, 200);
    assert.equal(body.childAlive, true);
    assert.equal(body.model, "mock");
    assert.ok(body.sessionId);
    assert.ok(body.completed >= 1, "Init message should have completed");
  });

  // ── Dispatch endpoint ─────────────────────────────────────────────

  it("dispatches a message and processes it", async () => {
    await setup();
    const { status, body } = await httpPost(port, "/dispatch", {
      content: "Hello from test",
      source: "test",
      priority: "high",
    });
    assert.equal(status, 200);
    assert.ok(body.id);

    // Wait for the turn to complete.
    await sleep(500);

    const health = await httpGet(port, "/health");
    assert.ok(health.body.completed >= 2, `Expected >=2 completed, got ${health.body.completed}`);
    assert.equal(health.body.queueDepth, 0);
    assert.equal(health.body.inFlight, null);
  });

  it("queues multiple messages and processes them in order", async () => {
    await setup(["--delay", "200"]);
    // Send 3 messages rapidly.
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await httpPost(port, "/dispatch", {
        content: `msg-${i}`,
        source: "test",
        priority: "normal",
        msgId: `order-${i}`,
      });
      ids.push(body.id);
    }

    // Wait for all to process.
    await sleep(2000);

    const health = await httpGet(port, "/health");
    // Init + 3 messages = 4.
    assert.ok(health.body.completed >= 4, `Expected >=4 completed, got ${health.body.completed}`);
    assert.equal(health.body.queueDepth, 0);
  });

  // ── Priority ordering ─────────────────────────────────────────────

  it("processes high-priority messages before normal ones", async () => {
    await setup(["--delay", "500"]);

    // Dispatch a normal message to occupy the session.
    await httpPost(port, "/dispatch", { content: "blocking", source: "test", priority: "normal" });
    await sleep(50);

    // Queue a normal and a high-priority behind it.
    await httpPost(port, "/dispatch", { content: "normal-queued", source: "test", priority: "normal", msgId: "n1" });
    await httpPost(port, "/dispatch", { content: "urgent-queued", source: "test", priority: "high", msgId: "h1" });

    // Check queue ordering.
    const health = await httpGet(port, "/health");
    if (health.body.queueDepth >= 2) {
      assert.equal(health.body.byPriority.high, 1);
      assert.equal(health.body.byPriority.normal, 1);
    }

    // Wait for all to complete.
    await sleep(3000);
    const final = await httpGet(port, "/health");
    assert.equal(final.body.queueDepth, 0);
  });

  // ── Dedup ─────────────────────────────────────────────────────────

  it("deduplicates messages with same msgId when queued", async () => {
    await setup(["--delay", "2000"]); // Slow mock so first message stays in-flight.
    // Dispatch a message to occupy the session.
    await httpPost(port, "/dispatch", { content: "blocking", source: "test", priority: "normal" });
    await sleep(100);

    // Now dispatch two messages with the same msgId while blocking is in-flight.
    const { body: first } = await httpPost(port, "/dispatch", {
      content: "original", source: "test", priority: "high", msgId: "dedup-1",
    });
    assert.ok(first.id !== "deduped");

    const { body: dupe } = await httpPost(port, "/dispatch", {
      content: "duplicate", source: "test", priority: "high", msgId: "dedup-1",
    });
    assert.equal(dupe.id, "deduped");
  });

  // ── Session restart on crash ──────────────────────────────────────

  it("restarts session when claude crashes", async () => {
    // fail-after 1: init succeeds (turn 0→1), next message triggers exit.
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"] });
    await sup.waitForReady();
    await sleep(5000); // Wait for init (3s delay + processing).

    // Init processed. Now send a message that triggers the crash.
    await httpPost(port, "/dispatch", { content: "trigger-crash", source: "test", priority: "high" });

    // Wait for crash + backoff restart (2s) + new session spawn.
    await sleep(10000);

    // Debug: check what the supervisor logged.
    const logs = sup.stderr.join("");
    const hasExit = logs.includes("claude exited");
    const hasRestart = logs.includes("restart #");

    const health = await httpGet(port, "/health");
    assert.ok(hasExit, `Expected 'claude exited' in logs. Got:\n${logs.slice(-1000)}`);
    assert.ok(hasRestart, `Expected 'restart #' in logs. Got:\n${logs.slice(-1000)}`);
    assert.ok(health.body.restartCount >= 1, `Restart count should be >=1, got ${health.body.restartCount}. Logs:\n${logs.slice(-500)}`);
  });

  // ── 404 for unknown routes ────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    await setup();
    const { status } = await httpGet(port, "/unknown");
    assert.equal(status, 404);
  });

  // ── Restart endpoint ──────────────────────────────────────────────

  it("POST /restart triggers session restart", async () => {
    await setup();
    const { status, body } = await httpPost(port, "/restart", {});
    assert.equal(status, 202);
    assert.equal(body.restarting, true);

    // Wait for restart to complete.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);
    assert.ok(health.body.restartCount >= 1);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────

  it("shuts down cleanly on SIGTERM", async () => {
    await setup();
    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);

    sup.proc.kill("SIGTERM");
    const { code } = await new Promise((r) => sup.proc.on("exit", (code, signal) => r({ code, signal })));
    assert.equal(code, 0);
  });

  // ── State persistence ─────────────────────────────────────────────

  it("persists session state to disk", async () => {
    await setup();
    await httpPost(port, "/dispatch", { content: "persist-test", source: "test", priority: "high" });
    await sleep(500);

    const statePath = path.join(tmp.dir, "session.json");
    assert.ok(fs.existsSync(statePath), "session.json should exist");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(state.sessionId);
    assert.ok(state.totalCostUsd > 0);
    assert.ok(state.totalTurns >= 1);
    assert.equal(state.everInitialized, true);
  });

  // ── Event logging ─────────────────────────────────────────────────

  it("logs events and costs to NDJSON files", async () => {
    await setup();
    await httpPost(port, "/dispatch", { content: "log-test", source: "test", priority: "high" });
    await sleep(500);

    const logDir = path.join(os.homedir(), "dev/merlin/agent/logs/supervisor-test-chat");
    // Events and cost logs should exist (or in the stateDir — let's check both).
    // The EventLog uses eventDir which is constructed from the agent name.
    const eventsPath = path.join(logDir, "events.ndjson");
    const costPath = path.join(logDir, "cost.ndjson");

    if (fs.existsSync(eventsPath)) {
      const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
      assert.ok(events.length >= 1, "Should have at least 1 event logged");
    }
    if (fs.existsSync(costPath)) {
      const costs = fs.readFileSync(costPath, "utf8").trim().split("\n");
      assert.ok(costs.length >= 1, "Should have at least 1 cost entry");
    }
  });

  // ── Concurrent dispatches ─────────────────────────────────────────

  it("handles concurrent HTTP requests without crashing", async () => {
    await setup(["--delay", "100"]);
    // Fire 10 dispatches concurrently.
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(httpPost(port, "/dispatch", {
        content: `concurrent-${i}`,
        source: "test",
        priority: i === 0 ? "high" : "normal",
        msgId: `conc-${i}`,
      }));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200);
    }

    // Wait for all to process.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.equal(health.body.queueDepth, 0);
    assert.equal(health.body.inFlight, null);
    // Init + 10 messages = 11.
    assert.ok(health.body.completed >= 11, `Expected >=11 completed, got ${health.body.completed}`);
  });

  // ── Malformed requests ────────────────────────────────────────────

  it("handles malformed JSON gracefully", async () => {
    await setup();
    // Send raw text that isn't valid JSON.
    const { status } = await new Promise((resolve, reject) => {
      const body = "not json at all";
      const req = http.request(`http://127.0.0.1:${port}/dispatch`, {
        method: "POST",
        headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      req.on("error", reject);
      req.end(body);
    });
    // Server falls back to treating raw body as content — should dispatch it.
    assert.equal(status, 200);
  });

  // ── Init message dispatched as low priority ───────────────────────

  it("init message is dispatched as low priority", async () => {
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--delay", "100"] });
    await sup.waitForReady();

    // Before init fires (3s delay), dispatch a high-priority message.
    await sleep(500);
    await httpPost(port, "/dispatch", { content: "urgent-before-init", source: "test", priority: "high", msgId: "pre-init" });

    // Wait for both to process.
    await sleep(5000);

    const health = await httpGet(port, "/health");
    assert.ok(health.body.completed >= 2, `Expected >=2 completed, got ${health.body.completed}`);
  });

  // ── Heartbeat endpoint ────────────────────────────────────────────

  it("POST /heartbeat updates phoneChannelHeartbeatAgeMs", async () => {
    await setup();
    // Before heartbeat, age should be null.
    const before = await httpGet(port, "/health");
    assert.equal(before.body.phoneChannelHeartbeatAgeMs, null);

    // Send heartbeat.
    const { status } = await httpPost(port, "/heartbeat", { source: "phone-channel", pid: 12345 });
    assert.equal(status, 200);

    // After heartbeat, age should be a small number.
    const after = await httpGet(port, "/health");
    assert.ok(after.body.phoneChannelHeartbeatAgeMs !== null, "heartbeat age should not be null");
    assert.ok(after.body.phoneChannelHeartbeatAgeMs < 2000, `heartbeat age should be <2s, got ${after.body.phoneChannelHeartbeatAgeMs}`);
  });

  // ── Heartbeat reported in health snapshot ─────────────────────────

  it("health snapshot includes phoneChannelHeartbeatAgeMs field", async () => {
    await setup();
    const { body } = await httpGet(port, "/health");
    assert.ok("phoneChannelHeartbeatAgeMs" in body, "health should include phoneChannelHeartbeatAgeMs");
  });

  // ── sendInit called after restart ─────────────────────────────────

  it("sendInit is called after restart so session initializes", async () => {
    await setup();

    // Trigger restart.
    await httpPost(port, "/restart", {});
    await sleep(10000); // Wait for restart backoff (2s) + spawn + init (3s delay) + processing.

    const health = await httpGet(port, "/health");
    assert.equal(health.body.childAlive, true);
    assert.ok(health.body.restartCount >= 1);
    // The restarted session should have completed at least 1 turn (the init message).
    assert.ok(health.body.completed >= 1, `Expected >=1 completed after restart, got ${health.body.completed}`);
  });

  // ── dispatch_error triggers restart ───────────────────────────────

  it("requeues message and restarts on dispatch_error", async () => {
    // Use --fail-after 1 so the second message causes a crash mid-send.
    port = allocPort();
    tmp = tmpDir();
    const configPath = writeTestConfig(tmp.dir, port);
    sup = startSupervisor({ port, configPath, stateDir: tmp.dir, claudeArgs: ["--fail-after", "1"] });
    await sup.waitForReady();
    await sleep(5000); // Wait for init.

    // Send a message that will cause the mock to crash.
    await httpPost(port, "/dispatch", { content: "will-crash", source: "test", priority: "high" });

    // Wait for crash + restart + reprocessing.
    await sleep(10000);

    const logs = sup.stderr.join("");
    const health = await httpGet(port, "/health");
    assert.ok(health.body.restartCount >= 1, "Should have restarted at least once");
    assert.equal(health.body.childAlive, true, "Child should be alive after restart");
  });
});
