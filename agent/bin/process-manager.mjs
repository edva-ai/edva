#!/usr/bin/env node
// process-manager.mjs — direct process supervisor, replaces tmux session management.
//
// Manages 4 child processes with independent restart:
//   1. Chat supervisor  (Node.js — manages Claude session for Merlin messages)
//   2. Ops supervisor   (Node.js — manages Claude session for email triage + tasks)
//   3. Hookdeck         (webhook relay for Gmail Pub/Sub)
//   4. Wiki server      (HTTP wiki browser at 127.0.0.1:9096)
//
// Each process restarts independently with exponential backoff.
// One crashing does not affect the others.
//
// Managed by launchd (ai.claude.session).

import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { ManagedProcess } from "../lib/managed-process.mjs";

const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");

const HOME = process.env.HOME;
const MERLIN = MERLIN_HOME;
const AGENT_DIR = path.join(MERLIN, "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");
const SUPERVISOR_DIR = path.join(AGENT_DIR, "supervisor");
const NODE = "/opt/homebrew/bin/node";

// Load .env into process.env so secrets (SUPABASE_ACCESS_TOKEN, etc.)
// propagate to every child process — supervisors, Claude, and MCP servers
// that use ${VAR} substitution in .mcp.json. Does NOT override existing env vars.
function loadDotEnv() {
  const envPath = path.join(MERLIN, ".env");
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (err) {
    process.stderr.write(`[process-manager] warn: could not load ${envPath}: ${err.message}\n`);
  }
}
loadDotEnv();

mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stderr.write(`${ts} ${msg}\n`);
}

function createProcesses() {
  const children = [];

  // 1. Chat supervisor — manages Claude session for Merlin messages
  children.push(
    new ManagedProcess({
      name: "chat-supervisor",
      command: NODE,
      args: [path.join(SUPERVISOR_DIR, "chat-supervisor.mjs"), "--agent", "chat"],
      cwd: SUPERVISOR_DIR,
      logFile: path.join(LOG_DIR, "chat-supervisor.log"),
      log,
    })
  );

  // 2. Ops supervisor — manages Claude session for email triage + tasks
  children.push(
    new ManagedProcess({
      name: "ops-supervisor",
      command: NODE,
      args: [path.join(SUPERVISOR_DIR, "index.mjs"), "--agent", "ops"],
      cwd: SUPERVISOR_DIR,
      logFile: path.join(LOG_DIR, "ops-supervisor.log"),
      log,
    })
  );

  // 3. Hookdeck relay. Spawn the native Go binary directly instead of the
  // `hookdeck` shim on PATH — the shim is a node wrapper that execs the
  // native binary as a grandchild, and SIGTERM to the wrapper doesn't
  // reach the grandchild. That left orphaned hookdeck listeners from
  // prior manager restarts still connected to the Hookdeck cloud and
  // load-balancing Gmail pushes onto dead tunnels (observed 2026-04-16).
  children.push(
    new ManagedProcess({
      name: "hookdeck",
      command: "/opt/homebrew/lib/node_modules/hookdeck-cli/binaries/darwin-arm64/hookdeck",
      // --log-level debug adds connection diagnostics to hookdeck.log
      // (WebSocket close reasons, retry backoff, DNS/TLS errors) so when the
      // tunnel drops, we have enough context to diagnose root cause instead of
      // just "Connection lost, reconnecting...".
      args: ["listen", "9090", "gmail-source", "--output", "compact", "--log-level", "debug"],
      cwd: AGENT_DIR,
      logFile: path.join(LOG_DIR, "hookdeck.log"),
      log,
    })
  );

  // 4. Wiki server — HTTP wiki browser on :9096. Binds to 0.0.0.0 so
  // it's reachable over Tailscale (e.g. http://${MERLIN_HOST}:9096) and
  // on the home LAN, not just localhost. Read-only, no auth — exposure is
  // gated by network trust (LAN + Tailscale), same model as before.
  children.push(
    new ManagedProcess({
      name: "wiki-server",
      command: NODE,
      args: [path.join(MERLIN, "bin/wiki"), "serve", "--port", "9096", "--host", "0.0.0.0"],
      cwd: MERLIN,
      logFile: path.join(LOG_DIR, "wiki-server.log"),
      log,
    })
  );

  return children;
}

// ── Status heartbeat ────────────────────────────────────────────────────

function statusLine(children) {
  return children
    .map((c) => {
      const state = c.alive ? "up" : c.stopping ? "stopped" : "down";
      const pid = c.proc?.pid || "-";
      const restarts = c.restarts;
      const uptime = c.startedAt && c.alive
        ? `${((Date.now() - c.startedAt) / 60_000).toFixed(0)}min`
        : "-";
      return `${c.name}(${state} pid=${pid} restarts=${restarts} up=${uptime})`;
    })
    .join("  ");
}

// ── Main ────────────────────────────────────────────────────────────────

const children = createProcesses();
const startedAt = Date.now();

log(`process-manager v2.0 starting — pid=${process.pid}`);
log(`services: ${children.map((c) => c.name).join(", ")}`);

for (const child of children) {
  child.start();
}

// HTTP health endpoint — consumed by merlin status, heartbeat-sender, watchdog.
const HEALTH_PORT = 9095;
const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const status = {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      children: children.map((c) => ({
        name: c.name,
        alive: c.alive,
        pid: c.proc?.pid || null,
        restarts: c.restarts,
        uptimeMs: c.alive && c.startedAt ? Date.now() - c.startedAt : 0,
      })),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, "127.0.0.1", () => log(`health endpoint on :${HEALTH_PORT}`));

const STATUS_INTERVAL = 10 * 60_000;
const statusTimer = setInterval(() => {
  const uptimeMin = ((Date.now() - startedAt) / 60_000).toFixed(0);
  log(`[heartbeat] uptime=${uptimeMin}min  ${statusLine(children)}`);
}, STATUS_INTERVAL);
statusTimer.unref();

// ── Dispatch-aware watchdog ─────────────────────────────────────────────
// Process-liveness (child PID up) is not sufficient: a supervisor can be
// running while its inner Claude child is hung on a tool call or retry loop,
// producing zero events for hours. This polls /health and SIGKILLs the
// supervisor child when the dispatcher has been stuck with an in-flight task
// for too long. ManagedProcess.on("exit") then kicks the normal restart path.
// Added 2026-04-18 after a 5h silent hang went undetected by heartbeats.

const DISPATCH_HEALTH_PORTS = {
  "ops-supervisor": 9093,
};
const DISPATCH_POLL_INTERVAL = 2 * 60_000;
const DISPATCH_STUCK_MS = 15 * 60_000;
const DISPATCH_STUCK_MS_SLEEP_WINDOW = 30 * 60_000;

// Returns true when local ET hour is in [01:00, 08:00) — quiet window where
// nightly-review / daily-summary / hum-daily can legitimately run 15-25min
// (web research + classifier + multiple email-sends). Bumping the stuck
// threshold here avoids the recurring false-positive SIGKILL pattern that
// produced phantom catchup-sweeps documented across 4/27-4/30 reviews.
function inSleepWindowET() {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  return etHour >= 1 && etHour < 8;
}

function fetchSupervisorHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function checkDispatchLiveness() {
  for (const child of children) {
    const port = DISPATCH_HEALTH_PORTS[child.name];
    if (!port) continue;
    if (!child.alive) continue;
    const health = await fetchSupervisorHealth(port);
    if (!health) continue;
    const ageMs = health.lastEventAgeMs ?? 0;
    const inFlight = health.inFlight;
    const threshold = inSleepWindowET() ? DISPATCH_STUCK_MS_SLEEP_WINDOW : DISPATCH_STUCK_MS;
    if (inFlight && ageMs > threshold) {
      const window = threshold === DISPATCH_STUCK_MS_SLEEP_WINDOW ? "sleep" : "active";
      log(`[${child.name}] STUCK (${window}-window): inFlight=${inFlight.source} lastEventAge=${Math.round(ageMs / 60_000)}min — SIGKILL to trigger restart`);
      try { child.proc?.kill("SIGKILL"); } catch {}
    }
  }
}

const dispatchWatchdogTimer = setInterval(() => {
  checkDispatchLiveness().catch((err) => log(`dispatch-watchdog error: ${err.message}`));
}, DISPATCH_POLL_INTERVAL);
dispatchWatchdogTimer.unref();

async function shutdown(sig) {
  log(`received ${sig} — stopping all services`);
  clearInterval(statusTimer);
  try { healthServer.close(); } catch {}
  for (const child of children) {
    child.stop();
  }
  const deadline = Date.now() + 10_000;
  while (children.some((c) => c.alive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const alive = children.filter((c) => c.alive);
  if (alive.length > 0) {
    log(`shutdown forced — ${alive.map((c) => c.name).join(", ")} still alive`);
  } else {
    log("shutdown complete — all services stopped cleanly");
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});
