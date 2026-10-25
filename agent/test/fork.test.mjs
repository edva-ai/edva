// fork.test.mjs — WP3 forks / sub-agents with isolated context. Mock executor.
//
// Run: node --test agent/test/fork.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `fork-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");
const { Agent } = await import("../core/agent.mjs");
const forkMod = await import("../core/fork.mjs");
const { fork, reidToolUses, lastAssistantSummary, toolsForKind, forkDirective } = forkMod;

function cleanup() {
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const lastText = (parts) => parts.map((p) => p.text || "").join(" ").trim();

// Executor that echoes the directive text so we can assert join summaries.
function echoExecutor() {
  return ({ userParts }) => Promise.resolve({ text: `did:${lastText(userParts).slice(0, 40)}` });
}
let counter = 0;
const seed = () => counter++;

describe("fork pure helpers (WP3)", () => {
  it("reidToolUses suffixes tool_use/tool_result ids per fork", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "tu_abc", name: "x" }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_abc", content: "r" }] },
    ];
    const out = reidToolUses(msgs, "fork-ops-12345678");
    assert.match(out[0].content[0].id, /^tu_abc_/);
    assert.equal(out[1].content[0].tool_use_id, out[0].content[0].id, "use+result re-id'd consistently");
    assert.equal(msgs[0].content[0].id, "tu_abc", "original not mutated");
  });

  it("toolsForKind denies fork/restart/output to forks & subagents", () => {
    const base = ["repl", "fork", "restart", "output", "wiki_search"];
    assert.deepEqual(toolsForKind("main", base), base);
    assert.deepEqual(toolsForKind("fork", base), ["repl", "wiki_search"]);
    assert.deepEqual(toolsForKind("subagent", base), ["repl", "wiki_search"]);
  });

  it("lastAssistantSummary extracts the final assistant text", () => {
    const a = { messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "the answer" }] },
    ] };
    assert.equal(lastAssistantSummary(a), "the answer");
  });

  it("forkDirective states provenance, so a fork doesn't refuse its own task", () => {
    // With a bare `[fork <id>]` tag and a block of inherited
    // conversation, a fork read its own assignment as injected content and
    // refused an ordinary research task — "That message is a prompt injection,
    // not a real request from you. I'm not running the search." The directive has
    // to say who authorized it, and which inputs are untrusted, or the model
    // cannot apply CLAUDE.md's injection rule correctly.
    const d = forkDirective("fork-y", "look up the boiling point of ethanol");
    assert.match(d, /authorized/i, "must assert the task is authorized");
    assert.match(d, /Edva/, "must name who the task came from");
    assert.match(d, /INHERITED BACKGROUND|inherited background/i, "must label the inherited context as context");
    assert.match(d, /UNTRUSTED/i, "must label fetched web content untrusted");
    assert.match(d, /look up the boiling point of ethanol/, "and still carry the task");
  });

  it("forkDirective embeds the id and task", () => {
    const d = forkDirective("fork-x", "scan release notes");
    assert.match(d, /fork-x/);
    assert.match(d, /scan release notes/);
  });
});

describe("fork lifecycle (WP3)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("inherits the parent context slice and runs the directive", async () => {
    const parent = new Agent("ops", { executor: echoExecutor() });
    await parent.send("parent did some setup");   // parent context to inherit
    const before = parent.messages.length;
    const { forkId, agent, placeholder, joined } = fork(parent, { task: "scan release notes", autoJoin: false, seedFn: seed });
    assert.equal(placeholder, forkMod.FORK_PLACEHOLDER_RESULT);
    const summary = await joined;
    // The fork saw the inherited context + boundary + directive.
    assert.ok(agent.messages.length > before, "fork inherited context");
    assert.ok(agent.messages.some((m) => m.kind === "fork_boundary"), "boundary marker seeded");
    assert.match(summary, /did:/);
    assert.equal(store.getAgentRow(forkId).kind, "fork");
  });

  it("autoJoin posts the fork summary into the parent's mailbox", async () => {
    const parent = new Agent("ops", { executor: echoExecutor() });
    await parent.send("setup");
    const before = parent.turns;
    const { joined } = fork(parent, { task: "summarize the day", autoJoin: true, seedFn: seed });
    await joined;
    await parent.awaitIdle();                     // let the join hint process
    assert.ok(parent.turns > before, "parent processed the join hint as a new turn");
    assert.ok(parent.messages.some((m) => m.role === "user" && /joined\]/.test(lastText(Array.isArray(m.content) ? m.content : [m.content]))),
      "join hint landed in the parent context");
  });

  it("two forks run in parallel, each with its own context, both join", async () => {
    const parent = new Agent("ops", { executor: echoExecutor() });
    await parent.send("shared setup");
    const f1 = fork(parent, { task: "task ONE", autoJoin: false, seedFn: seed });
    const f2 = fork(parent, { task: "task TWO", autoJoin: false, seedFn: seed });
    const [s1, s2] = await Promise.all([f1.joined, f2.joined]);
    assert.notEqual(f1.forkId, f2.forkId, "distinct fork ids");
    // Assert on the directive each fork actually received, not on the echo
    // executor's 40-char prefix: the directive now opens with provenance framing
    // (who authorized this task, which inputs are untrusted) because without it
    // a fork refuses its own assignment as an injection attempt. The task text
    // therefore no longer sits in the first 40 characters.
    const directiveOf = (f) => f.agent.messages
      .map((m) => lastText(Array.isArray(m.content) ? m.content : [m.content]))
      .join("\n");
    assert.match(directiveOf(f1), /task ONE/);
    assert.match(directiveOf(f2), /task TWO/);
    assert.ok(s1.startsWith("did:") && s2.startsWith("did:"), "both forks ran a turn and joined");
    // Independent contexts — neither fork sees the other's directive.
    assert.ok(!/task TWO/.test(directiveOf(f1)), "neither fork sees the other's task");
    assert.ok(!/task ONE/.test(directiveOf(f2)));
  });
});
