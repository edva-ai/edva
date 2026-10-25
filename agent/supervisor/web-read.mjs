// A web-research job posted by an external app, run here on the Max
// subscription instead of that app's own metered API key (whose monthly limit,
// once hit, would stop its reads).
//
// The app composes the prompt and posts a job to a route an installation
// registers (supervisor/_ext/): a system prompt, a user prompt, a target (the
// app's own record the answer belongs to) and a callback URL. Jobs run
// one at a time through `claude -p` with only WebSearch and WebFetch, in a
// scratch directory so no CLAUDE.md or project context leaks in, and never
// with an ANTHROPIC_* credential in the environment. The final text plus the
// queries run and the pages fetched go back to the app's callback, signed
// with the same shared secret the app used to ask; the app parses the report.
//
// A read takes two to ten minutes. Nothing here holds an HTTP response open
// for it: the route answers 202 at once, and the callback carries the answer.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "../../lib/root.cjs";
const require = createRequire(import.meta.url);
// Model id from agent/config/models.env and a
// cost row per read — a web read runs its own `claude -p`, outside the
// supervisor's dispatch ledger. Both required lazily inside runClaude, so a bad
// models.env fails one read, never the supervisor that imports this module.
const loadModels = () => require("../../lib/models.cjs").MODELS;
const recordCost = (args) => { try { require("../../lib/fork-cost-ledger.cjs").recordForkCost(args); } catch (e) { console.error(`[web-read] cost row not written: ${e.message}`); } };

const HOME = process.env.HOME;
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(HOME, ".local/bin/claude");
const WORK_DIR = installTools("data/web-read");
const JOB_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_QUEUE = 6;

const queue = [];
let running = null;

/** Queue a job. Returns how many are ahead of it, or throws when the queue is full. */
export function enqueueWebRead(job) {
  if (queue.length >= MAX_QUEUE) throw new Error("web-read queue is full");
  queue.push(job);
  const ahead = queue.length - 1 + (running ? 1 : 0);
  setImmediate(pump);
  return { ahead };
}

export function webReadStatus() {
  return { running: running ? running.id : null, queued: queue.map((j) => j.id) };
}

async function pump() {
  if (running || queue.length === 0) return;
  running = queue.shift();
  const job = running;
  const started = Date.now();
  let result;
  try {
    result = await runClaude(job);
    console.log(`[web-read] ${job.id} answered in ${Math.round((Date.now() - started) / 1000)}s, ${result.queries.length} searches, ${result.sources.length} pages`);
  } catch (err) {
    console.error(`[web-read] ${job.id} failed: ${err.message}`);
    result = { ok: false, error: err.message };
  }
  try {
    await deliver(job, { ...result, ms: Date.now() - started });
  } finally {
    running = null;
    setImmediate(pump);
  }
}

function runClaude({ system, prompt, model, effort, maxTurns }) {
  return new Promise((resolve, reject) => {
    const modelId = model || loadModels().opus;
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const env = { ...process.env, PATH: `/opt/homebrew/bin:${HOME}/.local/bin:${process.env.PATH || ""}` };
    // The subscription, never the metered key: a stray credential would move this onto the API.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const args = [
      "-p",
      "--model", modelId,
      "--effort", effort || "high",
      "--tools", "WebSearch,WebFetch",
      "--allowedTools", "WebSearch,WebFetch",
      "--max-turns", String(maxTurns || 80),
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt", system,
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: WORK_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    let done = false;
    const finish = (fn) => (v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject)(new Error(`timed out after ${JOB_TIMEOUT_MS / 60000} minutes`));
    }, JOB_TIMEOUT_MS);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { errText = (errText + c).slice(-20000); });
    child.on("error", finish(reject));
    child.on("close", (code) => {
      try { finish(resolve)(parseStream(out, code, errText, (ev) => recordCost({ job: "web-read", result: ev, model: modelId }))); } catch (e) { finish(reject)(e); }
    });
    child.stdin.on("error", () => { /* the child closed early; `close` reports it */ });
    child.stdin.end(prompt);
  });
}

/** The final answer, the searches run and the pages fetched, out of the stream-json events. */
function parseStream(out, code, errText, onResult = () => {}) {
  const queries = [];
  const fetched = new Set();
  let text = "";
  let resultSeen = false;
  let isError = false;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type !== "tool_use") continue;
        if (b.name === "WebSearch" && typeof b.input?.query === "string") queries.push(b.input.query);
        if (b.name === "WebFetch" && typeof b.input?.url === "string") fetched.add(b.input.url);
      }
    }
    if (ev.type === "result") {
      resultSeen = true;
      onResult(ev);
      isError = Boolean(ev.is_error);
      if (typeof ev.result === "string") text = ev.result;
    }
  }
  if (!resultSeen) throw new Error(`claude exited ${code} without a result${errText ? `: ${errText.trim().slice(-400)}` : ""}`);
  // The keychain guard run-ephemeral-opus.sh has: an auth failure is a short "Not logged in" and exit 0.
  if (text.length < 400 && /not logged in|please run \/login/i.test(text)) throw new Error("claude is not logged in on this host");
  if (isError) throw new Error(`claude reported an error: ${text.slice(0, 400)}`);
  return {
    ok: true,
    text,
    queries: queries.slice(0, 30),
    sources: [...fetched].slice(0, 25).map((url) => ({ title: url, url })),
  };
}

async function deliver(job, result) {
  const body = JSON.stringify({ id: job.id, target: job.target, ...result });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(job.callback.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-browse-secret": job.callback.secret },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return;
      console.error(`[web-read] callback for ${job.id} answered ${res.status}`);
    } catch (err) {
      console.error(`[web-read] callback for ${job.id} failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 10000 * attempt));
  }
  console.error(`[web-read] gave up delivering ${job.id}; the app's own sweep will mark it unanswered`);
}
