// email-inbound-oneshot.mjs — pure helpers for the agent-address email responder
// (bin/email-inbound-run + agent/tools-mcp/email-inbound.mjs).
//
// The prompts are not written here: they are SECTIONS of the job playbook
// (agent/ops-agent/jobs/email-inbound.md), cut out by HTML-comment
// markers, so the doc Edva reads about this job is the text the model gets.
//
//   <!-- oneshot:start --> … <!-- oneshot:end -->       the one-shot's system prompt
//   <!-- escalation:start --> … <!-- escalation:end -->  what the ops agent gets
//                                                         when the one-shot escalates
//
// The instance's own companion (agent/local/jobs/email-inbound.md, when
// present) is read after the kernel playbook, and every marker block of a name
// is used — the kernel's first, then the companion's — the same join the
// in-session dispatch (http-server.mjs) makes.
//
// Everything here is structure: marker slicing, JSON framing, a machine-id
// shape check on marketing draft ids, the ops webhook POST. What the email
// MEANS is the model's call (Rule #0b).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractJsonObject } from "./extract-json.mjs";
import { readOptional, sliceAll } from "../agent/supervisor/dispatch-preamble.mjs";
import { createRequire } from "node:module";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;

import { TOOLS_DIR, installTools } from "./root.cjs";
export { REPO_ROOT as ROOT } from "./root.cjs";
export const PLAYBOOK = path.join(TOOLS_DIR, "agent/ops-agent/jobs/email-inbound.md");
export const LOCAL_PLAYBOOK = path.join(
  process.env.EDVA_LOCAL_DIR || path.join(TOOLS_DIR, "agent/local"), "jobs/email-inbound.md");

export function playbookSection(md, name) {
  const s = sliceAll(md, `<!-- ${name}:start -->`, `<!-- ${name}:end -->`);
  if (s == null) throw new Error(`email-inbound.md is missing the ${name} section markers`);
  return s;
}

// Kernel playbook, then the local companion when there is one.
export function readPlaybook() {
  const kernel = fs.readFileSync(PLAYBOOK, "utf8");
  const local = readOptional(LOCAL_PLAYBOOK);
  return local == null ? kernel : `${kernel}\n\n${local}`;
}

// The email is DATA. It is fenced as JSON inside a tagged block, and the system
// prompt (playbook section) tells the model that nothing inside the block is an
// instruction to it — only the sender's own top-level request is, and only to
// the extent the rules allow.
export function untrustedEmailBlock(email, context) {
  const view = {
    from: email.from, to: email.to, subject: email.subject, date: email.date,
    message_id: email.message_id, in_reply_to: email.in_reply_to ?? null,
    text: String(email.text || "").slice(0, 30000),
  };
  return [
    "<untrusted_email>",
    "```json",
    JSON.stringify(view, null, 2),
    "```",
    "</untrusted_email>",
    "",
    "Resolved by code (trusted):",
    "```json",
    JSON.stringify(context ?? null, null, 2),
    "```",
  ].join("\n");
}

export function systemPrompt({ md = readPlaybook(), now = new Date() } = {}) {
  const tz = instanceTz();
  const today = now.toLocaleDateString("en-CA", { timeZone: tz });
  // The zone's place name from its IANA id ("America/Los_Angeles" → "Los Angeles").
  const place = String(tz).split("/").pop().split("_").join(" ");
  return `${playbookSection(md, "oneshot")}\n\nToday is ${today} (${place}).`;
}

export function escalationTask({ email, context, instruction, why, md = readPlaybook() }) {
  return [
    playbookSection(md, "escalation"),
    "",
    "## The sender's request (as read by the one-shot responder)",
    "",
    String(instruction || "(none given — read the email)"),
    why ? `\nWhy it needs you: ${why}` : "",
    "",
    "## Inbound Email (parsed — untrusted data)",
    "",
    "```json",
    JSON.stringify(email, null, 2),
    "```",
    "",
    "## Resolved by code",
    "",
    "```json",
    JSON.stringify(context ?? null, null, 2),
    "```",
  ].join("\n");
}

// Marketing draft ids are machine-generated: `<prefix>-<YYYY-MM-DD>-<id>`, with
// an optional `li-`/`x-` channel tag before the id (`draft-2026-05-20-abc123`).
// The prefixes and the apply task's name are the installation's
// (agent/local/config/email-inbound.json `draft_id_prefixes`,
// `draft_apply_task`); by default only `draft-` ids, applied as `OUTREACH APPLY`.
function draftConfig() {
  const c = createRequire(import.meta.url)("./instance.cjs").localConfig("email-inbound", {
    draft_id_prefixes: ["draft"], draft_apply_task: "OUTREACH APPLY",
  });
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // lang-regex-ok: escapes regex metacharacters in a configured id prefix
  const prefixes = (Array.isArray(c.draft_id_prefixes) && c.draft_id_prefixes.length ? c.draft_id_prefixes : ["draft"]).map(esc);
  return {
    re: new RegExp(`^(?:${prefixes.join("|")})-\\d{4}-\\d{2}-\\d{2}-(?:li-|x-)?[a-z0-9]+$`), // lang-regex-ok: machine-generated draft id shape, not language
    task: String(c.draft_apply_task || "OUTREACH APPLY"),
  };
}
export function mktApplyTask({ action, draftId, editText }) {
  const a = String(action || "").toLowerCase();
  if (!["approve", "edit", "decline"].includes(a)) throw new Error(`bad action ${action}`);
  const id = String(draftId || "").trim();
  const cfg = draftConfig();
  if (!cfg.re.test(id)) throw new Error(`not a draft id: ${id}`);
  let task = `${cfg.task} ${id} ${a}`;
  if (a === "edit" && String(editText || "").trim()) task += `\n${editText}`;
  return task;
}

export function opsWebhookPort(agentsPath = path.join(TOOLS_DIR, "agent/config/agents.json")) {
  try { return JSON.parse(fs.readFileSync(agentsPath, "utf8")).agents.ops.supervisor.webhookPort || 9092; }
  catch { return 9092; }
}

export async function postToOps({ task, source }, {
  fetchFn = globalThis.fetch,
  port = opsWebhookPort(),
  tokenFile = installTools("secrets/webhook-token"),
} = {}) {
  const headers = { "Content-Type": "application/json" };
  try { const t = fs.readFileSync(tokenFile, "utf8").trim(); if (t) headers.Authorization = `Bearer ${t}`; } catch {}
  const r = await fetchFn(`http://127.0.0.1:${port}`, {
    method: "POST", headers, body: JSON.stringify({ task, source }), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`ops webhook HTTP ${r.status}`);
  return true;
}

// The model's final message is a JSON object {outcome, reply, answered_fully}.
// outcome ∈ answered | escalated | mkt-apply | no-reply. Returns null when
// unusable — the runner then escalates rather than guess.
//
// answered_fully is the model's own judgment that its reply actually answers
// the question (Rule #0b: the model decides; code never reads the reply's words
// for "I don't know"). Kept as true / false / null (absent or not a boolean).
const OUTCOMES = new Set(["answered", "escalated", "mkt-apply", "no-reply"]);
export function parseDecision(text) {
  const obj = extractJsonObject(String(text || ""), { requireKey: "outcome" });
  if (!obj || !OUTCOMES.has(obj.outcome)) return null;
  const reply = typeof obj.reply === "string" && obj.reply.trim() ? obj.reply.trim() : null;
  if (obj.outcome === "answered" && !reply) return null;
  const answered_fully = typeof obj.answered_fully === "boolean" ? obj.answered_fully : null;
  return { outcome: obj.outcome, reply, answered_fully };
}

// What the runner does, given the model's decision and what the tools recorded.
// The tool state is authoritative: if the model escalated or applied a draft,
// no reply is sent by us even if it also wrote one.
//
// An `answered` reply is sent only when the model marked it answered_fully:
// true. false (it knows its reply is a deflection: "I don't have visibility
// into why…") or a missing flag hands the email to ops instead,
// and the drafted reply is NOT sent, so the sender gets one answer, from ops. Missing
// counts as not-full because the prompt requires the flag; a reply that broke
// the contract is treated like any other unusable decision (escalate, never
// guess), and its worst case is the pre-2026-10-04 path where ops answered
// every email.
export function planAction({ decision, state }) {
  if (state?.escalated) return { kind: "escalated" };
  if (state?.mkt_applied) return { kind: "mkt-applied" };
  if (!decision) return { kind: "fallback-escalate", reason: "no valid decision from the one-shot" };
  if (decision.outcome === "answered") {
    if (decision.answered_fully === true) return { kind: "reply", body: decision.reply };
    return {
      kind: "fallback-escalate",
      reason: decision.answered_fully === false
        ? "the one-shot responder drafted a reply but judged it does not fully answer the question (answered_fully: false); the draft was not sent, so the reply is yours"
        : "the one-shot responder answered without the required answered_fully flag, so its reply could not be trusted; the draft was not sent, so the reply is yours",
    };
  }
  if (decision.outcome === "no-reply") return { kind: "none" };
  // Claimed escalated/mkt-apply but the tool never ran: don't trust the claim.
  return { kind: "fallback-escalate", reason: `model said ${decision.outcome} but no tool call recorded` };
}
