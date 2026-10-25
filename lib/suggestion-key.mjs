// suggestion-key.mjs — canonical identity for hum suggestions.
//
// Every advisory hum candidate (a restaurant, an exhibit, an album, a show)
// gets a stable subject_key derived from its content, NOT from its source URL
// or an LLM-generated subject string. Same-restaurant-different-URL must
// produce the same key, so suggestion-history can answer "have we surfaced
// this before, and how did the user respond?"
//
// Three lanes are NOT advisory and don't need canonical recall (their dedup
// stays URL/event-id based): news, weather, calendar, tasks, watchdog,
// property lanes, email_followups, exercise, testflight_crashes, health,
// secret_failures, project lanes, family, stocks, serendipity, travel, crossref.
// For those, canonicalKey() returns null and callers fall through to the
// existing dedup_key path.

import { createRequire } from "node:module";

// This installation's own normalisation (agent/local/config/suggestion-key.json):
//   event_lanes        — extra lanes keyed like "concerts" (<lane>:<artist>[:<venue>]);
//   name_dash_suffixes — what may follow " — " after a place name and is dropped
//                        (alternation pieces, e.g. a home-city tag; full list);
//   name_city_tags     — trailing city tags dropped from a place name;
//   area_city_tags     — trailing ", <borough/city>" tags dropped from an area.
// The pieces are regex alternation fragments matched case-insensitively.
const LOCAL = createRequire(import.meta.url)("./instance.cjs").localConfig("suggestion-key", {
  event_lanes: [],
  name_dash_suffixes: ["reopen.*", "relocat.*", "new location"],
  name_city_tags: [],
  area_city_tags: [],
});
const EVENT_LANES = new Set(["concerts", ...LOCAL.event_lanes]);

const ADVISORY_LANES = new Set([
  "dining",
  "music",
  "art",
  "talks",
  "ideas",
  "watchlist",
  ...EVENT_LANES,
  "location_context",
]);
const NAME_DASH_RE = new RegExp(`\\s*[—–-]\\s*(${LOCAL.name_dash_suffixes.join("|")}).*$`, "i");
const NAME_CITY_RE = LOCAL.name_city_tags.length ? new RegExp(`\\s+(${LOCAL.name_city_tags.join("|")})\\s*$`, "i") : null;
const AREA_CITY_RE = LOCAL.area_city_tags.length ? new RegExp(`,\\s*(${LOCAL.area_city_tags.join("|")})\\s*$`, "i") : null;

export function isAdvisoryLane(lane) {
  return ADVISORY_LANES.has(String(lane || "").toLowerCase());
}

// Lowercase, strip diacritics, collapse to [a-z0-9-]+, dedupe dashes.
export function slug(s) {
  if (s == null) return "";
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Restaurant/place name normalizer. Strips city tags, parentheticals, common
// suffixes that vary by source (e.g. a city tag, "(<neighbourhood>)", "— <area>
// revamp"). Keeps the core establishment name.
export function normalizeName(name) {
  if (!name) return "";
  let n = String(name);
  n = n.replace(/\s*\([^)]*\)\s*/g, " ");
  n = n.replace(NAME_DASH_RE, "");
  if (NAME_CITY_RE) n = n.replace(NAME_CITY_RE, "");
  n = n.trim();
  return slug(n);
}

// Neighborhood normalizer. Strips street numbers, "neighborhood,"-style
// suffixes, and borough tags so "<Area> (<street address>)" / "<Area>" /
// "<Area>, <Borough>" all collapse.
export function normalizeArea(area) {
  if (!area) return "";
  let n = String(area);
  n = n.replace(/\s*\([^)]*\)\s*/g, " ");
  if (AREA_CITY_RE) n = n.replace(AREA_CITY_RE, "");
  n = n.split(",")[0]; // first comma-separated component is the neighborhood
  return slug(n);
}

// Derive a canonical subject_key for a single hum-finding-shape candidate.
// `lane` is the harvester/topic name. `cand` is the finding object as written
// to hum-feedback.jsonl (`{topic, signal, supporting_data:{candidate, ...}}`).
//
// Returns a key like "dining:<name>:<neighbourhood>" or null when the lane is
// non-advisory or not enough fields are present to identify the subject.
export function canonicalKey(lane, cand) {
  if (!cand) return null;
  const ln = String(lane || cand.topic || "").toLowerCase();
  if (!isAdvisoryLane(ln)) return null;
  const kind = EVENT_LANES.has(ln) ? "concerts" : ln;

  // Supporting_data.candidate is the structured form; fall back to the finding
  // top level for older entries.
  const c = cand.supporting_data?.candidate || cand;

  switch (kind) {
    case "dining": {
      const name = normalizeName(c.name || parseNameFromSignal(cand.signal));
      const area = normalizeArea(c.neighborhood || c.area || c.city);
      if (!name) return null;
      return `dining:${name}${area ? `:${area}` : ""}`;
    }
    case "music": {
      const artist = slug(c.artist || c.who);
      // For tours/albums/shows, prefer a stable work id: title for albums,
      // "tour-YYYY" for tours that share a name across years.
      const work = slug(c.title || c.work || c.album || c.tour || (c.kind === "tour" ? `tour-${(c.year||"").toString().slice(0,4)}` : ""));
      if (!artist) return null;
      return `music:${artist}${work ? `:${work}` : ""}`;
    }
    case "art": {
      const venue = slug(c.venue || c.gallery || c.museum);
      const title = slug(c.title || c.exhibit || c.show);
      if (!venue && !title) return null;
      return `art:${venue || "unknown"}:${title || "unknown"}`;
    }
    case "talks": {
      // Talks (Moth, lectures-on-tap, storytelling) already have stable
      // upstream IDs. Use them verbatim under a lane prefix.
      const id = c.id || c.upstream_id || cand.supporting_data?.id;
      if (id) return `talks:${slug(id)}`;
      const venue = slug(c.venue);
      const title = slug(c.title);
      const date = (c.date || "").slice(0, 10);
      if (title && date) return `talks:${title}:${date}${venue ? `:${venue}` : ""}`;
      return null;
    }
    case "ideas": {
      const id = c.idea_id || cand.supporting_data?.idea_id;
      return id ? `ideas:${slug(id)}` : null;
    }
    case "watchlist": {
      const title = slug(c.title || c.show || c.movie);
      return title ? `watchlist:${title}` : null;
    }
    case "concerts": {
      const artist = slug(c.artist || c.show || c.title);
      const venue = slug(c.venue);
      if (!artist) return null;
      return `${ln}:${artist}${venue ? `:${venue}` : ""}`;
    }
    case "location_context": {
      // Location prompts are about places. Stable id = place_name (when known)
      // or the Supabase visit row_id.
      const place = slug(c.place_name || c.place || c.matched_name);
      const rowId = c.row_id || cand.supporting_data?.row_id;
      if (rowId) return `location_context:row-${slug(rowId)}`;
      return place ? `location_context:${place}` : null;
    }
    default:
      return null;
  }
}

// Heuristic: pull the leading restaurant/show name out of a finding.signal
// like "<Name> $$$ (<cuisine>) <neighbourhood> — ...". Only uses the
// high-confidence delimiters `$` (price tier) and `(` (cuisine). Compressed
// signals like "<Name> <cuisine> <neighbourhood> — ex-<restaurant> chef" don't match —
// the caller should fall back to a URL fingerprint or skip. Returns undefined
// when no structural delimiter is present.
export function parseNameFromSignal(signal) {
  if (!signal) return undefined;
  const s = String(signal);
  let m = s.match(/^([^$(—]+?)\s*\$+/);
  if (m) return m[1].trim();
  m = s.match(/^([^(—]+?)\s*\(/);
  if (m) return m[1].trim();
  return undefined;
}

// Derive a display string for a candidate, used in recall blocks shown to
// scout LLMs. Stable enough that two surfacings of the same subject_key
// produce the same display.
export function canonicalDisplay(lane, cand) {
  if (!cand) return "";
  const c = cand.supporting_data?.candidate || cand;
  const ln = String(lane || cand.topic || "").toLowerCase();
  switch (EVENT_LANES.has(ln) ? "concerts" : ln) {
    case "dining": {
      const name = c.name || parseNameFromSignal(cand.signal) || "(unknown)";
      const area = c.neighborhood || c.area || c.city || "";
      const cuisine = c.cuisine ? ` ${c.cuisine}` : "";
      return area ? `${name} (${area}${cuisine})` : name;
    }
    case "music":
      return `${c.artist || "?"} — ${c.title || c.work || c.album || c.tour || c.kind || "?"}`;
    case "art":
      return `${c.title || "?"} @ ${c.venue || "?"}`;
    case "talks":
      return `${c.title || "?"} @ ${c.venue || "?"}${c.date ? ` (${c.date})` : ""}`;
    case "ideas":
      return c.subject || c.title || c.idea_id || "(idea)";
    case "watchlist":
      return c.title || "(title?)";
    case "concerts":
      return `${c.artist || c.show || c.title || "?"} @ ${c.venue || "?"}`;
    case "location_context":
      return c.place_name || c.place || c.matched_name || "(place)";
    default:
      return cand.signal?.slice(0, 80) || "";
  }
}

// Compact attributes payload — fields recall layers/filters care about.
// Trimmed so we don't accidentally write huge bodies to the ledger (the raw
// finding is still in hum-feedback.jsonl for audit).
export function canonicalAttrs(lane, cand) {
  if (!cand) return {};
  const c = cand.supporting_data?.candidate || cand;
  const ln = String(lane || cand.topic || "").toLowerCase();
  const out = {};
  if (ln === "dining") {
    if (c.name) out.name = c.name;
    if (c.neighborhood) out.neighborhood = c.neighborhood;
    if (c.cuisine) out.cuisine = c.cuisine;
    if (c.cost_tier) out.cost_tier = c.cost_tier;
    if (c.price) out.price = c.price;
    if (c.url) out.url = c.url;
  } else if (ln === "music") {
    for (const k of ["artist", "title", "work", "album", "tour", "kind", "url", "year"]) if (c[k]) out[k] = c[k];
  } else if (ln === "art") {
    for (const k of ["title", "venue", "location", "ends", "url"]) if (c[k]) out[k] = c[k];
  } else if (ln === "talks") {
    for (const k of ["title", "venue", "date", "price", "url"]) if (c[k]) out[k] = c[k];
  } else if (ln === "watchlist") {
    for (const k of ["title", "type", "category", "rating", "year"]) if (c[k]) out[k] = c[k];
  } else if (ln === "ideas") {
    for (const k of ["category", "rationale", "why_now"]) if (c[k]) out[k] = c[k];
  } else if (EVENT_LANES.has(ln)) {
    for (const k of ["artist", "show", "title", "venue", "date", "url"]) if (c[k]) out[k] = c[k];
  } else if (ln === "location_context") {
    for (const k of ["place_name", "place", "lat", "lon", "row_id"]) if (c[k]) out[k] = c[k];
  }
  return out;
}
