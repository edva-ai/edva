// tail-file.mjs — bounded tail reads over append-only text files.
//
// Both /events (supervisor/http-server.mjs) and the handoff-digest fallback
// wanted "the last N lines of events.ndjson" and implemented it as
// fs.readFileSync(path, "utf8") + split("\n"). That works until the file gets
// big, and events.ndjson is append-only with no rotation — on 2026-07-20 it
// reached 2.6GB and both call sites started throwing
//   RangeError: Cannot create a string longer than 0x1fffffe8 characters
// (V8's ~512MB max string). The /events endpoint had been returning a 500 for
// however long the file had been over the limit; nothing alerted, because the
// error was caught and rendered as a normal JSON error body.
//
// readTailLines() reads only the last `maxBytes` of the file, so cost is
// bounded by the window rather than by total file size. The first (likely
// partial) line in the window is dropped unless we happened to start exactly
// at a record boundary.

import fs from "node:fs";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // ~8MB back-window

/**
 * Read up to `limit` trailing lines from a file without loading all of it.
 *
 * @param {string} filePath
 * @param {{limit?: number, maxBytes?: number}} [opts]
 * @returns {string[]} trailing lines, oldest-first, no empty lines
 */
export function readTailLines(filePath, opts = {}) {
  const limit = opts.limit ?? 2000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!filePath || !fs.existsSync(filePath)) return [];

  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];

    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);

    let text = buf.toString("utf8");
    // If we started mid-file we almost certainly sliced a line in half; drop
    // the leading fragment so callers never see a truncated record.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }

    const lines = text.split("\n").filter(Boolean);
    return lines.length > limit ? lines.slice(-limit) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Read trailing lines and JSON.parse each, skipping unparseable ones.
 * Returns newest-last (chronological), matching the on-disk order.
 *
 * `backscan` controls how many raw lines to pull before filtering — callers
 * that filter by kind need a wider net than their final `limit`.
 */
export function readTailJson(filePath, opts = {}) {
  const backscan = opts.backscan ?? Math.max((opts.limit ?? 2000) * 10, 5000);
  const lines = readTailLines(filePath, { ...opts, limit: backscan });
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip partial/corrupt */ }
  }
  return out;
}
