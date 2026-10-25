// email-inbound-gate — the structural half of the email-inbound job
// Mail to the agent's address arrives from the Cloudflare Email
// Worker as parsed JSON; before this module, the ops agent spent part of its
// turn on three steps that are machine facts, not language:
//
//   1. Sender allowlist — an exact match on the parsed From address.
//   2. "Is this a reply to something Edva sent?" — a lookup of the
//      In-Reply-To / References message ids (or the exact subject) in the
//      sent-mail log email-send writes (data/edva-sent-mail.jsonl).
//   3. The handled-log line.
//
// They now run here, in the supervisor's /email-inbound route
// (agent/supervisor/http-server.mjs), before anything is dispatched. A sender
// off the allowlist is dropped without a turn; a Message-ID already handled
// (a Worker retry) is not dispatched twice; and the agent receives the reply
// context already resolved. What the message ASKS stays with the model.
//
// Never decides what the message means. No regex on any message content.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { instance, localConfig } = createRequire(import.meta.url)("./instance.cjs");
// Who may email the agent's address directly: the user, plus whoever this
// installation lists (agent/local/config/email-inbound.json `allowlist`,
// the full ordered list; the user's own address first). `held_example` is a
// name the held-email notice offers as an example of "say who it is".
const LOCAL = localConfig("email-inbound", {
  allowlist: instance().owner_email ? [instance().owner_email] : [],
  held_example: "",
});
export const ALLOWLIST = Object.freeze(LOCAL.allowlist.map((a) => String(a).trim().toLowerCase()));

const HANDLED_SCAN_LINES = 2000;
const SENT_SCAN_LINES = 5000;

export function normAddress(addr) {
  return String(addr || "").trim().toLowerCase();
}

export function isAllowlisted(from) {
  return ALLOWLIST.includes(normAddress(from));
}

function tailJsonl(file, maxLines) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean);
  return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Strip leading reply/forward markers that mail clients add to a Subject
// header ("Re: ", "RE: ", "Fwd: "), repeatedly. Header mechanics, not meaning.
export function baseSubject(subject) {
  let s = String(subject || "").trim();
  for (;;) {
    const lower = s.toLowerCase();
    const prefix = ["re:", "fwd:", "fw:"].find((p) => lower.startsWith(p));
    if (!prefix) return s;
    s = s.slice(prefix.length).trim();
  }
}

// Find the Edva-sent email this message replies to.
// Match 1: an In-Reply-To / References message id that contains the
//          SMTP2Go email_id the sent log recorded.
// Match 2: the exact base subject, sent to this sender.
// Returns the newest matching sent-log entry, or null.
export function findRepliedTo(email, sentEntries) {
  const ids = [email.in_reply_to, ...(Array.isArray(email.references) ? email.references : [email.references])]
    .filter(Boolean).map(String);
  const from = normAddress(email.from);
  const subj = baseSubject(email.subject);
  let byId = null;
  let bySubject = null;
  for (const e of sentEntries) {
    const eid = e && e.email_id ? String(e.email_id) : "";
    if (eid.length >= 8 && ids.some((id) => id.includes(eid))) byId = e;
    const to = Array.isArray(e && e.to) ? e.to : [e && e.to];
    if (subj && e && baseSubject(e.subject) === subj && to.some((t) => normAddress(t) === from)) bySubject = e;
  }
  const hit = byId || bySubject;
  if (!hit) return null;
  return {
    matched_by: byId ? "message-id" : "subject",
    sent_at: hit.ts || null,
    subject: hit.subject || null,
    email_id: hit.email_id || null,
    originating_task: hit.originating_task || null,
  };
}

export function alreadyHandled(messageId, handledEntries) {
  if (!messageId) return false;
  return handledEntries.some((h) => h && h.message_id === messageId);
}

function append(file, row) {
  try { fs.appendFileSync(file, JSON.stringify(row) + "\n"); } catch {}
}

// ── Held mail from an unknown person ───────────────────────────────────────
// Someone the user knows emailed from a second address and it was dropped as
// not-allowlisted without a word. The user's decision: hold an
// email from an unknown PERSON and tell the user in chat with the exact address;
// only the user's explicit "add <address>" adds it, through the installation's
// allowlist-add step, which refuses any address that is not exactly one held here. Nothing in this
// module grants anyone anything — holding is the whole of it.
//
// "A person, not a newsletter or a robot" is decided from mail STRUCTURE only:
//   - the From domain is DKIM/DMARC-aligned (auth.aligned) — an unverified
//     From could be anyone, so it is never worth offering to add;
//   - no bulk/automation headers (List-Unsubscribe, List-Id, Auto-Submitted
//     other than "no", Precedence bulk/list/junk), as the email Worker reports
//     them in `bulk`;
//   - the SMTP envelope sender is on the From domain. Mailing services send
//     from their own bounce domain (Supabase's notices: mtasv.net, amazonses);
//     a person's mail client does not.
// Nothing here reads the subject or body.
export const HELD_FILE = "email-inbound-held.jsonl";
export const HELD_DIR = "email-inbound-held";
export const HOLD_MAX_AGE_DAYS = 30;

const domainOf = (addr) => normAddress(addr).split("@").pop() || "";

export function looksAutomated(email) {
  const b = (email && email.bulk) || {};
  if (b.list_unsubscribe || b.list_id) return true;
  const autoSub = String(b.auto_submitted || "").trim().toLowerCase();
  if (autoSub && autoSub !== "no") return true;
  if (["bulk", "list", "junk"].includes(String(b.precedence || "").trim().toLowerCase())) return true;
  const envFrom = email && email.envelope && email.envelope.from;
  if (envFrom && domainOf(envFrom) !== domainOf(email.from)) return true;
  return false;
}

export function isHoldable(email) {
  return Boolean(email && email.from && email.auth && email.auth.aligned === true && !looksAutomated(email));
}

// Latest status per hold_id (rows are append-only: "held", then "added" /
// "dismissed"). Returns [{...heldRow, status}] newest last.
export function readHolds(dataDir) {
  const rows = tailJsonl(path.join(dataDir, HELD_FILE), 5000);
  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.hold_id) continue;
    if (r.status === "held") byId.set(r.hold_id, { ...r });
    else if (byId.has(r.hold_id)) byId.set(r.hold_id, { ...byId.get(r.hold_id), status: r.status, resolved_at: r.ts });
  }
  return [...byId.values()];
}

// The pending (status "held", not expired) hold for exactly this address, newest first.
export function pendingHoldsFor(address, dataDir, now = new Date()) {
  const a = normAddress(address);
  const cutoff = now.getTime() - HOLD_MAX_AGE_DAYS * 86400000;
  return readHolds(dataDir)
    .filter((h) => h.status === "held" && normAddress(h.from) === a && Date.parse(h.ts) >= cutoff)
    .reverse();
}

function holdEmail(email, { dataDir, now, base }) {
  const holds = readHolds(dataDir);
  if (email.message_id && holds.some((h) => h.message_id === email.message_id)) return { action: "duplicate" };
  // One chat message per address while it is pending: a second email from the
  // same unknown address is held too, but does not ping again.
  const alreadyAsked = pendingHoldsFor(email.from, dataDir, now).length > 0;
  const holdId = `h-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const row = { ...base, from: normAddress(email.from), from_name: email.from_name || null, hold_id: holdId, status: "held" };
  try {
    fs.mkdirSync(path.join(dataDir, HELD_DIR), { recursive: true });
    fs.writeFileSync(path.join(dataDir, HELD_DIR, `${holdId}.json`), JSON.stringify(email));
  } catch {}
  append(path.join(dataDir, HELD_FILE), row);
  return { action: "hold", held: row, notify: !alreadyAsked };
}

// The one chat line about a held email. Code-composed from the address and the
// subject header, so it says exactly which address would be added.
export function heldNotice(held) {
  const subj = String(held.subject || "").trim() || "(no subject)";
  const to = instance().agent_email || "the agent's address";
  const eg = LOCAL.held_example ? ` (e.g. ${LOCAL.held_example})` : "";
  return `📨 Held an email to ${to} from an address I don't know: ${held.from} — subject "${subj}". ` +
    `If it's family, reply "add ${held.from}" and say who it is${eg}; otherwise ignore it and nothing changes.`;
}

// Returns { action: "drop" | "duplicate" | "hold" | "dispatch", context?, held?, notify? }
// and writes the dropped / held / handled log rows itself.
export function prepareInbound(email, { dataDir, now = new Date() } = {}) {
  const dropped = path.join(dataDir, "email-inbound-dropped.jsonl");
  const handled = path.join(dataDir, "email-inbound-handled.jsonl");
  const sent = path.join(dataDir, "edva-sent-mail.jsonl");
  const ts = now.toISOString();
  const base = { ts, message_id: email.message_id || null, from: email.from || null, subject: email.subject || null };

  if (!isAllowlisted(email.from)) {
    if (isHoldable(email)) return holdEmail(email, { dataDir, now, base });
    append(dropped, { ...base, reason: "not-allowlisted" });
    return { action: "drop" };
  }
  if (alreadyHandled(email.message_id, tailJsonl(handled, HANDLED_SCAN_LINES))) {
    return { action: "duplicate" };
  }
  const repliedTo = findRepliedTo(email, tailJsonl(sent, SENT_SCAN_LINES));
  append(handled, { ...base, action_taken: "dispatched", reply_to_edva: repliedTo });
  return {
    action: "dispatch",
    context: { allowlisted: true, reply_to_edva: repliedTo },
  };
}
