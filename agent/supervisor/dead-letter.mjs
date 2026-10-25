// dead-letter.mjs — what the ops supervisor does with a turn its hang watchdog
// has given up on.
//
// WHEN a turn counts as hung is turn-watchdog.mjs's call, and requeue-vs-drop
// is index.mjs _onTurnHang's; neither lives here. This module only covers what
// happens AFTER a drop. Without it a dropped item leaves one silent
// System-tab row and nothing else: an emailed request from the user can be
// killed twice, dropped, and the reply the user is waiting for on the thread
// never comes.
//
// Now every dropped item is appended to data/dead-letter.jsonl. When the
// item is the user's OWN request, the supervisor also tells the user in chat (through
// the normal precheck-gated send) and puts the item back at the tail of the
// queue ONCE, as a fresh item flagged `hangRetry` whose header lists what the
// killed attempts already sent and which background jobs they started. A
// retried item is dropped on its first hang and never retried again.
//
// "The user's own request" is decided from structure, never from the text: a
// gmail:<messageId> item whose row in the command-channel ledger
// (email-inbound-handled.jsonl, written by gmail-source at the moment it
// dispatched that message BECAUSE it was addressed to Edva's address) has
// From = OWNER_ADDRESS. Everything else (cron jobs, triage of other mail,
// email-inbound escalations, whose allowlist also admits other senders) is only
// dead-lettered; a cron job runs again on its own schedule.
//
// The chat lines never quote the email's subject: Edva's own subjects can
// carry sensitive figures (money, health), and these lines pass through the Sonnet
// precheck, its log and the lock screen (Financial rule 5). They name the email
// by how long ago it arrived. The retry header (read only by the agent) keeps
// the subject.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { inboundLedgerFile, normalizeRfcMessageId } from "./gmail-source.mjs";

import { installTools } from "../../lib/root.cjs";
// The operator's own address and name (lib/instance.cjs).
const { instance } = createRequire(import.meta.url)("../../lib/instance.cjs");
const INSTANCE = instance();
export const OWNER_ADDRESS = String(INSTANCE.owner_email || "").trim().toLowerCase();
const OWNER_NAME = INSTANCE.owner_name;
const LEDGER_ACTION = "dispatched-via-gmail-command-channel";
const SENT_SCAN_LINES = 500;

const dataFile = (name) => installTools("data", name);
export const deadLetterFile = () => dataFile("dead-letter.jsonl");
export const sentMailFile = () => dataFile("edva-sent-mail.jsonl");
export const jobsDir = () => dataFile("jobs");

function tailRows(file, n) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const l of raw.split("\n").filter(Boolean).slice(-n)) { try { rows.push(JSON.parse(l)); } catch {} }
  return rows;
}

// "Name <addr>" -> "addr". Header structure, no regex.
export function bareAddress(v) {
  const s = String(v || "");
  const i = s.lastIndexOf("<"), j = s.lastIndexOf(">");
  return (i !== -1 && j > i ? s.slice(i + 1, j) : s).trim().toLowerCase();
}

// null, or { kind: "email", gmailId, rfcMessageId, subject, receivedAt } when
// the item is a command-channel email from the user. Read-only, fails to null.
export function ownRequestFor(item, { ledgerFile = inboundLedgerFile() } = {}) {
  const src = String(item?.source || "");
  if (!src.startsWith("gmail:")) return null;
  const gmailId = src.slice("gmail:".length);
  if (!gmailId) return null;
  const row = tailRows(ledgerFile, 2000).reverse().find((r) => r && r.gmail_id === gmailId && r.action_taken === LEDGER_ACTION);
  if (!row || !OWNER_ADDRESS || bareAddress(row.from) !== OWNER_ADDRESS) return null;
  return { kind: "email", gmailId, rfcMessageId: row.message_id || null, subject: String(row.subject || "").slice(0, 140), receivedAt: row.ts || null };
}

// Mail Edva sent since `sinceMs` (email-send's own log), and whether a reply
// on the user's thread is among it. state is "replied", "not-replied" or "unknown":
// unknown when the log can't be read, a line in it doesn't parse, the ledger
// row had no Message-ID to match, or the scanned tail doesn't reach back to
// `sinceMs`. Only a definite answer is ever said to the user (Rule #2).
export function sentSince(sinceMs, rfcMessageId, { file = sentMailFile() } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { state: "unknown", rows: [] }; }
  const lines = raw.split("\n").filter(Boolean);
  const tail = lines.slice(-SENT_SCAN_LINES);
  const want = normalizeRfcMessageId(rfcMessageId);
  let broken = false, oldest = Infinity;
  const rows = [];
  for (const l of tail) {
    let r; try { r = JSON.parse(l); } catch { broken = true; continue; }
    const t = Date.parse(r?.ts);
    if (t < oldest) oldest = t;
    if (!(t >= sinceMs)) continue;
    rows.push({ ts: r.ts, subject: String(r.subject || "").slice(0, 140), replyToThis: !!want && normalizeRfcMessageId(r.in_reply_to) === want });
  }
  const short = lines.length > tail.length && oldest > sinceMs;
  const state = rows.some((r) => r.replyToThis) ? "replied" : (!want || broken || short) ? "unknown" : "not-replied";
  return { state, rows };
}

// job-run ids start with their UTC start time, YYYYMMDD-HHMMSS (job-runner.mjs
// genJobId). Machine structure, read by slicing.
function idStartMs(name) {
  const d = String(name).slice(0, 15);
  if (d.length !== 15 || d[8] !== "-") return NaN;
  const n = (a, b) => Number(d.slice(a, b));
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(9, 11), n(11, 13), n(13, 15));
}

// Background jobs (the job-run registry, read the way job-list reads it)
// started since `sinceMs`. A killed turn's job-run child outlives it: a job
// launched seconds before the kill can send its email minutes later, by which
// time a retry would have started. Files whose id-date is before the request are not opened.
export function jobsSince(sinceMs, { dir = jobsDir() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".tmp")); } catch { return []; }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const jobs = [];
  for (const f of names) {
    const idMs = idStartMs(f);
    if (idMs + 1000 <= sinceMs) continue;   // the id-date truncates to the second
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!(Date.parse(j?.started_at) >= sinceMs)) continue;
    const live = j.status === "running" || j.status === "starting";
    const running = live && !!j.pid && alive(j.pid);
    const label = running ? "STILL RUNNING" : live ? `ended (process gone; last status ${j.status})` : j.status;
    jobs.push({ id: j.id, name: j.name, status: j.status, startedAt: j.started_at, running, label });
  }
  return jobs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

// The whole decision. A retried item never earns a second retry. The first
// note promises an answer on the user's thread, so it is skipped only when a reply on
// that thread definitely went out; "unknown" still sends it.
export function planForDrop(item, own, { replyState = "unknown" } = {}) {
  if (item?.hangRetry) return { retry: false, notice: own ? "final" : null };
  if (!own) return { retry: false, notice: null };
  return { retry: true, notice: replyState === "replied" ? null : "first" };
}

export function buildRetryItem(item, { own = null, sent = [], replyState = "unknown", jobs = [], noticeQueued = false, now = Date.now() } = {}) {
  const first = new Date(item.enqueuedAt || now).toISOString();
  const lines = [
    `[supervisor] RETRY. This task got stuck twice (the hang watchdog killed both attempts; it first arrived ${first}) and was dead-lettered. This is its one retry: if it gets stuck again it is dropped for good.`,
    `The killed attempts may already have done some or all of the work. Before anything with a side effect, check what already happened since then: \`git -C ~/Dev/edva log --since=${first} --oneline\`, \`~/Dev/edva/bin/job-list\`, and the lists below (as of when it was set aside). Never send a second reply, email or message for something already sent; do only what is still missing. If what is left is long, launch it with \`~/Dev/edva/bin/job-run\` instead of waiting on it in this turn.`,
  ];
  if (!jobs.length) lines.push(`No background job (job-run) was started since ${first}.`);
  else {
    lines.push(`Background jobs started since ${first} (data/jobs):`);
    for (const j of jobs.slice(-12)) lines.push(`  - ${j.id} ${j.name || ""} ${j.label}`);
    lines.push("A job the stuck attempt started may still be running. If one is, do not relaunch it or redo its work: wait for it (`~/Dev/edva/bin/job-status <id>`), then check its result.");
  }
  if (own?.kind === "email") {
    if (own.subject) lines.push(`Their email's subject: "${own.subject}".`);
    if (sent.length) {
      lines.push(`Edva's sent-mail log since ${first} (data/edva-sent-mail.jsonl):`);
      for (const s of sent.slice(-12)) lines.push(`  - ${s.ts} "${s.subject}"${s.replyToThis ? " (a reply on THIS email's thread)" : ""}`);
    }
    if (replyState === "unknown") lines.push("Whether a reply on the user's thread already went out could NOT be determined from the sent-mail log; check the thread before replying.");
    else if (!sent.length) lines.push(`Edva's sent-mail log shows nothing sent since ${first}.`);
  }
  if (noticeQueued) lines.push(`A short note to ${OWNER_NAME} saying this got stuck was queued and may have been held back; don't refer to it.`);
  lines.push("--- original task ---");
  return {
    id: randomUUID(),
    source: item.source,
    content: `${lines.join("\n")}\n${item.content ?? ""}`,
    enqueuedAt: now,
    hangRetry: true,
    retryOf: item.id,
    firstEnqueuedAt: item.enqueuedAt ?? null,
    ownRequest: own,
  };
}

// "your email from about 40 minutes ago". Elapsed time only, so no timezone.
export function emailAgo(receivedAt, now = Date.now()) {
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t) || t > now + 60_000) return "your last email to me";
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 3) return "the email you just sent me";
  if (min < 50) return `your email from about ${Math.max(5, Math.round(min / 5) * 5)} minutes ago`;
  if (min < 90) return "your email from about an hour ago";
  const h = Math.round(min / 60);
  if (h < 24) return `your email from about ${h} hours ago`;
  const days = Math.round(h / 24);
  return days === 1 ? "your email from yesterday" : `your email from about ${days} days ago`;
}

// The one plain line the user gets (Rule #0 voice: no "dispatched", no
// "watchdog", no subject). The closing line stands alone: the user may never have
// seen the first (skipped after a reply, or held back by the precheck).
export function stuckNotice(kind, own, { replyState = "unknown", now = Date.now() } = {}) {
  const what = emailAgo(own?.receivedAt, now);
  if (kind === "final") {
    const thread = replyState === "replied"
      ? "A reply on that thread did go out earlier; if anything is still missing, a quick reply there will start me on it fresh."
      : replyState === "not-replied"
      ? "Nothing has gone back on that thread yet; if you still need it, a quick reply there will start me on it fresh."
      : "If you still need it, a quick reply on that thread will start me on it fresh.";
    return `I kept getting stuck on ${what}, three tries in all, so I've stopped rather than keep looping. ${thread}`;
  }
  return `I got stuck twice on ${what}, so I've set it aside for now rather than hold everything else up. I'll take one more run at it once I've cleared what's ahead, and answer you on that thread.`;
}

export function appendDeadLetter(row, file = deadLetterFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
    return true;
  } catch { return false; }
}
