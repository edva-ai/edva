// job-runner-wrapper.mjs — the detached process that actually owns a
// background job's child process. Spawned by startJob() in job-runner.mjs
// with `detached: true` + `.unref()`, so it is NOT a descendant of whatever
// launched it (an agent session's Bash subprocess) — it is reparented to
// launchd/init and keeps running through session rotations, crash-loop
// restarts, or manual /restart of the agent that kicked it off.
//
// This process does exactly one thing: spawn the target command as its own
// (regular, non-detached) child so it can reap the real exit code, pipe its
// output to the job's log file, and write the terminal status back to the
// registry. It does NOT dispatch any completion notification itself — that's
// agent/bin/process-manager.mjs's job, on its own always-on timer, so a
// crash of THIS wrapper right after the target finishes can't silently lose
// the notification (the registry file, not this process's memory, is the
// source of truth).
//
// Usage: node job-runner-wrapper.mjs <job-id>

import fs from "node:fs";
import { spawn } from "node:child_process";
import { readRegistry, updateRegistry, logPath } from "./job-runner.mjs";

const id = process.argv[2];
if (!id) {
  process.exit(1);
}

const job = readRegistry(id);
if (!job) {
  process.exit(1);
}

const logFile = job.log_file || logPath(id);
const logFd = fs.openSync(logFile, "a");
const startLine = `\n[job-runner-wrapper] ${new Date().toISOString()} launching: ${job.command} ${(job.args || []).join(" ")}\n`;
fs.writeSync(logFd, startLine);

let child;
try {
  child = spawn(job.command, job.args || [], {
    cwd: job.cwd || undefined,
    env: { ...process.env, ...(job.env || {}) },
    stdio: ["ignore", logFd, logFd],
  });
} catch (err) {
  fs.writeSync(logFd, `[job-runner-wrapper] spawn failed: ${err?.message || err}\n`);
  updateRegistry(id, {
    status: "failed",
    exit_code: null,
    signal: null,
    finished_at: new Date().toISOString(),
    error: `spawn failed: ${err?.message || err}`,
  });
  fs.closeSync(logFd);
  process.exit(1);
}

updateRegistry(id, {
  status: "running",
  pid: child.pid,
  wrapper_pid: process.pid,
});

child.on("exit", (code, signal) => {
  const current = readRegistry(id) || job;
  // job-runner's status only judges the PROCESS LIFECYCLE (did it run to
  // completion, or was it killed/crashed?) — it deliberately does NOT assume
  // "0 == success". Several scripts in this codebase (e.g. a daily report
  // runner) use multi-value exit codes with their own meaning
  // (0=sent, 1=failure, 2=idempotent no-op) — collapsing anything non-zero to
  // "failed" would mislabel a routine no-op as an error every day. Callers
  // read `exit_code` via job-status for the job's own semantics; "done" here
  // just means the process exited on its own rather than being killed.
  let status;
  if (signal) {
    status = current.cancel_requested ? "canceled" : "failed";
  } else {
    status = "done";
  }
  fs.writeSync(
    logFd,
    `[job-runner-wrapper] ${new Date().toISOString()} exited code=${code} signal=${signal} -> status=${status}\n`
  );
  updateRegistry(id, {
    status,
    exit_code: code,
    signal,
    finished_at: new Date().toISOString(),
  });
  fs.closeSync(logFd);
  process.exit(0);
});

child.on("error", (err) => {
  fs.writeSync(logFd, `[job-runner-wrapper] child error: ${err?.message || err}\n`);
  updateRegistry(id, {
    status: "failed",
    finished_at: new Date().toISOString(),
    error: err?.message || String(err),
  });
  try { fs.closeSync(logFd); } catch {}
  process.exit(1);
});
