// claude-session.mjs — spawn claude -p with stream-json, parse events, emit.
// Contract:
//   const s = new ClaudeSession({ sessionId, model, fallbackModel, permissionMode, ... });
//   s.on("event", handler);       // every event from stream-json stdout
//   s.on("ready", snapshot);      // after system.init
//   s.on("result", resultEvent);  // on each turn completion
//   s.on("exit", ({code}));       // child exited
//   await s.start();              // resolves when system.init arrives
//   s.send(text);                 // write user message, returns correlation-id string
//   await s.stop();               // EOF stdin, wait for exit

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;

export class ClaudeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.child = null;
    this.ready = false;
    this.sessionId = opts.sessionId;
    this.lastInit = null;
    this.resumeFailed = false;
  }

  _buildArgs({ resume }) {
    const o = this.opts;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--include-hook-events",
      "--model", o.model,
      "--permission-mode", o.permissionMode || "bypassPermissions",
    ];
    if (resume) {
      args.push("--resume", this.sessionId);
    } else {
      args.push("--session-id", this.sessionId);
    }
    if (o.fallbackModel) args.push("--fallback-model", o.fallbackModel);
    if (o.effort) args.push("--effort", o.effort);
    if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
    if (o.remoteControlPrefix) args.push("--remote-control-session-name-prefix", o.remoteControlPrefix);
    if (o.mcpConfig) args.push("--mcp-config", o.mcpConfig);
    if (o.addDirs) for (const d of o.addDirs) args.push("--add-dir", d);
    if (o.appendSystemPromptFile) args.push("--append-system-prompt-file", o.appendSystemPromptFile);
    if (o.allowedTools) {
      // --allowedTools accepts space-separated tokens; pass as a single arg value.
      args.push("--allowedTools", ...o.allowedTools.split(/\s+/).filter(Boolean).map(t => t.replace(/^"|"$/g, "")));
    }
    return args;
  }

  async start() {
    // IMPORTANT: claude -p with stream-json input is LAZY — it does not emit
    // system.init until it receives the first user message on stdin. So we
    // resolve start() as soon as the child spawns successfully. The init
    // event arrives after the first dispatch; we treat that as a normal event.
    const spawnOnce = (resume) => new Promise((resolve, reject) => {
      const builtArgs = this._buildArgs({ resume });
      // claudeBin can be a string ("claude") or array (["node", "mock.mjs"]).
      const claudeBin = this.opts.claudeBin || DEFAULT_CLAUDE;
      const [bin, ...binPrefix] = Array.isArray(claudeBin) ? claudeBin : [claudeBin];
      const args = [...binPrefix, ...builtArgs];
      console.error(`[claude-session] spawn: ${bin} ${args.join(" ")}`);
      const env = { ...process.env, ...(this.opts.env || {}) };
      // Strip env vars the caller wants hidden from the child — e.g. ops
      // requires the Max-subscription auth flow and must not inherit
      // ANTHROPIC_API_KEY from process.env, otherwise claude -p picks the
      // API key over the Max credentials in ~/.claude/.credentials.json.
      for (const k of this.opts.unsetEnv || []) delete env[k];
      const child = spawn(bin, args, {
        cwd: this.opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      this.child = child;

      const rl = readline.createInterface({ input: child.stdout });
      let earlyExit = false;
      const spawnConfirmTimer = setTimeout(() => {
        // If child is still alive after 500ms, assume spawn succeeded.
        if (!earlyExit) { earlyExit = true; resolve({ spawned: true }); }
      }, 500);

      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        this.emit("event", ev);
        if (ev.type === "system" && ev.subtype === "init") {
          this.ready = true;
          this.lastInit = ev;
          // If we asked to resume but got a different session_id, resume failed.
          if (resume && ev.session_id !== this.sessionId) {
            this.resumeFailed = true;
            this.sessionId = ev.session_id;
          }
          this.emit("ready", ev);
        }
        if (ev.type === "result") this.emit("result", ev);
        if (ev.type === "rate_limit_event") this.emit("rate_limit", ev);
      });

      child.stderr.on("data", (chunk) => {
        const s = chunk.toString().trimEnd();
        if (s) console.error(`[claude stderr] ${s}`);
      });

      child.on("exit", (code, signal) => {
        clearTimeout(spawnConfirmTimer);
        this.ready = false;
        this.emit("exit", { code, signal });
        if (!earlyExit) { earlyExit = true; reject(new Error(`child exited immediately (code=${code} signal=${signal})`)); }
      });
      child.on("error", (err) => {
        clearTimeout(spawnConfirmTimer);
        earlyExit = true;
        reject(err);
      });
    });

    if (this.opts.resume) {
      try {
        return await spawnOnce(true);
      } catch (err) {
        console.error(`[claude-session] --resume spawn failed (${err.message}), starting fresh`);
        this.resumeFailed = true;
        if (this.child) { try { this.child.kill("SIGKILL"); } catch {} }
        return await spawnOnce(false);
      }
    }
    return await spawnOnce(false);
  }

  send(content) {
    if (!this.child || this.child.exitCode !== null) throw new Error("session not running");
    const frame = { type: "user", message: { role: "user", content } };
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  async stop({ timeoutMs = 10_000 } = {}) {
    if (!this.child) return;
    // Already exited (normal exit OR via signal): nothing to wait for.
    // Previously only checked exitCode, which stays null after SIGKILL — that
    // caused stop() to attach once("exit") to a child that had already emitted
    // exit, hanging the restart path forever.
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const hardKill = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
        setTimeout(finish, 1000); // guarantee resolution even if exit never fires
      }, timeoutMs);
      this.child.once("exit", () => { clearTimeout(hardKill); finish(); });
      try { this.child.stdin.end(); } catch {}
      setTimeout(() => { try { this.child.kill("SIGTERM"); } catch {} }, 2000);
    });
  }
}
