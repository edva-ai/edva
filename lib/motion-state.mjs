// motion-state — Is the user moving right now?
//
// One oracle, consumed by the push chokepoint (lib/apns-push.mjs) to
// decide whether a non-urgent alert should buzz now or wait until the user stops.
//
// Why this exists: pings often arrived while the user was walking and could
// not see them. Only urgent pings are allowed while the user is mobile;
// non-urgent ones prefer a stationary moment. A push that lands in a pocket is not a quieter push — it is a
// LOST one, because the banner is gone by the time the phone comes out.
//
// Reads the newest `location_history` row, which is the same signal
// `findme activity` reports. Deliberately NOT a new sensor: the phone already
// writes visit/transit segments with a CoreMotion `activity` verdict, and a
// second source would just be a second thing to drift.
//
// THE CARDINAL RULE: unknown fails OPEN (treated as sendable). A data gap —
// phone off, network down, RLS change, table empty — must never mute Edva.
// The cost of a wrongly-delivered ping is a wasted buzz; the cost of a wrongly
// -held ping is silence that nobody notices until something important is late.

const MOVING_ACTIVITIES = new Set([
  "walking",
  "running",
  "cycling",
  "scooting",
  "driving",
  "automotive",
]);

// A `transit` row only proves motion while it is fresh. Past this, the phone
// has stopped reporting and we know nothing — the user may have arrived 40 minutes
// ago and the arrival segment never landed.
export const TRANSIT_FRESH_MS = 12 * 60 * 1000;

// An OPEN visit (departed_at IS NULL) is a valid stationary signal at any age —
// sitting through a 3-hour dinner is still sitting. But past this bound the
// more likely story is a phone that died mid-visit than a user who has not moved
// since yesterday, so we stop trusting it.
export const OPEN_VISIT_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * Classify a single `location_history` row into a motion state. Pure — takes
 * the row and the clock, touches nothing else, so the whole truth table is
 * testable without a live phone.
 *
 * @param {object|null} row  Newest location_history row, or null if none.
 * @param {number} nowMs     Current epoch ms.
 * @returns {{state: "mobile"|"stationary"|"unknown", reason: string, ageMs: number|null}}
 */
export function classifyMotion(row, nowMs = Date.now()) {
  if (!row) return { state: "unknown", reason: "no location rows", ageMs: null };

  const stamp = row.departed_at || row.arrived_at;
  const t = stamp ? Date.parse(stamp) : NaN;
  const ageMs = Number.isFinite(t) ? nowMs - t : null;

  if (ageMs === null) {
    return { state: "unknown", reason: "unparseable timestamp", ageMs: null };
  }

  // A clock skew between the phone and this host can put the newest row in the
  // future. Treat a small negative age as "now" rather than as a bad row.
  const age = Math.max(0, ageMs);
  const activity = String(row.activity || "unknown").toLowerCase();
  const openVisit = row.segment_type === "visit" && !row.departed_at;

  if (openVisit) {
    if (age > OPEN_VISIT_MAX_MS) {
      return { state: "unknown", reason: `open visit ${Math.round(age / 3.6e6)}h stale`, ageMs: age };
    }
    // The user is parked somewhere. This holds even when the dominant activity reads
    // `walking` — a browsing stop inside a market is still a stop, and it is
    // still a moment where the user can look at a screen.
    return { state: "stationary", reason: "open visit", ageMs: age };
  }

  if (activity === "stationary") {
    return { state: "stationary", reason: "activity=stationary", ageMs: age };
  }

  if (MOVING_ACTIVITIES.has(activity)) {
    if (age > TRANSIT_FRESH_MS) {
      return { state: "unknown", reason: `${activity} but ${Math.round(age / 60000)}m stale`, ageMs: age };
    }
    return { state: "mobile", reason: `activity=${activity}`, ageMs: age };
  }

  return { state: "unknown", reason: `activity=${activity}`, ageMs: age };
}

/**
 * Fetch the newest location row and classify it. Never throws — any failure
 * degrades to `unknown`, which the caller must treat as sendable.
 *
 * @param {object} supabase  Supabase client holding credentials that can read
 *                           location_history. The table holds location data, so
 *                           it needs a restrictive RLS policy; give this reader
 *                           only the credentials that policy allows to read it.
 */
export async function getMotionState(supabase, nowMs = Date.now()) {
  try {
    const { data, error } = await supabase
      .from("location_history")
      .select("segment_type,activity,arrived_at,departed_at")
      .order("arrived_at", { ascending: false })
      .limit(1);
    if (error) return { state: "unknown", reason: `query failed: ${error.message}`, ageMs: null };
    return classifyMotion(data?.[0] ?? null, nowMs);
  } catch (e) {
    return { state: "unknown", reason: `query threw: ${e?.message || e}`, ageMs: null };
  }
}
