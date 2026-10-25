// stateless-executor.mjs — a Max-compliant, Agent-OWNS-CONTEXT turn executor.
//
// Each turn renders the Agent's full transcript (system + messages) into a
// single prompt and runs a FRESH, stateless `claude -p --no-session-persistence`
// subprocess with ANTHROPIC_API_KEY stripped (Max subscription only — never the
// raw Anthropic SDK / Messages API, never an API key). The Agent owns the
// context array; claude -p is treated as a stateless completer over OUR
// transcript, so snipping/compaction/system-assembly done on the Agent's array
// are what the model actually sees.
//
// WHERE THIS FITS (executor-cutover decision — see
// conway-substrate-plan.md). `claude -p` cannot be fed a full authoritative
// transcript (stream-json input accepts user turns only; system + tools are
// fixed at spawn), so "Agent owns context" is only achievable by re-rendering
// the whole transcript per turn into a fresh spawn. For a long-lived CHAT
// conversation that is a REGRESSION (flattening loses tool-call structure; every
// turn re-sends the full context with no cross-turn prompt-cache reuse), so chat
// stays on the persistent `--resume` ClaudeSession (claude-session-executor.mjs).
// But for a BOUNDED task — a WP3 fork / sub-agent, or a one-shot ops task — a
// fresh context slice per run is exactly the right model, and this executor is
// its Max-compliant home.
//
// Executor contract (see core/agent.mjs):
//   ({ agent, system, messages, tools, userParts, signal }) => { text, usage }
//
// `spawnFn` and `renderPrompt` are injectable so the loop is unit-testable
// without spawning a real `claude -p` (tests pass a fake spawnFn).

import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";

function resolveClaudeBin(claudeBin) {
  if (Array.isArray(claudeBin)) return claudeBin;
  if (typeof claudeBin === "string") return [claudeBin];
  return [process.env.CLAUDE_BIN || `${os.homedir()}/.local/bin/claude`];
}

// Render one message's content (string | array of blocks) to text, keeping a
// best-effort textual trace of tool_use / tool_result blocks (claude -p can't
// receive them structurally, so we describe them). Exported for tests.
export function flattenBlock(block) {
  if (block == null) return "";
  if (typeof block === "string") return block;
  if (Array.isArray(block)) return block.map(flattenBlock).filter(Boolean).join("\n");
  if (typeof block === "object") {
    if (block.type === "text" || typeof block.text === "string") return block.text || "";
    if (block.type === "tool_use") {
      const input = (() => { try { return JSON.stringify(block.input ?? {}); } catch { return "{...}"; } })();
      return `[tool_use ${block.name || "?"} ${input}]`;
    }
    if (block.type === "tool_result") {
      const c = flattenBlock(block.content);
      return `[tool_result${block.is_error ? " error" : ""}] ${c}`;
    }
    return block.text || "";
  }
  return "";
}

// Render the full transcript into a single prompt string. Exported for tests.
export function renderTranscript(system, messages) {
  const lines = [];
  if (system) lines.push(system, "");
  for (const m of messages || []) {
    const text = flattenBlock(m.content);
    if (text) lines.push(`${String(m.role || "user").toUpperCase()}: ${text}`);
  }
  lines.push("ASSISTANT:");
  return lines.join("\n");
}

// Parse `claude -p --output-format json` stdout → { text, usage }. Falls back to
// treating raw stdout as text if it isn't the expected JSON envelope.
export function parseClaudeJson(stdout) {
  const raw = (stdout || "").trim();
  if (!raw) return { text: "", usage: null };
  try {
    const obj = JSON.parse(raw);
    // Claude Code -p --output-format json envelope: { result, usage, total_cost_usd, ... }
    const text = typeof obj.result === "string" ? obj.result
      : typeof obj.text === "string" ? obj.text
      : "";
    const usage = obj.usage || (obj.total_cost_usd != null ? { total_cost_usd: obj.total_cost_usd } : null);
    return { text: text.trim(), usage };
  } catch {
    return { text: raw, usage: null };
  }
}

export function makeStatelessExecutor({
  model = "claude-sonnet-5-5",
  claudeBin = null,
  cwd = null,
  // Reasoning effort for this spawn. Effort is session-scoped and can only be
  // set at spawn time (agent/CLAUDE.md § Effort Policy) — which is exactly
  // what a stateless per-turn executor gets to do, unlike the --resume
  // supervisors. Rule 3 there: a high-volume fork that runs per-invocation
  // should pass `low`. Null = inherit the plan-tier default.
  effort = null,
  allowedTools = null,   // space-separated string or array — AUTO-APPROVE list only
  // AVAILABILITY restriction — a different flag with a different job, and the
  // distinction is load-bearing. `--allowedTools` is the auto-approve list; it
  // does NOT remove anything from the tool surface. `--tools` is what actually
  // limits which built-in tools exist for the session ("" disables all,
  // "default" keeps all, else a comma/space list).
  //
  // Learned the hard way: a chat fork launched with
  // `allowedTools: "WebSearch WebFetch"` is NOT restricted by it.
  // A probe fork reported its real surface as "Bash, Edit, Read, Write, …,
  // Skill" — i.e. a sub-agent doing open web research had shell and filesystem
  // WRITE access. For a fork whose whole job is reading untrusted web content,
  // that is the prompt-injection surface CLAUDE.md § Prompt Injection exists to
  // prevent. Pass `tools` to bound it, not `allowedTools`.
  tools = null,          // space/comma-separated string or array; "" disables all
  mcpConfig = null,      // path
  // Ignore every MCP config EXCEPT an explicit --mcp-config. Without this,
  // `claude -p` auto-discovers `.mcp.json` from its cwd — so a fork given
  // cwd=<chat-agent dir> silently inherited the chat agent's ENTIRE MCP surface.
  // A probe found a supposedly read-only research fork holding
  // mcp__chrome-devtools (which drives Edva's already-logged-in Chrome, i.e.
  // the real bank/brokerage cookies) and mcp__claude_ai_Gmail (create_draft,
  // labels). `--tools` does NOT cover MCP tools; only this does.
  strictMcpConfig = false,
  appendSystemPromptFile = null,
  addDirs = null,        // array of dirs
  timeoutMs = 120_000,
  noSessionPersistence = true,
  spawnFn = nodeSpawn,
  renderPrompt = renderTranscript,
} = {}) {
  const bin = resolveClaudeBin(claudeBin);

  return function statelessExecutor({ system, messages, signal } = {}) {
    return new Promise((resolve) => {
      const prompt = renderPrompt(system, messages);

      const args = [...bin.slice(1), "-p", "--output-format", "json", "--model", model];
      if (noSessionPersistence) args.push("--no-session-persistence");
      if (effort) args.push("--effort", effort);
      if (appendSystemPromptFile) args.push("--append-system-prompt-file", appendSystemPromptFile);
      if (mcpConfig) args.push("--mcp-config", mcpConfig);
      if (strictMcpConfig) args.push("--strict-mcp-config");
      if (addDirs) for (const d of addDirs) args.push("--add-dir", d);
      if (tools !== null && tools !== undefined) {
        const list = (Array.isArray(tools) ? tools.join(",") : String(tools)).trim();
        args.push("--tools", list);     // "" is meaningful: disable every built-in tool
      }
      if (allowedTools) {
        const toks = (Array.isArray(allowedTools) ? allowedTools.join(" ") : allowedTools)
          .split(/\s+/).filter(Boolean);
        if (toks.length) args.push("--allowedTools", ...toks);
      }

      // Max-only invariant: never let the child see an API key.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      let child, out = "", done = false;
      const finish = (stdout) => {
        if (done) return;
        done = true;
        try { child?.kill("SIGKILL"); } catch {}
        clearTimeout(timer);
        if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch {} }
        resolve(parseClaudeJson(stdout));
      };

      let onAbort = null;
      let timer = null;
      try {
        child = spawnFn(bin[0], args, { cwd: cwd || undefined, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        return resolve({ text: "", usage: null });
      }

      timer = setTimeout(() => finish(out), timeoutMs);
      if (signal) {
        if (signal.aborted) return finish(out);
        onAbort = () => finish(out);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => { if (process.env.STATELESS_EXECUTOR_DEBUG) console.error(`[stateless-executor stderr] ${d}`); });
      child.on("exit", () => finish(out));
      child.on("error", () => finish(out));

      // Feed the rendered transcript on stdin, then EOF (avoids ARG_MAX on long
      // contexts — claude -p reads the prompt from stdin when none is on argv,
      // but we also passed no positional prompt so stdin is authoritative here).
      try { child.stdin?.write(prompt); child.stdin?.end(); } catch {}
    });
  };
}
