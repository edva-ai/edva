// self-improve.mjs — WP11: gated runtime self-improvement (the agent extends itself).
//
// Goal: when Edva hits a recurring need with no capability, it can AUTHOR a
// module (a skill, or a read/compute tool) and — ONLY after the owner reviews the
// actual code and approves — load it live via the WP5 plugin loader, no redeploy.
//
// THIS IS THE HIGHEST-RISK SURFACE IN THE SYSTEM (self-authored code on a box with
// financial rails + a logged-in browser). Every safety property here is deliberate
// and FAILS CLOSED. Design (see system/wp11-self-improvement-gate-design.md):
//   (a) Owner approval is the real gate — a proposed module is STAGED, never run,
//       until approve(id) is called out-of-band from the trusted owner channel.
//       No durable approval record → refuse (fail closed).
//   (b) Writes are confined to extDir; readOwnSource is read-only + denies secrets.
//   (c) Static rails scan REFUSES at propose time any module referencing financial
//       rails, destructive ops, or outbound channels — it can't even be offered.
//   (d) Non-owner channels can't reach propose/approve (wired chat-only, out of band).
//   Plus: full WP4 audit of every write/propose/approve/deny, git-commit on approve
//   (reversibility), a global kill-switch, and fail-isolated loading (WP5 loader).
//
// Pure orchestration over injected deps (approvalGate, pluginLoader, store, notify,
// exec) → unit-testable with fakes, no real git/model/fs-side-effects in tests.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { installRoot, KERNEL_SUBDIR } from "../../lib/root.cjs";

const { localConfig } = createRequire(import.meta.url)("../../lib/instance.cjs");

// ---- static rails: what a self-authored module may NEVER reference ----------
// Mirrors the spirit of data/self-improvement-risk-rubric.md §2 FORBIDDEN.
// A hit here REFUSES the proposal outright (not "second confirm").
// Match at a word start with ANY continuation (so "plaidClient"/"stripeCharge"
// are caught). Conservative on purpose — a false positive just refuses a
// proposal (the agent can rephrase); owner review is the real gate underneath.
// The installation's own financial accounts and services (brokerages, payment
// providers) join the financial rails by name, from
// agent/local/config/self-improve-rails.json `forbidden_names`.
const LOCAL_RAILS = localConfig("self-improve-rails", { forbidden_names: [] });
export const FORBIDDEN_PATTERNS = [
  // financial rails
  /\bplaid/i, ...LOCAL_RAILS.forbidden_names.map((n) => new RegExp(`\\b${n}`, "i")), /\bticket-?purchase/i,
  /\btransfer/i, /\bwithdraw/i, /\bzelle/i, /\bstripe/i, /\bissuing/i,
  // destructive / privileged ops
  /\brm\s+-rf/i, /\bgit\s+push/i, /--force/i, /\bsudo/i, /keychain/i,
  /security\s+(find|add|delete)-generic-password/i, /\bop\s+(read|run|item)/i,
  /\.credentials/i, /SUPABASE_SERVICE_ROLE_KEY/, /process\.env/,
  // outbound / privileged capabilities (network, subprocess, identity channels)
  /email-send/i, /gmail-action/i, /\bimsg\b/i, /whatsapp/i, /edva-send/i,
  /sendApnsPush/i, /edva-notify/i, /\bfetch\s*\(/i, /child_process/i, /\bexec(File|Sync)?\b/i,
  /\bspawn\b/i,
];

// Read-only source is denied for anything secret-bearing. The secrets and
// credentials dirs sit in the kernel tree (<repo>/tools/ or the repo root).
const KDIR = KERNEL_SUBDIR ? `${KERNEL_SUBDIR}\\/` : "";
const READ_DENYLIST = [
  /\.env(\.|$)/i, new RegExp(`${KDIR}secrets\\/`, "i"), new RegExp(`${KDIR}credentials\\/`, "i"), /\.credentials/i,
  /\.p8$/i, /\.pem$/i, /keychain/i, /\.key$/i, /asc-key/i,
];

export function analyzeModule(files = {}) {
  const hits = [];
  for (const [fname, content] of Object.entries(files)) {
    const text = String(content || "");
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(text)) hits.push({ file: fname, pattern: String(pat) });
    }
  }
  return { ok: hits.length === 0, hits };
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  const b = path.resolve(base);
  if (p !== b && !p.startsWith(b + path.sep)) return null; // escapes base → reject
  if (String(rel).includes("..")) return null;
  return p;
}

export function createSelfImprove({
  root = process.env.HOME ? installRoot() : process.cwd(),
  extDir = null,                 // where approved modules live
  stagingDir = null,             // where proposals are staged pre-approval
  approvalGate,                  // createApprovalGate(...) — REQUIRED
  pluginLoader = null,           // createPluginLoader(...) bound to the live registry
  store = null,                  // WP4 message-store (audit) — { appendMessage }
  notify = null,                 // async (summary, detail) => deliver approval request to owner
  exec = null,                   // async (cmd, args, opts) => {} for git-commit on approve (optional)
  now = () => Date.now(),
  disableFlag = null,            // kill-switch sentinel path
} = {}) {
  if (!approvalGate || typeof approvalGate.gate !== "function") {
    throw new Error("self-improve: an approvalGate (core/approval-gate.mjs) is required");
  }
  const EXT = extDir || path.join(root, "agent/ext");
  const STAGE = stagingDir || path.join(EXT, ".staging");
  const KILL = disableFlag || path.join(root, "data/self-improve-disabled");

  const audit = (kind, data) => {
    try { store?.appendMessage?.({ agentId: "self-improve", role: "system", kind, content: data, ts: now() }); } catch {}
  };
  const killed = () => { try { return fs.existsSync(KILL); } catch { return false; } };

  // The REAL side-effecting action, wrapped by the approval gate: promote a staged
  // module to EXT, git-commit it, and hot-load it. Runs ONLY via approve().
  async function _loadApproved({ name } = {}) {
    if (killed()) return { ok: false, error: "self-improve: kill-switch active — loading disabled" };
    const staged = safeJoin(STAGE, name);
    const dest = safeJoin(EXT, name);
    if (!staged || !dest) return { ok: false, error: "self-improve: invalid module name" };
    if (!fs.existsSync(staged)) return { ok: false, error: `self-improve: no staged module '${name}'` };
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(staged, dest, { recursive: true });
      fs.rmSync(staged, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `self-improve: promote failed (${e.message})` };
    }
    // Git-commit for reversibility (best-effort; never blocks the load).
    if (exec) {
      try {
        await exec("git", ["add", "--", path.relative(root, dest)], { cwd: root });
        await exec("git", ["commit", "-m", `self-improve: load agent-authored module '${name}' (owner-approved)`], { cwd: root });
      } catch (e) { audit("self_improve.git_commit_failed", { name, error: e.message }); }
    }
    let loaded = { loaded: [name], failed: [] };
    if (pluginLoader) {
      try {
        if (pluginLoader.has?.(name)) await pluginLoader.reloadPlugin(name);
        else await pluginLoader.loadPlugin(dest);
      } catch (e) {
        audit("self_improve.load_failed", { name, error: e.message });
        return { ok: false, error: `self-improve: module '${name}' loaded to disk but failed to activate (${e.message})` };
      }
    }
    audit("self_improve.loaded", { name });
    return { ok: true, name, loaded };
  }

  const gatedLoad = approvalGate.gate(
    { name: "self_improve.load", handler: _loadApproved },
    { risk: "critical", agentId: "self-improve", describe: (i) => `Load agent-authored module '${i.name}'` }
  );

  // ---- read-only source access (denies secrets) ------------------------------
  function readOwnSource(relPath) {
    const p = safeJoin(root, relPath);
    if (!p) return { ok: false, error: "readOwnSource: path escapes repo root" };
    if (READ_DENYLIST.some((re) => re.test(relPath))) {
      audit("self_improve.read_denied", { path: relPath });
      return { ok: false, error: "readOwnSource: reading secrets is denied" };
    }
    try { return { ok: true, path: relPath, content: fs.readFileSync(p, "utf8") }; }
    catch (e) { return { ok: false, error: `readOwnSource: ${e.message}` }; }
  }

  // ---- propose: analyze → refuse-or-stage → approval request -----------------
  // files: { "manifest.json": "...", "index.mjs": "...", ... } (relative names).
  async function proposeModule(name, files = {}, { rationale = "", agentId = "chat" } = {}) {
    if (killed()) return { ok: false, error: "self-improve: kill-switch active — proposals disabled" };
    if (!name || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) {
      return { ok: false, error: "self-improve: module name must be kebab-case [a-z0-9-], 2-49 chars" };
    }
    if (!files || typeof files !== "object" || !Object.keys(files).length) {
      return { ok: false, error: "self-improve: at least one file is required" };
    }
    // (c) static rails scan — a hit REFUSES outright.
    const scan = analyzeModule(files);
    if (!scan.ok) {
      audit("self_improve.refused", { name, rationale, hits: scan.hits, agentId });
      return { ok: false, refused: true, error: "self-improve: proposal references forbidden rails (financial/destructive/outbound) — refused", hits: scan.hits };
    }
    // Stage the files (path-confined). Never into EXT until approved.
    const stageRoot = safeJoin(STAGE, name);
    if (!stageRoot) return { ok: false, error: "self-improve: invalid module name" };
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.mkdirSync(stageRoot, { recursive: true });
      for (const [fname, content] of Object.entries(files)) {
        const fp = safeJoin(stageRoot, fname);
        if (!fp) return { ok: false, error: `self-improve: invalid file path '${fname}'` };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, String(content));
      }
    } catch (e) {
      return { ok: false, error: `self-improve: staging failed (${e.message})` };
    }
    audit("self_improve.proposed", { name, rationale, files: Object.keys(files), agentId });
    // (a) create the durable approval — this does NOT run anything.
    const pend = await gatedLoad.handler({ name });
    if (!pend?.approval_id) return { ok: false, error: pend?.error || "self-improve: could not create approval" };
    // Deliver the review request to the owner OUT OF BAND (channel chosen by the
    // injected notify — email/phone/etc). notify gets (summary, code, meta) so the
    // channel can render the full code + the unguessable approval id (the shared
    // secret an owner reply must echo).
    const summary = `Edva wrote a module: "${name}" — ${rationale || "(no rationale given)"}`;
    const code = renderDiff(name, files);
    try { await notify?.(summary, code, { approvalId: pend.approval_id, name, rationale }); }
    catch (e) { audit("self_improve.notify_failed", { name, error: e.message }); }
    return { ok: true, pending: true, approval_id: pend.approval_id, name, summary };
  }

  // ---- owner-only decisions (called out of band from the trusted channel) ----
  async function approve(approvalId) {
    if (killed()) return { ok: false, error: "self-improve: kill-switch active" };
    const res = await approvalGate.approve(approvalId);   // runs _loadApproved exactly once
    audit("self_improve.approve", { approvalId, ok: res?.ok, result: res?.result });
    return res;
  }
  function deny(approvalId, reason = "") {
    const row = approvalGate.get?.(approvalId);
    const res = approvalGate.deny(approvalId, reason);
    // Discard the staged files on denial.
    try { const name = row?.tool === "self_improve.load" ? JSON.parse(row.input_json || "{}").name : null; if (name) { const s = safeJoin(STAGE, name); if (s) fs.rmSync(s, { recursive: true, force: true }); } } catch {}
    audit("self_improve.deny", { approvalId, reason, ok: res?.ok });
    return res;
  }

  function pendingProposals() { return (approvalGate.pending?.("self-improve") || []).filter((p) => p.tool === "self_improve.load"); }
  function listModules() { try { return fs.readdirSync(EXT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name); } catch { return []; } }
  function unloadModule(name) { try { if (pluginLoader?.has?.(name)) pluginLoader.unloadPlugin(name); const p = safeJoin(EXT, name); if (p) fs.rmSync(p, { recursive: true, force: true }); audit("self_improve.unloaded", { name }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
  function killSwitch(on) { try { if (on) fs.writeFileSync(KILL, `disabled ${new Date(now()).toISOString()}\n`); else fs.rmSync(KILL, { force: true }); audit("self_improve.kill_switch", { on }); return { ok: true, disabled: !!on }; } catch (e) { return { ok: false, error: e.message }; } }

  return {
    readOwnSource, proposeModule, approve, deny,
    pendingProposals, listModules, unloadModule, killSwitch,
    analyzeModule, isKilled: killed,
    EXT, STAGE, KILL,
  };
}

function renderDiff(name, files) {
  const lines = [`Module: ${name}`, `Files: ${Object.keys(files).join(", ")}`, ""];
  for (const [fname, content] of Object.entries(files)) {
    lines.push(`── ${fname} ──`);
    const body = String(content);
    lines.push(body.length > 2000 ? body.slice(0, 2000) + "\n…(truncated)" : body);
    lines.push("");
  }
  return lines.join("\n");
}
