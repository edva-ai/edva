// one-shot.test.mjs — runOneShot: a bounded task through an Agent + (mocked)
// stateless executor. No real claude -p (executor is injected).
//
// Run: node --test agent/test/one-shot.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// Ephemeral (persist:false) one-shots don't write, but point the store DB at a
// tmp path anyway so nothing can touch the real memory-index.db.
process.env.MEMORY_INDEX_DB = path.join(os.tmpdir(), `oneshot-test-${process.pid}.db`);
const { runOneShot } = await import("../core/one-shot.mjs");

describe("runOneShot", () => {
  it("runs the task through the injected executor and returns { id, text }", async () => {
    let seen = null;
    const executor = async ({ messages, system }) => {
      // Snapshot at call time — `messages` is a live ref that gets the assistant
      // turn appended after this returns.
      seen = { messages: messages.map((m) => ({ role: m.role, content: m.content })), system };
      return { text: "  the synthesized answer  " };
    };
    const out = await runOneShot("research the thing", { executor, system: "SYS" });
    assert.equal(out.text, "the synthesized answer");   // trimmed
    assert.match(out.id, /^oneshot-/);
    // The executor saw the task as the (only) user turn + the system.
    assert.equal(seen.system, "SYS");
    const lastUser = seen.messages.at(-1);
    assert.equal(lastUser.role, "user");
    assert.match(JSON.stringify(lastUser.content), /research the thing/);
  });

  it("honors a custom id", async () => {
    const out = await runOneShot("x", { executor: async () => ({ text: "ok" }), id: "research-42" });
    assert.equal(out.id, "research-42");
  });

  it("generates unique ids across calls", async () => {
    const exec = async () => ({ text: "ok" });
    const a = await runOneShot("a", { executor: exec });
    const b = await runOneShot("b", { executor: exec });
    assert.notEqual(a.id, b.id);
  });

  it("throws when the task is empty", async () => {
    await assert.rejects(() => runOneShot("   ", { executor: async () => ({ text: "x" }) }), /task is required/);
  });

  it("an executor error propagates (bounded task fails loudly, not silently)", async () => {
    await assert.rejects(
      () => runOneShot("boom", { executor: async () => { throw new Error("model down"); } }),
      /model down/
    );
  });
});
