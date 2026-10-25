// handoff-digest.mjs — session-handoff digest for the ops supervisors.
//
// The supervisor --resume's ONE Claude session across dispatches and rotates to
// a fresh one on a dispatch/age/context cap. A blunt rotation is amnesia: the
// new session boots with zero awareness of what the old one was doing. This
// module captures a digest of the OUTGOING session's recent activity so the
// fresh session gets that context once, prepended to its first real dispatch
// (see Supervisor._prepareHandoff and the dispatcher preamble in index.mjs).
//
// Sourcing: recent activity comes from the events_fts recall index
// (lib/event-fts.mjs recentEvents) — the same derived index the
// recall_events tool queries — with a fallback to tailing events.ndjson so the
// digest still works before the index has warmed or if it's unavailable.
//
// NO MODEL. Forking `claude -p --model haiku` to rewrite the activity list as
// prose, then dispatching a whole Sonnet turn whose only instruction is
// "acknowledge in one line and end your turn", was a large line in the budget — 99% of it the cold
// cache-write of the fresh session's floor, with almost no output. The Haiku fork
// could not add information (its input is completed dispatch lifecycle lines;
// rotation only fires when the dispatcher is idle), its cost never reached
// job-costs.ndjson, and it loaded the full CLAUDE.md + MCP set from the
// supervisor's cwd. The digest is now built in code and rides on the next real
// dispatch instead of costing a turn of its own.

import { recentEvents } from "../../lib/event-fts.mjs";
import { readTailLines } from "../../lib/tail-file.mjs";

// Event kinds worth summarizing — the dispatch lifecycle + notable outcomes.
// Deliberately excludes the assistant/tool/user firehose (too noisy for a
// handoff, and the dispatch source+content already says what the work was).
const HANDOFF_KINDS = [
  "dispatcher.dispatching",
  "dispatcher.turn_complete",
  "dispatcher.error",
  "context_guard.compact",
  "context_guard.rotate",
];

// Pull the outgoing session's recent activity. Prefer the events_fts index;
// fall back to tailing events.ndjson if the index yields nothing.
function collectRecentActivity({ agent, eventsPath, limit = 40 }) {
  let rows = [];
  try {
    rows = recentEvents({ limit, agent, kinds: HANDOFF_KINDS });
  } catch { rows = []; }
  if (rows.length) return rows.reverse(); // recentEvents is newest-first; want chronological

  // Fallback: tail the JSONL source of truth.
  try {
    // Bounded tail read — see lib/tail-file.mjs. This fallback silently
    // returned [] once events.ndjson passed V8's max string length, so a
    // degraded events_fts index meant a digest with no activity at all rather
    // than the JSONL-backed fallback this block was written to provide.
    const lines = readTailLines(eventsPath, { limit: 50000, maxBytes: 16 * 1024 * 1024 });
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { continue; }
      if (!HANDOFF_KINDS.includes(ev.kind)) continue;
      out.push({
        ts: ev.ts,
        kind: ev.kind,
        source: ev.source || ev.item?.source || null,
        text: JSON.stringify(ev.result ?? ev).slice(0, 500),
      });
    }
    return out.reverse();
  } catch {
    return [];
  }
}

// Compact each activity row to one line.
function activityLines(rows) {
  return rows.map((r) => {
    const t = (r.ts || "").slice(11, 19);
    const src = r.source ? ` ${r.source}` : "";
    let detail = "";
    if (r.kind === "dispatcher.dispatching") {
      // content lives in the projected text/JSON — pull a short slice.
      // lang-regex-ok: slices a JSON string field out of serialized event JSON, interprets no meaning
      const m = /"content":"((?:[^"\\]|\\.){0,180})/.exec(r.text || "");
      detail = m ? `: ${m[1].replace(/\\n/g, " ").replace(/\\"/g, '"')}` : "";
    } else if (r.kind === "dispatcher.turn_complete") {
      detail = " ✓done";
    } else if (r.kind === "dispatcher.error") {
      detail = " ✗error";
    } else if (r.kind === "context_guard.compact") {
      detail = " (auto-compacted context)";
    } else if (r.kind === "context_guard.rotate") {
      detail = " (context rotation)";
    }
    return `${t} ${r.kind.replace("dispatcher.", "")}${src}${detail}`;
  });
}

// The digest: the distinct recent job sources, then the last dozen lifecycle
// lines, so the fresh session knows which areas the last session touched.
function deterministicDigest(rows) {
  if (!rows.length) return "";
  const sources = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.source && !seen.has(r.source)) { seen.add(r.source); sources.push(r.source); }
  }
  const lines = activityLines(rows).slice(-12);
  const head = sources.length
    ? `Recent work touched: ${sources.slice(0, 8).join(", ")}.`
    : "Recent supervisor activity:";
  return `${head}\n${lines.join("\n")}`;
}

// Build a session-handoff digest for the outgoing session. Never throws.
// Returns { text, reason, fromSessionId, fromDispatches, generatedAt, model } or
// null if there's nothing worth handing off.
export function buildHandoffDigest({ agent, eventsPath, fromSessionId, fromDispatches, reason }) {
  let rows = [];
  try { rows = collectRecentActivity({ agent, eventsPath }); } catch { rows = []; }
  if (!rows.length) return null;
  const text = deterministicDigest(rows);
  if (!text) return null;
  return {
    text,
    reason,
    fromSessionId: fromSessionId || null,
    fromDispatches: fromDispatches ?? null,
    generatedAt: new Date().toISOString(),
    model: "deterministic",
  };
}

// The block prepended (once) to the fresh session's first real dispatch. Framed
// as context only: rotation fires while the dispatcher is idle and restart()
// transfers the queue, so nothing listed here is in flight. Recurring problems
// belong to the nightly system-issue-review and outages to watchdog.sh — the
// System Channel rule in agent/CLAUDE.md — so the block gives the turn
// nothing to act on beyond the task that follows it.
export function formatHandoffBlock(digest) {
  if (!digest?.text) return "";
  const from = digest.fromSessionId ? digest.fromSessionId.slice(0, 8) : "?";
  return (
    "<session-handoff>\n" +
    `Fresh session after a scheduled rotation (${digest.reason}; previous session ${from}, ` +
    `${digest.fromDispatches ?? "?"} dispatches). Background only: what the previous session recently ` +
    "handled, all of it completed. Do not investigate, re-run or alert on anything here; do the task below.\n" +
    `${digest.text}\n` +
    "</session-handoff>\n\n"
  );
}
