// auto-recall.mjs — proactively fetch relevant memory for an inbound chat
// message and format it as a compact <recall> block to prepend to the turn.
//
// The read-side counterpart to the write-side consolidators. Unified `recall`
// exists, but it only helps when the agent THINKS to call it — the exact gap
// being: the user asks "what did I say about X" and the agent answers from the
// live transcript without checking memory. Auto-recall closes that by running
// recall() on the incoming message BEFORE the agent sees it and prepending the
// hits, so relevant memory (the user's own notes + recent chat) is already in context.
//
// Wired at the phone-channel (chat inbound), on the CLEAN user message — not at
// the dispatcher/send layer, where the content is already an assembled blob and
// the query would be noisy. Chat-only: ops dispatches are structured job
// playbooks that do their own targeted recall.
//
// Hard requirements (this runs on the chat inbound hot path):
//   - FAIL-SOFT: any error/timeout → "" (empty block); never block or throw a
//     dispatch. A missing recall block just means the agent recalls on demand
//     as it does today.
//   - BOUNDED: a tight timeout caps the added latency. The Gemma ack has already
//     shown the user an indicator, so a sub-second delay before the real answer
//     is invisible; we never wait on a slow embed/RPC.
//   - GATED: trivial messages (acks, single-token reactions, bare affirmations,
//     slash-commands) skip recall — no value, and it keeps hum-reply / command
//     traffic from triggering a pointless retrieval.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { recall } from "./unified-recall.mjs";
import { decide } from "./jev-shadow.mjs";
import { runToolless } from "./jev-claude.mjs";
import { jevSiteDef } from "./jev.mjs";
import { mixedQuantities } from "./money-quantity.mjs";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
// The operator's name as the prompts call them (agent/local/instance.json
// owner_name; "the user" by default), capitalised where it opens a sentence.
const { instanceValue } = createRequire(import.meta.url)("./instance.cjs");
const ownerName = () => instanceValue("owner_name");
const OwnerName = () => { const n = ownerName(); return n.charAt(0).toUpperCase() + n.slice(1); };

const MIN_LEN = 15;
// Bare affirmations / acks / commands that carry no recallable subject.
const TRIVIAL_RE =
  /^(y|yes|no|nope|ok|okay|sure|yep|yup|k|kk|ty|thanks|thank you|done|got it|do it|go ahead|continue|stop|cancel|nvm|never ?mind|👍|👎|💤|🙏|❤️|🔥)\b/i;

// Decide whether a message is worth an auto-recall. Permissive by design —
// recall is fail-soft + additive, so the only reason to skip is to avoid
// latency/noise on clearly-trivial traffic.
export function shouldAutoRecall(text) {
  const t = String(text || "").trim();
  if (t.length < MIN_LEN) return false;
  if (t.startsWith("/")) return false; // slash-command directive
  // Emoji-only / reaction.
  if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(t)) return false;
  // A bare affirmation/ack (short) — but "do it for the conference trip"
  // (longer, has a subject) still recalls.
  if (TRIVIAL_RE.test(t) && t.length < 30) return false;
  return true;
}

// The money-quantity tag (lib/money-quantity.mjs), shown so neither the
// judge nor the chat agent has to guess whether a figure is net worth, holdings
// or contract terms. Empty for untagged rows.
function qtag(r) {
  return r.quantity && r.quantity.length ? ` · quantity: ${r.quantity.join("+")}` : "";
}

function fmtRow(r) {
  if (r.source === "wiki") {
    const label = r.title ? `${r.title} — ` : "";
    return `- [wiki ${r.id}${qtag(r)}] ${label}${clip(r.snippet, 160)}`;
  }
  if (r.source === "chat") {
    return `- [chat ${(r.created_at || "").slice(0, 10)}] ${clip(r.snippet, 160)}`;
  }
  return `- [${r.source}${qtag(r)}] ${clip(r.snippet, 160)}`;
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}

// ─── Relevance gating ─────────────────────────────────────────────────────
//
// `recall` returns its top-k by rank with NO relevance floor, so it answers for
// any query at all. Un-gated, that made auto-recall prepend loosely-related
// memory to every single chat message — measured on the live corpus, a query
// about quantum chromodynamics pulled eight chat rows about favourite restaurants.
//
// TWO MECHANISMS, in priority order:
//   1. A Sonnet judge that READS the candidates — the primary path. See
//      "Model-judged relevance" below.
//   2. The lexical/BM25 gate in `relevantRows` — the fallback, used only when
//      the judge is unreachable. Verified numbers for it are in that section.
//
// Both are capped at JUDGE_MAX_KEEP, because screening out the absurd is not
// the same as selecting the useful.

// CORPUS-SIZE DEPENDENT — this number is empirical, not universal. BM25's IDF
// term scales with log(N/df), so the same query scores very differently against
// a big corpus and a small one: about -15 against a wiki of several hundred
// pages, and -0.00
// against a 1-page test fixture (with N=1 every term has zero IDF and all
// scores collapse). Recalibrate if the corpus changes size materially, and pass
// `minBm25` explicitly rather than relying on the default when the corpus is
// not the production wiki.
export const MAX_BM25 = -12;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "these", "those",
  "there", "then", "than", "they", "them", "their", "your", "yours", "you",
  "have", "has", "had", "was", "were", "will", "would", "about", "just", "not",
  "but", "any", "all", "its", "already", "what", "when", "where", "which",
  "who", "how", "why", "some", "more", "most", "here", "very", "much", "also",
  "been", "being", "does", "did", "done", "get", "got", "make", "made", "want",
  "need", "know", "think", "going", "doing", "like", "over", "back", "still",
  // Generic nouns/quantifiers. These are >=4 chars and survive the length
  // filter, but sharing one carries no evidence that two texts are about the
  // same subject — "that thing you wanted" and "about your thing" would
  // otherwise qualify each other. Kept deliberately short: over-listing here
  // costs real recall.
  "thing", "things", "stuff", "time", "times", "something", "anything",
]);

function distinctive(s) {
  return new Set(
    (String(s || "").toLowerCase().match(/\b[a-z0-9]{4,}\b/g) || [])
      .filter((w) => !STOPWORDS.has(w)),
  );
}

// ─── Model-judged relevance (primary) ─────────────────────────────────────
//
// A model that READS the candidates is the right instrument for "is this memory
// about this message", and the two cheaper signals both failed empirically:
//
//   cosine        IS semantic understanding and it INVERTED — a nonsense query's
//                 best chat hit scored 0.516 while a real question about a
//                 booked appointment scored 0.484. Page/message-level embeddings are
//                 too coarse to answer "about", so no threshold on them works.
//   gemma3:1b     rubber-stamps. Measured on this exact task it kept 7/12 and
//                 11/12 candidates for two deliberately irrelevant queries
//                 (quantum chromodynamics retaining notes about favourite
//                 restaurants). Fast (~750ms) and useless.
//
// So: Sonnet `--effort low`, one call per message, candidates numbered, indices
// back. Cost and latency are real and accepted (by the user's explicit
// choice) — this is one forked call per
// substantive inbound message, and it is why MIN_LEN/TRIVIAL_RE gating upstream
// matters.
//
// ASYNC SPAWN, NOT spawnSync. auto-recall is imported by
// agent/phone-channel/index.mjs, a long-lived service with a Realtime
// subscription and an ack-refresh interval. A multi-second spawnSync there would
// block its event loop and stall the whole channel. outbound-precheck.mjs may
// use spawnSync only because it is a short-lived CLI.
// AUTO_RECALL_CLAUDE_BIN is a test seam (tests/jev-auto-recall.test.mjs).
const CLAUDE_BIN = process.env.AUTO_RECALL_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");

// Hard cap on what the judge may keep, and it is load-bearing. Asked merely to
// FILTER ("which notes would help answer this?"), Sonnet rubber-stamped: it
// returned 12/12 for "what did we decide about the <city> lodging in <month>",
// keeping an unrelated city page, a years-old trip to that city and an unrelated
// one-line reply about the weather — because with a travel query and twelve travel-adjacent
// candidates, anything plausibly "could help". Asking it to SELECT a small
// ranked set instead turns a permissive judgment into a competitive one. The cap
// is also a backstop: even a maximally permissive answer can only cost this many
// rows.
const JUDGE_MAX_KEEP = 4;

// How many candidates the judge is shown. Bounds the prompt; the retrieval pool
// is wider so ranking still has room to work.
const JUDGE_INPUT_MAX = 12;

// Which path actually ran, on stderr so it lands in the phone-channel log.
//
// This exists because the model path CANNOT be verified from outside the
// authenticated session: `claude -p` resolves Max credentials from the login
// keychain, so a fork from an SSH shell returns "Not logged in" and judgeRows
// silently falls back. Any measurement taken that way is measuring the lexical
// gate while looking exactly like a measurement of the model — which is how the
// first version of this filter was "verified". `judged=false` in production
// (where phone-channel descends from the launchd `ai.claude.session` tree and
// SHOULD authenticate) means the fork is genuinely failing and wants attention.
function logPath(judged, kept, considered) {
  try {
    console.error(`[auto-recall] judged=${judged} kept=${kept}/${considered}`);
  } catch {}
}

// ─── Judge shadow log (labelled data for a cheaper gate) ──────────────────
//
// Every judged message is a free labelled example: these candidates, with these
// retrieval features, and a Sonnet verdict on which were worth citing. Nothing
// captured that today — `logPath` writes two counters to stderr — so the two
// previous attempts at a cheap gate (cosine thresholds, gemma3:1b) were each
// evaluated on a handful of hand-picked queries, which is exactly how you end
// up with a threshold that INVERTS on the live corpus.
//
// So: record the features and the verdict, append-only, and let the calibration
// set accumulate while the judge keeps doing its job. Replacing the judge is a
// separate decision that this data is the precondition for, not a consequence.
//
// ONLY logged when the model actually answered. A lexical-fallback run carries
// no label — writing those rows would train the replacement on the thing it is
// meant to replace.
//
// Contains the user's message text and memory snippets, so it is gitignored and
// stays local, like hum-runs.jsonl and outbound-precheck-log.jsonl.
const JUDGE_LOG =
  process.env.AUTO_RECALL_JUDGE_LOG ||
  installTools("data/auto-recall-judge.jsonl");

function logJudgeDecision(message, candidates, picked, ms) {
  if (process.env.AUTO_RECALL_JUDGE_LOG_DISABLED === "1") return;
  try {
    const keptIdx = new Set();
    const pos = new Map(candidates.map((r, i) => [r, i]));
    for (const p of picked) {
      const i = pos.get(p);
      if (i !== undefined) keptIdx.add(i);
    }
    const row = {
      ts: new Date().toISOString(),
      message: String(message || "").slice(0, 600),
      n_considered: candidates.length,
      n_kept: keptIdx.size,
      kept: [...keptIdx].sort((a, b) => a - b),
      candidates: candidates.map((r, i) => ({
        i,
        source: r.source,
        id: r.id ?? null,
        type: r.type ?? null,
        quantity: r.quantity ?? null,
        // The three retrieval signals a cheap gate would have to work from.
        score: typeof r.score === "number" ? r.score : null,
        cosine: typeof r.cosine === "number" ? r.cosine : null,
        rrf: typeof r.rrf === "number" ? r.rrf : null,
        snippet: String(r.snippet || "").replace(/\s+/g, " ").slice(0, 220),
      })),
      judge_ms: ms,
    };
    // Fire-and-forget: this runs on the chat inbound hot path and a logging
    // failure must never cost a reply.
    fs.appendFile(JUDGE_LOG, JSON.stringify(row) + "\n", () => {});
  } catch {}
}

function judgePrompt(message, rows) {
  const list = rows
    .map((r, i) => {
      const tag = (r.source === "wiki" ? `wiki ${r.id}` : r.source) + qtag(r);
      return `${i}. [${tag}] ${String(r.snippet || "").replace(/\s+/g, " ").slice(0, 220)}`;
    })
    .join("\n");
  return `${OwnerName()} just sent this message to their assistant:

"${String(message).slice(0, 600)}"

Below are candidate notes retrieved from their memory by similarity search. Similarity search returns its top matches whether or not any of them is actually related, so most of these are probably noise.

${list}

Pick the FEW notes you would actually cite when answering that message — at most ${JUDGE_MAX_KEEP}, best first. Fewer is better; most messages deserve 0 to 2.

A note qualifies only if it is about the same specific subject, person, place, or decision. Belonging to the same broad area is NOT enough — do not keep a note just because both it and the message concern travel, or food, or ${ownerName()}'s life. If you would not quote it, leave it out.

MONEY QUESTIONS. Some notes carry a "quantity:" tag naming the kind of money they state — net_worth (everything owned), brokerage_holdings (the stock portfolio's market value), private_holdings, cash_balances, property_value, liabilities, equity_terms (ownership % / vesting in a contract, not a dollar holding), income, spending, portfolio_targets (target weights, not value), plan_projection (dated plans), finance_context (no figure). If the message asks for a money figure, first decide which ONE quantity it asks for, then keep only notes tagged with that quantity (or untagged notes plainly about it). A note tagged with a different quantity answers a different question — leave it out even if it shares words like "portfolio", "worth" or "stock".

Reply with ONLY a JSON array of the numbers to keep, best first, e.g. [4,0]. Reply [] if none qualify. No prose.`;
}

// Ask the model which rows to keep. Returns the filtered array, or null when the
// model is unavailable/unparseable so the caller can fall back.
// A long-lived caller (phone-channel) can hand in a WarmClaude (lib/
// warm-claude.mjs) so the judge pays API latency instead of `claude -p` startup
// on every message — ~2.7s per judgment on the production host, most of it CLI boot
// (2026-10-04). Same model, flags and prompt; the test seam
// AUTO_RECALL_CLAUDE_BIN always takes the per-call fork.
let warmJudge = null;
export function useWarmJudge(warm) { warmJudge = warm || null; }

async function judgeRows(rows, message, timeoutMs) {
  if (!rows.length) return [];
  const prompt = judgePrompt(message, rows);
  // Tool-less, Max-only, off the edva tree's settings (lib/jev-claude.mjs)
  // — this judge is also Jev's shadow for the week, on every chat message.
  const stdout = warmJudge && !process.env.AUTO_RECALL_CLAUDE_BIN
    ? await warmJudge.run(prompt, { timeoutMs })
    : await runToolless({ bin: CLAUDE_BIN, model: "claude-sonnet-5-5", prompt, timeoutMs });
  if (!stdout) return null;
  const m = String(stdout).match(/\[[^\]]*\]/);
  if (!m) return null;
  let idx;
  try { idx = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(idx)) return null;
  // Preserve the model's own ordering (best first) and enforce the cap here —
  // the prompt asks for it, but a filter must not depend on the model obeying.
  const seen = new Set();
  const picked = [];
  for (const n of idx) {
    if (!Number.isInteger(n) || n < 0 || n >= rows.length || seen.has(n)) continue;
    seen.add(n);
    picked.push(rows[n]);
    if (picked.length >= JUDGE_MAX_KEEP) break;
  }
  return picked;
}

// ─── Jev as the primary judge ─────────────────────────────────────────────
//
// Jev runs as primary with the current mechanism as shadow for one week
// (docs/jev.md). Jev (a decision model,
// no text output) answers ONE boolean per candidate — "would you cite this
// note?" — all in parallel against one state, in well under a second. The
// Sonnet judge above becomes the shadow during the shadow week and the fallback
// forever: whenever Jev errors, or is not confident in the set it produced
// (see interpretRecallAnswers for what "confident" means here), Sonnet decides.
//
// Kept/dropped are compared as index SETS after the JUDGE_MAX_KEEP cap: the
// block is what matters, not the order within it.
//
// PRIVATE CONTENT NEVER REACHES JEV. Jev is an external model; health and bank
// data are edva-model-only. The inbound message and the candidate snippets
// are screened on-device first (decide's privacyScreen → jev-private-screen.mjs,
// fail-closed) and a flagged set goes to the Sonnet judge, logged as sensitive-excluded.
//
// awaitShadow:false — phone-channel is long-lived, so when Jev answers the
// reply does not wait for the Sonnet shadow; the comparison lands in the log
// when Sonnet finishes.
const JEV_SITE = "auto-recall";

function msgId(message) {
  return createHash("sha1").update(String(message || "")).digest("hex").slice(0, 12);
}

export function jevRecallQuestions(rows) {
  const def = jevSiteDef(JEV_SITE);
  const tmpl = def && def.candidate_question;
  if (!tmpl) throw new Error("jev: auto-recall.json has no candidate_question");
  const q = {};
  rows.forEach((_, i) => {
    q[`c${i}`] = {
      ...tmpl,
      instructions: String(tmpl.instructions).replace(/\{\{n\}\}/g, String(i)),
    };
  });
  return q;
}

// Jev answers → { value: kept indexes best-first (capped), confidence }.
//
// CONFIDENCE IS ABOUT THE SET WE SHIP, NOT THE WORST SUB-ANSWER (2026-09-24).
// It used to be min over all N candidates of max(p, 1-p) — "the weakest thing
// we kept, or the closest thing we dropped". That is a principled measure and
// it was the wrong one HERE: a 12-candidate similarity list reliably contains
// something sitting on the fence, so the min lands near 0.5 on essentially
// every message that has anything worth keeping. Over the shadow window Jev
// was used on 3 of 3 messages where it kept NOTHING (confidence 0.77 / 0.82 /
// 0.81) and 0 of 3 where it kept something (0.52 / 0.59 / 0.53) — a
// negative-only filter, unable to be primary in exactly the case the feature
// exists for, while agreeing with or beating the Sonnet judge on all three.
//
// So measure the two things that actually carry risk on this site:
//   kept something → how strong is the ANCHOR. A block whose best note the
//                    judge is not convinced by is not worth prepending; the
//                    marginal extras under it cost one line each in a list
//                    already capped at JUDGE_MAX_KEEP and sorted best-first,
//                    on a path that is additive and fail-soft by design.
//   kept nothing   → how close was the NEAREST MISS. That is the failure mode
//                    auto-recall exists to prevent, so this arm is UNCHANGED:
//                    1 - max(p) is exactly what the old min reduced to when
//                    every candidate fell below the line.
export function interpretRecallAnswers(answers, n) {
  const scored = [];
  let maxAll = 0;
  for (let i = 0; i < n; i++) {
    const a = answers[`c${i}`];
    const p = a ? (a.type === "noul" ? a.noul : a.probability) : null;
    if (typeof p !== "number") return { value: [], confidence: 0 };
    if (p > maxAll) maxAll = p;
    if (p >= 0.5) scored.push([i, p]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return {
    value: scored.slice(0, JUDGE_MAX_KEEP).map(([i]) => i),
    confidence: scored.length ? scored[0][1] : 1 - maxAll,
  };
}

export const sameIndexSet = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

// Returns the kept rows, or null when neither Jev nor Sonnet could answer (the
// caller then uses the lexical gate).
async function judgeRowsPrimary(rows, message, timeoutMs, jevTimeoutMs) {
  if (!rows.length) return [];
  let memo = null;
  const legacy = () => (memo ||= judgeRows(rows, message, timeoutMs).then((r) => {
    if (r === null) throw new Error("sonnet judge unavailable");
    return r.map((x) => rows.indexOf(x));
  }));
  const state = {
    message: String(message).slice(0, 600),
    candidates: rows.map((r, i) => ({
      n: i,
      source: r.source === "wiki" ? `wiki ${r.id}` : r.source,
      ...(r.title ? { title: r.title } : {}),
      text: String(r.snippet || "").replace(/\s+/g, " ").slice(0, 220),
    })),
  };
  try {
    const r = await decide({
      site: JEV_SITE,
      id: msgId(message),
      state,
      questions: jevRecallQuestions(rows),
      interpret: (answers) => interpretRecallAnswers(answers, rows.length),
      legacy,
      same: sameIndexSet,
      logInput: state,
      awaitShadow: false,
      jevTimeoutMs,
      // On-device health/bank screen over exactly this state; runs only when Jev
      // would (so it adds no latency while Jev is inert).
      privacyScreen: true,
    });
    return r.value.map((i) => rows[i]).filter(Boolean);
  } catch {
    return null;
  }
}

// ─── Lexical relevance (deterministic fallback) ───────────────────────────
//
// Used only when the model is unreachable or returns garbage. Strictly worse
// than the model — it cannot see a paraphrase that shares no vocabulary — but
// far better than the two alternatives on a model outage: passing everything
// (noise in every message) or passing nothing (feature silently dead).
//
// Keep a row only if its own half's evidence clears the bar.
export function relevantRows(rows, queryText, { minBm25 = MAX_BM25 } = {}) {
  const qt = distinctive(queryText);
  const kept = [];
  for (const r of rows || []) {
    if (r.source === "wiki") {
      if (typeof r.score === "number" && r.score <= minBm25) kept.push(r);
      continue;
    }
    if (r.source === "chat") {
      // Drop the message recalling ITSELF. Auto-recall runs on text that may
      // already be persisted, so the top hit is frequently the query verbatim
      // at similarity 1.0 — never useful, and confusing to read as "memory".
      if (typeof r.score === "number" && r.score >= 0.995) continue;
      const ht = distinctive(r.snippet);
      let overlap = 0;
      for (const t of qt) if (ht.has(t)) overlap++;
      if (overlap > 0) kept.push(r);
      continue;
    }
    kept.push(r); // other sources keep their own contracts
  }
  return kept;
}

// Build the <recall> block for a message, or "" when there's nothing to add
// (gated out, no relevant hits, timed out, or recall errored). Never throws.
// `timeoutMs` bounds the retrieval; `judgeTimeoutMs` bounds the Sonnet judge
// and `jevTimeoutMs` the Jev call in front of it. `judge: false` skips the model
// entirely (tests, and any caller that cannot afford the latency).
//
// JUDGE BUDGETS ARE SIZED TO THE MEASURED DISTRIBUTION (2026-10-04). This runs
// before the chat agent sees the message, so every second here is a second of
// "On it…". The judge measured p50 2.8s / p90 3.6s / max 12s over 60 messages;
// the old 20s Sonnet budget (behind Jev's 8s default) only ever bought the tail
// and let one slow fork hold a reply for up to ~28s. Past the budget the
// lexical gate decides — strictly worse, but a block, and on time.
export async function autoRecallBlock(
  text,
  { k = 6, timeoutMs = 1200, minBm25 = MAX_BM25, judge = true, judgeTimeoutMs = 4000, jevTimeoutMs = 2500 } = {},
) {
  if (process.env.CHAT_AUTORECALL_DISABLED === "1") return "";
  if (!shouldAutoRecall(text)) return "";
  let out;
  try {
    out = await Promise.race([
      // Pull wider than k so gating selects rather than merely truncating, and
      // ask the wiki half for OR semantics so BM25 is meaningful.
      //
      // The inner budgets are sized to NEST inside `timeoutMs`: embed then
      // sources is the serial worst case, so they must sum to less than it.
      // Otherwise the outer race fires first and auto-recall degrades to no
      // block at all — whereas a per-source deadline degrades to a block built
      // from the sources that did answer, which on this hot path is every
      // source except the Supabase round trip.
      recall(text, {
        k: k * 3,
        chat: true,
        wiki: true,
        events: false,
        wikiMatch: "or",
        embedTimeoutMs: Math.max(200, Math.floor(timeoutMs * 0.4)),
        sourceTimeoutMs: Math.max(200, Math.floor(timeoutMs * 0.4)),
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return "";
  }
  const candidates = out?.results || [];
  if (!candidates.length) return "";

  // Model first; deterministic gate only if it couldn't answer.
  let rows = null;
  if (judge && process.env.CHAT_AUTORECALL_NO_JUDGE !== "1") {
    const shown = candidates.slice(0, JUDGE_INPUT_MAX);
    const t0 = Date.now();
    rows = await judgeRowsPrimary(shown, text, judgeTimeoutMs, jevTimeoutMs);
    // Only a real verdict is a label — a null here means the fork failed.
    if (rows !== null) logJudgeDecision(text, shown, rows, Date.now() - t0);
  }
  const judged = rows !== null;
  if (!judged) {
    // Same cap as the judge. Measured on the live corpus the lexical gate keeps
    // 11-12 of 12 rows for an on-topic query — it screens out the absurd but
    // does not select, so without a cap a model outage would quietly restore
    // the always-noisy block this whole change exists to remove.
    rows = relevantRows(candidates, text, { minBm25 }).slice(0, JUDGE_MAX_KEEP);
  }
  if (!rows.length) {
    logPath(judged, 0, Math.min(candidates.length, JUDGE_INPUT_MAX));
    return "";
  }
  logPath(judged, rows.length, Math.min(candidates.length, JUDGE_INPUT_MAX));
  const lines = rows.slice(0, k).map(fmtRow);
  // Structural check on the TAGS (never the text): a kept set whose tagged
  // notes share no money quantity cannot be summed or blended into one figure.
  const mixed = mixedQuantities(rows.slice(0, k));
  const mixNote = mixed
    ? `\nWARNING: these notes state DIFFERENT kinds of money (${mixed.join(", ")}). They answer different questions — never combine or average their figures; answer from the one quantity asked, or ask which they mean.`
    : "";
  return (
    "<recall>\n" +
    `Relevant memory auto-retrieved for this message (${ownerName()}'s own notes + recent chat; ` +
    "verify specifics before acting, and still search memory yourself if this looks incomplete):\n" +
    lines.join("\n") +
    mixNote +
    "\n</recall>\n\n"
  );
}
