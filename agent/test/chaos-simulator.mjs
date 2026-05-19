#!/usr/bin/env node
// chaos-simulator.mjs — random failure injection to validate process manager resilience.
//
// Usage:
//   node agent/test/chaos-simulator.mjs [--duration <min>] [--intensity <low|med|high>]
//
// Spawns 3 ManagedProcess instances with mock services, then randomly injects
// failures (SIGKILL, SIGTERM, SIGSTOP, simultaneous kills, garbage stdin).
// After each injection, verifies recovery. Reports statistics at the end.
//
// Exit 0 = PASS, exit 1 = FAIL

import { ManagedProcess } from "../lib/managed-process.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.join(__dirname, "mock-service.mjs");
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flagVal(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}

const durationMin = parseFloat(flagVal("--duration", "2"));
const intensity = flagVal("--intensity", "med");
const intervalMs = { low: 30_000, med: 10_000, high: 3_000 }[intensity] || 10_000;
const durationMs = durationMin * 60_000;

// ── Setup ───────────────────────────────────────────────────────────────

const tmpBase = process.env.TMPDIR || os.tmpdir();
fs.mkdirSync(tmpBase, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpBase, "chaos-"));

const services = ["alpha", "bravo", "charlie"];
const procs = [];
const logs = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

for (const name of services) {
  const svcLogs = [];
  const proc = new ManagedProcess({
    name,
    command: NODE,
    // Long-running mock that outputs its name on start.
    args: [MOCK, "--output", `${name}-alive`, "--exit-after", "600000"],
    cwd: os.tmpdir(),
    logFile: path.join(tmpDir, `${name}.log`),
    log: (msg) => svcLogs.push(msg),
  });
  procs.push(proc);
  logs.push(svcLogs);
}

// ── Injection types ─────────────────────────────────────────────────────

const injectionTypes = [
  { name: "SIGKILL-one", weight: 40, fn: injectSigkillOne },
  { name: "SIGTERM-one", weight: 20, fn: injectSigtermOne },
  { name: "SIGSTOP-CONT", weight: 15, fn: injectSigstopCont },
  { name: "kill-all", weight: 10, fn: injectKillAll },
  { name: "kill-during-restart", weight: 10, fn: injectKillDuringRestart },
  { name: "garbage-stdin", weight: 5, fn: injectGarbageStdin },
];

const totalWeight = injectionTypes.reduce((s, t) => s + t.weight, 0);

function pickInjection() {
  let r = Math.random() * totalWeight;
  for (const type of injectionTypes) {
    r -= type.weight;
    if (r <= 0) return type;
  }
  return injectionTypes[0];
}

function randomProc() {
  return procs[Math.floor(Math.random() * procs.length)];
}

function injectSigkillOne() {
  const p = randomProc();
  if (p.alive) {
    p.proc.kill("SIGKILL");
    return `SIGKILL → ${p.name} (pid=${p.proc.pid})`;
  }
  return `SIGKILL → ${p.name} (already dead, skipped)`;
}

function injectSigtermOne() {
  const p = randomProc();
  if (p.alive) {
    p.proc.kill("SIGTERM");
    return `SIGTERM → ${p.name} (pid=${p.proc.pid})`;
  }
  return `SIGTERM → ${p.name} (already dead, skipped)`;
}

async function injectSigstopCont() {
  const p = randomProc();
  if (p.alive) {
    const pid = p.proc.pid;
    p.proc.kill("SIGSTOP");
    const freezeMs = 2000 + Math.random() * 3000;
    await sleep(freezeMs);
    // Process may have been restarted while frozen. Check pid still matches.
    if (p.proc?.pid === pid && p.alive) {
      p.proc.kill("SIGCONT");
    }
    return `SIGSTOP(${(freezeMs / 1000).toFixed(1)}s)→SIGCONT → ${p.name}`;
  }
  return `SIGSTOP → ${p.name} (already dead, skipped)`;
}

function injectKillAll() {
  const killed = [];
  for (const p of procs) {
    if (p.alive) {
      p.proc.kill("SIGKILL");
      killed.push(p.name);
    }
  }
  return `SIGKILL-all → [${killed.join(", ")}]`;
}

function injectKillDuringRestart() {
  // Kill a process, then immediately kill it again when it restarts.
  const p = randomProc();
  if (p.alive) {
    const origStart = p.start.bind(p);
    let intercepted = false;
    p.start = function () {
      origStart();
      if (!intercepted) {
        intercepted = true;
        // Kill again 100ms after restart.
        setTimeout(() => {
          if (p.alive) p.proc.kill("SIGKILL");
        }, 100);
      }
      // Restore original start for future restarts.
      p.start = origStart;
    };
    p.proc.kill("SIGKILL");
    return `kill-during-restart → ${p.name}`;
  }
  return `kill-during-restart → ${p.name} (already dead, skipped)`;
}

function injectGarbageStdin() {
  const p = randomProc();
  if (p.alive) {
    const garbage = Buffer.alloc(1024);
    for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(Math.random() * 256);
    p.write(garbage);
    return `garbage-stdin → ${p.name} (1KB)`;
  }
  return `garbage-stdin → ${p.name} (already dead, skipped)`;
}

// ── Recovery verification ───────────────────────────────────────────────

async function waitForRecovery(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (procs.every((p) => p.alive)) {
      return { recovered: true, timeMs: Date.now() - start };
    }
    await sleep(500);
  }
  const dead = procs.filter((p) => !p.alive).map((p) => p.name);
  return { recovered: false, timeMs: Date.now() - start, dead };
}

// ── Main loop ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Chaos Simulator ===`);
  console.log(`Duration: ${durationMin}min | Intensity: ${intensity} (every ${intervalMs / 1000}s)\n`);

  // Start all services.
  for (const p of procs) p.start();
  await sleep(1000);

  const stats = {
    injections: 0,
    recoveries: 0,
    unrecovered: 0,
    recoveryTimes: [],
    byType: {},
    startHeap: process.memoryUsage().heapUsed,
  };

  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    // Random jitter: ±30% of interval.
    const jitter = intervalMs * (0.7 + Math.random() * 0.6);
    await sleep(jitter);
    if (Date.now() >= deadline) break;

    const injection = pickInjection();
    const desc = await injection.fn();
    stats.injections++;
    stats.byType[injection.name] = (stats.byType[injection.name] || 0) + 1;
    log(`INJECT #${stats.injections}: ${desc}`);

    // Wait for recovery.
    const result = await waitForRecovery();
    if (result.recovered) {
      stats.recoveries++;
      stats.recoveryTimes.push(result.timeMs);
      log(`  RECOVERED in ${(result.timeMs / 1000).toFixed(1)}s`);
    } else {
      stats.unrecovered++;
      log(`  !! UNRECOVERED after ${(result.timeMs / 1000).toFixed(0)}s — dead: ${result.dead.join(", ")}`);
    }
  }

  // Shutdown.
  for (const p of procs) p.stop();
  await sleep(2000);

  // Report.
  const endHeap = process.memoryUsage().heapUsed;
  const heapGrowthMB = (endHeap - stats.startHeap) / 1024 / 1024;
  const avgRecovery = stats.recoveryTimes.length > 0
    ? stats.recoveryTimes.reduce((a, b) => a + b, 0) / stats.recoveryTimes.length
    : 0;
  const maxRecovery = Math.max(0, ...stats.recoveryTimes);
  const totalRestarts = procs.reduce((s, p) => s + p.restarts, 0);

  console.log(`\n=== Chaos Simulator Report ===`);
  console.log(`Duration: ${durationMin}min | Intensity: ${intensity}`);
  console.log(`Injections: ${stats.injections}`);
  console.log(`Recoveries: ${stats.recoveries}/${stats.injections} (${stats.injections > 0 ? ((stats.recoveries / stats.injections) * 100).toFixed(0) : 0}%)`);
  console.log(`Avg recovery: ${(avgRecovery / 1000).toFixed(1)}s | Max recovery: ${(maxRecovery / 1000).toFixed(1)}s`);
  console.log(`Unrecovered: ${stats.unrecovered}`);
  console.log(`Total restarts: ${totalRestarts}`);
  console.log(`Memory growth: ${heapGrowthMB > 0 ? "+" : ""}${heapGrowthMB.toFixed(1)}MB`);
  console.log(`Breakdown: ${Object.entries(stats.byType).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  const pass = stats.unrecovered === 0 && heapGrowthMB < 50;
  console.log(`RESULT: ${pass ? "PASS ✓" : "FAIL ✗"}\n`);

  // Cleanup temp dir.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`Chaos simulator error: ${err.message}\n${err.stack}`);
  for (const p of procs) p.stop();
  process.exit(1);
});
