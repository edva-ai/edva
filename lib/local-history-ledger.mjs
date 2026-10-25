// local-history-ledger.mjs — what hum has already told the user about the ground
// they stand on, and whether a local explanation is still worth delivering.
//
// Two rules, both the user's, both enforced in code:
//
//   1. NEVER THE SAME THING TWICE. One landmark went out three days running:
//      three wordings, two Wikipedia editions, one landmark. A dedup key
//      built from model-written text cannot catch that. This ledger keys on
//      identities code owns — the Wikipedia page (`wp:<lang>:<pageid>`), the
//      OSM element (`osm:<type>/<id>`), the Wikidata QID that joins the
//      per-language articles about one subject — and, as a backstop for two
//      sources that share no id, on POSITION: a subject within SAME_SPOT_M of
//      one already told is the same subject.
//
//   2. ONLY WHILE THE USER IS THERE. An explanation is worth floating only
//      while the user is within 300 m of the point. Checked at
//      harvest (candidates past PROXIMITY_M are dropped by the lore sources)
//      and again at DELIVERY (hum-ping, and ping-flush for an alert the motion
//      gate parked), against the user's newest fix. Too stale to know counts as away.
//
// Rule #0b: ids, coordinates, timestamps. Nothing here reads language.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const DATA = installTools("data");
export const LEDGER_PATH = process.env.LOCAL_HISTORY_LEDGER || path.join(DATA, "local-history-sent.json");
export const PENDING_PATH = process.env.LOCAL_HISTORY_PENDING || path.join(DATA, "local-history-pending.json");

export const PROXIMITY_M = 300;
// Past this, the newest fix says where the user WAS. A still phone stops emitting,
// so this is generous; beyond it we do not know, and an explanation of a
// building the user may have left an hour ago is the failure being prevented.
export const STALE_FIX_MIN = 30;
export const SAME_SPOT_M = 30;
export const WINDOW_DAYS = 365;

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const num = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * The title as a key, in the same shape the old `nearby:<slug>` dedup keys
 * used (lowercase, runs of non-alphanumerics → "-", 50 chars), so a subject
 * told before this ledger existed is still recognised by name. A title with
 * no Latin letters (a non-Latin-script article) has no slug and relies on its ids and
 * position.
 */
export function titleSlug(t) {
  // lang-regex-ok: normalising a Wikipedia/OSM TITLE into a key — machine data.
  const s = String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return s.length >= 4 ? s : null;
}

/** Every stable identity a subject carries. */
export function identitiesOf(s) {
  const out = new Set();
  for (const k of ["id", "qid", "osm_id", "wp_id"]) if (s?.[k]) out.add(String(s[k]));
  for (const k of Array.isArray(s?.ids) ? s.ids : []) if (k) out.add(String(k));
  const slug = titleSlug(s?.title);
  if (slug) out.add(`title:${slug}`);
  return [...out];
}

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1) + "\n");
  fs.renameSync(tmp, p);
}

export function readLedger(p = LEDGER_PATH) {
  const v = readJson(p, []);
  return Array.isArray(v) ? v : [];
}

/**
 * Has the user already been told about this subject? Pure given `entries`.
 * @returns {{told: boolean, reason?: string, entry?: object}}
 */
export function alreadyTold(subject, { entries = readLedger(), now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const ids = new Set(identitiesOf(subject));
  const lat = num(subject?.lat), lon = num(subject?.lon);
  for (const e of entries) {
    if (e?.retracted) continue;
    const t = Date.parse(e?.sent_at || "");
    if (Number.isFinite(t) && now - t > windowDays * 86400000) continue;
    const shared = identitiesOf(e).find((k) => ids.has(k));
    if (shared) return { told: true, reason: `same identity ${shared} (told ${e.sent_at})`, entry: e };
    const elat = num(e?.lat), elon = num(e?.lon);
    if (lat != null && lon != null && elat != null && elon != null) {
      const d = haversineM(lat, lon, elat, elon);
      if (d <= SAME_SPOT_M) return { told: true, reason: `same spot as "${e.title}" (${Math.round(d)}m, told ${e.sent_at})`, entry: e };
    }
  }
  return { told: false };
}

/** Record a delivered explanation. */
export function recordTold({ ping_id, message_id = null, subject, sent_at = new Date().toISOString() }, p = LEDGER_PATH) {
  const entries = readLedger(p);
  entries.push({
    ping_id, message_id, sent_at,
    title: subject?.title || null,
    ids: identitiesOf(subject),
    lat: num(subject?.lat), lon: num(subject?.lon),
  });
  writeJson(p, entries.slice(-2000));
}

/** Un-count an explanation that was withdrawn before the user could see it. */
export function retractTold(ping_id, p = LEDGER_PATH) {
  const entries = readLedger(p);
  let hit = false;
  for (const e of entries) if (e.ping_id === ping_id && !e.retracted) { e.retracted = new Date().toISOString(); hit = true; }
  if (hit) writeJson(p, entries);
  return hit;
}

/**
 * Should a local explanation reach the user now? Pure.
 * @param {{lat,lon}} subject  the thing explained
 * @param {{lat,lon,at}|null} fix  the user's newest position
 */
export function deliveryVerdict({ subject, fix, now = Date.now(), proximityM = PROXIMITY_M, staleMin = STALE_FIX_MIN }) {
  const slat = num(subject?.lat), slon = num(subject?.lon);
  if (slat == null || slon == null) return { ok: false, reason: "subject has no coordinates — cannot know the user is near it" };
  if (!fix || num(fix.lat) == null || num(fix.lon) == null) return { ok: false, reason: "no position for the user" };
  const t = Date.parse(fix.at || "");
  if (!Number.isFinite(t)) return { ok: false, reason: "position has no timestamp" };
  const ageMin = (now - t) / 60000;
  if (ageMin > staleMin) return { ok: false, reason: `newest fix is ${Math.round(ageMin)}m old (> ${staleMin}m) — position unknown` };
  const d = haversineM(num(fix.lat), num(fix.lon), slat, slon);
  if (d > proximityM) return { ok: false, reason: `the user is ${Math.round(d)}m from it (> ${proximityM}m)`, distance_m: Math.round(d) };
  return { ok: true, reason: `${Math.round(d)}m away, fix ${Math.round(ageMin)}m old`, distance_m: Math.round(d) };
}

/** The user's newest position from location_history: newest of arrived/departed stamps. */
export async function latestFix({ fetchImpl = fetch, env = process.env } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const url = `https://${createRequire(import.meta.url)("./instance.cjs").instance().supabase_project}.supabase.co/rest/v1/location_history`
    + "?select=latitude,longitude,arrived_at,departed_at&order=arrived_at.desc&limit=8";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetchImpl(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return newestFix(await res.json());
  } catch { return null; }
}

/** Pure: the freshest positioned stamp among rows. */
export function newestFix(rows) {
  let best = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const lat = num(r.latitude), lon = num(r.longitude);
    if (lat == null || lon == null) continue;
    for (const s of [r.arrived_at, r.departed_at]) {
      const t = Date.parse(s || "");
      if (Number.isFinite(t) && (!best || t > best.t)) best = { lat, lon, t };
    }
  }
  return best ? { lat: best.lat, lon: best.lon, at: new Date(best.t).toISOString() } : null;
}

// ── alerts the motion gate parked ─────────────────────────────────────────
// The message is in the app the moment hum-ping sends it; only the ALERT is
// held while the user walks (lib/ping-hold.mjs). hum-ping notes each local
// explanation here by message id, so ping-flush can re-check distance before
// buzzing and withdraw one the user has walked away from.

export function rememberPending({ message_id, ping_id, subject }, p = PENDING_PATH) {
  if (!message_id) return;
  const m = readJson(p, {});
  const now = Date.now();
  for (const [k, v] of Object.entries(m)) if (Date.parse(v.at) < now - 6 * 3600000) delete m[k];
  m[message_id] = { ping_id, lat: num(subject?.lat), lon: num(subject?.lon), title: subject?.title || null, at: new Date(now).toISOString() };
  writeJson(p, m);
}

export function readPending(p = PENDING_PATH) {
  const m = readJson(p, {});
  return m && typeof m === "object" ? m : {};
}

export function forgetPending(messageIds, p = PENDING_PATH) {
  const m = readPending(p);
  let changed = false;
  for (const id of messageIds) if (id in m) { delete m[id]; changed = true; }
  if (changed) writeJson(p, m);
}

/** Is this finding a local explanation (the local-history pool)? */
export function isLocalHistory(f) {
  return Boolean(f && (f.topic === "nearby" || f.lane === "nearby")
    && (f.supporting_data?.kind === "factoid" || f.budget_pool === "local_history" || f.supporting_data?.budget_pool === "local_history"));
}

/**
 * Split parked alerts into those still worth buzzing and local explanations
 * the user has walked away from. Pure.
 * @returns {{keep: object[], withdraw: Array<{entry, pending, reason}>}}
 */
export function splitWithdrawn(queue, pending, fix, now = Date.now()) {
  const keep = [], withdraw = [];
  for (const e of queue || []) {
    const p = e?.messageId ? pending?.[e.messageId] : null;
    if (!p) { keep.push(e); continue; }
    const v = deliveryVerdict({ subject: p, fix, now });
    if (v.ok) keep.push(e);
    else withdraw.push({ entry: e, pending: p, reason: v.reason });
  }
  return { keep, withdraw };
}
