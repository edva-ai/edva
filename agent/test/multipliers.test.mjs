// multipliers.test.mjs — WP10 (context hooks), WP9 (skills), WP14 (checkLater).
//
// Run: node --test agent/test/multipliers.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createContextHookRegistry } from "../core/context-hooks.mjs";
import { createSkillRegistry, parseSkill } from "../core/skills.mjs";
import { createToolRegistry } from "../core/tool-registry.mjs";
import { createBrowserTool } from "../capabilities/browser.mjs";

const TMP_DB = path.join(os.tmpdir(), `checklater-test-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
const cl = await import("../core/check-later.mjs");
const snipSemantic = await import("../core/snip-semantic.mjs");
const { createApprovalGate } = await import("../core/approval-gate.mjs");

// ---- WP10 context hooks ----------------------------------------------------

describe("context hooks (WP10)", () => {
  it("concatenates systemAppend from hooks in order", async () => {
    const reg = createContextHookRegistry();
    reg.registerContextHook(() => ({ systemAppend: "now: 9am" }));
    reg.registerContextHook(() => ({ systemAppend: "on-call: yes" }));
    const { systemAppend } = await reg.runHooks({});
    assert.equal(systemAppend, "now: 9am\n\non-call: yes");
  });

  it("assembleSystem appends to the base prompt", async () => {
    const reg = createContextHookRegistry();
    reg.registerContextHook(() => ({ systemAppend: "LIVE" }));
    assert.equal(await reg.assembleSystem("BASE", {}), "BASE\n\nLIVE");
  });

  it("fails open on a throwing hook (others still contribute)", async () => {
    const reg = createContextHookRegistry();
    reg.registerContextHook(() => { throw new Error("boom"); });
    reg.registerContextHook(() => ({ systemAppend: "survived" }));
    const { systemAppend } = await reg.runHooks({});
    assert.equal(systemAppend, "survived");
  });

  it("fails open on a slow hook (timeout)", async () => {
    const reg = createContextHookRegistry({ timeoutMs: 30 });
    reg.registerContextHook(() => new Promise((r) => setTimeout(() => r({ systemAppend: "too late" }), 500)));
    reg.registerContextHook(() => ({ systemAppend: "fast" }));
    const { systemAppend } = await reg.runHooks({});
    assert.equal(systemAppend, "fast");
  });

  it("supports async hooks and unregister", async () => {
    const reg = createContextHookRegistry();
    const off = reg.registerContextHook(async () => ({ systemAppend: "async" }));
    assert.match((await reg.runHooks({})).systemAppend, /async/);
    off();
    assert.equal(reg.count(), 0);
    assert.equal((await reg.runHooks({})).systemAppend, "");
  });
});

// ---- WP9 skills ------------------------------------------------------------

describe("skills (WP9)", () => {
  const dir = path.join(os.tmpdir(), `skills-test-${process.pid}`);
  before(() => {
    fs.mkdirSync(path.join(dir, "triage-email"), { recursive: true });
    fs.mkdirSync(path.join(dir, "book-table"), { recursive: true });
    fs.writeFileSync(path.join(dir, "triage-email", "SKILL.md"),
      "---\nname: triage-email\ndescription: Sort and label the inbox\nwhen_to_use: an email arrives\n---\n# Body\nStep 1. read it.\nStep 2. label it.\n");
    fs.writeFileSync(path.join(dir, "book-table", "SKILL.md"),
      "---\nname: book-table\ndescription: Find and book a table\n---\nlong body here\n");
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("parseSkill extracts frontmatter + body", () => {
    const s = parseSkill("---\nname: x\ndescription: does x\n---\nthe body\n");
    assert.equal(s.name, "x");
    assert.equal(s.description, "does x");
    assert.equal(s.body, "the body");
  });

  it("loads skills from a dir, sorted", () => {
    const reg = createSkillRegistry(dir);
    assert.equal(reg.count(), 2);
    assert.deepEqual(reg.list().map((s) => s.name), ["book-table", "triage-email"]);
  });

  it("buildIndex is one compact line per skill — bodies NOT included", () => {
    const reg = createSkillRegistry(dir);
    const idx = reg.buildIndex();
    assert.match(idx, /- triage-email: Sort and label the inbox — an email arrives/);
    assert.match(idx, /- book-table: Find and book a table/);
    assert.doesNotMatch(idx, /Step 1/, "body text must not be in the index");
  });

  it("loadBody pulls the full procedure on demand", () => {
    const reg = createSkillRegistry(dir);
    const body = reg.loadBody("triage-email");
    assert.match(body, /Step 1\. read it\./);
    assert.equal(reg.loadBody("nonexistent"), null);
  });

  it("empty/missing dir yields an empty registry (no throw)", () => {
    const reg = createSkillRegistry(path.join(os.tmpdir(), `no-such-${process.pid}`));
    assert.equal(reg.count(), 0);
    assert.equal(reg.buildIndex(), "");
  });
});

// ---- WP14 checkLater -------------------------------------------------------

describe("checkLater (WP14)", () => {
  function cleanup() {
    cl._closeForTest();
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
  }
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it("schedules a wake and clamps seconds to [1, MAX_CHECK_LATER_SECONDS]", () => {
    const now = 1_000_000;
    const MAX = cl.MAX_CHECK_LATER_SECONDS;
    const w = cl.checkLater("ops", 60, "poll the PR", { now });
    assert.equal(w.seconds, 60);
    assert.equal(w.wakeAt, now + 60_000);
    assert.equal(cl.checkLater("ops", MAX + 9999, "x", { now }).seconds, MAX);   // clamped to cap
    assert.equal(cl.checkLater("ops", 0, "x", { now }).seconds, 1);              // floored
  });

  it("dueWakes returns only wakes whose time has passed", () => {
    const now = 1_000_000;
    cl.checkLater("ops", 60, "soon", { now });     // wake_at now+60s
    cl.checkLater("ops", 5, "sooner", { now });    // wake_at now+5s
    assert.equal(cl.dueWakes({ now }).length, 0, "nothing due yet");
    const due = cl.dueWakes({ now: now + 10_000 });
    assert.equal(due.length, 1);
    assert.equal(due[0].note, "sooner");
  });

  it("markFired removes a wake from the due set (one-shot)", () => {
    const now = 1_000_000;
    const w = cl.checkLater("ops", 5, "once", { now });
    const due = cl.dueWakes({ now: now + 10_000 });
    assert.equal(due.length, 1);
    cl.markFired(w.id);
    assert.equal(cl.dueWakes({ now: now + 10_000 }).length, 0);
  });

  it("persists across a DB reopen (survives a supervisor bounce)", () => {
    const now = 1_000_000;
    cl.checkLater("ops", 120, "survive the bounce", { now });
    cl._closeForTest();                            // simulate a restart
    const pend = cl.pendingWakes("ops");
    assert.equal(pend.length, 1);
    assert.equal(pend[0].note, "survive the bounce");
  });
});

// ---- Multiplier 4: snip-semantic tool + backfill (WP7 #2) ------------------
// The chat supervisor wires hybrid_snip_search into a WP1 tool registry and
// runs indexPendingSnips on a tick. These assert the two new surfaces the
// supervisor depends on: the registry-executable tool envelope (fail-open when
// nothing is indexed / the embedder is down) and the backfill no-op contract.

describe("snip-semantic tool + backfill (Multiplier 4)", () => {
  function cleanup() {
    snipSemantic._closeForTest();
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
  }
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  // Register the tool the way a registry-owning consumer does, so this locks in
  // the wiring contract (name, deferred-by-default, executeTool envelope shape).
  // NOTE: chat-supervisor.mjs carried this wiring until it was
  // retired there (inert under `--resume` — no snips ever existed). The contract
  // still matters: the stateless/fork path is where a registry is reachable.
  function registryWithSnipTool() {
    const reg = createToolRegistry();
    reg.registerTool({
      name: "hybrid_snip_search",
      description: "Search this chat session's compressed context breadcrumbs.",
      schema: { type: "object", properties: { query: { type: "string" }, k: { type: "number" } }, required: ["query"] },
      handler: async ({ query, k = 5 } = {}) => ({ results: await snipSemantic.hybridSnipSearch("chat", query, { k }) }),
    });
    return reg;
  }

  it("registers hybrid_snip_search as a deferred tool", () => {
    const reg = registryWithSnipTool();
    assert.ok(reg.has("hybrid_snip_search"));
    assert.equal(reg.isDeferred("hybrid_snip_search"), true, "off the allowlist → deferred, so its schema stays out of the prompt");
    const manifest = reg.getDeferredTools({ filter: "snip" });
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].name, "hybrid_snip_search");
  });

  it("executeTool returns a fail-open {ok:true, results:[]} when nothing is indexed", async () => {
    const reg = registryWithSnipTool();
    const out = await reg.executeTool("hybrid_snip_search", { query: "anything" });
    assert.equal(out.ok, true, "normalized envelope");
    assert.deepEqual(out.results, [], "no vectors indexed → empty, never throws");
  });

  it("indexPendingSnips is a no-op with no pending snips (mock embedder, no Ollama)", async () => {
    const embed = async () => new Array(8).fill(0.1);   // deterministic, no network
    const res = await snipSemantic.indexPendingSnips("chat", { embed });
    assert.deepEqual(res, { indexed: 0, skipped: 0 });
  });
});

// ---- Multiplier 5: CAP tools + browser.click behind approval-gate ----------
// A registry-owning consumer loads the CAP plugin into its WP1 registry and
// gates the browser tool's MUTATING click behind the WP7 approval-gate, while
// read-only actions pass through (Financial Operations: financial-site access
// is information-only, but never click a button that initiates a payment). This
// replicates that wiring against an injected mock cdp (no live Chrome).
// NOTE: chat-supervisor.mjs carried it until it was retired (the
// `--resume` executor ignores `tools`, so the registry was never reachable).
// The gate contract is what any future stateless/fork consumer must honor.

describe("CAP browser.click behind approval-gate (Multiplier 5)", () => {
  let gate;
  function cleanup() {
    try { gate?._closeForTest(); } catch {}
    for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
  }
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  // Build registry + gated browser exactly as chat-supervisor.mjs does, but with
  // an injected cdp so nothing touches a real browser.
  function gatedBrowserRegistry() {
    const cdpCalls = [];
    const mockCdp = (args) => {
      cdpCalls.push(args);
      if (args[0] === "eval" && /clicked/.test(args[1] || "")) return '{"clicked":true}';
      return JSON.stringify({ title: "t", url: "u", text: "body", links: [], controls: [] });
    };
    const reg = createToolRegistry();
    gate = createApprovalGate({ execute: (n, i) => reg.executeTool(n, i) });
    reg.registerTool(createBrowserTool({ cdp: mockCdp }));
    const raw = reg.get("browser");
    const rawHandler = raw.handler;
    const gated = gate.gate({ name: "browser", handler: rawHandler }, { agentId: "chat", risk: "high" });
    reg.registerTool({
      name: "browser",
      description: raw.description,
      schema: raw.schema,
      handler: async (input = {}) => (input.action === "click" ? gated.handler(input) : rawHandler(input)),
    });
    return { reg, cdpCalls };
  }

  it("read passes through the gate untouched (information-only)", async () => {
    const { reg, cdpCalls } = gatedBrowserRegistry();
    const rd = await reg.executeTool("browser", { action: "read", url: "https://example.com" });
    assert.equal(rd.ok, true);
    assert.ok(cdpCalls.length >= 1, "read drove the (mock) browser directly");
  });

  it("click defers to owner approval — side effect NOT run, pending row created", async () => {
    const { reg, cdpCalls } = gatedBrowserRegistry();
    const before = cdpCalls.length;
    const clk = await reg.executeTool("browser", { action: "click", selector: "#place-order" });
    assert.equal(clk.ok, false);
    assert.equal(clk.needs_approval, true);
    assert.ok(clk.approval_id, "a pending approval id is returned");
    assert.equal(cdpCalls.length, before, "the click did NOT touch the browser before approval");
    assert.equal(gate.pending("chat").length, 1);
  });

  it("owner approve() runs the real click exactly once", async () => {
    const { reg, cdpCalls } = gatedBrowserRegistry();
    const { approval_id } = await reg.executeTool("browser", { action: "click", selector: "#place-order" });
    const before = cdpCalls.length;
    const res = await gate.approve(approval_id);
    assert.equal(res.ok, true);
    assert.ok(cdpCalls.length > before, "the click executed only after approval");
    assert.equal(gate.pending("chat").length, 0);
  });
});
