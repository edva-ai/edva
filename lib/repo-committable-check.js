"use strict";
// repo-committable-check — can the shared clone actually accept a commit right
// now, or will the next `edva-commit` refuse?
//
// Consumed by `edva doctor` (check 8f). Extracted from the monolith so the
// logic is unit-testable, same reasoning as its sibling cron-interpreter-check:
// a false negative re-ships a silent failure, a false positive puts permanent
// noise in a health dashboard.
//
// THE BUG THIS CATCHES. `bin/edva-commit` is the only sanctioned write
// path, and it does two things in order: `git add -- <declared paths>`, then a
// PLAIN `git commit` with no pathspec. Both halves have a way to fail on
// conditions that have nothing to do with the caller:
//
//   - An UNMERGED path anywhere in the index makes plain `git commit` refuse
//     outright ("Committing is not possible because you have unmerged files"),
//     even when the caller's own files are perfectly stageable. Note this is
//     specific to the plain form: for a stash-pop conflict (no MERGE_HEAD, the
//     shape the real 2026-08-31 case took) `git commit -- <paths>` DOES
//     survive it, which is exactly why the failure is easy to miss when
//     reasoning about the code rather than running it. During a true merge
//     even the pathspec form refuses ("cannot do a partial commit during a
//     merge"), so the plain form is never the safer of the two.
//   - Any file staged in the index that the caller did NOT declare trips
//     edva-commit's foreign-file guard and exits 3. That guard is correct
//     and load-bearing — the shared clone is edited by a laptop, the host,
//     the ops-agent and any concurrent chat session at once, so committing
//     someone else's staged work under your message is the accident the whole
//     tool exists to prevent. But it means a forgotten staged file silently
//     blocks every other writer.
//
// WHY IT MATTERS MORE THAN IT LOOKS. The self-improvement pipeline lands owner-
// approved Face-ID cards through this exact path: self-improve-approval-poll
// writes the payload's files to disk and then calls edva-commit. When the
// commit half fails, the approval row still records status "applied" with
// ok:true (the error is tucked into result.git), so every downstream reader —
// the nightly review's roundup, system-issue-review's writeback, the cost
// review's state — reads the change as landed while it sits uncommitted, one
// `git checkout --` from silently reverting. That happened on 2026-08-26 to two
// signed cards and cost three days before anyone noticed. Nothing in the system
// watches for the CONDITION; it is only ever discovered from its consequences.
//
// THE THIRD CONDITION: conflict markers in tracked content. `git add` on a
// conflicted file marks it resolved regardless of what the content says, so a
// marker can survive into a commit. That is worse than an unmerged path,
// because the index looks clean and the corruption ships.

const CONFLICT_START = "<<<<<<< ";
const CONFLICT_END = ">>>>>>> ";

// Files legitimately allowed to contain conflict-marker text: this checker, its
// test, and anything documenting the markers themselves. Matched as substrings
// of the repo-relative path.
const MARKER_ALLOWLIST = [
  "lib/repo-committable-check.js",
  "tests/repo-committable-check.test.mjs",
];

// `run` takes an array of git args and returns stdout as a string, or throws.
// Injected so the test can drive real temporary repositories.
function findCommitBlockers(run) {
  const lines = (out) =>
    String(out || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  let unmerged = [];
  let staged = [];
  let markers = [];

  try {
    unmerged = lines(run(["diff", "--name-only", "--diff-filter=U"]));
  } catch {}

  try {
    staged = lines(run(["diff", "--cached", "--name-only"]));
  } catch {}

  // An unmerged path is reported by `git diff --cached` too. Report it once,
  // under the more specific heading.
  const unmergedSet = new Set(unmerged);
  staged = staged.filter((f) => !unmergedSet.has(f));

  // Anchored to line start WITH the trailing space git actually emits, so prose
  // that merely mentions "<<<<<<<" does not trip it. `git grep` searches tracked
  // content only, which is what a commit would carry.
  try {
    const starts = new Set(
      lines(run(["grep", "-l", "-e", `^${CONFLICT_START}`, "--", "."])),
    );
    const ends = lines(run(["grep", "-l", "-e", `^${CONFLICT_END}`, "--", "."]));
    // Require BOTH halves in the same file: one alone is far more likely to be
    // documentation or a test fixture than a live conflict.
    markers = ends
      .filter((f) => starts.has(f))
      .filter((f) => !MARKER_ALLOWLIST.some((a) => f.includes(a)))
      // An unmerged file almost always still carries markers in the worktree,
      // and it is already reported above under the more specific heading —
      // same rule as `staged`. What makes this condition worth having on its
      // own is the file that is NOT unmerged because `git add` marked it
      // resolved with the markers still in the content: there the index looks
      // clean and the corruption would ship.
      .filter((f) => !unmergedSet.has(f));
  } catch {
    // `git grep -l` exits 1 with no matches; that is the healthy case.
  }

  const blockers = [];
  if (unmerged.length)
    blockers.push({
      kind: "unmerged",
      files: unmerged,
      why: "plain `git commit` refuses while any path is unmerged, so edva-commit fails for every caller",
    });
  if (markers.length)
    blockers.push({
      kind: "conflict-markers",
      files: markers,
      why: "tracked content still holds merge markers; `git add` would mark it resolved and ship the corruption",
    });
  if (staged.length)
    blockers.push({
      kind: "foreign-staged",
      files: staged,
      why: "edva-commit exits 3 rather than commit files the caller did not declare",
    });

  return { ok: blockers.length === 0, blockers };
}

// One line for the doctor dashboard. Names the condition and the first few
// files; the point is to be actionable at a glance, not exhaustive.
function describeBlockers(blockers) {
  return blockers
    .map((b) => {
      const shown = b.files.slice(0, 4).join(", ");
      const more = b.files.length > 4 ? ` (+${b.files.length - 4} more)` : "";
      return `${b.kind}: ${shown}${more} — ${b.why}`;
    })
    .join("; ");
}

module.exports = { findCommitBlockers, describeBlockers, MARKER_ALLOWLIST };
