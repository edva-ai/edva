// system-issue-gate — decides whether a system-channel alert earns a SAME-DAY
// review dispatch, separate from the nightly system-issue-review pass.
//
// Why this is a module and not three lines inside the trigger's heredoc:
// the suppression logic is load-bearing and the failure mode is expensive.
// Measured over the real 14-day system-channel window on 2026-07-25: of 32
// alerts carrying the 🔴 critical marker, ~17 were the SAME "Max auth is DOWN"
// condition (watchdog re-fires every 30 min while it persists) and 7 were the
// same episode-archive-missing condition. A same-day trigger that only asked
// "is it critical and new since the cursor?" would have dispatched ~17 heavy
// Opus root-cause turns in one night, for one issue that already had a Face-ID
// card in flight. Every clause below exists to stop a specific observed
// duplicate, so each one is covered by a test in system-issue-gate.test.mjs.
//
// Severity marker convention in the system channel (counts from that window):
//   🔴  critical — capability down / data loss            (32)
//   ⚠️  warning — degraded, retrying, needs a look        (82)
//   ✅  recovery — the condition cleared                   (60)
// Only 🔴 escalates same-day. ⚠️ and ✅ ride the nightly pass, which since
// 2026-07-25 reviews auto-healed incidents too rather than closing them unread.

export const CRITICAL_MARKER = "🔴";

// A cluster in one of these states already has someone on it — a fresh alert
// for the same condition is a repeat, not news. `open` is deliberately NOT in
// the set: an open cluster with zero attempts means nobody has looked yet.
const WORKED_STATUSES = new Set(["verifying", "awaiting_approval", "escalated"]);

export function isCritical(content) {
  return typeof content === "string" && content.includes(CRITICAL_MARKER);
}

/** True when a cluster is already being worked, so repeats shouldn't escalate. */
export function isBeingWorked(cluster) {
  if (!cluster || typeof cluster !== "object") return false;
  if (WORKED_STATUSES.has(cluster.status)) return true;
  // An `open` cluster that has already had a fix attempt is also in flight.
  return cluster.status === "open" && Array.isArray(cluster.attempts) && cluster.attempts.length > 0;
}

/**
 * Match alert text against a cluster's match_patterns[].
 * Patterns are authored as "case-insensitive substrings/regexes" (see the
 * playbook's Step 2b), so try regex first and fall back to substring when the
 * stored pattern isn't valid regex — a bad pattern must never throw here and
 * take the whole gate down with it.
 */
/**
 * The readings of one stored pattern that are worth trying.
 *
 * match_patterns[] are hand-authored into system-issue-review-state.json by an
 * agent turn, and that turn reaches the file through a shell layer — which is
 * how three live patterns ended up carrying a doubled backslash, e.g. the
 * calendar-audit wording and the two gmail.googleapis.com DNS patterns. A
 * doubled backslash makes the regex demand a LITERAL backslash, and no
 * system-channel alert has ever contained one, so the pattern compiles fine
 * and then matches nothing at all.
 *
 * That is the worst failure available to this file: the cluster stops
 * recognising its own recurrences, which at verify time reads as "the fix
 * worked", and the next firing forms a duplicate cluster instead of landing on
 * the one already being worked.
 *
 * Found on a calendar-audit cluster whose
 * flagship alert wording ("N calendar event(s) with attendees Edva cannot
 * account for") had gone unmatched by its own cluster while that cluster sat
 * in `verifying` and due for closure.
 *
 * So: try the pattern as written, and when it carries an escaped backslash
 * also try the once-de-escaped reading. This can only ADD matches, and only
 * for patterns that as written match nothing — see
 * tests/system-issue-gate-escaped-patterns.test.mjs.
 */
function patternVariants(p) {
  const out = [p];
  if (p.includes("\\\\")) out.push(p.replace(/\\\\/g, "\\"));
  return out;
}

/**
 * Stored patterns that compile but can never match alert text. Exported so a
 * state-hygiene pass can audit match_patterns[] in one call rather than
 * rediscovering the escaping hazard from a missed match.
 */
export function deadPatterns(cluster) {
  const pats = Array.isArray(cluster?.match_patterns) ? cluster.match_patterns : [];
  return pats.filter((p) => typeof p === "string" && p.includes("\\\\"));
}

export function matchesCluster(content, cluster) {
  if (typeof content !== "string") return false;
  const pats = Array.isArray(cluster?.match_patterns) ? cluster.match_patterns : [];
  return pats.some((p) => {
    if (typeof p !== "string" || !p.trim()) return false;
    return patternVariants(p).some((v) => {
      try {
        // lang-regex-ok: a cluster's own stored match_patterns over system-alert text, not the user's words
        return new RegExp(v, "i").test(content);
      } catch {
        return content.toLowerCase().includes(v.toLowerCase());
      }
    });
  });
}

/**
 * Collapse an alert to a stable identity so the 17 near-identical "Max auth is
 * DOWN" firings share one signature. Strips the things that vary per firing
 * (timestamps, counts, ids, durations) and keeps the prose that names the
 * condition — the same stable-parts-only principle the playbook applies to
 * match_patterns.
 */
export function signature(content) {
  if (typeof content !== "string") return "";
  return content
    .replace(/\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/g, "#DATE")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days|%|x|×)\b/gi, "#DUR")
    .replace(/\b[0-9a-f]{7,}\b/gi, "#ID")
    .replace(/\d+/g, "#N")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

/**
 * Pick the alerts that earn a same-day dispatch.
 *
 * @param {object}   o
 * @param {Array}    o.rows        edva_messages rows {role, content, created_at}
 * @param {?string}  o.cursor      state.cursor_ts — alerts at or before this were already seen
 * @param {Array}    o.clusters    state.clusters[]
 * @param {object}   o.dispatched  {signature: ISO} of prior same-day dispatches
 * @param {number}   o.now
 * @param {number}   o.dedupWindowMs  re-escalate the same signature only after this long
 * @param {number}   o.max         hard cap on escalations per evaluation
 * @returns {{escalate: Array, suppressed: object}}
 */
export function selectCriticalEscalations({
  rows = [],
  cursor = null,
  clusters = [],
  dispatched = {},
  now = Date.now(),
  dedupWindowMs = 24 * 3600e3,
  max = 1,
} = {}) {
  const suppressed = { not_critical: 0, not_fresh: 0, being_worked: 0, already_dispatched: 0, over_cap: 0 };
  const escalate = [];
  const seenThisPass = new Set();

  const fresh = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || r.role !== "assistant" || typeof r.content !== "string" || !r.content.trim()) return false;
    if (cursor && !(String(r.created_at) > String(cursor))) {
      suppressed.not_fresh++;
      return false;
    }
    return true;
  });

  for (const row of fresh) {
    if (!isCritical(row.content)) {
      suppressed.not_critical++;
      continue;
    }
    if (clusters.some((c) => isBeingWorked(c) && matchesCluster(row.content, c))) {
      suppressed.being_worked++;
      continue;
    }
    const sig = signature(row.content);
    const prior = dispatched?.[sig];
    if (prior && now - Date.parse(prior) < dedupWindowMs) {
      suppressed.already_dispatched++;
      continue;
    }
    if (seenThisPass.has(sig)) {
      suppressed.already_dispatched++;
      continue;
    }
    if (escalate.length >= max) {
      suppressed.over_cap++;
      continue;
    }
    seenThisPass.add(sig);
    escalate.push({ signature: sig, created_at: row.created_at, sample: row.content.slice(0, 200) });
  }

  return { escalate, suppressed };
}

/** Drop dedup entries older than the window so the marker file can't grow forever. */
export function pruneDispatched(dispatched = {}, now = Date.now(), keepMs = 7 * 24 * 3600e3) {
  const out = {};
  for (const [sig, ts] of Object.entries(dispatched || {})) {
    const t = Date.parse(ts);
    if (Number.isFinite(t) && now - t < keepMs) out[sig] = ts;
  }
  return out;
}
