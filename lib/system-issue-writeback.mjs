// system-issue-writeback — closes the loop from a Face-ID approval back into
// data/system-issue-review-state.json.
//
// REGRESSION GUARD: approval writeback stall.
// Nothing used to write an approval outcome back into the system-issue-review
// state file. `self-improve-approval-poll` applied a signed card, committed it
// and confirmed to the Improvements channel — and knew nothing about the
// cluster that had filed the card. Meanwhile the nightly job's Step 2d only
// closes clusters already marked `verifying`, and its Step 3 deliberately skips
// `awaiting_approval` clusters (CRITICAL RULE 8: never re-attempt a cluster
// with an unresolved fix in flight).
//
// Net effect: the fix landed in the tree while the cluster stayed
// `awaiting_approval` FOREVER — no verification window ever opened, recurrence
// was never checked, and the cluster went invisible to both lanes permanently.
// It was observed on several approvals, each still `awaiting_approval` days
// after its fix was applied and reconciled by hand, and documented earlier
// without being fixed.
//
// Design constraints this module exists to honour:
//   * It is BOOKKEEPING ONLY. It records an outcome that already happened. It
//     must never be able to stop a fix from landing or a confirmation from
//     being sent, so every entry point swallows its own errors and the caller
//     runs it AFTER apply + confirm.
//   * The state file is ~280KB of irreplaceable issue history and is read
//     concurrently by the nightly job. Writes are atomic (temp file in the same
//     directory + rename), never in-place.
//   * A skip is the user's own decision and outranks this job's judgment
//     (system-issue-review.md CRITICAL RULE 9) — it closes the cluster
//     `wontfix` / `owner-skipped` so the card can never come back.
//
// REGRESSION GUARD: approval id filed in the wrong field.
// The lookup above only ever scanned `attempts[].approval_id`, so it depended
// on the filing agent having put the uuid in the right field. Once one
// did not: an approval uuid was recorded in the
// attempt's `commit` field, the cluster-level `approval_id` was left unset, the
// writeback returned "no-matching-cluster" — and that cluster sat
// `awaiting_approval` for 5 days, i.e. exactly the
// stall this module exists to prevent, reached through a different door. The
// lookup now also accepts a uuid-shaped `attempts[].commit` and a uuid-shaped
// cluster-level `approval_id`, and self-heals the record into the canonical
// field on the way through.
//
// REGRESSION GUARD: escalated-cluster writeback no-op.
// The writeback only advanced a cluster whose status was exactly
// `awaiting_approval` — but system-issue-review.md Step 7 ("Escalate what
// resists") files its Face-ID DECISION card and then sets the cluster
// `escalated`, not `awaiting_approval`. So signing a Step 7 card returned
// "not-awaiting-approval" and the cluster stayed `escalated` forever: no
// verification window opened, recurrence was never checked, and Step 3 kept
// skipping it — the same stall as the approval writeback stall above,
// reached through a third door. Observed on a signed and applied Step 7 card
// whose cluster was `escalated` (poll log line
// "writeback <id>-… no-op: not-awaiting-approval"), while another Step 7 card
// — whose filer happened to record `awaiting_approval` — wrote back correctly. Both filing states are now accepted (WRITEBACK_FROM
// below); every other status is still refused with the same
// "not-awaiting-approval" reason so finished history is never clobbered.

import fs from "node:fs";
import path from "node:path";

/** Step 6a.7 of system-issue-review.md: a fix is watched for 3 days. */
export const VERIFY_WINDOW_MS = 3 * 24 * 3600e3;

/**
 * Shortest id overlap we will trust. The state file stores a full uuid while
 * the CLI, the channel card and the log lines surface an 8-char prefix — so
 * prefix matching is required — but 7 hex chars is ~268M combinations across a
 * table that has held thousands of rows, and a wrong match here silently
 * rewrites the status of an UNRELATED issue. 8 is the floor everything else in
 * this system already uses to abbreviate an id.
 */
export const MIN_ID_PREFIX = 8;

/**
 * Only a cluster that actually filed the card is ours to move — and a cluster
 * files a Face-ID card in one of exactly two states:
 *   * `awaiting_approval` — Step 6 staged a high-risk fix behind a card.
 *   * `escalated`         — Step 7 ("Escalate what resists") filed a DECISION
 *                           card after two failed attempts.
 *
 * REGRESSION GUARD: escalated-cluster writeback no-op. This
 * used to be the single string "awaiting_approval", so signing a Step 7 card
 * no-op'd with
 * "not-awaiting-approval" and left its cluster `escalated` forever. Any status
 * NOT in this set (`verifying`, `resolved`, `reviewed`, `open`, `wontfix`, …)
 * has already been advanced or closed by the nightly job and is still refused
 * — the reason string "not-awaiting-approval" is kept verbatim because the
 * poller's log line and any grep over it depend on it.
 */
// Module-private on purpose (Object.freeze would not stop Set#add anyway).
const WRITEBACK_FROM = new Set(["awaiting_approval", "escalated"]);

/**
 * Exact match, or either id being a prefix of the other with at least
 * MIN_ID_PREFIX characters of overlap. Never matches on a shorter prefix.
 */
export function idMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < MIN_ID_PREFIX) return false;
  return long.startsWith(short);
}

// lang-regex-ok: matches a machine-generated uuid FORMAT, interprets no meaning
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * REGRESSION GUARD: approval id filed in the wrong field.
 *
 * The loose fields below (`attempts[].commit`, the cluster-level `approval_id`)
 * are searched because agents have misfiled an approval uuid into them — but
 * `commit` legitimately holds git SHAs, and idMatches() accepts an 8-char
 * prefix overlap, so an 8-hex-char abbreviated SHA would otherwise collide with
 * an approval-id prefix and silently rewrite the status of an UNRELATED issue.
 * A git SHA is bare hex and can never carry dashes, so requiring the full
 * 8-4-4-4-12 uuid shape separates the two populations with no overlap at all.
 * Anything not uuid-shaped is ignored outright for matching purposes.
 */
export function isUuidShaped(v) {
  return typeof v === "string" && UUID_SHAPE.test(v.trim());
}

/**
 * Does this attempt carry `rowId`? Two places, in preference order:
 *   1. `approval_id` — the canonical home. Unguarded, unchanged behaviour.
 *   2. `commit`      — where an approval uuid was once misfiled, leaving its
 *                      cluster stalled at `awaiting_approval` for 5 days.
 *                      uuid-guarded, per isUuidShaped above.
 */
function attemptCarriesApproval(a, rowId) {
  if (!a || typeof a !== "object") return false;
  if (idMatches(a.approval_id, rowId)) return true;
  // `commit` is only consulted when `approval_id` is ABSENT. If both are
  // populated with different uuids, the canonical field owns the record and the
  // attempt belongs to that other card — matching on `commit` here would let the
  // backfill below overwrite a live approval id, losing it from a file that is
  // the only copy of this issue history. The misfiled record that prompted this
  // carried no `approval_id`, so the stall this exists to fix is unaffected.
  return a.approval_id == null && isUuidShaped(a.commit) && idMatches(a.commit, rowId);
}

/**
 * Does this cluster carry `rowId` anywhere — an attempt (canonical or misfiled)
 * or the cluster-level `approval_id` (also uuid-guarded)?
 */
export function clusterCarriesApproval(c, rowId) {
  if (!c || typeof c !== "object") return false;
  if (Array.isArray(c.attempts) && c.attempts.some((a) => attemptCarriesApproval(a, rowId))) return true;
  return isUuidShaped(c.approval_id) && idMatches(c.approval_id, rowId);
}

/**
 * Pure writeback. Returns a NEW state object; the input is never mutated and
 * every cluster other than the matched one is carried through by reference, so
 * nothing else in the file can change.
 *
 * @param {object} state    parsed system-issue-review-state.json
 * @param {string} rowId    self_improve_approvals.id (full uuid or 8+ prefix)
 * @param {"applied"|"skipped"} outcome
 * @param {string} nowIso   ISO timestamp to stamp
 * @param {object} [details] optional {commit, files} — recorded only when the
 *                           caller actually has them. Nothing is invented here.
 * @returns {{state: object, changed: boolean, cluster_id: ?string, from: ?string, to: ?string, reason: ?string}}
 */
export function applyApprovalWriteback(state, rowId, outcome, nowIso, details = {}) {
  const nochange = (reason) => ({ state, changed: false, cluster_id: null, from: null, to: null, reason });

  if (!state || typeof state !== "object" || !Array.isArray(state.clusters)) return nochange("no-clusters");
  if (typeof rowId !== "string" || !rowId.trim()) return nochange("no-row-id");
  if (outcome !== "applied" && outcome !== "skipped") return nochange(`unknown-outcome:${outcome}`);

  const now = Date.parse(nowIso);
  const stamp = Number.isFinite(now) ? new Date(now).toISOString() : new Date().toISOString();

  // Collect every cluster whose attempts[] carries this approval id. There can
  // legitimately be more than one: a real state file has contained a fix
  // mis-attributed across two clusters (one cluster recording an attempt that
  // actually belonged to another).
  // Only a cluster still in a card-filing state — `awaiting_approval` (Step 6)
  // or `escalated` (Step 7) — is ours to move. Anything else has already been
  // advanced by the nightly job, and clobbering a `resolved` or `recurred`
  // record would destroy the history this file exists to keep.
  const idx = state.clusters.findIndex((c) => c && WRITEBACK_FROM.has(c.status) && clusterCarriesApproval(c, rowId));
  if (idx === -1) {
    const known = state.clusters.some((c) => clusterCarriesApproval(c, rowId));
    return nochange(known ? "not-awaiting-approval" : "no-matching-cluster");
  }

  const target = state.clusters[idx];
  const from = target.status;

  // Spread rather than deep-clone: existing keys keep their position and value
  // byte-for-byte, and only the fields named below move.
  //
  // A cluster can also be matched purely on its cluster-level `approval_id`,
  // in which case no attempt is ours to stamp and `attempts` is carried
  // through untouched (including when it is absent or malformed — we never add
  // a key that was not already there).
  const rawAttempts = Array.isArray(target.attempts) ? target.attempts : null;
  const attemptsPatch = rawAttempts
    ? {
        attempts: rawAttempts.map((a) =>
          attemptCarriesApproval(a, rowId)
            ? {
                ...a,
                // Self-heal: an attempt found only through the misfiled
                // `commit` field gets the id written into its canonical home,
                // so every future lookup takes the `approval_id` path and this
                // cluster can never go invisible the same way twice.
                ...(idMatches(a.approval_id, rowId) ? {} : { approval_id: a.commit }),
                outcome,
                ...(outcome === "applied" ? { applied_at: stamp } : { skipped_at: stamp }),
                ...(details.commit ? { commit: details.commit } : {}),
                ...(Array.isArray(details.files) && details.files.length ? { files: details.files } : {}),
              }
            : a,
        ),
      }
    : {};

  const patched =
    outcome === "applied"
      ? {
          ...target,
          status: "verifying",
          verify_after: new Date((Number.isFinite(now) ? now : Date.now()) + VERIFY_WINDOW_MS).toISOString(),
          ...attemptsPatch,
        }
      : // CRITICAL RULE 9 — a skip is terminal. No verify window: there is
        // nothing to watch for, and re-proposing it next week would teach
        // the user the button doesn't work.
        { ...target, status: "wontfix", resolution: "owner-skipped", ...attemptsPatch };

  const clusters = state.clusters.slice();
  clusters[idx] = patched;
  return {
    state: { ...state, clusters },
    changed: true,
    cluster_id: target.id ?? null,
    from,
    to: patched.status,
    reason: null,
  };
}

/**
 * Read → writeback → atomic write. Swallows everything: a missing file, a
 * corrupt file, an unwritable directory and a bug in the pure function above
 * all degrade to a logged no-op, because this runs after a fix has ALREADY been
 * applied and confirmed and must never be able to undo either.
 *
 * @returns {{changed: boolean, cluster_id?: ?string, from?: ?string, to?: ?string, reason?: ?string, error?: string}}
 */
export function writebackApprovalOutcome(statePath, rowId, outcome, nowIso = new Date().toISOString(), details = {}) {
  try {
    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch {
      return { changed: false, reason: "state-file-missing" };
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      return { changed: false, reason: "state-file-unparseable" };
    }

    const res = applyApprovalWriteback(state, rowId, outcome, nowIso, details);
    if (!res.changed) return { changed: false, reason: res.reason };

    // Atomic: same-directory temp + rename, so a crash or a concurrent reader
    // can only ever see the whole old file or the whole new one. A torn write
    // here would destroy the entire issue history.
    const dir = path.dirname(statePath);
    const tmp = path.join(dir, `.${path.basename(statePath)}.writeback.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(res.state, null, 2) + "\n");
      fs.renameSync(tmp, statePath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      return { changed: false, reason: "write-failed", error: (e?.message || String(e)).trim() };
    }
    return { changed: true, cluster_id: res.cluster_id, from: res.from, to: res.to };
  } catch (e) {
    return { changed: false, reason: "writeback-threw", error: (e?.message || String(e)).trim() };
  }
}
