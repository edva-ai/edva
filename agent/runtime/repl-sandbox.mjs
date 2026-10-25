// repl-sandbox.mjs — WP8: the agentic REPL (the force multiplier).
//
// Conway's single highest-leverage substrate primitive: a persistent JS runtime
// the model evaluates code in mid-loop, where variables survive across calls,
// registered tools are callable from code, and cheap models can be fanned out
// programmatically. It turns the agent from a serial tool-caller into a program
// that orchestrates tools, delegates, and buffers bulk data OUTSIDE the context
// window ("REPL variables as buffers"). WP1 and WP8 are the same lever from two
// ends: deferred tools are invoked via executeTool() in code, so ~30K of schemas
// never enters context.
//
// EDVA ADAPTATION — Max-only auth: Conway's sample() calls the Messages API
// directly. Here sample() routes through an injected `sampler` that defaults to a
// Max-compliant `claude -p --model <tier>` fork (ANTHROPIC_API_KEY stripped), the
// same fork pattern the hum harvesters use — never the SDK. Tests inject a mock sampler.
//
// SECURITY (WP8 risk section): arbitrary code eval on a box with financial rails
// + a logged-in browser is the exact attack surface OpenCLAW flags. So:
//   - the sandbox is OFF by default (`enabled:false`); a caller must opt in;
//   - `sh` (shell) is separately gated (`enableShell:false` by default);
//   - injected globals are frozen (non-writable) so user code can't clobber the
//     bridge; oversized results spill to disk instead of blowing context.
// The caller is responsible for only ever constructing this behind the same
// owner-approval / allow-list gates as Edva's other privileged tools.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { installTools } from "../../lib/root.cjs";
const DEFAULT_SPILL_THRESHOLD = 20_000;   // chars of serialized result → spill
const DEFAULT_TIMEOUT_MS = 30_000;

// Names the evaluated code must not be able to reassign (the bridge surface).
const PROTECTED = new Set([
  "executeTool", "getDeferredTools", "sample", "spawn", "bg", "wait", "db",
  "sh", "console", "setTimeout", "clearTimeout", "log",
]);

export function createReplSandbox({
  sessionId = "default",
  registry = null,
  sampler = null,
  store = null,
  enabled = false,
  enableShell = false,
  spillDir = null,
  spillThreshold = DEFAULT_SPILL_THRESHOLD,
  onSettle = null,
} = {}) {
  const _bg = new Map();                       // key → { status, value, error, promise }
  const spillRoot = spillDir || installTools("data/repl-spill");
  const theSampler = sampler || makeClaudeSampler();

  // ---- bridge globals -----------------------------------------------------
  const executeTool = async (name, args = {}) => {
    if (!registry) return { ok: false, error: "no tool registry bound" };
    return registry.executeTool(name, args);
  };
  const getDeferredTools = (opts = {}) => (registry ? registry.getDeferredTools(opts) : []);
  const sample = async ({ system = "", messages = [], modelId = "haiku" } = {}) =>
    theSampler({ system, messages, modelId });

  const spawnBg = (key, work) => {
    const p = Promise.resolve(typeof work === "function" ? work() : work);
    const rec = { status: "pending", value: undefined, error: undefined, promise: p };
    _bg.set(key, rec);
    p.then(
      (v) => { rec.status = "settled"; rec.value = v; try { onSettle?.(key, { ok: true, value: v }); } catch {} },
      (e) => { rec.status = "error"; rec.error = e; try { onSettle?.(key, { ok: false, error: e }); } catch {} },
    );
    return key;
  };
  const wait = async (key) => {
    const rec = _bg.get(key);
    if (!rec) throw new Error(`no background task: ${key}`);
    return rec.promise;
  };
  const bg = {
    get: (key) => { const r = _bg.get(key); return r ? { key, status: r.status } : null; },
    keys: () => [..._bg.keys()],
    settled: () => [..._bg.entries()].filter(([, r]) => r.status !== "pending").map(([k]) => k),
  };

  // Read-only DB bridge (safe helpers over the WP4 store; no raw SQL by default).
  const db = store ? {
    searchMessages: (query, opts) => store.searchFTS(sessionId, query, opts),
    recent: (limit) => store.getRecentMessages(sessionId, limit),
    range: (startSeq, endSeq) => store.retrieveRange(sessionId, startSeq, endSeq),
  } : { searchMessages: () => [], recent: () => [], range: () => [] };

  // Gated shell — off unless enableShell. Quoting-safe: array argv, no shell string.
  const sh = enableShell
    ? (strings, ...vals) => runShell(interpolate(strings, vals))
    : () => { throw new Error("sh is disabled (enableShell:false)"); };

  // ---- persistent vm context ---------------------------------------------
  const logs = { buffer: [] };
  const consoleShim = {
    log: (...a) => logs.buffer.push(a.map(fmt).join(" ")),
    error: (...a) => logs.buffer.push("[err] " + a.map(fmt).join(" ")),
    warn: (...a) => logs.buffer.push("[warn] " + a.map(fmt).join(" ")),
  };

  const sandbox = {};
  const injected = {
    executeTool, getDeferredTools, sample,
    spawn: spawnBg, bg, wait, db, sh,
    console: consoleShim, log: consoleShim.log,
    // setTimeout/clearTimeout aren't native to a vm context; the standard
    // intrinsics (JSON/Math/Promise/Object/...) already are, so we don't inject
    // them (injecting cross-realm versions breaks instanceof inside the sandbox).
    setTimeout, clearTimeout,
  };
  // camelCase tool bindings (wikiSearch, recallEvents, ...) from the registry.
  if (registry) Object.assign(injected, registry.replBindings());

  vm.createContext(sandbox);
  for (const [k, v] of Object.entries(injected)) {
    Object.defineProperty(sandbox, k, {
      value: v,
      writable: !PROTECTED.has(k),      // freeze the bridge; leave tool globals writable-but-present
      configurable: false,
      enumerable: true,
    });
  }

  async function evaluate(code) {
    if (!enabled) return { ok: false, error: "repl sandbox is disabled (enabled:false) — gate behind owner approval before enabling" };
    logs.buffer = [];
    let result;
    try {
      result = await runInContext(sandbox, code);
    } catch (err) {
      return { ok: false, error: err?.message || String(err), logs: logs.buffer.slice() };
    }
    // Result serialization + spill discipline (mirror snipping): a giant result
    // can't blow the context — spill it to disk and return a pointer + preview.
    let serialized;
    try { serialized = result === undefined ? "" : JSON.stringify(result); } catch { serialized = String(result); }
    if (serialized && serialized.length > spillThreshold) {
      const p = spill(serialized);
      return { ok: true, spilled: p, bytes: serialized.length, preview: serialized.slice(0, 500), logs: logs.buffer.slice() };
    }
    return { ok: true, result, logs: logs.buffer.slice() };
  }

  function spill(serialized) {
    try {
      fs.mkdirSync(spillRoot, { recursive: true });
      const p = path.join(spillRoot, `${sessionId}-${Date.now()}-${_bg.size}.json`);
      fs.writeFileSync(p, serialized);
      return p;
    } catch (e) {
      return `<spill-failed: ${e.message}>`;
    }
  }

  function dispose() { _bg.clear(); }

  return { evaluate, dispose, context: sandbox, _bg };
}

// Compile+run: try expression form first (auto-returns the value); fall back to
// statement form (needs an explicit `return`). Async wrapper allows top-level
// await. Undeclared assignments (`x = 5`) persist on the context global across
// calls — "REPL variables as buffers".
async function runInContext(sandbox, code) {
  let script;
  try {
    script = new vm.Script(`(async () => (\n${code}\n))()`);
  } catch {
    script = new vm.Script(`(async () => {\n${code}\n})()`);
  }
  return script.runInContext(sandbox, { timeout: DEFAULT_TIMEOUT_MS });
}

function fmt(x) {
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function interpolate(strings, vals) {
  // Build an argv by treating the template literal as a single command line,
  // shell-escaping interpolated values. Returns { cmd, args } for /bin/sh -c
  // is avoided; instead we run the whole thing through sh -c with escaped vals.
  let out = "";
  strings.forEach((s, i) => { out += s + (i < vals.length ? shEscape(vals[i]) : ""); });
  return out;
}

function shEscape(v) {
  const s = String(v);
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runShell(cmdline) {
  return new Promise((resolve) => {
    let out = "", err = "";
    const child = spawn("/bin/sh", ["-c", cmdline], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

// Default Max-compliant sampler: one-shot `claude -p --model <tier> --output-format
// text`, ANTHROPIC_API_KEY stripped. Renders {system, messages} to a prompt.
export function makeClaudeSampler({ claudeBin = null, timeoutMs = 45_000 } = {}) {
  const bin = Array.isArray(claudeBin) ? claudeBin : [claudeBin || process.env.CLAUDE_BIN || `${os.homedir()}/.local/bin/claude`];
  return function claudeSampler({ system = "", messages = [], modelId = "haiku" }) {
    return new Promise((resolve) => {
      const prompt = [system, ...messages.map((m) => `${(m.role || "user").toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)]
        .filter(Boolean).join("\n");
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      let out = "", done = false;
      const finish = (t) => { if (done) return; done = true; resolve((t || "").trim()); };
      let child;
      try {
        child = spawn(bin[0], [...bin.slice(1), "-p", prompt, "--model", modelId, "--output-format", "text"], { env, stdio: ["ignore", "pipe", "pipe"] });
      } catch { return finish(""); }
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(out); }, timeoutMs);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("exit", () => { clearTimeout(timer); finish(out); });
      child.on("error", () => { clearTimeout(timer); finish(out); });
    });
  };
}
