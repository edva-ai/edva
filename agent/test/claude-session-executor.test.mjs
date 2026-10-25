// claude-session-executor.test.mjs — proves an Agent can drive a live-shaped
// ClaudeSession via the Max-compliant executor. Uses a MOCK session emitter
// (no real claude -p, no network).
//
// Run: node --test agent/test/claude-session-executor.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `cse-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const store = await import("../core/message-store.mjs");
const { Agent } = await import("../core/agent.mjs");
const { makeClaudeSessionExecutor } = await import("../core/claude-session-executor.mjs");

function cleanup() {
  store._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

// Mock ClaudeSession: on send(content), streams an assistant text event then a
// result event, echoing the content back. Honors a `hang` mode for cancel tests.
class MockSession extends EventEmitter {
  constructor({ hang = false } = {}) { super(); this.hang = hang; this.sent = []; }
  send(content) {
    this.sent.push(content);
    if (this.hang) return;                 // never emits result → exercise cancel
    setImmediate(() => {
      this.emit("event", { type: "assistant", message: { content: [{ type: "text", text: `reply to: ${content}` }] } });
      this.emit("result", { modelUsage: { input_tokens: 10 }, num_turns: 1 });
    });
  }
}

describe("claude-session-executor (Max-compliant loop bridge)", () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("requires a session with send()", () => {
    assert.throws(() => makeClaudeSessionExecutor({}), /send\(\) is required/);
  });

  it("drives one turn: sends content, accumulates assistant text, resolves", async () => {
    const session = new MockSession();
    const exec = makeClaudeSessionExecutor(session);
    const out = await exec({ userParts: [{ type: "text", text: "hello" }], signal: new AbortController().signal });
    assert.equal(out.text, "reply to: hello");
    assert.deepEqual(session.sent, ["hello"]);       // only the new turn sent (--resume holds history)
    assert.ok(out.usage, "carries usage from the result event");
  });

  it("an Agent runs end-to-end through the session executor + records to the store", async () => {
    const session = new MockSession();
    const agent = new Agent("chat", { executor: makeClaudeSessionExecutor(session) });
    const text = await agent.send("what's on my calendar?");
    assert.equal(text, "reply to: what's on my calendar?");
    // Shadow record landed in the WP4 store.
    const rows = store.getRecentMessages("chat", 10);
    assert.deepEqual(rows.map((r) => r.role), ["user", "assistant"]);
    assert.match(store.searchFTS("chat", "calendar")[0]?.snippet ?? "", /calendar/i);
  });

  it("streams multiple assistant text blocks into one turn", async () => {
    const session = new EventEmitter();
    session.send = () => setImmediate(() => {
      session.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "part one. " }] } });
      session.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "part two." }] } });
      session.emit("result", { modelUsage: {} });
    });
    const out = await makeClaudeSessionExecutor(session)({ userParts: [{ text: "go" }], signal: new AbortController().signal });
    assert.equal(out.text, "part one. part two.");
  });

  it("cancel (abort) resolves with partial text, doesn't hang", async () => {
    const session = new MockSession({ hang: true });
    const exec = makeClaudeSessionExecutor(session);
    const ctrl = new AbortController();
    const p = exec({ userParts: [{ text: "slow one" }], signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    const out = await p;
    assert.equal(out.text, "");             // hung before any assistant text
  });

  it("scopes listeners per turn (no leak across turns)", async () => {
    const session = new MockSession();
    const exec = makeClaudeSessionExecutor(session);
    await exec({ userParts: [{ text: "one" }], signal: new AbortController().signal });
    await exec({ userParts: [{ text: "two" }], signal: new AbortController().signal });
    // After two turns, no lingering result/event listeners from the executor.
    assert.ok(session.listenerCount("result") === 0, "result listeners cleaned up");
    assert.ok(session.listenerCount("event") === 0, "event listeners cleaned up");
  });
});
