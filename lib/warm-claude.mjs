// warm-claude.mjs — a persistent, tool-less `claude -p` for judgments on a hot
// path, so each call pays API latency instead of CLI startup.
//
// WHY (2026-10-04). auto-recall's relevance judge forks `claude -p` per chat
// message (runToolless in jev-claude.mjs). On the host that measured ~2.7s, and
// most of it is the CLI booting, not the model: a warm stream-json session
// answered the same tiny prompt in ~1.8s vs ~4.1s cold on the laptop. The judge
// sits in front of every substantive message the user sends, so this is time the user
// waits on every message.
//
// SHAPE. One child, `--input-format stream-json`, tool-less and Max-only with
// the exact flags runToolless uses (toollessArgs / maxOnlyEnv). Calls are
// serialized; each resolves the turn's `result` text, or "" on timeout/error —
// the same fail-open contract as runToolless, so callers keep their fallbacks.
//
// CONTEXT. Every call becomes another turn in the same conversation. Prompts
// must therefore be self-contained, and each is prefixed with a line telling the
// model to ignore earlier turns. The child is recycled every MAX_CALLS so the
// accumulated context (and any carry-over) stays small; a timeout or exit also
// recycles it.
//
// COST. One resident `claude` process (~150MB) in the long-lived caller. Only
// phone-channel uses it; short-lived CLIs keep calling runToolless.

import { spawn } from "node:child_process";
import os from "node:os";
import { DEFAULT_CLAUDE_BIN, toollessArgs, maxOnlyEnv } from "./jev-claude.mjs";

const MAX_CALLS = 20;
const INDEPENDENT =
  "This is a new, independent task. Ignore every earlier message in this conversation.\n\n";

export class WarmClaude {
  constructor({ bin = DEFAULT_CLAUDE_BIN, model, effort = "low", maxCalls = MAX_CALLS, spawnFn = spawn } = {}) {
    this.bin = bin;
    this.model = model;
    this.effort = effort;
    this.maxCalls = maxCalls;
    this.spawnFn = spawnFn;
    this.child = null;
    this.calls = 0;
    this.chain = Promise.resolve();
    this.pending = null; // { resolve, timer }
    this.buf = "";
  }

  _args() {
    // toollessArgs ends with `--output-format text`; the warm child needs the
    // stream-json pair instead, so drop that pair and add ours.
    const a = toollessArgs(this.model, this.effort);
    const i = a.indexOf("--output-format");
    if (i >= 0) a.splice(i, 2);
    return [...a, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  }

  _spawn() {
    const child = this.spawnFn(this.bin, this._args(), {
      cwd: os.tmpdir(), env: maxOnlyEnv(), stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.calls = 0;
    this.buf = "";
    child.stdout.on("data", (d) => this._onData(child, d));
    const gone = () => {
      if (this.child === child) this.child = null;
      this._settle("");
    };
    child.on("exit", gone);
    child.on("error", gone);
    child.stdin.on("error", () => {});
  }

  _onData(child, d) {
    if (child !== this.child) return;
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "result") {
        this._settle(ev.is_error ? "" : String(ev.result ?? "").trim());
      }
    }
  }

  _settle(text) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(text);
  }

  _recycle() {
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill(); } catch {} }
  }

  /** Spawn ahead of the first call so it is already warm. */
  prewarm() {
    if (!this.child) { try { this._spawn(); } catch {} }
  }

  /** One judgment. Resolves the model's text, or "" on any failure. */
  run(prompt, { timeoutMs = 8000 } = {}) {
    const job = this.chain.then(() => new Promise((resolve) => {
      try {
        if (!this.child || this.calls >= this.maxCalls) { this._recycle(); this._spawn(); }
        this.calls++;
        const timer = setTimeout(() => { this._settle(""); this._recycle(); }, timeoutMs);
        this.pending = { resolve, timer };
        this.child.stdin.write(JSON.stringify({
          type: "user",
          message: { role: "user", content: INDEPENDENT + String(prompt ?? "") },
        }) + "\n");
      } catch {
        this._settle("");
        resolve("");
      }
    }));
    this.chain = job.catch(() => {});
    return job;
  }

  close() { this._recycle(); }
}
