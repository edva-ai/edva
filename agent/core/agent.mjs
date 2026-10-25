// agent.mjs — WP0 (own the context array) + WP6 (continuity & cancellation).
//
// This is the pivot Conway's whole substrate descends from: an agent is a
// persistent, addressable in-process object that OWNS the exact array of
// messages sent to the model. Everything else (deferred tools, snipping, forks,
// steering) is only possible on top of a loop you control the context of.
//
// EDVA ADAPTATION — Max-only auth (hard invariant, agent/CLAUDE.md
// § Auth Model): Conway's Agent runs a direct Anthropic Messages-API loop via
// the SDK + API key. Edva may NEVER make an API-key-billed call. So the turn
// EXECUTOR is an injected strategy, not a hardcoded SDK call. The Agent owns the
// context array (the real point of WP0); the executor is what actually produces
// an assistant turn — the default is Max-compliant (claude -p, key stripped),
// and a mock executor drives the tests. No raw SDK, ever.
//
// Executor contract:
//   executor(turn) => Promise<{ text?: string, assistant?: any, usage?: object }>
//     turn = { agent, system, messages, tools, userParts, signal }
//   - `messages` is the rendered context array (already includes the just-drained
//     user turn). `signal` is an AbortSignal the executor should honor for cancel.
//   - Returns the assistant's final text and/or the full `assistant` content to
//     store. If `assistant` is omitted, {type:'text',text} is stored.
//
// Conway mechanisms mirrored (agent.ts): single _processLoop per agent draining
// _mailbox sequentially; at most one turn active; _wakeLoop(); send(content,
// {interrupt}) pushes to mailbox BEFORE cancelling; awaitIdle fast-path;
// _sendWaiters resolve with the turn's assistant-text snapshot; subagents cannot
// interrupt (kind rule).

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import * as defaultStore from "./message-store.mjs";

// Interrupt-permission rule (Conway): main & forks can interrupt; subagents cannot.
export const INTERRUPT_ALLOWED_KINDS = new Set(["main", "fork"]);

// string → [{type:'text',text}]; array → as-is; object → [object].
export function normalizeParts(input) {
  if (input == null) return [];
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (Array.isArray(input)) return input;
  return [input];
}

export class Agent extends EventEmitter {
  constructor(id, { system = "", modelId = null, kind = "main", executor, store = defaultStore, renderContext = null, contextHooks = null, registry = null, forkExecutor = null, persist = true, allowInterrupt = null } = {}) {
    super();
    if (!id) throw new Error("Agent: id is required");
    if (typeof executor !== "function") throw new Error("Agent: an executor function is required (Max-compliant; never a raw SDK loop)");
    this.id = id;
    this.system = system;
    this.modelId = modelId;
    this.kind = kind;
    this._executor = executor;
    this.executor = executor;   // public alias so a fork can inherit the parent's executor (WP3)
    // Optional stateless executor a fork should use instead of inheriting this
    // agent's (session-bound) executor — set by supervisors whose main executor
    // is bound to a persistent --resume session (chat). See fork.mjs + WP3.
    this.forkExecutor = forkExecutor;
    this._store = store;
    this._renderContext = renderContext || ((msgs) => msgs);
    // WP10: optional { assembleSystem(base, ev) => Promise<string> } — e.g.
    // core/context-hooks.mjs's createContextHookRegistry(). Default null means
    // the turn's system prompt is the static `this.system`, byte-identical to
    // pre-WP10 behavior. When present, assembleSystem runs once per turn to
    // append live state (skill index, calendar, etc.) ahead of the executor
    // call; a throwing/misbehaving hook registry must never break a turn, so
    // failures here fall back to the static system (defense in depth on top of
    // context-hooks.mjs's own per-hook timeout + fail-open).
    this._contextHooks = contextHooks;
    this._registry = registry;
    this._persist = persist;
    this._allowInterrupt = allowInterrupt != null ? allowInterrupt : INTERRUPT_ALLOWED_KINDS.has(kind);

    this._messages = [];        // the authoritative context array
    this._mailbox = [];         // pending inbound { parts, resolve, reject }
    this._status = "idle";      // 'idle' | 'running' | 'error'
    this._cancel = null;        // abort fn set while a turn runs
    this._idleWaiters = [];     // resolve on idle (awaitIdle)
    this._turns = 0;

    if (this._persist) this._store.upsertAgent?.({ id, kind, status: "idle" });
  }

  get status() { return this._status; }
  get messages() { return this._messages; }
  get turns() { return this._turns; }

  // Queue a message for the agent. Returns a promise that resolves with the
  // assistant text of the turn that consumes it. With { interrupt } (and if this
  // agent's kind may interrupt) the in-flight turn is cancelled first — but the
  // message is pushed to the mailbox BEFORE cancelling (the push-before-cancel
  // invariant), so a cancel can never drop the steering message.
  send(content, { interrupt = false } = {}) {
    const parts = normalizeParts(content);
    return new Promise((resolve, reject) => {
      const item = { parts, resolve, reject };
      this._mailbox.push(item);                          // push BEFORE cancel
      if (interrupt && this._allowInterrupt && this._cancel) {
        try { this._cancel("interrupt"); } catch {}
      }
      this._wakeLoop();
    });
  }

  // Durable steering: persist the message to the store's inbound_queue first, so
  // it survives a crash between enqueue and processing, THEN feed the mailbox.
  // Resolves on durability (the enqueue), not turn completion — matching Conway's
  // sendDurable semantics.
  async sendDurable(content) {
    const parts = normalizeParts(content);
    const seq = this._store.enqueueInbound?.(this.id, parts) ?? null;
    // Feed the live mailbox but don't tie the returned promise to the turn.
    this.send(parts).catch(() => {});
    return seq;
  }

  // Replay any inbound messages persisted-but-unprocessed (call on boot so a
  // message enqueued before a supervisor bounce is not lost).
  replayInbound() {
    const pending = this._store.pendingInbound?.(this.id) || [];
    for (const row of pending) {
      this.send(row.parts).catch(() => {});
      this._store.markInboundProcessed?.(row.seq);
    }
    return pending.length;
  }

  // Cancel the in-flight turn (if any). The loop goes idle after the current
  // turn unwinds; queued mailbox messages are preserved for the next turn.
  cancel(reason = "cancel") {
    if (this._cancel) { try { this._cancel(reason); } catch {} }
  }

  // Resolve when the agent is idle with an empty mailbox. Fast path when already
  // idle; otherwise queued and flushed when the loop exits.
  awaitIdle() {
    if (this._status !== "running" && this._mailbox.length === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  _wakeLoop() {
    if (this._status === "running") return;             // one loop at a time
    // Kick asynchronously so send() returns before the loop runs.
    queueMicrotask(() => this._processLoop());
  }

  async _processLoop() {
    if (this._status === "running") return;
    this._status = "running";
    if (this._persist) this._store.setAgentStatus?.(this.id, "running");
    this.emit("running");
    try {
      while (this._mailbox.length) {
        const batch = this._mailbox.splice(0);           // drain all pending
        // Merge the batch's parts into one user turn.
        const userParts = batch.flatMap((b) => b.parts);
        this._appendMessage("user", "text", userParts);
        let text = "";
        let error = null;
        try {
          text = await this._runTurn(userParts);
        } catch (err) {
          error = err;
          this._status = "error";
        }
        // Resolve/reject the sends that contributed this turn.
        for (const b of batch) {
          if (error) b.reject(error); else b.resolve(text);
        }
        if (error) throw error;
      }
    } catch (err) {
      this.emit("error", err);
    } finally {
      if (this._status !== "error") this._status = "idle";
      if (this._persist) this._store.setAgentStatus?.(this.id, this._status);
      this.emit("idle");
      this._flushIdleWaiters();
    }
  }

  async _runTurn(userParts) {
    const controller = new AbortController();
    this._cancel = (reason) => controller.abort(reason);
    try {
      // 1. render context (WP2 snipping applies here, under budget).
      const rendered = this._renderContext(this._messages, this);
      // 1b. assemble system (WP10 context hooks append live state; fail-soft).
      let system = this.system;
      if (this._contextHooks && typeof this._contextHooks.assembleSystem === "function") {
        try {
          system = await this._contextHooks.assembleSystem(this.system, { messages: rendered, agent: this });
        } catch {
          system = this.system;
        }
      }
      // 2. tools param = allowlist only (WP1); executor may also read the registry.
      const tools = this._registry ? this._registry.toolsForModel() : [];
      // 3. run the turn via the injected (Max-compliant) executor.
      const out = await this._executor({
        agent: this, system, messages: rendered,
        tools, userParts, signal: controller.signal,
      });
      const text = typeof out === "string" ? out : (out?.text ?? "");
      const assistant = (out && out.assistant != null) ? out.assistant : [{ type: "text", text }];
      // 4. append assistant row + persist.
      this._appendMessage("assistant", "text", assistant, out?.usage);
      this._turns++;
      this.emit("turn_complete", { text, usage: out?.usage });
      return text;
    } finally {
      this._cancel = null;
    }
  }

  _appendMessage(role, kind, content, usage = null) {
    const ts = new Date().toISOString();
    const msg = { role, kind, content, ts };
    this._messages.push(msg);
    if (this._persist) {
      const seq = this._store.appendMessage?.({ agentId: this.id, role, kind, content, ts });
      if (seq != null) msg.seq = seq;
    }
    return msg;
  }

  _flushIdleWaiters() {
    if (this._status === "running" || this._mailbox.length) return;
    const waiters = this._idleWaiters.splice(0);
    for (const w of waiters) w();
  }

  // Seed context directly (used by forks inheriting a parent slice — WP3).
  seedMessages(messages) {
    for (const m of messages) {
      this._messages.push(m);
      if (this._persist) this._store.appendMessage?.({ agentId: this.id, role: m.role, kind: m.kind, content: m.content, ts: m.ts });
    }
  }
}

// ---- Reference Max-compliant executor -------------------------------------
//
// Drives a one-shot `claude -p ... --output-format text` per turn with
// ANTHROPIC_API_KEY stripped — the same key-stripped fork pattern the hum
// harvesters use (agent/scripts/hum-harvesters/). The Agent owns the context array, so each turn
// re-renders the transcript into the prompt (claude -p manages its own internal
// context; here we treat it as a stateless text completer over OUR transcript).
// This is a genuine Max-path executor for simple/text turns; the full
// tool-loop executor is a later integration concern. Tests use a mock instead.
export function makeClaudeTextExecutor({ claudeBin = null, model = "haiku", timeoutMs = 45_000 } = {}) {
  const bin = resolveClaudeBin(claudeBin);
  return function claudeTextExecutor({ system, messages, signal }) {
    return new Promise((resolve) => {
      const prompt = renderTranscriptPrompt(system, messages);
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;                       // Max-only invariant
      const args = [...bin.slice(1), "-p", prompt, "--model", model, "--output-format", "text"];
      let child, out = "", done = false;
      const finish = (text) => { if (done) return; done = true; try { child?.kill("SIGKILL"); } catch {} resolve({ text: (text || "").trim() }); };
      try {
        child = spawn(bin[0], args, { env, stdio: ["ignore", "pipe", "pipe"] });
      } catch { return resolve({ text: "" }); }
      const timer = setTimeout(() => finish(out), timeoutMs);
      if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); finish(out); }, { once: true });
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("exit", () => { clearTimeout(timer); finish(out); });
      child.on("error", () => { clearTimeout(timer); finish(out); });
    });
  };
}

function resolveClaudeBin(claudeBin) {
  if (Array.isArray(claudeBin)) return claudeBin;
  if (typeof claudeBin === "string") return [claudeBin];
  const fallback = process.env.CLAUDE_BIN || `${os.homedir()}/.local/bin/claude`;
  return [fallback];
}

function renderTranscriptPrompt(system, messages) {
  const lines = [];
  if (system) lines.push(system, "");
  for (const m of messages) {
    const text = flattenContent(m.content);
    if (text) lines.push(`${m.role.toUpperCase()}: ${text}`);
  }
  lines.push("ASSISTANT:");
  return lines.join("\n");
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenContent).filter(Boolean).join(" ");
  if (content && typeof content === "object") return content.text || "";
  return "";
}
