#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";

const HUM_STATE_FILE = path.join(
  os.homedir(),
  "dev/merlin/data/hum-state.json",
);

/**
 * Return true if the two [start,end) intervals overlap by more than 1s.
 * Touching edges (end == start) do NOT count as a conflict — a standard
 * back-to-back calendar layout shouldn't emit a conflict signal.
 */
export function overlaps(s1, e1, s2, e2) {
  if (!s1 || !e1 || !s2 || !e2) return false;
  const start = Math.max(s1, s2);
  const end = Math.min(e1, e2);
  return end - start > 1000;
}

/**
 * Filter out events that shouldn't participate in conflict detection:
 *   - transparency === "transparent" (shown as "free" on the calendar — e.g.,
 *     maintenance blocks, shared-calendar events marked free, workout placeholders)
 *   - summary prefixed with any string in `config.calendar.exclude_prefixes`
 *     (default: empty — set to e.g. ["[Shared]"] to filter out shared-calendar
 *     entries that don't block the owner's time)
 * Also filters events without valid start/end so downstream code can rely
 * on numeric timestamps.
 */
export function filterScannableEvents(events, excludePrefixes = []) {
  return (events || [])
    .map((e) => {
      const start = new Date(e?.start?.dateTime || e?.start?.date || 0).getTime();
      const end = new Date(e?.end?.dateTime || e?.end?.date || 0).getTime();
      return { ...e, _start: start, _end: end };
    })
    .filter((e) => {
      if (!e._start || !e._end) return false;
      if (e.transparency === "transparent") return false;
      const summary = String(e.summary || "").trim();
      for (const prefix of excludePrefixes) {
        if (summary.startsWith(prefix)) return false;
      }
      return true;
    });
}

/**
 * Stable pair key: lowercase both summaries, trim, sort alphabetically.
 * Ensures (a,b) and (b,a) dedup to the same key regardless of ordering.
 */
export function pairKey(a, b) {
  const na = String(a || "").trim().toLowerCase();
  const nb = String(b || "").trim().toLowerCase();
  return [na, nb].sort().join("::");
}

/**
 * Read the hum-state.json dedup map for today, pruning any older-date keys.
 * Returns { state, todayKey, todayList } — callers mutate todayList in place
 * then pass state back to writeDedup.
 */
export function readDedup(nowDate = new Date()) {
  const todayKey = nowDate.toISOString().slice(0, 10);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(HUM_STATE_FILE, "utf8"));
  } catch {
    state = {};
  }
  const map = state.calendar_conflict_dedup;
  const pruned = {};
  if (map && typeof map === "object") {
    for (const k of Object.keys(map)) {
      if (k === todayKey && Array.isArray(map[k])) pruned[k] = map[k].slice();
    }
  }
  state.calendar_conflict_dedup = pruned;
  if (!Array.isArray(state.calendar_conflict_dedup[todayKey])) {
    state.calendar_conflict_dedup[todayKey] = [];
  }
  return { state, todayKey, todayList: state.calendar_conflict_dedup[todayKey] };
}

export function writeDedup(state) {
  try {
    fs.writeFileSync(HUM_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[calendar] dedup state write failed: ${e.message}`);
  }
}

// ── main (skip when imported for tests) ───────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { situation: sit } = await readStdinJson();

  try {
    const json = execSync(
      "gog calendar list --account ${MERLIN_OWNER_EMAIL} --days 2 --max 30 --json 2>/dev/null",
      { encoding: "utf8", timeout: 10000 },
    );
    const data = JSON.parse(json);
    const rawEvents = data?.events || data?.items || data || [];
    const events = filterScannableEvents(rawEvents);

    const now = Date.now();
    const conflicts = [];
    const soon = [];

    // Strict O(n^2) overlap over all pairs (n ≤ 30 here; trivial cost).
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i];
        const b = events[j];
        if (overlaps(a._start, a._end, b._start, b._end)) {
          conflicts.push({ a: a.summary, b: b.summary });
        }
      }
    }

    for (const e of events) {
      const minsToStart = Math.round((e._start - now) / 60000);
      if (minsToStart >= 10 && minsToStart <= 60) {
        soon.push({
          summary: e.summary,
          minsToStart,
          location: e.location || null,
        });
      }
    }

    // Dedup pairs already emitted today.
    const { state, todayKey, todayList } = readDedup(new Date());
    const newConflicts = [];
    for (const c of conflicts) {
      const key = pairKey(c.a, c.b);
      if (todayList.includes(key)) continue;
      newConflicts.push({ ...c, _key: key });
    }

    if (newConflicts.length === 0 && soon.length === 0) {
      stampRun("calendar", false);
      emitNull(
        conflicts.length > 0
          ? `all ${conflicts.length} conflict(s) already deduped for ${todayKey}`
          : "no conflicts or imminent",
      );
      process.exit(0);
    }

    let signal, urgency, dedupKey;
    if (newConflicts.length > 0) {
      const c = newConflicts[0];
      signal = `Calendar conflict: "${c.a}" overlaps "${c.b}"`;
      urgency = 0.8;
      dedupKey = `calendar:${(c.a || "").slice(0, 40)}`;
      // Record ALL new pairs so subsequent ticks today don't re-emit any of them.
      for (const nc of newConflicts) {
        if (!todayList.includes(nc._key)) todayList.push(nc._key);
      }
      writeDedup(state);
    } else {
      const s = soon[0];
      signal = `"${s.summary}" starts in ${s.minsToStart}min${
        s.location ? " at " + s.location : ""
      }`;
      const awayFromEvent =
        s.location && sit?.where?.place && !s.location.includes(sit.where.place);
      urgency = awayFromEvent ? 0.7 : 0.4;
      dedupKey = `calendar:${(s.summary || "").slice(0, 40)}`;
    }

    stampRun("calendar", true);
    emit({
      topic: "calendar",
      signal,
      urgency,
      freshness_min: 0,
      dedup_key: dedupKey,
      supporting_data: {
        conflicts: newConflicts.map(({ a, b }) => ({ a, b })),
        soon,
      },
    });
  } catch (e) {
    emitNull(`gog calendar failed: ${e.message}`);
  }
}
