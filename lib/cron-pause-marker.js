// cron-pause-marker — restore crontab lines that were switched off with a
// `#MARKER#` prefix.
//
// WHY THIS EXISTS. Edva's convention for switching a family of cron jobs off
// without losing them is to prefix each line with a marker comment:
//
//     #HUMPAUSE# 0 23 * * * /…/cron-run --label trigger-hum-daily -- …
//     #XYZPAUSE# 15 9 * * * /…/cron-run --label trigger-xyz-daily-digest -- …
//
// Switching them back ON was never implemented. `edva hum pause` and
// `edva hum resume` only write `hum-state.json.pause`, which is read by the
// */20 tick — so lifting a pause restored the tick and left the eight daily
// `#HUMPAUSE#` jobs (daily, ideation, review, canary, consolidate, metrics,
// weekly-ideation, action-executor) commented out permanently, with hum looking
// alive because its tick came back. On 2026-09-08 the live crontab held 8 such
// lines against a pause due to expire on 09-10.
//
// SAFETY IS THE WHOLE DESIGN HERE. This edits the user's real crontab, 238
// lines of it, so:
//   - a line is touched only if its first non-space characters are exactly the
//     marker followed by a space;
//   - every other line is passed through byte-identical;
//   - the line COUNT is asserted unchanged by the caller before install;
//   - the function is pure, so all of the above is unit-testable without a
//     crontab anywhere near it.

const MARKER_RE = /^(\s*)#([A-Z0-9_]+)#\s(.*)$/; // lang-regex-ok: matches a crontab marker prefix — machine-written structure, no natural language involved

/** Lines currently switched off with `#<marker>#`. Pure. */
function findPaused(lines, marker) {
  const out = [];
  lines.forEach((line, i) => {
    const m = MARKER_RE.exec(line);
    if (m && m[2] === marker) out.push({ index: i, line, restored: m[1] + m[3] });
  });
  return out;
}

/**
 * Strip the `#<marker># ` prefix from every line carrying it.
 * Returns { lines, restored } — `lines` is a new array, same length, with every
 * untouched line identical by reference.
 */
function unpause(lines, marker) {
  const hits = findPaused(lines, marker);
  if (!hits.length) return { lines, restored: [] };
  const next = lines.slice();
  for (const h of hits) next[h.index] = h.restored;
  return { lines: next, restored: hits.map((h) => h.restored) };
}

/** The `--label <name>` of a cron line, for logging. Structure, not language. */
function labelOf(line) {
  const m = /--label\s+(\S+)/.exec(line); // lang-regex-ok: reads a CLI flag Edva itself wrote
  return m ? m[1] : null;
}

module.exports = { findPaused, unpause, labelOf, MARKER_RE };
