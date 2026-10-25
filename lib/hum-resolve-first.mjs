// hum-resolve-first.mjs — work the answer out before hum asks the user.
//
// Working out the answer before asking applies to EVERY question and hum
// comment before it is floated, regardless of type or context — not to hide
// anything from the user, but because floating something Edva should
// already know is unhelpful. It uses the best available model.
//
// The trigger: hum asked the user a question whose answer was already on file
// in the bookings and the travel timeline. Every gate in front of a hum send
// asked whether the message was relevant, new and still true; none asked
// whether Edva already knew the answer.
//
// WHERE IT RUNS. Inside bin/edva-send-curl, for every chat-channel
// message whose --intent starts with `hum:` — the one point every hum send
// passes: info pings via hum-ping, questions via hum-ask, queued lane-diagnosis
// questions via hum-deliver-qual. It runs before the outbound precheck, so a
// rewritten message is still checked for relevance and freshness after it.
//
// WHAT IT DOES. Code reads a bounded bundle of Edva's own records, each
// stamped with when it was read. The kernel bundle is generic: calendar,
// tasks, recent chat, wiki/inbox/replies recall, email memory, and this gate's
// own earlier conclusions. An installation adds its own sources (a travel
// timeline, bookings, leases, location history, …) as modules in
// agent/scripts/hum-resolve-first-sources/_ext/ (see loadOverlaySources),
// and orders them with agent/local/config/hum-resolve-first.json. One
// Opus call (models.env, Max session only, tool-less) reads the message against
// them and returns a schema-checked verdict. Code owns the action table:
//
//   resolved + worth knowing → rewrite to a short FYI (the fact + what was checked)
//   resolved + adds nothing  → drop (nothing is sent)
//   partial                  → rewrite to ask only the remaining gap
//   unresolved question      → rewrite as the specific gap + what was checked
//                              (sent as written if the model offers no rewrite)
//   nothing to resolve       → send as written
//
// A resolution must cite at least one section that was actually in the bundle,
// or it is not a resolution. Every decision is logged to
// data/hum-resolve-first-log.jsonl; settled answers go to
// lib/hum-resolve-first-store.mjs so the same thing is not re-asked.
//
// FAIL-OPEN, ALWAYS. A missing model, a timeout, an unreadable bundle or an
// answer that fails validation sends the message exactly as written. This gate
// may make hum quieter or sharper; it may never make it silent by breaking.
//
// PRIVACY. Bank and health content is edva-model-only (agent/CLAUDE.md
// § Financial Operations rule 5, § Health). This gate never READS bank or health
// rows into its bundle; a finance/stocks/health-lane message itself reaches only
// Edva's own model (the Max-session Opus fork, no API key, no connector), and
// its log row and stored answer carry no text, only a hash and the verdict.
//
// Rule #0b: what the message means and whether the records answer it is the
// model's call. Code owns ids, timestamps, the bundle, the citation check and
// the action table. No regex reads the message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runToollessDetailed } from "./jev-claude.mjs";
import { extractJsonObject } from "./extract-json.mjs";
import { recentResolved, recordResolved } from "./hum-resolve-first-store.mjs";
import { installTools } from "./root.cjs";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");

const HOME = os.homedir();
const ROOT = installTools();
const BIN = path.join(ROOT, "bin");
const DATA = path.join(ROOT, "data");
export const LOG_FILE = path.join(DATA, "hum-resolve-first-log.jsonl");
export const KILL_SWITCH = path.join(DATA, ".hum-resolve-first-off");
const SUPABASE_URL = `https://${instance().supabase_project}.supabase.co`;
const GOG = process.env.HUM_RESOLVE_FIRST_GOG_BIN || "/opt/homebrew/bin/gog";

export const EFFORT = process.env.HUM_RESOLVE_FIRST_EFFORT || "medium";
export const DEADLINE_MS = Number(process.env.HUM_RESOLVE_FIRST_DEADLINE_MS || 90_000);
const SOURCE_TIMEOUT_MS = 12_000;
const MODEL_TIMEOUT_MS = 60_000;
const MAX_TEXT = 600;

export const VERDICTS = new Set(["resolved", "partial", "unresolved", "nothing_to_resolve"]);
// Lanes whose content is edva-model-only. Same lanes edva-send-curl keeps
// out of the outbound precheck (finance, stocks), plus health.
export const PRIVATE_LANES = new Set(["finance", "stocks", "health"]);
// Live sources of record — the only places a changeable status may come from.
// The kernel's own; an overlay source marked `live`, or listed in the local
// config's live_sources, joins them.
export const LIVE_SOURCES = ["calendar", "tasks"];

// Overlay source drop: one module per source, default-exporting
// { id, live?: boolean, read({run, nowMs, message, fetchFn, storeFile}) → {title, text, as_of?} | {error} }.
// See the .gitkeep there for the contract.
export const OVERLAY_SOURCES_DIR = process.env.HUM_RESOLVE_FIRST_SOURCES_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agent/scripts/hum-resolve-first-sources/_ext");

// This installation's ordering of the bundle and its prompt wording
// (agent/local/config/hum-resolve-first.json). The defaults are generic.
const OWNER = instance().owner_name;
const OWNER_CAP = OWNER.charAt(0).toUpperCase() + OWNER.slice(1);
function settings() {
  return localConfig("hum-resolve-first", {
    // Section order in the bundle; ids not listed follow, kernel first.
    source_order: null,
    // Every live source of record, in the order the prompt names them.
    live_sources: null,
    prompt: {},
  });
}
const PROMPT_DEFAULTS = {
  intro: `A hum message is about to be sent to ${OWNER}'s phone. Hum is Edva's proactive check-in loop: it floats questions and comments to ${OWNER}. The standing rule: work out the answer before asking — for EVERY question and hum comment, regardless of type or context. Not to hide anything from ${OWNER}, but because floating something Edva should already have the answer to is unhelpful.`,
  case_example: `An example of the failure this prevents: hum asked "Your flight on the 31st leaves at 9am... do you need a ride to the airport?" The records already showed a car service booked for 6:30 that morning, so the ride is covered. The question should never have been asked.`,
  rule_resolved: `2. "resolved": the records answer every open point. Draw the conclusion ${OWNER} would draw from booked facts (a car booked to the airport ahead of ${OWNER}'s own flight = the ride is covered). Do not stretch: a conclusion must follow from the records with no reasonable alternative. Never treat the message itself or the lane's finding as the answer.`,
  read_time_note: "Each section shows when it was read (or, for a file, when it was last written).",
  fyi_example: `Example: "Your car to the airport is booked for 6:30 on the 31st, ahead of your 9am flight, so the ride is covered. I checked the booking and your calendar."`,
  partial_example: `Example: "Your car to the airport is booked for 6:30 on the 31st. What I can't see is whether it's for one passenger or two. Do you know?"`,
  unresolved_example: `Example: "Do you need a ride to the airport on the 31st? Your calendar and bookings don't show one."`,
};
function promptText() {
  return { ...PROMPT_DEFAULTS, ...(settings().prompt || {}) };
}

// ─── intent / context (machine labels, never the user's words) ─────────────

/** `hum:<lane>[:<branch>]`, with `hum:explore:<lane>` unwrapped. */
export function laneOf(intent, context = null) {
  if (context && context.lane) return String(context.lane);
  const parts = String(intent || "").split(":");
  if (parts[0] !== "hum") return "unknown";
  if (parts[1] === "explore" && parts[2]) return parts[2];
  return parts[1] || "unknown";
}

export function kindOf(intent, context = null) {
  if (context && (context.kind === "question" || context.kind === "ping")) return context.kind;
  const last = String(intent || "").split(":").pop();
  return last === "question" || last === "lane-diagnosis" ? "question" : "ping";
}

export const isPrivateLane = (lane) => PRIVATE_LANES.has(String(lane || ""));

function readContext(input) {
  if (input && input.context && typeof input.context === "object") return input.context;
  const p = input && input.context_file;
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function newDecisionId(nowMs) {
  const d = new Date(nowMs).toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 15);
  return `hr-${d}-${crypto.randomBytes(2).toString("hex")}`;
}

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const sha8 = (s) => crypto.createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 8);

// ─── the bundle ────────────────────────────────────────────────────────────

function envWithGog() {
  const env = { ...process.env };
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
        if (line.startsWith("GOG_KEYRING_PASSWORD=")) { env.GOG_KEYRING_PASSWORD = line.slice("GOG_KEYRING_PASSWORD=".length).trim(); break; }
      }
    } catch { /* gog falls back to the keychain */ }
  }
  return env;
}

/** Run a command; resolves {ok, out, error}. Never rejects. */
export function runCmd(bin, args, { timeoutMs = SOURCE_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: env || process.env },
        (err, stdout) => {
          const out = String(stdout || "");
          if (err && !out.trim()) return resolve({ ok: false, out: "", error: String(err.killed ? `timeout after ${timeoutMs}ms` : err.message || err).slice(0, 160) });
          resolve({ ok: true, out, error: null });
        });
    } catch (e) { resolve({ ok: false, out: "", error: String(e?.message || e).slice(0, 160) }); }
  });
}

function readSupabaseKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      if (line.startsWith("SUPABASE_SERVICE_ROLE_KEY=")) return line.slice("SUPABASE_SERVICE_ROLE_KEY=".length).trim();
    }
  } catch {}
  return null;
}

function userTz() {
  try {
    const tz = JSON.parse(fs.readFileSync(path.join(DATA, "user-timezone.json"), "utf8")).timezone;
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch { return instance().tz; }
}

function localStamp(ms, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(ms));
}

const SOURCES = {
  async calendar({ run, nowMs }) {
    const from = new Date(nowMs - 2 * 86_400_000).toISOString();
    const to = new Date(nowMs + 35 * 86_400_000).toISOString();
    const r = await run(GOG, ["calendar", "list", "--json", "--results-only", "--from", from, "--to", to, "--all", "--max=250"], { env: envWithGog() });
    if (!r.ok) return { error: r.error };
    let events;
    try { events = JSON.parse(r.out); } catch { return { error: "unparseable calendar JSON" }; }
    if (!Array.isArray(events) || !events.length) return { error: "no events" };
    const lines = events.slice(0, 160).map((e) => {
      const start = e.start?.dateTime || e.start?.date || "?";
      const end = e.end?.dateTime || e.end?.date || "?";
      const who = e.organizer?.displayName || e.organizer?.email || "";
      const bits = [`${start} → ${end}`, e.summary || "(untitled)"];
      if (e.location) bits.push(`@ ${clip(e.location, 80)}`);
      if (who && who !== instance().owner_email) bits.push(`[calendar: ${clip(who, 40)}]`);
      if (e.transparency === "transparent") bits.push("[shows as free]");
      return bits.join(" · ");
    });
    return { title: `Google Calendar, all of ${OWNER}'s calendars, 2 days back to 35 days ahead`, text: clip(lines.join("\n"), 9000) };
  },

  async tasks({ run }) {
    const r = await run(GOG, ["tasks", "list", "@default", "--plain"], { env: envWithGog() });
    if (!r.ok || !r.out.trim()) return { error: r.error || "empty" };
    return { title: "Google Tasks, default list (open tasks)", text: clip(r.out.trim(), 3000) };
  },

  async recent_chat({ nowMs, fetchFn }) {
    const key = readSupabaseKey();
    if (!key) return { error: "no Supabase key" };
    try {
      const qs = new URLSearchParams({
        select: "role,content,created_at", created_at: `gt.${new Date(nowMs - 24 * 3_600_000).toISOString()}`,
        channel: "eq.chat", order: "created_at.desc", limit: "40",
      });
      const resp = await fetchFn(`${SUPABASE_URL}/rest/v1/edva_messages?${qs}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const rows = (await resp.json()).filter((r) => typeof r.content === "string" && r.content).reverse();
      if (!rows.length) return { error: "no chat in the last 24h" };
      return {
        title: `The last 24 hours of the chat with ${OWNER} (role user = ${OWNER}'s own words; assistant = Edva)`,
        text: clip(rows.map((r) => `${r.created_at} ${r.role}: ${clip(r.content, 400)}`).join("\n"), 9000),
      };
    } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
  },

  async recall({ run, message }) {
    const r = await run(path.join(BIN, "recall"), [clip(message, 500), "--json", "-k", "10"]);
    if (!r.ok) return { error: r.error };
    let res;
    try { res = JSON.parse(r.out); } catch { return { error: "unparseable recall JSON" }; }
    const lines = (res?.results || []).map((x) => {
      const when = x.created_at ? String(x.created_at).slice(0, 10) : "";
      const snippet = String(x.snippet || "").replaceAll("«", "").replaceAll("»", "");
      return `[${x.source}] ${when} ${clip(x.title || "", 120)} — ${clip(snippet, 400)}`;
    });
    if (!lines.length) return { error: "no matches" };
    return { title: `Memory recall for this message (wiki pages, inbox, ${OWNER}'s dated replies to earlier pings, chat; each line dated where known)`, text: clip(lines.join("\n"), 7000) };
  },

  async email_memory({ run, message }) {
    const r = await run(path.join(BIN, "context-search"), [clip(message, 300)]);
    if (!r.ok || !r.out.trim()) return { error: r.error || "no matches" };
    return { title: "Indexed email memories, notes and files matching this message (context-search)", text: clip(r.out.trim(), 3500) };
  },

  async resolved_before({ nowMs, storeFile }) {
    const rows = recentResolved({ nowMs, file: storeFile });
    if (!rows.length) return { error: "none" };
    return {
      title: `What this check already worked out in the last 14 days (Edva's own conclusions, not ${OWNER}'s words; their words outrank these)`,
      text: rows.map((r) => `${String(r.ts).slice(0, 10)} · asked: ${clip(r.question, 200)} → ${clip(r.answer, 300)} (from ${(r.sources || []).join(", ")})`).join("\n"),
    };
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

/**
 * Overlay sources from OVERLAY_SOURCES_DIR. Never throws: an unloadable module
 * is skipped. A kernel source id always wins over an overlay one.
 */
export async function loadOverlaySources(dir = OVERLAY_SOURCES_DIR) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort(); } catch { return out; }
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const src = mod.default || mod;
      if (!src || typeof src.read !== "function") continue;
      const id = String(src.id || path.basename(f, ".mjs"));
      if (SOURCES[id]) continue;
      out.push({ id, live: src.live === true, read: src.read });
    } catch { /* skip a broken overlay source */ }
  }
  return out;
}

/** Order source entries by the local config's source_order; unlisted ones keep their order after it. */
function ordered(list, order) {
  if (!Array.isArray(order) || !order.length) return list;
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  return list.map((x, i) => ({ x, i })).sort((a, b) => (rank(a.x.id) - rank(b.x.id)) || (a.i - b.i)).map(({ x }) => x);
}

/** Every live source of record for this installation, in the order the prompt names them. */
export function liveSourceIds(overlay = [], cfg = settings()) {
  if (Array.isArray(cfg.live_sources) && cfg.live_sources.length) {
    const extra = overlay.filter((s) => s.live && !cfg.live_sources.includes(s.id)).map((s) => s.id);
    return [...cfg.live_sources, ...extra];
  }
  const ids = [...LIVE_SOURCES, ...overlay.filter((s) => s.live).map((s) => s.id)];
  return ordered(ids.map((id) => ({ id })), cfg.source_order).map((s) => s.id);
}

/** Read every source in parallel. Each result: {id, title, as_of, text} or {id, error}. */
export async function gatherEvidence({ message, nowMs = Date.now(), run = runCmd, fetchFn = fetch, storeFile, overlay } = {}) {
  const fixture = process.env.HUM_RESOLVE_FIRST_EVIDENCE_FIXTURE;
  if (fixture) {
    try { return JSON.parse(fs.readFileSync(fixture, "utf8")); } catch { return []; }
  }
  const readAt = new Date(nowMs).toISOString();
  const extra = overlay || await loadOverlaySources();
  const all = ordered([...SOURCE_IDS.map((id) => ({ id, read: SOURCES[id] })), ...extra], settings().source_order);
  return Promise.all(all.map(async ({ id, read, live }) => {
    try {
      const r = await read({ run, nowMs, message, fetchFn, storeFile });
      if (!r || r.error || !r.text) return { id, error: r?.error || "empty" };
      return { id, title: r.title, as_of: r.as_of || `read live at ${readAt}`, text: r.text, ...(live ? { live: true } : {}) };
    } catch (e) {
      return { id, error: String(e?.message || e).slice(0, 120) };
    }
  }));
}

// ─── the judgment ──────────────────────────────────────────────────────────

export function buildPrompt({ message, intent, lane, kind, finding, choices, sections, nowMs = Date.now(), tz = userTz(), isPrivate = false }) {
  const evidence = sections.map((s) => `### [${s.id}] ${s.title}\n(${s.as_of})\n${s.text}`).join("\n\n");
  const findingText = finding ? clip(JSON.stringify(finding), 3000) : "(none passed)";
  const choicesText = choices ? `\nTAPPABLE ANSWER CHOICES ATTACHED TO IT:\n${clip(JSON.stringify(choices), 1200)}\n` : "";
  // Every lane, not only the private ones: the bundle holds email and chat that
  // can carry figures, and a rewrite goes on to the outbound precheck.
  const privacyLine = `\nDo not add any money amount, balance, account number or health figure that is not already in the original message.${isPrivate ? " This message carries private money or health detail; keep it exactly as private as it already is." : ""}`;
  const T = promptText();
  const liveIds = liveSourceIds(sections);
  return `You are the "work it out before asking" check inside Edva, ${OWNER}'s personal assistant.

${T.intro}

Your job: work out what this message asks or leaves open, and decide whether Edva's own records below already answer it.

${T.case_example}

NOW: ${localStamp(nowMs, tz)} (${tz}) = ${new Date(nowMs).toISOString()}

THE MESSAGE (${kind === "question" ? "a question" : "a hum comment"}; lane ${lane}; intent ${intent || "none"}):
<<<
${message}
>>>

WHAT THE LANE BASED IT ON (the finding that raised it; it is not evidence that the point is settled):
${findingText}
${choicesText}
EDVA'S RECORDS (each section names its source and when it was read):

${evidence}

HOW TO DECIDE
1. Say to yourself what the message floats: a direct question, an implied open issue ("...and nothing is tracked for after"), a status it calls unknown or pending, or a suggestion that hangs on a fact. A message that floats nothing open (a fact about a place nearby, the weather, a pure heads-up) is "nothing_to_resolve".
${T.rule_resolved}
3. "partial": some open points are answered and at least one real gap remains that only ${OWNER} can fill.
4. "unresolved": the records do not answer it. When unsure, this is the verdict.
5. ${OWNER_CAP}'s own words (recent chat as role user, their dated replies in recall) outrank every other record, including Edva's earlier conclusions in [resolved_before].
6. Freshness. A status that can change (a booking, a flight, a lease, a task, a payment, a third party's action) counts only from a live source of record here: ${liveIds.map((s) => `[${s}]`).join(", ")}, or from what ${OWNER} said. ${T.read_time_note} A status found only in an older secondary record (a wiki page, an email memory, an old reply) may be used only with its date said out loud ("as of Tuesday's email"), and never to state that something is currently so; if that is all there is for a point, that point is unresolved.
7. Cite every section you relied on in "sources", by its id (the word in square brackets above, without the brackets). No sources, no resolution.

WHAT GETS SENT
- resolved, and the answer is worth ${OWNER} knowing now (it changes what they will do, or they would want the heads-up): useful_fyi=true, and fyi_text says the fact. ${T.fyi_example}
- resolved, but saying it adds nothing (they already know, or it is Edva's own bookkeeping): useful_fyi=false, fyi_text null. Nothing is sent.
- partial: gap_text asks only what is still missing, specifically, with one short line on what you already checked. ${T.partial_example}
- unresolved, and the message asks ${OWNER} something: gap_text asks it as the specific thing that is unknown, with one short line on what you checked and did not find. Keep the original's meaning and anything it needs them to know. ${T.unresolved_example} If the message asks nothing (a reminder, a heads-up), gap_text is null and it goes out as written.
- nothing_to_resolve: fyi_text and gap_text null; the message goes out as written.

VOICE for fyi_text and gap_text: a caring, sharp person talking to someone they look after. One or two sentences plus the short line on what you checked, under 300 characters. Specific, warm, plain words, "you" for ${OWNER}. No jargon ("verified", "resolved", "per records", "source of record", section ids), no ids, no menus or "reply yes/no", no exclamation filler, no "Great news". Do not mention the original question or that anything was held back.${privacyLine}

choices_still_fit: true only if the tappable choices above still answer your gap_text as written; otherwise false (and false when there are no choices).

Reply with ONLY this JSON object, nothing before or after it:
{"floats":"<what the message asks or leaves open, a few words>","verdict":"resolved|partial|unresolved|nothing_to_resolve","answer":"<the facts that settle it, or null>","remaining_gap":"<what is still unknown, or null>","sources":["<section id>"],"checked":"<one plain line: what you looked at>","useful_fyi":false,"fyi_text":null,"gap_text":null,"choices_still_fit":false}`;
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Schema check. Citations are kept only if they name a section that was in the bundle. */
export function validateVerdict(raw, sectionIds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["not a JSON object"] };
  const errors = [];
  const verdict = String(raw.verdict || "");
  if (!VERDICTS.has(verdict)) errors.push(`unknown verdict "${clip(verdict, 30)}"`);
  const ids = sectionIds instanceof Set ? sectionIds : new Set(sectionIds || []);
  const cited = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((s) => String(s ?? "").replaceAll("[", "").replaceAll("]", "").trim())
    .filter(Boolean);
  const sources = [...new Set(cited.filter((s) => ids.has(s)))];
  const v = {
    verdict,
    floats: str(raw.floats),
    answer: str(raw.answer),
    remaining_gap: str(raw.remaining_gap),
    sources,
    checked: str(raw.checked),
    useful_fyi: raw.useful_fyi === true,
    fyi_text: str(raw.fyi_text),
    gap_text: str(raw.gap_text),
    choices_still_fit: raw.choices_still_fit === true,
  };
  if (verdict === "resolved" || verdict === "partial") {
    if (!sources.length) errors.push("a resolution cites no section that was in the bundle");
    if (!v.answer) errors.push("a resolution with no answer");
  }
  if (verdict === "resolved" && v.useful_fyi && !v.fyi_text) errors.push("useful_fyi without fyi_text");
  if (verdict === "partial" && !v.gap_text) errors.push("partial without gap_text");
  for (const k of ["fyi_text", "gap_text"]) if (v[k] && v[k].length > MAX_TEXT) errors.push(`${k} over ${MAX_TEXT} chars`);
  return { ok: errors.length === 0, errors, verdict: v };
}

/** The action table — code, not model. */
export function decideAction(v) {
  if (v.verdict === "resolved") {
    return v.useful_fyi && v.fyi_text
      ? { action: "rewrite", text: v.fyi_text, still_question: false, keep_choices: false }
      : { action: "drop" };
  }
  // partial: only the gap; unresolved: the same question, phrased as the
  // specific unknown with what was checked. An unresolved
  // answer with no gap_text is sent as written.
  if ((v.verdict === "partial" || v.verdict === "unresolved") && v.gap_text) {
    return { action: "rewrite", text: v.gap_text, still_question: true, keep_choices: v.choices_still_fit };
  }
  return { action: "send" };
}

/** One Opus judgment on the Max session. Resolves {out, error}. */
export async function callModel({ prompt, timeoutMs }) {
  const fixture = process.env.HUM_RESOLVE_FIRST_MODEL_FIXTURE;
  if (fixture) {
    try { return { out: fs.readFileSync(fixture, "utf8"), error: null }; } catch (e) { return { out: "", error: { kind: "fixture", message: String(e.message) } }; }
  }
  const { MODELS } = require("./models.cjs");
  return runToollessDetailed({ model: MODELS.opus, effort: EFFORT, prompt, timeoutMs });
}

function modelId() {
  try { return require("./models.cjs").MODELS.opus; } catch { return "opus"; }
}

/**
 * The whole pass. Never throws; any failure is {action: "send"}.
 * input: {message, intent, evidence_as_of?, choices?, context?|context_file?}
 * deps (tests): nowMs, gather, model, killSwitch, deadlineMs, storeFile
 */
export async function resolveFirst(input, deps = {}) {
  const started = Date.now();
  const nowMs = deps.nowMs ?? Date.now();
  const deadline = started + (deps.deadlineMs ?? DEADLINE_MS);
  const message = String(input?.message || "").trim();
  const intent = String(input?.intent || "");
  const context = readContext(input);
  const lane = laneOf(intent, context);
  const kind = kindOf(intent, context);
  const base = {
    decision_id: newDecisionId(nowMs), intent, lane, kind, private: isPrivateLane(lane),
    dedup_key: context?.dedup_key || null, ping_id: context?.ping_id || null, original: message,
  };
  const pass = (verdict, reason, extra = {}) => ({ ...base, action: "send", verdict, reason, latency_ms: Date.now() - started, ...extra });

  try {
    if (!message) return pass("skipped", "empty message");
    const off = deps.killSwitch ?? (process.env.HUM_RESOLVE_FIRST_OFF === "1" || fs.existsSync(KILL_SWITCH));
    if (off) return pass("skipped", "kill switch");

    const gathered = await (deps.gather || gatherEvidence)({ message, nowMs, storeFile: deps.storeFile });
    const sections = (gathered || []).filter((s) => s && s.id && s.text);
    const evidence = (gathered || []).map((s) => ({ id: s.id, ok: Boolean(s.text), ...(s.error ? { error: s.error } : {}) }));
    const evidence_ms = Date.now() - started;
    if (!sections.length) return pass("error", "no records could be read", { evidence, evidence_ms });

    const prompt = buildPrompt({
      message, intent, lane, kind, nowMs, sections, isPrivate: base.private,
      finding: context?.finding || null, choices: input?.choices || null,
    });
    const ids = new Set(sections.map((s) => s.id));
    const call = deps.model || callModel;
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 8_000) break;
      const p = attempt === 0 ? prompt
        : `${prompt}\n\nYour previous reply could not be used (${last.errors.join("; ")}). Reply again with only the JSON object.`;
      const r = await call({ prompt: p, timeoutMs: Math.min(MODEL_TIMEOUT_MS, left - 3_000) });
      if (!r?.out) {
        return pass("error", `model unavailable: ${r?.error?.kind || "empty"}`, { evidence, evidence_ms, model: modelId(), effort: EFFORT });
      }
      const v = validateVerdict(extractJsonObject(String(r.out), { requireKey: "verdict" }), ids);
      if (v.ok) {
        const act = decideAction(v.verdict);
        return {
          ...base, ...act, ...v.verdict, reason: v.verdict.floats || v.verdict.verdict,
          evidence, evidence_ms, model: modelId(), effort: EFFORT, attempts: attempt + 1, latency_ms: Date.now() - started,
        };
      }
      last = v;
    }
    return pass("error", last ? `invalid model answer: ${last.errors.join("; ")}` : "deadline before the model could answer", { evidence, evidence_ms, model: modelId(), effort: EFFORT });
  } catch (e) {
    return pass("error", `gate error: ${String(e?.message || e).slice(0, 160)}`);
  }
}

// ─── side effects (the CLI calls these; tests call them with temp paths) ───

/** One log row per decision. Private lanes keep no text: a hash and a length instead. */
export function logRow(d) {
  const hide = (t) => (t ? { sha8: sha8(t), len: String(t).length } : null);
  const priv = Boolean(d.private);
  return {
    ts: new Date().toISOString(),
    decision_id: d.decision_id, intent: d.intent, lane: d.lane, kind: d.kind, dedup_key: d.dedup_key, ping_id: d.ping_id,
    verdict: d.verdict, action: d.action, reason: priv ? (d.verdict === "error" || d.verdict === "skipped" ? d.reason : null) : d.reason,
    sources: d.sources || [], private: priv,
    original: priv ? hide(d.original) : d.original,
    answer: priv ? hide(d.answer) : d.answer ?? null,
    remaining_gap: priv ? hide(d.remaining_gap) : d.remaining_gap ?? null,
    checked: priv ? hide(d.checked) : d.checked ?? null,
    sent_text: d.action === "rewrite" ? (priv ? hide(d.text) : d.text) : null,
    still_question: d.action === "rewrite" ? Boolean(d.still_question) : null,
    model: d.model || null, effort: d.effort || null, attempts: d.attempts ?? null,
    latency_ms: d.latency_ms ?? null, evidence_ms: d.evidence_ms ?? null, evidence: d.evidence || null,
    ...(d.dry_run ? { dry_run: true } : {}),
  };
}

export function appendLog(d, { file = process.env.HUM_RESOLVE_FIRST_LOG || LOG_FILE } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(logRow(d)) + "\n");
  } catch { /* a lost log row never blocks a send */ }
}

/** Keep a settled answer so the same thing is not floated again. */
export function rememberIfSettled(d, { file } = {}) {
  if (d.verdict !== "resolved" && d.verdict !== "partial") return false;
  if (d.action === "send") return false;
  const priv = Boolean(d.private);
  return recordResolved({
    decision_id: d.decision_id, intent: d.intent, lane: d.lane, dedup_key: d.dedup_key, kind: d.kind,
    verdict: d.verdict, action: d.action, sources: d.sources || [], private: priv,
    question: priv ? null : d.original, answer: priv ? null : d.answer,
    remaining_gap: priv ? null : d.remaining_gap, checked: priv ? null : d.checked,
  }, { file });
}

export const sidecarPath = (captureFile) => `${captureFile}.resolve.json`;

/**
 * Tell the caller what happened, through the --capture-id file edva-send-curl
 * already uses. A drop writes the same {"suppressed":true} sentinel the precheck
 * writes, tagged `by: "hum-resolve-first"`; a drop or rewrite also writes a
 * sidecar next to it ({action, still_question, text}) so a question sender knows
 * whether what went out is still a question.
 */
export function writeCaptureArtifacts(captureFile, d) {
  if (!captureFile) return;
  const side = sidecarPath(captureFile);
  try { fs.unlinkSync(side); } catch {}
  if (d.action !== "drop" && d.action !== "rewrite") return;
  const atomic = (p, body) => {
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
  };
  try {
    atomic(side, JSON.stringify({
      by: "hum-resolve-first", decision_id: d.decision_id, action: d.action, verdict: d.verdict,
      still_question: d.action === "rewrite" ? Boolean(d.still_question) : false,
      text: d.action === "rewrite" ? d.text : null,
    }) + "\n");
    if (d.action === "drop") {
      atomic(captureFile, JSON.stringify({ suppressed: true, by: "hum-resolve-first", decision_id: d.decision_id, reason: `resolved before asking${d.private ? "" : `: ${clip(d.answer, 200)}`}` }) + "\n");
    }
  } catch { /* the send path still behaves; only the caller's bookkeeping degrades */ }
}

/** Read a capture sidecar (and remove it). null when the gate left nothing. */
export function readSidecar(captureFile) {
  if (!captureFile) return null;
  const side = sidecarPath(captureFile);
  try {
    const j = JSON.parse(fs.readFileSync(side, "utf8"));
    try { fs.unlinkSync(side); } catch {}
    return j && j.by === "hum-resolve-first" ? j : null;
  } catch { return null; }
}
