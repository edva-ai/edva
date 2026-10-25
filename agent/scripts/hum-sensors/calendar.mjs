// calendar — the transitions Google Calendar never pushes.
//
// The old model could only ever see "is the user in a meeting right now" and used it
// as a gate. The interesting information is one derivative up: a meeting just
// ENDED (the user is back, and a suggestion can land), a meeting is about to start
// somewhere else (leave now), an afternoon just opened up. Those are the
// moments; being in a meeting is merely a state.
//
// One `gog` call per interval. A model is asked only about busy events longer
// than three hours, once per event, off the sensor's own clock (see below).
//
// Two memo fields, two questions: `current_id` is whatever is on
// the calendar now (drives meeting_ended / free_window, unchanged); `hold_id`
// is an event that should hold hum, which is all the in_meeting gate reads.
// A day-long block named after a city can otherwise hold most of a day's hum
// events. Up to three hours, every busy event holds as before. Longer, the
// difference between a thing the user is attending (a flight, a wedding, a
// conference) and a container for the day ("<City>", "Trip day with ...") is language, so a
// model reads it (Rule #0b): Jev and Sonnet (Opus if Sonnet's answer is
// unusable). Only both saying "container" releases; anything else holds.

import { event, shJson, BIN, GOG_ACCOUNT } from "./_common.mjs";

export const meta = {
  name: "calendar",
  lanes: ["calendar", "situation", "tasks", "ideas"],
};

const ACCOUNT = GOG_ACCOUNT;

export const HOLD_MAX_MIN = 3 * 60;   // longer than this, the model is asked
export const JEV_SITE = "calendar-hold";
const ASK_AHEAD_MS = 60 * 60e3;       // ask about an event starting within the hour
const RETRY_MS = 30 * 60e3;           // a failed ask is retried after this
const MAX_ASKS_PER_RUN = 3;

// A link to one of these hosts is a call (hostname match: structure, not words).
const CALL_HOSTS = ["zoom.us", "zoom.com", "meet.google.com", "teams.microsoft.com", "teams.live.com", "webex.com"];
const isCallUrl = (u) => CALL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
const URL_END = " \t\r\n\"'<>()[]{}";
const FILLER = ` \t\r\n()[]{}<>,.;:|-–—·•"'`;

/** A string's http(s) URLs and the text left around them. Scans for "http"
 *  and parses with URL; no regex. */
export function splitUrls(s) {
  const urls = [];
  if (typeof s !== "string") return { urls, rest: "" };
  let rest = "", from = 0;
  for (let i = s.indexOf("http"); i !== -1; ) {
    let j = i;
    while (j < s.length && !URL_END.includes(s[j])) j++;
    let u = null;
    try { u = new URL(s.slice(i, j)); } catch { /* not a URL */ }
    if (u && (u.protocol === "https:" || u.protocol === "http:")) {
      urls.push(u); rest += s.slice(from, i); from = j; i = s.indexOf("http", j);
    } else i = s.indexOf("http", i + 1);
  }
  return { urls, rest: rest + s.slice(from) };
}

/** Where the user would go, or null. A location that is nothing but call links
 *  (someone's Zoom URL) is not a place; anything else is — an address, a venue
 *  name with a maps link after it ("<Venue> (https://maps.app...)"),
 *  or a bare maps link. */
export function placeOf(location) {
  if (typeof location !== "string" || !location.trim()) return null;
  const { urls, rest } = splitUrls(location);
  const textLeft = [...rest].some((ch) => !FILLER.includes(ch));
  return urls.length && urls.every(isCallUrl) && !textLeft ? null : location;
}

export function parseEvents(payload) {
  const items = payload?.events || payload?.items || (Array.isArray(payload) ? payload : []);
  return items
    .map((e) => ({
      id: e.id || `${e.summary}:${e.start?.dateTime}`,
      updated: e.updated || null,
      summary: e.summary || "(no title)",
      location: e.location || null,
      place: placeOf(e.location),
      transparent: (e.transparency || "opaque") === "transparent",
      start: new Date(e.start?.dateTime || e.start?.date || 0).getTime(),
      end: new Date(e.end?.dateTime || e.end?.date || 0).getTime(),
      allDay: !e.start?.dateTime,
      declined: (e.attendees || []).some((a) => a?.self && a.responseStatus === "declined"),
      call: Boolean(e.hangoutLink || (e.conferenceData?.entryPoints || []).length || splitUrls(e.location).urls.some(isCallUrl)),
      others: (e.attendees || []).filter((a) => a && !a.self && !a.resource).length,
      invited: Boolean(e.organizer && e.organizer.self !== true),
    }))
    .filter((e) => Number.isFinite(e.start) && e.start > 0 && !e.allDay && !e.transparent);
}

const minutesOf = (ev) => Math.round((ev.end - ev.start) / 60000);
export const verdictKey = (ev) => `${ev.id}|${ev.updated || ""}`;

/** Should this event hold hum while it is on? PURE → {hold, why}.
 *  `verdicts` is the model's cache, keyed by verdictKey. */
export function holdVerdict(ev, { verdicts = {} } = {}) {
  if (ev.allDay || ev.transparent) return { hold: false, why: "all-day or marked free" };
  if (ev.declined) return { hold: false, why: "declined" };
  if (minutesOf(ev) <= HOLD_MAX_MIN) return { hold: true, why: "busy event" };
  const v = verdicts[verdictKey(ev)]?.verdict;
  if (v === "container") return { hold: false, why: `planning block (${minutesOf(ev)} min)` };
  return { hold: true, why: v === "attending" ? "attending a long event" : "long event, no verdict (holds)" };
}

/** What is on now (`current`), and which of it, if any, holds hum. PURE.
 *  Each overlapping event is judged, so a call inside a day block holds. */
export function calendarSituation(events, { nowMs, verdicts = {} } = {}) {
  const now = events.filter((e) => e.start <= nowMs && e.end > nowMs);
  const judged = now.map((e) => ({ e, ...holdVerdict(e, { verdicts }) }));
  const hold = judged.find((j) => j.hold) || null;
  return { current: now[0] || null, hold: hold?.e || null, why: (hold || judged[0])?.why || null };
}

// ── the model ──────────────────────────────────────────────────────────────

function modelState(ev) {
  const hours = Math.round(minutesOf(ev) / 30) / 2;
  return {
    title: ev.summary,
    lasts: `about ${hours} hours`,
    has_a_location: Boolean(ev.place),
    has_a_video_call_link: ev.call,
    other_people_invited: ev.others ? `${ev.others}` : "none",
    organised_by_someone_else: ev.invited,
  };
}

const KINDS = ["attending", "container", "unclear"];

/** Sonnet, then Opus when the answer is not one of KINDS, asked the same
 *  question Jev is. A failed call (no login, timeout) throws: the next tier
 *  would fail the same way. */
async function claudeLadder(state, q) {
  const { runToollessDetailed, parseModelJson } = await import("../../../lib/jev-claude.mjs");
  const { createRequire } = await import("node:module");
  const { MODELS } = createRequire(import.meta.url)("../../../lib/models.cjs");
  const kinds = Object.entries(q.criteria).map(([k, d]) => `${k}: ${d}`).join("\n");
  const prompt = `${q.instructions}\n\n${kinds}\n\nEntry:\n${JSON.stringify(state, null, 1)}\n\nReply with JSON only: {"kind": "${KINDS.join('" | "')}"}`;
  for (const model of [MODELS.sonnet, MODELS.opus]) {
    const { out, error } = await runToollessDetailed({ model, prompt, timeoutMs: 90000 });
    if (error) throw new Error(`${model}: ${error.kind}`);
    const kind = parseModelJson(out)?.kind;
    if (KINDS.includes(kind)) return kind;
  }
  throw new Error("no tier answered attending/container/unclear");
}

/**
 * Attending or a container? → {verdict, used}, or null (= hold, asked again
 * later). Jev (site calendar-hold, question in
 * data/jev-questions/calendar-hold.json) and the Claude ladder both read
 * it. Releasing the hold is the risky direction, so it takes BOTH: `container`
 * only when the ladder says container and Jev's own top answer — at any
 * confidence — is container too (Jev unreachable → the ladder alone). Jev
 * confidently saying attending/unclear holds without a second call. Any
 * disagreement holds, in the shadow week and after it. Jev's container alone
 * never releases.
 */
export async function classifyLongEvent(ev, { decideImpl = null, siteDef = undefined, ladder = claudeLadder } = {}) {
  const { answerConfidence, jevSiteDef } = await import("../../../lib/jev.mjs");
  const def = siteDef !== undefined ? siteDef : jevSiteDef(JEV_SITE);
  const q = def?.questions?.kind;
  if (!q) return null;
  const { decide } = decideImpl ? { decide: decideImpl } : await import("../../../lib/jev-shadow.mjs");
  const state = modelState(ev);
  let asked = null;
  const askClaude = () => (asked ||= ladder(state, q)); // one run, shared with decide()'s shadow/legacy
  const r = await decide({
    site: JEV_SITE,
    id: verdictKey(ev),
    state,
    questions: def.questions,
    interpret: (answers) => ({ value: answers.kind?.choice || null, confidence: answerConfidence(answers.kind) }),
    legacy: askClaude,
    // Inert while jev-config.json privacy_exclusions is false (today). If that
    // guard is switched back on, an on-device screen keeps a sensitive title
    // (a long medical procedure) off Jev: Claude alone answers, unlogged.
    privacyScreen: true,
    alwaysShadow: Boolean(def.shadow_until && Date.now() < Date.parse(def.shadow_until)),
    same: (a, b) => a === b,
  });
  if (r.used === "jev" && r.value !== "container") return KINDS.includes(r.value) ? { verdict: r.value, used: "jev" } : null;
  const jevSaid = r.jev && !r.jev.error && KINDS.includes(r.jev.value) ? r.jev.value : null;
  const claude = await askClaude().catch(() => null);
  if (!claude) return null;
  if (claude === "container" && (!jevSaid || jevSaid === "container")) return { verdict: "container", used: jevSaid ? "jev+claude" : "claude" };
  return { verdict: [jevSaid, claude].includes("attending") ? "attending" : "unclear", used: "cautious" };
}

export function createRuntime() { return { pending: new Map(), settled: new Map() }; }
const RUNTIME = createRuntime(); // lives as long as the daemon's module cache

/**
 * Verdicts for the events listed now: the memo's, plus any that settled since
 * the last run. Starts (never awaits) an ask for each long busy event that is
 * on now or starts within the hour and has no verdict: the sensor's 20 s
 * budget cannot wait on a model, so until the answer lands the event holds —
 * exactly what it did before. Returns the verdict map to persist.
 */
export function refreshVerdicts(events, { memo = {}, nowMs, classify = classifyLongEvent, rt = RUNTIME } = {}) {
  const listed = new Set(events.map(verdictKey));
  const verdicts = {};
  for (const [k, v] of Object.entries(memo.verdicts || {})) if (listed.has(k)) verdicts[k] = v;
  for (const [k, v] of rt.settled) { if (listed.has(k)) verdicts[k] = v; rt.settled.delete(k); }
  let asked = 0;
  for (const ev of events) {
    if (asked >= MAX_ASKS_PER_RUN) break;
    if (ev.declined || minutesOf(ev) <= HOLD_MAX_MIN || ev.end <= nowMs || ev.start - nowMs > ASK_AHEAD_MS) continue;
    const k = verdictKey(ev);
    const have = verdicts[k];
    if (have && (have.verdict || nowMs - Date.parse(have.at) < RETRY_MS)) continue;
    if (rt.pending.has(k)) continue;
    asked++;
    rt.pending.set(k, Promise.resolve().then(() => classify(ev)).catch(() => null).then((r) => {
      rt.settled.set(k, { verdict: r?.verdict ?? null, used: r?.used ?? null, at: new Date(nowMs).toISOString() });
      rt.pending.delete(k);
    }));
  }
  return verdicts;
}

export default async function detect(ctx) {
  const payload = await shJson("/opt/homebrew/bin/gog",
    ["calendar", "list", ...(ACCOUNT ? ["--account", ACCOUNT] : []), "--days", "1", "--max", "30", "--json"],
    { timeout: 15000 });
  // A real calendar with nothing on it still returns valid JSON, so an
  // unparseable response means the probe failed (expired gog token, missing
  // GOG_KEYRING_PASSWORD, no network) — not "a quiet day". Throw so the daemon
  // records it as last_error and `hum-sense status` shows it. Returning [] here
  // is what let this sensor sit blind for hours looking perfectly healthy.
  if (!payload) throw new Error("gog calendar returned nothing (auth or network?)");
  return fromPayload(payload, ctx);
}

/** Everything after the fetch; `ctx.classify` / `ctx.rt` are test seams. */
export function fromPayload(payload, ctx) {
  const { memo, setMemo, nowMs } = ctx;
  const events = parseEvents(payload);

  const verdicts = refreshVerdicts(events, { memo, nowMs, classify: ctx.classify, rt: ctx.rt });
  const { current, hold, why } = calendarSituation(events, { nowMs, verdicts });
  const upcoming = events.filter((e) => e.start > nowMs).sort((a, b) => a.start - b.start);
  const next = upcoming[0] || null;
  const out = [];

  // ── a meeting just ended ──
  // The single best moment hum has: the user is free, at the desk, and has just
  // finished thinking about something. Anything queued during the meeting was
  // held by the gate and ships now.
  if (memo?.current_id && memo.current_id !== current?.id) {
    out.push(event("calendar", "meeting_ended", {
      subject: memo.current_summary || "a meeting",
      summary: `Just out of "${memo.current_summary || "a meeting"}"`,
      salience: 0.6,
      lanes: ["calendar", "situation", "tasks", "ideas"],
      dedup_key: `calendar:ended:${memo.current_id}`,
      ttl_min: 20,
      cooldown_min: 25,
      data: { ended: memo.current_summary, next: next?.summary || null, free_min: next ? Math.round((next.start - nowMs) / 60000) : null },
    }));
  }

  // ── leave-now window for an event with a physical location ──
  // A link in the location field is a call, not a place to leave for.
  if (next?.place) {
    const inMin = Math.round((next.start - nowMs) / 60000);
    if (inMin > 0 && inMin <= 40 && memo?.departure_warned !== next.id) {
      out.push(event("calendar", "departure_window", {
        subject: next.summary,
        summary: `"${next.summary}" at ${next.location} in ${inMin} min`,
        // Time-critical and actionable — high enough to punch through the
        // refractory window when it matters.
        salience: inMin <= 20 ? 0.82 : 0.66,
        lanes: ["calendar", "situation", "weather", "location_context"],
        dedup_key: `calendar:departure:${next.id}`,
        ttl_min: Math.max(5, inMin),
        cooldown_min: 60,
        data: { summary: next.summary, location: next.location, in_min: inMin },
      }));
    }
  }

  // ── a long free window just opened ──
  // Only interesting on the transition from "the day was booked" to "the next
  // three hours are not", and only during waking hours the ranker can use.
  const freeMin = next ? Math.round((next.start - nowMs) / 60000) : 24 * 60;
  const wideOpen = !current && freeMin >= 180;
  if (wideOpen && memo?.wide_open === false) {
    out.push(event("calendar", "free_window", {
      subject: `${Math.min(freeMin, 600)}m free`,
      summary: `Clear calendar for the next ${freeMin >= 600 ? "rest of the day" : `${Math.round(freeMin / 60)}h`}`,
      salience: 0.4,
      lanes: ["ideas", "experiences", "situation", "tasks"],
      dedup_key: `calendar:free_window:${new Date(nowMs).toISOString().slice(0, 13)}`,
      ttl_min: 60,
      cooldown_min: 4 * 60,
      data: { free_min: freeMin, next: next?.summary || null },
    }));
  }

  setMemo({
    current_id: current?.id || null,
    current_summary: current?.summary || null,
    // Always written (null = nothing holds): hum-sense tells a new memo from
    // an older-format one by the key's presence.
    hold_id: hold?.id || null,
    hold_summary: hold?.summary || null,
    hold_why: why,
    verdicts,
    wide_open: wideOpen,
    departure_warned: out.some((e) => e.type === "calendar.departure_window") ? next?.id : memo?.departure_warned ?? null,
  });
  void BIN;
  return out;
}
