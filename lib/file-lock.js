"use strict";
// file-lock.js — a tiny cross-process mutex for read-modify-write of a small
// state file. mkdir is atomic on POSIX, so `<file>.lock/` either exists or it
// doesn't; a lock older than STALE_MS is presumed abandoned (crashed holder)
// and broken. Synchronous on purpose: callers are short CLI/cron steps.
//
// First user (2026-09-23): data/p1-scan-seen.json, written by both
// bin/p1-scan-gate (every trigger tick) and bin/jev-gate-shadow
// (the Jev P1 self-heal). Without it the gate's full overwrite could restore
// ids the shadow had just un-seen.

const fs = require("node:fs");

const STALE_MS = 30_000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn() while holding `<file>.lock`. Waits up to waitMs; on timeout runs
 * fn() anyway only if `failOpen` (the default is to throw), because a lost
 * update is recoverable here and a wedged cron tick is not.
 */
function withFileLock(file, fn, { waitMs = 5000, failOpen = true } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try { fs.mkdirSync(lock); held = true; break; } catch (e) {
      if (e.code !== "EEXIST") break; // e.g. missing dir: run unlocked
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > deadline) { if (!failOpen) throw new Error(`lock timeout: ${lock}`); break; }
      sleepMs(50);
    }
  }
  try { return fn(); } finally { if (held) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} } }
}

module.exports = { withFileLock };
