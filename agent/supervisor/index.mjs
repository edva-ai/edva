#!/usr/bin/env node
// index.mjs — Merlin ops-agent supervisor.
//
// Responsibilities:
//   1. Spawn `claude -p --input-format stream-json --output-format stream-json ...`
//   2. Parse NDJSON event stream, append to events.ndjson + cost.ndjson
//   3. Serve HTTP:
//        :9090  POST / — Gmail Pub/Sub push (from Hookdeck)
//        :9092  POST / — webhook task dispatch
//        :9093  GET /health, GET /cost, POST /restart, POST /dispatch
//   4. Serialize dispatch: one turn at a time, queue the rest
//   5. Persist session_id for warm --resume across restarts
//   6. Watchdog readable via GET :9093/health
//
// Flags:
//   --agent ops            name from agents.json (default: ops)
//   --config <path>        path to agents.json
//   --model <name>         override agent.model
//   --no-resume            don't try to resume previous session
//   --claude-bin <path>    override claude binary path
//
// Env:
//   CLAUDE_BIN             fallback claude binary path

import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProc } from "node:child_process";
import { ClaudeSession } from "./claude-session.mjs";

const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");

// Prefix every supervisor stderr line with an ISO timestamp. The supervisor
// log used to have no per-line time, forcing cross-reference with
// events.ndjson during incidents. Wrapping console.error catches every
// `[supervisor] …`, `[http] …`, `[claude-session] …` line from this module
// and its imports. Raw child-process stdout/stderr (claude -p warnings)
// still lands unprefixed — acceptable.
const _origConsoleError = console.error.bind(console);
console.error = (...args) => _origConsoleError(new Date().toISOString(), ...args);
import { Dispatcher } from "./dispatcher.mjs";
import { QueuePersist } from "./queue-persist.mjs";
import { EventLog } from "./event-log.mjs";
import { State } from "./state.mjs";
import { GmailSource } from "./gmail-source.mjs";
import { startServers } from "./http-server.mjs";
import { Instrumentation } from "./instrumentation.mjs";
import { attachClaudeMdWatcher } from "./graceful-restart.mjs";

const HOME = process.env.HOME;
const MERLIN_ROOT = MERLIN_HOME;

// No-op counter — observability metric exposed via /health. Prompt-cached
// Max turns can legitimately complete in well under 1500ms, so this counter
// does not trigger any automated action; crash-loop recovery still runs off
// `consecutiveZeroTurns` (num_turns === 0).
const NO_OP_DURATION_MS = 1500;

// Per-turn watchdog: if a dispatching event is not followed by a result event
// within this window, the child is considered hung (deadlocked tool call,
// network retry without timeout, resumed-session state corruption). Killing
// the child triggers session.on("exit") → requeueInFlight → restart().
// Added 2026-04-18 after a 5h hang where cron kept enqueuing hum ticks behind
// one stuck in-flight task with no automated recovery.
const TURN_WATCHDOG_MS_DEFAULT = 10 * 60 * 1000;

// Per-source overrides: I/O-heavy jobs legitimately exceed the default.
// daily-summary harvests calendar + email + photos + git + tasks + notes and
// routinely runs 7-8 min; the 10-min default fired false positives on
// 2026-04-19 (s-20260419-05). Widen to 20 min so normal-but-slow days don't
// kill the child mid-turn. Key matches Dispatcher item.source.
//
// portfolio-rebalance runs ultrathink + xhigh effort and does deep web
// research (newsletters, market data) before writing the memo and emailing.
// The 10-min default tripped on 2026-04-30 and 2026-05-07, in both cases
// killing the child mid-research and (per the 2026-05-08 fix below) losing
// the dispatch entirely. Widen to 30 min — substantially more headroom than
// the only successful attempt's actual duration.
const TURN_WATCHDOG_MS_BY_SOURCE = {
  "daily-summary": 20 * 60 * 1000,
  "portfolio-rebalance": 30 * 60 * 1000,
};

function watchdogMsFor(source) {
  return TURN_WATCHDOG_MS_BY_SOURCE[source] || TURN_WATCHDOG_MS_DEFAULT;
}

// Queue-depth alarm thresholds. Push once when queue crosses HIGH, re-arm
// when it drops below CLEAR so a new incident can fire again.
const QUEUE_ALARM_HIGH = 20;
const QUEUE_ALARM_CLEAR = 10;

// Hard rotation age: past this, rotate regardless of dispatcher state.
// The soft rotation at 20h defers when dispatcher is busy, which is exactly
// the state a wedged session can't get out of.
const HARD_ROTATE_AGE_MS = 30 * 60 * 60 * 1000;

// Matches the error string claude -p writes to the `result` field when the
// Max credentials are invalid. Two variants observed: the SDK prefix plus
// the raw JSON `authentication_error` type.
const AUTH_ERROR_RE = /Failed to authenticate|authentication_error/;
const AUTH_FAIL_THRESHOLD = 3;

function parseArgs(argv) {
  const args = { agent: "ops", resume: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") args.agent = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--no-resume") args.resume = false;
    else if (a === "--state-dir") args.stateDir = argv[++i];
    else if (a === "--claude-bin") args.claudeBin = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: supervisor [--agent ops] [--config path] [--model name] [--no-resume] [--claude-bin path]");
      process.exit(0);
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

async function importTriageLog() {
  const mod = await import(path.join(MERLIN_ROOT, "lib/triage-log.js"));
  return mod.triageLog;
}

class Supervisor {
  constructor({ args, agentCfg, dataDir, eventDir, triageLog }) {
    this.args = args;
    this.cfg = agentCfg;
    this.dataDir = dataDir;
    this.eventLog = new EventLog(eventDir);
    this.instrumentation = new Instrumentation(eventDir);
    this.state = new State(path.join(dataDir, "session.json"));
    // Durable queue persistence — survives whole-process restarts (launchd
    // respawn, OOM, panic). The in-process restart() flow already transfers
    // queue+inFlight between dispatchers in-memory; this is the cold-start
    // backstop. See queue-persist.mjs for the 2026-05-18 mkt-aso-baseline
    // loss that motivated this.
    this.queuePersist = new QueuePersist(path.join(MERLIN_ROOT, "data/dispatcher-queue.json"));
    this.queueRestored = false;
    this.gmailSource = new GmailSource({
      lastHistoryFile: path.join(MERLIN_ROOT, "data/last-history-id.json"),
      pauseFlagFile: path.join(MERLIN_ROOT, "data/.triage-paused"),
      triageLog,
    });
    this.session = null;
    this.dispatcher = null;
    this.http = null;
    this.startedAt = Date.now();
    this.restartCount = 0;
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.restarting = false;
    this.lastRateLimit = null;
    this.rotationTimer = null;
    this.turnWatchdogTimer = null;
    this.authErrorCount = 0;
    this.authAlertSent = false;
    this.authWatcher = null;
    this.queueAlarmArmed = true;
    attachClaudeMdWatcher(this, {
      claudeMdPath: path.join(MERLIN_ROOT, this.cfg.cwd, "CLAUDE.md"),
      logPrefix: "[supervisor]",
    });
  }

  async startSession({ resume }) {
    this.sessionStartedAt = Date.now();
    const cfg = this.cfg;
    const mcpConfigPath = path.join(MERLIN_ROOT, "agent/supervisor/mcp-config.json");
    const sessionOpts = {
      sessionId: this.state.sessionId,
      model: this.args.model || cfg.model,
      fallbackModel: cfg.fallbackModel,
      effort: cfg.effort,
      permissionMode: cfg.permissionMode,
      maxBudgetUsd: cfg.maxBudgetUsd,
      remoteControlPrefix: cfg.remoteControlPrefix,
      mcpConfig: fs.existsSync(mcpConfigPath) ? mcpConfigPath : undefined,
      allowedTools: (cfg.allowedTools || []).join(" "),
      cwd: path.join(MERLIN_ROOT, cfg.cwd),
      addDirs: [MERLIN_ROOT],
      claudeBin: this.args.claudeBin,
      // Ops runs on the Max subscription (intended auth). Hide
      // ANTHROPIC_API_KEY from the child so claude -p uses the Max
      // credentials in ~/.claude/.credentials.json; otherwise the API key
      // takes precedence and ops hits the same usage cap as the chat agent.
      unsetEnv: ["ANTHROPIC_API_KEY"],
      resume,
    };

    this.session = new ClaudeSession(sessionOpts);

    this.session.on("event", (ev) => {
      this.state.touch();
      this.eventLog.append({ kind: ev.type, ...ev });
      this.instrumentation.observe(ev);
    });

    this.session.on("result", (ev) => {
      const costUsd = ev.total_cost_usd || 0;
      const turns = ev.num_turns || 0;
      const durationMs = ev.duration_ms || 0;
      if (turns === 0) this.consecutiveZeroTurns++;
      else this.consecutiveZeroTurns = 0;
      // No-op detection: a completed turn that finished too fast to be real work
      // — seen when the child stays alive but emits instant result events without
      // actually calling the LLM (Apr 2026 outage: 1 turn / $0 / <300ms).
      if (turns >= 1 && durationMs < NO_OP_DURATION_MS) this.consecutiveNoOpTurns++;
      else this.consecutiveNoOpTurns = 0;
      // Auth-error detection: on invalid Max creds, claude -p emits a
      // "successful" result with the 401 body in ev.result. Count consecutive
      // failures so a single flake doesn't pause the dispatcher.
      if (typeof ev.result === "string" && AUTH_ERROR_RE.test(ev.result)) {
        this.authErrorCount++;
        console.error(`[supervisor] AUTH ERROR #${this.authErrorCount}: ${ev.result.slice(0, 160)}`);
        if (this.authErrorCount >= AUTH_FAIL_THRESHOLD && !this.authAlertSent) this._triggerAuthOutage();
      } else if (typeof ev.result === "string") {
        this.authErrorCount = 0;
      }
      this.state.recordResult({ costUsd, turns });
      this.eventLog.appendCost({
        session_id: ev.session_id,
        duration_ms: ev.duration_ms,
        num_turns: ev.num_turns,
        total_cost_usd: ev.total_cost_usd,
        model_usage: ev.modelUsage,
        permission_denials: (ev.permission_denials || []).length,
        terminal_reason: ev.terminal_reason,
      });
      // Don't log "turn complete" here — the dispatcher.turn_complete handler
      // logs with the dispatch short-id so completion ties back to its dispatch
      // line. Re-logging here would double every real dispatch.
    });

    this.session.on("rate_limit", (ev) => {
      this.lastRateLimit = ev.rate_limit_info;
      if (ev.rate_limit_info?.status !== "allowed") {
        console.error(`[supervisor] RATE LIMIT: ${JSON.stringify(ev.rate_limit_info)}`);
      }
    });

    this.session.on("exit", ({ code, signal }) => {
      console.error(`[supervisor] claude exited code=${code} signal=${signal}`);
      this._clearTurnWatchdog();
      // Re-queue in-flight dispatch so it's not lost across restarts.
      const requeued = this.dispatcher?.requeueInFlight();
      if (requeued) console.error(`[supervisor] re-queued in-flight dispatch: ${requeued.source}`);
      // Pause the dispatcher across the restart window. Otherwise an inbound
      // dispatch (webhook, gmail-source, cron) calls _drain → shifts the
      // re-queued head item back into inFlight → session.send() writes to the
      // killed child's stdin → silent drop. The restart-recovery path below
      // only transfers `dispatcher.queue` to the new dispatcher, so anything
      // re-marked inFlight during the restart backoff is lost. This bit
      // 2026-04-30 and 2026-05-07 portfolio-rebalance after watchdog kills.
      // (The pause lives on the OLD dispatcher, which is replaced wholesale
      // by `new Dispatcher(...)` in restart() — the new dispatcher starts
      // unpaused and inherits the queued items.)
      const wasAuthPaused = this.dispatcher?.paused;
      if (this.dispatcher && !wasAuthPaused) this.dispatcher.setPaused(true);
      if (wasAuthPaused) {
        console.error(`[supervisor] dispatcher paused (auth outage) — skipping auto-restart until creds refresh`);
        return;
      }
      if (!this.restarting) this.restart().catch((e) => console.error(`[supervisor] auto-restart failed: ${e.message}`));
    });

    this.session.on("ready", (ev) => {
      if (this.session.resumeFailed) {
        console.error(`[supervisor] --resume failed, rotated to new session_id=${this.session.sessionId}`);
        this.state.rotateSession();
        this.state.data.sessionId = this.session.sessionId;
        this.state.save();
      } else if (resume) {
        this.state.markResumed();
        console.error(`[supervisor] resumed session ${this.state.sessionId}`);
      } else {
        console.error(`[supervisor] started new session ${this.state.sessionId}`);
      }
      this.state.markInitialized();
    });

    await this.session.start();
    console.error(`[supervisor] child spawned — init will fire after first dispatch`);

    // Transfer pending queue from old dispatcher (if any) to survive restarts.
    // IMPORTANT: defer the drain until AFTER the dispatcher listeners below
    // are attached. A prior version drained here and lost the `dispatching`
    // and `turn_complete` emissions for the first transferred item — no log
    // line, no TURN WATCHDOG armed, no cost attribution — which on 2026-04-24
    // silently swallowed a transferred daily-summary after broadway-lottery
    // tripped the watchdog.
    //
    // Defense-in-depth: also rescue any leftover `inFlight` from the old
    // dispatcher and put it at the head of the new queue. With the
    // setPaused(true) added to the exit handler above, inFlight should
    // already be null here (requeueInFlight ran on exit, and the pause
    // prevents any subsequent _drain from re-marking it). But if anything
    // ever bypasses the pause, a non-null inFlight at this point would
    // otherwise be silently dropped — that was the 2026-05-07 portfolio-
    // rebalance failure mode. Belt + suspenders.
    const pendingItems = [];
    if (this.dispatcher?.inFlight) {
      console.error(`[supervisor] rescuing in-flight ${this.dispatcher.inFlight.source} from old dispatcher`);
      pendingItems.push(this.dispatcher.inFlight);
      this.dispatcher.inFlight = null;
    }
    if (this.dispatcher) for (const item of this.dispatcher.queue) pendingItems.push(item);
    this.dispatcher = new Dispatcher(this.session, {
      persist: () => this.queuePersist.save(this.dispatcher),
    });
    // First construction only: replay any items persisted by a prior process.
    // After that, in-memory state is authoritative and `pendingItems` (above)
    // already carries the queue across in-process session restarts.
    if (!this.queueRestored) {
      this.queueRestored = true;
      const persisted = this.queuePersist.load();
      if (persisted) {
        const recovered = (persisted.inFlight ? 1 : 0) + (persisted.queue?.length || 0);
        if (recovered > 0) {
          console.error(`[supervisor] restoring ${recovered} item(s) from persisted queue (cold start)`);
          this.dispatcher.restore(persisted);
        }
      }
    }
    for (const item of pendingItems) this.dispatcher.queue.push(item);
    // Persist the merged state so a crash before the first turn doesn't
    // lose pendingItems (transferred from old in-process dispatcher).
    this.queuePersist.save(this.dispatcher);
    // Wire gmail batch dispatch to the new dispatcher.
    this.gmailSource._dispatchFn = (content, source) => this.dispatcher.dispatch(content, source);

    this.dispatcher.on("enqueued", (item) => {
      this.eventLog.append({ kind: "dispatcher.enqueued", item });
      const depth = this.dispatcher.queue.length;
      if (depth > QUEUE_ALARM_HIGH && this.queueAlarmArmed) {
        this.queueAlarmArmed = false;
        console.error(`[supervisor] QUEUE ALARM: depth=${depth} — dispatch backing up`);
        this._sendPush(`⚠️ Merlin ops queue depth=${depth}. Supervisor may be stuck — check \`merlin status\`.`);
      } else if (depth < QUEUE_ALARM_CLEAR) {
        this.queueAlarmArmed = true;
      }
    });
    this.dispatcher.on("dispatching", (item) => {
      const shortId = item.id.slice(0, 6);
      console.error(`[supervisor] disp ${shortId} → ${item.source}: ${(item.content ?? item.task ?? '').slice(0, 80)}...`);
      this.eventLog.append({ kind: "dispatcher.dispatching", item });
      this.instrumentation.markDispatch(item.id, item.source);
      this._armTurnWatchdog(item);
    });
    this.dispatcher.on("turn_complete", (info) => {
      this._clearTurnWatchdog();
      const shortId = info.message?.id ? info.message.id.slice(0, 6) : "------";
      const source = info.message?.source || "-";
      const ms = info.result.duration_ms ?? "?";
      const cost = (info.result.total_cost_usd || 0).toFixed(4);
      const turns = info.result.num_turns ?? "?";
      console.error(`[supervisor] disp ${shortId} done ${source} ${ms}ms $${cost} turns=${turns}`);
      this.eventLog.append({ kind: "dispatcher.turn_complete", id: info.message?.id, durationMs: info.result.duration_ms, costUsd: info.result.total_cost_usd });

      // Per-job cost attribution — drives merlin-cost-report + nightly-review
      // cost lens. Sum token counters across modelUsage so rollups can group
      // by job without re-iterating model dicts.
      // NB: the stream-json result event uses camelCase `modelUsage` — it's
      // only renamed to `model_usage` when written to cost.ndjson. A prior
      // version of this code used the snake_case field and wrote zero-token
      // rows for every dispatch (2026-04-23).
      try {
        const modelUsage = info.result.modelUsage || {};
        let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, webSearch = 0;
        const models = [];
        for (const [model, u] of Object.entries(modelUsage)) {
          models.push(model);
          input += u.inputTokens || 0;
          output += u.outputTokens || 0;
          cacheRead += u.cacheReadInputTokens || 0;
          cacheCreate += u.cacheCreationInputTokens || 0;
          webSearch += u.webSearchRequests || 0;
        }
        this.eventLog.appendJobCost({
          dispatch_id: info.message?.id || null,
          short_id: shortId,
          source,
          duration_ms: info.result.duration_ms ?? null,
          num_turns: info.result.num_turns ?? null,
          total_cost_usd: info.result.total_cost_usd ?? 0,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_creation_tokens: cacheCreate,
          web_search_requests: webSearch,
          models,
          terminal_reason: info.result.terminal_reason || null,
        });
      } catch (err) {
        console.error(`[supervisor] job-cost attribution failed: ${err.message}`);
      }

      this._tryGracefulRestart();
    });
    this.dispatcher.on("dispatch_error", ({ item, error }) => {
      console.error(`[supervisor] disp ${item.id.slice(0, 6)} error ${item.source}: ${error}`);
      this.eventLog.append({ kind: "dispatcher.error", id: item.id, source: item.source, error });
    });

    // Now that listeners are attached, flush transferred items — this is the
    // restart recovery path. Without this, queued items sit idle until the
    // next external webhook arrives.
    if (pendingItems.length) {
      console.error(`[supervisor] transferred ${pendingItems.length} queued item(s) to new dispatcher`);
      this.dispatcher._drain();
    }
  }

  _armTurnWatchdog(item) {
    this._clearTurnWatchdog();
    const ms = watchdogMsFor(item.source);
    this.turnWatchdogTimer = setTimeout(() => {
      console.error(`[supervisor] TURN WATCHDOG: no result in ${ms / 60000}min for item ${item.id} (source=${item.source}) — killing child`);
      try { this.session?.child?.kill("SIGKILL"); } catch {}
    }, ms);
  }

  _clearTurnWatchdog() {
    if (this.turnWatchdogTimer) {
      clearTimeout(this.turnWatchdogTimer);
      this.turnWatchdogTimer = null;
    }
  }

  _sendPush(text) {
    try {
      const bin = path.join(HOME, "dev/merlin/bin/merlin-send-curl");
      // --skip-precheck: supervisor alerts (auth outages, queue alarms) must
      // bypass the Sonnet-gated outbound precheck. The precheck depends on
      // the agents being up to dispatch; gating supervisor self-alerts
      // through it is the wrong direction — a stuck supervisor would silence
      // its own alert. See system/architecture.md § Outbound Precheck.
      const p = spawnProc(bin, ["--suppress-hook", "--skip-precheck", "--intent", "supervisor-alert", "--channel", "system", text], { stdio: "ignore", detached: true });
      p.unref();
    } catch (err) {
      console.error(`[supervisor] _sendPush failed: ${err.message}`);
    }
  }

  _triggerAuthOutage() {
    this.authAlertSent = true;
    if (this.dispatcher) this.dispatcher.setPaused(true);
    console.error(`[supervisor] AUTH OUTAGE: pausing dispatcher, alerting, and starting creds watcher`);
    this._sendPush("⚠️ Merlin down: Max auth invalid on mini. SSH in and run `claude login` to restore.");
    this._startAuthWatcher();
    // Kill the current child so it stops burning through the queue on 401s.
    try { this.session?.child?.kill("SIGKILL"); } catch {}
  }

  _startAuthWatcher() {
    if (this.authWatcher) return;
    const credsPath = path.join(HOME, ".claude/.credentials.json");
    let baselineMtime = 0;
    try { baselineMtime = fs.statSync(credsPath).mtimeMs; } catch {}
    this.authWatcher = setInterval(() => {
      let mtime = 0;
      try { mtime = fs.statSync(credsPath).mtimeMs; } catch { return; }
      if (mtime > baselineMtime) {
        console.error(`[supervisor] credentials refreshed — rotating session and resuming dispatcher`);
        clearInterval(this.authWatcher);
        this.authWatcher = null;
        this.authErrorCount = 0;
        this.authAlertSent = false;
        if (this.dispatcher) this.dispatcher.setPaused(false);
        // Force a clean session so the new creds are used from a fresh state.
        this.state.data.everInitialized = false;
        this.state.rotateSession();
        this.restart().catch((e) => console.error(`[supervisor] post-auth restart failed: ${e.message}`));
      }
    }, 15_000);
    this.authWatcher.unref?.();
  }

  async startHttp() {
    const ports = this.cfg.supervisor;
    this.http = startServers({
      ports,
      gmailSource: this.gmailSource,
      supervisor: this,
    });
  }

  // Runs startup-catchup once session is live.
  fireStartupCatchup() {
    const content = this.gmailSource.catchupMessage();
    if (!content) {
      console.error(`[supervisor] no last-history — skipping startup catchup`);
      return;
    }
    // Delay a few seconds so MCP servers finish wiring up.
    setTimeout(() => {
      console.error(`[supervisor] dispatching startup catchup`);
      this.dispatcher.dispatch(content, "startup-catchup");
    }, 5000);

    // Start periodic catchup timer to detect push delivery failures.
    this.gmailSource.startCatchupTimer();
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
      queueDepth: this.dispatcher?.snapshot().queueDepth ?? 0,
      inFlight: this.dispatcher?.snapshot().inFlight ?? null,
      completed: this.dispatcher?.snapshot().completed ?? 0,
      childAlive: !!(this.session?.child && this.session.child.exitCode === null && this.session.child.signalCode === null),
      dispatcherPaused: !!this.dispatcher?.paused,
      authErrorCount: this.authErrorCount,
      authAlertSent: this.authAlertSent,
      rateLimit: this.lastRateLimit,
      lastPushAt: this.gmailSource.lastPushAt ? new Date(this.gmailSource.lastPushAt).toISOString() : null,
      lastPushAgeMs: this.gmailSource.lastPushAt ? now - this.gmailSource.lastPushAt : null,
    };
  }

  costSummary() {
    const lines = fs.existsSync(this.eventLog.costPath) ? fs.readFileSync(this.eventLog.costPath, "utf8").trim().split("\n") : [];
    const now = Date.now();
    let today = 0, week = 0, total = 0;
    const perModel = {};
    for (const line of lines) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const ts = new Date(e.ts).getTime();
      const age = now - ts;
      const cost = e.total_cost_usd || 0;
      total += cost;
      if (age < 86_400_000) today += cost;
      if (age < 7 * 86_400_000) week += cost;
      for (const [m, u] of Object.entries(e.model_usage || {})) {
        perModel[m] = (perModel[m] || 0) + (u.costUSD || 0);
      }
    }
    return { todayUsd: today, weekUsd: week, totalUsd: total, perModel, entries: lines.length };
  }

  async restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.restartCount++;

    // Exponential backoff: 2s, 4s, 8s, ..., max 60s
    const delay = Math.min(2000 * Math.pow(2, Math.min(this.restartCount - 1, 5)), 60000);
    console.error(`[supervisor] restart #${this.restartCount} (backoff ${delay}ms)`);
    await new Promise(r => setTimeout(r, delay));

    try {
      await this.session.stop();
    } catch {}

    // Crash-loop breaker: if we've had 5+ consecutive zero-turn exits,
    // the session is likely corrupted. Abandon it and start fresh.
    const CRASH_LOOP_THRESHOLD = 5;
    if (this.consecutiveZeroTurns >= CRASH_LOOP_THRESHOLD) {
      console.error(`[supervisor] CRASH LOOP DETECTED: ${this.consecutiveZeroTurns} consecutive zero-turn exits — rotating to fresh session`);
      this.state.data.everInitialized = false;
      this.state.rotateSession();
      this.consecutiveZeroTurns = 0;
    }

    // Only --resume if the session was ever initialized successfully.
    const shouldResume = this.state.canResume;
    if (!shouldResume) {
      console.error(`[supervisor] session never initialized — starting fresh (no --resume)`);
      this.state.rotateSession();
    }
    await this.startSession({ resume: shouldResume });
    this.restarting = false;
  }

  // --- Daily session rotation ---
  // Checks hourly whether the session is old enough to rotate (default 20h).
  // Only rotates when the dispatcher is idle (no in-flight, empty queue).
  startRotationTimer() {
    if (this.rotationTimer) return;
    const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const MAX_SESSION_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours
    this.rotationTimer = setInterval(() => {
      const age = Date.now() - new Date(this.state.data.createdAt).getTime();
      if (age < MAX_SESSION_AGE_MS) return;
      // Hard rotation: past HARD_ROTATE_AGE_MS, rotate regardless of
      // dispatcher state. The soft-defer below could otherwise loop forever
      // when a wedged session is what's keeping the dispatcher "busy".
      if (age >= HARD_ROTATE_AGE_MS) {
        const hrs = (age / 3600000).toFixed(1);
        console.error(`[supervisor] HARD ROTATION: session age ${hrs}h (>${HARD_ROTATE_AGE_MS / 3600000}h) — rotating regardless of dispatcher state (queue=${this.dispatcher?.queue.length ?? 0})`);
        this.state.data.everInitialized = false;
        this.state.rotateSession();
        this.consecutiveZeroTurns = 0;
        this.consecutiveNoOpTurns = 0;
        // SIGKILL the child; exit handler will requeue inFlight + restart().
        try { this.session?.child?.kill("SIGKILL"); } catch {}
        return;
      }
      if (this.dispatcher?.inFlight || (this.dispatcher?.queue.length ?? 0) > 0) {
        console.error(`[supervisor] rotation deferred — dispatcher busy (queue=${this.dispatcher.queue.length})`);
        return;
      }
      if (this.restarting) return;
      const oldId = this.state.sessionId;
      const oldTurns = this.state.data.totalTurns;
      const oldCost = this.state.data.totalCostUsd;
      this.state.data.everInitialized = false;
      this.state.rotateSession();
      this.consecutiveZeroTurns = 0;
      this.consecutiveNoOpTurns = 0;
      console.error(`[supervisor] DAILY ROTATION: ${oldId} → ${this.state.sessionId} (was ${oldTurns} turns, $${oldCost.toFixed(2)})`);
      this.restart().catch((e) => console.error(`[supervisor] rotation restart failed: ${e.message}`));
    }, CHECK_INTERVAL_MS);
    console.error(`[supervisor] rotation timer started (check every ${CHECK_INTERVAL_MS / 60000}min, max age ${MAX_SESSION_AGE_MS / 3600000}h)`);
  }

  stopRotationTimer() {
    if (this.rotationTimer) { clearInterval(this.rotationTimer); this.rotationTimer = null; }
  }

  // Manual rotation via POST /rotate
  rotateIfIdle() {
    if (this.dispatcher?.inFlight || (this.dispatcher?.queue.length ?? 0) > 0) {
      return { rotated: false, reason: "dispatcher busy" };
    }
    if (this.restarting) {
      return { rotated: false, reason: "restart in progress" };
    }
    const oldId = this.state.sessionId;
    const oldTurns = this.state.data.totalTurns;
    const oldCost = this.state.data.totalCostUsd;
    this.state.data.everInitialized = false;
    this.state.rotateSession();
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    console.error(`[supervisor] MANUAL ROTATION: ${oldId} → ${this.state.sessionId} (was ${oldTurns} turns, $${oldCost.toFixed(2)})`);
    this.restart().catch((e) => console.error(`[supervisor] rotation restart failed: ${e.message}`));
    return { rotated: true, oldSessionId: oldId, newSessionId: this.state.sessionId };
  }

  async shutdown() {
    console.error("[supervisor] shutting down");
    this.stopRotationTimer();
    this.stopClaudeMdWatcher();
    this.gmailSource.stopCatchupTimer();
    this._clearTurnWatchdog();
    if (this.authWatcher) { clearInterval(this.authWatcher); this.authWatcher = null; }
    try { await this.http?.close(); } catch {}
    try { await this.session?.stop(); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(MERLIN_ROOT, "agent/config/agents.json");
  const agentCfg = loadAgentConfig(configPath, args.agent);
  const dataDir = args.stateDir || path.join(MERLIN_ROOT, `agent/supervisor/state/${args.agent}`);
  const eventDir = path.join(MERLIN_ROOT, `agent/logs/supervisor-${args.agent}`);
  const triageLog = await importTriageLog();

  const supervisor = new Supervisor({ args, agentCfg, dataDir, eventDir, triageLog });

  const shouldResume = args.resume && supervisor.state.canResume;
  console.error(`[supervisor] starting agent=${args.agent} model=${args.model || agentCfg.model} session=${supervisor.state.sessionId} resume=${shouldResume}`);
  await supervisor.startSession({ resume: shouldResume });
  await supervisor.startHttp();
  supervisor.fireStartupCatchup();
  supervisor.startRotationTimer();
  supervisor.watchClaudeMd();

  const shutdown = async (sig) => {
    console.error(`[supervisor] signal ${sig}`);
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[supervisor] fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
