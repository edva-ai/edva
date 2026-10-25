// utterance-store.mjs — the user's own words, dated and permanently searchable.
//
// "On <date> <user> said: '<the reply, verbatim>'"
//
// The gap this closes. Every reply the user makes is captured to
// hum-responses.jsonl — but nothing could SEARCH it. `hum-wiki-recall` read
// only TODAY's rows; `outbound-precheck` read 8h of chat and 48h of
// resolved-topics; the nightly `hum-consolidate` folded the *durable* replies
// into the wiki as paraphrased facts and — by design — DISCARDED the transient
// ones ("already handled", "don't re-ask", "we did that"). Which is to say: the
// exact class of reply that matters most for not re-asking was the one class the
// pipeline was built to forget, and everything else survived only as someone
// else's paraphrase.
//
// This module makes the raw reply the memory. It is append-only, never
// expires, and is rendered as a dated first-person statement so both retrieval
// and an LLM reader see WHO said it and WHEN — the thing a wiki paraphrase
// loses. Consolidation still runs (a taste belongs on a taste page), but it is
// no longer the only path out of a reply.
//
// Sources, in order of directness:
//   hum-responses.jsonl      every reply to a ping, any lane   (verbatim)
//   hum-resolved-topics.jsonl chat-agent acknowledgments        (verbatim + topic)
//   hum-feedback.jsonl       only to name the ping a reply answered, when the
//                            reply row carries a placeholder instead
//
// Chat messages are NOT duplicated here — unified-recall already has a `chat`
// source over edva_messages. This is the ping-reply channel, which has no
// other home.
//
// Read-only.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const HOME = os.homedir();
const DATA = process.env.UTTERANCE_DATA_DIR || installTools("data"); // override: tests only
const RESPONSES = path.join(DATA, "hum-responses.jsonl");
const RESOLVED = path.join(DATA, "hum-resolved-topics.jsonl");
const FEEDBACK = path.join(DATA, "hum-feedback.jsonl");

function readJsonl(p) {
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

// The installation's time zone and the operator's name as rendered lines call
// them (lib/instance.cjs: tz, owner_name). Read once per process.
let _inst = null;
function inst() {
  if (!_inst) {
    const { instance } = createRequire(import.meta.url)("./instance.cjs");
    const i = instance();
    _inst = { tz: i.tz, speaker: i.owner_name.charAt(0).toUpperCase() + i.owner_name.slice(1) };
  }
  return _inst;
}

function localDate(iso) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: inst().tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
  } catch { return String(iso || "").slice(0, 10); }
}

// Every ideas-lane reply is stored with ping_text "(idea)" (its subject_display),
// so it reached the judges as "(in reply to: (idea))" with the idea itself
// missing. Read that way, an old reply about one item (say, a date for an
// errand) could be cited as the user's answer about a different, unrelated
// item.
// The ping's own headline is in hum-feedback.jsonl under the same ping_id; use
// it. Same placeholder test as suggestion-classify's shapePing.
function isPlaceholder(s) {
  const t = String(s || "").trim();
  return !t || (t.startsWith("(") && t.endsWith(")"));
}

// ping_id → the ping's headline (findings[0].signal).
function pingHeadlines(p) {
  const out = new Map();
  for (const e of readJsonl(p)) {
    const h = e?.findings?.[0]?.signal;
    if (e?.ping_id && !isPlaceholder(h) && !out.has(e.ping_id)) out.set(e.ping_id, String(h));
  }
  return out;
}

// One utterance: what the user said, when, and what it was in reply to.
//   { id, ts, date, text, subject, lane, disposition, source, rendered }
// `rendered` is the form every consumer should show a model — it carries the
// date and the attribution inline, so a retrieved snippet can't be mistaken for
// Edva's own note.
function toUtterance(r, idx, source, headlines = null) {
  const date = localDate(r.ts);
  const said = String(r.reply_text || r.resolution || "").trim();
  if (!said) return null;
  const subject = r.subject || r.topic || null;
  const askedAbout = r.ping_text || r.topic || null;
  // Only the rendered line names the resolved ping. Search keeps scoring the
  // stored text: put the headline in the haystack too and 29 of 383 hum ideas
  // newly cross claim-check's 0.34 Stage-2 bar, nearly all tapbacks ("thumbs_up")
  // matching on one shared headline word (measured 2026-10-09).
  const shownAbout = (isPlaceholder(r.ping_text) && headlines?.get(r.ping_id)) || askedAbout;
  return {
    id: `${source}:${r.ping_id || r.source_ping_id || idx}:${r.ts || idx}`,
    ts: r.ts || null,
    date,
    text: said,
    subject,
    lane: r.lane || null,
    disposition: r.disposition || null,
    asked_about: askedAbout ? String(askedAbout).slice(0, 200) : null,
    source,
    rendered: `${date} · ${inst().speaker} said: "${said.slice(0, 400)}"` +
      (shownAbout ? ` (in reply to: ${String(shownAbout).slice(0, 120)})` : ""),
  };
}

// All utterances, newest first. `sinceDays` bounds the window (null = all).
// `files` overrides the source paths — tests pass fixtures; production never
// sets it. A fixture set without `feedback` reads no headlines at all.
export function readUtterances({ sinceDays = null, limit = 500, files = null } = {}) {
  const responsesPath = files?.responses ?? RESPONSES;
  const resolvedPath = files?.resolved ?? RESOLVED;
  const headlines = pingHeadlines(files ? files.feedback : FEEDBACK);
  const rows = [
    ...readJsonl(responsesPath).map((r, i) => toUtterance(r, i, "hum_reply", headlines)),
    ...readJsonl(resolvedPath).map((r, i) => toUtterance(r, i, "chat_ack")),
  ].filter(Boolean);

  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : null;
  const filtered = cutoff
    ? rows.filter((u) => { const t = Date.parse(u.ts || ""); return Number.isFinite(t) && t >= cutoff; })
    : rows;

  filtered.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  return filtered.slice(0, limit);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "there", "then",
  "than", "they", "them", "your", "yours", "you", "have", "has", "had", "was",
  "were", "will", "would", "about", "just", "not", "but", "any", "all", "its",
  "already", "still", "what", "when", "where", "which", "who", "how", "why",
]);

function tokens(s) {
  return (String(s || "").toLowerCase().match(/\b[a-z0-9]{3,}\b/g) || [])
    .filter((w) => !STOPWORDS.has(w));
}

// Lexical + recency ranking over the corpus. Deliberately NOT embedding-based:
// the corpus is small (hundreds of rows) and this must work when Ollama is
// down, because it is the last line of defense against a re-ask. Semantic
// matching still happens — unified-recall fuses this source with the embedded
// chat + wiki sources, so a paraphrase is caught there.
export function searchUtterances(query, { k = 8, sinceDays = null, files = null } = {}) {
  const qt = new Set(tokens(query));
  if (!qt.size) return [];
  const rows = readUtterances({ sinceDays, limit: 1000, files });
  const now = Date.now();
  const scored = [];
  for (const u of rows) {
    const hay = new Set(tokens(`${u.text} ${u.subject || ""} ${u.asked_about || ""}`));
    let overlap = 0;
    for (const t of qt) if (hay.has(t)) overlap++;
    if (!overlap) continue;
    const ageDays = Math.max(0, (now - Date.parse(u.ts || 0)) / 86400000);
    // Coverage is normalized by the SMALLER of the two token sets, not by the
    // query. Dividing by query length made the score fall as the query grew,
    // which is backwards for the caller that matters: claim-check passes a
    // whole candidate ping (up to 400 chars), so the richest, most re-ask-prone
    // texts scored LOWEST and slipped under the escalation threshold. Measured:
    // the same settled reply scored 0.899 for a short three-word query
    // and 0.257 for the real 5-line ping — i.e. the memory half of the gate
    // was quietly not firing in production while passing every short-query
    // test. min() makes it symmetric: a short reply fully contained in a long
    // query still scores high, which is exactly the "the user already answered this"
    // case.
    const denom = Math.min(qt.size, hay.size) || 1;
    const score = overlap / denom + 0.15 * Math.exp(-ageDays / 90);
    scored.push({ ...u, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
