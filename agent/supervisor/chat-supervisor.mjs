#!/usr/bin/env node
// chat-supervisor.mjs — Edva chat agent supervisor.
//
// Manages a Claude session for real-time Edva conversations with a
// priority dispatch queue. Messages arrive from phone-channel via HTTP POST.
//
// Architecture:
//   phone-channel (MCP) → HTTP POST :9094/dispatch → PriorityDispatcher → ClaudeSession
//   Claude calls phone-channel reply tool → Supabase → Edva app
//
// Flags:
//   --agent chat          agent name from agents.json (default: chat)
//   --config <path>       path to agents.json
//   --model <name>        override agent.model
//   --no-resume           don't try to resume previous session
//   --claude-bin <path>   override claude binary path

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { ClaudeSession, buildLocalRulesFile, watchLocalRules } from "./claude-session.mjs";
import { gitGuardHooks } from "../../lib/rollback-guard-settings.mjs";
import { PriorityDispatcher } from "../lib/priority-dispatcher.mjs";
import { isPhantomResult } from "../lib/phantom-result.mjs";
import { TurnWatchdog, TURN_WATCHDOG_MS_DEFAULT, hangReasonClause } from "./turn-watchdog.mjs";
import { QueueAlarm, CHAT_QUEUE_ALARM_HIGH, CHAT_QUEUE_ALARM_CLEAR } from "./queue-alarm.mjs";

// Prefix every supervisor stderr line with an ISO timestamp; see matching
// block in ops index.mjs for rationale.
const _origConsoleError = console.error.bind(console);
console.error = (...args) => _origConsoleError(new Date().toISOString(), ...args);
import { EventLog } from "./event-log.mjs";
import {
  chatContextGuardDecision,
  CHAT_COMPACT_THRESHOLD_TOKENS,
  CHAT_ROTATE_THRESHOLD_TOKENS,
  CHAT_IDLE_MS,
  MIN_COMPACTABLE_TOKENS,
} from "./context-guard.mjs";
import { State } from "./state.mjs";
import { Instrumentation } from "./instrumentation.mjs";
import { attachClaudeMdWatcher } from "./graceful-restart.mjs";
import { authFailureText, CHAT_AUTH_OFFLINE_REPLY } from "./auth-result.mjs";
import { isQuotaRefusal, rateLimitHoldUntil, RATE_LIMIT_REPROBE_MS } from "./dispatcher.mjs";
import { isCliQuotaMessage, chatQuotaNotice, chatQuotaDroppedNotice, QUOTA_RETRY_HEADER } from "./chat-quota.mjs";
import { userTz } from "../../lib/hum-events.mjs";
import * as substrateStore from "../core/message-store.mjs";
import { Agent } from "../core/agent.mjs";
import { makeClaudeSessionExecutor } from "../core/claude-session-executor.mjs";
import { dueWakes, markFired, pendingWakes } from "../core/check-later.mjs";
import { fork } from "../core/fork.mjs";
import { makeStatelessExecutor } from "../core/stateless-executor.mjs";
import * as forkQueue from "../core/fork-queue.mjs";
import { ReplyDraftTracker } from "../../lib/reply-stream.mjs";
import { installRoot, installTools } from "../../lib/root.cjs";
import { underTestRunner } from "../../lib/load-env.js";
const { instanceValue } = createRequire(import.meta.url)("../../lib/instance.cjs");

// Conway-substrate integration (WP4/WP0), flag-gated + additive. CHAT_SUBSTRATE:
//   off (default) — no substrate code runs; behavior is byte-identical to before.
//   record        — passively tee each chat turn (user + assistant) into the
//                   unified message store (core/message-store.mjs) so chat traffic
//                   becomes queryable substrate. Best-effort / fail-soft; does NOT
//                   change what the model sees or replies.
//   loop          — route dispatches through a core Agent (core/agent.mjs, WP0)
//                   bound to makeClaudeSessionExecutor(this.session). The Agent
//                   owns _messages + turn lifecycle and persists them itself (so
//                   the manual record-mode hooks below are skipped in this mode —
//                   they'd double-write the same turn); the EXISTING --resume'd
//                   ClaudeSession stays the actual execution engine (Max-auth, key
//                   stripped) — no raw SDK, no new spawn. TRANSITIONAL: the
//                   executor sends only the new user turn, not the Agent's full
//                   _messages array, since the ClaudeSession's own --resume
//                   context is still authoritative (see claude-session-executor.mjs).
// Mode resolves from CHAT_SUBSTRATE env, else a runtime toggle file
// (data/chat-substrate-mode) so the mode can be flipped with just a chat
// child restart — no process-manager bounce needed to re-read the env.
function resolveChatSubstrateMode() {
  if (process.env.CHAT_SUBSTRATE) return process.env.CHAT_SUBSTRATE.trim();
  try {
    const f = fs.readFileSync(installTools("data/chat-substrate-mode"), "utf8").trim();
    if (f) return f;
  } catch {}
  return "off";
}
const CHAT_SUBSTRATE = resolveChatSubstrateMode();
const SUBSTRATE_RECORD = CHAT_SUBSTRATE === "record"; // loop mode persists via the Agent itself
const SUBSTRATE_LOOP = CHAT_SUBSTRATE === "loop";

// RETIRED 2026-07-29 — Multipliers 1, 3, 4 and 5 are gone from this file.
//
// They were wired here in July 2026 as "wire the mechanism ahead of the
// content," on the assumption that the executor cutover would follow and make
// the Agent's rendered array + system + tools what the model actually sees.
// That cutover was deliberately abandoned on 2026-07-18 (`claude -p` cannot be
// fed a full authoritative transcript — see core/stateless-executor.mjs and
// system/conway-substrate-plan.md), so chat stayed on `--resume`, which
// means none of them could ever fire:
//
//   M1 auto-snip + applyToBudget    — `--resume` owns context, so nothing is
//                                     ever collapsed. 11 days live: 0 snips.
//   M3 context-hooks + skills index — the executor ignores `system`, and
//                                     agent/skills/ was never populated.
//   M4 snip-backfill tick + hybrid_snip_search — 0 snips means 0 vectors and
//                                     nothing to search; the tool was inert.
//   M5 CAP tools + browser approval-gate — the executor ignores `tools`, so
//                                     the registry was never reachable.
//
// Every core/ module they exercised is intact and tested; they now belong to
// the stateless/fork path (core/stateless-executor.mjs, core/one-shot.mjs,
// runtime/repl-runner.mjs), where a fresh rendered context per run is the
// point. What stays wired here is what actually works under `--resume`:
// check-later's dueWakes ticker (below) and the shared TurnWatchdog/QueueAlarm.
//
// Multiplier 2 (2026-07-18): check-later dueWakes (WP14 core/check-later.mjs)
// drained on a chat-supervisor tick — the one multiplier that IS live end to
// end. The model schedules its own follow-ups with `mcp__tools__check_later`
// (exposed via tools-mcp, keyed to EDVA_AGENT_ID — it never needed the WP1
// registry, which is why it survived the 2026-07-29 retirement above); this is
// the other half. Every tick, any due wake whose session_id matches this chat
// Agent's id gets re-dispatched into the normal priority queue as a
// self-originated message and marked fired (one-shot, per WP14's contract).
// Persisted in memory-index.db, so a wake survives a supervisor bounce between
// being scheduled and firing.
const CHECK_LATER_TICK_INTERVAL_MS = 15_000;

// WP3 forks (2026-07-29): the chat model can hand a bounded research task to a
// background sub-agent instead of doing it inline. `mcp__tools__delegate` writes
// a durable row (core/fork-queue.mjs); this supervisor owns the live chat Agent,
// so it is the only process that can actually fork it — the same split
// check_later already runs in production.
//
// WHY: a research task inside a chat turn blocks the conversation AND lands in
// the 200k window the context guard is already fighting (it fired a /compact at
// 150k earlier today). A fork inherits a bounded slice of the conversation as
// read-only background, runs on the STATELESS executor in its own context, and
// reports back one summary. The conversation pays for the summary, not the
// research.
const FORK_TICK_INTERVAL_MS = 20_000;
// How much conversation a fork inherits. Enough to know what the user is talking
// about, small enough that a fork prompt stays cheap — the whole point is to
// keep work OUT of the big context, so inheriting all of it would defeat it.
const FORK_CONTEXT_MESSAGES = 20;
// A fork's tool surface. `--tools` (availability), NOT `--allowedTools`
// (auto-approve) — the distinction cost a real hole on 2026-07-29: the first
// version passed `allowedTools: "WebSearch WebFetch"` believing that restricted
// the fork, and a probe fork reported its actual surface as "Bash, Edit, Read,
// Write, …, Skill". A sub-agent whose entire job is reading untrusted web
// content had shell and filesystem write access — exactly the prompt-injection
// surface CLAUDE.md § Prompt Injection & Input Safety exists to prevent, since a
// delegated research task is by definition pointed at content Edva does not
// control.
//
// Skill is included deliberately and is the one non-obvious member: forks CAN
// load Edva's real skills (verified — a fork invoked a skill and quoted a
// command that appears only in its body), so a delegated task inherits
// the actual methodology instead of improvising. It gets the JUDGMENT half of a
// skill, not the pipeline half: with no Bash, a skill step that says "run
// <some status CLI>" cannot execute. That is the right trade for an
// untrusted-input sub-agent, and `delegate`'s description says so.
const FORK_TOOLS = "WebSearch,WebFetch,Skill";
const FORK_TIMEOUT_MS = 10 * 60_000;

const HOME = process.env.HOME;
const EDVA_ROOT = installRoot();
// The operator's own rules (agent/local/; see claude-session.mjs § Local
// agent rules). Overridable for tests.
const LOCAL_DIR = process.env.EDVA_LOCAL_DIR || path.join(EDVA_ROOT, "agent/local");


// Turn-count cap for the cold-start guard (per-agent override via agents.json
// `maxSessionTurns`). The chat agent is interactive, so unlike ops it does NOT
// rotate mid-conversation — this cap is only consulted at boot to avoid
// resuming a session that already grew past it (e.g. after a kill before any
// rotation). The active ops turn-count rotation lives in index.mjs.
const MAX_SESSION_TURNS_DEFAULT = 250;

// No-op loop detection — kept as an observability counter exposed via /health;
// a turn finishing under NO_OP_DURATION_MS with ≥1 reported turn is *usually*
// a silent empty result from the child, but prompt-cached Max turns can also
// be this fast, so the counter doesn't trigger any automated action on its own.
// Crash-loop recovery still runs off `consecutiveZeroTurns` (num_turns === 0).
const NO_OP_DURATION_MS = 1500;

// A usage-limit outage saved in session.json is picked up by the next process
// while its hold is running or ended less than this long ago (_restoreQuotaState).
const QUOTA_STATE_TTL_MS = 6 * 3_600_000;
const QUOTA_RESTORE_MAX_HOLD_MS = 8 * 86_400_000;   // = dispatcher.mjs RATE_LIMIT_MAX_HOLD_MS

// Context-size guard (added 2026-06-06). A long-lived --resume'd chat session grows
// past the 200k standard window; Claude Code then auto-escalates to the 1M context
// window, which on the Max subscription hits "Usage credits required for 1M context"
// and breaks chat (the 2026-06-06 incident: a 349-turn / 6-day session walled at the
// 200k→1M boundary). Keep the session under 200k by proactively /compact-ing at ~75%
// (summarizes the conversation, preserving continuity; the session id survives a
// compact so --resume still works), and hard-rotating only as a last resort if that
// doesn't bring context back down. Context size is read from per-assistant-call usage
// (input + cache-read + cache-creation tokens) = the current prompt size.
// Thresholds (compact 150k / rotate 185k / hard rotate 195k) and the decision
// rule — compact only when idle AND there is enough above the floor to remove —
// live in ./context-guard.mjs § Chat (2026-10-04).
const CONTEXT_GUARD_INTERVAL_MS     = 90_000;
const COMPACT_COOLDOWN_MS           = 4 * 60_000; // let a compact land before re-acting
const CONTEXT_GUARD_TURN_FALLBACK   = 220;        // if usage is unreadable, bound by turns

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

// An agent's config from agents.json, with the installation's own connector
// deny list for it appended to `disallowedTools`
// (agent/local/config/agents.json `disallowed_tools: { <agent>: [...] }`).
function loadAgentConfig(configPath, agentName) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const a = cfg.agents[agentName];
  if (!a) throw new Error(`agent "${agentName}" not found in ${configPath}`);
  const extra = createRequire(import.meta.url)("../../lib/instance.cjs").localConfig("agents", { disallowed_tools: {} }).disallowed_tools?.[agentName];
  if (Array.isArray(extra) && extra.length) a.disallowedTools = [...(a.disallowedTools || []), ...extra];
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
    this.dataDir = dataDir;
    this.eventLog = new EventLog(eventDir);
    this.instrumentation = new Instrumentation(eventDir);
    this.state = new State(path.join(dataDir, "session.json"));
    this.session = null;
    this.dispatcher = null;
    this.chatAgent = null; // set in startSession() when CHAT_SUBSTRATE === "loop"
    this.server = null;
    this.startedAt = Date.now();
    this.restartCount = 0;
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.restarting = false;
    this.maxSessionTurns = this.cfg.maxSessionTurns ?? MAX_SESSION_TURNS_DEFAULT;
    this.contextTokens = 0;     // approx current session context, from per-call usage
    this.lastCompactAt = 0;     // when the context guard last injected /compact
    // Conversational activity: their last message arriving, or the last reply
    // turn to one finishing. The guard compacts only after CHAT_IDLE_MS of it.
    this.lastConversationAt = 0;
    // Per-session floor: the first usage-bearing call of a session, keyed on
    // session id so a post-/compact reset keeps the original (same as ops).
    this.sessionFloorTokens = 0;
    this.floorSessionId = null;
    this.lastGuardSkipLogAt = 0;
    // Live run_in_background Bash tasks — mirrors index.mjs's guard (2026-07-09:
    // a context-rotate SIGKILLed an in-flight background research fork ~27s
    // after its turn ended). See hasLiveBackgroundTasks().
    this.liveBackgroundTasks = new Map();
    this.interrupting = false;
    this.lastPhoneChannelHeartbeat = null;
    // Per-turn hang watchdog (parity with ops index.mjs, which has had one since
    // 2026-04-18). Chat previously relied only on the 15-min process-level SIGKILL
    // in process-manager.mjs; this recovers a hung chat turn faster and per-turn.
    // On fire: SIGKILL the child → session "exit" → requeueInFlight → restart.
    this.turnWatchdog = new TurnWatchdog({
      thresholds: this.cfg.turnWatchdogMsBySource || {},
      defaultMs: this.cfg.turnWatchdogMs || TURN_WATCHDOG_MS_DEFAULT,
      onFire: (item, ms, info) => this._onTurnHang(item, ms, info),
    });
    // Queue-backlog alarm (parity with ops index.mjs, which alarms at depth 20).
    // Chat had NONE — a wedged turn could silently pile a deep queue behind it
    // with no page. Chat volume is lower + coalescing collapses rapid bursts, so
    // the thresholds are lower than ops'. Hysteresis: page the system channel once
    // when depth crosses HIGH, then stay quiet until it drains below CLEAR (✅).
    this.queueAlarm = new QueueAlarm({
      high: this.cfg.chatQueueAlarmHigh ?? CHAT_QUEUE_ALARM_HIGH,
      clear: this.cfg.chatQueueAlarmClear ?? CHAT_QUEUE_ALARM_CLEAR,
      onHigh: (depth) => {
        console.error(`[chat-supervisor] QUEUE ALARM: depth=${depth} — chat dispatch backing up`);
        this.eventLog.append({ kind: "queue_alarm.high", depth });
        this._sendSystemAlert(`⚠️ Edva chat queue depth=${depth} — the turn engine may be stuck and messages are piling up. Check \`edva status\`.`);
      },
      onClear: (depth) => {
        this.eventLog.append({ kind: "queue_alarm.clear", depth });
        this._sendSystemAlert(`✅ Edva chat recovered: queue drained (depth=${depth}) — dispatch caught up.`);
      },
    });
    this.activeToolMap = new Map(); // tool_use_id → tool name
    // Safety net: if an `assistant` turn ends with substantive text but no
    // mcp__phone-channel__reply tool call, the text is silently dropped (the
    // phone-channel only persists what flows through reply()). Recover by
    // auto-posting the orphaned text. See changelog.md 2026-05-09 entry.
    this.currentTurn = null;
    this.replyDrafts = new ReplyDraftTracker();
    this.safetyNetFireCount = 0;
    // Consecutive turns that failed Max auth (see the result handler). Logged
    // as "AUTH ERROR #n" so watchdog.sh's existing chat-supervisor.log scan can
    // page, and reset with an "auth restored" line on the first good turn.
    this.authErrorCount = 0;
    // Usage-limit hold (see _onQuotaRefusal). The deadline
    // lives here, not on the dispatcher, so it survives the dispatcher swap a
    // restart does. One plain line to the user per outage, and at most one
    // "set aside" line. The outage is also saved in session.json, so a new
    // supervisor process keeps the hold and does not announce it again.
    this.quotaHoldUntil = 0;
    this._quotaHoldTo = 0;   // the live hold: quotaHoldUntil capped to the next re-check
    this._quotaHoldTimer = null;
    this.quotaInfo = null;
    this.quotaOutage = false;
    this.quotaNoticeSent = false;
    this.quotaDroppedNoticeSent = false;
    this._restoreQuotaState();
    attachClaudeMdWatcher(this, {
      claudeMdPath: path.join(EDVA_ROOT, this.cfg.cwd, "CLAUDE.md"),
      logPrefix: "[chat-supervisor]",
    });
  }

  // Chat role rules: agent/local/shared.md + chat.md → <state>/local-rules.md,
  // passed as --append-system-prompt-file. A failure here never blocks the
  // spawn: the session starts on the kernel rules alone.
  _buildLocalRules() {
    try {
      const r = buildLocalRulesFile({ localDir: LOCAL_DIR, role: "chat", stateDir: this.dataDir });
      this._localRulesContent = r.content;
      return r.path;
    } catch (err) {
      console.error(`[chat-supervisor] local rules unavailable (${err.message}) — starting on the kernel rules alone`);
      return null;
    }
  }

  startLocalWatchers() {
    this._stopLocalRulesWatch = watchLocalRules(this, { localDir: LOCAL_DIR, role: "chat", logPrefix: "[chat-supervisor]" });
  }

  async startSession({ resume }) {
    this.sessionStartedAt = Date.now();
    const cfg = this.cfg;
    const healthPort = cfg.supervisor?.healthPort || 9094;
    const mcpConfigPath = path.join(EDVA_ROOT, "agent/supervisor/chat-mcp-config.json");
    const localRulesFile = this._buildLocalRules();

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
      disallowedTools: (cfg.disallowedTools || []).join(" ") || undefined,
      // Reply streaming (GET /reply-draft). CHAT_REPLY_STREAM=0 turns it off.
      includePartialMessages: process.env.CHAT_REPLY_STREAM !== "0",
      cwd: path.join(EDVA_ROOT, cfg.cwd),
      addDirs: [EDVA_ROOT],
      claudeBin: this.args.claudeBin,
      resume,
      env: { EDVA_DISPATCH_URL: `http://127.0.0.1:${healthPort}/dispatch` },
      // Chat agent MUST use the Max subscription. Hide ANTHROPIC_API_KEY from
      // the child so claude -p uses the Max credentials in
      // ~/.claude/.credentials.json; the API key is reserved exclusively for
      // phone-channel ack generation (Haiku only).
      unsetEnv: ["ANTHROPIC_API_KEY"],
      // No idle compaction for the long-running chat session (Claude Code
      // 2.1.299+ would otherwise compact it after ~54 idle minutes). Chat has its
      // own context guard; this is per supervisor session, so the user's own
      // sessions keep the default. Same setting as the ops tiers in index.mjs,
      // as is the git-rollback guard hook (D2, lib/rollback-guard.mjs).
      settings: JSON.stringify({ idleCompaction: false, hooks: gitGuardHooks() }),
      // The operator's local rules (agent/local/shared.md + chat.md),
      // appended to the system prompt; omitted when there are none.
      appendSystemPromptFile: localRulesFile || undefined,
    };

    this.session = new ClaudeSession(sessionOpts);

    // Loop mode: a fresh Agent bound to the fresh session, every time startSession()
    // runs (boot, restart, interrupt) — mirrors how `this.dispatcher` is already
    // recreated fresh below. The Agent's in-memory _messages reset across a restart,
    // but that's fine: the ClaudeSession's own --resume context is still the
    // conversational source of truth (see claude-session-executor.mjs), and every
    // turn the Agent DOES see is durably persisted to the WP4 store regardless.
    // forkExecutor is load-bearing, not decoration: core/fork.mjs prefers it
    // precisely so a fork never inherits a parent bound to the persistent
    // --resume session. If a fork ran on the chat executor its turns would land
    // IN the user's conversation.
    this.chatAgent = SUBSTRATE_LOOP
      ? new Agent("chat", {
          executor: makeClaudeSessionExecutor(this.session),
          forkExecutor: makeStatelessExecutor({
            model: this.cfg.model || "claude-sonnet-5-5",
            effort: "low",
            tools: FORK_TOOLS,
            // Without this the fork auto-discovers .mcp.json from its cwd and
            // inherits the chat agent's whole MCP surface — the 2026-07-29 probe
            // caught it holding chrome-devtools (a logged-in browser profile)
            // and Gmail. No --mcp-config is passed, so
            // strict mode leaves it with zero MCP servers.
            strictMcpConfig: true,
            timeoutMs: FORK_TIMEOUT_MS,
            cwd: path.join(EDVA_ROOT, this.cfg.cwd || "agent/chat-agent"),
            // The fork loads chat-agent's CLAUDE.md files from that cwd; it
            // gets the same local rules as the session beside them.
            appendSystemPromptFile: localRulesFile || undefined,
          }),
        })
      : null;

    this.session.on("event", (ev) => {
      this.state.touch();
      // Child stream activity (partial chunks included) feeds the armed turn's
      // watchdog, which classifies the event as progress or a thinking_tokens
      // heartbeat (2026-10-08).
      this.turnWatchdog.touch(ev);
      // Partial-message chunks feed the reply draft and nothing else: there are
      // hundreds per reply, and the full assistant event still follows.
      if (this.replyDrafts.observe(ev)) return;
      this.eventLog.append({ kind: ev.type, ...ev });
      this.instrumentation.observe(ev);
      // Track active tool calls for ack status messages, and accumulate per-turn
      // assistant text + reply-tool call for the safety net.
      if (ev.type === "assistant" && ev.message?.content) {
        // The CLI's own usage-limit message ("You've hit your weekly limit ·
        // resets 11pm") is not the agent's words: flag the turn and keep its
        // text out of the safety net.
        const cliQuota = isCliQuotaMessage(ev);
        if (cliQuota && this.currentTurn) this.currentTurn.quotaError = true;
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            this.activeToolMap.set(block.id, block.name);
            if (this.currentTurn) this.currentTurn.toolUsed = true;
            if (this.currentTurn && block.name === "mcp__phone-channel__reply") {
              this.currentTurn.replyCalled = true;
            }
          } else if (!cliQuota && block.type === "text" && this.currentTurn && typeof block.text === "string") {
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
      // Track approx current context size from per-assistant-call usage, for the
      // context-size guard (compact-before-1M). The last assistant call in a turn
      // carries the full prompt = current context; it drops after a /compact.
      if (ev.type === "assistant" && ev.message?.usage) {
        const u = ev.message.usage;
        const ctx = (u.input_tokens ?? u.inputTokens ?? 0)
                  + (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0)
                  + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
        if (ctx > 0) this.contextTokens = ctx;
        // A resumed session keeps the floor its own first call measured (same
        // as index.mjs): after a restart the first call carries the whole
        // resumed conversation, which is not floor.
        const keptFloor = ctx > 0 && this.floorSessionId !== this.state.sessionId
          ? this.state.floorFor(this.state.sessionId) : 0;
        if (keptFloor > 0) {
          this.floorSessionId = this.state.sessionId;
          this.sessionFloorTokens = Math.min(keptFloor, ctx);
          this.eventLog.append({ kind: "context.floor_restored", sessionId: this.state.sessionId, floorTokens: keptFloor, contextTokens: ctx });
        } else if (ctx > 0 && this.floorSessionId !== this.state.sessionId) {
          this.floorSessionId = this.state.sessionId;
          this.sessionFloorTokens = ctx;
          this.state.recordFloor(this.state.sessionId, ctx);
          this.eventLog.append({
            kind: "context.floor_measured", sessionId: this.state.sessionId, floorTokens: ctx,
            compactThreshold: CHAT_COMPACT_THRESHOLD_TOKENS, rotateThreshold: CHAT_ROTATE_THRESHOLD_TOKENS,
            workingWindowTokens: Math.max(0, CHAT_ROTATE_THRESHOLD_TOKENS - ctx),
          });
        }
      }
      // Track run_in_background Bash tasks (see index.mjs's identical guard).
      if (ev.type === "user") {
        const backgroundTaskId = ev.tool_use_result?.backgroundTaskId;
        if (backgroundTaskId) this.liveBackgroundTasks.set(backgroundTaskId, Date.now());
        const content = ev.message?.content;
        if (typeof content === "string" && content.includes("<task-notification>")) {
          const m = content.match(/<task-id>([^<]+)<\/task-id>/); // lang-regex-ok: extracts the <task-id> tag from a harness task-notification, not anyone's words
          if (m) this.liveBackgroundTasks.delete(m[1]);
        }
      }
    });

    this.session.on("rate_limit", (ev) => {
      const info = ev?.rate_limit_info;
      // Same line index.mjs writes, so the two supervisors' logs read alike.
      if (info?.status !== "allowed") console.error(`[chat-supervisor] RATE LIMIT: ${JSON.stringify(info)}`);
      if (this.currentTurn && isQuotaRefusal(info)) this.currentTurn.quotaInfo = info;
    });

    this.session.on("result", (ev) => {
      // Max-auth failure (2026-09-22). Before this,
      // chat had no auth check: the turn's only text was the CLI's error, the
      // safety net below posted it to the user as their answer, and nothing wrote
      // the "AUTH ERROR" line watchdog.sh greps this log for, so a chat-side
      // outage paged nobody. The line format matches index.mjs's on purpose.
      const authFail = authFailureText(ev);
      // A zero-work result while a turn is in flight is not that turn's end
      // (lib/phantom-result.mjs): a respawned --resume child can send one ~2 s
      // into the retry after a turn-watchdog kill, and a no-op /compact on a
      // fresh session looks the same. The dispatcher already ignores it and keeps
      // the item in flight; until 2026-10-13 this listener did not, and cleared
      // currentTurn and the hang timer, leaving that turn with no safety net and
      // no hang recovery. None was logged on chat since July, so this is a guard.
      // An auth failure is never skipped.
      if (!authFail && this.dispatcher?.inFlight && isPhantomResult(ev)) return;
      if (authFail) {
        this.authErrorCount++;
        console.error(`[chat-supervisor] AUTH ERROR #${this.authErrorCount}: ${authFail.slice(0, 160)}`);
        this.eventLog.append({ kind: "auth_error", count: this.authErrorCount, preview: authFail.slice(0, 120) });
      } else if (typeof ev.result === "string" && this.authErrorCount > 0) {
        console.error(`[chat-supervisor] auth restored after ${this.authErrorCount} failed turn(s)`);
        this.eventLog.append({ kind: "auth_restored", count: this.authErrorCount });
        this.authErrorCount = 0;
      }
      // Safety net: agent emitted text but never called reply → recover.
      // Only applies to user-initiated `edva` dispatches; init / system
      // pings are allowed to end without a reply.
      const t = this.currentTurn;
      // Usage-limit refusal (ops' half is dispatcher.mjs),
      // known only from structure: a rejected rate_limit_event during this
      // turn, or the CLI's synthetic message with error "rate_limit". This
      // listener runs before PriorityDispatcher's (subscribed later), so the
      // refused item can still be taken back out of flight. A resume-handshake
      // result is not this turn's end (the turn is still running), so it never
      // reads as a refusal.
      const quota = !authFail && t && (t.quotaInfo || t.quotaError) && !isPhantomResult(ev) ? this._onQuotaRefusal(ev, t) : null;
      if (t && t.source === "edva" && !t.replyCalled && authFail) {
        // Never hand the user the CLI's error string as their reply. They asked
        // something and are waiting, so they still hear back, in plain words.
        this.safetyNetFireCount++;
        console.error(`[chat-supervisor] SAFETY NET: turn failed Max auth — posting the offline notice instead of the raw CLI error`);
        this.eventLog.append({ kind: "safety_net.auth_offline_reply", source: t.source });
        this._postOrphanedReply(CHAT_AUTH_OFFLINE_REPLY).catch((e) => console.error(`[chat-supervisor] safety net post failed: ${e.message}`));
      } else if (t && t.source === "edva" && !t.replyCalled && !quota?.noWork) {
        // A refused turn that did no work has no answer in it to rescue.
        const orphaned = t.text.join("\n").trim();
        // Any non-empty text. This was `>= 20` chars, which silently dropped
        // short real answers — a one-word answer (9 chars) once never
        // reached the user. A edva turn's text IS the answer to them.
        if (orphaned.length > 0) {
          this.safetyNetFireCount++;
          console.error(`[chat-supervisor] SAFETY NET: orphaned assistant text (${orphaned.length} chars), no reply tool call — auto-posting`);
          this.eventLog.append({ kind: "safety_net.orphaned_reply", chars: orphaned.length, source: t.source, preview: orphaned.slice(0, 120) });
          this._postOrphanedReply(orphaned).catch((e) => console.error(`[chat-supervisor] safety net post failed: ${e.message}`));
        }
      }
      if (quota && t.source === "edva") {
        if (quota.dropped) this._maybeQuotaDroppedNotice({ info: quota.info, several: quota.merged > 0 });
        else if (quota.requeued || !t.replyCalled) this._maybeQuotaNotice({ requeued: quota.requeued });
      } else if (quota) {
        // A background turn (a wake, init, the context guard's /compact) hit the
        // limit while their message waits behind it: they hear why, once.
        if (this.dispatcher?.queue.some((i) => i.source === "edva")) this._maybeQuotaNotice();
      } else if (!authFail && !isPhantomResult(ev) && this.quotaOutage && t && t.source !== "context-guard" && !this.dispatcher?.isHeld()) {
        // The first real turn after a hold: the limit has actually cleared.
        console.error(`[chat-supervisor] quota cleared — ${t.source} turn completed after the hold`);
        this.eventLog.append({ kind: "quota_cleared", source: t.source });
        this.quotaOutage = false;
        // The window may have come back before the reset it named; the next
        // outage must not inherit that reset (the notice and restart record read it).
        this.quotaHoldUntil = 0;
        this._quotaHoldTo = 0;
        this.quotaNoticeSent = false;
        this.quotaDroppedNoticeSent = false;
        this._saveQuotaState();
      }
      if (SUBSTRATE_RECORD && t) {
        try {
          const assistantText = t.text.join("\n").trim();
          if (assistantText) substrateStore.appendMessage({ agentId: "chat", role: "assistant", kind: "text", content: assistantText });
        } catch {}
      }
      this.currentTurn = null;
      this.turnWatchdog.clear();   // turn produced a result → disarm the hang timer
      const turns = ev.num_turns || 0;
      const durationMs = ev.duration_ms || 0;
      if (turns === 0) this.consecutiveZeroTurns++;
      else this.consecutiveZeroTurns = 0;
      if (!quota && turns >= 1 && durationMs < NO_OP_DURATION_MS) this.consecutiveNoOpTurns++;
      else this.consecutiveNoOpTurns = 0;
      this.state.recordResult({ costUsd: ev.total_cost_usd || 0, turns });
      this.state.data.contextTokens = this.contextTokens; // for the cold-start guard
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
        this.contextTokens = 0;
        this.state.save();
      } else if (resume) {
        this.state.markResumed();
        console.error(`[chat-supervisor] resumed session ${this.state.sessionId}`);
      } else {
        this.contextTokens = 0;
        console.error(`[chat-supervisor] started new session ${this.state.sessionId}`);
      }
      this.state.markInitialized();
    });

    await this.session.start();
    console.error(`[chat-supervisor] child spawned`);

    // Loop mode: route dispatch through the Agent instead of session.send()
    // directly, while session.on("result") (wired inside PriorityDispatcher's own
    // constructor) stays the turn-complete signal exactly as before — the Agent's
    // executor is the thing that actually calls session.send() under the hood.
    // Preserve the same "session not running" guard ClaudeSession.send() would
    // throw itself, so the dispatch_error → requeue/restart self-healing path
    // still fires; the executor otherwise swallows a send failure into a quiet
    // empty-text turn instead of rejecting, which would silently drop the item.
    const loopSendFn = this.chatAgent
      ? (content) => {
          if (!this.session.child || this.session.child.exitCode !== null) {
            throw new Error("session not running");
          }
          this.chatAgent.send(content).catch((err) => console.error(`[chat-supervisor] loop-mode agent.send error: ${err.message}`));
        }
      : undefined;

    // Transfer pending queue from old dispatcher.
    const pendingItems = this.dispatcher ? [...this.dispatcher.queue] : [];
    this.dispatcher = new PriorityDispatcher(this.session, { sendFn: loopSendFn });
    if (this._quotaHoldTo > Date.now()) this.dispatcher.hold(this._quotaHoldTo);   // a hold outlives a restart
    for (const item of pendingItems) this.dispatcher.queue.push(item);
    if (pendingItems.length) console.error(`[chat-supervisor] transferred ${pendingItems.length} queued item(s)`);

    this.dispatcher.on("enqueued", (item) => {
      this.eventLog.append({ kind: "dispatcher.enqueued", item });
      // They wrote while dispatch is held for the usage limit: say why, once.
      if (item.source === "edva" && this.dispatcher.isHeld()) this._maybeQuotaNotice();
      this._checkQueueAlarm();
    });
    // Several same-source, same-priority queued items merged into one turn (e.g.
    // The user rapid-fired 3 messages) — the Claude-Code "type several lines, one
    // turn" behavior. Log it so a merged turn isn't mistaken for a dropped one.
    this.dispatcher.on("coalesced", ({ source, mergedCount, priorityName }) => {
      console.error(`[chat-supervisor] coalesced ${mergedCount + 1} ${source} [${priorityName}] messages into one turn`);
      this.eventLog.append({ kind: "dispatcher.coalesced", source, mergedCount, priorityName });
    });
    this.dispatcher.on("dispatching", (item) => {
      const mergeNote = item.mergedCount ? ` (+${item.mergedCount} merged)` : "";
      console.error(`[chat-supervisor] dispatch → ${item.source} [${item.priorityName}]${mergeNote}: ${item.content.slice(0, 80)}...`);
      this.eventLog.append({ kind: "dispatcher.dispatching", item });
      this.instrumentation.markDispatch(item.id, item.source);
      this.currentTurn = { source: item.source, text: [], replyCalled: false };
      this.replyDrafts.reset();
      this.turnWatchdog.arm(item);   // hang recovery: cleared on "result"
      if (SUBSTRATE_RECORD) {
        try { substrateStore.appendMessage({ agentId: "chat", role: "user", kind: item.source, content: item.content }); } catch {}
      }
    });
    // A resume-handshake result was correctly NOT attributed to the in-flight
    // item (lib/phantom-result.mjs). On chat the swallowed item would be a
    // message from the user that never gets a reply, so this is worth a log line.
    this.dispatcher.on("phantom_result", ({ item }) => {
      console.error(`[chat-supervisor] ignored resume-handshake result for in-flight ${item.id?.slice(0, 6)} (${item.source}) — turn still running`);
      this.eventLog.append({ kind: "dispatcher.phantom_result", itemId: item.id, source: item.source });
    });
    this.dispatcher.on("turn_complete", (info) => {
      this.eventLog.append({ kind: "dispatcher.turn_complete", id: info.message?.id, durationMs: info.result.duration_ms, costUsd: info.result.total_cost_usd });
      if (info.message?.source === "edva") this.lastConversationAt = Date.now();
      // After a context-guard /compact, optimistically reset the tracked context so
      // the guard doesn't immediately re-fire; the next real turn re-measures it.
      if (info.message?.source === "context-guard") {
        this.contextTokens = 0;
        console.error(`[chat-supervisor] /compact turn complete — context tracker reset`);
      }
      this._checkQueueAlarm();   // depth may have drained below CLEAR → recovery ✅
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
    // Drain the handed-over queue only once every listener above is attached.
    // Draining it before them (as this did until 2026-10-13) sent the first
    // queued item with no "dispatching" handler, so that turn had no
    // currentTurn: no safety net, no usage-limit check and no hang timer (for
    // instance a message whose usage-limit hold ran out during a restart).
    if (pendingItems.length) this.dispatcher._drain();
  }

  async interruptForHighPriority(urgentItem) {
    if (this.restarting || this.interrupting) return; // Already handling a restart.
    console.error(`[chat-supervisor] INTERRUPTING for high-priority: ${urgentItem.content.slice(0, 60)}...`);
    this.interrupting = true;
    this.turnWatchdog.clear();   // the interrupted turn is being torn down
    try {
      this.dispatcher.requeueInFlight();
      // Loop mode: abort any in-flight Agent turn tied to the dying session so its
      // executor's abort handler resolves (partial text) instead of hanging forever
      // on a "result" event the dead session will never emit.
      this.chatAgent?.cancel("interrupt");
      await this.session.stop({ timeoutMs: 3000 });
      const shouldResume = this.state.canResume;
      await this.startSession({ resume: shouldResume });
    } catch (err) {
      console.error(`[chat-supervisor] interrupt failed: ${err.message}`);
    } finally {
      this.interrupting = false;
    }
  }

  // Per-turn hang recovery (TurnWatchdog onFire). A turn produced no `result`
  // within its window → the child is hung. SIGKILL it: session.on("exit") →
  // requeueInFlight() → restart(), so the stuck item is retried on a fresh
  // session and the queue behind it drains. Surfaced to the system channel so a
  // silent kill is visible.
  // Activity-aware since 2026-10-08 (turn-watchdog.mjs § Hybrid detection):
  // `info.reason` (idle | window | ceiling) names why it fired; its clause is
  // appended after the unchanged "restarting to retry" wording.
  _onTurnHang(item, ms, info) {
    const src = item?.source || "unknown";
    const mins = Math.round((info?.elapsedMs ?? ms) / 60000);
    const why = hangReasonClause(info);
    // Track how many times THIS item has hung. A deterministically-hanging item
    // (a poison message that wedges every turn it runs) would otherwise be
    // requeued and re-killed forever. After the first hang we retry once; on the
    // second we DROP it so it can't wedge the queue in a loop.
    const hangCount = (item ? (item.hangCount = (item.hangCount || 0) + 1) : 1);
    const drop = hangCount >= 2;
    if (drop && this.dispatcher) {
      // Clear inFlight BEFORE the SIGKILL so session.on("exit") → requeueInFlight()
      // finds nothing to requeue — the poison item is discarded, not retried.
      this.dispatcher.inFlight = null;
    }
    console.error(`[chat-supervisor] TURN WATCHDOG: no result in ${mins}min for ${src} (item ${item?.id}, hang #${hangCount}, reason ${info?.reason || "window"}, silent ${info ? Math.round(info.silentMs / 1000) + "s" : "?"}, since progress ${info ? Math.round(info.sinceProgressMs / 1000) + "s" : "?"}) — ${drop ? "DROPPING (repeat hang)" : "requeue"} + kill child`);
    this.eventLog.append({ kind: "turn_watchdog.hang", source: src, itemId: item?.id, windowMs: ms, hangCount, dropped: drop, reason: info?.reason, silentMs: info?.silentMs, sinceProgressMs: info?.sinceProgressMs, elapsedMs: info?.elapsedMs });
    this._sendSystemAlert(
      drop
        ? `⚠️ Chat turn from ${src} hung ${mins}min again (2nd time)${why} — dropping it and restarting so it stops wedging the queue.`
        : `⚠️ Chat turn from ${src} hung for ${mins}min with no result — killing + restarting to retry${why}.`
    );
    try { this.session?.child?.kill("SIGKILL"); } catch {}
  }

  // Called on enqueue (depth may cross HIGH) and on turn_complete (depth may
  // drain below CLEAR). The QueueAlarm owns the hysteresis + fires the notifiers.
  _checkQueueAlarm() {
    this.queueAlarm.check(this.dispatcher?.queue?.length || 0);
  }

  // Fire-and-forget system-channel alert (mirrors ops index.mjs _sendPush).
  // --skip-precheck: a supervisor self-alert must not depend on the Sonnet-gated
  // outbound precheck, which needs the agent up to run.
  _sendSystemAlert(text) {
    try {
      const bin = path.join(EDVA_ROOT, "bin/edva-send-curl");
      // EDVA_INFRA_PROBE=1 — see the fabricated-outage gate in
      // bin/edva-send-curl. The supervisor reports its own process
      // state from outside the agent sandbox, so it may page on machine health.
      const p = spawn(bin, ["--suppress-hook", "--skip-precheck", "--intent", "supervisor-alert", "--channel", "system", text], { stdio: "ignore", detached: true, env: { ...process.env, EDVA_INFRA_PROBE: "1" } });
      p.unref();
    } catch (err) {
      console.error(`[chat-supervisor] _sendSystemAlert failed: ${err.message}`);
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

          if (source === "edva") this.lastConversationAt = Date.now();
          const id = this.dispatcher.dispatch(String(content), source, { priority, msgId });
          json(res, 200, { id: id || "deduped" });
        } catch (err) {
          json(res, 500, { error: err.message });
        }
        return;
      }

      // Polled by phone-channel (~400ms) while a reply is outstanding; it owns
      // every write to the chat row, this only reports what's been written.
      if (req.method === "GET" && url.pathname === "/reply-draft") {
        json(res, 200, { turnActive: !!this.currentTurn, drafts: this.replyDrafts.snapshot() });
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

    this.startContextGuard();
    this.startCheckLaterTick();
    this.startForkTick();
  }

  // Context-size guard: keep the chat session under the 200k standard window so it
  // never auto-escalates to the usage-credits-gated 1M context. Prefer /compact
  // (continuity-preserving); hard-rotate only as a last resort. Runs only when idle.
  startContextGuard() {
    setInterval(() => {
      if (this.restarting || this.interrupting) return;
      if (this.dispatcher?.isHeld()) return;                   // usage-limit hold — nothing runs
      if (this.dispatcher?.inFlight) return;                  // mid-turn — wait
      if ((this.dispatcher?.queue?.length || 0) > 0) return;  // work queued — wait
      const ctx = this.contextTokens;
      const turns = this.state.data?.totalTurns || 0;
      const floor = this.floorSessionId === this.state.sessionId ? this.sessionFloorTokens : 0;
      const idleMs = Date.now() - this.lastConversationAt;
      const decision = ctx > 0 ? chatContextGuardDecision({ ctx, floor, idleMs }) : "none";
      if (decision === "rotate") {
        if (this.hasLiveBackgroundTasks()) {
          console.error(`[chat-supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CHAT_ROTATE_THRESHOLD_TOKENS} but deferring hard rotate — ${this.liveBackgroundTasks.size} background task(s) still in flight`);
          return;
        }
        console.error(`[chat-supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CHAT_ROTATE_THRESHOLD_TOKENS} — hard rotate (idle ${Math.round(idleMs / 1000)}s)`);
        this._rotateForContext(`ctx=${ctx}`);
      } else if (decision === "compact" && Date.now() - this.lastCompactAt > COMPACT_COOLDOWN_MS) {
        this.lastCompactAt = Date.now();
        console.error(`[chat-supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CHAT_COMPACT_THRESHOLD_TOKENS}, floor=${floor}, idle ${Math.round(idleMs / 1000)}s — injecting /compact`);
        this.eventLog.append({ kind: "context_guard.compact", contextTokens: ctx, floorTokens: floor, idleMs });
        this.dispatcher.dispatch("/compact", "context-guard", { priority: "high" });
      } else if (decision === "skip-compact" || decision === "wait") {
        // Throttled: this re-evaluates every tick and the answer rarely changes.
        if (Date.now() - this.lastGuardSkipLogAt > 15 * 60_000) {
          this.lastGuardSkipLogAt = Date.now();
          const why = decision === "wait"
            ? `conversation active (idle ${Math.round(idleMs / 1000)}s < ${CHAT_IDLE_MS / 1000}s)`
            : `only ${ctx - floor} above floor ${floor} (< ${MIN_COMPACTABLE_TOKENS}) — nothing to compact`;
          console.error(`[chat-supervisor] CONTEXT GUARD: ctx=${ctx} — ${decision}: ${why}`);
          this.eventLog.append({ kind: `context_guard.${decision}`, contextTokens: ctx, floorTokens: floor, idleMs });
        }
      } else if (ctx === 0 && turns >= CONTEXT_GUARD_TURN_FALLBACK) {
        if (this.hasLiveBackgroundTasks()) {
          console.error(`[chat-supervisor] CONTEXT GUARD: usage unreadable, turns=${turns} ≥ ${CONTEXT_GUARD_TURN_FALLBACK} but deferring — ${this.liveBackgroundTasks.size} background task(s) still in flight`);
          return;
        }
        // Usage was never readable but the session is clearly old — bound by turns.
        console.error(`[chat-supervisor] CONTEXT GUARD: usage unreadable, turns=${turns} ≥ ${CONTEXT_GUARD_TURN_FALLBACK} — rotating`);
        this._rotateForContext(`turn-fallback turns=${turns}`);
      }
    }, CONTEXT_GUARD_INTERVAL_MS).unref?.();
    console.error(`[chat-supervisor] context guard on (compact@${CHAT_COMPACT_THRESHOLD_TOKENS} / rotate@${CHAT_ROTATE_THRESHOLD_TOKENS} / every ${CONTEXT_GUARD_INTERVAL_MS / 1000}s)`);
  }

  // check-later tick (WP14): drain any due self-wakes for this chat Agent and
  // re-dispatch them into the normal queue. Started once from startHttp() —
  // independent of session restarts, like startContextGuard — because
  // dueWakes()/markFired() are plain DB ops that don't care which ClaudeSession
  // instance is currently live. Fail-soft: a DB hiccup skips this tick, not the
  // process; a dispatch failure leaves the wake unfired so it's retried next
  // tick instead of being silently lost.
  startCheckLaterTick() {
    setInterval(() => {
      if (!this.chatAgent || !this.dispatcher) return;   // only meaningful in loop mode, once wired up
      let due;
      try {
        due = dueWakes().filter((w) => w.sessionId === this.chatAgent.id);
      } catch (err) {
        console.error(`[chat-supervisor] check-later dueWakes failed: ${err.message}`);
        return;
      }
      for (const wake of due) {
        try {
          this.dispatcher.dispatch(`[check-later wake] ${wake.note}`, "check-later", { priority: "normal" });
          markFired(wake.id);
          console.error(`[chat-supervisor] check-later wake fired: id=${wake.id} note="${wake.note}"`);
          this.eventLog.append({ kind: "check_later.fired", id: wake.id, note: wake.note });
        } catch (err) {
          console.error(`[chat-supervisor] check-later dispatch failed for wake ${wake.id}: ${err.message}`);
        }
      }
    }, CHECK_LATER_TICK_INTERVAL_MS).unref?.();
    console.error(`[chat-supervisor] check-later tick on (every ${CHECK_LATER_TICK_INTERVAL_MS / 1000}s)`);
  }

  // Fork tick (WP3): drain delegate requests for this chat Agent and run each
  // as a real background sub-agent. Started once from startHttp(), like the
  // other tickers — the queue is in memory-index.db and does not care which
  // ClaudeSession is currently live.
  //
  // The fork runs on the Agent's forkExecutor (stateless, fresh `claude -p`), so
  // nothing it does touches the user's conversation until it reports back. When it
  // finishes, the summary is dispatched into the normal priority queue as a
  // self-originated message — the same delivery check-later uses — so the chat
  // agent relays it in its own voice rather than the supervisor pushing raw
  // model output at the user (Rule #0).
  startForkTick() {
    setInterval(() => {
      if (!this.chatAgent || !this.dispatcher) return;

      // A fork left 'running' across a bounce died with the supervisor. Reclaim
      // it, or the in-flight cap leaks a slot and delegation silently stops.
      try {
        const reclaimed = forkQueue.reclaimStale(this.chatAgent.id);
        if (reclaimed) console.error(`[chat-supervisor] reclaimed ${reclaimed} abandoned fork(s)`);
      } catch (err) {
        console.error(`[chat-supervisor] fork reclaim failed: ${err.message}`);
      }

      let queued;
      try {
        queued = forkQueue.queuedForks(this.chatAgent.id);
      } catch (err) {
        console.error(`[chat-supervisor] fork queue read failed: ${err.message}`);
        return;
      }

      for (const row of queued) {
        try {
          // Inherit only the tail of the conversation — enough for the fork to
          // know the subject, not so much that we recreate the big context we
          // are trying to stay out of.
          const start = Math.max(0, this.chatAgent.messages.length - FORK_CONTEXT_MESSAGES);
          const { forkId, joined } = fork(this.chatAgent, {
            task: row.task,
            autoJoin: false,          // deliver via the dispatcher, not the parent's mailbox
            contextStartIndex: start,
          });
          forkQueue.markRunning(row.id, forkId);
          console.error(`[chat-supervisor] fork started: ${forkId} — "${row.task.slice(0, 80)}"`);
          this.eventLog.append({ kind: "fork.started", forkId, requestId: row.id, task: row.task });

          joined.then((summary) => {
            forkQueue.markDone(row.id, summary);
            this.eventLog.append({ kind: "fork.done", forkId, requestId: row.id });
            console.error(`[chat-supervisor] fork done: ${forkId}`);
            this.dispatcher.dispatch(
              `[background task done] You asked a background sub-agent to: ${row.task}\n\nIt reports:\n${summary}\n\nRelay what matters to the user in your own voice.`,
              "fork",
              { priority: "normal" },
            );
          }).catch((err) => {
            forkQueue.markFailed(row.id, err.message);
            this.eventLog.append({ kind: "fork.failed", forkId, requestId: row.id, error: err.message });
            console.error(`[chat-supervisor] fork failed: ${forkId} — ${err.message}`);
            // Tell the user it failed rather than leaving them waiting on a
            // background task that silently died.
            this.dispatcher.dispatch(
              `[background task failed] The background task "${row.task.slice(0, 120)}" could not complete (${err.message}). Let the user know briefly.`,
              "fork",
              { priority: "normal" },
            );
          });
        } catch (err) {
          forkQueue.markFailed(row.id, err.message);
          console.error(`[chat-supervisor] fork spawn failed for request ${row.id}: ${err.message}`);
        }
      }
    }, FORK_TICK_INTERVAL_MS).unref?.();
    console.error(`[chat-supervisor] fork tick on (every ${FORK_TICK_INTERVAL_MS / 1000}s)`);
  }

  // True if any run_in_background Bash task is still presumed live. Mirrors
  // index.mjs — see BACKGROUND_TASK_MAX_AGE_MS there for the staleness ceiling
  // rationale; chat-supervisor reuses the same constant name if defined, else
  // falls back to 20 minutes.
  hasLiveBackgroundTasks() {
    if (this.liveBackgroundTasks.size === 0) return false;
    const maxAgeMs = Number(process.env.OPS_BACKGROUND_TASK_MAX_AGE_MS) || 20 * 60_000;
    const now = Date.now();
    for (const [id, startedAt] of this.liveBackgroundTasks) {
      if (now - startedAt > maxAgeMs) {
        console.error(`[chat-supervisor] background task ${id} exceeded ${maxAgeMs / 60000}min with no notification — treating as stale, no longer gating rotation`);
        this.liveBackgroundTasks.delete(id);
      }
    }
    return this.liveBackgroundTasks.size > 0;
  }

  _rotateForContext(reason) {
    const oldId = this.state.sessionId;
    this.state.data.everInitialized = false;
    this.state.rotateSession();
    this.contextTokens = 0;
    this.lastCompactAt = 0;
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.eventLog.append({ kind: "context_guard.rotate", reason });
    console.error(`[chat-supervisor] CONTEXT ROTATION (${reason}): ${oldId} → ${this.state.sessionId}`);
    this.restart().catch((e) => console.error(`[chat-supervisor] context rotation restart failed: ${e.message}`));
  }

  sendInit() {
    setTimeout(() => {
      // One queued init is enough: a usage-limit hold keeps the queue waiting,
      // and the watchdog restarts a supervisor whose queue waits.
      if (this.dispatcher && !this.dispatcher.queue.some((i) => i.source === "init")) {
        this.dispatcher.dispatch(
          "Session started. Standing by for Edva messages.",
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
      maxSessionTurns: this.maxSessionTurns,
      contextTokens: this.contextTokens,
      restartCount: this.restartCount,
      consecutiveZeroTurns: this.consecutiveZeroTurns,
      consecutiveNoOpTurns: this.consecutiveNoOpTurns,
      childAlive: !!(this.session?.child && this.session.child.exitCode === null && this.session.child.signalCode === null),
      phoneChannelHeartbeatAgeMs: this.lastPhoneChannelHeartbeat ? now - this.lastPhoneChannelHeartbeat : null,
      activeTools: [...this.activeToolMap.values()],
      safetyNetFireCount: this.safetyNetFireCount,
      authErrorCount: this.authErrorCount,
      substrateMode: CHAT_SUBSTRATE,
      chatAgentStatus: this.chatAgent?.status ?? null,
      chatAgentTurns: this.chatAgent?.turns ?? null,
      checkLaterPending: this.chatAgent ? pendingWakes(this.chatAgent.id).length : null,
      forksActive: this.chatAgent ? forkQueue.countActive(this.chatAgent.id) : null,
      queueAlarmActive: this.queueAlarm.active,
      ...this.dispatcher?.snapshot(),
    };
  }

  // A turn the Max usage limit refused. Dispatch holds until the window resets
  // (+1 min). A turn that did no work goes back to the front of the queue
  // once; refused again on that retry, it is dropped, so nothing loops. One
  // that called any tool is not re-run: it may have sent something. Never
  // routed around the limit (Max-only, agent/CLAUDE.md).
  _onQuotaRefusal(ev, t) {
    const now = Date.now();
    const last = this.quotaInfo;
    const info = t.quotaInfo || (Number(last?.resetsAt) * 1000 > now ? last : null) || { status: "rejected", inferred: true };
    const until = rateLimitHoldUntil(info, now);
    this.quotaInfo = info;
    this.quotaOutage = true;
    this._holdForQuota(until);
    const item = this.dispatcher?.inFlight;
    const noWork = !!item && (ev.num_turns || 0) <= 1 && !t.toolUsed;
    // Refused before the named reset, a retry is the hourly re-check finding
    // the window still shut, so the item keeps its place; refused again once
    // that reset has passed, it is dropped.
    const stillShut = Number(info.resetsAt) * 1000 > now;
    const requeued = noWork && (!item.quotaRetried || stillShut);
    if (requeued) {
      if (!item.quotaRetried) {
        item.quotaRetried = true;
        item.quotaSeveral = (item.mergedCount || 0) > 0;   // mergedCount is recomputed when it drains again
        if (item.source === "edva") item.content = `${QUOTA_RETRY_HEADER}\n\n${item.content}`;   // never in front of a /compact
      }
      this.dispatcher.requeueInFlight({ front: true });
    }
    const dropped = noWork && !requeued;
    const what = requeued ? "put back at the front of the queue" : dropped ? "refused again on its one retry, so it is dropped" : "hit the limit mid-turn after doing work, so it is NOT re-run";
    console.error(`[chat-supervisor] QUOTA REFUSED: ${t.source} (${item?.id?.slice(0, 6) || "------"}) ${what}; holding dispatch until ${new Date(until).toISOString()} (${info.rateLimitType || "unknown"} window, queue=${this.dispatcher?.queue.length ?? 0})`);
    this.eventLog.append({ kind: "quota_refused", source: t.source, itemId: item?.id, requeued, dropped, inferred: !!info.inferred, rateLimitType: info.rateLimitType || null, resetsAt: info.resetsAt ?? null, holdUntil: new Date(until).toISOString() });
    this._saveQuotaState();
    return { info, until, requeued, dropped, noWork, merged: (item?.mergedCount || 0) + (item?.quotaSeveral ? 1 : 0) };
  }

  // The outage, as session.json keeps it: the hold, the limit info and which
  // lines the user already has. Written on every change, removed when the limit
  // clears. A failed write costs only the restart guarantee, never the turn.
  _saveQuotaState() {
    try {
      if (this.quotaOutage) {
        this.state.data.quotaOutage = {
          holdUntil: this.quotaHoldUntil, info: this.quotaInfo,
          noticeSent: this.quotaNoticeSent, droppedNoticeSent: this.quotaDroppedNoticeSent,
          savedAt: new Date().toISOString(),
        };
      } else {
        delete this.state.data.quotaOutage;
      }
      this.state.save();
    } catch (err) {
      console.error(`[chat-supervisor] quota state not saved: ${err.message}`);
    }
  }

  // A supervisor process started mid-outage picks the outage up where the last
  // one left it: the hold is re-armed, and the lines already sent are not sent
  // again. An outage whose hold ended more than QUOTA_STATE_TTL_MS ago is
  // stale and dropped; one that ended more recently is kept without a hold, so
  // the first good turn clears it as usual and a refusal before that adds no
  // second line.
  _restoreQuotaState() {
    const saved = this.state.data.quotaOutage;
    if (!saved) return;
    const holdUntil = Number(saved.holdUntil) || 0;
    if (holdUntil < Date.now() - QUOTA_STATE_TTL_MS) {
      delete this.state.data.quotaOutage;
      return;
    }
    this.quotaOutage = true;
    this.quotaInfo = saved.info || null;
    this.quotaNoticeSent = !!saved.noticeSent;
    this.quotaDroppedNoticeSent = !!saved.droppedNoticeSent;
    // Never longer than any hold rateLimitHoldUntil can set, whatever the file says.
    if (holdUntil > Date.now()) this._holdForQuota(Math.min(holdUntil, Date.now() + QUOTA_RESTORE_MAX_HOLD_MS));
    console.error(`[chat-supervisor] quota outage restored from session.json (hold until ${new Date(holdUntil).toISOString()}, notice ${this.quotaNoticeSent ? "already sent" : "not sent"}, set-aside notice ${this.quotaDroppedNoticeSent ? "already sent" : "not sent"})`);
    this.eventLog.append({ kind: "quota_restored", holdUntil: new Date(holdUntil).toISOString(), noticeSent: this.quotaNoticeSent, droppedNoticeSent: this.quotaDroppedNoticeSent });
  }

  // quotaHoldUntil is the reset the limit named (the notice and the restart
  // record carry it); the hold itself re-checks at least every
  // RATE_LIMIT_REPROBE_MS, since a window can come back before that reset.
  _holdForQuota(until) {
    if (until > this.quotaHoldUntil) this.quotaHoldUntil = until;   // extends, never shortens
    const holdTo = Math.min(this.quotaHoldUntil, Date.now() + RATE_LIMIT_REPROBE_MS);
    if (!(holdTo > Date.now()) || !(holdTo > this._quotaHoldTo)) return;
    this._quotaHoldTo = holdTo;
    this.dispatcher?.hold(holdTo);
    clearTimeout(this._quotaHoldTimer);
    const release = () => {
      // Mid-restart the replacement dispatcher may already carry the expired
      // hold and nothing would wake its queue, so try again shortly.
      if (this.restarting || this.interrupting) { this._quotaHoldTimer = setTimeout(release, 1000); return; }
      console.error(`[chat-supervisor] quota hold released — resuming dispatch (queue=${this.dispatcher?.queue.length ?? 0})`);
      this.dispatcher?.releaseHold();
    };
    this._quotaHoldTimer = setTimeout(release, Math.max(0, holdTo - Date.now()));
  }

  // The one line per outage, in their own time zone. Posted the way the auth
  // notice is, straight to the chat, since the agent cannot run to send it.
  _maybeQuotaNotice({ requeued = true } = {}) {
    if (this.quotaNoticeSent) return;
    this.quotaNoticeSent = true;
    this._saveQuotaState();
    this._quotaNotice(chatQuotaNotice({ info: this.quotaInfo, until: this.quotaHoldUntil, tz: userTz(), requeued }));
  }

  // At most one "set aside" line per outage. A later message refused on its
  // retry in the same outage is still set aside, and logged, but not announced.
  _maybeQuotaDroppedNotice({ info, several }) {
    if (this.quotaDroppedNoticeSent) {
      console.error(`[chat-supervisor] set-aside notice already sent this outage — not sending another`);
      this.eventLog.append({ kind: "quota_notice_suppressed", which: "dropped" });
      return;
    }
    this.quotaDroppedNoticeSent = true;
    this._saveQuotaState();
    this._quotaNotice(chatQuotaDroppedNotice({ info, tz: userTz(), several }));
  }

  _quotaNotice(text) {
    console.error(`[chat-supervisor] quota notice to the user: ${text}`);
    this.eventLog.append({ kind: "quota_notice", text });
    this._postOrphanedReply(text).catch((e) => console.error(`[chat-supervisor] quota notice post failed: ${e.message}`));
  }

  _getSupabaseKey() {
    // Inside a test run (node --test) the safety net never holds the live key,
    // whatever the environment or the installation's .env carries, so a
    // test-started supervisor cannot post its fake replies into the real chat.
    // See "Test runs" in lib/load-env.js.
    if (underTestRunner()) return null;
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const env = fs.readFileSync(path.join(EDVA_ROOT, ".env"), "utf8");
      const m = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch {}
    return null;
  }

  async _postOrphanedReply(message) {
    const key = this._getSupabaseKey();
    if (!key) {
      console.error(`[chat-supervisor] safety net: SUPABASE_SERVICE_ROLE_KEY not available${underTestRunner() ? " (withheld in a test run)" : ""} — orphaned text lost: ${message.slice(0, 80)}`);
      return;
    }
    // SUPABASE_URL env, else this installation's project (lib/instance.cjs).
    const project = instanceValue("supabase_project");
    const SUPABASE_URL = process.env.SUPABASE_URL || (project ? `https://${project}.supabase.co` : "");
    if (!SUPABASE_URL) throw new Error("no Supabase project configured (instance supabase_project / SUPABASE_URL)");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/edva_messages`, {
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
    this.turnWatchdog.clear();   // tearing down — the new session re-arms per turn
    // Loop mode: same abort-before-teardown as interruptForHighPriority() — see there.
    this.chatAgent?.cancel("restart");
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
    this._stopLocalRulesWatch?.();
    try { this.server?.close(); } catch {}
    try { await this.session?.stop(); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(EDVA_ROOT, "agent/config/agents.json");
  const agentCfg = loadAgentConfig(configPath, args.agent);
  const dataDir = args.stateDir || path.join(EDVA_ROOT, `agent/supervisor/state/${args.agent}`);
  const eventDir = path.join(EDVA_ROOT, `agent/logs/supervisor-${args.agent}`);

  const supervisor = new ChatSupervisor({ args, agentCfg, dataDir, eventDir });
  let shouldResume = args.resume && supervisor.state.canResume;
  // Cold-start guard (mirrors ops): don't resume a session that already blew
  // past the turn cap. Chat doesn't rotate mid-conversation, but a process
  // restart is already a conversation break, so starting fresh here is safe and
  // prevents resurrecting a huge, expensive session.
  if (shouldResume && supervisor.maxSessionTurns > 0 && supervisor.state.data.totalTurns >= supervisor.maxSessionTurns) {
    console.error(`[chat-supervisor] persisted session has ${supervisor.state.data.totalTurns} turns (>= cap ${supervisor.maxSessionTurns}) — starting fresh instead of resuming`);
    supervisor.state.data.everInitialized = false;
    supervisor.state.rotateSession();
    shouldResume = false;
  }
  // Context cold-start guard (mirrors the turn-count one): never resume a session
  // whose persisted context already sits near the 200k→1M wall.
  if (shouldResume && (supervisor.state.data.contextTokens || 0) >= CHAT_ROTATE_THRESHOLD_TOKENS) {
    console.error(`[chat-supervisor] persisted session context ${supervisor.state.data.contextTokens} ≥ rotate threshold — starting fresh instead of resuming`);
    supervisor.state.data.everInitialized = false;
    supervisor.state.rotateSession();
    shouldResume = false;
  }

  console.error(`[chat-supervisor] starting agent=${args.agent} model=${args.model || agentCfg.model} session=${supervisor.state.sessionId} resume=${shouldResume}`);
  await supervisor.startSession({ resume: shouldResume });
  supervisor.startHttp();
  supervisor.sendInit();
  supervisor.watchClaudeMd();
  supervisor.startLocalWatchers();

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
