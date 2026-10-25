// hum-intent — what the user is trying to DO, assembled for the harvest.
//
// Hum's sensors are all state-change detectors: they answer "did X move?" very
// well and "what is the user up to?" not at all. That gap is why an arrival could
// only ever produce a retrospective question — "you were near <café> for an
// hour, did you stop?" — instead of something useful on the way in. Knowing the user
// is walking toward a market they already told Edva about is the difference
// between logging the route and being any help on it.
//
// Two sources, both already maintained by the rest of Edva:
//
//   plan          today's `trip_day_plans` row — the stops the user agreed to. This
//                 is intent already committed to, in structured form.
//   recent_chat   the last stretch of the user's own messages. This is intent stated
//                 in passing ("heading to the flea market after lunch") that
//                 exists nowhere else.
//
// This module deliberately does NOT interpret either one. Per Rule #0b, code
// owns geometry and a model owns language: what the user MEANT by "we'll head over
// after" is decided inside the harvester's own model call, which is reading
// this text anyway. Extracting intent here with string matching would be the
// exact failure that rule exists to prevent.
//
// Fail-open everywhere: any source that errors contributes nothing, and a
// missing intent block simply means the harvest behaves as it did before.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const HOME = os.homedir();
const ENV_FILE = installTools(".env");
const SUPABASE_URL = `https://${createRequire(import.meta.url)("./instance.cjs").instance().supabase_project}.supabase.co`;

function serviceKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      // Structure, not language — a KEY=value line in a machine-written env
      // file. lang-regex-ok: parsing a .env line, not deciding what the user meant.
      const m = line.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/);
      if (m) return m[1].trim();
    }
  } catch {}
  return "";
}

function rest(table, params, { timeout = 6000 } = {}) {
  const key = serviceKey();
  if (!key) return [];
  const url = `${SUPABASE_URL}/rest/v1/${table}?${new URLSearchParams(params)}`;
  try {
    const raw = execFileSync("curl", [
      "-s", "-H", `apikey: ${key}`, "-H", `Authorization: Bearer ${key}`, url,
    ], { encoding: "utf8", timeout });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Today's agreed plan, in the trip's own timezone when there is one. */
function todaysPlan(localDate) {
  const rows = rest("trip_day_plans", { date: `eq.${localDate}`, limit: "1" });
  const row = rows[0];
  if (!row) return null;
  // The manifest carries the rendered stops; shapes have varied across
  // versions of the renderer, so take what is there and never assume.
  const m = row.manifest || {};
  const stops = Array.isArray(m.stops) ? m.stops
    : Array.isArray(m.blocks) ? m.blocks
    : Array.isArray(m) ? m : [];
  return {
    date: row.date,
    area: row.area ?? null,
    title: row.title ?? null,
    stops: stops.slice(0, 12).map((s) => ({
      name: s.name ?? s.title ?? s.place ?? null,
      when: s.when ?? s.time ?? s.start ?? null,
      kind: s.kind ?? s.type ?? null,
      note: typeof s.note === "string" ? s.note.slice(0, 200) : null,
      lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : null,
      lon: Number.isFinite(Number(s.lon ?? s.lng)) ? Number(s.lon ?? s.lng) : null,
    })).filter((s) => s.name),
  };
}

/**
 * The user's own recent messages, verbatim. Handed to the harvester's model as
 * raw text — this is the "mentioned it in passing" channel, and the whole
 * point is that no code here decides what any of it means.
 */
function recentChat(windowMin) {
  const since = new Date(Date.now() - windowMin * 60000).toISOString();
  const rows = rest("edva_messages", {
    role: "eq.user",
    created_at: `gte.${since}`,
    order: "created_at.desc",
    limit: "25",
    select: "created_at,content",
  });
  return rows
    .map((r) => ({ at: r.created_at, text: String(r.content || "").slice(0, 400) }))
    .filter((r) => r.text)
    .reverse();
}

/**
 * @param {object} opts
 *   @param {string} opts.localDate  YYYY-MM-DD in the user's current local tz
 *   @param {number} [opts.chatWindowMin]  how far back to read the user's messages
 */
export function buildIntent({ localDate, chatWindowMin = 240 } = {}) {
  const intent = { plan: null, recent_chat: [], errors: [] };
  try { intent.plan = todaysPlan(localDate); }
  catch (e) { intent.errors.push(`plan: ${e.message}`); }
  try { intent.recent_chat = recentChat(chatWindowMin); }
  catch (e) { intent.errors.push(`chat: ${e.message}`); }
  return intent;
}

export default { buildIntent };
