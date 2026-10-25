// triage-route.test.mjs — per-message Gmail triage → ops-light (with fallback
// to the ops dispatcher), gmail-source's command-channel carve-out, and the
// --exclude-dynamic-system-prompt-sections flag gate.
//
// Run: node --test tests/triage-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTriageRouter, triageTargetFromConfig } from "../agent/supervisor/triage-route.mjs";
import { supportsCliFlag, ClaudeSession } from "../agent/supervisor/claude-session.mjs";

const AGENTS = {
  agents: {
    ops: { supervisor: { webhookPort: 9092, healthPort: 9093, gmailPubsubPort: 9090 } },
    "ops-light": { supervisor: { webhookPort: 9082, healthPort: 9083 } },
  },
};

test("target: defaults to ops-light; 'ops'/null roll back; missing ports disable", () => {
  assert.deepEqual(triageTargetFromConfig(AGENTS), { agent: "ops-light", webhookPort: 9082, healthPort: 9083 });
  const roll = structuredClone(AGENTS); roll.agents.ops.gmailTriageTarget = "ops";
  assert.equal(triageTargetFromConfig(roll), null);
  const off = structuredClone(AGENTS); off.agents.ops.gmailTriageTarget = null;
  assert.equal(triageTargetFromConfig(off), null);
  const bad = structuredClone(AGENTS); delete bad.agents["ops-light"].supervisor.webhookPort;
  assert.equal(triageTargetFromConfig(bad), null);
});

function fakeFetch({ healthy = true, postStatus = 200, throwOnPost = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ childAlive: healthy }) };
    if (throwOnPost) throw new Error("ECONNREFUSED");
    return { ok: postStatus < 300, status: postStatus };
  };
  return { fn, calls };
}

const target = { agent: "ops-light", webhookPort: 9082, healthPort: 9083 };

test("healthy ops-light: POSTs {task, source} with the bearer token; nothing local", async () => {
  const local = [];
  const { fn, calls } = fakeFetch();
  const route = makeTriageRouter({ target, localDispatch: (c, s) => local.push(s), tokenFile: "/x", readFile: () => "tok\n", fetchFn: fn });
  const r = await route("CONTENT", "gmail:abc");
  assert.equal(r.routed, "ops-light");
  assert.equal(local.length, 0);
  const post = calls.find((c) => c.init.method === "POST");
  assert.equal(post.url, "http://127.0.0.1:9082");
  assert.equal(post.init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(post.init.body), { task: "CONTENT", source: "gmail:abc" });
});

test("unhealthy ops-light, failed POST, or no target → the ops dispatcher (never dropped)", async () => {
  for (const opts of [{ healthy: false }, { postStatus: 500 }, { throwOnPost: true }]) {
    const local = [];
    const { fn } = fakeFetch(opts);
    const route = makeTriageRouter({ target, localDispatch: (c, s) => local.push([c, s]), tokenFile: "/x", readFile: () => "", fetchFn: fn });
    const r = await route("C", "gmail:1");
    assert.equal(r.routed, "local", JSON.stringify(opts));
    assert.deepEqual(local, [["C", "gmail:1"]]);
  }
  const local = [];
  const route = makeTriageRouter({ target: null, localDispatch: (c, s) => local.push(s), tokenFile: "/x" });
  await route("C", "gmail:2");
  assert.deepEqual(local, ["gmail:2"]);
});

test("gmail-source: per-message triage uses the router, the command channel stays on ops", async () => {
  const { GmailSource } = await import("../agent/supervisor/gmail-source.mjs");
  const tmp = (await import("node:fs")).mkdtempSync((await import("node:path")).join(process.env.TMPDIR || "/tmp", "trt-"));
  process.env.RECLASSIFY_TRACKING_FILE = `${tmp}/track.json`;
  const g = new GmailSource({ lastHistoryFile: `${tmp}/last.json`, pauseFlagFile: `${tmp}/.p`, triageLog: () => {} });
  const local = [], routed = [];
  g._dispatchFn = (c, s) => local.push(s);
  g._triageDispatchFn = async (c, s) => { routed.push(s); return { routed: "ops-light" }; };
  g._dispatchTriage("X", "m1");
  g._dispatchTriage("Y", "m2", { commandChannel: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(routed, ["gmail:m1"]);
  assert.deepEqual(local, ["gmail:m2"]);
  // Router rejects → falls back locally.
  g._triageDispatchFn = async () => { throw new Error("boom"); };
  g._dispatchTriage("Z", "m3");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(local.includes("gmail:m3"));
});

test("supportsCliFlag probes --help once and gates the flag", () => {
  let n = 0;
  const spawnSyncFn = () => { n++; return { status: 0, stdout: "  --exclude-dynamic-system-prompt-sections\n" }; };
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-a", spawnSyncFn }), true);
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-a", spawnSyncFn }), true);
  assert.equal(n, 1, "cached");
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-old", spawnSyncFn: () => ({ status: 0, stdout: "old help" }) }), false);
  assert.equal(supportsCliFlag("--x", { claudeBin: "/fake/broken", spawnSyncFn: () => { throw new Error("ENOENT"); } }), false);
});

test("ClaudeSession passes the flag only when asked", () => {
  const base = { sessionId: "s", model: "m" };
  assert.ok(new ClaudeSession({ ...base, excludeDynamicSystemPromptSections: true })._buildArgs({ resume: false }).includes("--exclude-dynamic-system-prompt-sections"));
  assert.ok(!new ClaudeSession(base)._buildArgs({ resume: false }).includes("--exclude-dynamic-system-prompt-sections"));
});
