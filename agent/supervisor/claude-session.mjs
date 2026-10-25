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

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";

const { instance } = createRequire(import.meta.url)("../../lib/instance.cjs");

const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;

// Does the installed claude CLI accept `flag`? Probed once per (bin, flag) from
// `claude --help`. Used to gate newer optional flags so a stale CLI on the host
// degrades to "flag not passed" instead of an unknown-option exit loop.
const _flagSupport = new Map();
export function supportsCliFlag(flag, { claudeBin = DEFAULT_CLAUDE, spawnSyncFn = spawnSync } = {}) {
  const [bin, ...prefix] = Array.isArray(claudeBin) ? claudeBin : [claudeBin];
  const key = `${[bin, ...prefix].join(" ")}\u0000${flag}`;
  if (_flagSupport.has(key)) return _flagSupport.get(key);
  let ok = false;
  try {
    const r = spawnSyncFn(bin, [...prefix, "--help"], { encoding: "utf8", timeout: 15000 });
    ok = r && r.status === 0 && String(r.stdout || "").includes(flag);
  } catch { ok = false; }
  _flagSupport.set(key, ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Local agent rules (agent/local/).
//
// The kernel rulebooks (agent/CLAUDE.md + <agent>/CLAUDE.md) are generic.
// An instance's own rules — its people, places, accounts, standing decisions —
// live in agent/local/: shared.md for every agent, plus chat.md or ops.md
// for that role. CLAUDE.md @imports cannot reach them (claude loads imports
// only from inside the agent's cwd), so the supervisor joins them into ONE file
// at session start and passes it with --append-system-prompt-file.
//
// Prompt caching: the file lives at a stable path under the agent's state dir
// and is rewritten only when its content changes, so the system prompt is
// byte-identical from one session to the next until a local rule is edited.

export const LOCAL_RULES_FILE = "local-rules.md";

/**
 * The joined local rules for `role` ("chat" | "ops"; "shared" = shared.md
 * alone), or "" when there are none.
 */
export function readLocalRules({ localDir, role }) {
  const parts = [];
  for (const name of role === "shared" ? ["shared.md"] : ["shared.md", `${role}.md`]) {
    let t;
    try { t = fs.readFileSync(path.join(localDir, name), "utf8"); } catch { continue; }
    if (t.trim()) parts.push(t.trimEnd() + "\n");
  }
  return parts.join("\n");
}

/**
 * Build `<stateDir>/local-rules.md` from localDir/shared.md + localDir/<role>.md
 * (missing files skipped). Returns { path, content } — path is null when there
 * are no local rules, and then no file is left behind.
 */
export function buildLocalRulesFile({ localDir, role, stateDir }) {
  const outPath = path.join(stateDir, LOCAL_RULES_FILE);
  const content = readLocalRules({ localDir, role });
  if (!content) {
    try { fs.unlinkSync(outPath); } catch {}
    return { path: null, content: "" };
  }
  let cur = null;
  try { cur = fs.readFileSync(outPath, "utf8"); } catch {}
  if (cur !== content) {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${outPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, outPath);
  }
  return { path: outPath, content };
}

/**
 * Which local rules a `claude -p` started in `cwd` should get: the role whose
 * CLAUDE.md hierarchy that cwd loads. "chat" (chat-agent), "ops" (an ops-*
 * agent dir), "shared" (elsewhere under agent, which loads only
 * agent/CLAUDE.md), or null outside `<root>/tools/agent` (no Edva
 * CLAUDE.md is loaded there, so no local rules either). The shell twin is
 * edva_local_rules_role in agent/scripts/lib/local-rules.sh.
 */
export function localRulesRoleForCwd(cwd, root) {
  if (!cwd || !root) return null;
  // Physical paths, so a symlinked checkout or cwd still matches.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const rel = path.relative(real(path.join(root, "agent")), real(cwd));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const top = rel.split(path.sep)[0];
  if (top === "chat-agent") return "chat";
  if (top === "ops-agent" || /^ops-[a-z0-9]+-agent$/.test(top)) return "ops"; // lang-regex-ok: a directory name
  return "shared";
}

/**
 * The local rules file for a fork that runs outside the supervisors (a
 * one-shot, a fork executor) in `cwd`: built under `stateDir` like the
 * supervisors' own, or null when the cwd loads no Edva CLAUDE.md or there
 * are no local rules. Never throws.
 */
export function localRulesFileForCwd({ cwd, root, localDir, stateDir }) {
  try {
    const role = localRulesRoleForCwd(cwd, root);
    if (!role) return null;
    return buildLocalRulesFile({
      localDir: localDir || path.join(root, "agent/local"),
      role,
      stateDir: path.join(stateDir, role),
    }).path;
  } catch {
    return null;
  }
}

/**
 * Poll the local rules the way graceful-restart.mjs polls CLAUDE.md: when the
 * joined content differs from what the running session was started with
 * (`supervisor._localRulesContent`, set by the caller at each session start),
 * schedule a graceful restart so the new rules reach the agent. Requires
 * attachClaudeMdWatcher() to have run (it supplies scheduleGracefulRestart).
 * Returns a stop function.
 */
export function watchLocalRules(supervisor, { localDir, role, logPrefix, pollMs = 30_000 }) {
  const timer = setInterval(() => {
    let now;
    try { now = readLocalRules({ localDir, role }); } catch { return; }
    if (supervisor._localRulesContent === undefined || now === supervisor._localRulesContent) return;
    console.error(`${logPrefix} local rules changed (${localDir}) — scheduling graceful restart`);
    supervisor.eventLog?.append({ kind: "local_rules_changed", localDir, role });
    supervisor._localRulesContent = now;
    supervisor.scheduleGracefulRestart?.("local-rules-changed");
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export class ClaudeSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.child = null;
    this.ready = false;
    this.sessionId = opts.sessionId;
    this.lastInit = null;
    this.resumeFailed = false;
    // Set when the child reports the --resume target doesn't exist ("No
    // conversation found with session ID: <id>"). claude -p is LAZY — it does
    // not validate the resume target until the first dispatch, so this failure
    // surfaces as a post-dispatch zero-turn code=1 exit, AFTER spawnOnce() has
    // already resolved. That means the --resume→fresh fallback in start()
    // (which only catches a within-500ms spawn reject) can't see it, and the
    // supervisor would otherwise re-resume the same missing id every restart
    // until the 3-strike crash-loop breaker. The supervisor reads this flag to
    // go fresh on the first strike instead. See index.mjs restart().
    this.sessionNotFound = false;
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
    // Extra settings layered over the user/project files (a JSON string).
    // --settings outranks ~/.claude/settings.json, so this is how a supervisor
    // pins a setting per agent without a gitignored settings.local.json.
    if (o.settings) args.push("--settings", o.settings);
    if (o.appendSystemPromptFile) args.push("--append-system-prompt-file", o.appendSystemPromptFile);
    // Move the per-machine/per-day system-prompt sections (cwd, env info, the
    // date, memory paths) out of the system prompt into the first user message,
    // so the system prompt + tool block stay byte-identical across sessions and
    // days and are READ from cache instead of re-written on every rotation.
    // Only passed when the caller verified the installed claude supports it
    // (supportsCliFlag) — an unknown flag would crash-loop the supervisor.
    if (o.excludeDynamicSystemPromptSections) args.push("--exclude-dynamic-system-prompt-sections");
    if (o.allowedTools) {
      // --allowedTools accepts space-separated tokens; pass as a single arg value.
      args.push("--allowedTools", ...o.allowedTools.split(/\s+/).filter(Boolean).map(t => t.replace(/^"|"$/g, "")));
    }
    // Streams tool-call arguments as input_json_delta chunks, so the supervisor
    // can show the reply text while it is still being written (reply-stream.mjs).
    if (o.includePartialMessages) args.push("--include-partial-messages");
    if (o.disallowedTools) {
      // Unlike --allowedTools under bypassPermissions (a no-op for loading),
      // a deny rule REMOVES the tool from the model's context — every MCP tool
      // name costs ~14 tokens per turn even when deferred (measured 2026-10-04).
      args.push("--disallowedTools", ...o.disallowedTools.split(/\s+/).filter(Boolean));
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
      // The MCP configs name this installation's Supabase project as
      // ${EDVA_SUPABASE_PROJECT}; give the child the instance's value when
      // the environment has none (lib/instance.cjs).
      if (!env.EDVA_SUPABASE_PROJECT) {
        const project = instance().supabase_project;
        if (project) env.EDVA_SUPABASE_PROJECT = project;
      }
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
        // The resume target was never persisted (rotation minted a fresh id
        // that got killed before claude flushed the conversation to disk).
        // Flag it so the supervisor rotates to a genuinely fresh session on the
        // first exit rather than looping on the same missing id.
        if (/No conversation found with session ID/i.test(s)) this.sessionNotFound = true;
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
