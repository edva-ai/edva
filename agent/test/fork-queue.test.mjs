// fork-queue.test.mjs — WP3's durable request ledger.
//
// The queue exists because the thing that ASKS for a fork (the model, via
// tools-mcp) runs in a different process from the thing that can DO it (the
// supervisor, which holds the live chat Agent). Same split check_later already
// runs in production.
//
// Isolation: MEMORY_INDEX_DB is pointed at a tmp DB before import, the landed
// event-fts pattern. No model, no supervisor — this covers the ledger contract
// and, mostly, its refusals: an unbounded fan-out of `claude -p` processes on a
// small always-on host is the failure mode worth designing against.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `fork-queue-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;

const q = await import("../core/fork-queue.mjs");

function cleanup() {
  q._closeForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}

describe("fork queue — the happy path", () => {
  before(cleanup); after(cleanup); beforeEach(cleanup);

  it("queues a request and hands it to the draining side", () => {
    const r = q.requestFork("chat", "compare these four hotels");
    assert.ok(r.id, `expected an id, got ${JSON.stringify(r)}`);
    const queued = q.queuedForks("chat");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].task, "compare these four hotels");
  });

  it("moves through queued -> running -> done", () => {
    const { id } = q.requestFork("chat", "research X");
    q.markRunning(id, "fork-chat-abc");
    assert.equal(q.queuedForks("chat").length, 0, "a running fork is no longer queued");
    assert.equal(q.countActive("chat"), 1, "but it still holds an in-flight slot");
    q.markDone(id, "here is what I found");
    assert.equal(q.countActive("chat"), 0);
    assert.equal(q.listForks("chat")[0].summary, "here is what I found");
  });

  it("keeps sessions separate", () => {
    q.requestFork("chat", "a");
    q.requestFork("ops", "b");
    assert.equal(q.queuedForks("chat").length, 1);
    assert.equal(q.queuedForks("ops").length, 1);
    assert.equal(q.queuedForks("chat")[0].task, "a");
  });
});

describe("fork queue — refusals", () => {
  before(cleanup); after(cleanup); beforeEach(cleanup);

  it("caps concurrent forks per session", () => {
    // Each fork is a `claude -p` process. A model that delegates in a loop must
    // not be able to fan out a swarm on a small always-on host.
    for (let i = 0; i < q.MAX_INFLIGHT_FORKS; i++) {
      assert.ok(q.requestFork("chat", `task ${i}`).id);
    }
    const over = q.requestFork("chat", "one too many");
    assert.ok(over.error, "expected a refusal at the cap");
    assert.match(over.error, /max/i);
    assert.equal(q.countActive("chat"), q.MAX_INFLIGHT_FORKS);
  });

  it("frees a slot once a fork finishes", () => {
    const ids = [];
    for (let i = 0; i < q.MAX_INFLIGHT_FORKS; i++) ids.push(q.requestFork("chat", `t${i}`).id);
    assert.ok(q.requestFork("chat", "blocked").error);
    q.markDone(ids[0], "done");
    assert.ok(q.requestFork("chat", "now allowed").id);
  });

  it("refuses an empty or oversized task instead of throwing", () => {
    assert.match(q.requestFork("chat", "").error, /required/); // lang-regex-ok: the queue's own error string
    assert.match(q.requestFork("chat", "   ").error, /required/); // lang-regex-ok: the queue's own error string
    assert.match(q.requestFork("chat", "x".repeat(q.MAX_TASK_CHARS + 1)).error, /too long/); // lang-regex-ok: the queue's own error string
  });

  it("refuses without a session id rather than orphaning the row", () => {
    assert.ok(q.requestFork("", "something").error);
    assert.ok(q.requestFork(null, "something").error);
  });
});

describe("fork queue — surviving a supervisor bounce", () => {
  before(cleanup); after(cleanup); beforeEach(cleanup);

  it("a queued request outlives the process that received it", () => {
    q.requestFork("chat", "still here after a restart");
    q._closeForTest();                      // simulate the bounce
    assert.equal(q.queuedForks("chat").length, 1,
      "the whole point of a durable ledger — a request made just before a restart is not lost");
  });

  it("reclaims a fork left running by a dead supervisor", () => {
    // Its `claude -p` died with the supervisor, so it will never report back.
    // Left alone it holds an in-flight slot forever and delegation silently
    // stops working — the same stale-holder class as the daily-summary lock.
    const { id } = q.requestFork("chat", "orphan");
    q.markRunning(id, "fork-chat-dead", { now: Date.now() - 60 * 60_000 });
    assert.equal(q.countActive("chat"), 1);
    const n = q.reclaimStale("chat", { olderThanMs: 30 * 60_000 });
    assert.equal(n, 1);
    assert.equal(q.countActive("chat"), 0, "slot released");
    assert.equal(q.listForks("chat")[0].status, "failed");
  });

  it("does not reclaim a fork that is merely still working", () => {
    const { id } = q.requestFork("chat", "long but alive");
    q.markRunning(id, "fork-chat-alive");
    assert.equal(q.reclaimStale("chat", { olderThanMs: 30 * 60_000 }), 0);
    assert.equal(q.countActive("chat"), 1);
  });
});

// --- the fork's tool surface -------------------------------------------------
// Not a queue test, but it belongs with WP3's safety contract and there is no
// better home: the fork's boundary is the one thing here that, if wrong, is a
// security bug rather than a bug.
describe("a fork's tool surface is bounded by --tools, not --allowedTools", async () => {
  const fsp = await import("node:fs");
  const url = await import("node:url");
  const { REPO_ROOT: ROOT } = await import("../../lib/root.cjs");
  const SUP = fsp.readFileSync(path.join(ROOT, "agent/supervisor/chat-supervisor.mjs"), "utf8");
  const EXEC = fsp.readFileSync(path.join(ROOT, "agent/core/stateless-executor.mjs"), "utf8");

  it("the executor passes --tools when asked (availability, not approval)", () => {
    // --allowedTools is only an auto-approve list and removes NOTHING from the
    // surface. The fork was once launched with allowedTools:"WebSearch
    // WebFetch" and a probe reported its real tools as "Bash, Edit, Read,
    // Write, …" — shell and filesystem write, in a sub-agent built to read
    // untrusted web pages.
    assert.match(EXEC, /args\.push\("--tools", list\)/);
  });

  it("the chat fork is restricted with tools:, not allowedTools:", () => {
    assert.match(SUP, /tools: FORK_TOOLS/);
    assert.ok(!/allowedTools: FORK/.test(SUP), "must not go back to the approve-list flag");
  });

  it("MCP inheritance is suppressed — --tools does not cover MCP tools", () => {
    // The second half of the same hole. `claude -p` auto-discovers .mcp.json
    // from its cwd, and the fork's cwd is the chat-agent dir — so after --tools
    // correctly stripped Bash/Edit/Write, the probe STILL reported
    // mcp__chrome-devtools (which drives Edva's already-logged-in Chrome, i.e.
    // real bank/brokerage cookies) and mcp__claude_ai_Gmail with create_draft.
    // --strict-mcp-config plus no --mcp-config leaves zero MCP servers.
    assert.match(EXEC, /args\.push\("--strict-mcp-config"\)/);
    assert.match(SUP, /strictMcpConfig: true/);
    assert.ok(!/mcpConfig:/.test(SUP.slice(SUP.indexOf("forkExecutor"), SUP.indexOf("forkExecutor") + 900)),
      "a fork must not be handed an MCP config");
  });

  it("the fork surface grants no shell, no file writes, and no MCP", () => {
    const m = SUP.match(/const FORK_TOOLS = "([^"]*)"/);
    assert.ok(m, "FORK_TOOLS must be declared");
    const granted = m[1].split(/[,\s]+/).filter(Boolean);
    for (const forbidden of ["Bash", "Edit", "Write", "NotebookEdit", "Read"]) {
      assert.ok(!granted.includes(forbidden), `${forbidden} must not be in a fork's surface`);
    }
    assert.deepEqual(granted.sort(), ["Skill", "WebFetch", "WebSearch"]);
  });
});
