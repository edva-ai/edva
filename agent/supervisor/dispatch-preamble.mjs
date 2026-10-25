// dispatch-preamble.mjs — per-turn live-state block prepended to dispatched work.
//
// Reloading agent *instructions* means a graceful-restart of the whole session
// (graceful-restart.mjs watches CLAUDE.md mtime → schedules a restart). That's
// right for structural CLAUDE.md edits, but far too heavy for "the agent should
// know it's now 9am." This module builds a small, cheap, append-only block that
// the dispatcher prepends to each turn's content at SEND time — so dynamic state
// refreshes every turn with no process restart and no MCP respawn.
//
// Design constraints:
//   - Cheap + synchronous + fail-soft. Built inline on the dispatch hot path, so
//     it does only local work (clock, tiny cached file reads) — never a network
//     call, never an LLM call, never anything that can block or throw upward.
//   - item.content is NOT mutated — the dispatcher prepends the return value only
//     to what the child receives, so dedup keys / persistence / event-log records
//     stay clean.
//   - Control/synthetic dispatches (context-guard /compact, init, raw
//     slash-commands, and legacy queued session-handoff items) get NO
//     preamble — see shouldPreamble().
//   - The supervisor's preamble callback (index.mjs) also uses this seam to
//     prepend a one-time <session-handoff> block to the first real dispatch
//     after a rotation (handoff-digest.mjs).
//
// Content today is time-anchored (the load-bearing signal: temporal awareness
// each turn). Richer cheap signals (calendar next-up, unread count) can be added
// as `part()` lines below the moment a cheap on-disk cache for them exists —
// keep every source best-effort so a missing/stale cache degrades to omission.

import fs from "node:fs";
import { createRequire } from "node:module";

// Home timezone and the operator's name, from lib/instance.cjs
// (EDVA_TZ, else agent/local/instance.json, else the host's zone).
const { instance } = createRequire(import.meta.url)("../../lib/instance.cjs");
const INSTANCE = instance();
const TZ = INSTANCE.tz;
const OWNER = INSTANCE.owner_name;
const ownerPossessive = (cap) => {
  const s = `${OWNER}'s`;
  return cap ? s.charAt(0).toUpperCase() + s.slice(1) : s;
};

// Sources that must never get a preamble: the supervisor's own control messages
// and anything that's already a bare command. Matching the dispatch `source`.
const CONTROL_SOURCES = new Set(["context-guard", "session-handoff", "init", "startup-catchup"]);

export function shouldPreamble(item) {
  if (!item) return false;
  if (CONTROL_SOURCES.has(item.source)) return false;
  const c = typeof item.content === "string" ? item.content : "";
  // Raw slash-commands (e.g. "/compact") are directives, not tasks — leave bare.
  if (c.startsWith("/")) return false;
  return true;
}

function formatInTz(tz) {
  // Intl gives us tz wall-clock without pulling in a date lib. Fail-soft: if the
  // runtime lacks the tz data, fall back to ISO UTC.
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    return fmt.format(now); // e.g. "Wed, Jul 8, 2026, 9:07 PM"
  } catch {
    return new Date().toISOString();
  }
}

function homeNow() {
  return formatInTz(TZ);
}

// Best-effort tiny cached-signal reader. Reads a small JSON file and pulls one
// value; returns null on any problem. Used for optional extra lines.
function readCachedJson(path) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    if (raw.length > 64 * 1024) return null; // guard against a bloated file on the hot path
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const STALE_TZ_MS = 48 * 60 * 60 * 1000; // ignore a user-timezone.json we haven't refreshed in 2 days

// Fixed-string comparisons: sleep/quiet-window gates are enforced in code
// (hum-events.mjs, trigger-hum.sh) against data/user-timezone.json — this
// module never re-derives them. It only makes the home-timezone clock line above
// impossible to misread as "the user is asleep" when they're traveling and it's
// actually midday where they are.
function currentLocationLine(cacheDir) {
  if (!cacheDir) return null;
  const loc = readCachedJson(`${cacheDir}/user-timezone.json`);
  const tz = loc?.timezone;
  if (!tz || tz === TZ) return null; // same as home tz — the line above already covers it
  const updatedAt = Date.parse(loc?.updated_at || "");
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_TZ_MS) return null;
  const label = tz.split("/").pop().replace("_", " ");
  return `${ownerPossessive(true)} current local time (where they actually are): ${formatInTz(tz)} (${label}) — this is what quiet-hours/sleep-window gates use, not the line above`;
}

// hum-state's today.date is the user's local day; accept it if it matches
// the home timezone or their current tz, so a traveling day boundary never hides a live count.
function todayCandidates(cacheDir) {
  const out = new Set();
  for (const tz of [TZ, readCachedJson(`${cacheDir}/user-timezone.json`)?.timezone]) {
    if (!tz) continue;
    try { out.add(new Date().toLocaleDateString("en-CA", { timeZone: tz })); } catch { /* bad tz */ }
  }
  return out;
}

// Build the preamble string, or null if there's nothing worth adding.
// `opts.cacheDir` (optional) points at data for cheap cached signals.
export function buildPreamble(opts = {}) {
  const parts = [];
  parts.push(`now: ${homeNow()} (${TZ.split("/").pop().replace("_", " ")}) — ${ownerPossessive(false)} home timezone, shown for date/task context only`);

  const locLine = currentLocationLine(opts.cacheDir);
  if (locLine) parts.push(locLine);

  // Optional cheap signals — each fully best-effort. Today's ping count from
  // hum-state.json's live counter, against the shared daily budget (6/day, 45 min
  // apart — lib/ping-budget.mjs, enforced in code by hum-ping and the
  // location-ambient trigger; this line is only so the agent can see it without
  // a tool call). Until 2026-10-06 this read pulse-state.json, dead since
  // 2026-09-10 and always 0. A counter from another day is omitted, not shown.
  if (opts.cacheDir) {
    const hum = readCachedJson(`${opts.cacheDir}/hum-state.json`);
    const pings = hum?.today?.pings;
    if (Number.isFinite(pings) && hum?.today?.date && todayCandidates(opts.cacheDir).has(hum.today.date)) {
      const cap = Number.isFinite(hum.max_pings_per_day) ? hum.max_pings_per_day : 6;
      parts.push(`hum/ambient pings so far today: ${pings} (budget ${cap}/day, enforced in code)`);
    }
  }

  if (!parts.length) return null;
  return `<live-state>\n${parts.join("\n")}\n</live-state>\n\n`;
}

// ---------------------------------------------------------------------------
// Local companions — the operator's own additions to a kernel playbook.
//
// Kernel playbooks (ops-agent/jobs/<job>.md, ops-agent/email-triage-rules.md)
// hold the generic procedure. An instance's own people, senders, accounts and
// standing decisions live beside them in agent/local/ (jobs/<job>.md,
// email-triage-rules.md). These helpers put the two back together at dispatch
// time, so the agent still receives every rule. Pure and synchronous; a missing
// companion is simply absent (the kernel text is returned unchanged).

export function readOptional(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/**
 * Kernel playbook + its local companion, if the companion exists and is not
 * empty. The companion is appended after a blank line, verbatim.
 */
export function withLocalCompanion(kernelText, companionText) {
  const k = String(kernelText ?? "");
  if (companionText == null || !String(companionText).trim()) return k;
  return `${k.trimEnd()}\n\n${String(companionText).trimEnd()}\n`;
}

/** Path of the local companion of `<jobsDir>/<job>.md`: `<localDir>/jobs/<job>.md`. */
export function localCompanionPath(localDir, job) {
  return `${localDir}/jobs/${job}.md`;
}

/**
 * Every `start … end` marker block in `text`, joined by a blank line (the
 * kernel's block first, then the companion's). Returns null when there is none.
 */
export function sliceAll(text, start, end) {
  const out = [];
  let from = 0;
  const s = String(text ?? "");
  for (;;) {
    const i = s.indexOf(start, from);
    if (i < 0) break;
    const j = s.indexOf(end, i + start.length);
    if (j < 0) break;
    out.push(s.slice(i + start.length, j).trim());
    from = j + end.length;
  }
  return out.length ? out.join("\n\n") : null;
}

// Split markdown on `### ` headings (the same cut lib/triage-rules.mjs
// slices on): { preamble, sections: [{ title, text }] }, text including its
// heading line.
function splitSections(md) {
  const pre = [];
  const sections = [];
  let cur = null;
  for (const line of String(md ?? "").split("\n")) {
    if (line.startsWith("### ")) {
      cur = { title: line.slice(4).trim(), lines: [line] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else pre.push(line);
  }
  return {
    preamble: pre.join("\n").trimEnd(),
    sections: sections.map((x) => ({ title: x.title, text: x.lines.join("\n").trimEnd() })),
  };
}

/**
 * Merge a local `### `-sectioned companion into a kernel ruleset, so a reader
 * that slices by heading (triage-rules core/index/section) sees one document:
 *   - a local section whose heading equals a kernel heading is appended to that
 *     kernel section's body (heading line dropped);
 *   - any other local section is inserted right after the section the previous
 *     local section landed in (so a companion written in kernel order keeps
 *     its place), or at the end when nothing precedes it;
 *   - the companion's preamble (text before its first heading) follows the
 *     kernel preamble.
 * Headings are compared exactly (after trimming).
 */
export function mergeSectionedMarkdown(kernelText, localText) {
  if (localText == null || !String(localText).trim()) return String(kernelText ?? "");
  const k = splitSections(kernelText);
  const l = splitSections(localText);
  const out = k.sections.map((s) => ({ ...s }));
  let anchor = -1; // index in `out` the previous local section landed at
  for (const ls of l.sections) {
    const at = out.findIndex((s) => s.title === ls.title);
    if (at >= 0) {
      const body = ls.text.split("\n").slice(1).join("\n").trim();
      if (body) out[at].text = `${out[at].text}\n\n${body}`;
      anchor = at;
    } else {
      const pos = anchor >= 0 ? anchor + 1 : out.length;
      out.splice(pos, 0, { ...ls });
      anchor = pos;
    }
  }
  const pre = [k.preamble, l.preamble].filter((p) => p && p.trim()).join("\n\n");
  return [pre, ...out.map((s) => s.text)].filter(Boolean).join("\n\n") + "\n";
}

/**
 * Write `content` to `outPath` only when it differs from what is there, via a
 * temp file + rename. Returns true when the file was (re)written. Keeping the
 * bytes and the path stable is what lets a prompt built from the file stay
 * cache-identical across sessions.
 */
export function writeFileIfChanged(outPath, content) {
  if (readOptional(outPath) === content) return false;
  const dir = outPath.slice(0, outPath.lastIndexOf("/")) || ".";
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, outPath);
  return true;
}

/**
 * The email-triage ruleset an agent should read: the kernel file merged with
 * the local companion, written to `outPath` (rewritten only on change).
 * Returns outPath, or null when there is no local companion (callers then keep
 * pointing at the kernel file itself).
 */
export function composeTriageRules({ kernelPath, localPath, outPath }) {
  const local = readOptional(localPath);
  if (local == null || !local.trim()) return null;
  const kernel = readOptional(kernelPath);
  if (kernel == null) return null;
  writeFileIfChanged(outPath, mergeSectionedMarkdown(kernel, local));
  return outPath;
}
