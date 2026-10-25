// ping-media — a harvester's pictures, kept where an agent turn cannot lose them.
//
// THE PROBLEM THIS SOLVES. A harvester emits a finding; the hum tick's agent
// turn reads the candidates, writes the sentence the user sees, and calls
// `hum-ping --findings '<JSON array>'`. That array is composed BY THE MODEL.
// It reliably carries the fields the model is told about and the gates depend
// on — `dedup_key` above all, since exit 8 is built on it — and unreliably
// carries a nested field nobody mentioned. Attaching a photograph to a ping is
// deterministic work (Rule #0b), so it must not silently depend on a model
// choosing to copy `supporting_data.media` through.
//
// So the harvester ALSO stashes its media here, keyed by the same `dedup_key`
// it is about to emit, and `hum-ping` falls back to this file when the findings
// it was handed came through without them. Belt and braces: the passed value
// still wins when present, and this is only consulted when it is not.
//
// Deliberately tiny and self-pruning. It is a hand-off between two processes
// minutes apart, not a store — nothing here needs to survive the day, and an
// unbounded file of image URLs is a liability rather than an asset.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTools } from "./root.cjs";
// Overridable so tests never touch the live hand-off file — same convention as
// HUM_NOVELTY_SIDECAR in lib/hum-novelty.mjs.
const FILE = process.env.EDVA_PING_MEDIA_FILE
  || installTools("data/ping-media.json");
// A harvest and its ping are seconds apart. Twelve hours is absurdly generous
// and still bounds the file at "today's candidates" rather than "forever".
const TTL_H = 12;

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function prune(all) {
  const cutoff = Date.now() - TTL_H * 3600000;
  for (const [k, v] of Object.entries(all)) {
    const ts = Date.parse(v?.ts || "");
    if (!Number.isFinite(ts) || ts < cutoff) delete all[k];
  }
  return all;
}

/**
 * Remember what this candidate looks like, against the key it will be sent under.
 *
 * Never throws. A harvester must not fail to produce a finding because a cache
 * write failed — the ping without its picture is the old behaviour, and the old
 * behaviour is fine.
 */
export function stashMedia(dedupKey, media) {
  if (!dedupKey || !media) return;
  const urls = [media.image_url, media.map_url].filter(Boolean);
  // `choice` — a tappable question card (client ChoicePrompt) for this ping,
  // carried the same way and for the same reason as the pictures.
  if (!urls.length && !media.choice) return;
  try {
    const all = prune(readAll());
    all[String(dedupKey)] = { ts: new Date().toISOString(), media };
    const tmp = `${FILE}.tmp.${process.pid}`;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
    fs.renameSync(tmp, FILE);
  } catch { /* an optimisation, never a dependency */ }
}

/** What the harvester stashed for this key, or null. Never throws. */
export function recallMedia(dedupKey) {
  if (!dedupKey) return null;
  try {
    const row = readAll()[String(dedupKey)];
    if (!row) return null;
    const ts = Date.parse(row.ts || "");
    if (!Number.isFinite(ts) || Date.now() - ts > TTL_H * 3600000) return null;
    return row.media || null;
  } catch { return null; }
}

/**
 * The URLs to attach, in reading order: what it looks like, then where it is.
 * Filters to http(s) so a malformed entry can never land in the bubble as text.
 */
export function mediaUrls(media) {
  if (!media) return [];
  return [media.image_url, media.map_url]
    // lang-regex-ok: a scheme check on a URL this process composed. No reading
    // of anything the user said.
    .filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
}
