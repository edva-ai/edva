// stateless-executor.test.mjs — the Max-compliant, Agent-owns-context per-turn
// executor (forks / one-shot ops). Uses an injected fake spawnFn so no real
// `claude -p` runs.
//
// Run: node --test agent/test/stateless-executor.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  makeStatelessExecutor,
  renderTranscript,
  flattenBlock,
  parseClaudeJson,
} from "../core/stateless-executor.mjs";

// A fake child process: records args/env/stdin, lets the test drive stdout+exit.
function makeFakeSpawn({ stdout = "", exitDelay = 0, code = 0 } = {}) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    const stdinChunks = [];
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (c) => stdinChunks.push(String(c)), end: () => {} };
    child.kill = () => {};
    const call = { bin, args, opts, stdinChunks };
    calls.push(call);
    // Emit stdout + exit on next tick (or after exitDelay) so listeners attach.
    setTimeout(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("exit", code, null);
    }, exitDelay);
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

describe("stateless-executor: rendering", () => {
  it("renderTranscript renders system + roled turns and closes with ASSISTANT:", () => {
    const out = renderTranscript("SYS", [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    assert.match(out, /^SYS/);
    assert.match(out, /USER: hi/);
    assert.match(out, /ASSISTANT: hello/);
    assert.match(out, /ASSISTANT:$/);
  });

  it("flattenBlock keeps a textual trace of tool_use / tool_result", () => {
    assert.equal(flattenBlock({ type: "text", text: "x" }), "x");
    assert.match(flattenBlock({ type: "tool_use", name: "wiki_search", input: { q: "a" } }), /\[tool_use wiki_search \{"q":"a"\}\]/);
    assert.match(flattenBlock({ type: "tool_result", content: "42" }), /\[tool_result\] 42/);
    assert.match(flattenBlock({ type: "tool_result", is_error: true, content: "boom" }), /\[tool_result error\] boom/);
  });
});

describe("stateless-executor: json parsing", () => {
  it("parses the claude -p --output-format json envelope", () => {
    const r = parseClaudeJson(JSON.stringify({ result: "  the answer  ", usage: { input_tokens: 10 }, total_cost_usd: 0.01 }));
    assert.equal(r.text, "the answer");
    assert.deepEqual(r.usage, { input_tokens: 10 });
  });
  it("falls back to raw text when stdout is not the JSON envelope", () => {
    const r = parseClaudeJson("just text");
    assert.equal(r.text, "just text");
    assert.equal(r.usage, null);
  });
  it("empty stdout → empty text", () => {
    assert.deepEqual(parseClaudeJson(""), { text: "", usage: null });
  });
});

describe("stateless-executor: the executor loop (fake spawn)", () => {
  it("builds Max-compliant args, strips ANTHROPIC_API_KEY, feeds prompt on stdin, returns parsed result", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-be-stripped";
    const spawnFn = makeFakeSpawn({ stdout: JSON.stringify({ result: "done", usage: { output_tokens: 5 } }) });
    const exec = makeStatelessExecutor({
      model: "claude-sonnet-5",
      claudeBin: "/fake/claude",
      allowedTools: "Read Bash",
      mcpConfig: "/tmp/mcp.json",
      appendSystemPromptFile: "/tmp/sys.txt",
      spawnFn,
    });
    const out = await exec({ system: "SYS", messages: [{ role: "user", content: "go" }] });
    assert.deepEqual(out, { text: "done", usage: { output_tokens: 5 } });

    const call = spawnFn.calls[0];
    assert.equal(call.bin, "/fake/claude");
    assert.ok(call.args.includes("-p"));
    assert.ok(call.args.includes("--no-session-persistence"), "stateless: no session written to disk");
    assert.deepEqual(call.args.slice(call.args.indexOf("--output-format"), call.args.indexOf("--output-format") + 2), ["--output-format", "json"]);
    assert.deepEqual(call.args.slice(call.args.indexOf("--model"), call.args.indexOf("--model") + 2), ["--model", "claude-sonnet-5"]);
    assert.ok(call.args.includes("--append-system-prompt-file"));
    assert.ok(call.args.includes("--mcp-config"));
    assert.ok(call.args.includes("--allowedTools"));
    assert.ok(call.args.includes("Read") && call.args.includes("Bash"));
    // Max-only invariant: the child must never see an API key.
    assert.equal(call.opts.env.ANTHROPIC_API_KEY, undefined);
    // The Agent's transcript is what's sent — on stdin, not argv (ARG_MAX safe).
    assert.match(call.stdinChunks.join(""), /SYS[\s\S]*USER: go[\s\S]*ASSISTANT:$/);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("omits optional flags when not configured", async () => {
    const spawnFn = makeFakeSpawn({ stdout: JSON.stringify({ result: "ok" }) });
    const exec = makeStatelessExecutor({ claudeBin: "/fake/claude", spawnFn });
    await exec({ system: "", messages: [{ role: "user", content: "hi" }] });
    const call = spawnFn.calls[0];
    assert.ok(!call.args.includes("--allowedTools"));
    assert.ok(!call.args.includes("--mcp-config"));
    assert.ok(!call.args.includes("--append-system-prompt-file"));
  });

  it("abort resolves with partial output instead of hanging", async () => {
    const spawnFn = makeFakeSpawn({ stdout: JSON.stringify({ result: "late" }), exitDelay: 10_000 });
    const exec = makeStatelessExecutor({ claudeBin: "/fake/claude", spawnFn });
    const ac = new AbortController();
    const p = exec({ system: "", messages: [{ role: "user", content: "hi" }], signal: ac.signal });
    ac.abort();
    const out = await p;
    assert.equal(out.text, "");   // no stdout arrived before abort
  });

  it("a spawn throw fails soft (resolves empty, never rejects)", async () => {
    const throwingSpawn = () => { throw new Error("ENOENT"); };
    const exec = makeStatelessExecutor({ claudeBin: "/fake/claude", spawnFn: throwingSpawn });
    const out = await exec({ system: "", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(out, { text: "", usage: null });
  });
});
