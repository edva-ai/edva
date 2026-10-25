// job-runner.mjs — generic infrastructure for long-running background jobs
// that must survive the agent session that launched them.
//
// Why this exists (user-authorized): a long research job
// used to run its Opus research fork as a `run_in_background` Bash subprocess
// INSIDE a conversational turn. That subprocess is a descendant of the
// `claude -p` session process, so a context-rotation, crash-loop restart, or
// manual /restart of that session kills it too — orphaning the work. The
// first fix (that pipeline is retired; see changelog.md) made that one
// job a single blocking script, which solves "protected from interruption"
// for that job but not generally, and a blocking call still monopolizes the
// whole agent session for the job's duration (no "runs in parallel").
//
// This module is the general mechanism the user asked for next: a protected,
// uninterrupted place for long-running processes that runs in parallel to
// the rest of the system. Any future long job (research
// forks, batch enrichment, whatever) can use it instead of either blocking
// the calling turn or backgrounding inside the session.
//
// How it works:
//   1. startJob() writes a job registry file, then spawns job-runner-wrapper.mjs
//      as a DETACHED process (`detached: true` + `.unref()`) — this removes it
//      from the calling process's process group entirely. It is reparented to
//      launchd/init, not to the claude session or its Bash subprocess. Killing,
//      rotating, or crash-looping the calling agent session cannot touch it.
//   2. The wrapper is the actual `spawn()` parent of the target command (this
//      matters: only a real parent process can reap a child and learn its true
//      exit code — you can't get that from polling a pid from outside). It
//      pipes the target's stdout/stderr to a log file, waits for it to exit,
//      and writes the terminal status back to the registry. The wrapper does
//      nothing else — no notification, no retry logic — to keep its own
//      crash surface as small as possible.
//   3. Completion notification and cross-restart visibility are NOT the
//      wrapper's job. agent/bin/process-manager.mjs — the one process
//      in the whole system that outlives every individual agent session —
//      polls the registry directory on its own timer and dispatches a
//      follow-up task to the right agent once a job reaches a terminal
//      status. This also means a completed-but-unreported job survives a
//      process-manager restart too: the registry file is the durable source
//      of truth, not any single process's memory.
//
// Registry: one JSON file per job at data/jobs/<id>.json (gitignored —
// runtime state, not config). Logs: data/logs/jobs/<id>.log.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { REPO_ROOT, TOOLS_DIR } from "./root.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const JOBS_DIR = path.join(TOOLS_DIR, "data/jobs");
export const LOGS_DIR = path.join(TOOLS_DIR, "data/logs/jobs");
const WRAPPER_PATH = path.join(__dirname, "job-runner-wrapper.mjs");
const NODE_BIN = process.execPath;

export const TERMINAL_STATUSES = new Set(["done", "failed", "canceled", "lost"]);

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function slugify(name) {
  return (
    String(name || "job")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "job"
  );
}

export function genJobId(name) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-"); // YYYYMMDD-HHMMSS
  const rand = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${slugify(name)}-${rand}`;
}

export function registryPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function logPath(id) {
  return path.join(LOGS_DIR, `${id}.log`);
}

export function readRegistry(id) {
  try {
    return JSON.parse(fs.readFileSync(registryPath(id), "utf8"));
  } catch {
    return null;
  }
}

// Atomic write (temp + rename) — job-cancel and the wrapper can both touch
// the same file; a half-written JSON must never be visible to a reader.
export function writeRegistry(id, obj) {
  ensureDirs();
  const p = registryPath(id);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

export function updateRegistry(id, patch) {
  const current = readRegistry(id) || {};
  const next = { ...current, ...patch };
  writeRegistry(id, next);
  return next;
}

export function listJobs() {
  ensureDirs();
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// startJob — register a job and launch it detached. Returns immediately;
// does NOT wait for the target command to finish.
//
// opts:
//   name         human label (also used in the job id)
//   command      executable (absolute path or on PATH)
//   args         array of string args
//   cwd          working directory (default: repo root)
//   env          extra env vars merged over process.env (optional)
//   requestedBy  which agent/session started it, for diagnostics (optional)
//   onComplete   { tier: "ops"|"ops-light"|"ops-haiku", task: "<template>" }
//                task may reference {{status}}, {{exit_code}}, {{id}}, {{name}}
//                — substituted by the watcher at dispatch time. If omitted,
//                the job runs with no follow-up notification (visibility
//                only via job-list/job-status).
export function startJob(opts) {
  ensureDirs();
  const {
    name,
    command,
    args = [],
    cwd = REPO_ROOT,
    env = {},
    requestedBy = null,
    onComplete = null,
  } = opts;
  if (!name) throw new Error("startJob: name is required");
  if (!command) throw new Error("startJob: command is required");

  const id = genJobId(name);
  const startedAt = new Date().toISOString();
  const log_file = logPath(id);

  writeRegistry(id, {
    id,
    name,
    command,
    args,
    cwd,
    env,
    status: "starting",
    pid: null,
    wrapper_pid: null,
    exit_code: null,
    signal: null,
    started_at: startedAt,
    finished_at: null,
    log_file,
    on_complete: onComplete,
    notified: !onComplete, // nothing to notify if no on_complete was given
    notify_attempts: 0,
    requested_by: requestedBy,
    cancel_requested: false,
  });

  const wrapper = spawn(NODE_BIN, [WRAPPER_PATH, id], {
    cwd: REPO_ROOT,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  // Detach fully — the calling process (a claude session's Bash subprocess,
  // or anything else) can exit/rotate/crash-loop without touching this.
  wrapper.unref();

  return { id, log_file };
}

// cancelJob — signal the running target command (not the wrapper) so the
// wrapper's own exit handler fires and records status=canceled. Returns the
// registry snapshot right before signaling; caller (job-cancel CLI) is
// responsible for polling readRegistry(id) afterward to confirm.
export function cancelJob(id) {
  const job = readRegistry(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (TERMINAL_STATUSES.has(job.status)) {
    return { job, alreadyTerminal: true };
  }
  updateRegistry(id, { cancel_requested: true });
  if (job.pid && isPidAlive(job.pid)) {
    try { process.kill(job.pid, "SIGTERM"); } catch {}
  }
  return { job, alreadyTerminal: false };
}
