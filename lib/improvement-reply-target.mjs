// improvement-reply-target — given the chat message a reply is THREADED to, say
// which improvement card that message anchors, and what the agent may do about it.
//
// WHY. The Improvements channel is a card feed with no input bar,
// so there was nowhere to ASK anything about a proposed self-modification —
// the user's only vocabulary was approve, retry, or ignore. The card's new "Chat"
// action fixes that by dropping the user into the chat channel with a reply composer
// open on an anchor message for that card (SelfImproveApproval.chatAnchor;
// `self_improve_approvals.chat_message_id` is the join).
//
// phone-channel already quotes a threaded reply's parent into the prompt, so the
// agent sees the anchor's TEXT. That is not enough here. The anchor is a
// snapshot written when the user first opened the thread; by the time the user asks "did
// this land?" the card may have been signed, applied, or failed, and the files
// it touches were never in the anchor at all. Answering "what does this actually
// change?" from a one-line summary is guesswork, and guessing is the worst
// possible failure mode on a queue whose items rewrite Edva's own source.
//
// So this module resolves the LIVE row and hands the agent (a) current status,
// (b) the exact files, (c) the commands that act on it. Deliberately fail-soft:
// any error means "not an improvement thread", never a thrown message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { installRoot } from "./root.cjs";

const ROOT = installRoot();
const { instanceValue, supabaseUrl } = createRequire(import.meta.url)("./instance.cjs");
// The operator's name as the prompt calls them (instance owner_name).
const owner = () => instanceValue("owner_name");

function supabase() {
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    try {
      key = (fs.readFileSync(path.join(ROOT, ".env"), "utf8")
        .match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m) || [])[1];
    } catch { /* fail-soft */ }
  }
  const base = process.env.SUPABASE_URL || supabaseUrl();
  if (!key || !base) return null;
  return {
    base,
    headers: { apikey: key, Authorization: "Bearer " + key },
  };
}

/**
 * Resolve the chat message `messageId` (a `reply_to` value) to the improvement
 * card it anchors.
 *
 * @returns {null | {id, item_type, summary, rationale, status, risk, skipped, files: string[], result}}
 */
export async function findImprovementByAnchor(messageId, { timeoutMs = 4000 } = {}) {
  if (!messageId) return null;
  const s = supabase();
  if (!s) return null;
  try {
    const url = `${s.base}/rest/v1/self_improve_approvals`
      + `?chat_message_id=eq.${encodeURIComponent(messageId)}`
      + `&select=id,item_type,summary,rationale,status,risk,skipped,item_json,result&limit=1`;
    const r = await fetch(url, { headers: s.headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const { item_json, ...rest } = row;
    return { ...rest, files: Object.keys(item_json?.files || {}) };
  } catch {
    return null;
  }
}

/** Human-readable state, folding the orthogonal `skipped` flag back in. */
function describeStatus(row) {
  const base = {
    pending: `waiting on ${owner()}'s Face-ID approval — nothing has been written`,
    signed: "signed, waiting for the host's next 2-minute poll to apply it",
    approved: "verified and being applied right now",
    retry_requested: "queued for a retry of the apply step",
    applied: "applied and committed",
    failed: "REJECTED — the signature/authorization check did not pass",
    apply_failed: "the apply step failed mechanically after the signature verified (retryable, no new Face ID needed)",
    denied: "declined",
    expired: "expired unapproved",
  }[row.status] || row.status;
  return row.skipped ? `SKIPPED by ${owner()} (underlying state: ${base})` : base;
}

/**
 * The prompt block for a reply threaded to an improvement anchor. Empty string
 * when this isn't one — callers concatenate unconditionally.
 */
export async function improvementRoutingBlock({ replyTo } = {}) {
  const row = await findImprovementByAnchor(replyTo);
  if (!row) return "";

  const files = row.files.length
    ? row.files.map((f) => `  - ${f}`).join("\n")
    : "  (none recorded on the card)";

  const err = row.result?.error ? `\nRecorded failure: ${row.result.error}` : "";

  const name = owner();
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  return `[Improvement thread] ${Name} is replying about a specific improvement card, not about the newest thing in the conversation. Answer in THAT context.

  id:      ${row.id}
  type:    ${row.item_type}${row.risk ? ` (risk: ${row.risk})` : ""}
  status:  ${describeStatus(row)}
  summary: ${row.summary}
files it changes:
${files}${err}

Read the actual change before characterising it — \`self-improve-show ${row.id}\` prints the full payload (add --full for whole files). Do not describe what it does from the summary alone; the summary is one line written when it was filed.

What you MAY do from this thread:
  - Answer questions about the change, its risk, and its blast radius.
  - Record that ${name} doesn't want it: \`self-improve-skip ${row.id}\` (reversible with --undo). Only on an explicit decision from them, never inferred from a critical question.
  - Retry a mechanically failed apply: \`self-improve-retry ${row.id}\`.
What you may NOT do: approve, sign, or apply it. That is Face ID on their device only — there is no path from this conversation to a change landing, and offering one would be a lie about the gate.
If their feedback means the change should be DIFFERENT, say so plainly and let the next improvement pass author a replacement; do not hand-edit the files behind the card.

`;
}
