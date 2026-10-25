#!/usr/bin/env node
// outbound-precheck — gate every agent-originated message to the user through a
// Sonnet `--effort low` reasoner that sees the last 8h of phone-channel
// chat + active calendar before deciding to send.
//
// Modeled on bin/location-confirm-resolve.mjs. The motivating bug: a
// harvester asked "the planned time slid by — when do you want to do it?"
// although the user had told the agent minutes earlier that it was already
// under way. The programmatic harvester had no chat-context awareness. This script makes that
// awareness universal: any caller of edva-send-curl pipes its proposed
// message through here first, and a Sonnet subprocess answers send / suppress
// / modify based on recent conversation + calendar.
//
// Stdin: {message: string, intent?: string, supporting_data?: object}
// Stdout: {decision: "send"|"suppress"|"modify", message?: string, reason: string}
//
// Fail-open: any error path (Supabase down, Sonnet down, malformed reply)
// emits {decision: "send"} so the original send path proceeds: better an
// occasional dumb ping than an entire silent agent.
//
// Canonical pattern per agent/CLAUDE.md § Effort Policy: high-volume
// `claude -p` subagents that fork per-invocation pass `--model claude-sonnet-5-5
// --effort low` inline.

import { spawnSync, spawn } from "node:child_process";
import { runToollessDetailed, parseModelJson } from "../lib/jev-claude.mjs";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// OUTBOUND_PRECHECK_* overrides are test seams (tests/jev-outbound-precheck.test.mjs).
const GOG = process.env.OUTBOUND_PRECHECK_GOG_BIN || "/opt/homebrew/bin/gog";
const CLAUDE_BIN = process.env.OUTBOUND_PRECHECK_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
const ENV_FILE = process.env.OUTBOUND_PRECHECK_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const LOG_FILE = process.env.OUTBOUND_PRECHECK_LOG || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "outbound-precheck-log.jsonl");
const { instance, localConfig } = createRequire(import.meta.url)("../lib/instance.cjs");
const SUPABASE_URL = `https://${instance().supabase_project}.supabase.co`;
// Who the gate protects (agent/local/instance.json owner_name) and this
// installation's own examples in the prompt below
// (agent/local/config/outbound-precheck.json, key "prompt").
const OWNER = instance().owner_name;
const OWNER_UP = OWNER.toUpperCase();
// The Jev state key for the owner's own dated words: `<owner_id>_said`
// (user_said by default). The site's question text in
// data/jev-questions/outbound-precheck.json names it, so it follows owner_id.
const SAID_KEY = `${instance().owner_id}_said`;
// The installation's protected hum lanes (agent/local/config/hum-lanes.json
// protected_lanes; none by default): the default protected-pattern lines name them.
const PROTECTED_LANES = localConfig("hum-lanes", { protected_lanes: [] }).protected_lanes || [];
const PROMPT_DEFAULTS = {
  criterion_b_example: `memory says ${OWNER} is away all week but the message assumes ${OWNER} is home today`,
  shared_word_examples: `"home", "call", "calendar"`,
  criterion_e_tail: `DELEGATION: when the wiki says "Person X does Action Y as part of a documented sequence", suppress any ping proposing ${OWNER} coordinate with X about Y. This is not a contradiction — it is a delegation signal.`,
  same_lane_rule: `SAME LANE IS NOT SAME SUBJECT. Only hide the same exact factoid, not the same lane. This applies with extra force to informational/factoid pings (nearby history, trivia, local-color notes) — such a lane can fire repeatedly per day, each time about a different building, business, or fact near wherever ${OWNER} is. Two pings sharing a neighborhood or a category are NOT duplicates unless they are the SAME factoid about the SAME specific subject (same building, same business, same fact). "Already covered the neighborhood" or "already sent a factoid in this lane today" is never sufficient grounds to suppress — require the two pings to be substantively interchangeable (${OWNER} reading one would already know what the other says) before treating them as a dup.`,
  questions_new_angle_example: "",
  delegation_reason_example: `("wiki <page> says <person> does <step> — suppress")`,
  hook_examples: `("one flagged item worth a look", "1 thing I could not confirm")`,
  hook_affairs: "their money, their mail, their home, their calendar, their day, their people",
  memory_authority_topics: "people, travel, home, and job ownership",
  outside_reading_hook_example: `"Newsletter digest emailed — 5 today; the standout is a teardown of a new open-source database engine"`,
  asked_for_examples: `("fix this", "move this to the evening", "why is this…", "let's stop this email")`,
  protected_intents_heading: "PROTECTED INTENTS:",
  protected_playbook_example: "(a lane the hum playbook protects)",
  protected_inferred_examples: `inferred calendar overlap ("they're at X"), or inferred sentiment ("nagging is wrong" / "something else is planned")`,
  // One line per protected lane (an installation may write its own lines: the
  // two keys keep their historical names).
  protected_pattern_exercise: PROTECTED_LANES.map((l) => `  - hum:${l}:*`.padEnd(35) + `— a protected lane, ALL branches. Only suppress if ${OWNER} explicitly said to skip or stop it in the last 24h transcript.`).join("\n"),
  protected_pattern_health: "",
  protected_reason_example: "'protected: hum:<lane>:*'",
};
const P = { ...PROMPT_DEFAULTS, ...(localConfig("outbound-precheck", { prompt: {} }).prompt || {}) };

// UTC offset (ms) of `tz` at `ms` — e.g. -7h for Los Angeles in summer, -8h in winter.
function tzOffsetMs(tz, ms) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - (ms - (ms % 1000));
  } catch { return 0; }
}

// ─── Log attribution ────────────────────────────────────────────────────────
// Every row this file wrote to outbound-precheck-log.jsonl was exactly the
// object it hands back on stdout, because emit() wrote its argument to both
// places. Measured on the production log, last 300 rows: 298 carry no intent,
// 300 carry no sender (the field has never once been written), and 63 of the
// 300 are suppressions. So roughly one programmatic message in five is being
// killed, and the log cannot say which lane lost it. The playbook tells investigators to read this file before
// blaming a harvester, which is not possible while the field is blank. It was
// flagged six weeks running; earlier passes read it as
// callers failing to pass --intent, but the callers that DO pass one were not
// recorded either — emit() never looked at anything but its argument. (The two
// rows that do carry an intent come from a separate appender inside
// edva-send-curl, not from here.)
//
// Deliberately narrow: the stdout protocol is untouched and stays exactly
// {decision, message?, reason}, because callers parse it. Only the LOG row is
// widened, and only with values this process was already handed on stdin — no
// new inputs, no environment probing, nothing derived. A caller that passes no
// --intent still logs "unknown"; making those callers declare one is a
// separate job for a pre-commit lint, not for this file.
//
// (Also deliberately NOT here: deriving a sender from the process tree. It was
// tried and dropped — the immediate ancestor is always edva-send-curl, so it
// records a constant, and the message is in that ancestor's argv, which would
// put message text one parsing slip away from a log that CLAUDE.md
// § Financial Operations rule 5 forbids bank content from entering.)
//
// Filled in once stdin has been parsed. emit() can fire before that, on the two
// malformed-input paths; those rows simply carry no intent, which is honest —
// nothing was parsed, so nothing is claimed.
let logContext = {};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Attribution first, decision last: the decision object is authoritative
    // and wins any key collision.
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...logContext, ...obj }) + "\n");
  } catch {}
  if (relevanceStage) noteSonnetOutcome(relevanceFailKind);
  process.exit(0);
}

// ─── Relevance-check health: make "went out unchecked" visible ─────────────
//
// THE GAP. An unusable Sonnet answer sends the message out
// unchecked (fail-open) and the row said only
// "precheck_sonnet_no_json", Sonnet's answer thrown away — 10-20% of decisions
// in the weeks measured (many of them p1-email, which never reaches
// Jev). Same shape as claim-freshness's extractor health: fail-open
// stays; the row keeps the unusable answer's head (sonnet_head) and why a call
// came back empty (precheck_sonnet_unavailable:<kind>); a rolling window counts
// the rate; one silent ⚠️ system row per episode, a ✅ when it clears. Only the
// relevance stage counts, and a message Jev decided is checked whatever its
// shadow did. The kind is SET at each fail-open site (relevanceFailKind), never
// read back out of a reason, which can be Sonnet's own text. Two rarer paths
// still count as checked though nothing usable came back: a Sonnet "modify" whose
// message is empty or oversize (none seen in two weeks of rows), and a
// decision outside send/suppress/modify (coerced to send before anything is
// logged, so its frequency is not measurable here). 25/15, not 20/10:
// at a ~12% base rate 20/10 risks a noise row within a fortnight
// and <=10% rarely closes. Replayed over this log, 25/15 stays silent in a
// normal week and reports the bad stretch (26-36%).
const HEALTH_FILE = process.env.OUTBOUND_PRECHECK_HEALTH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", ".outbound-precheck-health.json"); // dotfile: gitignored by data/.*
const SEND_BIN = process.env.OUTBOUND_PRECHECK_SEND_BIN || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "edva-send-curl");
const HEALTH_WINDOW = 50;        // last N relevance decisions
const HEALTH_MIN_SAMPLE = 20;    // don't judge a rate off a handful
const HEALTH_ALERT_RATE = 0.25;  // >25% unchecked → one system-channel row
const HEALTH_RECOVER_RATE = 0.15; // hysteresis: recover only well below the line
const HEALTH_REPAGE_MS = 24 * 3600e3;   // a standing episode re-reports at most daily
let relevanceStage = false;              // set just before the relevance decision
let relevanceFailKind = "";              // "" = checked; set by the fail-open paths
let sonnetFailure = "";                  // the fail-open code sonnetDecision threw, if it did

// Our own fail-open codes (machine strings this file throws), never language:
// only ever called on an error message, never on a decision's reason.
function sonnetFailKind(code) {
  const r = String(code || "");
  if (r.includes("precheck_sonnet_no_json")) return "no_json";
  if (r.includes("precheck_sonnet_unavailable")) return "unavailable";
  if (r.includes("precheck_error")) return "error";
  return "";
}

function noteSonnetOutcome(kind) {
  try {
    let st = {};
    try { st = JSON.parse(readFileSync(HEALTH_FILE, "utf8")) || {}; } catch {}
    const win = Array.isArray(st.window) ? st.window : [];
    win.push(kind || "");
    while (win.length > HEALTH_WINDOW) win.shift();
    st.window = win;
    st.total = (st.total || 0) + 1;
    if (kind) {
      st.by_kind = st.by_kind || {};
      st.by_kind[kind] = (st.by_kind[kind] || 0) + 1;
      st.last_failure_at = new Date().toISOString();
    }
    const failures = win.filter((k) => k).length;
    const rate = failures / win.length;
    const now = Date.now();
    let page = null;
    if (win.length >= HEALTH_MIN_SAMPLE && rate > HEALTH_ALERT_RATE) {
      const last = st.alerted_at ? Date.parse(st.alerted_at) : 0;
      if (!last || now - last >= HEALTH_REPAGE_MS) { st.alerted_at = new Date(now).toISOString(); page = "down"; }
    } else if (st.alerted_at && rate <= HEALTH_RECOVER_RATE) {
      page = "up"; delete st.alerted_at;
    }
    mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    // Atomic: concurrent prechecks must never read a half-written window.
    const tmp = `${HEALTH_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, HEALTH_FILE);
    if (page === "down") {
      const kinds = {};
      for (const k of win) if (k) kinds[k] = (kinds[k] || 0) + 1;
      const kindStr = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
      sendSystem(`⚠️ Relevance check partly blind: the outbound precheck got no usable answer for ${failures} of the last ${win.length} messages (${Math.round(rate * 100)}%; ${kindStr}). Those went out unchecked (it fails open, so nothing was dropped). Where Sonnet answered something unusable, its first 200 characters are kept per row in data/outbound-precheck-log.jsonl (sonnet_head); an empty answer logs why (precheck_sonnet_unavailable:<kind>).`);
    } else if (page === "up") {
      sendSystem(`✅ Relevance check seeing again: outbound precheck failures down to ${failures} of the last ${win.length} messages (${Math.round(rate * 100)}%).`);
    }
  } catch {}
}

// The precheck reporting its own degraded check: system channel, never through
// itself (agent/CLAUDE.md § Outbound Precheck, class 5). ⚠️ = silent row;
// system-alert-dedup collapses daily repeats, the ✅ clears it (same --intent).
// No outage claim or error mechanism: send-path gates pass it (sonnet-health test).
function sendSystem(msg) {
  if (process.env.OUTBOUND_PRECHECK_NO_ALERT) return;
  try {
    const child = spawn(SEND_BIN, ["--channel", "system", "--skip-precheck", "--intent", "precheck-health", msg], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

function readSupabaseKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const txt = readFileSync(ENV_FILE, "utf8");
    const m = txt.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let input;
try { input = JSON.parse(raw); } catch { emit({ decision: "send", reason: "precheck_invalid_input" }); }
if (!input || typeof input !== "object" || typeof input.message !== "string" || !input.message.trim()) {
  emit({ decision: "send", reason: "precheck_empty_input" });
}

const proposedMessage = input.message.trim();
const intent = (input.intent || "unknown").toString().slice(0, 80);
// Sender/agent label. Identifies which caller is gating
// the message so the reasoner can apply origin-aware heuristics:
//   - "ops"     — ops-agent autonomous push (harvester, digest, cron job).
//                 Default for edva-send-curl since nearly all programmatic
//                 callers are ops-side.
//   - "chat"    — chat-agent invoked edva-send-curl (rare; chat-agent
//                 normally uses mcp__phone-channel__reply, which bypasses
//                 precheck by design).
//   - "infra"   — supervisor/watchdog/process-manager liveness alerts.
//                 These already pass --skip-precheck so they shouldn't reach
//                 here; if they do, treat as send-default.
//   - anything else — accepted verbatim, surfaced to the reasoner as
//                     "sender_label". Truncated to 24 chars to bound prompt size.
const senderLabel = (input.agent || input.sender || "ops").toString().slice(0, 24).toLowerCase();

// Attribution for every log row emitted from here on (see § Log attribution).
logContext = { intent, sender: senderLabel };
const supportingData = input.supporting_data || null;

// ─── Fetch last 8h of phone-channel messages (BOTH roles) ─────────────────
// 8h covers the common case where the user answered a question (e.g. "already
// done") and the same question fires again after a quiet-window
// drain. 90 min was too short for that pattern, and 4h let a duplicate ping
// through when the first had gone out five hours before the second.
//
// SCOPED TO THE CHAT CHANNEL (from a Jev disagreement).
// edva_messages holds three channels and this query had no channel filter,
// so every `🔧` Improvements approval card and every `⚠️`/`🔀` system alert
// arrived below labelled "Phone-channel transcript" — i.e. as something
// Edva had said to the user in chat. It had not. Those are separate channels
// the user has to switch to in the app's top-bar menu, and edva-send-curl exempts
// both from this very gate (§ Outbound Precheck classes 5 and 6), so the gate
// was reading back, as evidence, traffic it had already been told is not its
// business.
//
// The pollution is one-directional and therefore only ever produces FALSE
// DUPLICATES: almost all non-chat rows are role=assistant,
// so it inflates "what the user has already been told" and adds almost nothing to
// "what the user said". It did exactly that: a report pointer was suppressed as
// a duplicate of two Improvements cards filed minutes earlier — a channel the
// user had not opened, about an email the cards do not contain. Jev had it right
// at 0.86 and lost it to the 0.92 bar; on the chat-only transcript the same row
// scores 0.99.
//
// It also crowded the budget, which is the larger harm. In that decision's own
// state 14 of the 30 transcript rows were machine chatter, leaving 16 of the
// window's 28 real chat messages — and fitState() drops transcript rows
// oldest-first, so the noise evicts precisely the context the gate exists to
// read. Measured: a verbatim re-send of a chat ping already in the window
// scored send 0.67-0.72 on the polluted transcript (the duplicate MISSED) and
// suppress 0.70-0.75 on the chat-only one. Removing rows here makes duplicate
// detection strictly better, not worse.
//
// Deliberately a blunt channel filter rather than "chat OR role=user". The user
// does occasionally type into the system channel when replying to an infra alert,
// and keeping those was tried first — measured, it moved a
// should-suppress case from suppress 0.66 to send 0.52, so it did not earn its
// place. The residual exposure is small and bounded: in every observed case
// Edva's chat-channel answer immediately followed and carries the substance.
// Revisit with a real disagreement, not a hypothesis.
let recentMessages = [];
const sbKey = readSupabaseKey();
if (sbKey) {
  try {
    const since = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const qs = new URLSearchParams({
      select: "role,content,created_at",
      "created_at": `gt.${since}`,
      channel: "eq.chat",
      order: "created_at.desc",
      limit: "60",
    });
    const url = `${SUPABASE_URL}/rest/v1/edva_messages?${qs}`;
    const resp = await fetch(url, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const rows = await resp.json();
      recentMessages = (rows || [])
        .filter(r => typeof r.content === "string" && r.content.length > 0)
        .reverse()
        .map(r => ({ role: r.role, body: r.content.slice(0, 500), at: r.created_at }));
    }
  } catch {}
}

// ─── Fetch calendar: now-2h → the end of the user's current local day ──────
//
// Was a flat ±2h either side of now. That window makes the gate
// blind in exactly the case it is most needed: a ping fired in the MORNING about
// something happening TONIGHT saw an empty calendar, so neither the Jev gate nor
// the Sonnet prompt could know the evening was already booked (a Jev
// disagreement: an "event tonight" suggestion went out against a fully booked
// evening; only an unrelated chat message happened to mention the plan).
//
// End of day is 02:00 local tomorrow, so an evening that runs past midnight is covered.
// Floored at now+2h so a late-night call never gets a SHORTER window than before.
const now = new Date();
const calFrom = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
const localNow = new Date(now.toLocaleString("en-US", { timeZone: instance().tz }));
const localDayEnd = new Date(localNow); localDayEnd.setHours(26, 0, 0, 0); // 02:00 local tomorrow
const msLeftInDay = localDayEnd.getTime() - localNow.getTime();            // offset-safe: a delta, not a reconstructed instant
const calTo = new Date(Math.max(now.getTime() + msLeftInDay, now.getTime() + 2 * 60 * 60 * 1000)).toISOString();
let calendarEvents = [];
try {
  const res = spawnSync(GOG, [
    "calendar", "list", "--json", "--results-only",
    "--from", calFrom, "--to", calTo, "--all",
  ], { encoding: "utf8", timeout: 8000 });
  if (res.status === 0 && res.stdout) {
    const parsed = JSON.parse(res.stdout);
    if (Array.isArray(parsed)) {
      calendarEvents = parsed
        .filter(e => (e.transparency || "opaque") !== "transparent")
        .map(e => ({
          summary: e.summary || "",
          location: e.location || "",
          start: e.start?.dateTime || e.start?.date || "",
          end:   e.end?.dateTime   || e.end?.date   || "",
        }));
    }
  }
} catch {}

// ─── Wiki memory lookup ───────────────────────────────────────────────────
// Two-pass wiki search so the reasoner has memory context before deciding:
//
// Pass 1 — topic keywords: extracted from intent + message text. Catches job-
//   ownership rules, household plans, scheduling constraints.
//
// Pass 2 — travel-status check: originally a fixed who-is-where wiki search,
//   added because a ping contradicted a who-travels-with-whom page that the
//   pass-1 keywords never matched. Replaced by the travel timeline (see below).
//
// Fail-open: any error leaves wikiContext empty; precheck still runs.
const WIKI_BIN = process.env.OUTBOUND_PRECHECK_WIKI_BIN || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "wiki");
let wikiContext = "";
try {
  const STOPWORDS = new Set([
    "the","a","an","is","are","was","were","be","been","being","have","has","had",
    "does","did","will","would","could","should","may","might","just","very","it",
    "its","he","she","they","we","you","me","him","her","them","us","this","that",
    "these","those","what","which","who","when","where","why","how","with","about",
    "from","into","through","before","after","for","and","but","or","not","so","at",
    "by","on","in","of","to","up","any","all","each","every","also","then","than",
    "over","both","more","some","only","now","still","even","such","new","our",
    "your","their","here","there","make","take","want","need","like","know","think",
    "going","doing","mine","hers","ours","lets",
  ]);
  const rawWords = (intent.replace(/[-_:]/g, " ") + " " + proposedMessage.slice(0, 300))
    .toLowerCase()
    .match(/\b[a-z]{4,}\b/g) || [];
  const keywords = [...new Set(rawWords)].filter(w => !STOPWORDS.has(w)).slice(0, 4);

  const wikiParts = [];

  // Pass 1: topic keywords
  if (keywords.length >= 2) {
    const r1 = spawnSync(WIKI_BIN, ["search", keywords.join(" "), "--limit", "3"], {
      encoding: "utf8", timeout: 8000,
    });
    if (r1.status === 0 && r1.stdout.trim() && !r1.stdout.trim().startsWith("(no matches)")) {
      wikiParts.push(r1.stdout.trim());
    }
  }

  // Pass 2 used to be a fixed `wiki search` for who-is-where — a
  // LEXICAL search of PROSE pages. That is the wrong source
  // twice over: a travel-schedule page is a rendered view that lags the
  // timeline (a display lag the user noticed), and a
  // bag-of-words search can't retrieve a contradiction that shares no words
  // with the message. Presence now comes from the authority (the travel
  // timeline, via claim-facts below), not from a page about presence.

  // Pass 3: direct page read when the idea carries a wiki_scope field.
  // An idea's wiki_scope page can document exactly the plan the ping is about
  // (e.g. who does which step of a multi-step plan) while sharing no keywords
  // with it. The keyword pass missed such a page; a direct read surfaces it.
  const wikiScope = supportingData?.wiki_scope;
  if (wikiScope && typeof wikiScope === "string") {
    const scopeId = wikiScope.slice(0, 80).replace(/[^a-z0-9_-]/gi, "");
    if (scopeId) {
      const r3 = spawnSync(WIKI_BIN, ["read", scopeId], {
        encoding: "utf8", timeout: 10000,
      });
      if (r3.status === 0 && r3.stdout.trim() && !r3.stdout.trim().startsWith("(no page")) {
        wikiParts.push(`PROJECT WIKI PAGE (${scopeId}):\n${r3.stdout.trim().slice(0, 2000)}`);
      }
    }
  }

  if (wikiParts.length > 0) {
    wikiContext = wikiParts.join("\n\n").slice(0, 4000);
  }
} catch {}

// ─── Read hum-resolved-topics.jsonl ─────────────────────────────────────
// Topics the user acknowledged via phone reply within last 48h. If the
// incoming message is about one of these, suppress without asking Sonnet.
const RESOLVED_TOPICS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "hum-resolved-topics.jsonl");
let resolvedTopicsText = "";
try {
  const resolvedLines = readFileSync(RESOLVED_TOPICS_FILE, "utf8").split("\n").filter(Boolean);
  const now48 = Date.now();
  const active = resolvedLines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.suppress_until && new Date(r.suppress_until).getTime() > now48);
  if (active.length > 0) {
    resolvedTopicsText = active.map(r =>
      `  - "${r.topic || (r.keywords || []).join(" ")}" (suppress until ${(r.suppress_until || "").slice(0, 16)})${r.resolution ? ` — reply was: "${r.resolution.slice(0, 60)}"` : ""}`
    ).join("\n");
  }
} catch {}

// ─── Read today's hum ping history from hum-feedback.jsonl ──────────────
// Provides a same-day ping log independent of the chat transcript window.
// The transcript lookback (8h) can still miss pings from earlier in the day
// (e.g., a 9am ping is outside the 8h window at 6pm). This check covers the
// full calendar day (local midnight to now) so same-topic pings fired any time
// today are surfaced to the reasoner (a same-topic double-ping five hours
// apart once slipped past the then-4h window).
const HUM_FEEDBACK_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "hum-feedback.jsonl");
const HUM_IDEAS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "hum-ideas.jsonl");
let sameDayPingsText = "";
// Resolved {dedupKey, subject, reaction, pingId} for today's pings — kept in
// scope (not just the prompt-text block) so the deterministic settled-subject
// short-circuit below can match against it directly.
let todayPingsResolved = [];
try {
  // Local midnight for "today", in the instance's zone (lib/instance.cjs tz)
  const nowMs = Date.now();
  const zoneOffset = tzOffsetMs(instance().tz, nowMs);
  const localNow = new Date(nowMs + zoneOffset);
  const localMidnight = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - zoneOffset);

  const fbLines = readFileSync(HUM_FEEDBACK_FILE, "utf8").split("\n").filter(Boolean);
  const todayPings = fbLines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    // Rows carry the send timestamp as `sent_at` (nearly all current rows);
    // only a few legacy rows have `ts`. Checking `r.ts` alone (the prior code)
    // matched almost nothing, so this "today's pings" context was silently
    // empty for nearly every precheck call — part of the same gap as the
    // dedup_key fix below (a hum-review improvement).
    .filter(r => r && r.ping_id && (r.sent_at || r.ts) && new Date(r.sent_at || r.ts).getTime() >= localMidnight.getTime());

  if (todayPings.length > 0) {
    // Build a lookup of idea subjects from hum-ideas.jsonl
    const ideaSubjects = {};
    try {
      const ideaLines = readFileSync(HUM_IDEAS_FILE, "utf8").split("\n").filter(Boolean);
      for (const line of ideaLines) {
        try {
          const idea = JSON.parse(line);
          if (idea.id && idea.subject) ideaSubjects[idea.id] = idea.subject;
        } catch {}
      }
    } catch {}

    // dedup_key lives on the headline finding (findings[0].dedup_key), never
    // on the row itself — reading `p.dedup_key` directly (the prior code)
    // was always undefined, so every summary line rendered its subject as ""
    // and Sonnet never actually saw what each same-day ping was ABOUT, only
    // its lane and timestamp. Fixed as part of a hum-review improvement
    // (reinforcing the today_chat-settled-subject gate — this silently-blank
    // context was a real gap in it).
    todayPingsResolved = todayPings.map(p => {
      const dedupKey = (Array.isArray(p.findings) && p.findings[0] && p.findings[0].dedup_key) || null;
      const subject = (dedupKey && ideaSubjects[dedupKey]) || dedupKey || "";
      return { dedupKey, subject, reaction: p.reaction || null, pingId: p.ping_id, ts: p.sent_at || p.ts, lane: p.lane || null };
    });

    const pingSummaries = todayPingsResolved.map(p => {
      const reaction = p.reaction ? ` [reaction: ${p.reaction}]` : " [no reaction]";
      return `  - ${(p.ts || "").slice(0, 16)} ping_id=${p.pingId} lane=${p.lane || "?"}: "${p.subject.slice(0, 80)}"${reaction}`;
    });
    sameDayPingsText = pingSummaries.join("\n");
  }
} catch {}

// ─── Deterministic same-day settled-subject short-circuit ────────────────
// Reinforces the today_chat-settled-subject gate (a hum-improvement
// review finding) for the one case that doesn't
// need Sonnet's judgment at all: the SAME subject already pinged today AND
// already reacted to. hum-ping forwards the winning candidate's subject as
// the trailing segment of --intent when the harvester didn't set a branch
// (format "hum:<lane>:<branch-or-subject>" — see jobs/hum.md; the `ideas`
// lane never sets branch, so this reliably carries the idea's subject
// slug). An exact subject match is unambiguous — it's the identical
// question/plan, not a related one — so this can only narrow toward an
// outcome Sonnet would already reach via reasoning, never suppress something new.
try {
  const intentMatch = /^hum:[^:]+:(.+)$/.exec(intent);
  const intentSubject = intentMatch ? intentMatch[1] : null;
  if (intentSubject) {
    const settled = todayPingsResolved.find(p => p.subject === intentSubject && p.reaction);
    if (settled) {
      emit({
        decision: "suppress",
        reason: `deterministic settled-subject gate: "${intentSubject}" already pinged + reacted today (${settled.pingId}, reaction=${settled.reaction})`,
      });
    }
  }
} catch {}

// ─── Authoritative claim facts + the user's own dated words ──────────────
//
// Two additions that close the gaps this gate had:
//
//   1. FACTS. Every place/date the message names, checked against the live
//      travel timeline (lib/claim-facts.mjs). A `hard` contradiction —
//      the message ASSERTS the user is somewhere the timeline refutes — is
//      suppressed right here, deterministically, without asking Sonnet (a
//      ping asserting a place the timeline refutes is wrong however it is
//      worded).
//
//   2. THE USER'S WORDS. The gate previously saw 8h of chat and 48h of
//      resolved-topics. A reply from three days ago — "already handled",
//      "don't re-ask" — was invisible. utterance-store makes every reply
//      permanently searchable, dated and attributed.
let claimFactsText = "";
try {
  const { loadTimeline, checkClaims } = await import("../lib/claim-facts.mjs");
  const timeline = await loadTimeline();
  if (timeline) {
    const { facts, contradictions } = checkClaims(
      { text: proposedMessage, supporting_data: supportingData },
      timeline,
    );
    const hard = contradictions.find(c => c.severity === "hard");
    if (hard) {
      emit({
        decision: "suppress",
        reason: `authority contradiction: ${hard.why}`.slice(0, 200),
      });
    }
    if (facts.length) {
      // Lead with the CANONICAL METRO, not the segment's display label.
      //
      // `f.in` is computed in claim-facts.mjs as `res.metro === wantMetro` —
      // metro against metro. The rendering here used to print `actual_label`
      // alone, which is a free-text label off the segment and is frequently
      // NOT the city the user is in (a stay can be labelled with its arrival
      // airport), so a stay in the right metro could render as:
      //
      //   - On <date>, <user> is in <airport town>. Message mentions "<neighbourhood>" — match: YES.
      //
      // Sonnet read the prose, disbelieved the verdict sitting next to it, and
      // suppressed true, local, time-critical messages. The deterministic
      // layer was right every time; only the sentence was misleading.
      //
      // So: the metro is the comparison key, so the metro leads. The label is
      // kept (it is genuinely useful when it names a neighbourhood or hotel)
      // but demoted to a parenthetical and explicitly marked as not the key.
      claimFactsText = facts.map(f => {
        const metro = f.actual_metro || f.actual_label;
        const where = (f.actual_label && f.actual_label !== f.actual_metro)
          ? `${metro} (segment label: "${f.actual_label}" — display text, not the comparison key)`
          : `${metro}`;
        return `  - On ${f.on}, ${OWNER} is in metro ${where} [travel timeline]. Message mentions "${f.place}" — SAME METRO: ${f.in ? "YES" : "NO"}.`;
      }).join("\n");
    }
  }
} catch {}

// ─── Is it still TRUE? (freshness — lib/claim-freshness.mjs) ───────
//
// Everything above this line asks whether the message should be SAID: is it a
// duplicate, was it settled, does it contradict the transcript, is the user actually
// in that city. Nothing asked whether its premise still HOLDS: a reservoir idea
// can assert a third party's status that was true when written days earlier
// and has since changed. The rule: every message into the chat must be both
// relevant and true, and truth is a property of the send instant.
//
// So: if the message rides evidence older than STALE_AFTER_MS (or evidence
// nobody dated), the gate re-reads the source of record for the specific
// stateful claims it makes. Resolved since → suppress. Moved, or unconfirmable
// → the message must carry its vintage rather than assert flatly, which arrives
// here as a "modify". Free when the evidence is live or nothing is mutable.
//
// Callers that composed the message from work they just did should pass
// `evidence_as_of: "live"` in supporting_data; that exits at stage 0 for free.
let workingMessage = proposedMessage;
let freshnessModified = false;
try {
  const { checkFreshness } = await import("../lib/claim-freshness.mjs");
  const fresh = await checkFreshness({
    text: proposedMessage,
    subject: intent,
    supporting_data: supportingData,
    created_at: input.created_at || null,
    evidence_as_of: input.evidence_as_of || null,
    // A edva-send-curl push is proactive by definition — the user did not ask
    // for it — so "drop" is available here. The chat reply path, where the user IS
    // waiting for an answer, passes solicited:true and loses that power.
    solicited: input.solicited === true,
  });
  if (fresh.verdict === "drop") {
    emit({
      decision: "suppress",
      reason: `stale premise: ${fresh.reasons?.[0] || "resolved since it was written"}`.slice(0, 200),
    });
  }
  if (fresh.verdict === "rewrite" && fresh.corrected_text) {
    workingMessage = fresh.corrected_text;
    freshnessModified = true;
  }
} catch {}

let utterancesText = "";
try {
  const { searchUtterances } = await import("../lib/utterance-store.mjs");
  const hits = searchUtterances(`${intent} ${workingMessage}`.slice(0, 400), { k: 6 });
  if (hits.length) utterancesText = hits.map(u => `  - ${u.rendered}`).join("\n");
} catch {}

// ─── Build prompt ────────────────────────────────────────────────────────
const msgBlock = recentMessages.length === 0
  ? "(no phone-channel messages in the last 8h)"
  : recentMessages.map(m => `- [${m.at}] ${m.role}: ${m.body}`).join("\n");

const calBlock = calendarEvents.length === 0
  ? "(no calendar events overlapping ±2h)"
  : calendarEvents.map(e => `- "${e.summary}" @ "${e.location || "no location"}"  [${e.start} → ${e.end}]`).join("\n");

const supportingBlock = supportingData
  ? `\nSupporting data from sender:\n${JSON.stringify(supportingData).slice(0, 800)}\n`
  : "";

const wikiBlock = wikiContext
  ? `\nLong-term memory (wiki pages matching message topic — check for contradictions AND for actions already delegated/documented):\n${wikiContext}\n`
  : "";

const resolvedTopicsBlock = resolvedTopicsText
  ? `\nTopics ${OWNER} already acknowledged in the last 48h (DO NOT re-surface these):\n${resolvedTopicsText}\n`
  : "";

const sameDayPingsBlock = sameDayPingsText
  ? `\nHum pings already sent TODAY (same-day dedup — suppress if this message covers the same topic as any of these, even if ${OWNER} hasn't reacted yet):\n${sameDayPingsText}\n`
  : "";

const claimFactsBlock = claimFactsText
  ? `\nAUTHORITATIVE FACTS (Edva's live travel timeline — GROUND TRUTH, outranks the message's wording and outranks any wiki page, which can lag).\nEach line was resolved by code against the timeline. "SAME METRO: YES" is the verdict and it is ALREADY CORRECT — trust it over your own reading of the place names, and do NOT suppress a message for a location mismatch when it says YES. A neighbourhood, borough, airport or suburb of the same metro reads YES by design:\n${claimFactsText}\n`
  : "";

const utterancesBlock = utterancesText
  ? `\nWHAT ${OWNER_UP} SAID (dated, verbatim, from the full reply log — not just the last 48h):\n${utterancesText}\nIf one of these already answers or settles what this message raises, SUPPRESS. Re-asking something they already answered is the failure mode they complain about most.\n`
  : "";

// ─── The self-narration rule in the prompt below ──────────────────────────
//
// Filed by jev-disagreement-review AGAINST THIS (LEGACY) MECHANISM rather than
// against Jev: several job-delivery announcements in a few days where Jev
// suppressed correctly and this prompt sent. Some reached the user's chat,
// because Jev sat under the 0.92 bar and this prompt decided.
//
// Measured cause: criteria (a)–(e) are about CONTRADICTION and DUPLICATION only.
// A hook-free delivery announcement contradicts nothing and duplicates nothing,
// so Sonnet passed each one as "standard job output" / "informational
// meta-summary is fine to send". Jev's question file already carried the rule
// (its third through sixth clauses, each measured against controls);
// the paragraphs below are that rule ported here.
//
// THE TWO RESCUES ARE SPLIT OUT AND DECLARED CO-EQUAL DELIBERATELY. In the Jev
// question they are a trailing clause of one criterion and hold there; ported in
// that shape they did NOT hold on Sonnet. Measured, before filing:
//   v1 (rescues trailing, as in the Jev file) — two messages that each ended
//      in a direct ask ("want me to file an improvement for it?", "needs your
//      eyes — see email") were suppressed, reasoned "no hook or ask about the
//      user's own affairs": Sonnet fused the hook's own-affairs scope onto the ask.
//   v2 (ask stated first as a precondition) — both asks fixed 2/2, but an
//      outside-reading hook (a notable article from a newsletter) was suppressed
//      1/2, reasoned "external hook not ask": leading with the ask demoted the
//      hook to a lesser rescue.
// Hence the current shape: one sentence declaring both sufficient and unranked,
// then each in its own paragraph. If this is ever edited, re-measure those three
// messages first — a wrongly suppressed ASK or outside-reading hook is the
// expensive error here, and this rule keeps re-introducing it.
//
// THE "ASKED FOR / WILL NOTICE" PARAGRAPH is the half of
// agent/CLAUDE.md's rule the first port left out: repair stories go to
// Improvements "unless the user asked for it, or can observe the difference".
// Filed by jev-disagreement-review against THIS mechanism after the same error
// three times, each a result the user had asked for (in chat minutes earlier,
// on the System tab, or by email reply), suppressed as "a run report on
// Edva's own plumbing". Jev's question already carries the
// first half. It is a separate paragraph, not a
// third rescue inside "EITHER OF TWO THINGS", so the co-equal ask/hook shape
// above is untouched.
//
// Why port it at all: Jev acts on only ~25% of this site's decisions at a 0.92
// threshold (jev-shadow-report, 7d). The other ~75% are
// decided by this prompt, and after the shadow window closes it still decides
// the whole sub-threshold band.
const prompt = `You are the outbound gate for ${OWNER}'s personal agent ("Edva"). A programmatic job is about to push a message to ${OWNER}'s phone. Your job is to decide whether the message should go through, be suppressed, or be modified.

Default to "send". Suppress when ANY of these apply:
(a) The recent phone-channel transcript shows the message is wrong, redundant, or rude — e.g., it asks them to do something they just said they're doing; it nags about a slot they explained they're skipping; it contradicts something they just told the agent.
(b) The long-term memory context reveals a direct factual contradiction — e.g., ${P.criterion_b_example}; memory says a specific job (hum harvester) owns a topic but the message sends an ad-hoc nudge on that same topic.
(c) The "Topics ${OWNER} already acknowledged" list above includes this topic or a very similar one — ${OWNER} replied to a ping about it within the last 48h; sending again is noise.
(d) The project wiki (shown in long-term memory) documents that the proposed action is already delegated or part of a planned sequence owned by someone else.
(e) The "Hum pings already sent TODAY" list above contains a ping on the same topic as this message — even if ${OWNER} hasn't reacted yet. Duplicate hum pings on the same topic within the same day are always noise. Match on the SAME SUBJECT — the specific plan/fact/question this ping is about (its dedup_key / subject), NOT on shared entity words. A shared person, pet, place, or generic verb (e.g. ${P.shared_word_examples}) is NOT a match by itself: two pings that merely mention the same person or place while addressing DIFFERENT subjects are NOT duplicates. Require the CORE subject to line up (same plan, same fact, same question), not ≥3 incidental keywords. When unsure whether the subjects are truly the same, SEND — a rare same-day near-duplicate is far cheaper than silently dropping a distinct signal or a question. ${P.criterion_e_tail}

${P.same_lane_rule}

The long-term memory context is the authoritative source for facts about ${P.memory_authority_topics} — even when the phone transcript is silent.

QUESTIONS ARE FIRST-CLASS (2026-07-19 false-suppression fix). If the proposed message is a QUESTION to ${OWNER} (asks a preference, verifies a premise, captures their intent — typically phrased with "?"), its whole purpose is to grow memory. Do NOT suppress a question under criterion (c) or (e) merely because it shares a person/pet/place/topic word with an earlier info ping or a resolved topic. Only suppress a question if the SAME question — the same subject being asked — was already asked today (same-day pings) or was explicitly answered/settled (resolved-topics or transcript). A question about a genuinely NEW angle on a familiar subject${P.questions_new_angle_example} MUST send.

REPORTING ON EDVA'S OWN STATE IS NOT NEWS (2026-09-27). A message whose only NEW content is EDVA'S OWN INTERNAL STATE, and which asks ${OWNER} for nothing and tells them nothing from inside the email, is a SUPPRESS — it belongs in the Improvements channel, not their chat (agent/CLAUDE.md: "Chat is the channel for things about ${OWNER}'s life; a repair story is about Edva's"; and the Long-form delivery rule: a pointer carries the standout fact or is not sent at all). This is not criterion (a)–(e) territory — such a message contradicts nothing and duplicates nothing, which is exactly why it keeps slipping through. Two shapes carry it. One is a DIGEST POINTER reporting only delivery mechanics: "<job> emailed", "N newsletter(s)/item(s)", "labeled p1", "starred in your inbox" — nothing the push notification did not already say. The other is a RUN REPORT on Edva's own plumbing: how many pings went out, how many went unreacted, which lane was busiest, which gate misfired or dropped something, that a job fired on schedule, why a bug happened. Suppressing either costs them nothing — the email itself and its APNs push are separate commands in the same job and are untouched.

EITHER OF TWO THINGS TAKES A MESSAGE OUT OF THIS PARAGRAPH ALTOGETHER, AND EACH ONE IS SUFFICIENT BY ITSELF — AN ASK, OR A HOOK. Check for both before you suppress anything under this paragraph; if either is present, the message SENDS. They are not ranked and neither requires the other.

THE ASK. Does the message put ANYTHING to them — to answer, decide, label, confirm, or simply LOOK AT? "needs your eyes", "see email", "details in your inbox", "reply to label", "want me to", or any question at all, however small, counts. If so the message SENDS, even when everything else in it is Edva's own plumbing, even when it offers no hook whatsoever, and even when it says nothing beyond the fact that a job produced something. An ask does NOT additionally have to be about their own affairs. A run report ending "the situation gate misfired twice today — want me to file an improvement for it?" SENDS, because they were asked something.

THE HOOK — equally sufficient, and it does NOT need an ask alongside it. A pointer whose whole merit is naming the one thing worth opening the email for SENDS. A hook is one substantive finding, number or decision from INSIDE the email — the thing that would make them open it now rather than later. Most often it is their own affairs: ${P.hook_affairs}, something they can act on or that changes what they believe about their own life ${P.hook_examples}. But an email whose whole content is OUTSIDE READING they asked to be kept across — a newsletter digest, a press or research roundup, an event or listings scan — hooks on its standout ITEM, and that is a full hook even though the subject is the world rather than them: ${P.outside_reading_hook_example} SENDS, because naming which piece is worth their time is exactly the judgement they wanted from the digest. What is NOT a hook: a bare COUNT of items, and a detail about EDVA ITSELF however specific — which gate misfired, how long something took to resolve, how many pings went unreacted, what a job got wrong. That IS the run-report shape told at greater length; narrating it in more detail never promotes it to a hook. This paragraph never applies to a PROTECTED INTENT (listed below), and when you are unsure whether the message's new content is really about Edva rather than about them, SEND.

A RESULT THEY ASKED FOR, OR A CHANGE THEY WILL NOTICE, IS NOT THIS PARAGRAPH'S MESSAGE AT ALL (2026-10-07). agent/CLAUDE.md sends repair stories to Improvements "unless ${OWNER} asked for it, or they can observe the difference", and both halves apply here. FIRST: if the transcript shows ${OWNER} asking for this very change or raising this very problem ${P.asked_for_examples}, the account of what was done IS the answer they are waiting for, and it SENDS however much of it is about Edva. They do not always ask in this chat: a reply to one of Edva's emails, or a word on the System tab, never appears in the transcript below, so a message that plainly reports back on a change made at their request ("Done — the retime you asked for is live", "Done: the pin audit won't email you anymore") counts on its own word. SECOND: a message telling them about a change they will SEE — an email that stops or starts arriving, a delivery time that moves, something they receive (a daily summary, a digest, a memo) coming back after it failed, anything that will look different on their phone or in their inbox — SENDS, because otherwise the change reaches them as a surprise. Older copies of that email in their inbox, or older pages describing the old behaviour, are the BEFORE of the change, not a contradiction of it. Neither reaches a run report on anything ELSE: a count of pings, a gate that misfired, a job that ran on schedule, a digest delivered as usual, or a bug story whose only effect stays inside Edva is still SUPPRESS, even in the same evening as their request.

Proposed message:
"""${workingMessage}"""

Sender (agent label): ${senderLabel}    (ops = autonomous backend / harvester / digest / cron; chat = chat-agent escalating via edva-send-curl; infra = supervisor liveness alert)
Intent (sender's tag): ${intent}
${supportingBlock}${claimFactsBlock}${utterancesBlock}${wikiBlock}${resolvedTopicsBlock}${sameDayPingsBlock}
Phone-channel transcript, last 8h (oldest first):
${msgBlock}

Calendar events overlapping ±2h (non-transparent only):
${calBlock}

Decide:
- "send" — the message is consistent with all context above, or all sources are silent on the topic.
- "suppress" — any of (a)–(d) above applies. For (d), the reason must name the wiki page and the specific delegation ${P.delegation_reason_example}.
- "modify" — the message is mostly right but needs a small acknowledgment of context. Only when full suppression loses real info.

${P.protected_intents_heading}
If the "Intent (sender's tag)" matches one of these patterns, the playbook has ALREADY decided this ping must fire ${P.protected_playbook_example}. Apply the HIGHEST-BAR suppression: only suppress on a DIRECT, EXPLICIT user statement of contradiction. NEVER suppress on inferred dedup ("already mentioned today"), ${P.protected_inferred_examples}. The playbook's harvester + ranker have already filtered for those; the precheck's job here is exclusively to catch user-stated revocations.

Protected intent patterns:
${[P.protected_pattern_exercise, `  - p1-email                       — P1 email notification (${OWNER} wants to see these).`, P.protected_pattern_health, "  - watchdog:* / supervisor:*      — these already pass --skip-precheck; should never reach here."].filter(Boolean).join("\n")}

For ALL OTHER intents, apply the normal "send/suppress/modify" criteria above.

Reply with ONE LINE of compact JSON, no prose, no markdown fence. Schema:
{"decision":"send"|"suppress"|"modify","message":"<modified text, only if decision=modify, ≤400 chars>","reason":"<≤140 chars: what in the transcript or memory drove the decision. For protected intents that you decided to send anyway, write ${P.protected_reason_example} or similar.>"}

If decision=send or suppress, omit the "message" field or set it to "". If decision=modify, "message" MUST be non-empty and ≤400 chars.`;

// "Send it" means "send what survived the freshness stage". Every fail-open
// path below routes through here, so a truth correction is never lost to a
// relevance-stage hiccup — the one way this gate could silently un-fix a
// message it had already fixed.
function emitSend(reason) {
  if (freshnessModified) {
    emit({ decision: "modify", message: workingMessage.slice(0, 600), reason: `stale premise attributed; ${reason}`.slice(0, 200) });
  }
  emit({ decision: "send", reason });
}

// ─── The relevance decision: Jev primary, Sonnet shadow + fallback ───────
//
// Jev (docs/jev.md) answers ONE choice — send / suppress /
// modify — against the same context the Sonnet prompt carries. It acts alone on
// send and suppress. It cannot write text, so a Jev "modify" takes Sonnet's
// modified message (and Sonnet's verdict). During the shadow week a Sonnet
// "suppress" beats a Jev "send" (lib/jev-gates.mjs). Intents carrying
// edva-model-only data never reach Jev, and everything else passes the
// fail-closed on-device health/bank screen first. Jev unavailable / unsure →
// exactly the old Sonnet path.
//
// The Sonnet call is now ASYNC (execFile), so the shadow Sonnet turn and the Jev
// request genuinely overlap; it resolves the parsed verdict or THROWS the old
// fail-open reason, which becomes an emitSend below — unchanged behavior.
// Tool-less, Max-only, off the edva tree's settings: lib/jev-claude.mjs.
async function sonnetDecision() {
  const { out: sonnetOut, error } = await runToollessDetailed({ bin: CLAUDE_BIN, model: "claude-sonnet-5-5", prompt, timeoutMs: 60000 });
  if (!sonnetOut) {
    sonnetFailure = `precheck_sonnet_unavailable${error?.kind ? `:${error.kind}` : ""}`;
    throw new Error(sonnetFailure);
  }
  const parsed = parseModelJson(sonnetOut);
  if (!parsed) {
    // Keep what it said instead (log row only — see § Relevance-check health).
    logContext.sonnet_head = sonnetOut.slice(0, 200);
    sonnetFailure = "precheck_sonnet_no_json";
    throw new Error(sonnetFailure);
  }
  if (!["send", "suppress", "modify"].includes(parsed.decision)) parsed.decision = "send";
  return parsed;
}

// Apply a Sonnet verdict exactly as the pre-Jev code did.
function emitSonnet(parsed, tag = "") {
  const decision = parsed.decision;
  const reason = `${tag}${(parsed.reason || "").toString()}`.slice(0, 200);
  if (decision === "suppress") emit({ decision: "suppress", reason: reason || "precheck_suppress" });
  if (decision === "modify") {
    const modified = (parsed.message || "").toString().trim();
    if (!modified || modified.length > 600) emitSend("precheck_modify_invalid_message");
    emit({ decision: "modify", message: modified, reason: reason || "precheck_modify" });
  }
  emitSend(reason || "precheck_send");
}

const { decideGate, privateIntent, protectedIntent, fitState } = await import("../lib/jev-gates.mjs");
const { createHash } = await import("node:crypto");
const jevState = fitState({
  proposed_message: workingMessage,
  intent,
  sender: senderLabel,
  supporting_data: supportingData ? JSON.stringify(supportingData).slice(0, 800) : "(none)",
  authoritative_facts: claimFactsText || "(none)",
  [SAID_KEY]: utterancesText || "(nothing matching in the reply log)",
  long_term_memory: wikiContext ? wikiContext.slice(0, 3000) : "(no matching wiki pages)",
  acknowledged_topics_48h: resolvedTopicsText || "(none)",
  hum_pings_today: sameDayPingsText || "(none)",
  calendar_now: calendarEvents.slice(0, 12),
  transcript_last_8h: recentMessages.slice(-30).map(m => `[${m.at}] ${m.role}: ${m.body.slice(0, 300)}`),
}, 20000, { oldestFirst: ["transcript_last_8h"] });

relevanceStage = true;   // from here every emit() is a relevance decision (§ Relevance-check health)
let gate;
try {
  gate = await decideGate({
    site: "outbound-precheck",
    id: `${intent.slice(0, 40)}#${createHash("sha1").update(workingMessage).digest("hex").slice(0, 10)}`,
    state: jevState,
    logInput: { intent, sender: senderLabel, message: workingMessage.slice(0, 300) },
    legacy: sonnetDecision,
    verdictOf: (p) => p.decision,
    classes: ["send", "suppress", "modify"],
    textClasses: ["modify"],
    conservative: ["suppress"],
    // PROTECTED INTENTS (the prompt's highest-bar list) stay on Sonnet: the bar
    // there is "only an explicit user revocation suppresses", a nuance a Jev
    // confidence threshold does not encode — and a wrongly-suppressed P1 email
    // pointer is the most expensive miss this gate can make.
    // protectedIntent() covers p1-email + the protected hum lanes and is NOT
    // privacy-gated. It used to lean on privateIntent() for the two hum lanes,
    // which meant turning privacy_exclusions off also stopped
    // protecting them — see the note on protectedIntent in jev-gates.mjs.
    skipJev: privateIntent(intent) || protectedIntent(intent),
  });
} catch (err) {
  const failCode = String(err?.message || err).replace(/^legacy failed[^:]*: /, "").slice(0, 120) || "precheck_error"; // lang-regex-ok: strips jev-shadow's own error prefix off our fail-open code, not language
  // Anything that lands here went out unchecked. One of our own codes names its
  // kind; an exception we did not throw ourselves is an "error", never a pass.
  relevanceFailKind = sonnetFailKind(failCode) || "error";
  emitSend(failCode);
}

if (gate.source === "jev") {
  if (gate.verdict === "suppress") emit({ decision: "suppress", reason: "jev: context says suppress" });
  emitSend("jev: consistent with context");
}
if (!gate.result) {
  // Jev said modify and Sonnet had no text. Say which way Sonnet failed: an
  // answer without JSON (sonnet_head is in the row) is no_json, not unavailable.
  const failCode = sonnetFailure || (logContext.sonnet_head ? "precheck_sonnet_no_json" : "precheck_sonnet_unavailable");
  relevanceFailKind = sonnetFailKind(failCode) || "unavailable";
  emitSend(failCode);
}
emitSonnet(gate.result, gate.source === "legacy-conservative" ? "sonnet shadow suppress over jev send: " : "");
