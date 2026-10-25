"use strict";
/**
 * clock-jobs — shared timezone-resolution + local-time-to-home-zone conversion
 * for the clock-anchored jobs registered in data/clock-jobs.json
 * (morning-digest, daily-summary, etc.). Used by:
 *   - bin/cron-tz-sync, which rewrites their crontab MM/HH/DOW fields
 *     nightly so they fire at the user's actual local clock time.
 *   - `edva doctor`'s tasks.json-vs-crontab check, which needs to know the
 *     CURRENTLY-expected crontab schedule to validate against — cron-tz-sync
 *     intentionally diverges crontab times from tasks.json's nominal
 *     `schedule` field whenever the user isn't in the instance's home zone, so a literal
 *     comparison against tasks.json false-flags every day the user is traveling.
 */

const fs = require("fs");
const path = require("path");
const { installRoot } = require("./root.cjs");

const EDVA = installRoot();
const JOBS_FILE = path.join(EDVA, "data/clock-jobs.json");
const USER_TZ_FILE = path.join(EDVA, "data/user-timezone.json");
// The installation's home zone (lib/instance.cjs tz; the host's zone when
// unset). It is also the zone the crontab runs in: the target zone of
// localToHomeZone.
const DEFAULT_TZ = require("./instance.cjs").instanceValue("tz");

function loadClockJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function confirmedTz() {
  try {
    const raw = JSON.parse(fs.readFileSync(USER_TZ_FILE, "utf8"));
    if (!raw?.timezone) return null;
    const ageMs = Date.now() - new Date(raw.updated_at).getTime();
    if (ageMs > 36 * 3600 * 1000) return null;
    return raw.timezone;
  } catch {
    return null;
  }
}

// The zone the user is planned to be in right now, from the installation's own
// travel timeline: the optional hook lib/_ext/clock-jobs.cjs exports
// plannedTz() → an IANA zone or null. Without the hook there is no planned
// zone; a hook that throws counts as none.
function plannedTz() {
  try {
    const hook = path.join(__dirname, "_ext", "clock-jobs.cjs");
    if (!fs.existsSync(hook)) return null;
    const ext = require(hook);
    return typeof ext.plannedTz === "function" ? ext.plannedTz() || null : null;
  } catch {
    return null;
  }
}

/** @param {(confirmed: string, planned: string) => void} [onDiscrepancy] */
function resolveTz(onDiscrepancy) {
  const confirmed = confirmedTz();
  const planned = plannedTz();
  if (confirmed && planned && confirmed !== planned && onDiscrepancy) {
    onDiscrepancy(confirmed, planned);
  }
  if (confirmed) return { tz: confirmed, source: "confirmed" };
  if (planned) return { tz: planned, source: "planned" };
  return { tz: DEFAULT_TZ, source: "default" };
}

/** Offset string (e.g. "+02:00") for `tz` on `dateStr` (YYYY-MM-DD), DST-aware. */
function offsetFor(tz, dateStr) {
  const approx = new Date(`${dateStr}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(approx);
  const raw = parts.find(p => p.type === "timeZoneName")?.value || "GMT+0";
  const m = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${m[3] || "00"}`;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Convert a local HH:MM in `tz` to the home zone's {hour, minute, dow}.
 *
 * `dow` (0=Sun..6=Sat) is the weekday IN `tz` that a weekly clock job is
 * anchored to (e.g. a weekly job that fires Friday-local). When omitted (daily
 * jobs), the conversion uses today's date in `tz`, which is fine since only
 * hour/minute matter. When given, "today in tz" is the WRONG anchor for a
 * weekly job whenever the caller runs on a day that isn't itself `dow` in
 * `tz` — which, once the user is outside the home zone, is most of the time
 * (cron-tz-sync runs nightly, not just on the target weekday; `edva
 * doctor` can run any day at all). Anchoring to literal "today" in that case
 * computes the home-zone weekday of a WRONG source day, e.g. it flipped a
 * Friday "50 2 * * 5" schedule toward whatever weekday the crontab happened to
 * be rewritten on, silently drifting a weekly job off Friday every week the
 * user travels (caught before the first bad nightly rewrite). Fix:
 * shift the reference date to the nearest occurrence (±3 days) of `dow` in
 * `tz` first, so the conversion is always anchored to the correct weekday
 * regardless of which day this function is actually called on.
 */
function localToHomeZone(tz, hhmm, dow) {
  let dateInTz = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  if (dow != null) {
    const curDow = DOW[new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date())];
    const forward = ((dow - curDow) % 7 + 7) % 7;
    const shiftDays = forward <= 3 ? forward : forward - 7;
    if (shiftDays !== 0) {
      const anchor = new Date(`${dateInTz}T12:00:00Z`); // noon UTC: safely mid-day in any tz offset
      anchor.setUTCDate(anchor.getUTCDate() + shiftDays);
      dateInTz = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(anchor);
    }
  }
  const offset = offsetFor(tz, dateInTz);
  const instant = new Date(`${dateInTz}T${hhmm}:00${offset}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(instant);
  const get = t => parts.find(p => p.type === t).value;
  return { hour: get("hour").padStart(2, "0"), minute: get("minute").padStart(2, "0"), dow: DOW[get("weekday")] };
}

/** Short label for the home zone, for log lines ("PT" for America/Los_Angeles,
 *  "CT" for Chicago); falls back to the short offset form ("GMT+3") where
 *  Intl has no short generic name, and to the zone id itself. */
function homeZoneLabel(zone = DEFAULT_TZ, at = new Date()) {
  for (const style of ["shortGeneric", "short"]) {
    try {
      const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style })
        .formatToParts(at).find(p => p.type === "timeZoneName")?.value || "";
      if (name && !/\s/.test(name)) return name;
    } catch {}
  }
  return zone;
}

module.exports = { loadClockJobs, resolveTz, localToHomeZone, homeZoneLabel, JOBS_FILE, USER_TZ_FILE };
