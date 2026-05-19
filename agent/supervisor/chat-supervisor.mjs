#!/usr/bin/env node
// chat-supervisor.mjs — Merlin chat agent supervisor.
//
// Manages a Claude session for real-time Merlin conversations with a
// priority dispatch queue. Messages arrive from phone-channel via HTTP POST.
//
// Architecture:
//   phone-channel (MCP) → HTTP POST :9094/dispatch → PriorityDispatcher → ClaudeSession
//   Claude calls phone-channel reply tool → Supabase → Merlin app
//
// Flags:
//   --agent chat          agent name from agents.json (default: chat)
//   --config <path>       path to agents.json
//   --model <name>        override agent.model
//   --no-resume           don't try to resume previous session
//   --claude-bin <path>   override claude binary path

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ClaudeSession } from "./claude-session.mjs";
import { PriorityDispatcher } from "../lib/priority-dispatcher.mjs";

const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");

// Prefix every supervisor stderr line with an ISO timestamp; see matching
// block in ops index.mjs for rationale.
const _origConsoleError = console.error.bind(console);
console.error = (...args) => _origConsoleError(new Date().toISOString(), ...args);
import { EventLog } from "./event-log.mjs";
import { State } from "./state.mjs";
import { Instrumentation } from "./instrumentation.mjs";
import { attachClaudeMdWatcher } from "./graceful-restart.mjs";

const HOME = process.env.HOME;
const MERLIN_ROOT = MERLIN_HOME;

// No-op loop detection — kept as an observability counter exposed via /health;
// a turn finishing under NO_OP_DURATION_MS with ≥1 reported turn is *usually*
// a silent empty result from the child, but prompt-cached Max turns can also
// be this fast, so the counter doesn't trigger any automated action on its own.
// Crash-loop recovery still runs off `consecutiveZeroTurns` (num_turns === 0).
const NO_OP_DURATION_MS = 1500;

function parseArgs(argv) {
  const args = { agent: "chat", resume: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") args.agent = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--no-resume") args.resume = false;
    else if (a === "--state-dir") args.stateDir = argv[++i];
    else if (a === "--claude-bin") {
      const v = argv[++i];
      // Support JSON array for bin + prefix args (used by tests).
      try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) { args.claudeBin = parsed; } else { args.claudeBin = v; } } catch { args.claudeBin = v; }
    }
  }
  return args;
}

function loadAgentConfig(configPath, agentName) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const a = cfg.agents[agentName];
  if (!a) throw new Error(`agent "${agentName}" not found in ${configPath}`);
  return a;
}

const MAX_BODY = 64 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

class ChatSupervisor {
  constructor({ args, agentCfg, dataDir, eventDir }) {
    this.args = args;
    this.cfg = agentCfg;
    this.eventLog = new EventLog(eventDir);
    this.instrumentation = new Instrumentation(eventDir);
    this.state = new State(path.join(dataDir, "session.json"));
    this.session = null;
    this.dispatcher = null;
    this.server = null;
    this.startedAt = Date.now();
    this.restartCount = 0;
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.restarting = false;
    this.interrupting = false;
    this.lastPhoneChannelHeartbeat = null;
    this.activeToolMap = new Map(); // tool_use_id → tool name
    // Safety net: if an `assistant` turn ends with substantive text but no
    // mcp__phone-channel__reply tool call, the text is silently dropped (the
    // phone-channel only persists what flows through reply()). Recover by
    // auto-posting the orphaned text. See architecture.md 2026-05-09 entry.
    this.currentTurn = null;
    this.safetyNetFireCount = 0;
    attachClaudeMdWatcher(this, {
      claudeMdPath: path.join(MERLIN_ROOT, this.cfg.cwd, "CLAUDE.md"),
      logPrefix: "[chat-supervisor]",
    });
  }

  async startSession({ resume }) {
    this.sessionStartedAt = Date.now();
    const cfg = this.cfg;
    const healthPort = cfg.supervisor?.healthPort || 9094;
    const mcpConfigPath = path.join(MERLIN_ROOT, "agent/supervisor/chat-mcp-config.json");

    const sessionOpts = {
      sessionId: this.state.sessionId,
      model: this.args.model || cfg.model,
      fallbackModel: cfg.fallbackModel,
      effort: cfg.effort,
      permissionMode: "bypassPermissions",
      maxBudgetUsd: cfg.maxBudgetUsd,
      remoteControlPrefix: cfg.remoteControlPrefix,
      mcpConfig: fs.existsSync(mcpConfigPath) ? mcpConfigPath : undefined,
      allowedTools: (cfg.allowedTools || []).join(" "),
      cwd: path.join(MERLIN_ROOT, cfg.cwd),
      addDirs: [MERLIN_ROOT],
      claudeBin: this.args.claudeBin,
      resume,
      env: { MERLIN_DISPATCH_URL: `http://127.0.0.1:${healthPort}/dispatch` },
      // Chat agent MUST use the Max subscription. Hide ANTHROPIC_API_KEY from
      // the child so claude -p uses the Max credentials in
      // ~/.claude/.credentials.json; the API key is reserved exclusively for
      // phone-channel ack generation (Haiku only).
      unsetEnv: ["ANTHROPIC_API_KEY"],
    };

    this.session = new ClaudeSession(sessionOpts);

    this.session.on("event", (ev) => {
      this.state.touch();
      this.eventLog.append({ kind: ev.type, ...ev });
      this.instrumentation.observe(ev);
      // Track active tool calls for ack status messages, and accumulate per-turn
      // assistant text + reply-tool call for the safety net.
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            this.activeToolMap.set(block.id, block.name);
            if (this.currentTurn && block.name === "mcp__phone-channel__reply") {
              this.currentTurn.replyCalled = true;
            }
          } else if (block.type === "text" && this.currentTurn && typeof block.text === "string") {
            this.currentTurn.text.push(block.text);
          }
        }
      }
      if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) this.activeToolMap.delete(block.tool_use_id);
        }
      }
      if (ev.type === "result") this.activeToolMap.clear();
    });

    this.session.on("result", (ev) => {
      // Safety net: agent emitted text but never called reply → recover.
      // Only applies to user-initiated `merlin` dispatches; init / system
      // pings are allowed to end without a reply.
      const t = this.currentTurn;
      if (t && t.source === "merlin" && !t.replyCalled) {
        const orphaned = t.text.join("\n").trim();
        if (orphaned.length >= 20) {
          this.safetyNetFireCount++;
          console.error(`[chat-supervisor] SAFETY NET: orphaned assistant text (${orphaned.length} chars), no reply tool call — auto-posting`);
          this.eventLog.append({ kind: "safety_net.orphaned_reply", chars: orphaned.length, source: t.source, preview: orphaned.slice(0, 120) });
          this._postOrphanedReply(orphaned).catch((e) => console.error(`[chat-supervisor] safety net post failed: ${e.message}`));
        }
      }
      this.currentTurn = null;
      const turns = ev.num_turns || 0;
      const durationMs = ev.duration_ms || 0;
      if (turns === 0) this.consecutiveZeroTurns++;
      else this.consecutiveZeroTurns = 0;
      if (turns >= 1 && durationMs < NO_OP_DURATION_MS) this.consecutiveNoOpTurns++;
      else this.consecutiveNoOpTurns = 0;
      this.state.recordResult({ costUsd: ev.total_cost_usd || 0, turns });
      this.eventLog.appendCost({
        session_id: ev.session_id,
        duration_ms: ev.duration_ms,
        num_turns: ev.num_turns,
        total_cost_usd: ev.total_cost_usd,
        model_usage: ev.modelUsage,
      });
      console.error(`[chat-supervisor] turn: $${ev.total_cost_usd?.toFixed(4)} / ${ev.num_turns} turns / ${ev.duration_ms}ms`);
    });

    this.session.on("exit", ({ code, signal }) => {
      console.error(`[chat-supervisor] claude exited code=${code} signal=${signal}`);
      if (this.interrupting) return; // Handled by interruptForHighPriority.
      const requeued = this.dispatcher?.requeueInFlight();
      if (requeued) console.error(`[chat-supervisor] re-queued in-flight: ${requeued.source}`);
      if (!this.restarting) this.restart().catch((e) => console.error(`[chat-supervisor] auto-restart failed: ${e.message}`));
    });

    this.session.on("ready", () => {
      if (this.session.resumeFailed) {
        console.error(`[chat-supervisor] --resume failed, rotated session`);
        this.state.rotateSession();
        this.state.data.sessionId = this.session.sessionId;
        this.state.save();
      } else if (resume) {
        this.state.markResumed();
        console.error(`[chat-supervisor] resumed session ${this.state.sessionId}`);
      } else {
        console.error(`[chat-supervisor] started new session ${this.state.sessionId}`);
      }
      this.state.markInitialized();
    });

    await this.session.start();
    console.error(`[chat-supervisor] child spawned`);

    // Transfer pending queue from old dispatcher.
    const pendingItems = this.dispatcher ? [...this.dispatcher.queue] : [];
    this.dispatcher = new PriorityDispatcher(this.session);
    for (const item of pendingItems) this.dispatcher.queue.push(item);
    if (pendingItems.length) {
      console.error(`[chat-supervisor] transferred ${pendingItems.length} queued item(s)`);
      this.dispatcher._drain();
    }

    this.dispatcher.on("enqueued", (item) => this.eventLog.append({ kind: "dispatcher.enqueued", item }));
    this.dispatcher.on("dispatching", (item) => {
      console.error(`[chat-supervisor] dispatch → ${item.source} [${item.priorityName}]: ${item.content.slice(0, 80)}...`);
      this.eventLog.append({ kind: "dispatcher.dispatching", item });
      this.instrumentation.markDispatch(item.id, item.source);
      this.currentTurn = { source: item.source, text: [], replyCalled: false };
    });
    this.dispatcher.on("turn_complete", (info) => {
      this.eventLog.append({ kind: "dispatcher.turn_complete", id: info.message?.id, durationMs: info.result.duration_ms, costUsd: info.result.total_cost_usd });
      this._tryGracefulRestart();
    });
    this.dispatcher.on("interrupt_requested", (item) => this.interruptForHighPriority(item));
    this.dispatcher.on("dispatch_error", ({ item, error }) => {
      console.error(`[chat-supervisor] dispatch_error: ${error} — requeuing ${item.source}`);
      this.eventLog.append({ kind: "dispatcher.dispatch_error", id: item.id, source: item.source, error });
      // Unshift into current dispatcher queue; restart() transfers this queue to the new dispatcher.
      this.dispatcher.queue.unshift(item);
      this.restart().catch((e) => console.error(`[chat-supervisor] restart after dispatch_error failed: ${e.message}`));
    });
  }

  async interruptForHighPriority(urgentItem) {
    if (this.restarting || this.interrupting) return; // Already handling a restart.
    console.error(`[chat-supervisor] INTERRUPTING for high-priority: ${urgentItem.content.slice(0, 60)}...`);
    this.interrupting = true;
    try {
      this.dispatcher.requeueInFlight();
      await this.session.stop({ timeoutMs: 3000 });
      const shouldResume = this.state.canResume;
      await this.startSession({ resume: shouldResume });
    } catch (err) {
      console.error(`[chat-supervisor] interrupt failed: ${err.message}`);
    } finally {
      this.interrupting = false;
    }
  }

  startHttp() {
    const port = this.cfg.supervisor?.healthPort || 9094;
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (req.method === "POST" && url.pathname === "/dispatch") {
        try {
          const body = await readBody(req);
          let payload;
          try { payload = JSON.parse(body); } catch { payload = { content: body }; }
          const content = payload.content || payload.task || payload.message || JSON.stringify(payload);
          const source = payload.source || "webhook";
          const priority = payload.priority || "normal";
          const msgId = payload.msgId || undefined;

          const id = this.dispatcher.dispatch(String(content), source, { priority, msgId });
          json(res, 200, { id: id || "deduped" });
        } catch (err) {
          json(res, 500, { error: err.message });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, this.snapshot());
        return;
      }

      if (req.method === "POST" && url.pathname === "/heartbeat") {
        this.lastPhoneChannelHeartbeat = Date.now();
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/restart") {
        json(res, 202, { restarting: true });
        this.restart().catch((e) => console.error(`[chat-supervisor] restart error: ${e.message}`));
        return;
      }

      if (req.method === "POST" && url.pathname === "/rotate") {
        const oldId = this.state.sessionId;
        this.state.data.everInitialized = false;
        this.state.rotateSession();
        this.consecutiveNoOpTurns = 0;
        this.consecutiveZeroTurns = 0;
        const newId = this.state.sessionId;
        console.error(`[chat-supervisor] MANUAL ROTATION: ${oldId} → ${newId}`);
        json(res, 202, { rotated: true, oldSessionId: oldId, newSessionId: newId });
        this.restart().catch((e) => console.error(`[chat-supervisor] rotate restart error: ${e.message}`));
        return;
      }

      json(res, 404, { error: "not found" });
    });
    this.server.listen(port, "127.0.0.1", () => console.error(`[chat-supervisor] HTTP on :${port}`));

    // Monitor phone-channel heartbeat — restart if stale >3 minutes.
    const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
    setInterval(() => {
      if (this.lastPhoneChannelHeartbeat &&
          Date.now() - this.lastPhoneChannelHeartbeat > HEARTBEAT_STALE_MS &&
          !this.restarting) {
        console.error("[chat-supervisor] phone-channel heartbeat stale — restarting session");
        this.restart().catch((e) => console.error(`[chat-supervisor] heartbeat restart failed: ${e.message}`));
      }
    }, 60_000);
  }

  sendInit() {
    setTimeout(() => {
      if (this.dispatcher) {
        this.dispatcher.dispatch(
          "Session started. Standing by for Merlin messages.",
          "init",
          { priority: "low" }
        );
        console.error(`[chat-supervisor] init message dispatched`);
      }
    }, 3000);
  }

  snapshot() {
    const s = this.state.snapshot();
    const now = Date.now();
    return {
      sessionId: s.sessionId,
      model: this.args.model || this.cfg.model,
      startedAt: new Date(this.startedAt).toISOString(),
      sessionStartedAt: this.sessionStartedAt ? new Date(this.sessionStartedAt).toISOString() : null,
      uptimeMs: now - this.startedAt,
      lastEventTs: s.lastEventTs ? new Date(s.lastEventTs).toISOString() : null,
      lastEventAgeMs: s.lastEventTs ? now - s.lastEventTs : null,
      totalCostUsd: s.totalCostUsd,
      totalTurns: s.totalTurns,
      restartCount: this.restartCount,
      consecutiveZeroTurns: this.consecutiveZeroTurns,
      consecutiveNoOpTurns: this.consecutiveNoOpTurns,
      childAlive: !!(this.session?.child && this.session.child.exitCode === null && this.session.child.signalCode === null),
      phoneChannelHeartbeatAgeMs: this.lastPhoneChannelHeartbeat ? now - this.lastPhoneChannelHeartbeat : null,
      activeTools: [...this.activeToolMap.values()],
      safetyNetFireCount: this.safetyNetFireCount,
      ...this.dispatcher?.snapshot(),
    };
  }

  _getSupabaseKey() {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const env = fs.readFileSync(path.join(MERLIN_ROOT, ".env"), "utf8");
      const m = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch {}
    return null;
  }

  async _postOrphanedReply(message) {
    const key = this._getSupabaseKey();
    if (!key) {
      console.error(`[chat-supervisor] safety net: SUPABASE_SERVICE_ROLE_KEY not available — orphaned text lost: ${message.slice(0, 80)}`);
      return;
    }
    const SUPABASE_URL = "https://${MERLIN_SUPABASE_PROJECT}.supabase.co";
    const res = await fetch(`${SUPABASE_URL}/rest/v1/merlin_messages`, {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify({ role: "assistant", content: message, read: false }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    console.error(`[chat-supervisor] safety net: orphaned reply posted (${message.length} chars)`);
  }

  async restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.restartCount++;
    const delay = Math.min(2000 * Math.pow(2, Math.min(this.restartCount - 1, 5)), 60000);
    console.error(`[chat-supervisor] restart #${this.restartCount} (backoff ${delay}ms)`);
    // Clear heartbeat state — the old phone-channel is dying; the staleness
    // check must not trip on the new phone-channel before it's had a chance
    // to send its first heartbeat.
    this.lastPhoneChannelHeartbeat = null;
    await new Promise((r) => setTimeout(r, delay));
    try { await this.session.stop(); } catch {}

    const CRASH_LOOP_THRESHOLD = 5;
    if (this.consecutiveZeroTurns >= CRASH_LOOP_THRESHOLD) {
      console.error(`[chat-supervisor] CRASH LOOP: ${this.consecutiveZeroTurns} zero-turn exits — rotating session`);
      this.state.data.everInitialized = false;
      this.state.rotateSession();
      this.consecutiveZeroTurns = 0;
    }

    const shouldResume = this.state.canResume;
    if (!shouldResume) {
      console.error(`[chat-supervisor] session never initialized — starting fresh`);
      this.state.rotateSession();
    }
    await this.startSession({ resume: shouldResume });
    this.sendInit(); // Kick the lazy session so MCP servers start.
    this.restarting = false;
  }

  async shutdown() {
    console.error("[chat-supervisor] shutting down");
    this.stopClaudeMdWatcher();
    try { this.server?.close(); } catch {}
    try { await this.session?.stop(); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(MERLIN_ROOT, "agent/config/agents.json");
  const agentCfg = loadAgentConfig(configPath, args.agent);
  const dataDir = args.stateDir || path.join(MERLIN_ROOT, `agent/supervisor/state/${args.agent}`);
  const eventDir = path.join(MERLIN_ROOT, `agent/logs/supervisor-${args.agent}`);

  const supervisor = new ChatSupervisor({ args, agentCfg, dataDir, eventDir });
  const shouldResume = args.resume && supervisor.state.canResume;

  console.error(`[chat-supervisor] starting agent=${args.agent} model=${args.model || agentCfg.model} session=${supervisor.state.sessionId} resume=${shouldResume}`);
  await supervisor.startSession({ resume: shouldResume });
  supervisor.startHttp();
  supervisor.sendInit();
  supervisor.watchClaudeMd();

  const shutdown = async (sig) => {
    console.error(`[chat-supervisor] signal ${sig}`);
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[chat-supervisor] fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
