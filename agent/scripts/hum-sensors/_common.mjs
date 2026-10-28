// Shared helpers for hum SENSORS.
//
// A sensor is a small ES module that answers exactly one question — "did X just
// change?" — and returns zero or more events. It is NOT a harvester:
//
//   harvester (hum-harvesters/*.mjs)   "is there something worth saying about X?"
//                                      runs inside the agent turn, may call an
//                                      LLM or the web, produces a candidate.
//   sensor    (hum-sensors/*.mjs)      "did something just happen?"
//                                      runs in the always-on hum-sense daemon,
//                                      must be cheap and local, produces an event.
//
// Contract:
//
//   export const meta = { name, lanes, ... }          // documentation; the
//                                                     // registry is authoritative
//   export default async function detect(ctx) => Event[] | Event | null
//
// `ctx` carries:
//   { now, nowMs, tz, local, memo, setMemo, sh, config, event }
//
//   memo / setMemo   per-sensor persisted blob (in hum-sense-state.json). This
//                    is how edge detection works: stash what you observed, and
//                    next run compare against it. Sensors are otherwise
//                    stateless and must never write their own files.
//   sh               async exec with a hard timeout; returns "" on any failure.
//                    Sensors NEVER throw for a missing binary or a flaky API —
//                    a blind sensor is a quiet one, not a broken daemon.
//   event(...)       shape an event without repeating the boilerplate.
//
// Budget: a sensor should finish in well under a second and cost at most one
// subprocess. Anything heavier belongs in a harvester, on the far side of the
// gate, where it only runs once the moment has already earned an agent turn.

import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { installRoot } from "../../../lib/root.cjs";

export const HOME = os.homedir();

// Per-instance values (lib/instance.cjs). GOG_ACCOUNT: the Google account
// gog reads (the operator's own address; empty → gog's default account).
const { instance, localConfig } = createRequire(import.meta.url)("../../../lib/instance.cjs");
export const GOG_ACCOUNT = instance().owner_email;
export { localConfig };
export const EDVA = installRoot();
export const BIN = path.join(EDVA, "bin");
export const DATA = path.join(EDVA, "data");

/** Async exec that never throws. Returns stdout (trimmed) or "" on any failure. */
export function sh(cmd, args = [], { timeout = 8000, env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(cmd, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ""}`, ...(env || {}) },
    }, (err, stdout) => {
      if (done) return;
      done = true;
      resolve(err && !stdout ? "" : String(stdout || "").trim());
    });
    child.on("error", () => { if (!done) { done = true; resolve(""); } });
  });
}

export async function shJson(cmd, args, opts) {
  const out = await sh(cmd, args, opts);
  if (!out) return null;
  // Tolerate leading log noise: take the last line that parses as JSON.
  const lines = out.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  try { return JSON.parse(out); } catch { return null; }
}

/** Shape an event. `salience` is the only field worth agonizing over — see
 *  the scale in system/hum-events.md. */
export function event(sensor, type, fields = {}) {
  return {
    sensor,
    type: `${sensor}.${type}`,
    subject: fields.subject ?? null,
    summary: fields.summary ?? String(fields.subject ?? type),
    salience: fields.salience ?? 0.5,
    lanes: fields.lanes ?? [],
    dedup_key: fields.dedup_key ?? `${sensor}.${type}:${fields.subject ?? ""}`,
    ttl_min: fields.ttl_min ?? null,
    cooldown_min: fields.cooldown_min ?? null,
    override_quiet: fields.override_quiet === true,
    no_ramp: fields.no_ramp === true,
    data: fields.data ?? {},
    ts: fields.ts ?? new Date().toISOString(),
  };
}

export function minsSince(iso, nowMs = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 60000;
}

/**
 * The standard edge detector: emit only when a watched value CHANGES.
 * Returns {changed, from, to}. Every sensor in this directory is some
 * variation on this — keeping it in one place keeps them honest about the
 * difference between "X is true" (a state, which the harvest already sees)
 * and "X just became true" (an event, which is what this framework is for).
 */
export function edge(memo, key, value) {
  const from = memo?.[key];
  const changed = from !== value && from !== undefined;
  return { changed, from, to: value, first: from === undefined };
}
