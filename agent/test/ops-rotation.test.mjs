// ops-rotation.test.mjs — turn-count session rotation for the ops supervisor.
//
// Covers the cost-runaway fix: the supervisor --resume's one Claude
// session across all dispatches, so its context grows turn-by-turn and each
// cold-cache turn re-bills the whole prefix. index.mjs now rotates to a fresh
// session once `maxSessionTurns` is reached — at a turn boundary, even while the
// dispatcher is busy — plus a cold-start guard so a kill can't resurrect a
// bloated session. Uses mock-claude.mjs (1 turn per dispatch) to drive the cap.
//
// Run: node --test agent/test/ops-rotation.test.mjs

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

// These tests spawn the supervisor as a child process that binds HTTP ports.
// Sandbox environments block that; skip gracefully when detected.
function canChildListen() {
  try {
    execSync(`/opt/homebrew/bin/node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{s.close();process.exit(0)})"`, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = path.join(__dirname, "mock-claude.mjs");
const OPS_SUPERVISOR = path.join(__dirname, "..", "supervisor", "index.mjs");
const NODE = "/opt/homebrew/bin/node";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Allocate a base port; the ops supervisor binds gmail/webhook/control on
// base, base+1, base+2. Step by 10 to keep test runs from colliding.
let nextPort = 18000 + Math.floor(Math.random() * 500) * 10;
function allocBase() { const p = nextPort; nextPort += 10; return p; }

function tmpDir() {
  const base = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "ops-rot-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeTestConfig(dir, basePort, overrides = {}) {
  const config = {
    agents: {
      "test-ops": {
        model: "mock",
        cwd: "agent/ops-agent",
        runtime: "supervisor",
        devChannels: [],
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash"],
        remoteControlPrefix: "test-ops",
        supervisor: {
          gmailPubsubPort: basePort,
          webhookPort: basePort + 1,
          healthPort: basePort + 2,
        },
        ...overrides,
      },
    },
  };
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function startSupervisor({ basePort, configPath, stateDir, claudeArgs = [], resume = false, env = {} }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const claudeBinJson = JSON.stringify([NODE, MOCK_CLAUDE, ...claudeArgs]);
  const spawnArgs = [
    OPS_SUPERVISOR,
    "--agent", "test-ops",
    "--config", configPath,
    "--state-dir", stateDir,
    "--claude-bin", claudeBinJson,
  ];
  if (!resume) spawnArgs.push("--no-resume");

  const proc = spawn(NODE, spawnArgs, {
    cwd: stateDir,
    stdio: ["pipe", "pipe", "pipe"],
    // Disable the session-handoff digest by default — most tests exercise
    // rotation mechanics, not the handoff (covered in handoff-digest.test.mjs
    // and the dedicated test below), and a prepended block would change the
    // recorded content. Per-test env can override.
    // Isolate the events_fts tee (EventLog now writes into memory-index.db) into
    // the test's own state dir so tests never pollute the real wiki DB.
    env: {
      ...process.env,
      HOME: os.homedir(),
      OPS_HANDOFF_DISABLED: "1",
      MEMORY_INDEX_DB: path.join(stateDir, "event-index.db"),
      ...env,
    },
  });

  const stderr = [];
  proc.stderr.on("data", (buf) => stderr.push(buf.toString()));
  proc.stdout.on("data", () => {});

  const waitForReady = (timeoutMs = 12000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`supervisor didn't start. stderr: ${stderr.join("")}`)), timeoutMs);
      const check = () => {
        if (stderr.join("").includes("control on :")) { clearTimeout(timer); resolve(); }
      };
      check();
      proc.stderr.on("data", check);
    });

  return { proc, stderr, waitForReady };
}

// The control port POST endpoints require the webhook token when the secret
// file exists on this machine; read it best-effort (auth degrades open when
// the file is absent — checkAuth() in http-server.mjs).
function authHeaders() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), "Dev/edva/secrets/webhook-token"), "utf8").trim();
    return t ? { authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body }); } });
    }).on("error", reject);
  });
}

function httpPost(port, p, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(`http://127.0.0.1:${port}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...authHeaders() },
    }, (res) => {
      let resBody = "";
      res.on("data", (c) => (resBody += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(resBody) }); } catch { resolve({ status: res.statusCode, body: resBody }); } });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitFor(fn, { timeout = 15000, interval = 150 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return true; await sleep(interval); }
  return false;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("ops turn-count rotation", { skip: !canChildListen() && "child process cannot bind ports (sandbox)" }, () => {
  let sup = null;
  let tmp = null;
  let healthPort = 0;
  let recordPath = "";

  afterEach(async () => {
    if (sup?.proc?.exitCode === null && sup?.proc?.signalCode === null) {
      sup.proc.kill("SIGTERM");
      await new Promise((r) => sup.proc.on("exit", r));
    }
    sup = null;
    await sleep(250); // let ports release
    tmp?.cleanup();
    tmp = null;
  });

  async function setup({ maxSessionTurns, resume = false, extraClaudeArgs = [], env = {}, config = {} } = {}) {
    const base = allocBase();
    healthPort = base + 2;
    tmp = tmpDir();
    recordPath = path.join(tmp.dir, "mock-record.log");
    const overrides = { ...config };
    if (maxSessionTurns !== undefined) overrides.maxSessionTurns = maxSessionTurns;
    const configPath = writeTestConfig(tmp.dir, base, overrides);
    sup = startSupervisor({
      basePort: base, configPath, stateDir: tmp.dir,
      claudeArgs: ["--record", recordPath, "--delay", "30", ...extraClaudeArgs],
      resume, env,
    });
    await sup.waitForReady();
  }

  function dispatch(content) { return httpPost(healthPort, "/dispatch", { content, source: "rot-test" }); }

  function recordedTestMsgs() {
    let raw = "";
    try { raw = fs.readFileSync(recordPath, "utf8"); } catch { return []; }
    return raw.split("\n").map((l) => (l.match(/rot-test-\d+/) || [])[0]).filter(Boolean);
  }

  it("rotates to a fresh session at the cap and keeps draining the queue", async () => {
    await setup({ maxSessionTurns: 3 });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;
    assert.ok(initId, "should report an initial sessionId");

    const N = 8;
    for (let i = 0; i < N; i++) await dispatch(`rot-test-${i}`);

    const rotated = await waitFor(async () => (await httpGet(healthPort, "/health")).body.sessionId !== initId);
    assert.ok(rotated, `session should rotate after exceeding cap. stderr: ${sup.stderr.join("").slice(-600)}`);
    assert.ok(sup.stderr.join("").includes("TURN-COUNT ROTATION"), "should log TURN-COUNT ROTATION");
    // Rotation pauses the dispatcher to block the imminent drain — it must NOT
    // be misread as an auth outage (which would skip the restart / risk a hang).
    assert.ok(!sup.stderr.join("").includes("auth outage"), "rotation must not log a false auth outage");

    // All work drains into the (rotated) session.
    // Wait until fully settled: queue empty AND not mid-rotation. A rotation
    // transiently pauses the dispatcher before restart() swaps in a fresh
    // (unpaused) one, so we must let that settle before asserting on paused.
    const drained = await waitFor(async () => {
      const h = (await httpGet(healthPort, "/health")).body;
      return h.queueDepth === 0 && h.inFlight === null && h.dispatcherPaused === false && recordedTestMsgs().length >= N;
    });
    assert.ok(drained, "queue should drain and all messages process");

    const h = (await httpGet(healthPort, "/health")).body;
    assert.equal(h.queueDepth, 0);
    assert.equal(h.inFlight, null);
    assert.equal(h.dispatcherPaused, false, "dispatcher must not be left paused after a rotation");
    // After the last rotation the dispatch counter is reset, so it sits below the cap.
    assert.ok(h.totalDispatches < 3, `dispatches should be reset below cap, got ${h.totalDispatches}`);
    assert.equal(h.maxSessionTurns, 3, "health should surface the cap");

    // No message lost or duplicated across the rotation/restart.
    const got = recordedTestMsgs();
    const want = Array.from({ length: N }, (_, i) => `rot-test-${i}`);
    assert.deepEqual([...new Set(got)].sort(), want.sort(), "every message processed exactly once (set)");
    assert.equal(got.length, N, `no duplicates — expected ${N} records, got ${got.length}`);
  });

  it("cold-start guard: does not resume a session already past the cap", async () => {
    const base = allocBase();
    healthPort = base + 2;
    tmp = tmpDir();
    recordPath = path.join(tmp.dir, "mock-record.log");
    // Pre-seed a persisted session that already blew past the cap.
    fs.writeFileSync(path.join(tmp.dir, "session.json"), JSON.stringify({
      sessionId: "OLD-BLOATED-SESSION",
      createdAt: new Date().toISOString(),
      totalCostUsd: 0,
      totalTurns: 400,
      totalDispatches: 100,
      lastEventTs: null,
      lastResumeAt: null,
      everInitialized: true,
    }));
    const configPath = writeTestConfig(tmp.dir, base, { maxSessionTurns: 60 });
    // resume:true — the guard must override it because 100 >= 60.
    sup = startSupervisor({ basePort: base, configPath, stateDir: tmp.dir, claudeArgs: ["--delay", "30"], resume: true });
    await sup.waitForReady();

    const h = (await httpGet(healthPort, "/health")).body;
    assert.notEqual(h.sessionId, "OLD-BLOATED-SESSION", "must not resume the bloated session");
    assert.ok(sup.stderr.join("").includes("starting fresh instead of resuming"), "should log the cold-start guard");
  });

  it("injects /compact when context crosses the threshold instead of rotating", async () => {
    // Turn rotation disabled (maxSessionTurns:0) so the ONLY lifecycle action is
    // the context guard. mock emits 5000-token usage per turn; compact threshold
    // set to 1000 and rotate threshold set absurdly high so the guard compacts
    // (never rotates). Fast guard interval + cooldown so the test doesn't wait.
    await setup({
      maxSessionTurns: 0,
      extraClaudeArgs: ["--emit-usage", "5000"],
      env: {
        OPS_CONTEXT_COMPACT_TOKENS: "1000",
        OPS_CONTEXT_ROTATE_TOKENS: "100000000",
        OPS_CONTEXT_GUARD_INTERVAL_MS: "400",
        OPS_COMPACT_COOLDOWN_MS: "100",
        // The mock reports a flat 5000 tokens, so the measured floor equals
        // ctx and the floor-aware rule (context-guard.mjs) would skip-compact.
        // A negative minimum (0 reads as "unset" → default) disables that
        // check so this test exercises the compact path itself.
        OPS_MIN_COMPACTABLE_TOKENS: "-1",
      },
    });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;
    await dispatch("rot-test-0"); // one real turn → context climbs to 5000 tokens

    const compacted = await waitFor(() => {
      const raw = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, "utf8") : "";
      return raw.includes("/compact");
    });
    assert.ok(compacted, `context guard should inject /compact. stderr: ${sup.stderr.join("").slice(-600)}`);
    assert.ok(sup.stderr.join("").includes("injecting /compact"), "should log the /compact decision");

    // A compact preserves the session — it must NOT rotate.
    const h = (await httpGet(healthPort, "/health")).body;
    assert.equal(h.sessionId, initId, "compact must not change the session id");
    assert.ok(!sup.stderr.join("").includes("CONTEXT ROTATION"), "should compact, not hard-rotate");
    assert.ok(h.contextTokens >= 0, "health surfaces contextTokens");
  });

  it("rotates instead of /compact on a compactOnContext:false tier", async () => {
    await setup({
      maxSessionTurns: 0,
      config: { compactOnContext: false },
      extraClaudeArgs: ["--emit-usage", "5000"],
      env: {
        OPS_CONTEXT_COMPACT_TOKENS: "1000",
        OPS_CONTEXT_ROTATE_TOKENS: "100000000",
        OPS_CONTEXT_GUARD_INTERVAL_MS: "400",
        OPS_COMPACT_COOLDOWN_MS: "100",
        OPS_MIN_COMPACTABLE_TOKENS: "-1",
      },
    });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;
    await dispatch("rot-test-0");

    const rotated = await waitFor(async () => (await httpGet(healthPort, "/health")).body.sessionId !== initId);
    assert.ok(rotated, `cron-only tier should rotate. stderr: ${sup.stderr.join("").slice(-600)}`);
    assert.ok(sup.stderr.join("").includes("rotating instead of /compact"), "should log the no-compact rotation");
    const raw = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, "utf8") : "";
    assert.ok(!raw.includes("/compact"), "must never send /compact");
  });

  it("prepends the handoff digest to the fresh session's first real dispatch — no extra turn", async () => {
    // Handoff enabled (override the harness default). The events_fts tee
    // writes into MEMORY_INDEX_DB under the state dir, so the digest has real
    // recent activity to summarize. No model is involved.
    await setup({
      maxSessionTurns: 3,
      env: { OPS_HANDOFF_DISABLED: "0" },
    });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;

    const N = 6;
    for (let i = 0; i < N; i++) await dispatch(`rot-test-${i}`);

    const rotated = await waitFor(async () => (await httpGet(healthPort, "/health")).body.sessionId !== initId);
    assert.ok(rotated, "session should rotate past the cap");

    const drained = await waitFor(async () => {
      const h = (await httpGet(healthPort, "/health")).body;
      return h.queueDepth === 0 && h.inFlight === null && recordedTestMsgs().length >= N;
    });
    assert.ok(drained, "queue should drain with handoff enabled");

    const raw = fs.readFileSync(recordPath, "utf8");
    assert.ok(raw.includes("<session-handoff>"), `fresh session should get the digest. stderr: ${sup.stderr.join("").slice(-700)}`);
    assert.equal(raw.split("<session-handoff>").length - 1, 1, "digest is prepended exactly once per rotation");
    assert.ok(sup.stderr.join("").includes("session-handoff digest prepended"), "should log the injection");
    // It rides on real work: no separate handoff dispatch, so the session saw
    // exactly the N test messages. (Count bare message lines — the digest
    // itself quotes earlier dispatches' content.)
    const bare = raw.split("\n").filter((l) => /^rot-test-\d+$/.test(l.trim()));
    assert.equal(bare.length, N, "no extra dispatch for the handoff");
    assert.ok(!raw.includes("SESSION HANDOFF"), "the old standalone handoff turn is gone");
  });

  it("caps on dispatches, not tool turns (a 25-step job is one dispatch)", async () => {
    // A cap that compared num_turns summed across dispatches would,
    // with 25 tool steps per dispatch, rotate a cap of 3 after every one.
    await setup({ maxSessionTurns: 3, extraClaudeArgs: ["--num-turns", "25"] });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;
    await dispatch("rot-test-0");
    await dispatch("rot-test-1");
    const settled = await waitFor(async () => {
      const h = (await httpGet(healthPort, "/health")).body;
      return h.queueDepth === 0 && h.inFlight === null && recordedTestMsgs().length >= 2;
    });
    assert.ok(settled, "two dispatches should complete");
    const h = (await httpGet(healthPort, "/health")).body;
    assert.equal(h.sessionId, initId, "two dispatches are under a cap of 3 — no rotation");
    assert.equal(h.totalDispatches, 2);
    assert.ok(h.totalTurns >= 50, "tool turns are still counted for telemetry");
    assert.ok(!sup.stderr.join("").includes("TURN-COUNT ROTATION"), "must not rotate on tool steps");
  });

  it("charges a background-wake turn to the job that launched the task, not '-'", async () => {
    await setup({ maxSessionTurns: 0, extraClaudeArgs: ["--bg-wake"] });
    await dispatch("rot-test-0");
    const woke = await waitFor(() => sup.stderr.join("").includes("disp ------ done"), { timeout: 8000 });
    assert.ok(woke, `the wake turn should complete. stderr: ${sup.stderr.join("").slice(-600)}`);
    const log = sup.stderr.join("");
    assert.ok(log.includes("disp ------ done rot-test"), "wake turn attributed to the launching source");
    assert.ok(!log.includes("disp ------ done -"), "no unattributed '-' row");
  });

  it("does not rotate when maxSessionTurns is 0 (disabled)", async () => {
    await setup({ maxSessionTurns: 0 });
    const initId = (await httpGet(healthPort, "/health")).body.sessionId;

    const N = 6;
    for (let i = 0; i < N; i++) await dispatch(`rot-test-${i}`);
    await waitFor(async () => {
      const h = (await httpGet(healthPort, "/health")).body;
      return h.queueDepth === 0 && h.inFlight === null && recordedTestMsgs().length >= N;
    });

    const h = (await httpGet(healthPort, "/health")).body;
    assert.equal(h.sessionId, initId, "sessionId must not change when rotation is disabled");
    assert.equal(h.maxSessionTurns, 0);
    assert.ok(h.totalTurns >= N, `turns accumulate without rotation, got ${h.totalTurns}`);
    assert.ok(!sup.stderr.join("").includes("TURN-COUNT ROTATION"), "must not log a rotation");
  });
});
