// local-triage.mjs — rules-first email triage classification on the local model.
// Shared by bin/local-classify (CLI) and bin/local-classify-eval (the
// past-month accuracy harness). See docs/cost-rearchitecture-june2026.md.
//
// Pipeline: P1 sender allowlist -> deterministic rules (P3 fast-paths + content P1s) → local model for the
// ambiguous middle (label + P2/P3, with email-mem context) → escalate (P1 / low
// confidence / failure all defer to the remote agent — never silently drop).

import { localLlmChat } from "./local-llm.mjs";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { installRoot } from "./root.cjs";

const EDVA = installRoot();
const require = createRequire(import.meta.url);
const { instance } = require("./instance.cjs");
const { triageLabels } = require("./triage-labels.cjs");
// Structured per-message outcomes (lib/triage-decisions.js), recorded by
// gmail-action. Loaded lazily and fail-soft: a missing store just means the
// legacy email-mem extraction below answers instead.
let _td = null;
function triageDecisions() {
  if (_td === null) { try { _td = require("./triage-decisions.js"); } catch { _td = false; } }
  return _td || null;
}

let RULES = [];
// The installation's rules file; LOCAL_TRIAGE_RULES_FILE points elsewhere (tests).
export function loadRules() {
  try {
    const j = JSON.parse(readFileSync(process.env.LOCAL_TRIAGE_RULES_FILE || path.join(EDVA, "data/local-triage-rules.json"), "utf8"));
    RULES = Array.isArray(j) ? j : (j.rules || []);
  } catch {}
  return RULES;
}
loadRules();

// P1 sender allowlist (2026-08-22) — data/p1-senders.json, managed by
// `p1-sender add|remove`. It is the ONE home for "mail from this sender is always
// urgent"; it used to be three (a prose rule in email-triage-rules.md, a regex in
// local-triage-rules.json, and nothing removable). Checked ahead of every rule so
// no fast-path or mem-consensus can auto-P3 one of these. Always escalate:true —
// a P1 never gets auto-handled locally; the remote agent does the notify + task.
// Re-read per email (mtime-cached) so a `p1-sender add` takes effect immediately,
// with no supervisor restart.
const P1_SENDERS_FILE = path.join(EDVA, "data/p1-senders.json");
let _p1Cache = [];
let _p1Mtime = 0;
export function loadP1Senders() {
  try {
    const st = statSync(P1_SENDERS_FILE);
    if (st.mtimeMs === _p1Mtime) return _p1Cache;
    const j = JSON.parse(readFileSync(P1_SENDERS_FILE, "utf8"));
    _p1Cache = Array.isArray(j.senders) ? j.senders : [];
    _p1Mtime = st.mtimeMs;
  } catch { _p1Cache = []; }
  return _p1Cache;
}

// Match on the ADDRESS only — a spoofed display name must not be able to buy a P1.
function senderAddr(from) {
  if (!from) return "";
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase();
}

export function applyP1Senders(e) {
  const addr = senderAddr(e.from);
  if (!addr) return null;
  for (const s of loadP1Senders()) {
    let hit = false;
    if (s.pattern_re) { try { hit = new RegExp(s.pattern_re, "i").test(addr); } catch {} }
    else if (s.pattern) hit = addr.includes(String(s.pattern).toLowerCase());
    if (!hit) continue;
    // `only_subject_re` / `unless_subject_re` — see bin/p1-sender for the
    // contract. Each fails toward the sender's own default: only_ fails CLOSED
    // (not urgent by default), unless_ fails OPEN (urgent by default).
    if (s.only_subject_re) {
      let included = false;
      try { included = new RegExp(s.only_subject_re, "i").test(e.subject || ""); } catch {}
      if (!included) continue;
    }
    if (s.unless_subject_re) {
      let excluded = false;
      try { excluded = new RegExp(s.unless_subject_re, "i").test(e.subject || ""); } catch {}
      if (excluded) continue;
    }
    return {
      label: s.label || null, priority: "P1", confidence: 1, escalate: true,
      reason: s.reason || "P1 sender allowlist", source: `p1-sender:${s.pattern_re || s.pattern}`,
    };
  }
  return null;
}

function ruleMatches(rule, e) {
  const from = (e.from || "").toLowerCase();
  const subj = (e.subject || "").toLowerCase();
  const body = ((e.subject || "") + "\n" + (e.body || "")).toLowerCase();
  const text = (from + "\n" + body);
  const re = (p) => new RegExp(p, "i");
  if (rule.from && !re(rule.from).test(from)) return false;
  if (rule.subject && !re(rule.subject).test(subj)) return false;
  if (rule.body && !re(rule.body).test(body)) return false;
  if (rule.text && !re(rule.text).test(text)) return false;
  if (rule.subject_not && re(rule.subject_not).test(subj)) return false;
  return true;
}

export function applyRules(e) {
  for (const r of RULES) if (ruleMatches(r, e)) {
    const escalate = r.escalate ?? (r.priority === "P1");
    return { label: r.label, priority: r.priority || "P2", confidence: 1, escalate, reason: r.reason, source: `rule:${r.id}` };
  }
  return null;
}

// The WHOLE `email-mem test` output. emailMemContext() below cuts it to the 600-char
// prompt budget; the consensus extraction is handed the full text as well, so that a
// display budget can never be what decides whether a past verdict was visible at all
// (see memConsensusDetail's `full` argument).
function emailMemFetch(from, subject, { noMem, excludeId } = {}) {
  if (noMem) return "";
  try {
    // Invoke with the current node binary (process.execPath), NOT email-mem's
    // #!/usr/bin/env node shebang — `node` isn't on PATH in this subprocess context,
    // which silently errored mem to empty (discovered 2026-06-07).
    let out = execFileSync(process.execPath,
      [path.join(EDVA, "bin/email-mem"), "test", "--from", from || "", "--subject", subject || ""],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Exclude this email's OWN memory record (honest sender-history, not the answer leaking).
    if (excludeId && out) out = out.split("\n").filter((l) => !l.includes(excludeId)).join("\n").trim();
    return out;
  } catch { return ""; }
}

function emailMemContext(from, subject, opts = {}) {
  return emailMemFetch(from, subject, opts).slice(0, 600);
}

const OWNER = instance().owner_name;
const TRIAGE = triageLabels();
const EMAIL_SYSTEM = `You are an email triage classifier for ${OWNER}. Output ONLY a JSON object, no prose.
The clearly-urgent and clearly-junk cases are already handled by rules upstream — you are deciding the AMBIGUOUS middle. Bias toward escalate=true whenever you are unsure.

LABEL (exactly one): ${TRIAGE.labels.map((l) => TRIAGE.descriptions[l] ? `${l} (${TRIAGE.descriptions[l]})` : l).join(" | ")}.

PRIORITY (exactly one): P1 (urgent, needs ${OWNER} now) | P2 (needs their reply within ~24h) | P3 (FYI/automated — newsletters, receipts, confirmations, shipping/delivery notices, payouts, status; MOST mail). A calendar invitation asking ${OWNER} to attend a meeting ("Invitation: …" with an invite attached — new or updated) is ALWAYS P1. A named person (support advisor, agent, rep) answering a support case ${OWNER} opened is P1 — it is written to them and waits on their reply — even inside a company template from a no-reply address. If it might be P1 but you are not sure, set escalate=true.

SPAM vs VENDOR: spam = unsolicited junk from unknown/random senders. Promotional or marketing email from a REAL company or a platform ${OWNER} uses (${TRIAGE.vendor_examples}) is "vendor", NOT spam.

ESCALATION (important): you only AUTO-HANDLE clearly routine P3 mail (automated/FYI) whose label is obvious. Set escalate=false ONLY then. For anything that might need ${OWNER}'s attention (P1 or P2), or any case where the label is not obvious, set escalate=true — the careful remote agent will handle it. When in any doubt, escalate.

confidence = 0.0-1.0 (your certainty about BOTH label and priority).
Respond: {"label":"<one>","priority":"P1|P2|P3","confidence":0.0,"escalate":true|false,"reason":"<=12 words"}`;

export async function classifyEmailModel(e, opts = {}) {
  const mem = emailMemContext(e.from, e.subject, opts);
  const user = `FROM: ${e.from}\nSUBJECT: ${e.subject}\nBODY:\n${(e.body || "").slice(0, 2500)}`
    + (mem ? `\n\nPRIOR DECISIONS for this sender/topic (align with these):\n${mem}` : "");
  const raw = await localLlmChat({
    system: EMAIL_SYSTEM, user, maxTokens: 220, numCtx: 8192, temperature: 0, think: false, timeoutMs: 20000,
  });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model output: ${raw.slice(0, 120)}`);
  const v = JSON.parse(m[0]);
  v.source = "model";
  if (mem) v.usedMemory = true;
  if (v.priority !== "P3") v.escalate = true;                                    // only auto-handle routine P3
  if (typeof v.confidence === "number" && v.confidence < 0.85) v.escalate = true;
  // Defer to the agent's learned importance: if this sender/topic was historically
  // rated P1/P2, don't auto-handle as P3 — escalate (catches the P2-under-rank misses).
  if (mem && /\bP[12]\b/.test(mem)) v.escalate = true;
  // Corroboration gate: the model's standalone LABEL (esp. vendor↔personal) is the last
  // miss source. Only auto-handle when the agent's sender-history (mem) confirms this
  // label; otherwise defer to the remote agent. Drives confident-wrong → 0 at the cost of
  // escalating no-mem / mem-disagrees cases (the safe direction).
  if (!(mem && mem.toLowerCase().includes((v.label || "").toLowerCase()))) v.escalate = true;
  return v;
}

// Mem consensus — the agent's own consistent per-sender decision, replayed. Returns a
// clean P3 verdict only when the sender's history is unambiguous: one clearly-dominant
// label and NO P1/P2 importance signal. Anything mixed or important → null (escalate).
// This is what makes the local path 0-confident-wrong: we only auto-handle when the
// agent has already, repeatedly, made the same low-stakes call for this sender.
//
// SENDER ANCHOR (2026-09-25). The text this reads is NOT sender-scoped. email-mem's
// searchForEmail builds a flat OR query out of the sender name, the domain and up to
// ten subject words and lets FTS5 rank the top 5 — so the sender's own terms carry no
// more weight than any word in the subject line. A brand-new sender whose subject
// happens to echo old mail gets five strangers' decisions back, and a single "P3 <label>"
// among them used to be replayed as this sender's settled pattern, at confidence 1,
// with no agent turn. (A Jev disagreement: a product-marketing email whose subject
// echoed unrelated mail retrieved strangers' records — zero history with the actual
// sender — and was auto-filed Personal. It is marketing from a platform the user
// uses, i.e. vendor.) So when the caller names the sender, at least one of those past
// decisions must actually BE about this sender. Identity is matched on the ADDRESS and
// its domain only, never the display name: a display name is spoofable, and a
// short one is a substring of unrelated prose.
const LABELS = TRIAGE.labels;

// CONSUMER MAILBOX PROVIDERS. On these domains the domain names the
// mailbox company, not the sender, so it cannot anchor anything: every stranger on
// gmail.com shares it with the user's own address, which appears in
// most of the agent's triage records. The anchor above therefore passed for ANY gmail
// sender, and a stranger inherited other people's verdicts again: filler spam from
// a random gmail address was told "no consistent label" off an airline boarding
// pass (a Jev disagreement), and same-shape spam from another (a pasted
// employee handbook) still got a confidence-1 vendor consensus from three records that
// mention only gmail.com. On these domains only the full address identifies a sender.
// A set of domain names is structure, not language.
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "yandex.com", "comcast.net", "verizon.net", "att.net",
]);

export function isFreeMailSender(from) {
  const addr = senderAddr(from);
  if (!addr.includes("@")) return false;
  const dom = addr.split("@")[1] || "";
  const reg = dom.split(".").slice(-2).join(".");
  return FREE_MAIL_DOMAINS.has(dom) || FREE_MAIL_DOMAINS.has(reg);
}

function senderIdentityTokens(from) {
  const addr = senderAddr(from);
  if (!addr || !addr.includes("@")) return [];
  if (isFreeMailSender(from)) return [addr];
  const dom = addr.split("@")[1] || "";
  const parts = dom.split(".");
  const reg = parts.length >= 2 ? parts.slice(-2).join(".") : dom;
  // A registrable domain shorter than this ("x.ai") collides with ordinary words.
  return [addr, dom, reg.length > 4 ? reg : ""].filter(Boolean);
}

// Has the agent ever decided a message from this exact address? Either an email-mem
// record names it (`full` is the untruncated `email-mem test` output) or
// triage_decisions holds an agent- or user-decided row for it (intake's own
// auto-files never count there, so this cannot certify itself).
export function senderKnown(from, full, { deps = {} } = {}) {
  const addr = senderAddr(from);
  if (!addr.includes("@")) return true;
  if (memRecords(full).some((r) => r.toLowerCase().includes(addr))) return true;
  const td = deps.triageDecisions === undefined ? triageDecisions() : deps.triageDecisions;
  try { if (td && td.senderConsensus(from).n > 0) return true; } catch {}
  return false;
}

// Does this memory excerpt actually talk about the sender of the email in hand?
// No address to check (a bare name, a malformed header) → true, so the anchor can
// never be the thing that withholds a verdict it was unable to evaluate.
export function namesSender(memText, from) {
  const toks = senderIdentityTokens(from);
  if (!toks.length) return true;
  const lc = String(memText || "").toLowerCase();
  return toks.some((t) => lc.includes(t));
}

// Split `email-mem test` stdout into its individual memory records. Structural, not
// semantic: "  #1234: " is email-mem's own listing format, and a continuation line is
// anything until the next record or the blank line before the prompt block.
export function memRecords(memText) {
  const out = [];
  let cur = null;
  for (const line of String(memText || "").split("\n")) {
    if (/^\s{2}#\d+:/.test(line)) { if (cur !== null) out.push(cur); cur = line; }
    else if (cur !== null) {
      if (/^\s*$/.test(line) || /^Prompt block:/.test(line)) { out.push(cur); cur = null; }
      else cur += "\n" + line;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

// `full` (optional) is the untruncated `email-mem test` output that `memText` was cut
// from. Of the three empty outcomes, "no-verdicts" is the only one that can be an
// artifact of the 600-char prompt budget rather than a fact about this sender: the
// window simply ended before the verdict was reached. When that happens and we were
// given the full text, retry the extraction over THIS SENDER'S OWN records in it.
//
// Only then, and only over the sender's own records. Widening unconditionally is
// measurably worse and was rejected twice: email-mem's searchForEmail returns the
// top-5 semantically SIMILAR memories regardless of sender, so the extra text is
// mostly strangers' decisions, and one P1/P2 anywhere in it vetoes a real consensus.
// Measured over the whole shadow window (55 distinct from+subject, replayed against
// the live email-mem corpus): retry-on-no-verdicts changes 6 rows and loses none —
// 2 recover a correct consensus (two Jev disagreements where the sender's own
// "P3 personal" sat 3 and 27 characters past the cut) and 4 keep their null but report a truer reason. The
// unconditional widening, by contrast, loses 6 consensuses and flips 2 labels.
export function memConsensusDetail(memText, { from, full } = {}) {
  const d = extractConsensus(memText, from);
  if (d.reason !== "no-verdicts" || from === undefined || !full) return d;
  const mine = memRecords(full).filter((r) => namesSender(r, from));
  if (!mine.length) return { consensus: null, reason: "other-senders" };
  return extractConsensus(mine.join("\n"), from);
}

// Same extraction as memConsensus, plus WHY it came back empty. withConsensus()
// (lib/jev-email-triage.mjs) reports that reason to Jev verbatim: the three
// empty cases are different facts about the world and were being collapsed into one
// sentence that was often simply false.
function extractConsensus(memText, from) {
  if (!memText) return { consensus: null, reason: "no-verdicts" };
  const lc = memText.toLowerCase();
  const alt = LABELS.map((l) => l.replace(/-/g, "\\-")).join("|");
  // Extract the agent's ACTUAL verdicts: a p-level adjacent to a label (either order,
  // tight window) — e.g. "P3 <label>", "label personal, P3". This ignores label
  // words that merely appear in prose/subject (the false-positive source).
  const pairs = [];
  let m;
  const re1 = new RegExp(`\\bp([123])\\b[^.\\n]{0,18}?\\b(${alt})\\b`, "gi");
  const re2 = new RegExp(`\\b(${alt})\\b[^.\\n]{0,12}?\\bp([123])\\b`, "gi");
  while ((m = re1.exec(lc))) pairs.push({ label: m[2], p: +m[1] });
  while ((m = re2.exec(lc))) pairs.push({ label: m[1], p: +m[2] });
  if (!pairs.length) return { consensus: null, reason: "no-verdicts" };
  if (from !== undefined && !namesSender(memText, from)) return { consensus: null, reason: "other-senders" };
  if (pairs.some((x) => x.p <= 2)) return { consensus: null, reason: "mixed-or-urgent" }; // any P1/P2 → escalate
  const c = {};
  for (const x of pairs) c[x.label] = (c[x.label] || 0) + 1;
  const sorted = Object.entries(c).sort((a, b) => b[1] - a[1]);
  const [topL, topN] = sorted[0];
  const secondN = sorted[1] ? sorted[1][1] : 0;
  if (topN >= 1 && topN >= 2 * secondN) return { consensus: { label: topL, priority: "P3" }, reason: "consensus" }; // clean, dominant, all-P3
  return { consensus: null, reason: "mixed-or-urgent" };
}

// The ONE consensus lookup both intake paths use (classifyEmail below and Jev's
// history header in jev-email-triage.mjs withConsensus), so they stay in lockstep.
//
// STRUCTURED FIRST (2026-10-04). `triage_decisions` (gmail-action records every
// label/star/mark-read per messageId) answers "what did the agent decide for THIS
// sender address" as a GROUP BY — no FTS ranking, no 600-char window, no regex
// over prose. Once a sender has ≥3 agent-decided rows that answer is
// authoritative, including a "mixed-or-urgent" no. Below that the table is too
// thin to say anything, so the legacy email-mem extraction answers exactly as
// before; it retires itself as rows accumulate. `source` says which one spoke.
export function senderConsensusDetail(memText, { from, full, deps = {} } = {}) {
  const td = deps.triageDecisions === undefined ? triageDecisions() : deps.triageDecisions;
  if (td && from) {
    const t = td.senderConsensus(from);
    if (t && t.enough) return { consensus: t.consensus || null, reason: t.reason, source: "triage-decisions", n: t.n };
  }
  return { ...memConsensusDetail(memText, { from, full }), source: "email-mem" };
}

// Unchanged signature and behaviour for every caller that does not name the sender.
export function memConsensus(memText, opts = {}) {
  return memConsensusDetail(memText, opts).consensus;
}

// Full pipeline for email: deterministic rules → clean mem-consensus → escalate.
// For email triage the 2B model proved unreliable on the ambiguous middle (it produced
// every residual miss), so we do NOT auto-handle on a bare model verdict — anything
// without a rule or a clean sender-history consensus defers to the remote agent.
// Content-importance signals that must OVERRIDE a P3 sender-consensus — a usually-routine
// sender can still send something that needs the user (an application to review, a payment problem,
// a signature request). Tight list of action-needed phrases (avoid words that appear in
// routine mail like "expired"/"cancel" in a cancellation policy).
const IMPORTANCE = /\bapplication\b|\bproblem\b|\bdefect\b|\burgent\b|action required|past[- ]due|\boverdue\b|payment (failed|declined)|signature required|counter[- ]?offer|needs your|please (call|review|sign|respond|confirm)|require[sd]?\s+(your\s+)?(action|signature|response)/i;

export async function classifyEmail(e, opts = {}) {
  const p1 = applyP1Senders(e);
  if (p1) return p1;
  const r = applyRules(e);
  if (r) return r;
  const mem = emailMemFetch(e.from, e.subject, opts);
  const { consensus: cons, reason: consReason, source: consSource } = senderConsensusDetail(mem.slice(0, 600), { from: e.from, full: mem, deps: opts.deps || {} });
  if (cons) {
    if (IMPORTANCE.test(`${e.subject || ""}\n${e.body || ""}`))
      return { escalate: true, label: cons.label, priority: null, confidence: 0, reason: "content signals action — overrides P3 consensus", source: "escalate:importance" };
    return { ...cons, confidence: 1, escalate: false, reason: "sender-history consensus", source: consSource === "triage-decisions" ? "decision-consensus" : "mem-consensus", usedMemory: true };
  }
  return {
    escalate: true, label: null, priority: null, confidence: 0, source: "escalate",
    reason: consReason === "other-senders"
      ? "no sender-history — the retrieved decisions are about other senders — defer to remote"
      : "no rule / no clean sender-history — defer to remote",
  };
}
