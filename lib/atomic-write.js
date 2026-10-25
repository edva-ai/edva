"use strict";
// atomic-write.js — replace a file so a reader sees the old content or the new,
// never a half-written one. The one shared helper (decision D15, 2026-10-22).
//
// Why: fs.writeFileSync(file, …) truncates first and writes second. A process
// that reads the file in between (a supervisor, hum-sense, the watchdog's jq, a
// second cron step) gets "" or a cut-off JSON, and most readers treat a parse
// failure as "empty state": cooldowns reset, a queue looks drained, a ledger
// starts over. A crash or a full disk mid-write leaves the cut-off file behind
// for good. Writing a temp file in the SAME directory, fsyncing it and renaming
// it over the target closes both: rename(2) within one filesystem is atomic.
//
// What it is not: a lock. Two writers doing read-modify-write can still lose
// one update (last rename wins); pair it with lib/file-lock.js for that.
// And not for append-only logs (.jsonl) that other processes append to: a
// rename swaps the inode under an open appender and its lines land in the old,
// unlinked file. Those keep appendFileSync.
//
// Usage (CommonJS and ESM alike):
//   const { writeFileAtomic, writeJsonAtomic } = require("../lib/atomic-write.js");
//   import { writeFileAtomic, writeJsonAtomic } from "../lib/atomic-write.js";
//   writeJsonAtomic(file, obj)                 // 2-space JSON + trailing newline
//   writeJsonAtomic(file, obj, { indent: 0 })  // compact, no newline
//   writeFileAtomic(file, text, { mode: 0o600 })
// Python twin: lib/atomic_write.py.

const fs = require("node:fs");
const path = require("node:path");

let seq = 0;

function writeFileAtomic(file, data, { mode, fsync = true, mkdir = true } = {}) {
  // Write through a symlink to its target, as writeFileSync would, instead of
  // replacing the link with a plain file.
  let target = file;
  try { target = fs.realpathSync(file); } catch {}   // not there yet: create it
  const dir = path.dirname(target);
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  // Keep the existing file's permissions unless the caller sets them (a 0600
  // token file must not come back 0644 after a rewrite).
  let fileMode = mode;
  if (fileMode == null) { try { fileMode = fs.statSync(target).mode & 0o7777; } catch {} }
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}-${seq++}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", fileMode ?? 0o666);
    fs.writeFileSync(fd, data);
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // openSync's mode is filtered by the umask; set it exactly when one was known.
    if (fileMode != null) fs.chmodSync(tmp, fileMode);
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  if (fsync) {
    // Make the rename itself durable. Best effort: not every platform allows
    // fsync on a directory fd, and the data is already safe from torn reads.
    try { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
  }
}

function writeJsonAtomic(file, obj, { indent = 2, newline, ...opts } = {}) {
  const body = indent ? JSON.stringify(obj, null, indent) : JSON.stringify(obj);
  writeFileAtomic(file, body + ((newline ?? !!indent) ? "\n" : ""), opts);
}

module.exports = { writeFileAtomic, writeJsonAtomic };
