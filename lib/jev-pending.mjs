// jev-pending.mjs — the small "compare this later" store the JOB-GATE Jev sites
// share (hum-ping-gate, p1-resolution). See docs/jev.md.
//
// A job gate cannot compare Jev against the legacy mechanism inline: when Jev
// lets the job run, the legacy verdict is whatever the agent turn actually did
// minutes later; when Jev skips the job, the verdict comes from a detached
// side-effect-free shadow. Both land here as pending rows, and each is resolved
// exactly ONCE — the same contract (and the same compaction) as
// bin/jev-email-reconcile: a resolved id is forgotten only together with
// its row, so a comparison can never be recorded (and paged) twice.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { SHADOW_DIR } from "./jev-shadow.mjs";

import { installTools } from "./root.cjs";
const { withFileLock } = createRequire(import.meta.url)("./file-lock.js");

export const MAX_AGE_MS = 48 * 3600e3;

export function pendingFile(site) { return path.join(SHADOW_DIR, `${site}-pending.jsonl`); }
function resolvedFile(site) { return path.join(SHADOW_DIR, `${site}-resolved.json`); }

export function appendPending(site, row) {
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.appendFileSync(pendingFile(site), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  } catch {}
}

export function readPending(site) {
  try {
    return fs.readFileSync(pendingFile(site), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function findPending(site, id) {
  return readPending(site).filter((r) => r.id === id).pop() || null;
}

export function loadResolved(site) {
  try { return JSON.parse(fs.readFileSync(resolvedFile(site), "utf8")) || {}; } catch { return {}; }
}

/**
 * Mark `id` resolved. Returns false if it already was — the caller must then
 * NOT record the comparison again (a detached shadow and the reconciler can
 * race on the same id).
 */
export function markResolved(site, id, how = "compared") {
  try { fs.mkdirSync(SHADOW_DIR, { recursive: true }); } catch {}
  // Locked read-modify-write: the detached shadow, the reconciler and the
  // compactor all touch this map (code review 2026-09-23).
  return withFileLock(resolvedFile(site), () => {
    const r = loadResolved(site);
    if (r[id]) return false;
    r[id] = { how, ts: new Date().toISOString() };
    writeResolved(site, r);
    return true;
  });
}

function writeResolved(site, r) {
  try {
    const tmp = `${resolvedFile(site)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(r));
    fs.renameSync(tmp, resolvedFile(site));
  } catch {}
}

/**
 * Drop resolved rows and rows older than MAX_AGE_MS; forget a resolved id only
 * when its row goes. Lines appended while this ran survive (the file is re-read
 * just before the swap and anything unseen is kept).
 */
export function compactPending(site, nowMs = Date.now()) {
  const rows = readPending(site);
  const resolved = loadResolved(site);
  const seen = new Set(rows.map((r) => JSON.stringify(r)));
  const keep = rows.filter((r) => !resolved[r.id] && !(nowMs - Date.parse(r.ts) > MAX_AGE_MS));
  let fresh = [];
  try {
    const now = fs.existsSync(pendingFile(site)) ? fs.readFileSync(pendingFile(site), "utf8").split("\n").filter(Boolean) : [];
    fresh = now.filter((l) => { try { return !seen.has(JSON.stringify(JSON.parse(l))); } catch { return true; } });
    const tmp = `${pendingFile(site)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, [...keep.map((r) => JSON.stringify(r)), ...fresh].map((l) => l + "\n").join(""));
    fs.renameSync(tmp, pendingFile(site));
  } catch { return; } // could not compact → leave the resolved map alone too
  // Live = every row still in the file, INCLUDING rows appended while we ran.
  const live = new Set(keep.map((r) => r.id));
  for (const l of fresh) { try { live.add(JSON.parse(l).id); } catch {} }
  // Re-read the map under the lock just before writing, so a markResolved that
  // landed during compaction is never lost; forget only ids whose row is gone
  // AND that were already resolved in our snapshot.
  withFileLock(resolvedFile(site), () => {
    const cur = loadResolved(site);
    let changed = false;
    for (const k of Object.keys(cur)) if (resolved[k] && !live.has(k)) { delete cur[k]; changed = true; }
    if (changed) writeResolved(site, cur);
  });
}

// One JSON extractor for every Jev batch (lib/jev-claude.mjs).
export { parseModelJson as firstJson } from "./jev-claude.mjs";

// Detach the side-effect-free shadow judgment for a skipped gate decision
// (bin/jev-gate-shadow <site> <id>). One copy for every job-gate site.
const SHADOW_CLI = installTools("bin/jev-gate-shadow");
export function spawnGateShadow(site, id) {
  try {
    const c = spawn(process.execPath, [SHADOW_CLI, site, id], { detached: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
  } catch {}
}
