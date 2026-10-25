// triage-decide.mjs — email triage as "the model decides, code acts".
//
// Today every inbound email that survives the intake cascade becomes a full
// turn in the resumed ops session (Sonnet, effort xhigh): the agent reads the
// 108 KB ruleset, re-fetches the email through the Gmail connector, re-runs
// checks intake already ran, and then executes Step 5 — which is a FIXED TABLE
// (email-triage-rules.md § Step 5):
//   P3 = label + mark-read
//   P2 = label + star + mark-read
//   P1 = label + star + `p1` (left unread) + notify + p1-task
// Measured over two weeks: hundreds of `gmail:*` dispatches at well over half a
// dollar an email, almost all of it the ~150k-token session floor re-read on
// every turn.
//
// This module splits the turn into its two halves:
//   decide()      ONE tool-less `claude -p` call (Max session, effort low, no
//                 MCP, no settings — lib/jev-claude.mjs) that reads the
//                 ruleset + the prefetched email and returns schema JSON:
//                 {label, priority, notify, urgent, task:{action}|null, action_tags[], reason}
//   planActions() the Step-5 table as code: gmail-action calls, the templated
//                 P1 pointer with --evidence-as-of from the Date header, the
//                 p1-task with a computed due date, the installation's code-tag webhooks.
// Anything the model tags as needing a multi-step side effect (calendar event,
// a wiki update, a subscription pause, meeting cancellation, an instruction, …) is NOT
// done here — that email goes to the agent dispatch exactly as today.
//
// Rollout: data/triage-decide-config.json `mode`:
//   "off"    — nothing runs
//   "shadow" — (default) the live agent path is untouched; a detached
//              `triage-decide shadow` computes the decision + the plan and logs
//              both to data/triage-decide-shadow.jsonl. `triage-decide
//              report` compares them with what actually happened (the
//              triage_decisions rows gmail-action records).
//   "live"   — gmail-source hands the email to `triage-decide live` instead of
//              dispatching; it executes the plan in code, and falls back to the
//              normal agent dispatch whenever the model fails, the output fails
//              validation, or any action tag needs the agent.
// Cutover criteria: email-triage-rules.md § Decide-then-act triage.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runToolless, parseModelJson } from "./jev-claude.mjs";
import { loadMergedRules } from "./triage-rules.mjs";
import { createRequire } from "node:module";

import { installRoot } from "./root.cjs";
const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");
const OWNER = instance().owner_name;
// This installation's extra side-effect tags and their one-line glosses for
// the prompt (agent/local/config/triage-decide.json): `agent_tags`
// replaces the list below (keep its order: the prompt shows it), `tag_help`
// adds prompt lines after the calendar-event line, and `tag_help_tail` is
// glossed just before other-agent on the last tag line. `code_tags` are the
// side effects code performs itself: [{tag, webhook: {job, ...payload}, help}],
// `help` being the tag's prompt line (shown before calendar-event).
const LOCAL = localConfig("triage-decide", { agent_tags: null, tag_help: [], tag_help_tail: "", code_tags: [] });
const CODE_TAG_DEFS = Array.isArray(LOCAL.code_tags) ? LOCAL.code_tags.filter((t) => t && typeof t.tag === "string") : [];

const ROOT = installRoot();
export const { LABELS } = require("./triage-labels.cjs");
export const PRIORITIES = ["P1", "P2", "P3"];
// Side effects code can perform itself (the installation's `code_tags`).
export const CODE_TAGS = CODE_TAG_DEFS.map((t) => t.tag);
// Side effects that need a full agent turn (multi-step, judgment, or tools the
// decide call does not have). Any of these → normal agent dispatch.
export const AGENT_TAGS = Array.isArray(LOCAL.agent_tags) && LOCAL.agent_tags.length ? LOCAL.agent_tags : [
  "calendar-event",       // ticket / reservation / appointment / invite → edva-calendar
  "meeting-cancellation", // remove or update an existing calendar event
  "instruction",          // The user asked Edva to do something
  "spam-campaign",        // extend a content fingerprint / blocklist
  "other-agent",          // anything else the ruleset says to DO beyond Step 5
];
export const ACTION_TAGS = [...CODE_TAGS, ...AGENT_TAGS];
export const EDVA_SENDER = String(instance().agent_email || "").toLowerCase();

export const CONFIG_FILE = process.env.TRIAGE_DECIDE_CONFIG || path.join(ROOT, "data/triage-decide-config.json");
export const SHADOW_LOG = process.env.TRIAGE_DECIDE_LOG || path.join(ROOT, "data/triage-decide-shadow.jsonl");

export function mode() {
  try {
    const m = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).mode;
    return ["off", "shadow", "live"].includes(m) ? m : "off";
  } catch { return "off"; }
}

// ---- structural helpers ------------------------------------------------------

export function senderAddr(from) {
  const s = String(from || "");
  const lt = s.lastIndexOf("<"), gt = s.lastIndexOf(">");
  return (lt !== -1 && gt > lt ? s.slice(lt + 1, gt) : s).trim().toLowerCase();
}

export function senderName(from) {
  const s = String(from || "").trim();
  const lt = s.lastIndexOf("<");
  const name = (lt > 0 ? s.slice(0, lt) : "").trim().replace(/^"|"$/g, "").trim(); // lang-regex-ok: strip quotes around an RFC 5322 display name
  return name || senderAddr(s) || "unknown sender";
}

/** The email's own Date header as ISO-8601; falls back to `now` (live mail arrived seconds ago). */
export function evidenceAsOf(dateHeader, now = new Date()) {
  const t = Date.parse(dateHeader || "");
  return Number.isFinite(t) ? new Date(t).toISOString() : now.toISOString();
}

function localParts(now) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: instance().tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, wd: p.weekday };
}

/**
 * email-triage-rules.md Step 5 due dates, in the installation's local zone (§ Timezone Rule):
 * weekday → today; weekend + not urgent → next Monday; urgent → today.
 * (Holidays are not modelled; a holiday P1 lands due that day, the safe side.)
 */
export function dueDate(now = new Date(), urgent = false) {
  const { ymd, wd } = localParts(now);
  if (urgent || !["Sat", "Sun"].includes(wd)) return ymd;
  const add = wd === "Sat" ? 2 : 1;
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + add));
  return t.toISOString().slice(0, 10);
}

// ---- decision ----------------------------------------------------------------

/** Validate + normalise model output. Returns {ok, decision} or {ok:false, error}. */
export function validateDecision(v, packet = {}) {
  if (!v || typeof v !== "object") return { ok: false, error: "no-json" };
  if (!LABELS.includes(v.label)) return { ok: false, error: `bad-label:${v.label}` };
  if (!PRIORITIES.includes(v.priority)) return { ok: false, error: `bad-priority:${v.priority}` };
  const tags = Array.isArray(v.action_tags) ? v.action_tags.map(String) : [];
  const unknown = tags.filter((t) => !ACTION_TAGS.includes(t));
  const d = {
    label: v.label,
    priority: v.priority,
    notify: v.notify === true,
    urgent: v.urgent === true,
    task: v.task && typeof v.task === "object" && String(v.task.action || "").trim()
      ? { action: String(v.task.action).trim().slice(0, 100) } : null,
    // An unknown tag means the model wanted something we have no name for —
    // route it to the agent rather than drop it.
    action_tags: [...new Set([...tags.filter((t) => ACTION_TAGS.includes(t)), ...(unknown.length ? ["other-agent"] : [])])],
    reason: String(v.reason || "").slice(0, 200),
  };
  // Code-owned facts override the model:
  // a P1 stamped at intake (sender list / reply-to-me) is P1, full stop.
  const stamps = packet.stamps || [];
  if (stamps.includes("p1-sender") || stamps.includes("reply-to-me-p1")) d.priority = "P1";
  // Edva's own mail: never a pointer or task about it (a loop) — Step 4.
  if (EDVA_SENDER && senderAddr(packet.from) === EDVA_SENDER) { d.notify = false; d.task = null; }
  if (d.priority !== "P1") { d.notify = false; d.task = null; }
  return { ok: true, decision: d };
}

export function buildPrompt(packet, rulesText) {
  const lines = [
    "You are the DECIDE step of Edva's email triage. You have no tools and take no actions.",
    "Code will execute Step 5 of the ruleset for you from your answer (labels, star, read state, the P1 phone pointer, the P1 task).",
    "Read the ruleset, then classify the ONE email at the end.",
    "",
    "Return ONLY a JSON object:",
    `{"label":"<${LABELS.join("|")}>","priority":"P1|P2|P3","notify":true|false,"urgent":true|false,`,
    ` "task":{"action":"<short imperative: what ${OWNER} must do, <=8 words>"}|null,`,
    ` "action_tags":[<zero or more of: ${ACTION_TAGS.map((t) => `"${t}"`).join(", ")}>],`,
    ` "reason":"<=20 words"}`,
    "",
    "- notify/task apply only to P1 (Step 5). urgent=true means due today even on a weekend.",
    // geo-gate-ok: classification prompt for a P1 email pointer, never an event recommendation.
    `- notify=true ONLY when the email needs ${OWNER} to act: it asks them something or for a decision, has a deadline,`,
    "  or wants something only they can do. A P1 that needs nothing from them (an automatic receipt, a confirmation of",
    "  something done, an FYI, a thank-you) is still P1 (starred, unread) with notify=false.",
    "- action_tags name every side effect the ruleset requires BEYOND Step 5 for this email:",
    ...CODE_TAG_DEFS.filter((t) => t.help).map((t) => `  ${t.help}`),
    "  calendar-event = a ticket/reservation/appointment/invite needing a calendar event; meeting-cancellation;",
    ...(LOCAL.tag_help || []),
    `  instruction = ${OWNER} is asking Edva to do something; spam-campaign = extend a fingerprint/blocklist;`,
    `  ${LOCAL.tag_help_tail || ""}other-agent = any other required action.`,
    "- Leave action_tags empty when Step 5 alone completes the triage.",
    "",
    "===== RULESET (email-triage-rules.md) =====",
    rulesText,
    "===== EMAIL =====",
    `FROM: ${packet.from || ""}`,
    `TO: ${packet.to || ""}`,
    `DATE: ${packet.date || ""}`,
    `SUBJECT: ${packet.subject || ""}`,
    `INTAKE STAMPS: ${(packet.stamps || []).join(", ") || "none"}`,
    `JEV VERDICT (typed classifier, may be wrong): ${packet.jev ? JSON.stringify(packet.jev) : "none"}`,
    `SENDER HISTORY: ${packet.history || "none"}`,
    "BODY:",
    String(packet.body || "").slice(0, 6000),
  ];
  return lines.join("\n");
}

export async function decide(packet, deps = {}) {
  let rules = "";
  // The merged ruleset (kernel + local companion; triage-rules.mjs), read now.
  try { rules = deps.rulesText ?? loadMergedRules(); } catch {}
  const prompt = buildPrompt(packet, rules);
  const started = Date.now();
  const out = deps.runClaude ? await deps.runClaude(prompt)
    : await runToolless({ model: deps.model || "claude-sonnet-5-5", prompt, timeoutMs: deps.timeoutMs || 120000, effort: "low" });
  const v = parseModelJson(out);
  const r = validateDecision(v, packet);
  return { ...r, latency_ms: Date.now() - started, raw: r.ok ? undefined : String(out || "").slice(0, 400) };
}

// ---- the Step 5 table, as code ----------------------------------------------

/**
 * Pure: the exact commands Step 5 prescribes for this decision.
 * Returns {actions:[{kind, argv?, payload?}], needsAgent, agentTags}.
 */
export function planActions(decision, ctx, now = new Date()) {
  const { messageId, from, subject, date } = ctx;
  const d = decision;
  const actions = [];
  const ga = (...a) => actions.push({ kind: "gmail-action", argv: a });
  ga("label", messageId, d.label);
  if (d.priority === "P3") ga("mark-read", messageId);
  if (d.priority === "P2") { ga("star", messageId); ga("mark-read", messageId); }
  if (d.priority === "P1") {
    ga("star", messageId);
    ga("label", messageId, "p1");
    if (d.notify) {
      // --p1-message lets edva-send-curl fold a second push for this email
      // or its thread burst (lib/p1-push-fold.mjs).
      actions.push({ kind: "notify", argv: ["--intent", "p1-email", "--evidence-as-of", evidenceAsOf(date, now), "--p1-message", messageId, `🚨 P1 Email: ${subject || "(no subject)"} from ${senderName(from)}`] });
    }
    if (d.task) {
      actions.push({ kind: "p1-task", argv: ["add", messageId, "--title", `${subject || "(no subject)"} from ${senderName(from)} — ${d.task.action}`, "--due", dueDate(now, d.urgent), "--notes", `Triaged by triage-decide: ${d.reason}`] });
    }
  }
  for (const t of CODE_TAG_DEFS) {
    if (t.webhook && d.action_tags.includes(t.tag)) actions.push({ kind: "webhook", payload: { ...t.webhook } });
  }
  const agentTags = d.action_tags.filter((t) => AGENT_TAGS.includes(t));
  return { actions, needsAgent: agentTags.length > 0, agentTags };
}

export function appendShadow(row, file = SHADOW_LOG) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch {}
}

export function readShadow(file = SHADOW_LOG) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- comparison (report) -----------------------------------------------------

/**
 * Compare shadow rows with what actually happened (a triage_decisions row per
 * messageId: label + priority derived from the final Gmail state).
 * `settleMs`: ignore rows younger than this — the agent may still be acting.
 */
export function compare(rows, getActual, { now = Date.now(), settleMs = 20 * 60 * 1000 } = {}) {
  const out = { compared: 0, label_agree: 0, priority_agree: 0, missed_p1: 0, over_p1: 0, waiting: 0, no_actual: 0, failed: 0, would_dispatch: 0, disagreements: [] };
  const seen = new Set();
  for (const r of rows) {
    if (!r.messageId || seen.has(r.messageId)) continue;
    seen.add(r.messageId);
    if (!r.ok) { out.failed++; continue; }
    if (now - Date.parse(r.ts) < settleMs) { out.waiting++; continue; }
    const a = getActual(r.messageId);
    if (!a || !a.label) { out.no_actual++; continue; }
    out.compared++;
    if (r.needs_agent) out.would_dispatch++;
    const lab = r.decision.label === a.label, pri = r.decision.priority === a.priority;
    if (lab) out.label_agree++;
    if (pri) out.priority_agree++;
    if (a.priority === "P1" && r.decision.priority !== "P1") out.missed_p1++;
    if (r.decision.priority === "P1" && a.priority !== "P1") out.over_p1++;
    if (!lab || !pri) out.disagreements.push({ messageId: r.messageId, subject: r.subject, from: r.from, shadow: `${r.decision.label}/${r.decision.priority}`, actual: `${a.label}/${a.priority}`, by: a.decided_by });
  }
  return out;
}

// Cutover gate (email-triage-rules.md § Decide-then-act triage).
export const CUTOVER = { min_compared: 150, min_days: 7, min_label_rate: 0.95, min_priority_rate: 0.95, max_missed_p1: 0 };

export function cutoverReady(stats, days) {
  const lr = stats.compared ? stats.label_agree / stats.compared : 0;
  const pr = stats.compared ? stats.priority_agree / stats.compared : 0;
  const reasons = [];
  if (stats.compared < CUTOVER.min_compared) reasons.push(`compared ${stats.compared} < ${CUTOVER.min_compared}`);
  if (days < CUTOVER.min_days) reasons.push(`window ${days.toFixed(1)}d < ${CUTOVER.min_days}d`);
  if (lr < CUTOVER.min_label_rate) reasons.push(`label agreement ${(lr * 100).toFixed(1)}% < 95%`);
  if (pr < CUTOVER.min_priority_rate) reasons.push(`priority agreement ${(pr * 100).toFixed(1)}% < 95%`);
  if (stats.missed_p1 > CUTOVER.max_missed_p1) reasons.push(`${stats.missed_p1} missed P1(s) — must be 0`);
  return { ready: reasons.length === 0, label_rate: lr, priority_rate: pr, reasons };
}
