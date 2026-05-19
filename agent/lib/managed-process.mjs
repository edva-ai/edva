// managed-process.mjs — supervised child process with auto-restart.
//
// Extracted from process-manager.mjs for testability.
// Handles: spawn, restart with exponential backoff, graceful stop, log streaming.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export class ManagedProcess {
  constructor({ name, command, args, cwd, logFile, env, onData, log }) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.cwd = cwd;
    this.logFile = logFile;
    this.env = env ? { ...process.env, ...env } : { ...process.env };
    this.onData = onData;
    this._log = log || (() => {});
    this.proc = null;
    this._logStream = null;
    this.restarts = 0;
    this.startedAt = null;
    this.stopping = false;
    this._restartTimer = null;
    this._killTimer = null;
    this._restartScheduled = false;
  }

  start() {
    if (this.stopping) return;
    this.startedAt = Date.now();
    this._restartScheduled = false;
    if (this.logFile) {
      this._logStream = createWriteStream(this.logFile, { flags: "a" });
    }

    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (buf) => {
      this._logStream?.write(buf);
      this.onData?.(buf.toString(), this);
    });
    this.proc.stderr.on("data", (buf) => {
      this._logStream?.write(buf);
    });

    this.proc.on("error", (err) => {
      this._log(`[${this.name}] spawn error: ${err.message}`);
      this._closeLogStream();
      this._scheduleRestart();
    });

    this.proc.on("exit", (code, signal) => {
      const uptime = Date.now() - this.startedAt;
      const uptimeStr = uptime > 60_000
        ? `${(uptime / 60_000).toFixed(1)}min`
        : `${(uptime / 1000).toFixed(1)}s`;
      this._log(`[${this.name}] exited code=${code} signal=${signal} (uptime=${uptimeStr}, restarts=${this.restarts})`);
      this._closeLogStream();
      this._scheduleRestart();
    });

    this._log(`[${this.name}] started pid=${this.proc.pid} cmd=${this.command} args=[${this.args.slice(0, 3).join(", ")}${this.args.length > 3 ? ", ..." : ""}]`);
  }

  _closeLogStream() {
    if (this._logStream) {
      this._logStream.end();
      this._logStream = null;
    }
  }

  _scheduleRestart() {
    if (this.stopping || this._restartScheduled) return;
    this._restartScheduled = true;

    // Reset restart count if process ran for >5 min (was healthy).
    const uptime = Date.now() - this.startedAt;
    if (uptime > 5 * 60_000) {
      this._log(`[${this.name}] ran for ${(uptime / 60_000).toFixed(1)}min — resetting backoff`);
      this.restarts = 0;
    }

    this.restarts++;
    const delay = ManagedProcess.backoffDelay(this.restarts);
    this._log(`[${this.name}] scheduling restart #${this.restarts} in ${(delay / 1000).toFixed(0)}s`);
    this._restartTimer = setTimeout(() => this.start(), delay);
  }

  static backoffDelay(attempt) {
    return Math.min(2000 * Math.pow(2, Math.min(attempt - 1, 5)), 60_000);
  }

  write(data) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(data);
    }
  }

  stop() {
    this.stopping = true;
    clearTimeout(this._restartTimer);
    clearTimeout(this._killTimer);
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      this._killTimer = setTimeout(() => {
        if (this.alive) {
          this._log(`[${this.name}] force killing`);
          this.proc.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  get alive() {
    return !!(this.proc && this.proc.exitCode === null && this.proc.signalCode === null);
  }
}

