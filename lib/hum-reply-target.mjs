// hum-reply-target — given the chat message a reply is THREADED to, say which
// hum item that message was.
//
// WHY. Threaded replies shipped so the user can answer a specific
// Edva message after several have stacked up (e.g. read later, after
// driving). The chat side of that is solved: `edva_messages.reply_to` pins the user's reply and
// phone-channel quotes the parent into the prompt.
//
// Hum's bookkeeping was still time-keyed, which reopened the same bug one layer
// down:
//   - `hum-pending-question.json` is a SINGLE slot — an answer routes to
//     whatever question happens to occupy it.
//   - `suggestion-classify` attributes a free-text reply to the most recent
//     open ping within 6h.
//   - `edva hum feedback last <token>` files a reaction against the newest
//     ping row.
// So threading "yes" to a question from 40 minutes ago could still be recorded
// against a newer, unrelated one — the reply arrives correct in chat and gets
// mis-filed in hum's state.
//
// Every hum ping already carries its chat message id (`hum-ping` writes
// `message_id` into `hum-feedback.jsonl`), so the join exists; nothing consumed
// it. This module is that consumer, and the single place the mapping lives.
//
// Deliberately dependency-free and fail-soft: any unreadable/absent file means
// "unknown", never a throw. Callers treat null as "not a reply to a hum item".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openQuestions, readLedger } from "./open-questions.mjs";

import { mayAnswerSeveral } from "./hum-reply-segments.mjs";
import { fileURLToPath } from "node:url";
import { loadHook } from "./ext-hooks.mjs";

import { installTools } from "./root.cjs";
// Ask-first offer lanes: a ping that asks "want X?" and acts only on a yes. An
// installation registers its own in lib/_ext/hum-offer-lanes.mjs as
//   export const offerLanes = { <lane>: { windowMin, line(row, sentAgo) } }
// and an un-reacted offer younger than windowMin minutes gets line(...) — the
// handling instruction for the agent — in the [Hum state] block, after the
// last-ping line. Past the window the moment (and the position the offer was
// made at) has gone. None registered: no offer lines.
const OFFER_LANES = (await loadHook(path.dirname(fileURLToPath(import.meta.url)), "hum-offer-lanes"))?.offerLanes || {};

/** Rows scanned from the tail of hum-feedback.jsonl. ~2 months of pings. */
const FEEDBACK_TAIL_ROWS = 500;

export function humDataDir() {
  return process.env.EDVA_DATA_DIR || installTools("data");
}

function readJSON(p) {
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw || raw === "null") return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function unexpired(o, now = Date.now()) {
  if (!o) return false;
  if (!o.expires_at) return true;
  const t = new Date(o.expires_at).getTime();
  return Number.isNaN(t) ? true : t > now;
}

/** Tail-scan hum-feedback.jsonl for the ping that was delivered as `messageId`. */
function findPingByMessageId(messageId, dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "hum-feedback.jsonl"), "utf8"); }
  catch { return null; }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 1 - FEEDBACK_TAIL_ROWS; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row.message_id && row.message_id === messageId) return row;
  }
  return null;
}

/**
 * Resolve the chat message `messageId` (a `reply_to` value) to the hum item it
 * carried.
 *
 * @returns {null | {
 *   kind: "question" | "approval" | "canary" | "ping",
 *   route: string,            // the exact command that files this reply
 *   is_current_pending: boolean, // also what the time-based rules would pick
 *   ...item fields
 * }}
 */
export function resolveHumTarget(messageId, dir = humDataDir(), now = Date.now()) {
  if (!messageId) return null;

  // 1. A delivered question — the pending slot stamps the message it was sent as.
  const q = readJSON(path.join(dir, "hum-pending-question.json"));
  if (q && q.delivered_msg_id && q.delivered_msg_id === messageId) {
    return {
      kind: "question",
      id: q.id,
      subject: q.subject || null,
      question: q.question || null,
      expired: !unexpired(q, now),
      is_current_pending: true,
      // A reply to the question's own message after its window closed is still the
      // answer; `--late` is what lets hum-answer accept it instead of refusing.
      route: unexpired(q, now) ? `hum-answer ${q.id} "<their answer>"` : `hum-answer ${q.id} --late "<their answer>"`,
    };
  }

  // 1b. Any OPEN question, including an earlier ask or re-ask whose slot is long
  // gone (open-questions ledger). Open means no --late is needed.
  const asked = openQuestions(now, readLedger(dir)).find((oq) => oq.msg_ids.includes(messageId));
  if (asked) {
    return {
      kind: "question",
      id: asked.id,
      subject: asked.subject || null,
      question: asked.question || null,
      expired: false,
      is_current_pending: Boolean(q && q.id === asked.id),
      route: `hum-answer ${asked.id} "<their answer>"`,
    };
  }

  // 2. A canary batch (three yes/no/skip candidates in one message).
  const canary = readJSON(path.join(dir, "hum-canary-pending.json"));
  if (canary && canary.message_id && canary.message_id === messageId) {
    return {
      kind: "canary",
      canary_id: canary.canary_id || null,
      candidates: canary.candidates || [],
      expired: !unexpired(canary, now),
      is_current_pending: true,
      route: "append one hum-feedback.jsonl row per matched item (see jobs/hum-canary.md)",
    };
  }

  // 3. Any hum ping — the row carries its own delivery id.
  const row = findPingByMessageId(messageId, dir);
  if (!row) return null;

  const headline = (row.findings || [])[0] || {};
  const dedupKey = headline.dedup_key || headline.subject_key || null;

  // A watchlist approval ping is a ping row whose finding is the approval ask;
  // the yes/no routes through the `watchlist` CLI, not `hum feedback`.
  if (dedupKey && dedupKey.startsWith("watchlist-approval:")) {
    const title = dedupKey.slice("watchlist-approval:".length);
    const pendingApproval = readJSON(path.join(dir, "hum-pending-approval.json"));
    return {
      kind: "approval",
      title,
      ping_id: row.ping_id || null,
      lane: row.lane || null,
      sent_at: row.sent_at || null,
      recommended_target: pendingApproval?.title === title ? pendingApproval.recommended_target : null,
      is_current_pending: !!pendingApproval && pendingApproval.title === title && unexpired(pendingApproval, now),
      route: `watchlist approve "${title}" [--category <cat>]   (or: watchlist reject "${title}")`,
    };
  }

  return {
    kind: "ping",
    ping_id: row.ping_id || null,
    lane: row.lane || null,
    dedup_key: dedupKey,
    summary: headline.summary || headline.signal || headline.subject_display || null,
    sent_at: row.sent_at || null,
    already_reacted: row.reaction || null,
    is_current_pending: isNewestPing(row.ping_id, dir),
    route: pingRoute(headline, dedupKey, row.ping_id),
  };
}

// Watchlist pings (v2) carry their own `watchlist …` command in
// supporting_data.route — a "loved it" / "skip the second one" reply must run
// that, not just file a lane reaction. The hum reaction is still recorded.
function pingRoute(headline, dedupKey, pingId) {
  const hum = `edva hum feedback ${pingId} <token>`;
  const own = headline?.supporting_data?.route;
  if (own && dedupKey && /^(watch-rate|watch-veto|watchlist-finale-day):/.test(dedupKey)) return `${own}   (then: ${hum})`;
  return hum;
}

function isNewestPing(pingId, dir) {
  if (!pingId) return false;
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "hum-feedback.jsonl"), "utf8"); }
  catch { return false; }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.ping_id) return r.ping_id === pingId;
    } catch { /* keep looking */ }
  }
  return false;
}

/**
 * What the time-based rules (CLAUDE.md Hum Inbound Handling Steps 0-3) would
 * currently match. Used to warn when a threaded reply points somewhere else.
 */
export function pendingSlots(dir = humDataDir(), now = Date.now()) {
  const q = readJSON(path.join(dir, "hum-pending-question.json"));
  const ap = readJSON(path.join(dir, "hum-pending-approval.json"));
  const canary = readJSON(path.join(dir, "hum-canary-pending.json"));
  return {
    question: unexpired(q, now) && q?.id ? { id: q.id, subject: q.subject || null } : null,
    approval: unexpired(ap, now) && ap?.title ? { title: ap.title } : null,
    canary: unexpired(canary, now) && canary?.canary_id ? { canary_id: canary.canary_id } : null,
  };
}

/**
 * What a hum finding actually offers to describe itself, in practice: `signal`
 * carries the real headline about half the time, `subject_display` is usually
 * absent (or the literal placeholder `(idea)`), `summary` is essentially never
 * set, and `dedup_key` is ALWAYS present and usually a slug or URL whose topic
 * words are the most reliable handle on what the ping was about
 * (`idea-…-acme-followup-reply`, `news:…regional-wildfires-update`).
 *
 * So: `subject` is the best human label for display, `matchText` is everything
 * available, handed to the attribution model as the item description. (Checked against 8 live pings on the production host
 * 2026-07-27 — matching on `subject_display`/`summary` alone would almost never
 * have fired in production.)
 */
/**
 * Topic words out of a dedup key.
 *
 * URL-shaped keys need care: a full path contributes section names like
 * `world` / `europe` / `business`, which match almost any sentence and would
 * pull unrelated segments onto the ping (caught by the URL-scaffolding test —
 * "some news about europe" was being attributed to an unrelated wildfires article).
 * The article slug — the last path segment — is where the topic actually lives,
 * so for URLs that's all we take.
 */
function deslug(dedupKey) {
  let s = String(dedupKey || "").replace(/^[a-z_]+:/i, "");   // drop the lane prefix
  if (/^https?:\/\//i.test(s) || /^www\./i.test(s)) {
    const path = s.split(/[?#]/)[0].replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop() || "";
    s = last.replace(/\.[a-z0-9]{2,5}$/i, "");                // strip .html/.php/…
  }
  return s.replace(/[^a-zA-Z0-9]+/g, " ").trim();
}

function describeFinding(headline, dedupKey, lane) {
  const placeholder = (s) => !s || /^\(.*\)$/.test(String(s).trim());
  const label = [headline.signal, headline.subject_display, headline.summary, headline.subject]
    .find((s) => !placeholder(s));
  const slug = deslug(dedupKey);
  const subject = label || slug || lane || "";
  const matchText = [label, headline.subject_display, slug]
    .filter((s) => !placeholder(s))
    .join(" ");
  return { subject, matchText: matchText || subject };
}

/**
 * Every hum item that could still be answered right now — the pending question,
 * a pending watchlist approval, an open canary, and un-reacted pings inside
 * `windowH`. This is the roster a catch-up reply may be answering several of at
 * once (see `hum-reply-segments.mjs` for why one reply is often several
 * answers).
 *
 * Newest first. A watchlist-approval ping is represented once, as an approval
 * (its answer routes through the `watchlist` CLI, not `hum feedback`).
 */
export function openHumItems(dir = humDataDir(), { windowH = 24, now = Date.now(), limit = 8 } = {}) {
  const items = [];
  const seenApprovals = new Set();

  const q = readJSON(path.join(dir, "hum-pending-question.json"));
  if (q?.id && unexpired(q, now)) {
    items.push({
      key: `question:${q.id}`, kind: "question", id: q.id,
      subject: q.subject || q.question || q.id,
      // The question text itself is the richest handle on what it's about.
      matchText: [q.subject, q.question].filter(Boolean).join(" ") || q.id,
      route: `hum-answer ${q.id} "<their answer>"`,
      sent_at: q.asked_at || null,
    });
  }

  const canary = readJSON(path.join(dir, "hum-canary-pending.json"));
  if (canary?.canary_id && unexpired(canary, now)) {
    items.push({
      key: `canary:${canary.canary_id}`, kind: "canary", id: canary.canary_id,
      subject: (canary.candidates || []).map((c) => c.summary).join(" ") || canary.canary_id,
      route: "append one hum-feedback.jsonl row per matched item (see jobs/hum-canary.md)",
      sent_at: canary.created_at || null,
    });
  }

  let raw;
  try { raw = fs.readFileSync(path.join(dir, "hum-feedback.jsonl"), "utf8"); }
  catch { raw = ""; }
  const lines = raw.split("\n").filter((l) => l.trim());
  const cutoff = now - windowH * 3600e3;
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 1 - FEEDBACK_TAIL_ROWS; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const sent = new Date(row.sent_at).getTime();
    // `continue`, not `break`: the log is append-only and therefore usually
    // chronological, but one out-of-order row must not truncate the roster and
    // silently hide every open item behind it.
    if (!Number.isNaN(sent) && sent < cutoff) continue;
    if (row.reaction) continue;                        // already answered
    const headline = (row.findings || [])[0] || {};
    const dedupKey = headline.dedup_key || headline.subject_key || null;

    if (dedupKey && dedupKey.startsWith("watchlist-approval:")) {
      const title = dedupKey.slice("watchlist-approval:".length);
      if (seenApprovals.has(title)) continue;
      seenApprovals.add(title);
      items.push({
        key: `approval:${title}`, kind: "approval", id: title,
        subject: title, matchText: title,
        route: `watchlist approve "${title}" [--category <cat>]   (or: watchlist reject "${title}")`,
        ping_id: row.ping_id || null, sent_at: row.sent_at || null,
      });
      continue;
    }
    if (!row.ping_id) continue;
    const { subject, matchText } = describeFinding(headline, dedupKey, row.lane);
    items.push({
      key: `ping:${row.ping_id}`, kind: "ping", id: row.ping_id, lane: row.lane || null,
      subject: subject || row.ping_id, matchText,
      route: pingRoute(headline, dedupKey, row.ping_id),
      ping_id: row.ping_id, sent_at: row.sent_at || null,
    });
  }

  items.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));
  return items.slice(0, limit);
}

/**
 * One-line routing hint for the agent prompt. Returns "" when the threaded
 * parent has nothing to do with hum — which is itself the useful signal: the
 * time-based rules would otherwise have filed the reply against whatever is
 * pending.
 */
export function humRoutingLine(messageId, dir = humDataDir(), now = Date.now()) {
  const target = resolveHumTarget(messageId, dir, now);
  const slots = pendingSlots(dir, now);
  const anyPending = slots.question || slots.approval || slots.canary;

  if (!target) {
    if (!anyPending) return "";
    const names = [
      slots.question && `question ${slots.question.id}`,
      slots.approval && `watchlist approval "${slots.approval.title}"`,
      slots.canary && `canary ${slots.canary.canary_id}`,
    ].filter(Boolean).join(", ");
    return `[Hum routing] The message the user replied to is NOT a hum ping. Do NOT file this reply against the currently-pending ${names} — that slot is unrelated to what the user answered.`;
  }

  const parts = [`[Hum routing] The message the user replied to was hum's ${target.kind}`];
  if (target.kind === "question") parts.push(`\`${target.id}\`${target.subject ? ` (${target.subject})` : ""}`);
  if (target.kind === "approval") parts.push(`for "${target.title}"`);
  if (target.kind === "canary") parts.push(`\`${target.canary_id}\``);
  if (target.kind === "ping") parts.push(`\`${target.ping_id}\` (lane ${target.lane})`);
  if (target.expired) parts.push("— its reply window has expired, but the user is clearly answering it, so honor it");
  let line = parts.join(" ") + `. If this reply is an answer or reaction, file it with: ${target.route}`;
  if (!target.is_current_pending) {
    line += " — NOT against whatever is newest/pending, which is a different item.";
  }
  if (target.kind === "ping" && target.already_reacted) {
    line += ` (a "${target.already_reacted}" reaction is already recorded on it — this reply supersedes or adds to that.)`;
  }
  return line;
}

/**
 * The hum state the chat agent's Hum Inbound steps need, precomputed
 * (2026-10-04). Those steps used to have the model read three JSON files,
 * scan hum-feedback newest-first and do the 2h / 4h / 6h window arithmetic by
 * hand on every phone message. All of that is structure — file contents and
 * clock math — so it is done here and handed over as one `[Hum state]` block.
 * What the message MEANS (is it an answer? a reaction? a new command?) stays
 * the agent's call (Rule #0b).
 *
 * Returns "" when nothing hum-related is open — the common case.
 */
export function humStateBlock(dir = humDataDir(), now = Date.now()) {
  const lines = [];
  const mins = (iso) => {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null;
  };
  const age = (m) => (m == null ? "?" : m < 90 ? `${m} min ago` : `${Math.round(m / 60)}h ago`);

  const q = readJSON(path.join(dir, "hum-pending-question.json"));
  if (q?.id) {
    if (unexpired(q, now)) {
      lines.push(`- Pending question \`${q.id}\` (asked ${age(mins(q.asked_at))}): "${String(q.question || q.subject || "").replace(/\s+/g, " ").slice(0, 200)}". If their message answers it → \`hum-answer ${q.id} "<answer>"\`; otherwise leave it.`); // lang-regex-ok: whitespace collapse of our own stored question for display
    } else if (String(q.memory_hook || "").startsWith("hum_improvement:")) {
      // A question about how hum itself behaves does not go stale like a "were you at X?" does,
      // and the user answers it at leisure (the answer need not be yes/no), so a late reply still counts.
      lines.push(`- Pending question \`${q.id}\` (asked ${age(mins(q.asked_at))}, about changing how hum behaves) is past its reply window, but that kind never goes stale: "${String(q.question || q.subject || "").replace(/\s+/g, " ").slice(0, 200)}". If their message answers it → \`hum-answer ${q.id} --late "<answer>"\`, then record the verdict as in Hum Inbound Handling Step 1; otherwise run \`hum-answer --clear\` and treat the message as fresh.`); // lang-regex-ok: whitespace collapse of our own stored question for display
    } else if (openQuestions(now, readLedger(dir)).some((oq) => oq.id === q.id)) {
      // Past the slot window but still OPEN in the ledger: it is listed below with
      // the other unanswered questions and stays answerable. Never clear it.
    } else {
      lines.push(`- Pending question \`${q.id}\` has EXPIRED → run \`hum-answer --clear\` and treat the message as fresh.`);
    }
  }

  // Every other question the user has not answered yet (open-questions ledger:
  // questions are repeated until answered). The user may answer any
  // of them at any time, often long after it was asked.
  const live = q?.id && unexpired(q, now) ? q.id : null;
  const open = openQuestions(now, readLedger(dir)).filter((oq) => oq.id !== live);
  if (open.length) {
    lines.push(`- Unanswered Edva questions (still open; Edva re-asks them until answered). If their message answers one → \`hum-answer <id> "<answer>"\` (no --late needed); if they say to drop one or it no longer applies → \`open-questions retire <id> --why "<their reason>"\`; otherwise leave them:`);
    for (const oq of open.slice(-6)) {
      lines.push(`  - \`${oq.id}\` (first asked ${age(mins(oq.first_asked_at))}, asked ${oq.asks}x): "${String(oq.question || oq.subject || "").replace(/\s+/g, " ").slice(0, 200)}"`); // lang-regex-ok: whitespace collapse of our own stored question for display
    }
  }

  // A decision card (hum `decisions` lane) sent in the last 48h and
  // not yet answered. A tap files itself; a typed answer that is not threaded
  // to the card needs the agent to file it (decision-answer --latest).
  const lane = readJSON(path.join(dir, "decision-lane-state.json"));
  const pendingDecision = (lane?.asked || [])
    .filter((a) => a?.ref && !a.answered_at && mins(a.at) != null && mins(a.at) <= 48 * 60)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (pendingDecision) {
    lines.push(`- Decision card \`${pendingDecision.ref}\` (asked ${age(mins(pendingDecision.at))}) is waiting for their answer. If their message answers it → \`decision-answer --ref ${pendingDecision.ref} --option "<the option's label, exactly>"\` or \`--text "<their answer>"\`; otherwise leave it.`);
  }

  // Newest ping (any lane) — the reaction-token windows of Step 2.
  let raw = "";
  try { raw = fs.readFileSync(path.join(dir, "hum-feedback.jsonl"), "utf8"); } catch { /* none */ }
  const rows = raw.split("\n");
  let last = null, openIdea = null;
  const openOffers = new Map(); // lane → newest un-reacted offer inside its window
  for (let i = rows.length - 1; i >= 0 && i > rows.length - 1 - FEEDBACK_TAIL_ROWS; i--) {
    const l = rows[i].trim();
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!r.ping_id || !r.sent_at) continue;
    if (!last) last = r;
    const m = mins(r.sent_at);
    if (m == null || m > 240) break;
    const dk = (r.findings || [])[0]?.dedup_key || "";
    if (!openIdea && !r.reaction && (r.lane === "ideas" || String(dk).startsWith("idea-"))) openIdea = r;
    const offer = OFFER_LANES[r.lane];
    if (offer && !openOffers.has(r.lane) && !r.reaction && m <= offer.windowMin) openOffers.set(r.lane, r);
  }
  if (last) {
    const m = mins(last.sent_at);
    if (m != null && m <= 360) {
      const reacted = last.reaction ? `, already reacted "${last.reaction}"` : "";
      const window = m <= 120
        ? `a bare reaction token (👍 👎 💤 helpful skip more snooze) files with \`edva hum feedback ${last.ping_id} <token>\``
        : `2–6h old: a bare reaction token is AMBIGUOUS — ask whether it was about this ping before recording`;
      lines.push(`- Last hum ping \`${last.ping_id}\` (${last.lane || "?"}) sent ${age(m)}${reacted}; ${window}.`);
    }
  }
  for (const [lane, offer] of Object.entries(OFFER_LANES)) {
    const r = openOffers.get(lane);
    if (r) lines.push(offer.line(r, age(mins(r.sent_at))));
  }
  if (openIdea) {
    lines.push(`- Open ideas ping \`${openIdea.ping_id}\` (sent ${age(mins(openIdea.sent_at))}, no reaction). If their message is a verbal reply to it → \`hum-ideas-resolve ${openIdea.ping_id} --resolution "<their words, ≤100 chars>" [--topic "<phrase>"]\` (does the sibling sweep, resolved-topics row and reservoir review; topic defaults to the idea subject).`);
  }

  const canary = readJSON(path.join(dir, "hum-canary-pending.json"));
  if (canary?.canary_id && unexpired(canary, now)) {
    const ids = (canary.candidates || []).map((c, i) => `${i + 1}=\`${c.id}\``).join(", ");
    lines.push(`- Canary \`${canary.canary_id}\` pending (${ids}; expires ${canary.expires_at}). If their message answers numbered lines, file what you read with \`hum-canary-answer <n>=<yes|no|skip> …\` (only the lines they answered).`);
  }

  return lines.length ? `[Hum state]\n${lines.join("\n")}\n` : "";
}

/**
 * The full hum block for the agent prompt: the threaded-parent routing line
 * (when threaded) plus — when the reply plausibly answers more than one open
 * item — the roster of open items and the attribution rule.
 *
 * The roster is deliberately NOT unconditional. Most inbound messages are fresh
 * commands, and listing four open pings on every one of them is prompt noise
 * that trains the agent to ignore the block. It appears when there is actual
 * evidence: the user threaded the reply (they are answering something), or the
 * message has several parts (line breaks, sentences) while 2+ items are open.
 */
export function humRoutingBlock({ replyTo, text } = {}, dir = humDataDir(), now = Date.now()) {
  const lines = [];
  if (replyTo) {
    const line = humRoutingLine(replyTo, dir, now);
    if (line) lines.push(line);
  }

  const open = openHumItems(dir, { now });
  let showRoster = false;
  if (open.length >= 2) {
    if (replyTo) showRoster = true;
    else {
      // Not threaded — surface the roster when the message is structurally
      // able to answer several items (2+ segments). WHICH items it answers is
      // the reading agent's call (Rule #0b) — this used to be a keyword match.
      showRoster = mayAnswerSeveral(text || "", open);
    }
  }

  if (showRoster) {
    lines.push(
      `[Hum open items] ${open.length} hum items are still open, and ONE reply can answer several of them ` +
      `— this is the catch-up case (they were driving and the messages stacked up). Attribute each part of their message to the ` +
      `item that part actually answers, and file each one with its own command below. Do NOT file the whole text ` +
      `against one item, do NOT blanket-file it against all of them, and do NOT treat answering one as closing ` +
      `the others — anything they didn't address stays open:`
    );
    for (const it of open) {
      const label = it.kind === "ping" ? `ping \`${it.id}\`${it.lane ? ` (${it.lane})` : ""}` :
                    it.kind === "question" ? `question \`${it.id}\`` :
                    it.kind === "approval" ? `approval "${it.id}"` : `canary \`${it.id}\``;
      const subject = (it.subject || "").replace(/\s+/g, " ").slice(0, 90);
      lines.push(`  - ${label} "${subject}" → ${it.route}`);
    }
  }

  return lines.length ? lines.join("\n") + "\n" : "";
}
