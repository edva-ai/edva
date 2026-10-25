// jev-gates.mjs — Jev as primary for Edva's three outbound GATES
// (outbound-precheck, claim-check stage 2, claim-freshness stage 3), with the
// existing Sonnet adjudicator as shadow + fallback. See docs/jev.md.
//
// The user asked for these gates to be wired too — after being told they would
// send outbound drafts, claims and the memory evidence behind them to Jev, a
// third-party API, with no zero-data-retention flag.
//
// What all three gates share, and so what lives here:
//   - A single verdict CLASS decides the outcome (send/suppress/modify,
//     pass/rewrite/drop). Jev answers one `verdict` choice question over it.
//   - Jev cannot write text. A class that needs generated text (modify /
//     rewrite) is never acted on by Jev alone: the memoized Sonnet result — the
//     same call the shadow already made — supplies the text, and its verdict.
//   - These gates are SAFETY gates, so the costly error is a false "let it
//     through". During the shadow week the Sonnet shadow has already finished by
//     the time decide() returns; if IT chose a conservative class (suppress /
//     drop) where Jev chose to let the message through, the conservative Sonnet
//     verdict wins (same rule as memory-write-precheck's conflict-wins). decide()
//     has already logged and paged the disagreement.
//   - Health and financial content never reaches Jev: intent-keyed exclusion
//     (privateIntent) plus decide()'s fail-closed on-device content screen over
//     exactly the state that would be sent.

import { decide, privacyOn } from "./jev-shadow.mjs";
import { createRequire } from "node:module";
import { answerConfidence } from "./jev.mjs";

// Intents that carry edva-model-only data (agent/CLAUDE.md § Financial
// Operations rule 5, § Health Data). Mirrors edva-send-curl's implied
// --skip-precheck list, plus hum:health and hum:exercise — health pings DO pass
// through the (Max-session Sonnet) precheck by design, but never through Jev.
// Keyed on the intent label, never on message text (Rule #0b).
// An installation names its own financial-account intents in
// agent/local/config/send-intents.json (jev_private_intent_prefixes,
// the full list; the same file feeds edva-send-curl's lists).
const PRIVATE_INTENT_PREFIXES = createRequire(import.meta.url)("./instance.cjs").localConfig("send-intents", {
  jev_private_intent_prefixes: [
    "bank", "health", "finance",
    "hum:finance", "hum:stocks", "hum:health", "hum:exercise",
  ],
}).jev_private_intent_prefixes;
const PRIVATE_LANES = new Set(["finance", "stocks", "health", "exercise"]);

export function privateIntent(intent, lane) {
  if (!privacyOn()) return null;
  const i = String(intent || "").toLowerCase();
  for (const p of PRIVATE_INTENT_PREFIXES) {
    if (i === p || i.startsWith(p + ":") || i.startsWith(p + "-")) return `private-intent-excluded (${p})`;
  }
  if (lane && PRIVATE_LANES.has(String(lane).toLowerCase())) return `private-intent-excluded (lane ${lane})`;
  return null;
}

// PROTECTED intents — a different concern from private ones, and it must not
// ride on the same switch.
//
// Privacy asks "may this content leave the machine". The user turned that off
// (everything may go to Jev), which is the user's call to make.
// PROTECTION asks something else entirely: "may a confidence threshold be the
// thing that decides whether this ping fires at all". For the protected Rule #1
// lanes and for P1 email pointers the answer has been no since
// 2026-05-20, because the bar there is "only an EXPLICIT user revocation
// suppresses" — a rule a scalar confidence cannot encode — and the playbook has
// already decided the ping must go.
//
// Those two answers lived in one function until 2026-09-24, so flipping
// privacy_exclusions to false silently un-protected the lanes too: protected-lane
// pings started reaching Jev (two disagreements the same day, both Jev
// suppressions on a lane Jev is not supposed to be asked about). Both landed at 0.84/0.86, under outbound-precheck's 0.92
// bar, so the guarantee held by luck rather than by design. The two tests that
// claim to pin it passed throughout, because the fixture leaves privacy
// exclusions ON.
//
// Deliberately NOT privacy-gated, and deliberately the same list as
// edva-send-curl's PROTECTED_INTENT_RE plus p1-email (which that belt
// dropped on 2026-09-01 for reasons about the belt, not about Jev — the
// reasoning layers still treat it as protected).
// The protected lanes are the installation's (agent/local/config/hum-lanes.json
// `protected_lanes`, none by default), the same list hum-vetoes and the belt read.
const PROTECTED_INTENT_PREFIXES = createRequire(import.meta.url)("./instance.cjs")
  .localConfig("hum-lanes", { protected_lanes: [] }).protected_lanes.map((l) => `hum:${String(l).toLowerCase()}`);

export function protectedIntent(intent) {
  const i = String(intent || "").toLowerCase();
  if (i === "p1-email") return "protected-intent (p1-email)";
  for (const p of PROTECTED_INTENT_PREFIXES) {
    if (i === p || i.startsWith(p + ":") || i.startsWith(p + "-")) return `protected-intent (${p})`;
  }
  return null;
}

// Jev's own state budget and the privacy screen's bound (24k chars, fail-closed
// above it) both apply to the WHOLE state. Trim the named list-valued fields,
// longest first, until the serialized state fits.
//
// Direction is per field (code review 2026-09-23): most lists here are RANKED
// best-first (utterance search, recall top-k, memory rows) or lead with the
// current item (calendar_now), so they lose items from the END. Only lists named
// in `oldestFirst` (chronological, e.g. a transcript) lose from the FRONT.
export function fitState(state, maxChars = 20000, { oldestFirst = [] } = {}) {
  const front = new Set(oldestFirst);
  const s = JSON.parse(JSON.stringify(state));
  const size = () => JSON.stringify(s).length;
  let guard = 0;
  while (size() > maxChars && guard++ < 200) {
    const lists = Object.entries(s).filter(([, v]) => Array.isArray(v) && v.length);
    const strs = Object.entries(s).filter(([, v]) => typeof v === "string" && v.length > 400);
    if (lists.length) {
      const [k] = lists.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
      if (front.has(k)) s[k].shift(); else s[k].pop();
    } else if (strs.length) {
      const [k, v] = strs.sort((a, b) => b[1].length - a[1].length)[0];
      s[k] = v.slice(0, Math.floor(v.length * 0.75));
    } else break;
  }
  return s;
}

/**
 * @param {object} o
 * @param {string}   o.site
 * @param {string}   [o.id]
 * @param {object}   o.state            what Jev sees (keep under fitState's bound)
 * @param {*}        [o.logInput]
 * @param {()=>Promise<object>} o.legacy the existing Sonnet adjudicator; resolves its
 *                                      full parsed result, THROWS when it has no verdict
 * @param {(r:object)=>string} o.verdictOf  legacy result → verdict class
 * @param {string[]} o.classes          the verdict classes (Jev choice options)
 * @param {string[]} o.textClasses      classes that need generated text (Jev never acts alone)
 * @param {string[]} o.conservative     classes a Sonnet shadow may impose over a Jev let-through
 * @param {string}   [o.skipJev]
 * @param {number}   [o.jevTimeoutMs]
 * @returns {Promise<{source:"jev"|"legacy"|"legacy-conservative"|"legacy-text", verdict?:string, result?:object|null, jev?:string}>}
 *   source "jev" → act on `verdict` (a no-text class).
 *   otherwise    → act on `result` exactly as the pre-Jev code did; `result` is
 *                  null only when Sonnet failed on a legacy-text path (fail-open).
 */
export async function decideGate(o) {
  let memo = null;
  const legacy = () => (memo ||= Promise.resolve().then(o.legacy));
  const r = await decide({
    site: o.site,
    id: o.id ?? null,
    state: o.state,
    logInput: o.logInput,
    skipJev: o.skipJev || undefined,
    privacyScreen: true,
    jevTimeoutMs: o.jevTimeoutMs,
    interpret: (a) => {
      const v = a.verdict;
      const choice = v?.choice;
      if (!o.classes.includes(choice)) throw new Error(`jev: verdict not one of ${o.classes.join("/")}`);
      return { value: choice, confidence: answerConfidence(v) };
    },
    legacy,
    same: (j, l) => j === o.verdictOf(l),
  });

  if (r.used !== "jev") return { source: "legacy", result: r.value };

  const jv = r.value;
  // Shadow week: the Sonnet shadow has already resolved (decide awaits it).
  if (memo && !o.conservative.includes(jv)) {
    const sh = await memo.catch(() => null);
    if (sh && o.conservative.includes(o.verdictOf(sh))) return { source: "legacy-conservative", result: sh, jev: jv };
  }
  if (o.textClasses.includes(jv)) {
    const full = await legacy().catch(() => null);
    return { source: "legacy-text", result: full, jev: jv };
  }
  return { source: "jev", verdict: jv, jev: jv };
}
