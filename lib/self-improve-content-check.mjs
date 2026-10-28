// self-improve-content-check — sanity checks on the CONTENT of a self-improvement
// change, shared by every door it can land through: self-improve-bundle (when the
// bundle is built), self-improve-request (before a card is filed),
// self-improve-auto-apply (before an automatic landing) and
// self-improve-approval-poll (before a signed card is written).
//
// Why: on 2026-10-25 a rebuilt card replaced the whole changelog (2,023 lines)
// with one line of JSON, and it was approved and applied. The rebuilding agent
// bundled the files with a hand-written `node -e '…' -- <paths>`; under `node -e`,
// process.argv[1] is the first path, not an output file, so the bundle of the
// other files was written over the changelog. A second bundling read the broken
// file back, the agent restored its working tree, and its tests and critic saw a
// clean tree. Nothing between the bundle and the commit looked at what a file
// was being turned into. These two checks would each have stopped it:
//
//   - a file whose new content is itself a bundle ({"files": {"<path>": …}});
//   - a text file losing most of its lines (SHRINK_FRACTION of them, and at
//     least SHRINK_MIN_LINES), unless the change declares that path in
//     allow_shrink (inside item_json, so a signature covers the declaration).
//
// Both are structural: line counts and a JSON shape, never a reading of the text.

export const SHRINK_MIN_LINES = 200;
export const SHRINK_FRACTION = 0.8;

const lineCount = (s) => (s ? String(s).split("\n").length : 0);

/** True when `content` is a self-improve bundle: an object whose "files" maps repo paths to strings. */
export function isFilesBundle(content) {
  const s = String(content ?? "").trim();
  if (!s.startsWith("{")) return false;
  let j;
  try { j = JSON.parse(s); } catch { return false; }
  const f = j && typeof j === "object" && !Array.isArray(j) ? j.files : null;
  if (!f || typeof f !== "object" || Array.isArray(f)) return false;
  const keys = Object.keys(f);
  return keys.length > 0 && keys.every((k) => k.includes("/") && typeof f[k] === "string");
}

/**
 * Files that lose most of their lines: [{ rel, from, to, removed }].
 * `before` maps each path to its current content (null for a new file).
 */
export function largeRemovals({ files, before = {} }) {
  const out = [];
  for (const [rel, content] of Object.entries(files || {})) {
    const old = before[rel];
    if (old == null || typeof content !== "string") continue;
    const from = lineCount(old), to = lineCount(content), removed = from - to;
    if (removed >= SHRINK_MIN_LINES && removed >= from * SHRINK_FRACTION) out.push({ rel, from, to, removed });
  }
  return out;
}

/** Plain-language reasons to refuse the change; [] when it may proceed. */
export function contentRefusals({ files, before = {}, allowShrink = [] }) {
  const reasons = [];
  const allowed = new Set(Array.isArray(allowShrink) ? allowShrink : []);
  for (const [rel, content] of Object.entries(files || {})) {
    // A file that already holds a bundle (a test fixture) may keep holding one.
    if (isFilesBundle(content) && !isFilesBundle(before[rel])) {
      reasons.push(`${rel}: its new content is a self-improve bundle ({"files": …}), not the file. The bundle was written over it; rebuild it with bin/self-improve-bundle.`);
    }
  }
  for (const r of largeRemovals({ files, before })) {
    if (allowed.has(r.rel)) continue;
    reasons.push(`${r.rel}: would go from ${r.from} lines to ${r.to}. If that is intended, rebuild the bundle with self-improve-bundle --allow-shrink ${r.rel}; otherwise the file was truncated.`);
  }
  return reasons;
}

/** The card line for declared large removals, or "" when there are none. */
export function removalNote({ files, before = {} }) {
  const rs = largeRemovals({ files, before });
  if (!rs.length) return "";
  return `Large removals: ${rs.map((r) => `${r.rel} ${r.from.toLocaleString("en-US")} → ${r.to.toLocaleString("en-US")} lines`).join("; ")}.`;
}
