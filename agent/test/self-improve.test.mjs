// self-improve.test.mjs — WP11 gated runtime self-improvement. Real approval-gate
// (tmp DB) for the security-critical two-phase handshake; fakes for loader/store/
// notify/exec; a tmp filesystem for ext/staging. Every safety property is asserted.
//
// Run: node --test agent/test/self-improve.test.mjs

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DB = path.join(os.tmpdir(), `selfimprove-approval-${process.pid}.db`);
process.env.MEMORY_INDEX_DB = TMP_DB;
// A synthetic installation: one extra financial-rail name from local config.
const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "si-local-"));
fs.mkdirSync(path.join(LOCAL_DIR, "config"));
fs.writeFileSync(path.join(LOCAL_DIR, "config", "self-improve-rails.json"), JSON.stringify({ forbidden_names: ["acmebroker"] }));
process.env.EDVA_LOCAL_DIR = LOCAL_DIR;
const { createApprovalGate } = await import("../core/approval-gate.mjs");
const { createSelfImprove, analyzeModule, FORBIDDEN_PATTERNS } = await import("../core/self-improve.mjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "si-root-"));
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });

function fakeLoader() {
  const calls = { load: [], reload: [], unload: [] };
  const loaded = new Set();
  return {
    calls, loaded,
    has: (n) => loaded.has(n),
    async loadPlugin(dir) { const n = path.basename(dir); calls.load.push(n); loaded.add(n); return n; },
    async reloadPlugin(n) { calls.reload.push(n); return n; },
    unloadPlugin(n) { calls.unload.push(n); loaded.delete(n); return true; },
  };
}
function fakeStore() { const events = []; return { events, appendMessage: (e) => events.push(e) }; }

function makeSI(overrides = {}) {
  const gate = createApprovalGate({});
  const loader = fakeLoader();
  const store = fakeStore();
  const notified = [];
  const si = createSelfImprove({
    root: ROOT,
    extDir: path.join(ROOT, "ext"),
    stagingDir: path.join(ROOT, "ext/.staging"),
    approvalGate: gate,
    pluginLoader: loader,
    store,
    notify: async (s, d) => notified.push({ s, d }),
    exec: null,
    ...overrides,
  });
  return { si, gate, loader, store, notified };
}

const SKILL_FILES = {
  "manifest.json": JSON.stringify({ name: "greet-helper", version: "1.0.0", contributes: [{ kind: "skill", name: "greet", description: "how to greet", body: "Be warm." }] }),
};

function cleanup() {
  try { fs.rmSync(path.join(ROOT, "ext"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, "data/self-improve-disabled"), { force: true }); } catch {}
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
}
after(() => { cleanup(); try { fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(LOCAL_DIR, { recursive: true, force: true }); } catch {} });
beforeEach(cleanup);

describe("static rails scan (capability ceiling)", () => {
  it("refuses financial / destructive / outbound references", () => {
    assert.equal(analyzeModule({ "a.mjs": "const x = plaidClient()" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "await stripeCharge()" }).ok, false);
    // an installation's own account names (local config) join the rails
    assert.equal(analyzeModule({ "a.mjs": "await acmebrokerTrade()" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "exec('rm -rf /')" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "git push origin" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "sendApnsPush(x)" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "import { spawn } from 'node:child_process'" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "fetch('https://evil.com')" }).ok, false);
    assert.equal(analyzeModule({ "a.mjs": "process.env.SUPABASE_SERVICE_ROLE_KEY" }).ok, false);
  });
  it("allows a benign skill / compute module", () => {
    assert.equal(analyzeModule(SKILL_FILES).ok, true);
    assert.equal(analyzeModule({ "index.mjs": "export default (api)=>api.registerTool({name:'add',handler:({a,b})=>({sum:a+b})})" }).ok, true);
  });
});

describe("propose: nothing runs before approval", () => {
  it("stages + creates approval + notifies, but does NOT load", async () => {
    const { si, loader, store, notified } = makeSI();
    const res = await si.proposeModule("greet-helper", SKILL_FILES, { rationale: "warm greetings" });
    assert.equal(res.ok, true);
    assert.equal(res.pending, true);
    assert.ok(res.approval_id);
    // staged, NOT in ext/, NOT loaded
    assert.ok(fs.existsSync(path.join(ROOT, "ext/.staging/greet-helper/manifest.json")));
    assert.ok(!fs.existsSync(path.join(ROOT, "ext/greet-helper")));
    assert.equal(loader.calls.load.length, 0, "no load before approval");
    assert.equal(loader.calls.reload.length, 0);
    // owner was notified with the code for review
    assert.equal(notified.length, 1);
    assert.match(notified[0].d, /manifest\.json/);
    // audited
    assert.ok(store.events.some((e) => e.kind === "self_improve.proposed"));
  });

  it("REFUSES a rails-hitting module at propose time — nothing staged, no approval", async () => {
    const { si, gate, notified } = makeSI();
    const res = await si.proposeModule("sneaky", { "index.mjs": "export default (api)=>{ fetch('https://x'); }" }, { rationale: "exfil" });
    assert.equal(res.ok, false);
    assert.equal(res.refused, true);
    assert.ok(res.hits.length > 0);
    assert.ok(!fs.existsSync(path.join(ROOT, "ext/.staging/sneaky")), "nothing staged");
    assert.equal(gate.pending("self-improve").length, 0, "no approval created");
    assert.equal(notified.length, 0);
  });
});

describe("approve: only the owner path loads it, exactly once", () => {
  it("approve() promotes staging → ext and hot-loads it", async () => {
    const { si, loader } = makeSI();
    const { approval_id } = await si.proposeModule("greet-helper", SKILL_FILES, { rationale: "x" });
    const res = await si.approve(approval_id);
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(path.join(ROOT, "ext/greet-helper/manifest.json")), "promoted to ext/");
    assert.ok(!fs.existsSync(path.join(ROOT, "ext/.staging/greet-helper")), "staging cleared");
    assert.equal(loader.calls.load.length, 1, "loaded exactly once");
    // a second approve is rejected (no double-load)
    const again = await si.approve(approval_id);
    assert.equal(again.ok, false);
    assert.equal(loader.calls.load.length, 1);
  });

  it("deny() discards the staged module and never loads", async () => {
    const { si, loader } = makeSI();
    const { approval_id } = await si.proposeModule("greet-helper", SKILL_FILES, { rationale: "x" });
    const d = si.deny(approval_id, "not needed");
    assert.equal(d.ok, true);
    assert.ok(!fs.existsSync(path.join(ROOT, "ext/.staging/greet-helper")), "staged files discarded");
    const res = await si.approve(approval_id);
    assert.equal(res.ok, false, "cannot approve a denied proposal");
    assert.equal(loader.calls.load.length, 0);
  });
});

describe("confinement + secrets + kill-switch + naming", () => {
  it("readOwnSource denies secrets, allows normal files", () => {
    fs.writeFileSync(path.join(ROOT, "readme.txt"), "hello");
    assert.equal(si0().readOwnSource("readme.txt").content, "hello");
    assert.equal(si0().readOwnSource(".env").ok, false);
    assert.equal(si0().readOwnSource("secrets/x").ok, false);
    assert.equal(si0().readOwnSource("../../etc/passwd").ok, false); // escapes root
    function si0() { return makeSI().si; }
  });

  it("rejects path traversal in file names and bad module names", async () => {
    const { si } = makeSI();
    assert.equal((await si.proposeModule("../evil", SKILL_FILES, {})).ok, false);
    assert.equal((await si.proposeModule("BadName", SKILL_FILES, {})).ok, false);
    const trav = await si.proposeModule("ok-name", { "../../escape.mjs": "x" }, {});
    assert.equal(trav.ok, false);
  });

  it("kill-switch blocks proposals and loads", async () => {
    const { si, loader } = makeSI();
    // stage+approve one to have a pending, then flip the switch before approving another
    si.killSwitch(true);
    const res = await si.proposeModule("greet-helper", SKILL_FILES, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /kill-switch/);
    assert.equal(loader.calls.load.length, 0);
    si.killSwitch(false);
    assert.equal((await si.proposeModule("greet-helper", SKILL_FILES, {})).ok, true);
  });
});
