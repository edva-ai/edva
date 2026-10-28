#!/usr/bin/env node
// index.mjs — Edva ops-agent supervisor.
//
// Responsibilities:
//   1. Spawn `claude -p --input-format stream-json --output-format stream-json ...`
//   2. Parse NDJSON event stream, append to events.ndjson + cost.ndjson
//   3. Serve HTTP:
//        :9090  POST / — Gmail Pub/Sub push (OIDC-verified; via Cloudflare Tunnel)
//               POST /email-inbound — CF Email Worker (X-Inbound-Secret)
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
import { createRequire } from "node:module";
import { ClaudeSession, supportsCliFlag, buildLocalRulesFile, watchLocalRules } from "./claude-session.mjs";
import { writeFileAtomic } from "../../lib/atomic-write.js";
import { gitGuardHooks } from "../../lib/rollback-guard-settings.mjs";
import { makeTriageRouter, triageTargetFromConfig } from "./triage-route.mjs";
import { authFailureText } from "./auth-result.mjs";

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
import { buildHandoffDigest, formatHandoffBlock } from "./handoff-digest.mjs";
import { buildPreamble, shouldPreamble, composeTriageRules } from "./dispatch-preamble.mjs";
import { TurnWatchdog, TURN_WATCHDOG_MS_DEFAULT, hangReasonClause } from "./turn-watchdog.mjs";
import { QueueAlarm } from "./queue-alarm.mjs";
import { ownRequestFor, sentSince, jobsSince, planForDrop, buildRetryItem, stuckNotice, appendDeadLetter } from "./dead-letter.mjs";
import {
  contextGuardDecision,
  idleColdRotate,
  CONTEXT_COMPACT_THRESHOLD_TOKENS,
  CONTEXT_ROTATE_THRESHOLD_TOKENS,
  MIN_COMPACTABLE_TOKENS,
} from "./context-guard.mjs";
import { installRoot, installTools } from "../../lib/root.cjs";

const HOME = process.env.HOME;
const EDVA_ROOT = installRoot();
// The operator's own rules and playbook additions (agent/local/; see
// claude-session.mjs § Local agent rules). Overridable for tests.
const LOCAL_DIR = process.env.EDVA_LOCAL_DIR || path.join(EDVA_ROOT, "agent/local");
const TRIAGE_RULES_KERNEL = path.join(EDVA_ROOT, "agent/ops-agent/email-triage-rules.md");

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
// one stuck in-flight task with no automated recovery. Shared with chat via
// turn-watchdog.mjs (unified 2026-07-18, Phase 4 of the substrate plan) —
// TURN_WATCHDOG_MS_DEFAULT is imported above; only the per-source overrides
// below stay local (ops-specific I/O-heavy jobs).
//
// Per-source overrides: I/O-heavy jobs legitimately exceed the default.
// daily-summary harvests calendar + email + photos + git + tasks + notes and
// routinely runs 7-8 min; the 10-min default fired false positives on
// 2026-04-19. Widen to 20 min so normal-but-slow days don't
// kill the child mid-turn. Key matches Dispatcher item.source.
//
// nightly-review and system-issue-review are the two self-improvement jobs, and
// both are structurally incapable of finishing inside 10 min: each reads a large
// batch, then fans out classifier + implementer + critic subagents, each of which
// is its own multi-minute Claude turn. nightly-review had been silently paying
// for this — it tripped the watchdog twice on 2026-07-21 alone (two system-channel
// alerts an hour apart, "hung 10min again (2nd time) — dropping it"), which is
// how a weekly review gets dropped rather than run. system-issue-review hit the
// identical wall on its very first dispatch, 2026-07-22. Neither is hung; both
// are just long. Widen to 30/35 min — the same reasoning that widens any
// deep-research-then-write job.
//
// nightly-review's 30-min override (above) turned out to still be too tight.
// The 2026-07-28 run's real end-to-end duration (data gather + external research +
// second-critic subagent + classify/implement/critic per auto-apply item + email
// build/send) ran close to an hour: dispatched 07:00:01 UTC, hit the 30-min
// watchdog at 07:30:01 (requeued), hit it again at 08:01:02 on the retry and was
// DROPPED — but the actual work had already finished successfully seconds earlier
// (email sent 08:00:20 UTC, confirmed via Gmail). The kill signal doesn't appear to
// reliably stop an in-flight turn already mid-write, so a too-tight watchdog here
// doesn't just risk losing the review — it wastes a full duplicate ~30-min attempt
// racing against one that was already about to finish. Widen further to 55 min,
// comfortably above the observed ~60-min run, rather than re-tuning this a third time.
//
// email-inbound-instruction is the dispatch source the "dispatch, don't chase
// inline" fix (agent/ops-agent/CLAUDE.md, 2026-07-27) created:
// a substantive freeform instruction from the user's reply to a Edva-originated
// email gets forwarded here as its own top-level task instead of being executed
// inline inside the triage turn. That fix closed one way instructions were silently
// dropped — but this new source was never added to the map, so it inherited the
// generic 10-min default, which a "develop these self-improvement suggestions and
// file each as its own Face-ID card" instruction cannot finish inside (it involves
// job-run dispatches, multiple self-improve-request submissions, and state-file
// bookkeeping). Confirmed directly via agent/logs/supervisor-ops/events.ndjson:
// one such item (source email-inbound-instruction, 2026-07-28) hung after
// 10 min (hangCount 1, requeued), hung again 11 min later (hangCount 2,
// dropped:true) — the instruction's official dispatch tracking ended there. The
// underlying work only continued because the interactive session happened to retain
// context across the subsequent restarts; a session with no such continuity would
// have silently lost the user's instruction, which is the exact failure class the
// dispatch fix was written to close, just recreated one layer downstream. 25 min
// matches daily-summary's reasoning (real multi-step I/O-and-subagent work) with a
// bit more headroom for the job-run dispatch + multi-card-filing shape this source
// carries.
//
//
// The instance's own long jobs add their overrides in
// agent/local/config/turn-watchdog.json (`ms_by_source`), merged over
// these.
const TURN_WATCHDOG_MS_BY_SOURCE = {
  "daily-summary": 20 * 60 * 1000,
  "nightly-review": 55 * 60 * 1000,
  "system-issue-review": 35 * 60 * 1000,
  "email-inbound-instruction": 25 * 60 * 1000,
  ...createRequire(import.meta.url)("../../lib/instance.cjs").localConfig("turn-watchdog", { ms_by_source: {} }).ms_by_source,
};

// Queue-depth alarm thresholds. Push once when queue crosses HIGH, re-arm
// when it drops below CLEAR so a new incident can fire again. Ops runs a much
// higher-volume queue than chat (cron + gmail + webhook), so these thresholds
// stay local rather than using queue-alarm.mjs's CHAT_QUEUE_ALARM_* defaults —
// only the QueueAlarm class + hysteresis logic are shared.
const QUEUE_ALARM_HIGH = 20;
const QUEUE_ALARM_CLEAR = 10;

// Hard rotation age: past this, rotate regardless of dispatcher state.
// The soft rotation at 20h defers when dispatcher is busy, which is exactly
// the state a wedged session can't get out of.
const HARD_ROTATE_AGE_MS = 30 * 60 * 60 * 1000;

// Session rotation cap, counted in DISPATCHES since 2026-10-04 (default;
// per-agent override via agents.json `maxSessionTurns` — the key kept its old
// name; see _maybeRotateForTurnCount). The supervisor --resume's one session across dispatches,
// so its context grows turn-by-turn; because ops dispatches are spaced further
// apart than the 5-min prompt-cache TTL, each turn cold-re-bills the entire
// accumulated prefix at full input price. Left unbounded this drove the
// 2026-05-31 cost runaway (a session hundreds of turns long, each turn costing
// dollars). Rotating to a fresh session at this cap — at a turn boundary, even
// while the dispatcher is busy — caps per-turn cost. Set 0 to disable. See
// agent/supervisor/README.md and system/architecture.md.
const MAX_SESSION_TURNS_DEFAULT = 80;

// Context-size guard (ported from chat-supervisor.mjs, 2026-07-08). The
// supervisor --resume's one session across dispatches, so context grows
// turn-by-turn and every cold-cache turn re-bills the whole accumulated prefix
// at full input price — the mechanism behind the 2026-05-31 runaway. Turn-count
// rotation (MAX_SESSION_TURNS) bounds this bluntly: it nukes the session and
// throws away all continuity. The context guard is the gentler *primary* bound —
// inject `/compact` when the live context crosses a token threshold, which
// summarizes the conversation in place (the session id survives a compact, so
// --resume keeps working and continuity is preserved) and drops the re-billed
// prefix back down. Hard-rotate only as a fallback if a compact can't bring
// context under the ceiling. Runs only when the dispatcher is idle. Context
// size is read from per-assistant-call usage (input + cache-read + cache-create
// tokens) = the current prompt size; it drops after a /compact lands. With this
// guard active, MAX_SESSION_TURNS can be relaxed off its emergency floor of 20
// (fewer full rotations → fewer MCP-server respawns). See agents.json + README.
// Thresholds/timing are env-overridable so they can be tuned per-host without a
// code change and driven fast in tests (OPS_CONTEXT_* / OPS_COMPACT_COOLDOWN_MS).
// Thresholds + the decision rule live in ./context-guard.mjs so they can be
// imported (and tested) without starting a supervisor — this file is a CLI
// entrypoint and calls main() on import. That module's header carries the full
// 2026-08-06 cost-runaway rationale for why the rule is floor-aware.
// Unit tests: agent/test/context-guard-floor.test.mjs
const CONTEXT_GUARD_INTERVAL_MS        = Number(process.env.OPS_CONTEXT_GUARD_INTERVAL_MS) || 90_000;
const COMPACT_COOLDOWN_MS              = Number(process.env.OPS_COMPACT_COOLDOWN_MS) || 4 * 60_000; // let a compact land before re-acting
// A /compact reading more than this many cache tokens has run away. A normal
// compaction reads roughly one pass over the context (~170-185k); the runaways
// read 1-8M in 60-170s, i.e. tens of concurrent passes. See the 2026-08-21
// cost-efficiency review: a couple of percent of compactions, each costing
// many times a normal one.
const COMPACT_RUNAWAY_CACHE_READ_TOKENS = Number(process.env.OPS_COMPACT_RUNAWAY_CACHE_READ_TOKENS) || 1_000_000;

// Background-task rotation guard (2026-07-09). A rotation kills the whole
// claude -p child, which takes any run_in_background Bash task with it. The
// "graceful, can-wait" rotation paths (context guard, daily age rotation) defer
// while this.liveBackgroundTasks is non-empty. Bounded so a task whose
// completion notification never streams back (bug, or the CLI dropped it)
// can't block rotation forever.
const BACKGROUND_TASK_MAX_AGE_MS       = Number(process.env.OPS_BACKGROUND_TASK_MAX_AGE_MS) || 20 * 60_000;

// Session-handoff digest (2026-07-08; model-free since 2026-10-04). A blunt
// rotation is amnesia: the fresh session boots knowing nothing of what the old
// one was mid-way through. Before a *healthy* rotation (dispatch cap / age /
// manual / context — NOT crash-loop or auth outage, which are degraded states)
// we build a digest of the outgoing session's recent activity in code, and the
// dispatcher preamble prepends it ONCE to the fresh session's first real
// dispatch. No Haiku fork and no dedicated "acknowledge" turn — that pair was
// a large budget line for a one-line ack. See handoff-digest.mjs.
// Kill-switch: OPS_HANDOFF_DISABLED=1 turns off digest generation entirely (an
// operational escape hatch; also used by rotation tests).
const HANDOFF_DISABLED = process.env.OPS_HANDOFF_DISABLED === "1";
// Per-turn live-state preamble (dispatch-preamble.mjs). On by default; disable
// with OPS_DISPATCH_PREAMBLE_DISABLED=1.
const PREAMBLE_DISABLED = process.env.OPS_DISPATCH_PREAMBLE_DISABLED === "1";

// Matches the error string claude -p writes to the `result` field when Max
// auth is broken. Variants observed:
//   - "Failed to authenticate" / raw JSON "authentication_error" (invalid/expired creds)
//   - "Not logged in · Please run /login" (no creds at all — e.g. the login
//     keychain went missing, as on 2026-06-17 when a CI signing job
//     renamed login.keychain-db out from under the search list; the old regex
//     did NOT match this, so the outage failed silently for ~1h)
//   - keychain unreachable ("keychain cannot be found" / "Keychain Not Found")
const AUTH_ERROR_RE = /Failed to authenticate|authentication_error|Not logged in|Please run \/?(login|`?claude login`?)|[Kk]eychain (cannot be found|[Nn]ot [Ff]ound)/;
const AUTH_FAIL_THRESHOLD = 3;

// "Tue, Oct 13, 3:01 AM <zone>" — for alert text the user reads on their phone,
// in the home timezone (lib/instance.cjs tz) with its generic short name.
const HOME_TZ = createRequire(import.meta.url)("../../lib/instance.cjs").instance().tz;
// How alerts name the machine the agents run on ("the host" unless the instance says otherwise).
const HOST_LABEL = createRequire(import.meta.url)("../../lib/instance.cjs").instance().host_label;
function fmtHome(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: HOME_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortGeneric" });
}

function parseArgs(argv) {
  const args = { agent: "ops", resume: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") args.agent = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--no-resume") args.resume = false;
    else if (a === "--state-dir") args.stateDir = argv[++i];
    else if (a === "--claude-bin") {
      const v = argv[++i];
      // Support a JSON array for bin + prefix args (["node","mock.mjs",...],
      // used by tests); a plain path string is kept as-is for prod. Mirrors
      // chat-supervisor so both supervisors are testable the same way.
      try { const parsed = JSON.parse(v); args.claudeBin = Array.isArray(parsed) ? parsed : v; } catch { args.claudeBin = v; }
    }
    else if (a === "--help" || a === "-h") {
      console.log("usage: supervisor [--agent ops] [--config path] [--model name] [--no-resume] [--claude-bin path]");
      process.exit(0);
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

async function importTriageLog() {
  const mod = await import(path.join(EDVA_ROOT, "lib/triage-log.js"));
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
    // backstop. See queue-persist.mjs for the 2026-05-18 queued-job loss that
    // motivated this.
    // Per-agent queue file so the ops (Opus) and ops-light (Sonnet) supervisors
    // never clobber each other's persisted queue. ops keeps the legacy
    // unsuffixed filename for back-compat (zero-change on restart); any other
    // agent gets a "-<agent>" suffix.
    this.queuePersist = new QueuePersist(path.join(
      EDVA_ROOT,
      `data/dispatcher-queue${args.agent === "ops" ? "" : "-" + args.agent}.json`
    ));
    this.queueRestored = false;
    this.gmailSource = new GmailSource({
      lastHistoryFile: path.join(EDVA_ROOT, "data/last-history-id.json"),
      pauseFlagFile: path.join(EDVA_ROOT, "data/.triage-paused"),
      triageLog,
    });
    this.session = null;
    this.dispatcher = null;
    this.http = null;
    this.startedAt = Date.now();
    this.restartCount = 0;
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.crashLoopAlerted = false;
    this.restarting = false;
    // Rotate to a fresh session once the resumed session reaches this many
    // turns, bounding per-turn cold-cache re-bill cost (see MAX_SESSION_TURNS_DEFAULT).
    this.maxSessionTurns = this.cfg.maxSessionTurns ?? MAX_SESSION_TURNS_DEFAULT;
    // false on cron-only tiers (ops-light, ops-haiku): the context guard
    // rotates where it would otherwise /compact. See context-guard.mjs.
    this.compactOnContext = this.cfg.compactOnContext !== false;
    this.lastRateLimit = null;
    // Quota-refusal hold (dispatcher.mjs § Quota-refusal guard). Kept here as
    // well as on the dispatcher so a restart's replacement dispatcher inherits
    // it instead of spending a turn to rediscover the limit.
    this.rateLimitHoldUntil = 0;
    this.rateLimitAlerted = false;
    this.rotationTimer = null;
    // Context-size guard state (see CONTEXT_*_THRESHOLD_TOKENS).
    this.contextTokens = 0;      // approx current session context, from per-call usage
    this.lastCompactAt = 0;      // when the context guard last injected /compact
    this.compactRanAway = false; // last context-guard /compact blew past the cache-read ceiling
    this.lastActivityAt = Date.now(); // idle clock for the idle-cold rotation (context-guard.mjs): last child event or turn end
    // Session context FLOOR: the irreducible prefix (system prompt + CLAUDE.md
    // chain + MCP tool schemas) that every turn re-sends and no /compact can
    // shrink. Captured from the first usage-bearing assistant call of each
    // session and keyed to that session id, so a /compact — which keeps the
    // session — does NOT re-baseline it. Drives MIN_COMPACTABLE_TOKENS and is
    // the headline number the cost-efficiency review tracks: every token cut
    // from the floor is paid back on every dispatch, forever.
    this.sessionFloorTokens = 0;
    this.floorSessionId = null;
    // Cost cursor for per-dispatch delta attribution. The SDK result message
    // mixes granularities: `num_turns` and `usage` are PER-DISPATCH, but
    // `total_cost_usd` and `modelUsage` are SESSION-CUMULATIVE. Recording the
    // cumulative fields as if they were per-dispatch double-counts every row
    // and pins the session's entire running total on whichever dispatch happens
    // to close next — which is how a `/compact` with `usage` all zeros and
    // `duration_api_ms: 0` appeared to burn tens of dollars in 140s (2026-07-20),
    // and why job-costs.ndjson was inflating daily spend ~2.8x. Diffing against this cursor recovers each dispatch's own spend.
    this.costCursor = { sessionId: null, cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, webSearch: 0 };
    this.contextGuardTimer = null;
    // Live background Bash tasks (run_in_background), keyed by task id → start
    // Date.now(). Populated from tool_result events carrying backgroundTaskId;
    // cleared when the matching <task-notification> (completed/killed) streams
    // back. Rotation paths that can afford to wait (context guard, daily age
    // rotation) defer while any entry is live, so a routine housekeeping
    // rotation doesn't SIGKILL a research fork that's still running — on
    // 2026-07-09 CONTEXT GUARD killed an in-flight Opus research background
    // task ~27s after the turn ended.
    this.liveBackgroundTasks = new Map();
    // Session-handoff digest: staged by the healthy rotation paths and consumed
    // by the dispatcher preamble, which prepends it once to the fresh session's
    // first real dispatch (kills the amnesia a blunt rotation otherwise causes).
    this.pendingHandoff = null;
    // Background-wake attribution. A run_in_background Bash task or async
    // subagent that finishes AFTER its dispatch's turn ended wakes the model
    // with a <task-notification>, and that wake turn completes with no
    // in-flight item — it used to land in job-costs as source "-" (dozens of
    // rows a fortnight, invisible to every per-job view). Map task id → the
    // source that launched it, and charge the wake turn back to that job.
    this.backgroundTaskOwners = new Map();
    this.pendingWakeSource = null;
    this.authErrorCount = 0;
    this.authAlertSent = false;
    this.authWatcher = null;
    // Most recent `result` text that authFailureText() accepted — quoted verbatim
    // in the outage alert so the page reflects what claude -p actually reported
    // instead of always guessing "locked keychain" (see _triggerAuthOutage).
    this.lastAuthError = null;
    // Per-turn hang watchdog + queue-backlog alarm — unified onto the shared
    // modules 2026-07-18 (Phase 4 of the substrate plan; chat adopted these
    // 2026-07-xx as part of the loop-mode work). Behavior is unchanged from
    // ops' prior inline versions except: _onTurnHang now drops an item that
    // hangs twice in a row (parity with chat's poison-message guard, new for
    // ops) and alerts the system channel on every hang (previously silent —
    // see _onTurnHang for rationale).
    this.turnWatchdog = new TurnWatchdog({
      thresholds: TURN_WATCHDOG_MS_BY_SOURCE,
      defaultMs: TURN_WATCHDOG_MS_DEFAULT,
      onFire: (item, ms, info) => this._onTurnHang(item, ms, info),
    });
    this.queueAlarm = new QueueAlarm({
      high: QUEUE_ALARM_HIGH,
      clear: QUEUE_ALARM_CLEAR,
      onHigh: (depth) => {
        console.error(`[supervisor] QUEUE ALARM: depth=${depth} — dispatch backing up`);
        const quotaHeld = !!this.dispatcher?.isHeld();
        this.eventLog.append({ kind: "queue_alarm.high", depth, authPaused: this.authAlertSent, quotaHeld });
        // A queue growing because THIS process deliberately paused dispatch for
        // a Max-auth outage is not a stuck supervisor, and this object already
        // knows which it is — _triggerAuthOutage() set authAlertSent and called
        // dispatcher.setPaused(true) moments earlier. On 2026-09-22 both
        // readings went out about the same queue 20 minutes apart: 03:22:01Z
        // named the auth pause (true), 03:41:48Z said "may be stuck" (false).
        // Name the cause we have instead of guessing at one. The depth still
        // pages either way, so no backlog signal is lost and onClear keeps a
        // partner alert — staying silent here would latch the alarm (armed
        // false, active true, see queue-alarm.mjs) and leave the ✅ drain
        // notice with no ⚠️ in front of it, which is the orphaned-recovery
        // defect.
        // A quota hold is the same shape, and it already paged once when it
        // began (rate_limited below), so its arm is written without a push.
        this._sendPush(quotaHeld
          ? `⚠️ Edva ${this.args.agent} queue depth=${depth} — dispatch is on hold until ${fmtHome(this.dispatcher.holdUntil)} because the Max allowance is used up; the queue runs then.`
          : this.authAlertSent
          ? `⚠️ Edva ${this.args.agent} queue depth=${depth} — dispatch is paused for the Max-auth outage, so nothing will drain until auth is back.`
          : `⚠️ Edva ${this.args.agent} queue depth=${depth}. That supervisor may be stuck — check \`edva status\`.`, { push: !quotaHeld });
      },
      onClear: (depth) => {
        this.eventLog.append({ kind: "queue_alarm.clear", depth });
        this._sendPush(`✅ Edva ${this.args.agent} recovered: queue drained (depth=${depth}) — dispatch caught up.`);
      },
    });
    attachClaudeMdWatcher(this, {
      claudeMdPath: path.join(EDVA_ROOT, this.cfg.cwd, "CLAUDE.md"),
      logPrefix: "[supervisor]",
    });
    // The triage ruleset the agent reads (`triage-rules core|section`, which
    // honours TRIAGE_RULES_FILE) is the kernel file merged with the local
    // companion. An operator-set TRIAGE_RULES_FILE is left alone.
    this._triageRulesOwned = !process.env.TRIAGE_RULES_FILE;
  }

  // Ops role rules: agent/local/shared.md + ops.md → <state>/local-rules.md,
  // passed as --append-system-prompt-file. Every ops tier (ops, ops-light,
  // ops-haiku) shares the ops CLAUDE.md, so every tier gets ops.md. A failure
  // here never blocks the spawn: the session starts on the kernel rules alone.
  _buildLocalRules() {
    try {
      const r = buildLocalRulesFile({ localDir: LOCAL_DIR, role: "ops", stateDir: this.dataDir });
      this._localRulesContent = r.content;
      return r.path;
    } catch (err) {
      console.error(`[supervisor] local rules unavailable (${err.message}) — starting on the kernel rules alone`);
      return null;
    }
  }

  // Merge ops-agent/email-triage-rules.md + local/email-triage-rules.md into
  // <state>/email-triage-rules.md (rewritten only on change) and point
  // TRIAGE_RULES_FILE at it for this process and everything it spawns: the
  // claude child's `triage-rules` calls, and the triage helpers gmail-source
  // forks. Re-run on a timer so an edit to either file reaches the next read.
  _refreshTriageRules() {
    if (!this._triageRulesOwned) return;
    try {
      const merged = composeTriageRules({
        kernelPath: TRIAGE_RULES_KERNEL,
        localPath: path.join(LOCAL_DIR, "email-triage-rules.md"),
        outPath: path.join(this.dataDir, "email-triage-rules.md"),
      });
      if (merged) process.env.TRIAGE_RULES_FILE = merged;
      else delete process.env.TRIAGE_RULES_FILE;
    } catch (err) {
      console.error(`[supervisor] triage rules merge failed (${err.message}) — agent reads the kernel ruleset`);
    }
  }

  startLocalWatchers() {
    this._stopLocalRulesWatch = watchLocalRules(this, { localDir: LOCAL_DIR, role: "ops", logPrefix: "[supervisor]" });
    this._triageRulesTimer = setInterval(() => this._refreshTriageRules(), 30_000);
    this._triageRulesTimer.unref?.();
  }

  stopLocalWatchers() {
    this._stopLocalRulesWatch?.();
    if (this._triageRulesTimer) { clearInterval(this._triageRulesTimer); this._triageRulesTimer = null; }
  }

  async startSession({ resume }) {
    this.sessionStartedAt = Date.now();
    const cfg = this.cfg;
    const mcpConfigPath = path.join(EDVA_ROOT, "agent/supervisor/mcp-config.json");
    this._refreshTriageRules();
    const localRulesFile = this._buildLocalRules();
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
      // A deny rule removes the server's tool names from the prefix of every
      // dispatch (see claude-session.mjs); allowedTools does not under
      // bypassPermissions. Per-agent, so it never touches the user's own sessions.
      disallowedTools: (cfg.disallowedTools || []).join(" ") || undefined,
      cwd: path.join(EDVA_ROOT, cfg.cwd),
      addDirs: [EDVA_ROOT],
      claudeBin: this.args.claudeBin,
      // Ops runs on the Max subscription (intended auth). Hide
      // ANTHROPIC_API_KEY from the child so claude -p uses the Max
      // credentials in ~/.claude/.credentials.json; otherwise the API key
      // takes precedence and ops hits the same usage cap as the chat agent.
      unsetEnv: ["ANTHROPIC_API_KEY"],
      // Keep the session's prompt prefix byte-stable across rotations. With
      // git context on, claude -p snapshots `git status` + recent commits into
      // the context at session start; the repo always has churning untracked
      // data files and new commits, so every fresh session's prefix
      // differed and the CLAUDE.md chain behind it was re-written to cache
      // instead of read. Setting this (any value) turns off both the git
      // status snapshot and the generic git/PR instructions; ops jobs never
      // relied on either — they run git through Bash like any other command.
      //
      // NODE_USE_ENV_PROXY makes Node honour the Bash sandbox's network proxy.
      // ops-light and ops-haiku used to run their Bash tool inside the Claude
      // Code sandbox (~/.claude/settings.json; only ops-agent/ and chat-agent/
      // turn it off, in their gitignored .claude/settings.local.json) until
      // `settings` below switched it off for every ops tier. That sandbox lets
      // traffic out only through the local proxy it puts in HTTPS_PROXY. curl uses the proxy; Node's built-in fetch ignores it
      // unless this is set, so every Node tool (email-send, gmail-action,
      // og-card, …) failed there with "fetch failed (ENOTFOUND)" — a job's
      // email built but never delivered. Inert wherever HTTPS_PROXY is unset: the ops
      // tier, cron, every MCP server. Localhost stays blocked, because the
      // sandbox lists it in NO_PROXY. Guarded by
      // tests/supervisor-sandbox-node-proxy.test.mjs.
      env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1", NODE_USE_ENV_PROXY: "1" },
      // The Bash sandbox is OFF for every ops tier, matching ops-agent/ and
      // chat-agent/ (which turn it off in their gitignored settings.local.json;
      // ops-light-agent/ and ops-haiku-agent/ never had one). The host sandbox
      // denies reading ~/Library/Keychains, where the Max login lives, so on
      // those two tiers every `claude -p` a CLI forks from Bash (the outbound
      // precheck and claim-freshness gates behind edva-send-curl,
      // claim-check, hum-ideas-append) printed "Not logged in" and the gate
      // failed open: the message went out unchecked. 2026-10-13/14: 11 of 11
      // precheck failures were sandboxed calls, 11 of 11 successes were calls
      // the agent had un-sandboxed itself (dangerouslyDisableSandbox, which
      // bypassPermissions grants without asking, so the sandbox was never an
      // enforced boundary on these tiers). Guarded by
      // tests/supervisor-sandbox-off.test.mjs.
      //
      // idleCompaction:false — Claude Code 2.1.299+ compacts a long conversation
      // after ~54 idle minutes; that would summarise away the supervisor's warm
      // context between jobs and re-write the cache floor on the next dispatch.
      // The supervisors already run their own compaction (context-guard.mjs),
      // so the CLI's idle one is switched off here, per supervisor session only:
      // The user's own Claude Code sessions keep the default. Item 13 of the
      // 2026-10-20 review. Guarded by tests/supervisor-idle-compaction.test.mjs.
      //
      // hooks — the git-rollback guard (D2): a PreToolUse hook that snapshots
      // uncommitted work to refs/edva/pre-destructive/* before any
      // destructive git command, or blocks it. lib/rollback-guard.mjs.
      settings: JSON.stringify({ sandbox: { enabled: false }, idleCompaction: false, hooks: gitGuardHooks() }),
      // The other half of the stable prefix: the default system prompt also
      // carries per-day/per-machine sections (today's date, cwd, env info).
      // The date changes daily, so the first session of each day re-wrote the
      // whole floor to cache. This flag moves those sections into the first
      // user message. Gated on the installed CLI actually knowing the flag so
      // a stale binary degrades to "not passed" instead of a crash loop.
      // Opt out per agent with `excludeDynamicPromptSections: false`.
      excludeDynamicSystemPromptSections: cfg.excludeDynamicPromptSections !== false
        && !this.args.claudeBin
        && supportsCliFlag("--exclude-dynamic-system-prompt-sections"),
      // The operator's local rules (agent/local/shared.md + ops.md),
      // appended to the system prompt; omitted when there are none.
      appendSystemPromptFile: localRulesFile || undefined,
      resume,
    };

    const sess = new ClaudeSession(sessionOpts);
    this.session = sess;
    // The id this child was actually spawned with. Used by the "ready" handler
    // below to reject late events from a session a rotation has already
    // replaced — see the stale-session guard there.
    const spawnedSessionId = sessionOpts.sessionId;

    this.session.on("event", (ev) => {
      this.state.touch();
      // Idle clock: ANY child event counts, not just a dispatch's turn_complete,
      // because a background-task wake runs a turn with no dispatch in flight.
      this.lastActivityAt = Date.now();
      // Child stream activity feeds the armed turn's watchdog, which tells a
      // turn still making progress from a stalled one trickling thinking_tokens
      // (2026-10-08). Only the child's
      // own events land here; dispatcher.* bookkeeping never touches.
      this.turnWatchdog.touch(ev);
      this.eventLog.append({ kind: ev.type, ...ev });
      this.instrumentation.observe(ev);
      // Track approx current context size from per-assistant-call usage, for the
      // context-size guard (compact-before-nuke). The last assistant call in a
      // turn carries the full prompt = current context; it drops after a
      // /compact. Mirrors chat-supervisor.mjs.
      if (ev.type === "assistant" && ev.message?.usage) {
        const u = ev.message.usage;
        const ctx = (u.input_tokens ?? u.inputTokens ?? 0)
                  + (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0)
                  + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
        if (ctx > 0) this.contextTokens = ctx;
        // First usage-bearing call of a session measures the floor. Keyed on
        // session id (not on contextTokens===0) so a post-/compact reset —
        // same session — keeps the original floor rather than re-baselining to
        // a post-compact number, which would make the floor look like it fell
        // when nothing structural changed.
        // A session resumed after a supervisor restart keeps the floor its
        // own first call measured (State.floorFor): its first call now carries
        // the whole resumed conversation, which is not floor.
        const keptFloor = ctx > 0 && this.floorSessionId !== this.state.sessionId
          ? this.state.floorFor(this.state.sessionId) : 0;
        if (keptFloor > 0) {
          this.floorSessionId = this.state.sessionId;
          this.sessionFloorTokens = Math.min(keptFloor, ctx);
          this.eventLog.append({ kind: "context.floor_restored", sessionId: this.state.sessionId, floorTokens: keptFloor, contextTokens: ctx });
          console.error(`[supervisor] context floor restored for resumed session: ${keptFloor} tokens (context now ${ctx})`);
        } else if (ctx > 0 && this.floorSessionId !== this.state.sessionId) {
          this.floorSessionId = this.state.sessionId;
          this.sessionFloorTokens = ctx;
          this.state.recordFloor(this.state.sessionId, ctx);
          this.eventLog.append({
            kind: "context.floor_measured",
            sessionId: this.state.sessionId,
            floorTokens: ctx,
            compactThreshold: CONTEXT_COMPACT_THRESHOLD_TOKENS,
            rotateThreshold: CONTEXT_ROTATE_THRESHOLD_TOKENS,
            // Working window = how much real conversation fits before a rotate.
            // If this goes near zero the agent is paying full freight to do
            // almost nothing; that is the signal the review job watches.
            workingWindowTokens: Math.max(0, CONTEXT_ROTATE_THRESHOLD_TOKENS - ctx),
          });
          console.error(`[supervisor] context floor measured: ${ctx} tokens (working window to rotate: ${Math.max(0, CONTEXT_ROTATE_THRESHOLD_TOKENS - ctx)})`);
        }
      }
      // Track run_in_background Bash tasks so rotation paths that can afford
      // to wait don't SIGKILL one mid-flight. Start: a tool_result carrying
      // backgroundTaskId. End: the <task-notification> that streams back
      // (completed or killed) when the CLI itself resolves it.
      if (ev.type === "user") {
        const tur = ev.tool_use_result ?? ev.toolUseResult;
        const backgroundTaskId = tur?.backgroundTaskId;
        if (backgroundTaskId) {
          this.liveBackgroundTasks.set(backgroundTaskId, Date.now());
          this._recordBackgroundOwner(backgroundTaskId);
        }
        // Async Agent subagents resolve through the SAME <task-notification>
        // envelope as a background Bash task, so the end side below already
        // clears them — but only Bash tasks were ever REGISTERED, so an async
        // fan-out was invisible to every rotation-deferral path. 2026-09-07:
        // a watch job launched three, ended its turn to await them, and the
        // session was hard-rotated 9s after the last one finished with one
        // result still undelivered — the job died between discovery and
        // delivery, having already paid for 96 web searches. Structured
        // field off the SDK envelope, no parsing.
        if (tur?.isAsync && tur?.agentId) {
          this.liveBackgroundTasks.set(tur.agentId, Date.now());
          this._recordBackgroundOwner(tur.agentId);
        }
        const content = ev.message?.content;
        if (typeof content === "string" && content.includes("<task-notification>")) {
          // The CLI's own <task-notification> envelope — structure emitted by
          // Claude Code, not anything the user wrote, and the id is opaque.
          // lang-regex-ok: reads a machine-generated tag, interprets no meaning
          const m = content.match(/<task-id>([^<]+)<\/task-id>/);
          if (m) {
            this.liveBackgroundTasks.delete(m[1]);
            // If no dispatch is in flight, this notification is about to wake
            // the model on its own — remember whose task it was so the wake
            // turn's cost is charged to that job instead of "-".
            const owner = this.backgroundTaskOwners.get(m[1]);
            this.backgroundTaskOwners.delete(m[1]);
            if (owner && !this.dispatcher?.inFlight) this.pendingWakeSource = owner;
          }
        }
      }
    });

    this.session.on("result", (ev) => {
      const costUsd = ev.total_cost_usd || 0;
      const turns = ev.num_turns || 0;
      const durationMs = ev.duration_ms || 0;
      if (turns === 0) this.consecutiveZeroTurns++;
      else {
        this.consecutiveZeroTurns = 0;
        // Recovery notification: if we paged about a crash-loop, confirm the
        // fresh session is processing real turns again — parity with the alert
        // (§ System Channel: a self-heal that fixes an issue is reported too).
        if (this.crashLoopAlerted) {
          this._sendPush(`✅ Edva ${this.args.agent} recovered: the fresh session is processing turns again after the crash-loop.`);
          this.crashLoopAlerted = false;
        }
      }
      // No-op detection: a completed turn that finished too fast to be real work
      // — seen when the child stays alive but emits instant result events without
      // actually calling the LLM (Apr 2026 outage: 1 turn / $0 / <300ms).
      if (turns >= 1 && durationMs < NO_OP_DURATION_MS) this.consecutiveNoOpTurns++;
      else this.consecutiveNoOpTurns = 0;
      // Auth-error detection: on invalid Max creds, claude -p emits a
      // "successful" result with the 401 body in ev.result. Count consecutive
      // failures so a single flake doesn't pause the dispatcher.
      //
      // Only a short result from a turn that errored or never got past its
      // first step counts (authFailureText, the same guard chat-supervisor.mjs
      // uses). Testing AUTH_ERROR_RE against the whole result made any real
      // summary that quoted one of the CLI's phrases an auth failure: on
      // 2026-10-23 a 6-turn, 1050-character hum summary on ops-light mentioned
      // another job failing with "Not logged in", was logged as AUTH ERROR #1,
      // and watchdog.sh paged a Max-auth outage that never happened. Three such
      // turns in a row would also have paused dispatch on a healthy login.
      const authFail = authFailureText(ev);
      if (authFail) {
        this.authErrorCount++;
        this.lastAuthError = authFail.slice(0, 300);
        console.error(`[supervisor] AUTH ERROR #${this.authErrorCount}: ${authFail.slice(0, 160)}`);
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
      this.turnWatchdog.clear();
      // Re-queue in-flight dispatch so it's not lost across restarts.
      const requeued = this.dispatcher?.requeueInFlight();
      if (requeued) console.error(`[supervisor] re-queued in-flight dispatch: ${requeued.source}`);
      // Pause the dispatcher across the restart window. Otherwise an inbound
      // dispatch (webhook, gmail-source, cron) calls _drain → shifts the
      // re-queued head item back into inFlight → session.send() writes to the
      // killed child's stdin → silent drop. The restart-recovery path below
      // only transfers `dispatcher.queue` to the new dispatcher, so anything
      // re-marked inFlight during the restart backoff is lost. This bit a
      // weekly job on 2026-04-30 and 2026-05-07 after watchdog kills.
      // (The pause lives on the OLD dispatcher, which is replaced wholesale
      // by `new Dispatcher(...)` in restart() — the new dispatcher starts
      // unpaused and inherits the queued items.)
      // A REAL auth outage is signalled by this.authAlertSent (set in
      // _triggerAuthOutage), NOT merely by dispatcher.paused. Turn-count
      // rotation also pauses the dispatcher (to block the imminent _drain), so
      // keying off `paused` here misclassified every rotation as an auth outage
      // — a misleading log, and a latent hang risk (if a rotation's own restart
      // failed, the early return would leave the dispatcher paused forever).
      // Always ensure the dispatcher is paused across the restart window; only
      // skip the auto-restart when it's a genuine auth outage. 2026-06-01.
      const authOutage = this.authAlertSent;
      if (this.dispatcher && !this.dispatcher.paused) this.dispatcher.setPaused(true);
      if (authOutage) {
        console.error(`[supervisor] dispatcher paused (auth outage) — skipping auto-restart until creds refresh`);
        return;
      }
      if (!this.restarting) this.restart().catch((e) => console.error(`[supervisor] auto-restart failed: ${e.message}`));
    });

    this.session.on("ready", (ev) => {
      // Stale-session guard (root cause of the 2026-07-20 rotate->resume race).
      // A turn-count/context rotation calls state.rotateSession() — which mints
      // a new id and clears everInitialized — and then awaits session.stop().
      // stop() ends stdin and only SIGTERMs at +2000ms, so the OUTGOING child
      // can still emit a system.init inside that window. Unguarded, that stale
      // init fell through to markInitialized() below, which marks STATE's
      // *current* id — the freshly-minted rotation id that has never been
      // spawned — as resumable. restart() then saw canResume=true and spawned
      // `--resume <never-created-id>`; claude -p validates the target lazily,
      // so this surfaced as a zero-turn "No conversation found" exit code=1,
      // which the generic exit path charged a 60s crash backoff for.
      // Only the session that is still live may mutate rotation state.
      if (this.session !== sess || this.state.sessionId !== spawnedSessionId) {
        console.error(`[supervisor] ignoring stale ready from ${spawnedSessionId} (current=${this.state.sessionId})`);
        return;
      }
      if (this.session.resumeFailed) {
        console.error(`[supervisor] --resume failed, rotated to new session_id=${this.session.sessionId}`);
        this.state.rotateSession();
        this._resetContextTracking();
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
    // silently swallowed a transferred daily-summary after another job
    // tripped the watchdog.
    //
    // Defense-in-depth: also rescue any leftover `inFlight` from the old
    // dispatcher and put it at the head of the new queue. With the
    // setPaused(true) added to the exit handler above, inFlight should
    // already be null here (requeueInFlight ran on exit, and the pause
    // prevents any subsequent _drain from re-marking it). But if anything
    // ever bypasses the pause, a non-null inFlight at this point would
    // otherwise be silently dropped — that was the 2026-05-07 failure mode.
    // Belt + suspenders.
    const pendingItems = [];
    if (this.dispatcher?.inFlight) {
      console.error(`[supervisor] rescuing in-flight ${this.dispatcher.inFlight.source} from old dispatcher`);
      pendingItems.push(this.dispatcher.inFlight);
      this.dispatcher.inFlight = null;
    }
    if (this.dispatcher) for (const item of this.dispatcher.queue) pendingItems.push(item);
    this.dispatcher?.dispose();
    this.dispatcher = new Dispatcher(this.session, {
      persist: () => this.queuePersist.save(this.dispatcher),
      // Per-turn live-state preamble (dispatch-preamble.mjs) — prepended to real
      // work at send time so the agent gets fresh dynamic state (time, …) every
      // turn without a graceful-restart. Skips control/synthetic dispatches and
      // is fully fail-soft. Toggle off with OPS_DISPATCH_PREAMBLE_DISABLED=1.
      // A staged session-handoff digest rides on the first real dispatch of the
      // fresh session, once (it used to cost a dedicated turn).
      preamble: (item) => {
        if (!shouldPreamble(item)) return null;
        const handoff = this._takeHandoffBlock(item);
        const live = PREAMBLE_DISABLED ? null : buildPreamble({ cacheDir: path.join(EDVA_ROOT, "data") });
        return (handoff + (live || "")) || null;
      },
    });
    // A quota hold outlives the dispatcher it started on. Without this, every
    // restart during an outage (the watchdog's stale check fires one every 15
    // min while the queue sits) would send one more turn just to be refused.
    if (this.rateLimitHoldUntil > Date.now()) this.dispatcher.hold(this.rateLimitHoldUntil);
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
      this._checkQueueAlarm();
    });
    this.dispatcher.on("dispatching", (item) => {
      const shortId = item.id.slice(0, 6);
      console.error(`[supervisor] disp ${shortId} → ${item.source}: ${(item.content ?? item.task ?? '').slice(0, 80)}...`);
      this.eventLog.append({ kind: "dispatcher.dispatching", item });
      this.instrumentation.markDispatch(item.id, item.source);
      this.turnWatchdog.arm(item);
    });
    // A resume-handshake result was correctly NOT attributed to the in-flight
    // item (lib/phantom-result.mjs). Log it — this fires on every hang recovery,
    // so silence here would hide whether the guard is working, and a sudden
    // spike means something is killing turns.
    this.dispatcher.on("phantom_result", ({ item }) => {
      console.error(`[supervisor] ignored resume-handshake result for in-flight ${item.id.slice(0, 6)} (${item.source}) — turn still running`);
      this.eventLog.append({ kind: "dispatcher.phantom_result", itemId: item.id, source: item.source });
    });
    // Compact-race guard (dispatcher.mjs) — a turn landed too fast/cheap right
    // after a context-guard /compact to trust it did real work. First hit
    // requeues silently (normal — the retry usually clears it); log only.
    this.dispatcher.on("compact_race_requeue", ({ item, result }) => {
      console.error(`[supervisor] compact-race requeue for ${item.id.slice(0, 6)} (${item.source}) — turns=${result.num_turns} ${result.duration_ms}ms, retrying once`);
      this.eventLog.append({ kind: "dispatcher.compact_race_requeue", itemId: item.id, source: item.source, numTurns: result.num_turns, durationMs: result.duration_ms });
    });
    // Second hit on the same item — no longer a timing fluke. The turn is
    // allowed to stand (the queue must not wedge retrying forever) but this
    // is a real anomaly worth a human look, so page the system channel the
    // same way auth-outage/queue-alarm/crash-loop already do from here.
    this.dispatcher.on("compact_race_exhausted", ({ item, result }) => {
      console.error(`[supervisor] compact-race guard EXHAUSTED for ${item.id.slice(0, 6)} (${item.source}) — turns=${result.num_turns} ${result.duration_ms}ms, letting it complete`);
      this.eventLog.append({ kind: "dispatcher.compact_race_exhausted", itemId: item.id, source: item.source, numTurns: result.num_turns, durationMs: result.duration_ms });
      this._sendPush(`⚠️ ${item.source} may have silently no-op'd next to a /compact (turns=${result.num_turns}, ${result.duration_ms}ms, already retried once) — worth checking it actually did its job.`);
    });
    // Quota-refusal guard (dispatcher.mjs). The refused turn is already back at
    // the head of the queue and dispatch is held; here we stop the hang
    // watchdog (no result is coming for that item), keep the refusal out of
    // the watchdog's no-op count (five of them used to buy a /restart, 151
    // times on 2026-09-16), and page once per outage. The text carries no
    // tier name on purpose: the allowance is one account shared by ops,
    // ops-light and ops-haiku, so all three hit it together, and identical
    // text lets system-alert-dedup send one page instead of three.
    this.dispatcher.on("rate_limited", ({ item, info, until, requeued }) => {
      this.turnWatchdog.clear();
      this.consecutiveNoOpTurns = 0;
      this.rateLimitHoldUntil = Math.max(this.rateLimitHoldUntil, until);
      const windowType = info?.rateLimitType || "unknown";
      const depth = this.dispatcher.queue.length;
      const what = requeued ? "put back at the head of the queue" : "hit the limit mid-turn after doing work, so it is NOT re-run";
      const how = info?.inferred ? "still refused (silently) on the first try after the hold" : "QUOTA REFUSED";
      console.error(`[supervisor] ${how}: ${item.source} (${item.id.slice(0, 6)}) ${what}; holding dispatch until ${new Date(until).toISOString()} (${windowType} window, queue=${depth})`);
      this.eventLog.append({ kind: "dispatcher.rate_limited", itemId: item.id, source: item.source, requeued: !!requeued, inferred: !!info?.inferred, rateLimitType: windowType, resetsAt: info?.resetsAt ?? null, holdUntil: new Date(until).toISOString(), queueDepth: depth });
      if (this.rateLimitAlerted) return;
      this.rateLimitAlerted = true;
      const which = { seven_day: "weekly limit", five_hour: "5-hour limit" }[windowType] || "usage limit";
      const when = info?.resetsAt ? `until ${fmtHome(until)}, when it resets` : "for now — it gave no reset time, so I'll try again every 15 minutes";
      const kept = requeued
        ? "The job that was refused is back at the front of the queue"
        : `The job that was running (${item.source}) got partway before the limit hit and won't be repeated`;
      this._sendPush(`⚠️ Edva has hit its Max ${which}, so background jobs are on hold ${when}. ${kept}, queued jobs will run once the limit clears, and hum check-ins pause until then.`, { push: true });
    });
    this.dispatcher.on("hold_released", () => {
      console.error(`[supervisor] quota hold released — resuming dispatch (queue=${this.dispatcher.queue.length})`);
      this.eventLog.append({ kind: "dispatcher.hold_released", queueDepth: this.dispatcher.queue.length });
    });
    this.dispatcher.on("turn_complete", (info) => {
      this.turnWatchdog.clear();
      this.lastActivityAt = Date.now();
      this._checkQueueAlarm();   // depth may have drained below CLEAR → recovery ✅
      // First real turn after a quota hold: the limit has actually cleared
      // (a released hold alone proves nothing — the next turn can be refused
      // again and re-hold). Partner ✅ for the ⚠️ above. A turn that completes
      // while still held is the one that hit the limit mid-turn, and a
      // context-guard /compact or a background wake is not a job — neither is
      // recovery.
      if (this.rateLimitAlerted && !this.dispatcher.isHeld() && info.message && info.message.source !== "context-guard") {
        this.rateLimitAlerted = false;
        this.rateLimitHoldUntil = 0;
        this._sendPush(`✅ Edva's Max allowance is back — queued background jobs are running again.`);
      }
      const shortId = info.message?.id ? info.message.id.slice(0, 6) : "------";
      // A result with no in-flight item is a background-wake turn; charge it
      // to the job whose task woke it (see backgroundTaskOwners).
      const wakeSource = !info.message ? this.pendingWakeSource : null;
      this.pendingWakeSource = null;
      const source = info.message?.source || wakeSource || "-";
      const ms = info.result.duration_ms ?? "?";
      const cost = (info.result.total_cost_usd || 0).toFixed(4);
      const turns = info.result.num_turns ?? "?";
      console.error(`[supervisor] disp ${shortId} done ${source} ${ms}ms $${cost} turns=${turns}`);
      this.eventLog.append({ kind: "dispatcher.turn_complete", id: info.message?.id, durationMs: info.result.duration_ms, costUsd: info.result.total_cost_usd });
      this._clearHungTurnAlert(info);

      // Per-job cost attribution — drives edva-cost-report + nightly-review
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
        // Diff the cumulative fields against the cursor to recover THIS
        // dispatch's own spend. A session change (rotation) or any counter
        // going backwards resets the baseline rather than emitting a negative.
        // Caveat: with one shared session, parallel subagent work that finishes
        // inside a dispatch's window is still charged to that dispatch. That's
        // inherent to the shared-session model and is a smaller, separate
        // problem than the double-count this fixes.
        const sid = info.result.session_id || this.state.sessionId;
        const cum = info.result.total_cost_usd ?? 0;
        const c = this.costCursor;
        const fresh = c.sessionId !== sid || cum < c.cost;
        const d = (cur, prev) => (fresh || cur < prev ? cur : cur - prev);
        const row = {
          cost: d(cum, c.cost), input: d(input, c.input), output: d(output, c.output),
          cacheRead: d(cacheRead, c.cacheRead), cacheCreate: d(cacheCreate, c.cacheCreate),
          webSearch: d(webSearch, c.webSearch),
        };
        this.costCursor = { sessionId: sid, cost: cum, input, output, cacheRead, cacheCreate, webSearch };
        this.eventLog.appendJobCost({
          dispatch_id: info.message?.id || null,
          short_id: shortId,
          source,
          session_id: sid,
          duration_ms: info.result.duration_ms ?? null,
          num_turns: info.result.num_turns ?? null,
          total_cost_usd: row.cost,
          session_cumulative_cost_usd: cum,
          input_tokens: row.input,
          output_tokens: row.output,
          cache_read_tokens: row.cacheRead,
          cache_creation_tokens: row.cacheCreate,
          web_search_requests: row.webSearch,
          models,
          terminal_reason: info.result.terminal_reason || null,
          ...(wakeSource ? { bg_wake: true } : {}),
        });

        // Runaway-/compact detection. The TRIGGER looks normal every time
        // (ctx ~180k, compactable ~50k) — it is the execution that blows up,
        // re-reading the context tens of times over. They also CLUSTER: a
        // runaway compact often fails to bring ctx down, so the guard fires
        // another one minutes later and that one runs away too (2026-08-16
        // 13:32 rotate -> 13:34 compact -> 13:37 rotate -> 13:38 compact ->
        // 13:43 compact). Flagged here because the per-dispatch token diff
        // only exists in this scope; acted on in the context-guard branch
        // below.
        // Two cheap discriminators, because the cache-read ceiling alone
        // cannot tell a runaway compaction from ANOTHER TURN'S usage landing
        // on this dispatch id — the SDK attributes usage to whichever turn
        // closes, and a /compact enqueued while a session has async subagents
        // or an unfinished turn in flight collects theirs. A compaction issues
        // no web searches and is not a turn loop, so either signal proves the
        // row is not a compaction and the hard rotate would be destructive for
        // nothing. Measured over all 669 historically-flagged rows: these two
        // exclude 41 (6.1%) and keep 628, including the entire July cluster
        // (turns 0, no searches) this guard was built for. 2026-09-07 needed
        // both — the 11:17 row was 7 searches at 1,206,254 cache tokens in
        // 2,218 ms (544k tok/s, not a read); the 13:59 row was 34 turns over
        // 429 s and its transcript is a watch job finishing its email.
        const notACompaction = (row.webSearch ?? 0) > 0 || (info.result.num_turns ?? 0) > 1;
        if (source === "context-guard" && row.cacheRead > COMPACT_RUNAWAY_CACHE_READ_TOKENS && !notACompaction) {
          this.compactRanAway = true;
          this.eventLog.append({
            kind: "context_guard.compact_runaway",
            cacheReadTokens: row.cacheRead,
            outputTokens: row.output,
            costUsd: row.cost,
            durationMs: info.result.duration_ms ?? null,
          });
          console.error(`[supervisor] CONTEXT GUARD: /compact ran away — ${row.cacheRead} cache-read tokens, ${row.output} output, ${(row.cost ?? 0).toFixed(2)} — hard-rotating instead of giving it another try`);
        }
      } catch (err) {
        console.error(`[supervisor] job-cost attribution failed: ${err.message}`);
      }

      // After a context-guard /compact, optimistically reset the tracked
      // context so the guard doesn't immediately re-fire; the next real turn
      // re-measures it from usage.
      if (info.message?.source === "context-guard") {
        this.contextTokens = 0;
        console.error(`[supervisor] /compact turn complete — context tracker reset`);
        // Do not give a session that just ran away a second chance to do it
        // again. A cold rotate costs about one cache-write, several times less
        // than an average runaway, and it resets the context outright rather
        // than hoping the next compaction behaves. Defers while background
        // work is live, exactly as the guard.s own rotate path does.
        if (this.compactRanAway) {
          this.compactRanAway = false;
          if (this.hasLiveBackgroundTasks()) {
            console.error(`[supervisor] runaway /compact: deferring hard rotate — ${this.liveBackgroundTasks.size} background task(s) still in flight`);
          } else {
            this._rotateForContext("compact-runaway");
          }
        }
      }

      // Turn-count rotation: once the resumed session has accumulated enough
      // turns, rotate to a fresh one to bound cold-cache re-bill cost. This
      // fires at a turn boundary (inFlight already cleared above) even when the
      // queue is non-empty — unlike the age-based timer, which defers while
      // busy and so never fired during the 2026-05-31 backlog. The setPaused
      // inside blocks the imminent _drain() so the next item isn't sent to the
      // session we're about to replace; restart() transfers the queue.
      if (this._maybeRotateForTurnCount()) return;
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

  // Per-turn hang recovery (TurnWatchdog onFire). A turn produced no `result`
  // within its window → the child is hung. SIGKILL it: session.on("exit") →
  // requeueInFlight() → restart(), so the stuck item is retried on a fresh
  // session and the queue behind it drains. Surfaced to the system channel so
  // a silent kill is visible (previously ops killed silently — log only, no
  // alert; brought to parity with chat's _onTurnHang during the 2026-07-18
  // unification since a repeated multi-minute hang is exactly the kind of
  // concrete, non-self-healing signal worth paging on).
  //
  // Activity-aware since 2026-10-08 (turn-watchdog.mjs § Hybrid detection):
  // `info.reason` is "idle" (no child event for 12 min), "window" (the classic
  // elapsed window, with no recent progress) or "ceiling" (still making
  // progress, but past 3x its window). `mins` is the turn's real elapsed time
  // when known. The alert wording up to "restarting to retry"
  // is unchanged on purpose — system-issue-review clusters on it — and the
  // reason is appended after it.
  _onTurnHang(item, ms, info) {
    const src = item?.source || "unknown";
    const mins = Math.round((info?.elapsedMs ?? ms) / 60000);
    const why = hangReasonClause(info);
    // Track how many times THIS item has hung. A deterministically-hanging
    // item (a poison message that wedges every turn it runs) would otherwise
    // be requeued and re-killed forever. After the first hang we retry once;
    // on the second we DROP it so it can't wedge the queue in a loop.
    const hangCount = (item ? (item.hangCount = (item.hangCount || 0) + 1) : 1);
    // A dead-lettered request's one retry (dead-letter.mjs) drops on its FIRST
    // hang: never retry more than once. Detection and the count above are
    // untouched, and no item carried `hangRetry` before that module set it.
    const retried = !!item?.hangRetry;
    const drop = hangCount >= 2 || retried;
    if (drop && this.dispatcher) {
      // Clear inFlight BEFORE the SIGKILL so session.on("exit") →
      // requeueInFlight() finds nothing to requeue — the poison item is
      // discarded, not retried.
      this.dispatcher.inFlight = null;
    }
    console.error(`[supervisor] TURN WATCHDOG: no result in ${mins}min for ${src} (item ${item?.id}, hang #${hangCount}, reason ${info?.reason || "window"}, silent ${info ? Math.round(info.silentMs / 1000) + "s" : "?"}, since progress ${info ? Math.round(info.sinceProgressMs / 1000) + "s" : "?"}) — ${drop ? `DROPPING (${retried ? "its one retry hung" : "repeat hang"})` : "requeue"} + kill child`);
    this.eventLog.append({ kind: "turn_watchdog.hang", source: src, itemId: item?.id, windowMs: ms, hangCount, dropped: drop, reason: info?.reason, silentMs: info?.silentMs, sinceProgressMs: info?.sinceProgressMs, elapsedMs: info?.elapsedMs, hangRetry: retried, retryOf: item?.retryOf });
    // Best-effort: nothing in the dead-letter step may skip the SIGKILL below
    // and leave a hung child alive.
    let dl = null;
    if (drop && item) {
      try { dl = this._deadLetter(item, { src, mins, hangCount, reason: info?.reason || "window" }); }
      catch (err) { console.error(`[supervisor] dead-letter step failed for ${src}: ${err.message}`); }
    }
    this._sendPush(
      retried
        // "dropping it and restarting" kept verbatim: system-issue-review's
        // generic-turn-hangs cluster matches on it.
        ? `⚠️ ${this.args.agent} turn from ${src} hung ${mins}min on its one retry${why} — dropping it and restarting so it stops wedging the queue. Dead-lettered for good; it is not retried again.`
        : drop
        ? `⚠️ ${this.args.agent} turn from ${src} hung ${mins}min again (2nd time)${why} — dropping it and restarting so it stops wedging the queue. Dead-lettered${dl?.retryItem ? "; it is the user's own request, so it is queued once more as a fresh retry" : ""}.`
        : `⚠️ ${this.args.agent} turn from ${src} hung for ${mins}min with no result — killing + restarting to retry${why}.`
    );
    // Recovery parity (§ System Channel, 2026-07-04: a successful self-heal is
    // reported too, not only the failure). The hang page
    // above says "restarting to retry" and then never says whether the retry
    // worked — so a ⚠️ that reads like a job failure is the whole story the user
    // gets for something that usually succeeds a minute later. Measured on the
    // two cron-hum-action-executor hangs this alert has fired for: 2026-08-23
    // killed 14:24:35Z, retry completed 14:38:01Z (32 turns); 2026-08-28 killed
    // 14:40:00Z, retry completed 14:42:18Z (8 turns, 75s). Both ran fine. Only
    // the non-drop branch is remembered — the drop branch is already terminal
    // and states its own outcome.
    if (!drop && item?.id) {
      (this._hungTurnAlerts ||= new Map()).set(item.id, { source: src, mins, at: Date.now() });
    } else if (item?.id) {
      this._hungTurnAlerts?.delete(item.id);
    }
    // The dead-lettered retry gets the same ✅ when it finishes.
    if (dl?.retryItem) (this._hungTurnAlerts ||= new Map()).set(dl.retryItem.id, { source: src, mins, at: Date.now() });
    try { this.session?.child?.kill("SIGKILL"); } catch {}
  }

  // After a drop (see dead-letter.mjs): one dead-letter row for
  // every dropped item; for the user's own request also one chat note and, once,
  // a fresh retry at the tail of the queue. Returns { retryItem } (null if none).
  _deadLetter(item, { src, mins, hangCount, reason }) {
    let own = item.ownRequest || null;
    if (!own) { try { own = ownRequestFor(item); } catch {} }
    const since = item.firstEnqueuedAt || item.enqueuedAt || Date.now();
    // replied | not-replied | unknown; only a definite answer reaches them.
    let sent = { state: "unknown", rows: [] };
    if (own) { try { sent = sentSince(since, own.rfcMessageId); } catch {} }
    const replyState = sent.state;
    const plan = planForDrop(item, own, { replyState });
    let retryItem = null;
    if (plan.retry && this.dispatcher) {
      let jobs = [];
      try { jobs = jobsSince(since); } catch {}
      retryItem = buildRetryItem(item, { own, sent: sent.rows, replyState, jobs, noticeQueued: plan.notice === "first" });
      // Straight onto the tail, not dispatch(): inFlight was just cleared and
      // the child is about to be SIGKILLed, so dispatch()'s _drain would hand
      // the retry to the dying session. exit → restart() carries the queue,
      // retry included, to the fresh session, which reaches it after the work
      // already queued. persist() keeps it across a whole-process restart.
      this.dispatcher.queue.push(retryItem);
      this.dispatcher.persist();
    }
    const action = retryItem ? "retry-queued" : "dropped";
    appendDeadLetter({
      ts: new Date().toISOString(), agent: this.args.agent, action, source: src, itemId: item.id,
      hangCount, reason, hungMins: mins, hangRetry: !!item.hangRetry, retryOf: item.retryOf || null,
      ownRequest: own, replyState: own ? replyState : null, retryItemId: retryItem?.id || null,
      item: { id: item.id, source: item.source, enqueuedAt: item.enqueuedAt, content: item.content },
    });
    this.eventLog.append({ kind: "turn_watchdog.dead_letter", source: src, itemId: item.id, action, hangRetry: !!item.hangRetry, retryOf: item.retryOf || null, ownRequest: !!own, replyState: own ? replyState : null, notice: plan.notice, retryItemId: retryItem?.id || null });
    if (retryItem) {
      this.eventLog.append({ kind: "turn_watchdog.retry_enqueued", item: retryItem });
      this._checkQueueAlarm();
    }
    // "first" promises a retry, so it goes out only if one was really queued.
    if (plan.notice === "final" || (plan.notice === "first" && retryItem)) this._sendChatNotice(stuckNotice(plan.notice, own, { replyState }), { intent: "stuck-request" });
    return { retryItem };
  }

  // Counterpart to the hang page in _onTurnHang: the killed item was requeued
  // onto a fresh session, and this is where we learn it finished. Emits the ✅
  // that the ⚠️ promised and nothing was sending.
  //
  // Entries are pruned on a 6h horizon because not every remembered item comes
  // back — an item that hangs a second time is DROPPED (its own ⚠️ is terminal
  // and deletes the entry), and a supervisor restart loses the map entirely.
  // Both are fine: a missing ✅ costs nothing, and the map must not grow.
  _clearHungTurnAlert(info) {
    const map = this._hungTurnAlerts;
    if (!map?.size) return;
    const HORIZON_MS = 6 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, rec] of map) if (now - rec.at > HORIZON_MS) map.delete(id);
    const id = info?.message?.id;
    if (!id) return;
    const rec = map.get(id);
    if (!rec) return;
    map.delete(id);
    const secs = Math.round((info?.result?.duration_ms ?? 0) / 1000);
    const turns = info?.result?.num_turns ?? 0;
    this.eventLog.append({ kind: "turn_watchdog.recovered", source: rec.source, itemId: id, hungMins: rec.mins, retryMs: info?.result?.duration_ms, retryTurns: info?.result?.num_turns });
    // A retry that returns zero turns did no work — that is what the
    // compact-race guard exists for — so the ✅ must not claim the job ran.
    this._sendPush(turns > 0
      ? `✅ Recovered: the ${rec.source} turn that hung for ${rec.mins}min finished on the retry (${turns} turns, ${secs}s). Nothing was lost — the job ran.`
      : `⚠️ The ${rec.source} turn that hung for ${rec.mins}min came back from the retry without doing any work (0 turns, ${secs}s) — that job has not run today.`);
  }

  // Called on enqueue (depth may cross HIGH) and on turn_complete (depth may
  // drain below CLEAR). The QueueAlarm owns the hysteresis + fires the notifiers.
  _checkQueueAlarm() {
    this.queueAlarm.check(this.dispatcher?.queue?.length || 0);
  }

  // geo-gate-ok: this is the supervisor's infrastructure-alert path (auth
  // outage, queue alarm, crash-loop recovery). It never recommends an event —
  // the only reason this file could trip the event-word heuristic is event-ish
  // words in comments and routing tables. An auth-outage alert must reach the user in whatever city they are in.
  //
  // Every alert below must name `this.args.agent`. This file is spawned once
  // per agent (ops / ops-light / ops-haiku / chat), so a message that says
  // "Edva ops" or "Ops turn" is wrong for three of the four supervisors —
  // and since 2026-07 the system channel's text is an input to
  // system-issue-review's clustering, a misattributed emitter root-causes to
  // the wrong process. Observed 2026-08-26T22:01Z: three identical
  // "✅ Edva back up: Max auth restored — resuming." pings 6s apart
  // with nothing to tell them apart.
  // push=true: the alert needs the user to act, so it notifies even though it is
  // not 🔴 — every other system row is written silently (edva-send-curl §
  // System-channel push policy).
  _sendPush(text, { push = false } = {}) {
    try {
      const bin = installTools("bin/edva-send-curl");
      // --skip-precheck: supervisor alerts (auth outages, queue alarms) must
      // bypass the Sonnet-gated outbound precheck. The precheck depends on
      // the agents being up to dispatch; gating supervisor self-alerts
      // through it is the wrong direction — a stuck supervisor would silence
      // its own alert. See system/architecture.md § Outbound Precheck.
      // EDVA_INFRA_PROBE=1 — the supervisor reports on its OWN process state
      // (auth outage, queue alarm, crash-loop) from outside the agent sandbox,
      // so it is an authorized author of machine-health pages. See the
      // fabricated-outage gate in bin/edva-send-curl.
      const p = spawnProc(bin, ["--suppress-hook", "--skip-precheck", "--intent", "supervisor-alert", "--channel", "system", ...(push ? ["--push"] : []), text], { stdio: "ignore", detached: true, env: { ...process.env, EDVA_INFRA_PROBE: "1" } });
      p.unref();
    } catch (err) {
      console.error(`[supervisor] _sendPush failed: ${err.message}`);
    }
  }

  // The supervisor's one send to the user's MAIN chat: the note that a request
  // of theirs got stuck (_deadLetter). It is not an infra alert, so it takes the
  // path every content send takes: default chat channel, outbound precheck ON
  // (no --skip-precheck), and EDVA_INFRA_PROBE / EDVA_PRECHECK_BYPASS
  // stripped in case this process inherited them. The precheck may hold it
  // back; its decision lands in data/outbound-precheck-log.jsonl.
  // geo-gate-ok: never about an event, only about a stuck request of theirs.
  _sendChatNotice(text, { intent }) {
    try {
      const bin = installTools("bin/edva-send-curl");
      const env = { ...process.env };
      delete env.EDVA_INFRA_PROBE;
      delete env.EDVA_PRECHECK_BYPASS;
      const p = spawnProc(bin, ["--intent", intent, "--evidence-as-of", "live", "--agent", "ops", text], { stdio: "ignore", detached: true, env });
      p.unref();
    } catch (err) {
      console.error(`[supervisor] _sendChatNotice failed: ${err.message}`);
    }
  }

  _triggerAuthOutage() {
    this.authAlertSent = true;
    if (this.dispatcher) this.dispatcher.setPaused(true);
    console.error(`[supervisor] AUTH OUTAGE: pausing dispatcher, alerting, and starting creds watcher`);
    // Quote the actual captured error instead of always asserting a locked
    // keychain — that was one real cause (2026-06-17, a CI signing job renamed
    // login.keychain-db) but AUTH_ERROR_RE also matches "Failed to authenticate"
    // / "authentication_error" (expired/invalid creds, no keychain issue at all),
    // which the old fixed wording misdiagnosed every time it fired.
    const errText = this.lastAuthError ? `Captured error: "${this.lastAuthError}". ` : "";
    this._sendPush(`⚠️ Edva down: Max auth broken on ${HOST_LABEL} for the ${this.args.agent} supervisor (no valid login). ${errText}If it mentions a keychain, check \`security default-keychain\` + \`security list-keychains\` and restore login.keychain-db if renamed; otherwise it's likely just expired/invalid creds. Either way: \`claude /login\`. See changelog.md 2026-06-17.`, { push: true });
    this._startAuthWatcher();
    // Kill the current child so it stops burning through the queue on 401s.
    try { this.session?.child?.kill("SIGKILL"); } catch {}
  }

  // One-shot auth probe: spawn a throwaway `claude -p` (cheap haiku turn) with
  // the same Max-only env (ANTHROPIC_API_KEY stripped) and report whether it
  // authenticated. Auth-store-agnostic — works whether Max creds live in
  // ~/.claude/.credentials.json OR the macOS login keychain (the 2026-06-17
  // outage had NO creds file; auth was keychain-only, so the old mtime watcher
  // could never detect recovery and the dispatcher would stay paused forever).
  _authProbe() {
    return new Promise((resolve) => {
      const claudeBin = this.args.claudeBin || process.env.CLAUDE_BIN || path.join(HOME, ".local/bin/claude");
      const [bin, ...prefix] = Array.isArray(claudeBin) ? claudeBin : [claudeBin];
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; // mirror the Max-only auth invariant
      let out = "";
      let done = false;
      let child;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child?.kill("SIGKILL"); } catch {}
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 30_000);
      try {
        child = spawnProc(bin, [...prefix, "-p", "reply with the single word OK", "--model", "haiku"], {
          env, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch { return finish(false); }
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("exit", () => finish(out.length > 0 && !AUTH_ERROR_RE.test(out)));
      child.on("error", () => finish(false));
    });
  }

  _startAuthWatcher() {
    if (this.authWatcher) return;
    const credsPath = path.join(HOME, ".claude/.credentials.json");
    let baselineMtime = 0;
    try { baselineMtime = fs.statSync(credsPath).mtimeMs; } catch {}
    let probing = false;
    this.authWatcher = setInterval(async () => {
      // Fast path: file-based creds were rewritten (cheap stat).
      let authBack = false;
      try { authBack = fs.statSync(credsPath).mtimeMs > baselineMtime; } catch {}
      // Robust path: actively probe (covers keychain-stored creds, no file).
      if (!authBack && !probing) {
        probing = true;
        try { authBack = await this._authProbe(); } finally { probing = false; }
      }
      if (authBack) {
        console.error(`[supervisor] auth restored — rotating session and resuming dispatcher`);
        clearInterval(this.authWatcher);
        this.authWatcher = null;
        this.authErrorCount = 0;
        this.authAlertSent = false;
        this._sendPush(`✅ Edva back up: Max auth restored on ${HOST_LABEL} — ${this.args.agent} is resuming.`);
        if (this.dispatcher) this.dispatcher.setPaused(false);
        // Force a clean session so the new creds are used from a fresh state.
        this.state.data.everInitialized = false;
        this.state.rotateSession();
        this._resetContextTracking();
        this.restart().catch((e) => console.error(`[supervisor] post-auth restart failed: ${e.message}`));
      }
    }, 60_000);
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
  async fireStartupCatchup() {
    // Start the periodic-catchup timer immediately regardless of the
    // (now-async) catchupMessage() outcome below, so a slow/failed prefetch
    // never delays push-failure detection.
    this.gmailSource.startCatchupTimer();

    const content = await this.gmailSource.catchupMessage();
    if (!content) {
      console.error(`[supervisor] no last-history — skipping startup catchup`);
      return;
    }
    // Delay a few seconds so MCP servers finish wiring up.
    setTimeout(() => {
      console.error(`[supervisor] dispatching startup catchup`);
      this.dispatcher.dispatch(content, "startup-catchup");
    }, 5000);
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
      totalDispatches: s.totalDispatches || 0,
      maxSessionTurns: this.maxSessionTurns,
      contextTokens: this.contextTokens,
      restartCount: this.restartCount,
      consecutiveZeroTurns: this.consecutiveZeroTurns,
      consecutiveNoOpTurns: this.consecutiveNoOpTurns,
      queueDepth: this.dispatcher?.snapshot().queueDepth ?? 0,
      inFlight: this.dispatcher?.snapshot().inFlight ?? null,
      completed: this.dispatcher?.snapshot().completed ?? 0,
      childAlive: !!(this.session?.child && this.session.child.exitCode === null && this.session.child.signalCode === null),
      // A quota hold counts as paused: hum and the watchdog's backlog check
      // already treat a paused supervisor as "deliberately not draining".
      dispatcherPaused: !!this.dispatcher?.paused || !!this.dispatcher?.isHeld(),
      rateLimitHoldUntil: this.dispatcher?.isHeld() ? new Date(this.dispatcher.holdUntil).toISOString() : null,
      queueAlarmActive: this.queueAlarm.active,
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

  async restart({ skipBackoff = false } = {}) {
    if (this.restarting) return;
    this.restarting = true;
    this.restartCount++;

    // Resume-target-missing breaker (root-caused 2026-07-16, moved ahead of the
    // backoff 2026-07-20). A `--resume <id>` for a session claude never
    // persisted exits code=1 / zero-turn with "No conversation found with
    // session ID: <id>" AFTER the first dispatch (claude -p is lazy — it
    // doesn't validate the resume target until then, so claude-session's
    // within-500ms --resume→fresh fallback can't catch it).
    // Left alone this loops: the failing child never emits init, so
    // markInitialized() never clears everInitialized, canResume stays true, and
    // the SAME missing id is re-resumed on every restart until the 3-strike
    // crash-loop breaker below finally forces a fresh session. Drop
    // resumability so the fresh-start path below rotates to a NEW id spawned
    // with --session-id (which CREATES it) — recovering on the first strike.
    //
    // This is a KNOWN-RECOVERABLE condition, not a crash, so it must be handled
    // BEFORE the exponential backoff rather than after it. restartCount is
    // never reset on success, so on a long-lived supervisor the backoff is
    // pinned at its 60s ceiling — every resume-miss was buying a full minute of
    // dead air to recover from a fault already diagnosed. Un-count the restart
    // too, so a benign resume-miss can't inflate the backoff for the next
    // genuine crash.
    if (this.session?.sessionNotFound) {
      console.error(`[supervisor] resume target not found (session never persisted) — immediate fresh session, no backoff`);
      this.state.data.everInitialized = false;
      this.consecutiveZeroTurns = 0;
      this.restartCount--;
      skipBackoff = true;
    }

    // Exponential backoff: 2s, 4s, 8s, ..., max 60s. Skipped for intentional
    // rotations (turn-count) — those are healthy restarts, not crash recovery,
    // and shouldn't inherit the crash-loop backoff that grows with restartCount.
    if (!skipBackoff) {
      const delay = Math.min(2000 * Math.pow(2, Math.min(this.restartCount - 1, 5)), 60000);
      console.error(`[supervisor] restart #${this.restartCount} (backoff ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      await this.session.stop();
    } catch {}

    // Crash-loop breaker: after a few consecutive zero-turn exits the session
    // is wedged, and restarting the SAME session just burns the exponential
    // backoff (pinned at 60s after ~6 restarts). Escalate to a fresh session
    // fast. Lowered 5→3 on 2026-06-28: that morning a
    // zero-turning child was restarted ~20× over ~14min before a rotation
    // finally took, delaying the nightly review ~4h. Alert the system channel
    // the first time a rotation fires in a burst so a recurrence is visible
    // immediately instead of found hours later (root cause — likely an MCP
    // server stalling during init — still wants a focused look at the spawn path).
    const CRASH_LOOP_THRESHOLD = 3;
    if (this.consecutiveZeroTurns >= CRASH_LOOP_THRESHOLD) {
      console.error(`[supervisor] CRASH LOOP DETECTED: ${this.consecutiveZeroTurns} consecutive zero-turn exits — rotating to fresh session`);
      if (!this.crashLoopAlerted) {
        this._sendPush(`⚠️ Edva ${this.args.agent} crash-loop: ${this.consecutiveZeroTurns} consecutive zero-turn child exits — rotated to a fresh session. If the review/digests look late, check the spawn path + MCP init.`);
        this.crashLoopAlerted = true;
      }
      this.state.data.everInitialized = false;
      this.state.rotateSession();
      this._resetContextTracking();
      this.consecutiveZeroTurns = 0;
    }

    // Only --resume if the session was ever initialized successfully AND the
    // CLI actually has a transcript for it on disk. claude -p is lazy — it
    // doesn't validate --resume until the first dispatch, so a bad target costs
    // a full spawn plus a dead zero-turn dispatch before we find out. Defense
    // in depth behind the stale-ready guard in startSession(): this also covers
    // a cold start from a state.json whose transcript was reaped by retention.
    let shouldResume = this.state.canResume;
    if (shouldResume && !this._sessionPersisted(this.state.sessionId)) {
      console.error(`[supervisor] no on-disk transcript for ${this.state.sessionId} — starting fresh (no --resume)`);
      this.state.data.everInitialized = false;
      shouldResume = false;
    }
    if (!shouldResume) {
      console.error(`[supervisor] session never initialized — starting fresh (no --resume)`);
      this.state.rotateSession();
      this._resetContextTracking();
    }
    await this.startSession({ resume: shouldResume });
    this.restarting = false;
  }

  // True if the CLI has a transcript on disk for `id` — i.e. `--resume id` can
  // actually work. Transcripts live at ~/.claude/projects/<cwd-slug>/<id>.jsonl
  // where <cwd-slug> is the realpath'd agent cwd with "/" and "." replaced by "-".
  // Fails OPEN (returns true) when the projects dir can't be located, so an
  // unexpected CLI layout can never wrongly force a fresh session.
  _sessionPersisted(id) {
    try {
      const cwd = fs.realpathSync(path.join(EDVA_ROOT, this.cfg.cwd));
      const dir = path.join(HOME, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
      if (!fs.existsSync(dir)) return true;
      return fs.existsSync(path.join(dir, `${id}.jsonl`));
    } catch { return true; }
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
        this._prepareHandoff(`hard rotation, age ${hrs}h`);
        this.state.data.everInitialized = false;
        this.state.rotateSession();
        this._resetContextTracking();
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
      if (this.hasLiveBackgroundTasks()) {
        console.error(`[supervisor] rotation deferred — ${this.liveBackgroundTasks.size} background task(s) still in flight`);
        return;
      }
      if (this.restarting) return;
      const oldId = this.state.sessionId;
      const oldTurns = this.state.data.totalTurns;
      const oldCost = this.state.data.totalCostUsd;
      this._prepareHandoff("daily age rotation");
      this.state.data.everInitialized = false;
      this.state.rotateSession();
      this._resetContextTracking();
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

  // True if any run_in_background Bash task is still presumed live. Opportunistically
  // drops entries older than BACKGROUND_TASK_MAX_AGE_MS so a missed/dropped
  // completion notification can't block rotation forever.
  hasLiveBackgroundTasks() {
    if (this.liveBackgroundTasks.size === 0) return false;
    const now = Date.now();
    for (const [id, startedAt] of this.liveBackgroundTasks) {
      if (now - startedAt > BACKGROUND_TASK_MAX_AGE_MS) {
        console.error(`[supervisor] background task ${id} exceeded ${BACKGROUND_TASK_MAX_AGE_MS / 60000}min with no notification — treating as stale, no longer gating rotation`);
        this.liveBackgroundTasks.delete(id);
      }
    }
    return this.liveBackgroundTasks.size > 0;
  }

  // --- Context-size guard ---
  // Keep the session's context small so cold-cache turns don't re-bill a huge
  // prefix (and, on Sonnet's 200k window, so it never auto-escalates to the
  // usage-credits-gated 1M context). Prefer /compact (continuity-preserving,
  // session id survives); hard-rotate only as a last resort. Runs only when the
  // dispatcher is idle so a compact never lands mid-turn or ahead of real work.
  startContextGuard() {
    if (this.contextGuardTimer) return;
    this.contextGuardTimer = setInterval(() => {
      if (this.restarting) return;
      if (this.dispatcher?.inFlight) return;                  // mid-turn — wait
      if ((this.dispatcher?.queue?.length || 0) > 0) return;  // work queued — wait
      // Quota hold: nothing can run, and a /compact queued now would become
      // the post-hold probe — a turn that proves nothing about the limit.
      if (this.dispatcher?.isHeld()) return;
      const ctx = this.contextTokens;
      // Idle past the prompt-cache TTL: the next dispatch would re-write this
      // whole conversation cold, so start it fresh instead (context-guard.mjs
      // § IDLE-COLD ROTATION). Checked first: a compact or a parked dead-zone
      // session that has gone cold is cheaper rotated too.
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleColdRotate(ctx, this.sessionFloorTokens, idleMs)) {
        if (this.hasLiveBackgroundTasks()) return;
        const idleFloor = this.sessionFloorTokens;
        const idleMin = Math.round(idleMs / 60_000);
        console.error(`[supervisor] CONTEXT GUARD: idle ${idleMin}m (cache expired) with ${ctx - idleFloor} tokens above the ${idleFloor}-token floor — rotating so the next dispatch writes only the prefix`);
        this._rotateForContext(`idle-cold ctx=${ctx} floor=${idleFloor} idle=${idleMin}m`);
        return;
      }
      const decision = contextGuardDecision(ctx, this.sessionFloorTokens, { allowCompact: this.compactOnContext });
      if (decision === "none") return;
      if (decision === "rotate") {
        // Below the rotate threshold this is a cron-only tier rotating where
        // ops would compact (compactOnContext:false — see context-guard.mjs).
        const inPlaceOfCompact = ctx < CONTEXT_ROTATE_THRESHOLD_TOKENS;
        if (this.hasLiveBackgroundTasks()) {
          console.error(`[supervisor] CONTEXT GUARD: ctx=${ctx} but deferring rotate — ${this.liveBackgroundTasks.size} background task(s) still in flight`);
          return;
        }
        console.error(inPlaceOfCompact
          ? `[supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CONTEXT_COMPACT_THRESHOLD_TOKENS} — rotating instead of /compact (compactOnContext=false)`
          : `[supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CONTEXT_ROTATE_THRESHOLD_TOKENS} — hard rotate (compact insufficient)`);
        this._rotateForContext(inPlaceOfCompact ? `ctx=${ctx} no-compact tier` : `ctx=${ctx}`);
        return;
      }

      const floor = this.sessionFloorTokens;
      const compactable = floor > 0 ? ctx - floor : ctx;

      // Only the conversation above the floor is compactable. If there is
      // barely any, a /compact buys nothing and costs a cache invalidation —
      // skip it and let the rotate threshold handle the session instead.
      // Logged (not silent) so the review job can count these: a rising
      // skip count alongside a rising rotate count means the floor has grown
      // past the point where compacting can help at all.
      if (decision === "skip-compact") {
        this.eventLog.append({
          kind: "context_guard.compact_skipped",
          contextTokens: ctx,
          floorTokens: floor,
          compactableTokens: compactable,
          reason: "below-min-compactable",
        });
        console.error(`[supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CONTEXT_COMPACT_THRESHOLD_TOKENS} but only ${compactable} tokens sit above the ${floor}-token floor (<${MIN_COMPACTABLE_TOKENS}) — skipping /compact, it would just invalidate the cache. Cut the floor instead (see cost-efficiency-review).`);
        return;
      }

      if (decision === "compact" && Date.now() - this.lastCompactAt > COMPACT_COOLDOWN_MS) {
        this.lastCompactAt = Date.now();
        console.error(`[supervisor] CONTEXT GUARD: ctx=${ctx} ≥ ${CONTEXT_COMPACT_THRESHOLD_TOKENS} (floor=${floor}, compactable=${compactable}) — injecting /compact`);
        this.eventLog.append({ kind: "context_guard.compact", contextTokens: ctx, floorTokens: floor, compactableTokens: compactable });
        this.dispatcher.dispatch("/compact", "context-guard");
      }
    }, CONTEXT_GUARD_INTERVAL_MS);
    this.contextGuardTimer.unref?.();
    console.error(`[supervisor] context guard on (compact@${CONTEXT_COMPACT_THRESHOLD_TOKENS} / rotate@${CONTEXT_ROTATE_THRESHOLD_TOKENS} / every ${CONTEXT_GUARD_INTERVAL_MS / 1000}s)`);
  }

  stopContextGuard() {
    if (this.contextGuardTimer) { clearInterval(this.contextGuardTimer); this.contextGuardTimer = null; }
  }

  // Every rotation path hands off to a brand-new, uninitialized child —
  // state.rotateSession() mints a fresh session id with zero real turns, so
  // the new child's actual context is 0 no matter what the outgoing
  // session's contextTokens was. Previously only _rotateForContext() reset
  // contextTokens/lastCompactAt on rotation; every other rotation path
  // (turn-count cap, daily/hard age, crash-loop, auth-restore, --resume
  // failure, manual /rotate) left the stale pre-rotation value in place.
  // startContextGuard()'s 90s tick then read that stale number against the
  // NEW child and could fire /compact as literally the first message the
  // fresh session ever received — before its own init handshake completed —
  // which hung indefinitely with nothing to stop it except the external
  // 10-min turn watchdog. Root-caused 2026-08-02: a turn-count rotation left
  // contextTokens=162455 in place, the guard fired /compact 7s into the new
  // child's life, and the item hung twice (10min + 10min) and was dropped
  // (agent/logs/ops-supervisor.log + supervisor-ops/events.ndjson,
  // 07:21:54–07:42:10). Call this immediately after every
  // state.rotateSession() so a freshly-spawned child always starts the
  // guard's math at zero.
  _resetContextTracking() {
    this.contextTokens = 0;
    this.lastCompactAt = 0;
    // A fresh session re-measures its own floor on the first usage-bearing
    // call. Zeroing here means the compact guard falls back to the plain
    // threshold check until that measurement lands, rather than judging the
    // new child against the outgoing session's floor.
    this.sessionFloorTokens = 0;
    this.floorSessionId = null;
  }

  // Hard rotation triggered by context size (compact couldn't bring it down).
  // Healthy path → captures a handoff digest first so the fresh session isn't
  // amnesiac. skipBackoff: this is an intentional rotation, not crash recovery.
  _rotateForContext(reason) {
    if (this.restarting) return;
    const oldId = this.state.sessionId;
    this._prepareHandoff(`context-rotate: ${reason}`);
    this.state.data.everInitialized = false;
    this.state.rotateSession();
    this._resetContextTracking();
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    this.eventLog.append({ kind: "context_guard.rotate", reason });
    console.error(`[supervisor] CONTEXT ROTATION (${reason}): ${oldId} → ${this.state.sessionId}`);
    this.restart({ skipBackoff: true }).catch((e) => console.error(`[supervisor] context rotation restart failed: ${e.message}`));
  }

  // --- Session-handoff digest ---
  // Build (synchronously, in code) a digest of the OUTGOING session and stage
  // it for the fresh one. MUST be called BEFORE rotateSession() so it captures
  // the current session id + dispatch count. Only the healthy rotation paths
  // call this — crash-loop/auth restarts skip it. Persisted to
  // handoff-digest.json for observability and recall.
  _prepareHandoff(reason) {
    this.pendingHandoff = null;
    if (HANDOFF_DISABLED) return;
    try {
      const digest = buildHandoffDigest({
        agent: this.args.agent,
        eventsPath: this.eventLog.eventsPath,
        fromSessionId: this.state.sessionId,
        fromDispatches: this.state.dispatches,
        reason,
      });
      if (!digest) return;
      this.pendingHandoff = digest;
      try {
        writeFileAtomic(path.join(this.dataDir, "handoff-digest.json"), JSON.stringify(digest, null, 2));
      } catch {}
    } catch (e) {
      console.error(`[supervisor] _prepareHandoff error: ${e.message}`);
      this.pendingHandoff = null;
    }
  }

  // Called from the dispatcher preamble for each real (non-control) dispatch.
  // Returns the staged handoff block exactly once, then clears it. The read-only
  // framing lives in formatHandoffBlock: 2026-08-06 measured 70 of 357 handoff
  // turns acting on a digest of COMPLETED work when the note allowed it, so the
  // block gives the turn nothing to act on beyond the task it precedes.
  _takeHandoffBlock(item) {
    const digest = this.pendingHandoff;
    if (!digest) return "";
    this.pendingHandoff = null;
    const block = formatHandoffBlock(digest);
    if (!block) return "";
    this.eventLog.append({
      kind: "session_handoff.injected",
      fromSessionId: digest.fromSessionId,
      reason: digest.reason,
      model: digest.model,
      chars: block.length,
      intoSource: item?.source || null,
      intoId: item?.id || null,
    });
    console.error(`[supervisor] session-handoff digest prepended to ${item?.source || "?"} (${block.length} chars)`);
    return block;
  }

  // Record which dispatch launched a background task/async subagent, so a
  // wake turn its completion causes can be charged back to that job.
  _recordBackgroundOwner(taskId) {
    const owner = this.dispatcher?.inFlight?.source;
    if (!owner) return;
    this.backgroundTaskOwners.set(taskId, owner);
    // Bounded: entries normally clear on their notification; a dropped one
    // must not grow the map forever.
    if (this.backgroundTaskOwners.size > 200) {
      const oldest = this.backgroundTaskOwners.keys().next().value;
      this.backgroundTaskOwners.delete(oldest);
    }
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
    this._prepareHandoff("manual rotation");
    this.state.data.everInitialized = false;
    this.state.rotateSession();
    this._resetContextTracking();
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    console.error(`[supervisor] MANUAL ROTATION: ${oldId} → ${this.state.sessionId} (was ${oldTurns} turns, $${oldCost.toFixed(2)})`);
    this.restart().catch((e) => console.error(`[supervisor] rotation restart failed: ${e.message}`));
    return { rotated: true, oldSessionId: oldId, newSessionId: this.state.sessionId };
  }

  // Turn-count rotation — called from the turn_complete handler. Unlike
  // rotateIfIdle()/the age timer, this rotates even when the queue is non-empty
  // (the dispatcher-busy defer is exactly what let the 2026-05-31 session grow
  // to 352 turns). Safe because it runs at a turn boundary: inFlight is already
  // cleared, so no turn is interrupted. Returns true if it rotated.
  //
  // The cap counts DISPATCHES (state.dispatches), not num_turns. It used to
  // compare against totalTurns — the tool steps summed across dispatches — so
  // a single 20-step job exhausted ops-haiku's cap of 20 and the tiers rotated
  // every ~4.5 dispatches: 465 of 704 rotations over the 14d to 2026-10-04
  // were "turn-count cap 20", each paying a cold floor write. The context
  // guard bounds context size; this cap only bounds session age in dispatches.
  _maybeRotateForTurnCount() {
    if (!this.maxSessionTurns || this.maxSessionTurns <= 0) return false;
    if (this.restarting) return false;
    if (this.state.dispatches < this.maxSessionTurns) return false;
    const oldId = this.state.sessionId;
    const oldTurns = this.state.data.totalTurns;
    const oldDispatches = this.state.dispatches;
    const oldCost = this.state.data.totalCostUsd;
    // Block the imminent _drain() (runs synchronously right after this handler)
    // so the next queued item isn't written to the child we're about to replace.
    if (this.dispatcher) this.dispatcher.setPaused(true);
    this._prepareHandoff(`dispatch cap ${this.maxSessionTurns}`);
    this.state.data.everInitialized = false;
    this.state.rotateSession();
    this._resetContextTracking();
    this.consecutiveZeroTurns = 0;
    this.consecutiveNoOpTurns = 0;
    console.error(`[supervisor] TURN-COUNT ROTATION: ${oldId} → ${this.state.sessionId} (was ${oldDispatches} dispatches / ${oldTurns} tool turns, $${oldCost.toFixed(2)} — dispatch cap ${this.maxSessionTurns})`);
    this.restart({ skipBackoff: true }).catch((e) => console.error(`[supervisor] turn-count rotation restart failed: ${e.message}`));
    return true;
  }

  async shutdown() {
    console.error("[supervisor] shutting down");
    this.stopRotationTimer();
    this.stopContextGuard();
    this.stopClaudeMdWatcher();
    this.stopLocalWatchers();
    this.gmailSource.stopCatchupTimer();
    this.turnWatchdog.clear();
    if (this.authWatcher) { clearInterval(this.authWatcher); this.authWatcher = null; }
    try { await this.http?.close(); } catch {}
    try { await this.session?.stop(); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(EDVA_ROOT, "agent/config/agents.json");
  const agentCfg = loadAgentConfig(configPath, args.agent);
  const dataDir = args.stateDir || path.join(EDVA_ROOT, `agent/supervisor/state/${args.agent}`);
  const eventDir = path.join(EDVA_ROOT, `agent/logs/supervisor-${args.agent}`);
  const triageLog = await importTriageLog();

  const supervisor = new Supervisor({ args, agentCfg, dataDir, eventDir, triageLog });

  let shouldResume = args.resume && supervisor.state.canResume;
  // Cold-start guard: never resume a session that already exceeded the turn
  // cap. A kill (watchdog/OOM/launchd) before the in-process turn-count
  // rotation fired would otherwise resurrect the bloated, expensive session on
  // the next boot. Mint a fresh one instead.
  if (shouldResume && supervisor.maxSessionTurns > 0 && supervisor.state.dispatches >= supervisor.maxSessionTurns) {
    console.error(`[supervisor] persisted session has ${supervisor.state.dispatches} dispatches (>= cap ${supervisor.maxSessionTurns}) — starting fresh instead of resuming`);
    supervisor.state.data.everInitialized = false;
    supervisor.state.rotateSession();
    supervisor._resetContextTracking();
    shouldResume = false;
  }
  console.error(`[supervisor] starting agent=${args.agent} model=${args.model || agentCfg.model} session=${supervisor.state.sessionId} resume=${shouldResume}`);
  await supervisor.startSession({ resume: shouldResume });
  await supervisor.startHttp();
  // Gmail push + startup-catchup are single-instance, on the ops agent only.
  // An agent without a gmailPubsubPort (e.g. ops-light) skips the gmail
  // catchup dispatch and its periodic push-failure timer entirely; it only
  // serves the webhook + control ports.
  if (agentCfg.supervisor?.gmailPubsubPort) {
    // Per-message triage dispatches go to the ops-light tier (triage-route.mjs,
    // agents.json ops.gmailTriageTarget; "ops" = rollback). Falls back to this
    // supervisor's own dispatcher whenever ops-light is unhealthy.
    try {
      const target = triageTargetFromConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), { selfAgent: args.agent });
      if (target) {
        supervisor.gmailSource._triageDispatchFn = makeTriageRouter({
          target,
          localDispatch: (content, source) => supervisor.dispatcher.dispatch(content, source),
          tokenFile: path.join(EDVA_ROOT, "secrets/webhook-token"),
          log: (line) => { try { triageLog(line); } catch {} },
        });
        console.error(`[supervisor] gmail per-message triage → ${target.agent} (:${target.webhookPort}), fallback ${args.agent}`);
      }
    } catch (err) {
      console.error(`[supervisor] triage-route wiring failed (${err.message}) — triage stays on ${args.agent}`);
    }
    supervisor.fireStartupCatchup().catch(err => console.error(`[supervisor] fireStartupCatchup failed: ${err.message}`));
  } else {
    console.error(`[supervisor] agent=${args.agent} has no gmailPubsubPort — gmail catchup disabled (webhook-only)`);
  }
  supervisor.startRotationTimer();
  supervisor.startContextGuard();
  supervisor.watchClaudeMd();
  supervisor.startLocalWatchers();

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
