// jev-email-triage.mjs — Jev as the PRIMARY email-triage classifier at intake,
// with the pre-existing mechanisms as SHADOW (lib/jev-shadow.mjs).
//
// Where it sits: agent/supervisor/gmail-source.mjs runIntakeCascade, in the
// slot local-classify used to own — AFTER the spam blocklist, the P1 sender list,
// reply-to-me and the intake-skip fast-paths (all deterministic, all unchanged).
// CLI: bin/jev-email-classify. Design: docs/jev.md § email-triage.
//
// What each outcome does:
//   A curated spam fingerprint (local-triage-rules.json, label spam, escalate
//        false) matches → auto-handle as spam, Jev is NOT asked  (via: "local")
//   Jev confident (≥ threshold) AND P3 AND needs-the-user=false
//        → auto-handle: label + mark-read, NO dispatch          (via: "jev")
//   Jev confident but P1/P2 (or needs-the-user) → dispatch to ops as today; Jev's
//        verdict is recorded and compared later against what ops decided
//        (bin/jev-email-reconcile)                       (via: "dispatch")
//   Jev unavailable / error / low confidence → legacy local-classify verdict:
//        a non-escalated P3 is auto-handled exactly as before  (via: "local"),
//        anything else dispatches.
//   Health sender / medical subject → Jev is NEVER called (no external LLMs on
//        health rows); legacy path only                        (reason: "health-excluded")
//
// Shadow, during the shadow window:
//   - every Jev decision is compared with local-classify's verdict (decide());
//     when local-classify ESCALATED it has no verdict of its own, so the real
//     comparison is deferred:
//   - Jev auto-handled + local would have escalated (today: a Sonnet dispatch)
//        → a DETACHED side-effect-free Sonnet classification (`--shadow-sonnet`)
//          produces the legacy verdict and records a late comparison;
//   - Jev's verdict not acted on (dispatched) → the reconciler compares it with
//     the ops agent's own recorded triage decision in email-memory.db.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { runToolless, parseModelJson } from "./jev-claude.mjs";
import { loadMergedRules } from "./triage-rules.mjs";
import { createRequire } from "node:module";
import { decide, siteConfig, SHADOW_DIR, recordLateComparison, privacyOn } from "./jev-shadow.mjs";
import { answerConfidence, boolOf, jevAvailable } from "./jev.mjs";
import { classifyEmail, applyRules, applyP1Senders, senderConsensusDetail, isFreeMailSender, senderKnown } from "./local-triage.mjs";
import { installRoot } from "./root.cjs";
// The installation's home time zone (agent/local/instance.json tz; the host zone when unset).
const instanceTz = () => createRequire(import.meta.url)("./instance.cjs").instance().tz;
// The "does the user have to act?" question's key: `needs_<owner_id>` (needs_user
// by default). It names the Jev question in data/jev-questions/email-triage.json
// and the field in every verdict and pending row, so an installation keeps its key.
export const NEEDS_KEY = `needs_${createRequire(import.meta.url)("./instance.cjs").instance().owner_id}`;

const require = createRequire(import.meta.url);
const ROOT = installRoot();
export const SITE = "email-triage";
export const PENDING_FILE = path.join(SHADOW_DIR, "email-triage-pending.jsonl");
const EXCLUDE_FILE = process.env.JEV_EXCLUDE_SENDERS_FILE || path.join(ROOT, "data/jev-exclude-senders.json");
const CLI = path.join(ROOT, "bin/jev-email-classify");
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
// 6000, not 12000 (from a code review): the whole state must fit the on-device
// privacy screen's bound so every character sent to Jev has been screened.
export const BODY_CHARS = 6000;
export const { LABELS } = require("./triage-labels.cjs");

function senderAddr(from) {
  const m = String(from || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(from || "")).trim().toLowerCase();
}

// Sender-list + medical-subject exclusion (health AND financial senders).
// Returns "<category>:<match>" or null. Name kept for existing callers/tests.
export function healthExcluded(e) {
  const addr = senderAddr(e.from);
  let list = [];
  try { list = JSON.parse(fs.readFileSync(EXCLUDE_FILE, "utf8")).senders || []; } catch {}
  const dom = addr.split("@")[1] || "";
  for (const s of list) {
    const cat = s.category || "health";
    if (s.contains && addr.includes(String(s.contains).toLowerCase())) return `${cat}:sender:${s.contains}`;
    if (s.domain) { const d = String(s.domain).toLowerCase(); if (dom === d || dom.endsWith("." + d)) return `${cat}:domain:${d}`; }
  }
  // A provider nobody listed yet: the local medical-subject content rule.
  const r = applyRules({ from: e.from, subject: e.subject });
  if (r && r.source === "rule:medical-subject") return "health:rule:medical-subject";
  return null;
}

// ---- body + sender history --------------------------------------------------

function b64(s) { return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }

export function extractBody(payload) {
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (p.body?.data) {
      if (mt === "text/plain" && !plain) plain = b64(p.body.data);
      else if (mt === "text/html" && !html) html = b64(p.body.data);
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const text = plain || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return text.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, BODY_CHARS);
}

export async function fetchBody(messageId, { timeoutMs = 5000 } = {}) {
  const { getAccessToken } = require("./google-auth.js");
  const token = await getAccessToken();
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    if (!res.ok) throw new Error(`gmail HTTP ${res.status}`);
    return extractBody((await res.json()).payload);
  } finally { clearTimeout(t); }
}

// The 600-char excerpt is exactly what local-classify sees too (local-triage's
// emailMemContext truncates identically) — but local-classify does not READ it,
// it EXTRACTS the agent's own past (label, priority) verdicts out of it and acts
// on a clean consensus at confidence 1. Jev was handed the same text as prose and
// had to infer the consensus while simultaneously weighing the body, so a 5-of-5
// unanimous "P3 personal" for noreply-accounts@google.com arrived as one and a
// half paragraphs cut off mid-word and it answered vendor 0.62 / personal 0.38
// (from a Jev disagreement). Hand it the same extraction the
// legacy path makes, ahead of the prose, and leave the prose for the nuance.
export function senderHistory(from, subject, opts = {}) {
  return senderHistoryDetail(from, subject, opts).then((d) => d.text);
}

// Same lookup, also returning the untruncated email-mem output, which classifyInbound
// needs for the first-contact check (senderKnown) without a second email-mem call.
export function senderHistoryDetail(from, subject, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "bin/email-mem"), "test", "--from", from || "", "--subject", subject || ""],
      { encoding: "utf8", timeout: timeoutMs }, (err, out) => {
        // Jev still READS 600 characters of prose — the state size is unchanged.
        // The full text goes only to the extraction, so a verdict sitting just past
        // the cut is no longer reported to Jev as "nothing can be concluded".
        const full = err ? "" : String(out || "").trim();
        const text = full.slice(0, 600);
        resolve({ text: text ? withConsensus(text, from, full) : "", full });
      });
  });
}

// Prefix the excerpt with the consensus local-classify would read out of it, or with
// the explicit fact that there is not one — and, when there is not one, WHICH of the
// three different facts that is. They were collapsed into a single sentence ("mixed
// labels, or some were P1/P2") that in two of the three cases is simply false, and a
// false statement here is worse than silence: the question file tells Jev that a
// no-consensus line means "lean on the body instead", so it changes the answer.
//   consensus      — a dominant, all-P3 label for a sender these memories are about
//   other-senders  — verdicts are present but none of these memories is about THIS
//                    sender; email-mem ranks on subject words as much as on the sender,
//                    so a new sender inherits strangers' decisions
//   no-verdicts    — the 600-char window ended before any verdict appeared; we could
//                    not see far enough, which is not the same as "mixed"
//   mixed-or-urgent — genuinely mixed, or this sender has had a P1/P2
// memConsensusDetail applies the sender anchor when `from` is passed, so this line and
// local-classify's own auto-handle decision stay in lockstep — which is the whole point
// of handing Jev the extraction rather than the prose.
export function withConsensus(text, from, full) {
  let d = { consensus: null, reason: "mixed-or-urgent" };
  try { d = senderConsensusDetail(text, { from, full }); } catch {}
  const head = d.consensus
    ? `PAST DECISIONS BY THE AGENT FOR THIS SENDER/TOPIC: consistently label=${d.consensus.label}, priority=${d.consensus.priority}.`
    : d.reason === "other-senders"
      ? "PAST DECISIONS BY THE AGENT FOR THIS SENDER/TOPIC: none. The decisions below are about OTHER senders — they were retrieved because the subject shares wording with them. Ignore them as precedent and judge this message on its own content."
      : d.reason === "no-verdicts"
        ? "PAST DECISIONS BY THE AGENT FOR THIS SENDER/TOPIC: none visible — this excerpt is cut off before any past verdict, so nothing can be concluded either way. Judge this message on its own content."
        : "PAST DECISIONS BY THE AGENT FOR THIS SENDER/TOPIC: no consistent label (mixed labels, or some were P1/P2). Judge this message on its own content.";
  return `${head}\n${text}`;
}

// ---- the decision -------------------------------------------------------------

export function interpret(answers) {
  const label = answers.label?.choice, priority = answers.priority?.choice;
  const conf = Math.min(answerConfidence(answers.label), answerConfidence(answers.priority));
  const needs = answers[NEEDS_KEY] ? boolOf(answers[NEEDS_KEY]) : null;
  return { value: { label: LABELS.includes(label) ? label : null, priority: ["P1", "P2", "P3"].includes(priority) ? priority : null, [NEEDS_KEY]: needs }, confidence: (LABELS.includes(label) && priority) ? conf : 0 };
}

// Local-classify escalated = it has no verdict; not a disagreement, the real
// comparison is deferred to the Sonnet shadow / reconciler (see header).
export function sameVerdict(j, l) {
  if (!l || l.escalate !== false) return null;   // deferred: compared late (Sonnet shadow / reconciler)
  return j.label === l.label && j.priority === l.priority;
}

function localAuto(v) { return !!v && v.escalate === false && v.priority === "P3" && !!v.label; }

function appendRow(file, row) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch {}
}
function localDate() { return new Date().toLocaleDateString("en-CA", { timeZone: instanceTz() }); }

/**
 * Classify one inbound email. Pure decision — the caller (gmail-source) applies
 * Gmail state. Returns {auto, label, priority, via, source, reason}.
 *   auto=true → caller labels + marks read and SKIPS the dispatch.
 */
export async function classifyInbound({ messageId, from, subject }, deps = {}) {
  // Memoised: decide() runs it as the shadow, and the Jev-auto branch below needs
  // the same verdict again — one local-classify (and one email-mem lookup) per email.
  let legacyP = null;
  const legacy = () => (legacyP ||= Promise.resolve((deps.classifyEmail || classifyEmail)({ from, subject })));

  // A CURATED SPAM FINGERPRINT SETTLES THE MESSAGE BEFORE JEV IS ASKED.
  //
  // The `spam-*` rules in local-triage-rules.json are two-signal fingerprints of
  // known rotating-domain scam campaigns, each written after confirmed sightings
  // (email-triage-rules.md Step 0d). Scam mail is built to look urgent, so the body
  // Jev reads ("verify your identity", "your code expires in 5 minutes") pushes its
  // needs-the-user answer up, and the sub-threshold veto below then overrode the fingerprint:
  // a "Welcome to your <brand> life offer" scam matched its curated spam fingerprint
  // at confidence 1, Jev said spam/P3 but needs-the-user at 0.89, and the message was
  // dispatched instead of filed. A fingerprint is the stronger evidence for this one
  // class, so it wins outright. Only a non-escalating rule whose verdict IS `spam`
  // qualifies (first-match-wins, so an earlier P1/escalate rule still decides), and
  // never for a listed P1 sender. The `spam` label is Gmail's Spam folder
  // (`gmail-action spam`, guarded).
  if (!(deps.applyP1Senders || applyP1Senders)({ from, subject })) {
    const fp = (deps.applyRules || applyRules)({ from, subject });
    if (fp && fp.label === "spam" && fp.escalate === false && String(fp.source || "").startsWith("rule:")) {
      return { auto: true, label: "spam", priority: "P3", via: "local", source: fp.source, reason: "curated-spam-fingerprint" };
    }
  }

  const excl = privacyOn() ? healthExcluded({ from, subject }) : null;
  if (excl) {
    const reason = excl.startsWith("financial:") ? "financial-excluded" : "health-excluded";
    const { value: v } = await decide({ site: SITE, id: messageId, state: null, interpret, legacy, skipJev: reason });
    return localAuto(v) ? { auto: true, label: v.label, priority: "P3", via: "local", source: v.source, reason }
                        : { auto: false, via: "dispatch", reason };
  }

  let body = "", history = "", memFull = null;
  if (jevAvailable() && siteConfig(SITE).enabled) {
    [body, history] = await Promise.all([
      (deps.fetchBody || fetchBody)(messageId).catch(() => ""),
      deps.senderHistory ? deps.senderHistory(from, subject)
        : senderHistoryDetail(from, subject).then((d) => { memFull = d.full; return d.text; }),
    ]);
  }
  const r = await decide({
    site: SITE, id: messageId,
    state: { from, subject, body, sender_history: history || "(no prior decisions for this sender)" },
    logInput: { from, subject, body_chars: body.length, has_history: !!history },
    interpret, legacy, same: sameVerdict,
    // Content screen for anything the sender list missed (a bank alert from an
    // unlisted domain, a lab result forwarded by a person). Fail-closed.
    privacyScreen: true,
    jevTimeoutMs: 5000,
  });

  if (r.used === "jev") {
    const v = r.value;
    // NEVER-AUTO-HANDLE RULES APPLY TO JEV TOO.
    //
    // local-triage's rules can mark a message `escalate: true` because TRIAGING
    // it has a side effect only the ops agent performs — a restaurant booking
    // confirmation creates the calendar event, a lab result gets the P1 stamp, an
    // urgent problem reported in the body is an emergency. `reservation-platform` was
    // added for exactly this: the intake settled a restaurant
    // booking locally, replayed the label, and silently dropped the calendar
    // event; the user found the missing event themselves.
    //
    // Jev became primary days later and this branch computes `auto` from
    // its own three answers alone, so every one of those rules is bypassed
    // whenever Jev is confident. Jev is answering "does the user have to act",
    // which is a different question from "can this be filed with no agent
    // turn", and its confidence is not evidence about a side effect it was
    // never told about: a booking confirmation reads personal/P3/needs-the-user 0.04
    // and a "your test results are available" notice personal/P3/0.72, both at
    // confidence 0.67 today — under the 0.9 bar only by margin, and every card
    // this shadow week has been pushing these classes up.
    //
    // The gate is one-directional by construction: it can only WITHHOLD an
    // auto-handle, never create one, so the worst case is an ops dispatch that
    // did not strictly need to happen. `body` is passed as well as from/subject
    // so the body-matched rules (an urgent problem only the body describes)
    // reach it. Measured over the 95 distinct emails of the shadow window: 0 of
    // Jev's 25 auto-handles withheld — this is a guard, not a behaviour change.
    const ruled = (deps.applyRules || applyRules)({ from, subject, body });
    // A FIRST-CONTACT SENDER ON A CONSUMER MAILBOX IS NEVER AUTO-FILED BY JEV
    // Jev reads spam off the sender's domain and the message's tone,
    // and a gmail.com address with a human display name reads to it as a person.
    // Spam built for that — filler text pasted in to get past filters, the real pitch
    // in an image, or a party invite from a hijacked friend's account — comes back
    // personal or vendor with spam at 0.00-0.16 on all four instances in the shadow
    // window, and the text alone cannot fix it: a criteria clause describing the
    // filler only moved one such message (a pasted school handout from a free-mail
    // address) from spam 0.00 to 0.25-0.28 while Jev filed it personal at 0.95 and
    // marked it read. So this class goes to the ops agent, which has
    // the ruleset and the headers — the same route local-classify already gives a
    // sender with no history. It also means a real person writing to the user for the
    // first time from a gmail address is read by the agent, never silently filed.
    // One-directional like the gate above: it can only WITHHOLD an auto-handle.
    // Measured over the first 84 Jev auto-files (77 distinct sender +
    // subject): 1 withheld, this one.
    // Skipped when a test injects senderHistory (no full email-mem text to read).
    const firstContact = deps.firstContact ? !!deps.firstContact(from)
      : memFull !== null && isFreeMailSender(from) && !senderKnown(from, memFull);
    const auto = v.priority === "P3" && v[NEEDS_KEY] !== true && ruled?.escalate !== true && !firstContact;
    const pend = { ts: new Date().toISOString(), messageId, from, subject, jev: { label: v.label, priority: v.priority, [NEEDS_KEY]: v[NEEDS_KEY], confidence: r.jev?.confidence }, acted_by: auto ? "jev" : "dispatch" };
    if (ruled?.escalate === true && v.priority === "P3" && v[NEEDS_KEY] !== true) pend.withheld_by = ruled.source;
    else if (firstContact && v.priority === "P3" && v[NEEDS_KEY] !== true) pend.withheld_by = "first-contact-free-mail";
    if (siteConfig(SITE).inShadow) {
      if (!auto) {
        pend.compare = "reconcile";             // ops agent decides; reconciler compares
      } else {
        const local = await legacy().catch(() => null);
        if (!localAuto(local)) {                 // today this would have been a Sonnet dispatch
          pend.compare = "sonnet-shadow";
          (deps.spawnSonnetShadow || spawnSonnetShadow)({ messageId, from, subject, jev: pend.jev });
        }
      }
    }
    appendRow(PENDING_FILE, pend);
    return auto ? { auto: true, label: v.label, priority: "P3", via: "jev", source: "jev" } : { auto: false, via: "dispatch", jev: pend.jev };
  }

  const v = r.value;
  // A sub-threshold Jev verdict that says P1/P2 (or needs-the-user) VETOES a legacy
  // auto-P3. Jev fell under the bar, but it read the body; the
  // legacy consensus never did — it replays the sender's ROUTINE mail. Vendor
  // support-advisor replies on a case the user opened came back from Jev
  // P2 0.67 and were then auto-filed P3 at confidence 1 by a vendor-domain consensus
  // built from receipts and sign-in notices; one was missed for a week. Like the
  // never-auto-handle gate above, this can only WITHHOLD an auto-handle: the worst
  // case is an ops dispatch that did not strictly need to happen.
  //
  // A sub-threshold Jev LABEL that differs from the legacy label withholds too
  // too. Until then the needs-the-user flag was doing this job by accident:
  // every wrong legacy label in the shadow logs (consumer promos filed under a
  // business label, all from a sender-domain consensus that spans two
  // relationships) was a promo Jev wrongly said needed the user, so the veto caught
  // it. Teaching Jev that a promo CTA is not an ask removes that flag, and without
  // this line the next such promo would auto-file under the business label. Measured over the
  // first 73 legacy auto-files Jev answered: 2 new withholds (both
  // legacy-right, so one ops turn each), all 6 wrong promo labels still withheld.
  const jv = r.jev && !r.jev.error ? r.jev.value : null;
  const labelSplit = !!jv && !!jv.label && !!v?.label && jv.label !== v.label;
  const jevFlags = !!jv && (jv.priority === "P1" || jv.priority === "P2" || jv[NEEDS_KEY] === true || labelSplit);
  if (localAuto(v) && !jevFlags) return { auto: true, label: v.label, priority: "P3", via: "local", source: v.source, reason: r.reason };
  // Jev answered but below threshold, and local escalated → ops decides. Still
  // compare Jev's (unused) verdict against what ops did: the calibration data for
  // whether the threshold is right.
  if (r.jev && !r.jev.error && r.jev.value?.label && siteConfig(SITE).inShadow) {
    appendRow(PENDING_FILE, { ts: new Date().toISOString(), messageId, from, subject, jev: { label: r.jev.value.label, priority: r.jev.value.priority, [NEEDS_KEY]: r.jev.value[NEEDS_KEY], confidence: r.jev.confidence }, acted_by: "dispatch", jev_used: false, compare: "reconcile" });
  }
  return { auto: false, via: "dispatch", reason: r.reason };
}

// ---- Sonnet shadow (detached, side-effect-free) -----------------------------

export function spawnSonnetShadow({ messageId, from, subject, jev }) {
  try {
    const c = spawn(process.execPath, [CLI, "--shadow-sonnet", messageId, "--from", from || "", "--subject", subject || "", "--jev-json", JSON.stringify(jev)],
      { detached: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
  } catch {}
}

export function sonnetPrompt({ from, subject, body }) {
  let rules = "";
  // The merged ruleset (kernel + local companion; triage-rules.mjs), read now.
  try { rules = loadMergedRules(); } catch {}
  return `You are running in CLASSIFY-ONLY mode for a shadow comparison. Do NOT take any action and do not call any tools.
Apply the email triage ruleset below (Steps 3 and 4: label and priority) to the email at the end, exactly as the ops agent would.
Output ONLY a JSON object: {"label":"<${LABELS.join("|")}>","priority":"P1|P2|P3"}

===== RULESET =====
${rules}
===== EMAIL =====
FROM: ${from}
SUBJECT: ${subject}
BODY:
${body}`;
}

export async function runSonnetShadow({ messageId, from, subject, jev }, deps = {}) {
  const body = await (deps.fetchBody || fetchBody)(messageId).catch(() => "");
  const prompt = sonnetPrompt({ from, subject, body });
  // Tool-less, Max-only, off the edva tree's settings (lib/jev-claude.mjs):
  // this shadow must not be able to label, star or send anything.
  const out = deps.runClaude ? await deps.runClaude(prompt)
    : await runToolless({ bin: CLAUDE_BIN, model: "claude-sonnet-5-5", prompt, timeoutMs: 120000 });
  const v = parseModelJson(out);
  if (!v || !LABELS.includes(v.label) || !["P1", "P2", "P3"].includes(v.priority)) return null;
  const legacyValue = { label: v.label, priority: v.priority, via: "sonnet-shadow" };
  recordLateComparison({
    site: SITE, id: messageId,
    jevRow: { used: "jev", input: { from, subject }, jev: { value: jev, confidence: jev?.confidence } },
    legacyValue, agree: jev?.label === v.label && jev?.priority === v.priority,
  });
  return legacyValue;
}
