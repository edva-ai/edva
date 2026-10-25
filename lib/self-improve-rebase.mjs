// self-improve-rebase — carry an approved code-fix card across drift instead of
// refusing it.
//
// A code-fix card stores WHOLE-FILE contents plus base_sha256[rel], the hash each
// file had when the card was authored. The applier's stale-base check refuses a
// card whose file has since changed, because writing the card's copy would revert
// the newer change. That refusal is right, but on its own it is a dead end:
// an approved 17-file feature card was refused
// because system/tasks.json and architecture.md had gained unrelated
// entries in the 27 minutes between authoring and Face ID. Nothing re-filed it,
// and the feature the user approved never shipped.
//
// The card's intent is exactly diff(base → card). If the base is still in git
// history, a 3-way merge (current, base, card) applies that diff on top of the
// newer content without reverting it. A clean merge is applied; a conflict in
// code still refuses, as before.
//
// Markdown docs are the exception: every card adds its "Recent changes" entry
// at the top of system/changelog.md (system/architecture.md until
// 2026-10-24), so two cards authored on the same day always collide there
// (that card would have, even with this merge). For `.md` files a conflict keeps
// both sides (`git merge-file --union`): a doc that briefly says both things is
// recoverable, a dropped approved change is not.
//
// The changelog move (2026-10-24): the "## Recent changes" section left
// architecture.md for changelog.md. A card authored before the move still
// carries a whole architecture.md WITH that section; merged as-is, the union
// would paste the entire old changelog back into the map. So such a card is
// split at the heading: its map half is merged into architecture.md, its
// changelog half into changelog.md (see splitLegacyChangelog below).
//
// This is mechanical: the signed item_json is unchanged, and the merge only
// keeps both sides' already-made changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const MAXBUF = 64 * 1024 * 1024;
const HISTORY_DEPTH = 300;

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The committed version of `rel` whose bytes hash to `want`, or null.
export async function findBaseContent(root, rel, want) {
  let revs = [];
  try {
    const { stdout } = await exec("git", ["rev-list", "-n", String(HISTORY_DEPTH), "HEAD", "--", rel], { cwd: root, maxBuffer: MAXBUF });
    revs = stdout.split("\n").filter(Boolean);
  } catch { return null; }
  for (const rev of revs) {
    try {
      const { stdout } = await exec("git", ["show", `${rev}:${rel}`], { cwd: root, encoding: "buffer", maxBuffer: MAXBUF });
      if (sha256(stdout) === want) return stdout;
    } catch { /* file absent at that rev */ }
  }
  return null;
}

// 3-way merge. Returns { ok:true, content } on a clean merge, else { ok:false, error }.
export async function mergeThree(current, base, theirs, { union = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "si-rebase-"));
  try {
    const [c, b, t] = ["current", "base", "card"].map((n) => path.join(dir, n));
    fs.writeFileSync(c, current); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    try {
      const { stdout } = await exec("git", ["merge-file", "-p", ...(union ? ["--union"] : []), c, b, t], { encoding: "buffer", maxBuffer: MAXBUF });
      return { ok: true, content: stdout };
    } catch (e) {
      // merge-file exits with the conflict count (>0) or -1 on error.
      const n = typeof e.code === "number" ? e.code : null;
      return { ok: false, error: n && n > 0 ? `${n} conflicting hunk(s)` : (e.stderr || e.message || "merge failed").toString().trim() };
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const ARCH_REL = "system/architecture.md";
export const CHANGELOG_REL = "system/changelog.md";
const CHANGELOG_HEADING = /^## Recent changes[ \t]*$/m;

// Split a document at its "## Recent changes" heading: { head, log } with `log`
// starting at the heading, or null when there is no such section.
export function splitLegacyChangelog(doc) {
  const s = Buffer.isBuffer(doc) ? doc.toString("utf8") : String(doc);
  const m = CHANGELOG_HEADING.exec(s);
  return m ? { head: s.slice(0, m.index), log: s.slice(m.index) } : null;
}

// True when `card` is an architecture.md written before the changelog moved out
// of it (it still has the section, and the file on disk no longer does).
export function isLegacyArchCard(rel, current, card) {
  return rel === ARCH_REL && !!splitLegacyChangelog(card) && !splitLegacyChangelog(current);
}

// A pre-move architecture.md card: merge its map half into architecture.md and
// its changelog half into changelog.md. Returns { ok, merged } / { ok:false, error }.
async function rebaseLegacyArch(root, d, base) {
  const card = splitLegacyChangelog(d.card);
  const was = splitLegacyChangelog(base);
  if (!was) return { ok: false, error: `${d.rel}: this card adds a "Recent changes" section that its base did not have, and the changelog now lives in ${CHANGELOG_REL}, so it can't be placed. Nothing was written.` };
  let log;
  try { log = fs.readFileSync(path.join(root, CHANGELOG_REL)); }
  catch { return { ok: false, error: `${d.rel}: this card was written before the changelog moved to ${CHANGELOG_REL}, and that file is missing. Nothing was written.` }; }
  const logNow = splitLegacyChangelog(log);
  if (!logNow) return { ok: false, error: `${CHANGELOG_REL} has no "## Recent changes" section to carry this card's entry into. Nothing was written.` };
  const map = await mergeThree(d.current, Buffer.from(was.head), Buffer.from(card.head), { union: true });
  if (!map.ok) return { ok: false, error: `${d.rel} changed on disk after this card was authored and the two changes overlap (${map.error}). Nothing was written.` };
  const entries = await mergeThree(log, Buffer.from(logNow.head + was.log), Buffer.from(logNow.head + card.log), { union: true });
  if (!entries.ok) return { ok: false, error: `${CHANGELOG_REL}: this card's changelog entry overlaps newer entries (${entries.error}). Nothing was written.` };
  return { ok: true, merged: { [d.rel]: map.content, [CHANGELOG_REL]: entries.content } };
}

// drifted: [{ rel, want, current: Buffer, card: string }]
// Returns { ok:true, merged: { rel: Buffer } } or { ok:false, error }.
// `merged` may hold a file the card did not name: a pre-move architecture.md
// card also writes system/changelog.md.
export async function rebaseDrifted(root, drifted) {
  const merged = {};
  for (const d of drifted) {
    const base = await findBaseContent(root, d.rel, d.want);
    if (!base) return { ok: false, error: `${d.rel} changed on disk after this card was authored and its original version is no longer in git history, so the change can't be carried over. Nothing was written.` };
    if (isLegacyArchCard(d.rel, d.current, d.card)) {
      if (drifted.some((x) => x.rel === CHANGELOG_REL)) return { ok: false, error: `${d.rel}: this card edits both the old changelog section and ${CHANGELOG_REL}. Nothing was written.` };
      const r = await rebaseLegacyArch(root, d, base);
      if (!r.ok) return r;
      Object.assign(merged, r.merged);
      continue;
    }
    const m = await mergeThree(d.current, base, Buffer.from(String(d.card)), { union: d.rel.endsWith(".md") });
    if (!m.ok) return { ok: false, error: `${d.rel} changed on disk after this card was authored and the two changes overlap (${m.error}). Nothing was written.` };
    merged[d.rel] = m.content;
  }
  return { ok: true, merged };
}

// ---------------------------------------------------------------------------
// Stale-base check for AUTOMATIC fixes (self-improve-auto-apply), 2026-10-22.
//
// An automatic fix carries whole-file contents, like a card, but until now it
// carried no record of the version it was written against, so it overwrote
// whatever was on disk. In one week that went wrong twice: one
// landing wiped four entries from system/architecture.md (restored by
// hand), and another put back a five-day-old copy of the day-builder that would
// have dropped a calendar commitment from the rebuilt day (caught and
// restored). The user chose "refuse and redo" over merging: a file
// the fix loop edits several times a day is exactly where a clean-looking merge
// would combine two fixes nobody checked together. So unlike rebaseDrifted()
// above, nothing here merges. A moved file is refused, and the author
// regenerates its fix once against the current content.
//
// A file is pinned either by its own hash (baseSha256[rel], null meaning "did
// not exist when I read it") or by the commit the author read the tree at
// (baseRev). A per-file hash wins over the commit. Returns
//   { moved: [{ rel, reason }], unpinned: [rel] }
// and never throws: an unreadable revision counts as moved, the safe direction.
export async function findMovedFiles(root, files, { baseSha256 = null, baseRev = null } = {}) {
  const moved = [];
  const unpinned = [];
  for (const [rel, content] of Object.entries(files || {})) {
    let current = null;
    try { current = fs.readFileSync(path.resolve(root, rel)); } catch { /* absent */ }
    const curHash = current ? sha256(current) : null;
    // Already exactly what this fix writes: nothing to clobber.
    if (curHash && curHash === sha256(Buffer.from(String(content)))) continue;

    let want; // sha256 hex of the version read, or null for "did not exist"
    if (baseSha256 && Object.prototype.hasOwnProperty.call(baseSha256, rel)) {
      want = baseSha256[rel] ? String(baseSha256[rel]).toLowerCase() : null;
    } else if (baseRev) {
      try {
        await exec("git", ["cat-file", "-e", `${baseRev}^{commit}`], { cwd: root });
      } catch {
        moved.push({ rel, reason: `base revision ${baseRev} is not a commit in this repo` });
        continue;
      }
      try {
        const { stdout } = await exec("git", ["show", `${baseRev}:${rel}`], { cwd: root, encoding: "buffer", maxBuffer: MAXBUF });
        want = sha256(stdout);
      } catch {
        want = null; // the file did not exist at that commit
      }
    } else {
      unpinned.push(rel);
      continue;
    }

    if (want === curHash) continue;
    if (want === null) moved.push({ rel, reason: `${rel} did not exist when this fix was written, and it does now` });
    else if (curHash === null) moved.push({ rel, reason: `${rel} was deleted after this fix was written` });
    else moved.push({ rel, reason: `${rel} changed after this fix was written` });
  }
  return { moved, unpinned };
}
