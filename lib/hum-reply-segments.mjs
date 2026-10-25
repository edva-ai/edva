// hum-reply-segments — split one reply into the parts that answer different
// hum items, and attribute each part to the item it actually answers.
//
// WHY. Threaded replies fixed "which message is the user
// answering" for the single-answer case. But the situation that produces
// stacked-up pings in the first place — the user was driving, four things landed —
// also produces the CATCH-UP reply: one message that answers several of them at
// once. "Loved the wine bar. Skip the museum thing. And yes to that show."
// Attributing that whole text to one ping is wrong twice over: the item that
// gets it may receive a disposition drawn from a sentence about something else,
// and the other items stay open and re-ask.
//
// ATTRIBUTION IS A MODEL'S JOB (Rule #0b). The segment → item match used to be
// keyword overlap: tokenise both sides, drop a
// stopword list, count shared words. That is arithmetic deciding what the user
// meant — "the dinner thing" vs two dinner pings, "europe" vs a URL slug, a
// paraphrase with no shared word at all — exactly the class Rule #0b forbids.
// It is now a typed pick-one decision: Jev first (one choice question per
// segment over the open items plus "none"), the local model as the fallback
// rung, and NO keyword fallback — if neither answers, nothing is attributed and
// callers keep their single-target behaviour. Code still owns the structure:
// where the reply splits (line breaks, bullets, sentence ends) and the canary
// reply protocol we ourselves asked for ("1 yes 2 no 3 skip").
//
// Bias throughout: FALSE NEGATIVES OVER FALSE POSITIVES. An unattributed
// segment costs a re-ask; a mis-attributed one writes a wrong preference into
// durable memory. So "none" is always an option, low confidence attributes
// nothing, and multi-mode only engages when two different items are picked.

import { decide, privacyOn } from "./jev-shadow.mjs";
import { answerConfidence } from "./jev.mjs";
import { localLlmChat } from "./local-llm.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";
// Who the assistant serves (agent/local/instance.json owner_name).
const OWNER = createRequire(import.meta.url)("./instance.cjs").instance().owner_name;

export const ATTRIBUTE_SITE = "hum-reply-attribute";

/**
 * Split a reply into candidate answer segments. Conservative by design: only
 * boundaries a person actually uses to separate distinct answers — line breaks,
 * bullets/numbers, semicolons, sentence ends — never " and ", which joins as
 * often as it separates ("the wine bar and the museum were both great").
 * This is punctuation/layout, not meaning; which item a segment is about is
 * decided by the model in attributeSegments().
 */
export function segmentReply(input) {
  const out = [];
  // lang-regex-ok: splits on line breaks only — layout, not meaning
  for (const line of String(input || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const piece of splitInline(trimmed)) {
      // lang-regex-ok: strips a leading bullet/number marker — layout, not meaning
      const cleaned = piece.trim().replace(/^(?:[-*•]|\(?\d+[).:]?)\s*/, "").trim();
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

function splitInline(line) {
  // The canary reply protocol ("1 yes 2 no 3 skip") is a format WE asked for
  // in the canary message itself, so recognising it is parsing our own
  // protocol. Only number-followed-by-a-protocol-verdict splits, so ordinary
  // numbers in prose ("3 tickets for 20 bucks") never do.
  // lang-regex-ok: the canary reply protocol defined by hum-canary-run
  const verdicts = [...line.matchAll(/\b\d+\s*[).:]?\s*(?:yes|no|skip|maybe)\b/gi)];
  if (verdicts.length >= 2) {
    const parts = [];
    for (let i = 0; i < verdicts.length; i++) {
      const start = verdicts[i].index;
      const end = i + 1 < verdicts.length ? verdicts[i + 1].index : line.length;
      parts.push(line.slice(start, end));
    }
    return parts;
  }
  // lang-regex-ok: sentence-end punctuation and semicolons — layout, not meaning
  return line.split(/\s*;\s*|(?<=[.!?])\s+/);
}

/**
 * Structural precondition for a multi-answer reply: at least two segments and
 * at least two open items. Cheap and synchronous — used where a model call per
 * inbound message would be too slow (the chat prompt's roster gate), and where
 * the reader of the roster is itself a model.
 */
export function mayAnswerSeveral(input, items) {
  return (items || []).length >= 2 && segmentReply(input).length >= 2;
}

// ---------------------------------------------------------------------------
// The model pick.
// ---------------------------------------------------------------------------

function jevQuestionsFor(segments, items) {
  const criteria = { none: "the segment does not answer any one of these items: it is a new request, small talk, or it could be about more than one of them" };
  items.forEach((it, i) => { criteria[`i${i}`] = String(it.matchText || it.subject || it.key).slice(0, 300); });
  const qs = {};
  segments.forEach((_, s) => {
    qs[`seg_${s}`] = {
      type: "choice",
      instructions: `${OWNER} sent one message that may answer several open items from their assistant. \`segments[${s}]\` is one part of it. Which ONE of the open items (\`open_items\`, ids i0, i1, …) is that part answering? Pick "none" unless the part clearly refers to exactly one item.`,
      criteria,
    };
  });
  return qs;
}

async function localPick(segments, items) {
  const list = items.map((it, i) => `i${i}: ${String(it.matchText || it.subject || it.key).slice(0, 160)}`).join("\n");
  const segs = segments.map((t, s) => `${s}: ${t}`).join("\n");
  let out;
  try {
    out = await localLlmChat({
      system: `You match parts of a message to the open item each part answers. Open items:\n${list}\nFor each numbered part, answer the item id it clearly answers, or "none" if it is about none of them or could be about more than one. Respond with JSON only: {"picks": ["i0"|"none", ...]} in part order.`,
      user: `Parts:\n${segs}\nJSON:`,
      maxTokens: 120, temperature: 0, timeoutMs: 5000, think: false,
    });
  } catch { return null; }
  const raw = String(out?.content || "");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let parsed; try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
  if (!Array.isArray(parsed.picks) || parsed.picks.length !== segments.length) return null;
  return parsed.picks.map((p) => (typeof p === "string" && /^i\d+$/.test(p) && Number(p.slice(1)) < items.length ? p : null)); // lang-regex-ok: validates our own id format in model JSON
}

// Health/exercise items are about the user's body — no external model sees them
// while the privacy guard is on (same rule as suggestion-classify).
const PRIVATE_LANES = new Set(["health", "exercise"]);

/**
 * Default picker: Jev (typed choice per segment) → local model → nothing.
 * Returns an array (segment order) of item indices or null.
 *   jev: false   — skip Jev entirely (dry runs: no external call, no shadow log)
 *   id           — decision id for the Jev shadow log
 * HUM_ATTRIBUTION_FIXTURE (tests only) names a JSON file of {"<segment text>": "<item key>"|null}.
 */
export async function modelPick(segments, items, { id = null, jev = true } = {}) {
  if (process.env.HUM_ATTRIBUTION_FIXTURE) {
    const map = JSON.parse(fs.readFileSync(process.env.HUM_ATTRIBUTION_FIXTURE, "utf8"));
    return segments.map((t) => { const k = map[t]; const i = items.findIndex((it) => it.key === k); return i >= 0 ? i : null; });
  }
  const toIdx = (arr) => (arr ? arr.map((p) => (p ? Number(p.slice(1)) : null)) : segments.map(() => null));
  if (!jev) return toIdx(await localPick(segments, items));
  // Memoized so the shadow run and the fallback share ONE local-model call.
  let memo = null;
  const legacy = () => (memo ||= localPick(segments, items));
  const { value } = await decide({
    skipJev: privacyOn() && items.some((it) => PRIVATE_LANES.has(it.lane)) ? "health-excluded" : undefined,
    site: ATTRIBUTE_SITE,
    id,
    privacyScreen: true,
    state: { open_items: items.map((it, i) => ({ id: `i${i}`, subject: String(it.matchText || it.subject || it.key).slice(0, 300) })), segments },
    questions: jevQuestionsFor(segments, items),
    interpret: (answers) => {
      let conf = 1;
      const picks = segments.map((_, s) => {
        const a = answers[`seg_${s}`];
        conf = Math.min(conf, answerConfidence(a));
        const c = a?.choice;
        return c && c !== "none" ? c : null;
      });
      return { value: picks, confidence: conf };
    },
    legacy,
    // Shadow comparison must not count "the local model gave no answer" as a
    // legacy verdict (same rule as suggestion-classify). localPick returns null
    // on ANY failure — Ollama unreachable, timeout, unparseable or wrong-length
    // JSON — and null is "no answer", not "none of these". Compared as a
    // verdict it can never equal Jev's per-segment array, so every Jev answer
    // paged the system channel as a disagreement over identical outcomes (both
    // attribute nothing). A Jev disagreement: "is <title> on our/my watch
    // list?" — Jev "none" @0.91, legacy null.
    //
    // Measured the same day: localPick currently returns null on EVERY call.
    // localLlmChat returns a string, and localPick reads `out?.content`, so the
    // rung has never produced an answer since it shipped. Do not
    // revive it by fixing that read alone: on the one replay, gemma3:1b
    // attributed that watchlist question to an unrelated open item —
    // exactly the mis-attribution the bias at the top of this file exists to
    // prevent, and below Jev's bar the legacy pick is the one ACTED on.
    shadow: () => legacy().then((p) => {
      if (p == null) throw new Error("local model gave no answer");
      return p;
    }),
    same: (x, y) => JSON.stringify(x) === JSON.stringify(y),
  });
  return toIdx(value);
}

/**
 * Attribute each segment to the hum item it answers.
 *
 * @param segments string[] from segmentReply
 * @param items    [{ key, subject, matchText? }]
 * @param opts     { pick?, id?, jev? } — `pick` (tests inject a stub) gets (segments, items, {id, jev})
 * @returns [{ text, item|null }] in segment order
 */
export async function attributeSegments(segments, items, { pick = modelPick, id, jev } = {}) {
  if (!segments.length || !(items || []).length) return segments.map((text) => ({ text, item: null }));
  let idx = null;
  try { idx = await pick(segments, items, { id, jev }); } catch { idx = null; }
  return segments.map((text, s) => {
    const i = idx ? idx[s] : null;
    return { text, item: Number.isInteger(i) && items[i] ? items[i] : null };
  });
}

/**
 * The distinct items this reply demonstrably addresses. Two or more means the
 * caller must attribute per-segment instead of filing the whole text once.
 */
export function distinctTargets(attributions) {
  const seen = new Map();
  for (const a of attributions) {
    if (!a.item) continue;
    const key = a.item.key;
    if (!seen.has(key)) seen.set(key, { item: a.item, segments: [] });
    seen.get(key).segments.push(a.text);
  }
  return [...seen.values()];
}

/**
 * Does this reply answer several open hum items, and if so which text belongs
 * to which? Resolves null when it doesn't (the overwhelming majority of
 * messages), so callers can keep their single-target path. No model call is
 * made unless the reply is structurally able to (2+ segments, 2+ items).
 */
export async function splitMultiAnswer(input, items, opts = {}) {
  if (!mayAnswerSeveral(input, items)) return null;
  const targets = distinctTargets(await attributeSegments(segmentReply(input), items, opts));
  return targets.length >= 2 ? targets : null;
}

/**
 * The one open item this reply is about, when it names exactly one and no
 * other. Resolves null if it names none (a bare "yes" — nothing to go on) or
 * more than one (that's `splitMultiAnswer`'s job).
 */
export async function soleTarget(input, items, opts = {}) {
  const segments = segmentReply(input);
  if (!segments.length || !(items || []).length) return null;
  const targets = distinctTargets(await attributeSegments(segments, items, opts));
  return targets.length === 1 ? targets[0].item : null;
}
