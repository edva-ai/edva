// claim-freshness.mjs — is what this message ASSERTS still true at the moment
// it is RELEASED, not at the moment it was written?
//
// WHY. A reservoir idea can sit for days between being written and being sent.
// A status claim that was true when the idea was authored (a third party "still
// hasn't" done something) may have been resolved in the meantime. A ping must be
// BOTH relevant and TRUE, and truth is a property of the release instant, not
// the authoring one.
//
// WHY THE EXISTING GATES DIDN'T CATCH IT. Edva already had two:
//
//   claim-facts.mjs  — authorities for PLACES and DATES. Extracts the entities
//                      a candidate names and asks the travel timeline what is
//                      actually true. Excellent, and completely silent here:
//                      "hasn't shipped the replacement" contains no place and no
//                      date to probe.
//   outbound-precheck — RELEVANCE. Dedup, settled-topics, already-pinged-today,
//                      does-it-contradict-the-transcript. It asks "should this
//                      be said?", never "is this still so?".
//
// Between them sits the whole class of STATEFUL claims — a status some third
// party controls, which was observed once and then assumed to hold: has the
// payment been set up, has she replied, is it still unpaid, is the part still on backorder,
// is the permit still pending. These decay silently. Nothing re-read the source.
//
// THE INVERSION, which is claim-facts' inversion applied to state instead of
// geography: do NOT pattern-match phrasing to guess whether a claim went stale.
// Take the two things code actually knows — WHEN the evidence was observed and
// WHEN we are sending — and if there is a gap, ask a model what the message
// asserts that could have changed in that gap, then check that claim against
// what Edva KNOWS. The trigger is the GAP, which is arithmetic, so it cannot
// be defeated by a paraphrase. (This is also why there is no regex over the
// message text anywhere in this file: code owns geometry — here, elapsed
// time — and a model owns language.)
//
// THE AUTHORITY IS MEMORY, NOT A CHANNEL. Memory is updated from every channel,
// the inbox included, so it is what the gate consults. The first cut asked Gmail
// directly, with a model-authored keyword query per claim, and it missed: the
// resolving emails used different words from the claim, so the search returned
// only the stale complaint itself and the gate hedged where it should have
// dropped.
//
// That is Rule #0b one level removed: no regex touched anyone's language, but a
// LEXICAL query was treated as an authority and its miss was read as evidence of
// absence. Silence from a keyword search is not silence from the world, and a
// source's vocabulary is never the claim's vocabulary. So the gate now asks
// `recall` — semantic + BM25 across mail, chat, the user's own dated replies, the
// wiki and the activity log — and the inbox is ingested into memory
// (lib/inbox-mem.mjs) rather than queried at decision time. The dividend
// is bigger than the bug: a resolution that arrives by chat or WhatsApp now
// settles a claim just as well as an email does.
//
// THE COST SHAPE, which is what makes this affordable on every message.
// Stage 0 is subtraction. A message composed from evidence observed minutes ago
// — every chat reply, every freshly-harvested ping — exits at Stage 0 having
// spent nothing. Only a message riding OLD evidence pays for Stages 1–3, and
// that is exactly the population that can be stale. Reservoir ideas surface
// hours-to-days after authoring, so they always pay; that is the point.
//
// FAIL-OPEN, BUT NOT FAIL-TRUE. The house rule is fail-open — an occasional
// dumb ping is better than an entirely silent agent — and
// every error path here still lets the message through. But fail-open must not
// mean fail-TRUE: when a stale claim cannot be re-verified, the message is not
// allowed to keep ASSERTING it flatly. It is rewritten to carry its own
// provenance — "as of the <date> email, X hadn't happened" — which is a
// statement that stays true no matter what happened since.
// Unverifiable degrades confidence, never delivery.
//
// SOLICITED vs PROACTIVE. A hum ping nobody asked for can be dropped; a reply
// to a question the user just asked cannot — silence there is a worse failure than
// a hedged answer. Callers pass `solicited: true` and the gate's powers narrow
// to rewrite-only. See the three call sites: bin/claim-check,
// bin/outbound-precheck.mjs, agent/phone-channel/index.mjs.

import { createHash } from "node:crypto";
import { decideGate, privateIntent, fitState } from "./jev-gates.mjs";
import { decide, privacyOn } from "./jev-shadow.mjs";
import { answerConfidence, jevSiteDef } from "./jev.mjs";
import { runToolless, runToollessDetailed, parseModelJson as sharedParseModelJson } from "./jev-claude.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { installTools } from "./root.cjs";
const HOME = os.homedir();
const { instance, localConfig } = createRequire(import.meta.url)("./instance.cjs");
// CLAIM_FRESHNESS_* overrides are test seams (tests/jev-claim-freshness.test.mjs).
const CLAUDE_BIN = process.env.CLAIM_FRESHNESS_CLAUDE_BIN || path.join(HOME, ".local/bin/claude");
const LOG_FILE = process.env.CLAIM_FRESHNESS_LOG || installTools("data/claim-freshness-log.jsonl");
// Rolling extractor health (see noteExtractorOutcome). Gitignored runtime state.
const HEALTH_FILE = process.env.CLAIM_FRESHNESS_HEALTH || installTools("data/claim-freshness-health.json");
const SEND_BIN = process.env.CLAIM_FRESHNESS_SEND_BIN || installTools("bin/edva-send-curl");
const EXTRACT_TIMEOUT_MS = Number(process.env.CLAIM_FRESHNESS_EXTRACT_TIMEOUT_MS) || 45000;

// How old evidence must be before its claims are re-verified.
//
// 90 minutes, chosen off hum's own clock rather than a round number: the harvest
// tick is 20 minutes, so a candidate written this tick or the last few is still
// riding what the harvester just read and has nothing to re-check. Past that the
// candidate is coasting on a stored observation. Real stale ideas are usually
// days old, so the threshold could be far looser; it is tight because the check
// is nearly free when nothing is mutable, and because a same-morning resolution
// email is exactly the one most likely to be missed.
export const STALE_AFTER_MS = 90 * 60 * 1000;

// Bound on how many distinct claims get a mailbox round-trip in one check.
// Messages asserting more than a handful of mutable things are rare; the cap
// stops a pathological candidate from fanning out into a dozen searches.
const MAX_CLAIMS = 4;

// How far back the mailbox is searched when nobody dated the evidence.
//
// The first cut anchored the undated window at `now - STALE_AFTER_MS` — 90
// minutes — which is exactly backwards. "Undated" means we do not know how old
// the claim is, and a narrow window is a confident assumption about age. It made
// the re-check weakest precisely where we knew least: a two-day-old follow-up
// would sit just outside `after:` and the gate would report the mailbox silent
// and hedge, when the resolving mail was right there and it should have dropped.
// Unknown age → search wide. 14 days covers the reservoir's real dwell time with
// room to spare; the cost is a few more search hits for the adjudicator to read.
//
// A RETRIEVAL HINT, NEVER A PROVENANCE CLAIM. This value used to be
// handed to both model prompts as the sentence "the evidence behind it was
// observed at <date>", which is not what it means. For an undated message that
// rendered as a confident, false statement that the evidence was exactly 14 days
// old, and the models then judged fresh pings (e.g. one composed from a GPS fix
// seconds earlier) against two-week-old memory and dropped them — a large share
// of all outbound was suppressed this way. Since the memory rewrite (`recall` replaced the dated Gmail
// query) nothing bounds retrieval by this date at all, so the ONLY live effect
// the constant had was manufacturing that false provenance.
//
// The split is now explicit: `mailboxWindowStart` is a hint about how far to
// look, `staleness.as_of` is a fact about this message and is null when nothing
// dates it. Only the latter is ever shown to a model. Undated must read as
// "age unknown", never as "old".
const UNDATED_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

function log(row) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {}
}

// ─── Stage 0: geometry — when was this observed, and how long ago? ────────

// Keys that carry "when the world was looked at", most specific first. These are
// machine field names on Edva's own records, not prose, so matching them is
// structure — the thing the no-language-regex rule explicitly permits.
const AS_OF_KEYS = ["evidence_as_of", "observed_at", "as_of", "snapshot_at", "source_date", "received_at"];

// The timezone designator is part of the pattern on purpose. Matching only
// through the seconds leaves `Date.parse` a naive stamp, which ECMAScript reads
// as LOCAL time — so "2026-07-29T09:00:00Z" became 07:00Z on a UTC+2 host and
// every age was off by the host's offset. That is not cosmetic: it silently
// moved candidates across the stale line in both directions, which is the one
// piece of arithmetic this whole gate rests on. A stamp that genuinely carries
// no zone is read as UTC, matching every other timestamp Edva writes.
const ISO_STAMP = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/; // lang-regex-ok: ISO timestamp shape, machine-generated field value

function firstIso(value) {
  if (typeof value !== "string") return null;
  const stamp = value.match(ISO_STAMP);
  if (!stamp) return null;
  let text = stamp[0];
  if (text.length === 10) {
    // A bare date anchors at midday: midnight would make a same-day observation
    // read as up to 24h old, tripping the stale line for nothing.
    text = `${text}T12:00:00Z`;
  } else {
    text = text.replace(" ", "T");
    const zoned = text.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(text); // lang-regex-ok: timezone suffix on a machine timestamp
    if (!zoned) text += "Z";
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
}

/**
 * When the evidence behind this candidate was actually observed.
 *
 * Prefers an explicit as-of stamp, then a source email's date, then the
 * candidate's own creation time. Returns null when nothing dates the evidence —
 * and null is deliberately treated as STALE by checkFreshness, because an
 * undated claim is one whose age we cannot vouch for. (The one caller allowed to
 * skip that is a live turn, which passes `evidence_as_of: "live"`.)
 */
export function evidenceAsOf(input = {}) {
  const supporting = input.supporting_data || {};

  // Top-level first: this is what `edva-send-curl --evidence-as-of` and the
  // direct callers pass. Omitting it here was a silent wiring hole — the CLI
  // forwarded the stamp, nothing read it, and every ping stayed "undated".
  const declared = firstIso(input.evidence_as_of);
  if (declared) return { ...declared, from: "evidence_as_of" };

  for (const key of AS_OF_KEYS) {
    const hit = firstIso(supporting[key]);
    if (hit) return { ...hit, from: key };
  }

  // A nested source record — {source_email:{date}}, {source:{received_at}} —
  // is the common shape for anything harvested out of the mailbox.
  for (const [key, value] of Object.entries(supporting)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const inner of [...AS_OF_KEYS, "date", "sent_at"]) {
      const hit = firstIso(value[inner]);
      if (hit) return { ...hit, from: `${key}.${inner}` };
    }
  }

  const created = firstIso(input.created_at);
  if (created) return { ...created, from: "created_at" };
  return null;
}

/** Elapsed ms between evidence and send. Pure arithmetic — the whole trigger. */
export function evidenceAgeMs(input = {}, nowMs = Date.now()) {
  const at = evidenceAsOf(input);
  return at ? Math.max(0, nowMs - at.ms) : null;
}

/**
 * Does this candidate need re-verification at all?
 *
 * `live` — the caller composed it from work it did this turn — is the only way
 * to skip without a timestamp. Everything undated is stale by default: the
 * failure mode being closed is precisely a claim nobody could date.
 */
export function needsRecheck(input = {}, nowMs = Date.now()) {
  if (input.evidence_as_of === "live" || input.supporting_data?.evidence_as_of === "live") {
    return { stale: false, reason: "live_evidence", age_ms: 0 };
  }
  const at = evidenceAsOf(input);
  if (!at) return { stale: true, reason: "undated_evidence", age_ms: null, as_of: null };
  const age = Math.max(0, nowMs - at.ms);
  return {
    stale: age >= STALE_AFTER_MS,
    reason: age >= STALE_AFTER_MS ? "stale_evidence" : "fresh_evidence",
    age_ms: age,
    as_of: at.iso,
    as_of_from: at.from,
  };
}

/**
 * Where the mailbox re-check starts looking.
 *
 * Dated evidence anchors the window at the observation itself — only mail that
 * arrived after it can resolve the claim. Undated evidence gets the wide
 * fallback, because not knowing the age is a reason to look further back, not
 * a licence to look less. Exported so the choice is testable rather than buried.
 */
export function mailboxWindowStart(staleness, nowMs = Date.now()) {
  if (staleness && staleness.as_of) return staleness.as_of;
  return new Date(nowMs - UNDATED_LOOKBACK_MS).toISOString();
}

// ─── Model plumbing ───────────────────────────────────────────────────────

// ASYNC SPAWN, NOT spawnSync — non-negotiable, and the reason is the reply path.
// This module is imported by agent/phone-channel/index.mjs, a long-lived
// service holding a Supabase Realtime subscription and a 5-second ack-refresh
// interval. A multi-second synchronous spawn there blocks the event loop, which
// freezes both — the channel would stop acking and stop receiving while the gate
// thought. The same rule already binds auto-recall.mjs for the same reason
// (see changelog.md); outbound-precheck.mjs may use spawnSync only
// because it is a short-lived CLI that exits straight after.
// Tool-less, Max-only, async — lib/jev-claude.mjs (one shared runner).
async function askSonnet(prompt, timeoutMs = 60000) {
  return runToolless({ bin: CLAUDE_BIN, model: "claude-sonnet-5-5", prompt, timeoutMs });
}

/** Pull the JSON object out of a model's reply. Operates on MODEL output. */
export const parseModelJson = sharedParseModelJson;

// NO LOCAL PRE-FILTER — measured, then removed.
//
// The obvious cost optimisation is to screen undated messages with `gemma3:1b`
// first (Rule #0b's ladder: local → Sonnet → Opus) and only escalate the ones it
// flags as mutable. It was built, and it was cut after being run against the
// canonical case: asked whether "<the vendor> still hasn't shipped the
// replacement, so it won't arrive this week" describes a status someone else controls, the 1B model
// answered NO — clearing, for free, the exact ping this gate exists to catch.
// Reworded prompts got that case right, which is precisely the trap: a tier that
// passes the four examples in front of you and fails silently on the fifth
// paraphrase, weeks later, inside a nightly job nobody is watching.
//
// The trade was then measured rather than argued. Outbound volume is ~25–35
// messages/day; a Sonnet `--effort low` extraction is ~$0.004, so the filter was
// defending a few dollars a month — against a false-clear on the one gate the
// user has said must always hold. Undated messages go straight to Sonnet.
//
// The ladder is not wrong in general; it is wrong where the cheap tier's error
// mode is the failure you are trying to prevent. Cost is instead controlled at
// the source: callers declare `evidence_as_of: "live"` and pay nothing at all.

// ─── Stage 1: what does this assert that could have changed? ──────────────

/**
 * How the message's own age is described to a model.
 *
 * `observedIso` is null when nothing dates the evidence, and that must be said
 * plainly rather than papered over with a stand-in date. "Undated" is a
 * statement about our records, not about the message — a freshly-composed ping
 * and a two-week-old reservoir idea can both arrive here undated, and guessing
 * old is how a live GPS observation got adjudicated as a fortnight-stale claim.
 */
function provenanceLine(observedIso, nowIso, ageHours) {
  if (!observedIso) {
    return `Nothing in Edva's records dates the evidence behind it, so its age is UNKNOWN. It is now ${nowIso}. Treat the age as genuinely unknown: it may have been observed seconds ago. An undated message is NOT an old message, and you must not reason as if it were.`;
  }
  return `The evidence behind it was observed at ${observedIso}. It is now ${nowIso} — a gap of about ${ageHours} hours.`;
}

// Who the prompts below talk about (agent/local/instance.json owner_name;
// "the user" by default) and this installation's own examples in them
// (agent/local/config/claim-freshness.json, key "examples"). OWNER_ID is
// the suffix of the owner-named rewrite-check kinds; those kinds are persisted
// in the log and health rows, so they use instance().owner_id, not a new name.
const OWNER = instance().owner_name;
const OWNER_CAP = OWNER.charAt(0).toUpperCase() + OWNER.slice(1);
const OWNER_UP = OWNER.toUpperCase();
const OWNER_ID = instance().owner_id;
const EXAMPLE_DEFAULTS = {
  old_reply: "back ~the 12th",
  hedge: "as of Monday's shipping email, the replacement part hadn't shipped yet — worth confirming before assuming it arrives this week.",
  shipped_hedge: "As of when I found it on the 9th, the band was playing that venue that date — worth double-checking it's still on.",
  third_party_status: "has the vendor shipped it",
  corrected_address: "12 Main St",
  just_done: "Done — 1-2pm on the 14th is now lunch at the cafe",
  named_source: "the bank's alert on the 5th",
  correction_reply: "that's not where the meeting is",
  same_entity_examples: "Cancelling a subscription does not settle whether its last invoice was refunded. A reply confirming which booking a stay is does not settle when that stay ends.",
  earlier_step_examples: "an invitation sent is not an account signed up for, a contract sent for signature is not a contract signed, a package shipped is not a package delivered, an application started is not an application submitted",
};
const EX = { ...EXAMPLE_DEFAULTS, ...(localConfig("claim-freshness", { examples: {} }).examples || {}) };

// The exchange a chat reply answers (solicited callers only). Without it the
// extractor sees the reply alone and cannot tell an echo of what the user just
// said, or Edva's report of what it just did with it, from a status someone
// else controls: an acknowledgement of a place the user had just named was
// extracted as a third-party claim, re-checked against a calendar invite, and
// the "corrected" reply dropped the name the user had just given.
// Claims the reply brings in from ELSEWHERE are listed exactly as before, which
// is where this gate's real chat catches came from (a meeting time that differed
// from the invite, a stop the user had answered a minute earlier, stale watch progress).
const conversationBlock = (conversation) => conversation ? `
THIS MESSAGE IS EDVA'S REPLY in a live chat, composed seconds ago. The exchange it answers, oldest first (the last "${OWNER}:" line is what they just said):
"""
${conversation}
"""

${OWNER_CAP} is the source of what they tell Edva here, and they are the one reading the reply. So also do NOT list:
  - a fact ${OWNER} gave in this exchange, or the reply's acknowledgement of it, including Edva naming the place or thing they pointed to (a link, an address, "that spot"). That is Edva reading their own answer back to them, not a status someone else controls.
  - what Edva says it just did with their answer: saved, tagged, marked, added, noted. That is its own action, reported the moment it finished.
Everything else is judged exactly as before. List a claim the reply brings in from ELSEWHERE that they did not just give (an item still open on a stored list, a booking, a balance, a count, someone else's status), and list any part of the reply that CONTRADICTS what they said in the exchange.
The exchange is there to read the MESSAGE by, nothing more: list only assertions the MESSAGE itself makes, never one that appears only in the exchange.
` : "";

const EXTRACT_PROMPT = (body, observedIso, nowIso, ageHours, conversation = "") => `You are Edva's release gate. A message written earlier is about to be sent to ${OWNER} NOW.

${provenanceLine(observedIso, nowIso, ageHours)}

MESSAGE ABOUT TO BE SENT:
"""
${body.slice(0, 1500)}
"""
${conversationBlock(conversation)}
List every assertion in this message whose TRUTH COULD HAVE CHANGED during that gap. You are looking for claims about the CURRENT STATE of something that someone else controls and that nobody re-checked:

  - a status another party owns — has X enrolled / paid / replied / signed / booked / cancelled / shipped / approved / fixed it
  - something described as still outstanding, still pending, still missing, not yet done
  - a balance, a count, an availability, a deadline that someone could have met

Do NOT list:
  - things that cannot change — a past event, an arithmetic result, a preference, a date on the calendar
  - ${OWNER}'s own intentions or plans (they are the authority on those, and they are the reader)
  - background colour that the message does not actually depend on
  - WHERE ${OWNER_UP} IS, what they are doing, or what is around them right now. Edva observes this directly from their phone at the moment of sending — it is not a status some third party controls, and there is nothing to re-check. A message that says they are somewhere, or asks whether they are, is reporting a live sensor reading. An older chat message about travel plans is not evidence against it.

For each claim, write a short natural-language question to ask Edva's MEMORY — what you would want to know to find out whether it has changed. Memory is searched semantically across mail, chat, ${OWNER}'s own replies, the wiki and the activity log, so ask in plain words and name the people, places and things involved. Do NOT write a keyword query or search operators, and do NOT guess the words the source would have used — that is the mistake this gate was rebuilt to stop making.

Reply with ONE LINE of compact JSON, no prose, no markdown fence:
{"claims":[{"claim":"<the assertion, <=140 chars>","why_mutable":"<what could have changed it, <=100 chars>","memory_query":"<plain-language question naming the entities>"}]}

If nothing in the message is mutable, reply {"claims":[]}. Be strict: a message with no state claims must return an empty list, because an empty list is what makes this gate free on the messages that don't need it.`;

export async function extractStateClaims(args) {
  return (await extractStateClaimsDetailed(args)).claims; // null = extractor unavailable
}

/**
 * The extractor with its failure reason kept. Resolves {claims, error}:
 * claims is an array (possibly EMPTY — "nothing mutable", a real answer) or
 * null when the extractor failed, in which case error = {kind, message} with
 * kind "timeout" | "spawn_error" | "exit_nonzero" | "empty_output" |
 * "unparseable" (output was not JSON) | "bad_shape" (JSON without a claims
 * array). The kinds come from process status and parse structure, never from
 * reading the model's prose.
 */
export async function extractStateClaimsDetailed({ text, as_of_iso = null, now_iso, age_hours, conversation = "" }) {
  const { out: modelOut, error } = await runToollessDetailed({
    bin: CLAUDE_BIN, model: "claude-sonnet-5-5",
    prompt: EXTRACT_PROMPT(String(text || ""), as_of_iso, now_iso, age_hours, String(conversation || "")), timeoutMs: EXTRACT_TIMEOUT_MS,
  });
  if (error) return { claims: null, error };
  const parsed = parseModelJson(modelOut);
  if (!parsed) return { claims: null, error: { kind: "unparseable", message: `no JSON object in ${modelOut.length} chars of output` } };
  if (!Array.isArray(parsed.claims)) return { claims: null, error: { kind: "bad_shape", message: "JSON had no claims array" } };
  const claims = parsed.claims
    .filter((c) => c && typeof c.claim === "string" && c.claim.trim())
    .slice(0, MAX_CLAIMS)
    .map((c) => ({
      claim: String(c.claim).slice(0, 200),
      why_mutable: String(c.why_mutable || "").slice(0, 140),
      // Fall back to the claim itself as the query. Semantic retrieval makes the
      // claim a perfectly serviceable question, so a model that forgets the
      // field costs nothing — unlike the keyword era, where a missing query
      // meant no check at all.
      memory_query: String(c.memory_query || c.claim || "").slice(0, 300),
    }));
  return { claims, error: null };
}

// ─── Extractor health: make "couldn't check" visible ──────────────────────
//
// THE GAP. A self-improvement review found ~40% of one week's gate decisions
// were the Stage-1 extractor failing — mostly the 45s Sonnet call — and the
// code threw the error away and logged "pass". The truth gate was
// silently off and nothing could say so. Fail-OPEN stays (a
// message still goes out), but each failure now logs its
// kind, a rolling window counts the rate, and the system channel is paged ONCE
// per episode when the rate crosses the line — never a push per failure — with
// the matching recovery ping (agent/CLAUDE.md § System Channel parity).
export const HEALTH_WINDOW = 50;        // last N extraction attempts
export const HEALTH_MIN_SAMPLE = 20;    // don't judge a rate off a handful
export const HEALTH_ALERT_RATE = 0.2;   // >20% failed → page
export const HEALTH_RECOVER_RATE = 0.1; // hysteresis: recover only well below the line
const HEALTH_REPAGE_MS = 24 * 3600e3;   // a standing episode re-pages at most daily

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8")) || {}; } catch { return {}; }
}

/** Current rolling extractor stats — exported for reports and tests. */
export function extractorHealth() {
  const st = readHealth();
  const win = Array.isArray(st.window) ? st.window : [];
  const failures = win.filter((k) => k).length;
  return {
    window: win.length, failures, rate: win.length ? failures / win.length : 0,
    total_attempts: st.total_attempts || 0, total_failures: st.total_failures || 0,
    by_kind: st.by_kind || {}, alerted_at: st.alerted_at || null,
  };
}

// One rolling window, shared by the two health counters below: push the
// outcome ("" = fine), keep the totals, and say whether this push crossed the
// line ("down") or came back under the recovery line ("up"). Mutates `st`.
function rollWindow(st, kind, { window, minSample, alertRate, recoverRate }) {
  const win = Array.isArray(st.window) ? st.window : [];
  win.push(kind || "");
  while (win.length > window) win.shift();
  st.window = win;
  st.total_attempts = (st.total_attempts || 0) + 1;
  if (kind) {
    st.total_failures = (st.total_failures || 0) + 1;
    st.by_kind = st.by_kind || {};
    st.by_kind[kind] = (st.by_kind[kind] || 0) + 1;
    st.last_failure_at = new Date().toISOString();
    st.last_failure_kind = kind;
  }
  const failures = win.filter((k) => k).length;
  const rate = failures / win.length;
  const now = Date.now();
  let page = null;
  if (win.length >= minSample && rate > alertRate) {
    const last = st.alerted_at ? Date.parse(st.alerted_at) : 0;
    if (!last || now - last >= HEALTH_REPAGE_MS) { st.alerted_at = new Date(now).toISOString(); page = "down"; }
  } else if (st.alerted_at && rate <= recoverRate) {
    page = "up"; delete st.alerted_at;
  }
  const kinds = {};
  for (const k of win) if (k) kinds[k] = (kinds[k] || 0) + 1;
  const kindStr = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  return { page, failures, n: win.length, pct: Math.round(rate * 100), kindStr, stats: { window: win.length, failures, rate: Math.round(rate * 1000) / 1000 } };
}

function writeHealth(st) {
  fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
  writeFileAtomic(HEALTH_FILE, JSON.stringify(st));
}

/**
 * Record one extraction attempt ("" kind = success) and page on threshold
 * crossings. Never throws: a release decision must not fail because its own
 * bookkeeping did. Returns the post-update stats for the log row.
 */
export function noteExtractorOutcome(errorKind = "") {
  try {
    const st = readHealth();
    const r = rollWindow(st, errorKind, { window: HEALTH_WINDOW, minSample: HEALTH_MIN_SAMPLE, alertRate: HEALTH_ALERT_RATE, recoverRate: HEALTH_RECOVER_RATE });
    writeHealth(st);
    if (r.page === "down") {
      sendSystem(`🟠 Truth gate partly blind: the claim-freshness extractor failed ${r.failures} of the last ${r.n} checks (${r.pct}%; ${r.kindStr}). Those messages went out without the stale-claim check — fail-open, nothing was dropped. Per-row reasons: data/claim-freshness-log.jsonl (extractor_unavailable:<kind>).`);
    } else if (r.page === "up") {
      sendSystem(`✅ Truth gate seeing again: claim-freshness extractor failures down to ${r.failures} of the last ${r.n} checks (${r.pct}%).`);
    }
    return r.stats;
  } catch { return null; }
}

// The same counter for the Stage-3b rewrite check, kept under
// `rewrite_check` in the same file. A refused or unjudged rewrite sends the
// original, so a check that starts refusing nearly everything (or cannot answer)
// would quietly stop the gate dating stale claims: Rule #2's "fail-TRUE".
// Baseline, measured by replaying one week's 31 rewrites through this
// check on Sonnet: 17 refused (55%), 8 of them rewrites that had made a true
// message wrong, 7 that only added something to a reply that was already fine,
// 2 good corrections lost. So the line sits well above 55%: 17 of the last 20.
export const REWRITE_HEALTH_WINDOW = 20;       // ~4-5 days of rewrites at the measured rate
export const REWRITE_HEALTH_MIN_SAMPLE = 10;
export const REWRITE_HEALTH_ALERT_RATE = 0.8;
export const REWRITE_HEALTH_RECOVER_RATE = 0.6;

/** Record one rewrite check ("" = accepted; else "rejected:<kind>" | "unavailable"). Never throws. */
export function noteRewriteCheckOutcome(kind = "") {
  try {
    const st = readHealth();
    st.rewrite_check = st.rewrite_check && typeof st.rewrite_check === "object" ? st.rewrite_check : {};
    const r = rollWindow(st.rewrite_check, kind, { window: REWRITE_HEALTH_WINDOW, minSample: REWRITE_HEALTH_MIN_SAMPLE, alertRate: REWRITE_HEALTH_ALERT_RATE, recoverRate: REWRITE_HEALTH_RECOVER_RATE });
    writeHealth(st);
    if (r.page === "down") {
      sendSystem(`🟠 Truth gate refusing its own corrections: the rewrite check turned down or could not judge ${r.failures} of the last ${r.n} rewrites (${r.pct}%; ${r.kindStr}). Those messages went out as first written, so a stale claim in them was sent without its date. Per-row reasons and refused text: data/claim-freshness-log.jsonl (rewrite_rejected:<kind>, rewrite_check_unavailable, rejected_rewrite).`);
    } else if (r.page === "up") {
      sendSystem(`✅ Truth gate accepting its corrections again: rewrite-check refusals down to ${r.failures} of the last ${r.n} (${r.pct}%).`);
    }
    return r.stats;
  } catch { return null; }
}

function sendSystem(msg) {
  if (process.env.CLAIM_FRESHNESS_NO_ALERT) return;
  try {
    const child = spawn(SEND_BIN, ["--channel", "system", "--skip-precheck", "--intent", "claim-freshness-health", msg], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// ─── Stage 2: go re-read the source of record ─────────────────────────────

// A memory row's timestamp, whichever field its source uses.
function rowTs(r) {
  return r?.created_at || r?.ts || null;
}

/**
 * Ask MEMORY what it knows about this claim — the authority (memory is
 * updated from multiple channels, the inbox included).
 *
 * This replaced a direct `gog gmail search` with a model-authored keyword query.
 * That design failed on the ping it was built for: the claim and the resolving
 * emails used different words, and the keyword search returned only the stale
 * complaint itself. Two things fix it, and both
 * require memory rather than a channel:
 *
 *   SEMANTIC, not lexical. `recall` fuses BM25 with embedding KNN, so the
 *     question is answered in the ASKER's vocabulary, not the sender's.
 *   EVERY CHANNEL, not one. Mail, chat, the user's own dated replies, the wiki,
 *     the activity log. A resolution the user mentioned in chat, or that arrived by
 *     WhatsApp, settles the claim exactly as well as an email — which a
 *     mailbox-only authority could never do.
 *
 * Rows are returned annotated rather than filtered: the adjudicator READS them
 * and decides. Hard-filtering by date was tempting and wrong — a wiki page or a
 * durable reply carries no useful timestamp, and dropping undated rows would
 * silently discard exactly the settled-fact evidence most likely to refute a
 * claim. (Same lesson auto-recall learned when a score threshold was replaced
 * by a model that reads the candidates.)
 *
 * Fail-open to an empty list: unreachable memory must never manufacture a
 * contradiction. It does leave the claim UNCONFIRMED, which downstream becomes
 * attribution rather than a flat assertion.
 */
// 14, not 8. With five sources fused by RRF, a top-8 gives each source barely
// one or two slots — and on the case this gate exists for, the inbox's two
// decisive rows lost their slots to the stale complaint and an unrelated
// row. Chat and replies happened to carry the
// answer that time; a claim whose resolution lives ONLY in mail would have been
// buried by the fusion itself. Reading a few more rows is far cheaper than
// missing the one that settles it.
export async function recheckMemory(query, asOfIso, { limit = 14 } = {}) {
  if (!query) return { ok: false, hits: [] };
  try {
    const { recall } = await import("./unified-recall.mjs");
    const res = await recall(query, {
      k: limit,
      chat: true,
      wiki: true,
      replies: true,
      inbox: true,
      events: true,   // job outcomes + triage decisions often carry the resolution
      wikiMatch: "or", // the query is a whole question, not a term list
    });
    const rows = Array.isArray(res?.results) ? res.results : [];
    const asOfMs = Date.parse(asOfIso);
    return {
      ok: true,
      sources: res?.sources || [],
      hits: rows.slice(0, limit).map((r) => {
        const ts = rowTs(r);
        const tsMs = ts ? Date.parse(ts) : NaN;
        return {
          source: r.source,
          title: String(r.title || "").slice(0, 160),
          snippet: String(r.snippet || "").slice(0, 300),
          date: ts ? String(ts).slice(0, 16) : null,
          // "Did this arrive after we learned the thing we're asserting?"
          after_evidence: Number.isFinite(tsMs) && Number.isFinite(asOfMs) ? tsMs >= asOfMs : null,
        };
      }),
    };
  } catch (err) {
    // Carry the reason. An unexplained `ok:false` is indistinguishable from
    // "memory genuinely knows nothing", and the two demand opposite responses —
    // one is a broken authority, the other is a real answer. Reporting which is
    // the difference between a visible failure and a silent degradation.
    return { ok: false, hits: [], error: String(err?.message || err).slice(0, 200) };
  }
}

// ─── Stage 2b: the travel timeline — the authority memory does not have ───
//
// WHY. A message cited a flight date that the airline had since moved. Stage 1
// rightly flagged the date as mutable; Stage 2 then asked MEMORY, which only
// held prose written before the move, and Stage 3 "corrected" the true date to
// the stale one, overruling the travel timeline it had never been shown.
// The timeline (maintained by the installation from airline confirmations
// and its travel CLI) is the source of record for where the user will be
// and when they fly, and it is not indexed by recall, so it is read here
// directly and handed to both adjudicators as ground truth for travel claims.
//
// Code reads the timeline (geometry); the adjudicator decides whether a claim
// is about it (language). Fail-open: an unreadable timeline is reported as
// such and the adjudicator is told to treat travel dates as unverified-but-the-user's.
//
// The timeline is an installation's own source: the CLI that prints it
// (`<bin> list --json`, rows {arrive_at, depart_at, metro, place_label,
// source}) is named by the optional hook lib/_ext/claim-freshness-timeline.mjs
// (`export function travelBin()`). No hook, no timeline: the adjudicators then
// see no timeline block at all. CLAIM_FRESHNESS_TRAVEL_BIN is the test seam.
async function travelBin() {
  if (process.env.CLAIM_FRESHNESS_TRAVEL_BIN) return process.env.CLAIM_FRESHNESS_TRAVEL_BIN;
  const { runHook } = await import("./ext-hooks.mjs");
  return runHook(path.dirname(fileURLToPath(import.meta.url)), "claim-freshness-timeline", "travelBin", [], null);
}
export const TIMELINE_BACK_MS = 2 * 24 * 60 * 60 * 1000;
export const TIMELINE_AHEAD_MS = 120 * 24 * 60 * 60 * 1000;

export function renderTimeline(segments, nowMs = Date.now()) {
  const lo = nowMs - TIMELINE_BACK_MS, hi = nowMs + TIMELINE_AHEAD_MS;
  // A segment is a stay or a transit leg: it STARTS at arrive_at (the user
  // arrives there) and ENDS at depart_at (they leave); a transit leg is the flight.
  const rows = (segments || [])
    .filter((r) => Date.parse(r.depart_at || r.arrive_at) >= lo && Date.parse(r.arrive_at || r.depart_at) <= hi)
    .sort((a, b) => String(a.arrive_at).localeCompare(String(b.arrive_at)));
  if (!rows.length) return "  (the timeline has no segments in this window)";
  const t = (iso) => (iso ? `${String(iso).slice(0, 16).replace("T", " ")}Z` : "?");
  // Dates and places only — segment notes carry booking prose (refund amounts,
  // hosts' names) that the gate has no use for and Jev must not see.
  return rows.map((r) => `  - ${t(r.arrive_at)} → ${t(r.depart_at)}  ${r.metro === "transit" ? "IN TRANSIT (flight)" : r.metro || "?"}  "${String(r.place_label || "").slice(0, 60)}"  [${r.source || "?"}]`).join("\n");
}

export async function readTravelTimeline(nowMs = Date.now(), { timeoutMs = 8000 } = {}) {
  let TRAVEL_BIN;
  try { TRAVEL_BIN = await travelBin(); } catch { TRAVEL_BIN = null; }
  if (!TRAVEL_BIN) return null;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` };
      const child = spawn(TRAVEL_BIN, ["list", "--json"], { env });
      const t = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, block: "  (travel timeline could not be read: timeout)" }); }, timeoutMs);
      child.stdout.on("data", (c) => { out += c; });
      child.on("error", (e) => { clearTimeout(t); finish({ ok: false, block: `  (travel timeline could not be read: ${String(e.message).slice(0, 80)})` }); });
      child.on("close", (code) => {
        clearTimeout(t);
        if (code !== 0) return finish({ ok: false, block: `  (travel timeline could not be read: exit ${code})` });
        try { finish({ ok: true, block: renderTimeline(JSON.parse(out), nowMs) }); }
        catch { finish({ ok: false, block: "  (travel timeline could not be read: bad JSON)" }); }
      });
    } catch (e) {
      finish({ ok: false, block: `  (travel timeline could not be read: ${String(e?.message || e).slice(0, 80)})` });
    }
  });
}

export const TIMELINE_RULE = `TRAVEL DATES COME FROM THE TRAVEL TIMELINE, NEVER FROM MEMORY. The timeline above is Edva's live source of record for where ${OWNER} will be and when they fly — maintained from the airline and booking confirmations themselves, and updated when an airline moves a flight. Memory is prose written earlier and is NOT kept in step with it: an old reply ("${EX.old_reply}"), a ping that quoted a since-moved flight, a wiki line written before a rebooking. So for any claim about a trip, a stay, a flight, a departure or arrival date, or how long until one:
  - if the message AGREES with the timeline, the claim holds — "pass" on that claim, whatever memory says;
  - if the message DISAGREES with the timeline, the timeline is the correction (case (a)), never memory;
  - never rewrite a travel date to one the timeline does not show, and never let a memory row's date outrank it;
  - if the timeline could not be read, a travel date is ${OWNER}'s own plan read off their timeline: "pass" on it rather than correcting it from memory.`;

// ─── Stage 3: adjudicate against what came back ───────────────────────────

// WHY THE UNSOLICITED BRANCH NAMES WHO "SOMEONE ELSE" IS (from a Jev
// disagreement review).
//
// An earlier narrowing withdrew case (b) from proactive messages, on the
// reasoning that a hedge nobody asked for hands the user verification work. Right
// rule. But it left the branch with no verdict for a claim memory is SILENT
// about, because "Silence in memory is NOT confirmation. A claim nobody could
// re-verify gets case (b), not pass" forbade pass for every silent claim, and
// case (b) was gone — so silence had exactly one exit, and it was "drop".
//
// That is a drop on the absence of evidence, which the undated branch a few
// lines above explicitly forbids ("never drop it merely because you cannot date
// it"). The adjudicator resolved the contradiction about half the time each way
// on byte-identical input, which is itself the proof it was not deciding on
// evidence.
//
// Both clauses were always scoped to a THIRD PARTY's status — has the payment
// been set up, has she replied, is the tour still on. Two silent claims are not
// that, and for them the silence is structural: there is no source of record to
// go quiet. A wishlist item the user hasn't got round to is their own
// doing and they are also the reader; a digest this run just emailed
// or a delivery notice it read seconds ago is
// Edva's own just-done work, which memory cannot yet know about. Naming both
// restores "pass" for them without widening it anywhere else — the Jev question
// file already drew the same line; this is the port to the legacy adjudicator.
// Replayed before filing (3 samples per row, 10 rows): the two silent-claim
// drops became passes, every other row was unchanged, no regressions.

// The solicited own-just-done-work paragraph licenses a CHANGE Edva made and
// read back, but not Edva's own present STATE (e.g. a fix written and waiting
// on the user's approval). Memory cannot see the approval queue, so case (b)
// used to hedge a true answer about it. The proactive branch already treats
// Edva's own state and the user's own doing as outside "someone else"; the
// solicited branch now does too.

// WHAT A REWRITE MAY CHANGE. The rewrite is the gate's own new text, and until
// a weekly review nothing checked it. That review found rewrites that changed
// meaning: one marked a question answered before the user had answered it, one
// replaced the user's own fresh report with an older email's status, one added
// a question of its own, and a replay showed a flight date "corrected" from
// replies older than the message's evidence. Earlier, a
// true "review is complete" P1 ping was turned into "moved to In Review" from OLDER mail.
// The adjudicator is told the limits here; checkRewrite() below holds it to them.
export const REWRITE_LIMITS = `WHAT A REWRITE MAY CHANGE. A rewrite exists to stop the message asserting what Edva cannot vouch for, not to improve it. Touch only the claims you could not vouch for, and only in one of three ways: (1) say when and where the claim was observed; (2) remove it; (3) for case (a), replace its value (a date, a time, a count, a status, the items in a list, or how sure the message is) with what the travel timeline shows, or with what a DATED memory row shows (when the evidence is dated, a row from after it; when the evidence is undated, any dated row), naming that source if it helps and changing only the words that depend on the old value. Either way, not when ${OWNER}'s own word says otherwise: a reply or chat line of theirs dated later than that row, or what the message reports they have just told Edva. Never take a replacement value from an undated row. Leave every other sentence as written. Never add a claim, a warning or a question the message did not make. Never open a new question. Never present a question the message calls open as answered, or drop it, unless a dated reply of ${OWNER}'s shows they answered or dismissed THAT question. An answer they gave to a different question does not count, and one answer settles one question: if the message already takes their reply as the answer to one question, it is not also the answer to another.`;

export const ADJUDICATE_PROMPT = (body, observedIso, nowIso, claimBlock, solicited, timelineBlock = null) => `You are Edva's release gate, deciding whether a message is still TRUE at the moment it is sent.

${provenanceLine(observedIso, nowIso, "unknown")} Below is each claim it depends on, together with what Edva's MEMORY knows about it. Memory spans mail, chat, ${OWNER}'s own dated replies, the wiki and the activity log. Rows that postdate the evidence are marked -- those are the ones that can have overturned the claim.${observedIso ? "" : `

Because the evidence is undated, you have NO basis to call this message old. Drop it only if memory affirmatively shows the situation resolved. Never drop it merely because you cannot date it.`}

MESSAGE ABOUT TO BE SENT:
"""
${body.slice(0, 1500)}
"""

CLAIMS AND WHAT MEMORY SAYS:
${claimBlock}
${timelineBlock ? `
TRAVEL TIMELINE (live, authoritative — times are UTC):
${timelineBlock}

${TIMELINE_RULE}
` : ""}
Decide, for the message as a whole:

- "drop"    — memory shows the situation is resolved and the message is now simply wrong or pointless. The thing it says hasn't happened HAS happened; the question it raises is already answered. Note that the resolving evidence will usually NOT repeat the message's own words -- a claim that someone "hasn't enrolled" is settled by a notice saying they "set up" or "updated" or "registered". Match on MEANING, not on shared vocabulary; treating a wording mismatch as absence of evidence is the exact failure this gate was rebuilt to stop.
- "rewrite" — the message is still worth sending but must stop asserting something it can no longer vouch for. TWO cases, and both produce corrected text:
    (a) memory shows the state MOVED but the message is still useful with the new facts — say the new facts;
    (b) memory is SILENT (nothing came back, or it couldn't be reached) and the claim is a status someone else controls. Do not assert it flatly. Attribute it to when it was observed, in ${OWNER}'s own register — e.g. "${EX.hedge}" The rewrite must stay a normal, useful sentence: same point, same tone, honest about vintage. Never add hedging boilerplate like "please verify" or "this may be outdated".
    ${solicited
      ? `Case (b) IS available here: ${OWNER_CAP} asked, so a dated answer beats no answer.`
      : `**Case (b) is NOT available for this message.** Nobody asked for it. When memory is silent about a status someone else controls and the evidence is more than a day old, the honest move is "drop", not a dated hedge — see the DO NOT HEDGE A PING NOBODY ASKED FOR rule below.`}
- "pass"    — the claims are not actually stale, or memory confirms the message still holds. Nothing needs changing.

${REWRITE_LIMITS}${solicited ? "" : `

DO NOT HEDGE A PING NOBODY ASKED FOR (2026-08-04). A hedge moves work onto ${OWNER}: it hands them a claim Edva could not stand behind and asks them to go check. For a message THEY asked for that is the right trade — a dated answer beats silence. For a proactive one it is not, because the alternative is not silence-instead-of-an-answer, it is simply one fewer interruption. Real examples that shipped and should not have:

  "As of the last watchlist scan (Jul 18), 4 candidates were queued for hum approval — worth checking if you've already answered any of those pings since."
  "${EX.shipped_hedge}"

Both are Edva asking ${OWNER} to do Edva's verification. So for THIS message: if the claim is a stateful status someone else controls, memory is silent, and the evidence is more than about a day old — choose "drop". Prefer "rewrite" only when the message survives WITHOUT the stale claim (drop the claim, keep the useful part) or when the vintage genuinely is the point ("Wednesday's inspection report said X").

NEVER ASK ${OWNER_UP} TO VERIFY EDVA'S OWN STATE. A question like "worth checking if you've already answered any of those pings", "did that job run?", "is that still queued?" is a bug report addressed to the wrong person — Edva can read its own files and should. Any message whose ask is about Edva's internal state — queues, pings, jobs, scans, caches, its own memory — is "drop", regardless of freshness.

WHO "SOMEONE ELSE" IS. Both the drop above and case (b) turn on a status a THIRD PARTY controls — ${EX.third_party_status}, has she replied, is the tour still on, is the part still on backorder. Two silent claims are not that, and for them memory's silence is a gap in the instrument rather than evidence, so the verdict is "pass":

  ${OWNER_UP}'S OWN DOING — something they have or haven't got round to (an item on their own wishlist still unvisited, a list untouched, an idea unbooked), or a date read off their own calendar or travel timeline. They are the authority on these and they are also the reader: if they did the thing last week they know, and an offer to help with it costs them nothing. Nothing in mail, chat, the wiki or the activity log records "${OWNER} hasn't got round to it", so it can only ever come back unconfirmed. This does NOT cover a specific upcoming plan memory shows they CHANGED — that is case (a), which still applies.

  EDVA'S OWN JUST-DONE WORK — what this run just did or just read: a digest emailed, a delivery notice it read seconds ago, a slot with nothing to enter, an event it created or amended, a row it wrote. The action IS the evidence and memory has had no chance to learn of it; note too that memory does not span the calendar at all. It stays "pass" when the message hands ${OWNER} something only THEY can do with it (read the email it just sent, re-authorize a credential, decide) — that is an escalation, not a hedge. Two limits: not a status someone ELSE still has to confirm, and not an old observation in fresh clothes — if the message dates its own look to an earlier day, it is not just-done work.`}

SAME ENTITY IS NOT THE SAME PROPOSITION. Matching on meaning cuts both ways. A row can share the message's subject, its people, its place and its vocabulary and still answer a DIFFERENT question about them. Before letting a row overturn a claim, say what that row actually settles, and check that it is the same proposition the claim makes. ${EX.same_entity_examples} This gate has already lost three true messages this way: two dropped outright, one rewritten into a question. AND A STEP TOWARDS A STATE IS NOT THAT STATE. When the claim is that something has not happened YET, a row recording an EARLIER STEP of the same process settles nothing — ${EX.earlier_step_examples}. This is the hardest shape to catch, because such a row names the same person, the same product and the same process, is worded differently from the claim, and postdates the evidence — everything the meaning-matching rule above tells you to look for. But it is the PREMISE the message is built on, not its answer, and a message asking "has she actually done it yet, or is a nudge worth it" is MORE useful once the earlier step is known to have happened, not less. Before dropping, name what the FINISHED state would look like in writing and check that memory actually contains THAT.

AND A CORRECTION THE MESSAGE HAS ALREADY ABSORBED NEVER REFUTES IT. When ${OWNER} replies "${EX.correction_reply}" and the message in front of you opens "my mistake, it's actually at ${EX.corrected_address}", their correction is the REASON this message exists, not evidence against it. A row that prompted the message cannot overturn it — look at what the message already concedes before treating their objection as live. Rewriting such a message back into a question ("once you confirm whether it's really ${EX.corrected_address}...") hands them back the correction they just made.

Silence in memory is NOT confirmation. A claim about a status SOMEONE ELSE controls that nobody could re-verify gets case (b), not "pass".${solicited ? `

EDVA'S OWN JUST-DONE WORK IS NOT A THIRD-PARTY STATUS. When the message reports a change Edva itself made moments ago and read back — a calendar event it created or amended, a wiki page it saved, a watchlist row it flipped, a GPS stop it marked — the action IS the evidence, and memory has had no chance to learn of it, so silence there confirms nothing and case (b) does not apply. "${EX.just_done}" and "Got it, marked as a non-stop" are "pass"; they are not claims awaiting someone's confirmation. Note in particular that memory spans mail, chat, replies, wiki and the activity log but NOT the calendar, so a calendar claim can only ever come back unconfirmed — that silence is a gap in the instrument, never evidence. Two limits. This does not cover a status someone ELSE still has to confirm (a table a restaurant must accept, a reply someone owes) — that is their state, and the normal rules apply. And it does not cover an old observation in fresh clothes: if the message dates its own look to an earlier day, it is not just-done work.

EDVA'S OWN STATE IS NOT A THIRD-PARTY STATUS EITHER. When ${OWNER} asks about Edva itself and the answer says where Edva's own work stands right now — a fix waiting on their Face ID in Improvements, a card it filed, a build still running, a bug it has or has not started on, a job it has queued — the authority is Edva's own records (its approval queue, its job runner, its own work), and memory does not index those, so memory's silence about them is a gap in the instrument, never evidence. The same holds for whether ${OWNER} has approved, signed or decided something the answer tells them is waiting on them: that is their own doing, and they are both the authority on it and the reader. Hedging either ("as far as I can see", "as of the latest I have") makes Edva sound unsure of its own records and quietly hands them the check, which Edva must never do. Verdict "pass". The two limits above still apply: not a status someone ELSE still has to confirm, and not an observation the message itself dates to an earlier day.` : ""}

Memory is PROSE, and prose lags the world. Where ${OWNER} IS right now is observed from their phone, not recalled — so a remembered sentence about their travel plans can never establish that they are somewhere other than where this message places them. If the disagreement is between a live observation and something they said days ago, the observation wins and the claim is not stale.${solicited ? `

NOTE: ${OWNER_CAP} ASKED for this message. "drop" is not available — an unanswered question is worse than a dated answer. Choose "rewrite" or "pass".` : ""}

Reply with ONE LINE of compact JSON, no prose, no markdown fence:
{"verdict":"pass"|"rewrite"|"drop","reason":"<=140 chars, cite the memory row (source + date) or say memory was silent","corrected_text":"<only when verdict=rewrite; the full replacement message, same length and register as the original>"}`;

function renderClaimBlock(rechecked) {
  return rechecked.map((r, i) => {
    const head = `${i + 1}. CLAIM: ${r.claim}\n   could change because: ${r.why_mutable || "(unstated)"}\n   asked memory: ${r.memory_query || "(none proposed)"}`;
    if (!r.search.ok) return `${head}\n   MEMORY: could not be reached${r.search.error ? ` (${r.search.error})` : ""} — this claim is UNCONFIRMED.`;
    if (!r.search.hits.length) return `${head}\n   MEMORY: knows nothing about this. UNCONFIRMED — silence is not confirmation.`;
    const sinceLabel = r.since
      ? `evidence was observed ${r.since}`
      : "evidence date unknown — nothing below can be assumed to postdate it";
    const hits = r.search.hits
      .map((h) => {
        const when = h.date ? `[${h.date}]` : "[undated]";
        // Marking what postdates the evidence is the whole point: a row from
        // AFTER we learned the claim is the one that can have overturned it.
        const rel = h.after_evidence === true ? " ← AFTER the evidence"
          : h.after_evidence === false ? " (predates the evidence)"
          : "";
        return `     - ${when} ${h.source}${rel}: ${h.title ? `"${h.title}" — ` : ""}${h.snippet}`;
      })
      .join("\n");
    return `${head}\n   MEMORY says (${sinceLabel}):\n${hits}`;
  }).join("\n\n");
}

// ─── Stage 3 decision: Jev primary, Sonnet shadow + fallback ──────────────

async function sonnetAdjudicate({ body, observedIso, nowIso, rechecked, solicited, timeline }) {
  const modelOut = await askSonnet(
    ADJUDICATE_PROMPT(body, observedIso, nowIso, renderClaimBlock(rechecked), solicited, timeline?.block || null),
    60000,
  );
  const parsed = parseModelJson(modelOut);
  if (!parsed || !["pass", "rewrite", "drop"].includes(parsed.verdict)) throw new Error("adjudicator_unavailable");
  return parsed;
}

// The Jev state: the message, its provenance, and each claim with what memory
// said — flattened to strings so fitState can trim rows, not whole claims.
function jevFreshnessState({ body, observedIso, nowIso, rechecked, solicited, timeline }) {
  const rows = [];
  rechecked.forEach((r, i) => {
    if (!r.search.ok) { rows.push(`claim ${i + 1}: MEMORY UNREACHABLE — unconfirmed`); return; }
    if (!r.search.hits.length) { rows.push(`claim ${i + 1}: memory knows nothing — unconfirmed`); return; }
    for (const h of r.search.hits) {
      const rel = h.after_evidence === true ? " (AFTER the evidence)" : h.after_evidence === false ? " (predates the evidence)" : "";
      rows.push(`claim ${i + 1}: [${h.date || "undated"}] ${h.source}${rel}: ${h.title ? `"${h.title}" — ` : ""}${String(h.snippet || "").slice(0, 220)}`);
    }
  });
  return {
    message: body.slice(0, 1500),
    evidence_observed_at: observedIso || "UNKNOWN (undated — not the same as old)",
    now: nowIso,
    solicited: solicited ? `yes — ${OWNER} asked for this; drop is not available` : "no — proactive, nobody asked",
    claims: rechecked.map((r, i) => `claim ${i + 1}: ${r.claim} (could change because: ${r.why_mutable || "unstated"})`),
    memory_rows: rows,
    travel_timeline: timeline?.block ? timeline.block.split("\n").map((l) => l.trim()) : ["(not read)"],
  };
}

export async function adjudicate(ctx) {
  const legacy = () => sonnetAdjudicate(ctx);
  let gate;
  try {
    gate = await decideGate({
      site: "claim-freshness",
      id: createHash("sha1").update(ctx.body).digest("hex").slice(0, 12),
      state: fitState(jevFreshnessState(ctx)),
      logInput: { text: ctx.body.slice(0, 300), solicited: ctx.solicited, n_claims: ctx.rechecked.length },
      legacy,
      verdictOf: (p) => p.verdict,
      classes: ["pass", "rewrite", "drop"],
      textClasses: ctx.solicited ? ["rewrite", "drop"] : ["rewrite"],
      conservative: ["drop"],
      // SOLICITED replies never reach Jev (from a code review): the phone-
      // channel reply path carries no intent or lane, and a chat answer is exactly
      // where the user asks about their health or finances. Proactive messages are
      // excluded by intent/lane (forwarded by claim-check and outbound-precheck)
      // and screened on-device for everything else.
      skipJev: (ctx.solicited && privacyOn()) ? "solicited-reply-excluded"
        : (privateIntent(ctx.input?.intent) || privateIntent(ctx.input?.subject, ctx.input?.lane)),
    });
  } catch {
    return null; // legacy (Sonnet) also failed → adjudicator_unavailable → pass
  }
  if (gate.source === "jev") {
    return { verdict: gate.verdict, reason: `jev: ${gate.verdict === "drop" ? "memory shows it resolved" : "claims still hold"}` };
  }
  return gate.result || null;
}

// ─── Stage 3b: does the rewrite still say what the original said? ─────────
//
// See REWRITE_LIMITS for the incidents. Telling the adjudicator the limits is
// not enough on its own: it never sees the chat exchange, so it cannot know
// that a short "yes" answered a different question, or that the user's message a
// minute ago is newer than the email it is quoting. This check reads the
// original, the rewrite, the evidence and (on a chat reply) the exchange, and
// answers one fixed question, accept or reject.
//
// FAILING SAFE. A rejected rewrite, and one the check could not judge, both
// send the ORIGINAL. That is the outcome the gate already gives whenever its
// adjudicator is unavailable, so it adds no new failure class, and it never
// drops anything (a drop on a model failure would break fail-open, and would
// have silenced a true P1 ping). Shipping an unchecked
// rewrite instead would be the one thing measured to make a correct reply
// wrong. On the reply path the original is already on the user's screen, so "reject"
// simply means the in-place correction does not happen. Every rejection is
// logged with the text it refused (claim-freshness-log.jsonl, reasons
// rewrite_rejected:<kind> / rewrite_check_unavailable), and the refusal rate
// is counted (noteRewriteCheckOutcome), so a check that starts refusing
// nearly everything pages the system channel once instead of silently
// sending stale claims flat.
//
// WHO JUDGES. Jev first (Rule #0b, a fixed-answer decision), but only for a
// proactive message: a chat reply's check carries the exchange, the user's own
// words, which have never been sent to Jev and are not sent now, whatever
// privacy_exclusions says. Proactive messages keep the adjudicator's exclusions
// (private intents and lanes, the on-device screen when privacy is on).
export const REWRITE_CHECK_SITE = "claim-freshness-rewrite-check";
const REWRITE_CHECK_TIMEOUT_MS = Number(process.env.CLAIM_FRESHNESS_CHECK_TIMEOUT_MS) || 45000;
// Labels the checker picks from. Code reads the label (an enum the model
// chose), never its prose.
export const REWRITE_ACCEPT_KINDS = ["dated_or_removed", "corrected_from_timeline", `corrected_from_${OWNER_ID}`, "corrected_from_dated_row", `closed_by_${OWNER_ID}`];
export const REWRITE_REJECT_KINDS = ["added_claim", "added_question", "changed_open_questions", `contradicts_${OWNER_ID}`, "older_or_undated_source", "other_meaning_change"];

export const REWRITE_CHECK_PROMPT = ({ original, rewrite, reason, observedIso, nowIso, claimBlock, timelineBlock = null, conversation = "" }) => `You are the last check on Edva's release gate. The gate decided the message below could not go out exactly as written and produced a REWRITE. Rewrites have gone wrong before: they have marked a question answered before ${OWNER} answered it, replaced what they had just told Edva with an older email, added questions of their own, and "corrected" a true message from older mail. Decide only whether this rewrite stayed inside its limits. You are not judging whether the original was right.

${provenanceLine(observedIso, nowIso, "unknown")}

ORIGINAL:
"""
${String(original).slice(0, 3000)}
"""

REWRITE:
"""
${String(rewrite).slice(0, 3000)}
"""

WHY THE GATE REWROTE IT: ${String(reason || "(not given)").slice(0, 300)}
${conversation ? `
THE EXCHANGE THE ORIGINAL ANSWERS, oldest first. "${OWNER}:" lines are their own words from the last few minutes, and the original was written after reading them:
"""
${conversation}
"""
` : ""}
WHAT MEMORY SAID ABOUT EACH CLAIM:
${claimBlock}
${timelineBlock ? `
TRAVEL TIMELINE (live, authoritative; times are UTC, so convert to the local time of the place, minding any daylight-saving change on that date):
${timelineBlock}
` : ""}
Compare the two texts sentence by sentence. Every difference must be one of these:
  dated_or_removed — it says when or where a claim of the original was observed ("as of Wednesday's email, ..."), or removes or softens a claim, without changing what the claim says happened;
  corrected_from_timeline / corrected_from_${OWNER_ID} / corrected_from_dated_row — it replaces a value in a claim the original made (a date, a time, a count, a status, the items in a list, or how sure it is) with the value the travel timeline shows, that ${OWNER}'s own words in the exchange give, or that a memory row WITH A DATE shows (when the evidence is dated, the row must be from after it; when the evidence is undated, any dated row will do), and nothing ${OWNER} said later (in the exchange, or a reply of theirs dated after that row) says otherwise. Naming where the new value came from ("${EX.named_source}") and adjusting the words that only made sense with the old value (a question built on the old time) are part of the replacement, not additions;
  closed_by_${OWNER_ID} — it drops, or marks settled, a question the original asked them, and the exchange or a dated reply of theirs shows they themselves answered or dismissed THAT question.

Reject when the rewrite does any of these:
  added_claim — states a fact, warning or explanation the original did not make, beyond the dating or replacement above;
  added_question — asks them something the original did not ask, or adds a request;
  changed_open_questions — presents a question the original said was still open as answered or settled, drops a question the original asked them, or reopens one the original treated as settled, WITHOUT their own answer or dismissal of that very question in the exchange or a dated reply. An answer they gave to a different question does not count, and one answer settles one question: when the original already reads their reply as the answer to one question, the rewrite may not read the same reply as answering another as well;
  contradicts_${OWNER_ID} — overrides, doubts or reverses something they said in the exchange, something the original reports they just told Edva, or a reply of theirs dated after the row it relies on;
  older_or_undated_source — replaces a value using a memory row that has no date, or (when the evidence is dated) one older than the evidence;
  other_meaning_change — anything else that changes what the message means: who did what, what happens next, what Edva will do.

When in doubt, reject: the original is then sent exactly as written.

Reply with ONE LINE of compact JSON, no prose, no markdown fence:
{"verdict":"accept"|"reject","kind":"${[...REWRITE_ACCEPT_KINDS, ...REWRITE_REJECT_KINDS].join("|")}","reason":"<=140 chars, quote the sentence that decided it"}`;

async function sonnetRewriteCheck(ctx) {
  const out = await askSonnet(REWRITE_CHECK_PROMPT({
    original: ctx.body, rewrite: ctx.corrected, reason: ctx.reason,
    observedIso: ctx.observedIso, nowIso: ctx.nowIso, claimBlock: renderClaimBlock(ctx.rechecked),
    timelineBlock: ctx.timeline?.block || null, conversation: ctx.solicited ? ctx.conversation : "",
  }), REWRITE_CHECK_TIMEOUT_MS);
  const p = parseModelJson(out);
  if (!p || !["accept", "reject"].includes(p.verdict)) throw new Error("rewrite_check_unavailable");
  const kind = String(p.kind || "").slice(0, 40);
  // A rejecting label under "accept" is the model contradicting itself; the
  // change it named wins.
  const verdict = p.verdict === "accept" && REWRITE_REJECT_KINDS.includes(kind) ? "reject" : p.verdict;
  return { verdict, kind, reason: String(p.reason || "").slice(0, 200) };
}

// What Jev sees: the adjudicator's state (message, claims, memory rows,
// timeline) plus the rewrite. Never the chat exchange.
function jevRewriteState(ctx) {
  const { message, ...rest } = jevFreshnessState(ctx);
  return { original: message, rewrite: ctx.corrected.slice(0, 1500), why_rewritten: String(ctx.reason || "").slice(0, 300), ...rest };
}

/**
 * Resolves {verdict:"accept"|"reject"|null, kind, reason, source}. null =
 * nobody could judge it (the caller sends the original). Never throws.
 */
export async function checkRewrite(ctx) {
  let memo = null;
  const legacy = () => (memo ||= Promise.resolve().then(() => sonnetRewriteCheck(ctx)));
  try {
    const q = jevSiteDef(REWRITE_CHECK_SITE) || {};
    const r = await decide({
      site: REWRITE_CHECK_SITE,
      id: createHash("sha1").update(`${ctx.body}\n${ctx.corrected}`).digest("hex").slice(0, 12),
      state: fitState(jevRewriteState(ctx)),
      logInput: { text: ctx.body.slice(0, 300), rewrite: ctx.corrected.slice(0, 300), solicited: ctx.solicited },
      skipJev: ctx.solicited ? "solicited-exchange-excluded"
        : (privateIntent(ctx.input?.intent) || privateIntent(ctx.input?.subject, ctx.input?.lane)) || undefined,
      privacyScreen: true,
      interpret: (a) => {
        const choice = a?.verdict?.choice;
        if (choice !== "accept" && choice !== "reject") throw new Error("jev: verdict not accept/reject");
        return { value: choice, confidence: answerConfidence(a.verdict) };
      },
      legacy,
      // Own shadow week: Sonnet runs beside Jev until the question file's shadow_until.
      alwaysShadow: !!(q.shadow_until && Date.now() < Date.parse(q.shadow_until)),
      same: (j, l) => j === l?.verdict,
    });
    if (r.used !== "jev") return { ...r.value, source: "sonnet" };
    // The costly error here is a false accept, so while Sonnet still shadows,
    // its reject beats a Jev accept.
    if (r.value === "accept" && memo) {
      const sh = await memo.catch(() => null);
      if (sh?.verdict === "reject") return { ...sh, source: "sonnet-conservative" };
    }
    return { verdict: r.value, kind: null, reason: `jev: ${r.value}`, source: "jev" };
  } catch (e) {
    return { verdict: null, kind: null, reason: String(e?.message || e).slice(0, 200), source: "none" };
  }
}

// ─── The gate ─────────────────────────────────────────────────────────────

/**
 * Full check. Input mirrors claim-check's contract so the call sites stay thin:
 *
 *   {text, subject?, supporting_data?, created_at?, solicited?, evidence_as_of?, conversation?}
 *
 * `conversation` (solicited only): the chat exchange the reply answers, as
 * "<user's name>: …" / "Edva: …" lines, oldest first. It reaches the Stage-1
 * extractor and the Stage-3b rewrite check's Sonnet call, and nothing else:
 * not Jev, not the adjudicator, not memory.
 *
 * Returns {verdict:"pass"|"rewrite"|"drop", reasons[], corrected_text?, stage,
 *          claims[], age_ms, rewrite_check?}. Every failure path returns
 *          "pass" — the gate can decline to have an opinion, it can never take
 *          the channel down. A "rewrite" has passed the Stage-3b check.
 */
export async function checkFreshness(input = {}, { nowMs = Date.now(), noLlm = false, deadlineMs = null } = {}) {
  const body = String(input.text || "").trim();
  const solicited = input.solicited === true;
  const conversation = solicited ? String(input.conversation || "").slice(0, 2000) : "";
  const base = { claims: [], corrected_text: undefined };

  // A latency budget for the paths where the user is watching a cursor blink.
  // Checked BETWEEN stages rather than enforced with a hard kill, so the gate
  // always finishes the stage it is in and returns a coherent verdict; it just
  // declines to start another one. Proactive callers pass no deadline and let
  // it run — nobody is waiting on a hum ping.
  const startedMs = Date.now();
  const outOfTime = () => deadlineMs != null && Date.now() - startedMs >= deadlineMs;

  if (!body) return { verdict: "pass", reasons: ["empty_text"], stage: 0, age_ms: null, ...base };

  // Stage 0 — arithmetic. Free, and it retires the large majority of messages.
  const staleness = needsRecheck(input, nowMs);
  if (!staleness.stale) {
    return { verdict: "pass", reasons: [staleness.reason], stage: 0, age_ms: staleness.age_ms, ...base };
  }
  if (noLlm) {
    return { verdict: "pass", reasons: [`${staleness.reason}_unjudged`], stage: 0, age_ms: staleness.age_ms, ...base };
  }

  const nowIso = new Date(nowMs).toISOString();
  // The two quantities that used to be one. `observedIso` is a FACT about this
  // message — null when nothing dates it — and is the only one a model may see
  // as provenance. `mailboxWindowStart` stays a retrieval hint. See the note on
  // UNDATED_LOOKBACK_MS for what conflating them cost.
  const observedIso = staleness.as_of || null;
  const ageHours = staleness.age_ms == null ? "unknown" : Math.round(staleness.age_ms / 3.6e6);

  if (outOfTime()) {
    return { verdict: "pass", reasons: ["deadline_before_extract"], stage: 0, age_ms: staleness.age_ms, ...base };
  }

  // Stage 1 — language. What here could have moved?
  // A failure is still a pass (fail-open), but never an anonymous one: the log
  // row names the kind, and the rolling health counter decides whether the
  // system channel hears about it. "Extracted zero claims" is a SUCCESS and is
  // logged as such (extractor:"ok", claims_extracted:0) — the two used to be
  // indistinguishable to anyone reading the rate.
  let claims, extractError;
  try {
    ({ claims, error: extractError } = await extractStateClaimsDetailed({ text: body, as_of_iso: observedIso, now_iso: nowIso, age_hours: ageHours, conversation }));
  } catch (e) {
    claims = null;
    extractError = { kind: "exception", message: String(e?.message || e).slice(0, 200) };
  }
  const extractorHealthNow = noteExtractorOutcome(claims === null ? (extractError?.kind || "unknown") : "");

  if (claims === null) {
    const kind = extractError?.kind || "unknown";
    const out = { verdict: "pass", reasons: ["extractor_unavailable", `extractor_unavailable:${kind}`], stage: 1, age_ms: staleness.age_ms, ...base };
    log({
      gate: "claim-freshness", ...out, extractor: "failed",
      extractor_error: { kind, message: extractError?.message || "" },
      extractor_health: extractorHealthNow, text: body.slice(0, 200),
    });
    return out;
  }
  if (!claims.length) {
    const out = { verdict: "pass", reasons: ["no_mutable_claims"], stage: 1, age_ms: staleness.age_ms, ...base };
    log({ gate: "claim-freshness", ...out, extractor: "ok", claims_extracted: 0, extractor_health: extractorHealthNow, text: body.slice(0, 200) });
    return out;
  }

  // Out of time WITH mutable claims identified is the one place a deadline
  // changes the answer rather than just the cost: we know the message asserts
  // something that could have moved and we could not go check. On a solicited
  // reply that still sends — an answer late-and-hedged beats no answer — but it
  // is logged as unverified so the shortfall is visible in the gate's own log
  // rather than invisible in the chat.
  if (outOfTime()) {
    const out = {
      verdict: "pass", reasons: ["deadline_claims_unverified"], stage: 2,
      age_ms: staleness.age_ms, claims: claims.map((c) => ({ claim: c.claim, query: c.memory_query, reachable: false, hits: 0 })),
      corrected_text: undefined,
    };
    log({ gate: "claim-freshness", ...out, text: body.slice(0, 200) });
    return out;
  }

  // Stage 2 — authority. Re-read the source for each claim.
  // Concurrently — the searches are independent, and on the reply path the
  // difference between 4 sequential mailbox round-trips and 4 parallel ones is
  // most of the latency budget.
  const rechecked = await Promise.all(claims.map(async (c) => ({
    ...c,
    // null when undated — renderClaimBlock says so rather than inventing a date,
    // and recheckMemory then marks no row as "AFTER the evidence", because
    // without an observation time nothing can be known to postdate it.
    since: observedIso ? observedIso.slice(0, 10) : null,
    // Unconditional on purpose. This was a ternary guarded on a field that the
    // memory rewrite renamed, so it silently took the else branch every time and
    // the gate hedged for two runs without ever asking memory -- no error, since
    // the dead call was never reached. memory_query already falls back to the
    // claim itself, so there is no case where skipping is correct; removing the
    // branch removes the failure.
    search: await recheckMemory(c.memory_query, observedIso),
  })));

  // Stage 3 — adjudicate. Jev primary (docs/jev.md), the
  // Sonnet adjudicator as shadow + fallback. Jev answers pass / rewrite / drop
  // over the same claims and memory rows; it acts alone on pass and drop. It
  // cannot write the corrected text, so a Jev "rewrite" — and, on a SOLICITED
  // message where drop is unavailable, a Jev "drop" — takes Sonnet's verdict and
  // text. During the shadow week a Sonnet "drop" beats a Jev "pass". Health /
  // finance intents never reach Jev; everything else passes the fail-closed
  // on-device screen. Any Jev failure → exactly the old Sonnet adjudication.
  // Stage 2b — the travel timeline, read once, only for messages that reached here.
  const timeline = await readTravelTimeline(nowMs);
  const parsed = await adjudicate({ body, observedIso, nowIso, rechecked, solicited, input, timeline });

  const claimSummary = rechecked.map((r) => ({
    claim: r.claim,
    query: r.memory_query,
    reachable: r.search.ok,
    hits: r.search.hits.length,
    error: r.search.error || undefined,
  }));

  if (!parsed || !["pass", "rewrite", "drop"].includes(parsed.verdict)) {
    const out = {
      verdict: "pass", reasons: ["adjudicator_unavailable"], stage: 3,
      age_ms: staleness.age_ms, claims: claimSummary, corrected_text: undefined,
    };
    log({ gate: "claim-freshness", ...out, text: body.slice(0, 200) });
    return out;
  }

  let verdict = parsed.verdict;
  const corrected = String(parsed.corrected_text || "").trim();

  // A solicited message can never be dropped — see the header. Downgrade to the
  // rewrite the adjudicator was asked for; if it gave none, send as written.
  if (verdict === "drop" && solicited) verdict = corrected ? "rewrite" : "pass";
  // A rewrite with no replacement text is not a rewrite.
  if (verdict === "rewrite" && !corrected) verdict = "pass";
  // Nor is one that lost most of the message: a rewrite fixes a claim, it doesn't cut the reply.
  // (A 3.6k-char list once came back as its first 1,200 chars, cut mid-URL.)
  let reasonsExtra = [];
  if (verdict === "rewrite" && body.length > 600 && corrected.length < body.length * 0.5) {
    verdict = "pass"; reasonsExtra = [`rewrite_rejected_short:${corrected.length}/${body.length}`];
  }

  // Stage 3b — the rewrite is new text, so it is checked before it replaces
  // anything. Part of stage 3, so it runs even past a deadline: a rewrite
  // without its check is not a coherent verdict. Reject or no judgment → the
  // original, as written (see checkRewrite).
  let rewriteCheck;
  if (verdict === "rewrite") {
    rewriteCheck = await checkRewrite({ body, corrected, reason: parsed.reason, observedIso, nowIso, rechecked, solicited, input, timeline, conversation });
    rewriteCheck.health = noteRewriteCheckOutcome(rewriteCheck.verdict === "accept" ? ""
      : rewriteCheck.verdict === "reject" ? `rejected:${rewriteCheck.kind || "unspecified"}` : "unavailable");
    if (rewriteCheck.verdict !== "accept") {
      verdict = "pass";
      reasonsExtra.push(rewriteCheck.verdict === "reject" ? `rewrite_rejected:${rewriteCheck.kind || "unspecified"}` : "rewrite_check_unavailable");
    }
  }

  const out = {
    verdict,
    reasons: [String(parsed.reason || "adjudicated").slice(0, 200), ...reasonsExtra],
    stage: 3,
    age_ms: staleness.age_ms,
    as_of: observedIso,
    claims: claimSummary,
    // No length cap: the corrected text REPLACES the message in the chat, so a cap here cut every
    // long rewritten reply mid-word. The reply size limit
    // (reply-file.mjs, 64 KB) is the only bound.
    corrected_text: verdict === "rewrite" ? corrected.slice(0, 64 * 1024) : undefined,
    rewrite_check: rewriteCheck ? { verdict: rewriteCheck.verdict, kind: rewriteCheck.kind, reason: rewriteCheck.reason, source: rewriteCheck.source, health: rewriteCheck.health } : undefined,
  };
  // The refused text goes to the log only: it was never shown, and the weekly
  // review needs it to tell a good rejection from a lost correction.
  log({ gate: "claim-freshness", ...out, rejected_rewrite: rewriteCheck && verdict !== "rewrite" ? corrected.slice(0, 4000) : undefined, text: body.slice(0, 200) });
  return out;
}
