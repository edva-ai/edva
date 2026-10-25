// event-log.mjs — NDJSON append writer for supervisor events.
// Three streams:
//   events.ndjson     full event firehose
//   cost.ndjson       one line per turn result (session-level aggregate)
//   job-costs.ndjson  one line per turn result attributed to its job/source
//                     (drives per-job usage rollups for
//                     `edva-cost-report` + nightly-review cost lens)
//
// Rotation. Without it these streams are append-only with no bound.
// events.ndjson reached 2.6GB on the ops supervisor, which (a) put the logs
// dir at 3.8GB on a disk already at 97%, and (b) broke every reader that did
// readFileSync() on it — V8 caps strings at ~512MB, so GET /events had been
// returning `Cannot create a string longer than 0x1fffffe8 characters` and the
// handoff-digest JSONL fallback had been silently returning [].
//
// Readers were fixed to tail (lib/tail-file.mjs); this adds the missing
// bound at the writer so the file can't grow without limit again. On crossing
// MAX_BYTES the live file is renamed aside and gzipped in the background; the
// supervisor keeps appending to a fresh file (fs.appendFile resolves by path
// on each call, so no fd juggling is needed). Archives are pruned to
// KEEP_ARCHIVES per stream. The JSONL remains the durable source of truth —
// rotation moves history into .gz siblings, it never discards it.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { indexEvent } from "../../lib/event-fts.mjs";

const MAX_BYTES = 256 * 1024 * 1024; // rotate a stream once it passes 256MB
const CHECK_EVERY = 500;             // stat() every N appends, not every append
const KEEP_ARCHIVES = 6;             // gzipped generations retained per stream

export class EventLog {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.eventsPath = path.join(dir, "events.ndjson");
    this.costPath = path.join(dir, "cost.ndjson");
    this.jobCostsPath = path.join(dir, "job-costs.ndjson");
    // Supervisor identity for the recall index (dir is .../logs/supervisor-<agent>).
    const m = /supervisor-([^/]+)/.exec(dir);
    this.agent = m ? m[1] : path.basename(dir);
    this._writeCounts = new Map();
    this._rotating = new Set();
  }

  // Cheap amortised size check. stat() on every append would be a syscall per
  // event on the supervisor's hot path; once per CHECK_EVERY is plenty given
  // MAX_BYTES is measured in hundreds of MB.
  _maybeRotate(filePath) {
    const n = (this._writeCounts.get(filePath) || 0) + 1;
    if (n < CHECK_EVERY) { this._writeCounts.set(filePath, n); return; }
    this._writeCounts.set(filePath, 0);
    if (this._rotating.has(filePath)) return;
    fs.stat(filePath, (err, st) => {
      if (err || !st || st.size < MAX_BYTES) return;
      this._rotate(filePath);
    });
  }

  _rotate(filePath) {
    if (this._rotating.has(filePath)) return;
    this._rotating.add(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated = `${filePath}.${stamp}`;
    fs.rename(filePath, rotated, (err) => {
      if (err) {
        console.error(`[event-log] rotate rename failed: ${err.message}`);
        this._rotating.delete(filePath);
        return;
      }
      // Compress out-of-band. Failure here is non-fatal: the uncompressed
      // rotated file is still on disk and still readable.
      pipeline(
        fs.createReadStream(rotated),
        zlib.createGzip(),
        fs.createWriteStream(`${rotated}.gz`),
        (gzErr) => {
          if (gzErr) console.error(`[event-log] rotate gzip failed: ${gzErr.message}`);
          else fs.unlink(rotated, () => {});
          this._rotating.delete(filePath);
          this._pruneArchives(filePath);
        },
      );
      console.log(`[event-log] rotated ${path.basename(filePath)} -> ${path.basename(rotated)}.gz`);
    });
  }

  _pruneArchives(filePath) {
    const base = path.basename(filePath);
    fs.readdir(this.dir, (err, names) => {
      if (err) return;
      const archives = names
        .filter((n) => n.startsWith(`${base}.`) && n.endsWith(".gz"))
        .sort(); // ISO stamps sort chronologically
      for (const stale of archives.slice(0, Math.max(0, archives.length - KEEP_ARCHIVES))) {
        fs.unlink(path.join(this.dir, stale), () => {});
      }
    });
  }

  _appendLine(filePath, obj, label) {
    const line = JSON.stringify(obj) + "\n";
    fs.appendFile(filePath, line, (err) => {
      if (err) console.error(`[event-log] ${label} write failed: ${err.message}`);
    });
    this._maybeRotate(filePath);
  }

  append(event) {
    const row = { ts: new Date().toISOString(), ...event };
    this._appendLine(this.eventsPath, row, "event");
    // Tee into the events_fts recall index (lib/event-fts.mjs). Derived +
    // rebuildable; the JSONL above stays the durable source of truth. indexEvent
    // is fail-soft (disables itself if the DB can't be opened) so this never
    // throws into the supervisor's event loop.
    indexEvent(row, { agent: this.agent });
  }

  appendCost(entry) {
    this._appendLine(this.costPath, { ts: new Date().toISOString(), ...entry }, "cost");
  }

  appendJobCost(entry) {
    this._appendLine(this.jobCostsPath, { ts: new Date().toISOString(), ...entry }, "job-cost");
  }
}
