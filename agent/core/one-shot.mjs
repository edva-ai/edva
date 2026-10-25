// one-shot.mjs — run a bounded task through an Agent + the stateless executor,
// to completion, and return the result. This is the substrate's "fork /
// one-shot" payoff path: a fresh-context sub-agent that runs on a Max-compliant
// `claude -p --no-session-persistence` (see stateless-executor.mjs) and touches
// NO live --resume conversation. Use it to offload a bounded task — parallel
// research, a focused analysis, a summarization — to a clean context that
// doesn't consume the caller's context window.
//
// One `runOneShot` = one Agent turn = one `claude -p` invocation, inside which
// claude runs its OWN internal agentic loop (it may call WebSearch/Read/etc.
// several times) and returns a synthesized answer. So a research task is a single
// runOneShot call, not a hand-rolled multi-turn loop here.
//
// For a HEAVY / multi-minute task launched from an agent turn, prefer wrapping
// the runOneShot call in `job-run` (detached, survives a supervisor bounce) per
// agent/CLAUDE.md § Long-Running Jobs — runOneShot itself is a plain
// awaitable and does not detach.
//
// Max invariant: the executor strips ANTHROPIC_API_KEY; never a raw SDK/API key.

import os from "node:os";
import path from "node:path";
import { Agent } from "./agent.mjs";
import { makeStatelessExecutor } from "./stateless-executor.mjs";
import { localRulesFileForCwd } from "../supervisor/claude-session.mjs";

import { REPO_ROOT as EDVA_ROOT } from "../../lib/root.cjs";

// A one-shot started inside the agent tree loads that dir's CLAUDE.md files, as
// the supervised agents do; it gets the instance's local rules beside them
// (agent/local/, see claude-session.mjs § Local agent rules), built under
// a per-user temp dir at a stable path.
function defaultLocalRulesFile(cwd) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  return localRulesFileForCwd({
    cwd: cwd || process.cwd(),
    root: EDVA_ROOT,
    localDir: process.env.EDVA_LOCAL_DIR || undefined,
    stateDir: path.join(os.tmpdir(), `edva-local-rules-${uid}`),
  });
}

let _seq = 0;

export async function runOneShot(task, {
  system = "",
  model = "claude-sonnet-5-5",
  claudeBin = null,
  cwd = null,
  effort = null,         // "low" for high-volume fan-out; see CLAUDE.md § Effort Policy
  allowedTools = null,   // space-separated string or array; null = no tools
  mcpConfig = null,
  addDirs = null,
  // --append-system-prompt-file. Left undefined: the local rules for the cwd
  // (none outside agent); null: nothing appended.
  appendSystemPromptFile = undefined,
  timeoutMs = 120_000,
  executor = null,       // inject a mock/alternate executor (tests, custom hosts)
  persist = false,       // one-shots are ephemeral by default (no store writes)
  id = null,
} = {}) {
  if (!task || !String(task).trim()) throw new Error("runOneShot: task is required");
  const exec = executor || makeStatelessExecutor({
    model, claudeBin, cwd, effort, allowedTools, mcpConfig, addDirs, timeoutMs,
    appendSystemPromptFile: appendSystemPromptFile === undefined ? defaultLocalRulesFile(cwd) : appendSystemPromptFile,
  });
  const agentId = id || `oneshot-${Date.now()}-${_seq++}`;
  const agent = new Agent(agentId, {
    kind: "oneshot", executor: exec, system, modelId: model, persist,
  });
  // The Agent emits "error" on an executor failure; Node's EventEmitter throws
  // if "error" has no listener (→ unhandled rejection, process crash). The
  // failure is already surfaced to the caller via the rejected send() promise
  // below, so this listener just neutralizes the secondary emit.
  agent.on("error", () => {});
  const text = await agent.send(String(task));
  return { id: agentId, text: (text || "").trim(), agent };
}
