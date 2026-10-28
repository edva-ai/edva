#!/usr/bin/env node
// process-manager.mjs — direct process supervisor, replaces tmux session management.
//
// Manages 4 child processes with independent restart:
//   1. Chat supervisor   (Node.js — manages Claude session for Edva messages)
//   2. Ops supervisor    (Node.js — manages Claude session for email triage + tasks)
//   3. Wiki server       (HTTP wiki browser at 127.0.0.1:9096)
//   4. WhatsApp channel  (Baileys gateway for the user's personal WhatsApp on :9100)
//
// Gmail Pub/Sub push and the CF Email Worker reach :9090 through a Cloudflare
// Tunnel (push hostname → localhost:9090) managed by its own launchd agent
// (com.cloudflare.cloudflared), NOT by this process-manager.
//
// Each process restarts independently with exponential backoff.
// One crashing does not affect the others.
//
// Managed by launchd (ai.claude.session).

import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { ManagedProcess } from "../lib/managed-process.mjs";
import { listJobs, updateRegistry, isPidAlive, registryPath, logPath } from "../../lib/job-runner.mjs";
import { installRoot, installTools, nodeBin } from "../../lib/root.cjs";
const { instance } = createRequire(import.meta.url)("../../lib/instance.cjs");

const HOME = process.env.HOME;
const EDVA = installRoot();
const AGENT_DIR = path.join(EDVA, "agent");
const LOG_DIR = path.join(AGENT_DIR, "logs");
const SUPERVISOR_DIR = path.join(AGENT_DIR, "supervisor");
// The node every managed child runs on (lib/root.cjs nodeBin: $EDVA_NODE,
// else a stable Homebrew / /usr/local path, else this interpreter).
const NODE = nodeBin();

// Load .env into process.env so secrets (SUPABASE_ACCESS_TOKEN, etc.)
// propagate to every child process — supervisors, Claude, and MCP servers
// that use ${VAR} substitution in .mcp.json. Does NOT override existing env vars.
function loadDotEnv() {
  const envPath = path.join(EDVA, ".env");
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

  // 1. Chat supervisor — manages Claude session for Edva messages
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

  // 2b. Ops-light supervisor — Sonnet sibling of ops. Handles cron/webhook
  // jobs routed off Opus (job-routing.json model != opus); webhook-auth.sh
  // picks the :9082/:9083 port pair by job tier. No Gmail ingress (that stays
  // single-instance on ops). Lean cwd (ops-light-agent, Chrome-less .mcp.json)
  // to bound the RAM footprint on a swap-constrained host (part of the cost
  // re-architecture).
  children.push(
    new ManagedProcess({
      name: "ops-light-supervisor",
      command: NODE,
      args: [path.join(SUPERVISOR_DIR, "index.mjs"), "--agent", "ops-light"],
      cwd: SUPERVISOR_DIR,
      logFile: path.join(LOG_DIR, "ops-light-supervisor.log"),
      log,
    })
  );

  // 2c. Ops-haiku supervisor — Haiku sibling. Handles the haiku-tier scan/watch
  // jobs (job-routing.json model==haiku); webhook-auth.sh routes them to
  // :9072/:9073. Sonnet→Haiku on these jobs saves ~67%. No Gmail ingress; same
  // lean Chrome-less cwd pattern as ops-light (the Haiku tier of the same
// cost re-architecture).
  children.push(
    new ManagedProcess({
      name: "ops-haiku-supervisor",
      command: NODE,
      args: [path.join(SUPERVISOR_DIR, "index.mjs"), "--agent", "ops-haiku"],
      cwd: SUPERVISOR_DIR,
      logFile: path.join(LOG_DIR, "ops-haiku-supervisor.log"),
      log,
    })
  );

  // 3. Wiki server — HTTP wiki browser on :9096. Binds to 0.0.0.0 so
  // it's reachable over Tailscale (e.g. http://<host>:9096) and
  // on the home LAN, not just localhost. Read-only, no auth — exposure is
  // gated by network trust (LAN + Tailscale), same model as before.
  children.push(
    new ManagedProcess({
      name: "wiki-server",
      command: NODE,
      args: [path.join(EDVA, "bin/wiki"), "serve", "--port", "9096", "--host", "0.0.0.0"],
      cwd: EDVA,
      logFile: path.join(LOG_DIR, "wiki-server.log"),
      log,
    })
  );

  // 3b. Wiki server, INTERNET-FACING — the origin behind the public memory
  // hostname. A separate process from the one above on purpose:
  //
  //   - it binds 127.0.0.1 only, so the sole route in is the cloudflared
  //     tunnel, and
  //   - it runs WIKI_PUBLIC=1, which makes a verified Cloudflare Access JWT
  //     mandatory on every request and scopes what each identity may read
  //     (lib/wiki-access.js, data/wiki-share-scopes.json).
  //
  // Keeping them separate preserves the unauthenticated Tailscale/LAN browsing
  // above — which is network-trust gated and works fine — while guaranteeing
  // the internet-facing instance can never serve a page without an identity.
  // One process serving both would have meant choosing between the two.
  children.push(
    new ManagedProcess({
      name: "wiki-server-public",
      command: NODE,
      args: [path.join(EDVA, "bin/wiki"), "serve", "--port", "9097", "--host", "127.0.0.1"],
      cwd: EDVA,
      env: { WIKI_PUBLIC: "1" },
      logFile: path.join(LOG_DIR, "wiki-server-public.log"),
      log,
    })
  );

  // 4. WhatsApp channel — Baileys gateway holding the user's personal WhatsApp
  // session. HTTP send-server on :9100, inbound to whatsapp-inbox.jsonl,
  // chat-channel pings on filter-pass. If down, inbound stalls (WhatsApp
  // servers queue messages for Linked Devices for a few hours, not days),
  // so supervision matters here more than for wiki-server.
  children.push(
    new ManagedProcess({
      name: "whatsapp-channel",
      command: NODE,
      args: [path.join(AGENT_DIR, "whatsapp-channel/index.mjs")],
      cwd: path.join(AGENT_DIR, "whatsapp-channel"),
      logFile: path.join(LOG_DIR, "whatsapp-channel.log"),
      log,
    })
  );

  // 5. iMessage channel — tails the Messages store (chat.db, read-only) and
  // logs every new message, 1:1 and group, both directions, to
  // imessage-inbox.jsonl within seconds; health on :9107. Needs Full Disk
  // Access for the node binary. Sending stays with `imsg send`.
  children.push(
    new ManagedProcess({
      name: "imessage-channel",
      command: NODE,
      args: [path.join(AGENT_DIR, "imessage-channel/index.mjs")],
      cwd: path.join(AGENT_DIR, "imessage-channel"),
      logFile: path.join(LOG_DIR, "imessage-channel.log"),
      log,
    })
  );

  // 6. Slack channel — realtime runner on the user's own Slack web session
  // (xoxc token + d cookie from .env). Holds one RTM websocket, logs to
  // slack-inbox.jsonl; HTTP send API on 127.0.0.1:9108. With no or dead
  // credentials it idles (one system notice) and picks up a re-capture itself.
  children.push(
    new ManagedProcess({
      name: "slack-channel",
      command: NODE,
      args: [path.join(AGENT_DIR, "slack-channel/index.mjs")],
      cwd: path.join(AGENT_DIR, "slack-channel"),
      logFile: path.join(LOG_DIR, "slack-channel.log"),
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

// HTTP health endpoint — consumed by edva status, heartbeat-sender, watchdog.
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
// (Heartbeats alone can miss a silent hang of hours.)

const DISPATCH_HEALTH_PORTS = {
  "ops-supervisor": 9093,
  "ops-light-supervisor": 9083,
  "ops-haiku-supervisor": 9073,
};
const DISPATCH_POLL_INTERVAL = 2 * 60_000;
const DISPATCH_STUCK_MS = 15 * 60_000;
const DISPATCH_STUCK_MS_SLEEP_WINDOW = 30 * 60_000;

// The user's current timezone, from the phone-reported value the phone-channel
// persists to user-timezone.json. Falls back to the home timezone
// (lib/instance.cjs tz) when missing/unreadable.
function userTz() {
  try {
    const tz = JSON.parse(
      readFileSync(installTools("data/user-timezone.json"), "utf8")
    )?.timezone;
    if (tz && Intl.DateTimeFormat("en-US", { timeZone: tz })) return tz;
  } catch {}
  return instance().tz;
}

// Returns true when the user's LOCAL hour is in [01:00, 08:00) — quiet window
// where nightly-review / daily-summary / hum-daily can legitimately run
// 15-25min (web research + classifier + multiple email-sends). Keyed to the
// user's local tz (not a fixed home-zone clock) because cron-tz-sync pins those heavy jobs to
// local wall-clock, so their run window travels with the user. Bumping the
// stuck threshold here avoids a recurring false-positive SIGKILL pattern that
// produces phantom catchup-sweeps.
function inSleepWindowLocal() {
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: userTz(),
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  return localHour >= 1 && localHour < 8;
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
    const threshold = inSleepWindowLocal() ? DISPATCH_STUCK_MS_SLEEP_WINDOW : DISPATCH_STUCK_MS;
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

// ── Job-completion watcher ───────────────────────────────────────────────
// Companion to lib/job-runner.mjs (long-running processes in a
// protected, uninterrupted container that runs in parallel to other tasks
// in the system). Jobs
// launched via `job-run` run as detached processes that are NOT descendants
// of any agent session, so they survive session rotation/crash-loop/restart.
// This process-manager is the one thing in the whole system that outlives
// every individual agent session, which makes it the right home for the
// piece that still needs to happen once a job finishes: telling an agent
// about it. The registry file (data/jobs/<id>.json), not this
// process's memory, is the durable source of truth — a process-manager
// restart just re-reads the same files and picks up where it left off.
//
// Three things happen on each sweep:
//   1. Terminal-but-unnotified jobs with an on_complete spec get dispatched
//      to their tier's webhook (same POST-a-task pattern as cron dispatch —
//      see agent/scripts/lib/webhook-auth.sh dispatch_or_skip).
//   2. Jobs that still say status=="running" but whose pid is gone (wrapper
//      itself crashed, or a reboot took everything down) get marked "lost"
//      after two consecutive dead-pid observations, so a stuck job doesn't
//      sit invisible forever — this still notifies if on_complete was set,
//      framed as an unknown-outcome job so the agent knows to go check.
//   3. Old terminal job files get pruned so the registry directory doesn't
//      grow unbounded.

const JOB_POLL_INTERVAL = 20_000;
const JOB_NOTIFY_MAX_ATTEMPTS = 10;
const JOB_PRUNE_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days past finished_at
const JOB_TIER_PORTS = { ops: 9092, "ops-light": 9082, "ops-haiku": 9072 };

// pid observed dead but registry still says "running" — debounced across two
// consecutive sweeps before declaring the job lost, so we don't race the
// wrapper's own near-instant post-exit registry write.
const pendingLostSince = new Map();

function readWebhookToken() {
  try {
    return readFileSync(path.join(EDVA, "secrets/webhook-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
const WEBHOOK_TOKEN = readWebhookToken();

function postJobTask(port, taskText) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ task: taskText, source: "job-runner" });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (WEBHOOK_TOKEN) headers["Authorization"] = `Bearer ${WEBHOOK_TOKEN}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "POST", headers, timeout: 8000 },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

function renderTaskTemplate(template, job) {
  return template
    .replace(/\{\{status\}\}/g, job.status)
    .replace(/\{\{exit_code\}\}/g, job.exit_code === null || job.exit_code === undefined ? "unknown" : String(job.exit_code))
    .replace(/\{\{id\}\}/g, job.id)
    .replace(/\{\{name\}\}/g, job.name);
}

async function checkJobCompletions() {
  const jobs = listJobs();
  const now = Date.now();

  for (const job of jobs) {
    // 1. Detect jobs whose pid died without the wrapper updating status —
    // wrapper crash or machine reboot. Debounce across two sweeps.
    if (job.status === "running" && job.pid) {
      if (!isPidAlive(job.pid)) {
        const firstSeen = pendingLostSince.get(job.id);
        if (firstSeen) {
          log(`[job-runner] ${job.id} (${job.name}) pid ${job.pid} gone, wrapper never updated status — marking lost`);
          updateRegistry(job.id, {
            status: "lost",
            finished_at: new Date().toISOString(),
            error: "wrapper did not report a terminal status (crashed, or host restarted)",
          });
          pendingLostSince.delete(job.id);
        } else {
          pendingLostSince.set(job.id, now);
        }
        continue; // re-read as terminal next sweep before notifying
      } else {
        pendingLostSince.delete(job.id);
      }
    }

    // 2. Dispatch completion notification for terminal-but-unnotified jobs.
    if (job.on_complete && !job.notified) {
      const port = JOB_TIER_PORTS[job.on_complete.tier];
      const isTerminal = ["done", "failed", "canceled", "lost"].includes(job.status);
      if (!isTerminal || !port) continue;
      const attempts = (job.notify_attempts || 0) + 1;
      if (attempts > JOB_NOTIFY_MAX_ATTEMPTS) {
        log(`[job-runner] ${job.id} (${job.name}) giving up on notify after ${attempts - 1} attempts — marking notified to stop retrying`);
        updateRegistry(job.id, { notified: true, notify_attempts: attempts });
        continue;
      }
      const taskText = renderTaskTemplate(job.on_complete.task, job);
      const ok = await postJobTask(port, taskText);
      if (ok) {
        log(`[job-runner] ${job.id} (${job.name}) status=${job.status} — notified ${job.on_complete.tier}`);
        updateRegistry(job.id, { notified: true, notify_attempts: attempts });
      } else {
        log(`[job-runner] ${job.id} (${job.name}) notify attempt ${attempts} to ${job.on_complete.tier} failed — will retry`);
        updateRegistry(job.id, { notify_attempts: attempts });
      }
    }

    // 3. Prune old terminal job files (registry + log) past the retention window.
    if (["done", "failed", "canceled", "lost"].includes(job.status) && job.finished_at) {
      const age = now - new Date(job.finished_at).getTime();
      if (age > JOB_PRUNE_AGE_MS) {
        try { unlinkSync(registryPath(job.id)); } catch {}
        try { unlinkSync(logPath(job.id)); } catch {}
      }
    }
  }
}

const jobWatcherTimer = setInterval(() => {
  checkJobCompletions().catch((err) => log(`job-runner watcher error: ${err.message}`));
}, JOB_POLL_INTERVAL);
jobWatcherTimer.unref();

async function shutdown(sig) {
  log(`received ${sig} — stopping all services`);
  clearInterval(statusTimer);
  clearInterval(dispatchWatchdogTimer);
  clearInterval(jobWatcherTimer);
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
