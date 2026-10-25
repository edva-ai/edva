// Tests for the approval → system-issue-review state writeback.
//
// REGRESSION GUARD: approval-writeback stall — "an approved Face-ID card
// lands in the tree while its cluster stays `awaiting_approval` forever". It
// recurred several times before this module existed. What is pinned here is
// the whole of the contract that matters: the two transitions, the id-prefix
// floor, and the promise that a broken state file can never take the applier
// down with it.
//
// Fixture ids are arbitrary uuid/prefix pairs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VERIFY_WINDOW_MS,
  MIN_ID_PREFIX,
  idMatches,
  isUuidShaped,
  clusterCarriesApproval,
  applyApprovalWriteback,
  writebackApprovalOutcome,
} from "../lib/system-issue-writeback.mjs";

const FULL_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const SHORT_ID = "1a2b3c4d";
const NOW = "2026-08-14T04:27:00.000Z";

const cluster = (over = {}) => ({
  id: "sic-triage-sweep-phantom-rounds",
  title: "triage sweep re-runs phantom rounds",
  match_patterns: ["triage sweep"],
  component: "agent/ops-agent",
  first_seen: "2026-08-13T00:00:00Z",
  last_seen: "2026-08-13T19:00:00Z",
  occurrences: 4,
  severity: "degraded",
  status: "awaiting_approval",
  attempts: [
    {
      ts: "2026-08-13T08:40:00.000Z",
      risk: "high",
      summary: "stage a fix behind a Face-ID card",
      approval_id: FULL_ID,
    },
  ],
  verify_after: null,
  notes: "",
  ...over,
});
const state = (over = {}) => ({
  schema_version: 1,
  last_run: "2026-08-13T04:27:00.000Z",
  cursor_ts: "2026-08-13T19:50:02.869893+00:00",
  clusters: [cluster()],
  run_log: [],
  ...over,
});

// ─── (a) an applied row opens the verification window ─────────────────────

test("an applied row advances awaiting_approval → verifying with verify_after ~3d out", () => {
  const res = applyApprovalWriteback(state(), FULL_ID, "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.from, "awaiting_approval");
  assert.equal(res.to, "verifying");
  assert.equal(res.cluster_id, "sic-triage-sweep-phantom-rounds");

  const c = res.state.clusters[0];
  assert.equal(c.status, "verifying");
  assert.equal(Date.parse(c.verify_after) - Date.parse(NOW), VERIFY_WINDOW_MS);
  assert.equal(VERIFY_WINDOW_MS, 3 * 24 * 3600e3, "the playbook's window is 3 days");
  assert.equal(c.attempts[0].outcome, "applied");
  assert.equal(c.attempts[0].applied_at, NOW);
});

test("the input state is never mutated and other clusters stay byte-identical", () => {
  const other = cluster({ id: "sic-other", status: "resolved", attempts: [], verify_after: null });
  const before = state({ clusters: [cluster(), other] });
  const snapshot = JSON.stringify(before);

  const res = applyApprovalWriteback(before, FULL_ID, "applied", NOW);
  assert.equal(JSON.stringify(before), snapshot, "pure — the caller's object is untouched");
  assert.equal(res.state.clusters[1], other, "untouched clusters carry through by reference");
  // Everything on the patched cluster except the three named fields is identical.
  const a = { ...before.clusters[0] }, b = { ...res.state.clusters[0] };
  delete a.status; delete a.verify_after; delete a.attempts;
  delete b.status; delete b.verify_after; delete b.attempts;
  assert.deepEqual(b, a);
});

test("only what actually exists is recorded — no invented commit sha", () => {
  const bare = applyApprovalWriteback(state(), FULL_ID, "applied", NOW);
  assert.equal("commit" in bare.state.clusters[0].attempts[0], false);

  const withDetails = applyApprovalWriteback(state(), FULL_ID, "applied", NOW, {
    commit: "abc1234",
    files: ["bin/p1-downgrade"],
  });
  assert.equal(withDetails.state.clusters[0].attempts[0].commit, "abc1234");
  assert.deepEqual(withDetails.state.clusters[0].attempts[0].files, ["bin/p1-downgrade"]);
});

// ─── (b) a skip is terminal (CRITICAL RULE 9) ─────────────────────────────

test("a skipped row closes the cluster wontfix / owner-skipped", () => {
  const res = applyApprovalWriteback(state(), FULL_ID, "skipped", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.to, "wontfix");
  const c = res.state.clusters[0];
  assert.equal(c.status, "wontfix");
  assert.equal(c.resolution, "owner-skipped");
  assert.equal(c.attempts[0].outcome, "skipped");
  assert.equal(c.verify_after, null, "a skip has nothing to verify — no window opens");
});

// ─── (c)/(d) id matching, and the prefix floor ────────────────────────────

test("a short-prefix id still matches, in either direction", () => {
  assert.equal(idMatches(SHORT_ID, FULL_ID), true);
  assert.equal(idMatches(FULL_ID, SHORT_ID), true);
  assert.equal(idMatches(FULL_ID, FULL_ID), true);
  // The CLI surfaces the 8-char prefix; the state file holds the uuid.
  const res = applyApprovalWriteback(state(), SHORT_ID, "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.state.clusters[0].status, "verifying");
});

test("a 7-char-or-shorter overlap does NOT match", () => {
  assert.equal(MIN_ID_PREFIX, 8);
  assert.equal(idMatches("1a2b3c4", FULL_ID), false, "7 chars is below the floor");
  assert.equal(idMatches("1a2b", FULL_ID), false);
  assert.equal(idMatches("", FULL_ID), false);
  const res = applyApprovalWriteback(state(), "1a2b3c4", "applied", NOW);
  assert.equal(res.changed, false, "a below-floor prefix must never rewrite an unrelated issue");
  assert.equal(res.state.clusters[0].status, "awaiting_approval");
});

test("an 8-char string that is not a prefix does not match", () => {
  assert.equal(idMatches("1a2b3c4e", FULL_ID), false);
  for (const junk of [null, undefined, 42, {}, []]) {
    assert.equal(idMatches(junk, FULL_ID), false);
    assert.equal(idMatches(FULL_ID, junk), false);
  }
});

// ─── guards: only the cluster that filed the card is ours to move ─────────

test("a cluster not in a card-filing state is left alone", () => {
  // `escalated` was deliberately REMOVED from this list
  // (escalated-writeback no-op): it is a card-filing state (Step 7)
  // and is now advanced — see the dedicated section below.
  for (const status of ["verifying", "resolved", "reviewed", "open", "wontfix"]) {
    const before = state({ clusters: [cluster({ status })] });
    const snapshot = JSON.stringify(before);
    const res = applyApprovalWriteback(before, FULL_ID, "applied", NOW);
    assert.equal(res.changed, false, `${status} must not be clobbered`);
    assert.equal(res.reason, "not-awaiting-approval");
    assert.equal(JSON.stringify(res.state), snapshot, `${status}: state carried through unchanged`);
  }
});

// ─── a Step 7 `escalated` card is a filing state too ─────────────────────
//
// REGRESSION GUARD: escalated-writeback no-op — "a signed Step 7 decision
// card no-ops with not-awaiting-approval and its cluster stays `escalated`
// forever". system-issue-review.md Step 7 files its Face-ID card and sets the
// cluster `escalated`, not `awaiting_approval`; the writeback only accepted
// the latter, so one Step 7 card logged `writeback … no-op:
// not-awaiting-approval` while another, filed as `awaiting_approval`, wrote
// back.

const ESCALATED_ID = "5e6f7a8b-0000-4000-8000-000000000002";

/** Earlier failed attempts, then the Step 7 card. */
const escalatedCluster = (over = {}) =>
  cluster({
    id: "sic-digest-email-send-fail",
    title: "digest built but email-send failed",
    status: "escalated",
    attempts: [
      { approval_id: "9c8d7e6f-0000-4000-8000-000000000003", commit: "def5678", outcome: "recurred" },
      { commit: "fed9876", outcome: "recurred" },
      { ts: "2026-10-08T04:27:00.000Z", risk: "high", summary: "Step 7 decision card", approval_id: ESCALATED_ID },
    ],
    ...over,
  });

test("an escalated cluster carrying the approval goes to verifying on applied", () => {
  const res = applyApprovalWriteback(state({ clusters: [escalatedCluster()] }), ESCALATED_ID, "applied", NOW);
  assert.equal(res.changed, true, "this used to return not-awaiting-approval");
  assert.equal(res.reason, null);
  assert.equal(res.cluster_id, "sic-digest-email-send-fail");
  assert.equal(res.from, "escalated");
  assert.equal(res.to, "verifying");

  const c = res.state.clusters[0];
  assert.equal(c.status, "verifying");
  assert.equal(Date.parse(c.verify_after) - Date.parse(NOW), VERIFY_WINDOW_MS, "the 3-day window opens");
  // Only the attempt carrying this approval is stamped; the older ones survive.
  assert.equal(c.attempts[2].outcome, "applied");
  assert.equal(c.attempts[2].applied_at, NOW);
  assert.equal(c.attempts[0].outcome, "recurred");
  assert.equal("applied_at" in c.attempts[0], false);
  assert.equal(c.attempts[1].outcome, "recurred");
});

test("an escalated cluster is matched by the 8-char prefix the poller and card surface", () => {
  const res = applyApprovalWriteback(state({ clusters: [escalatedCluster()] }), "5e6f7a8b", "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.to, "verifying");
});

test("an escalated cluster goes to wontfix / owner-skipped on skipped", () => {
  const res = applyApprovalWriteback(state({ clusters: [escalatedCluster()] }), ESCALATED_ID, "skipped", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.from, "escalated");
  assert.equal(res.to, "wontfix");
  const c = res.state.clusters[0];
  assert.equal(c.status, "wontfix");
  assert.equal(c.resolution, "owner-skipped", "the operator declining a Step 7 card is exactly wontfix");
  assert.equal(c.verify_after, null, "a skip opens no verify window");
  assert.equal(c.attempts[2].outcome, "skipped");
  assert.equal(c.attempts[2].skipped_at, NOW);
});

test("an escalated cluster still requires the approval id — no id, no move", () => {
  const res = applyApprovalWriteback(state({ clusters: [escalatedCluster()] }), FULL_ID, "applied", NOW);
  assert.equal(res.changed, false);
  assert.equal(res.reason, "no-matching-cluster");
  assert.equal(res.state.clusters[0].status, "escalated");
});

test("a finished cluster carrying a Step 7 approval id is still refused, unchanged", () => {
  for (const status of ["resolved", "verifying", "open", "reviewed", "wontfix"]) {
    const before = state({ clusters: [escalatedCluster({ status })] });
    const snapshot = JSON.stringify(before);
    const res = applyApprovalWriteback(before, ESCALATED_ID, "applied", NOW);
    assert.equal(res.changed, false, `${status} must never be clobbered`);
    assert.equal(res.reason, "not-awaiting-approval", "reason string kept verbatim for the poller log");
    assert.equal(JSON.stringify(res.state), snapshot);
  }
});

test("an escalated writeback round-trips through the file writer and is idempotent", () => {
  const dir = tmpdir();
  const p = path.join(dir, "system-issue-review-state.json");
  fs.writeFileSync(p, JSON.stringify(state({ clusters: [escalatedCluster()] }), null, 2) + "\n");

  const res = writebackApprovalOutcome(p, ESCALATED_ID, "applied", NOW);
  assert.deepEqual(res, {
    changed: true,
    cluster_id: "sic-digest-email-send-fail",
    from: "escalated",
    to: "verifying",
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).clusters[0].status, "verifying");
  assert.deepEqual(fs.readdirSync(dir), ["system-issue-review-state.json"], "no .tmp left behind");

  // A second tick sees `verifying` and leaves it alone.
  assert.equal(writebackApprovalOutcome(p, ESCALATED_ID, "applied", NOW).reason, "not-awaiting-approval");
});

test("a mis-attributed duplicate approval_id only moves the awaiting cluster", () => {
  // A real state file has had one fix recorded against two clusters.
  const stale = cluster({ id: "sic-mis-attributed", status: "resolved" });
  const res = applyApprovalWriteback(state({ clusters: [stale, cluster()] }), FULL_ID, "applied", NOW);
  assert.equal(res.cluster_id, "sic-triage-sweep-phantom-rounds");
  assert.equal(res.state.clusters[0], stale);
  assert.equal(res.state.clusters[1].status, "verifying");
});

test("an unknown approval id, a junk outcome and a shapeless state are all quiet no-ops", () => {
  assert.equal(applyApprovalWriteback(state(), "ffffffff-0000-0000-0000-000000000000", "applied", NOW).reason, "no-matching-cluster");
  assert.equal(applyApprovalWriteback(state(), FULL_ID, "exploded", NOW).changed, false);
  assert.equal(applyApprovalWriteback(state(), "", "applied", NOW).changed, false);
  for (const junk of [null, undefined, {}, { clusters: "nope" }, 7]) {
    assert.doesNotThrow(() => applyApprovalWriteback(junk, FULL_ID, "applied", NOW));
    assert.equal(applyApprovalWriteback(junk, FULL_ID, "applied", NOW).changed, false);
  }
});

test("a cluster with junk attempts does not throw", () => {
  for (const attempts of [null, "nope", [null, 3, {}, { approval_id: 9 }]]) {
    assert.doesNotThrow(() =>
      applyApprovalWriteback(state({ clusters: [cluster({ attempts })] }), FULL_ID, "applied", NOW),
    );
  }
});

// ─── the approval id is looked for in three fields, not one ──────────────
//
// REGRESSION GUARD: approval-id field mismatch — "the writeback only
// scanned attempts[].approval_id, so an approval filed into the wrong field
// was invisible and its cluster stalled anyway". A filing agent recorded the
// approval uuid in the attempt's `commit` field and left the cluster-level
// `approval_id` unset; the writeback returned "no-matching-cluster" and the
// cluster sat `awaiting_approval` for days — invisible to Step 2d (walks only
// `verifying`) and to Step 3 (skips `awaiting_approval`). The fixture below
// has that shape.
//
// The load-bearing half of the fix is the uuid guard: `commit` legitimately
// holds git SHAs and idMatches() accepts an 8-char prefix overlap, so without
// it an abbreviated SHA could match an approval-id prefix and rewrite an
// unrelated issue's status. That case is pinned first.

const MISFILED_ID = "c0ffee01-0000-4000-8000-000000000004";

/** A misfiled record: uuid in `commit`, no approval_id anywhere. */
const misfiledCluster = (over = {}) => ({
  id: "sic-calendar-audit-unexplained-invites",
  title: "calendar-attendee-audit reports invites the operator created as unexplained",
  component: "bin/calendar-attendee-audit",
  occurrences: 2,
  severity: "noise",
  status: "awaiting_approval",
  disposition: "fix",
  approval_id: null,
  attempts: [
    {
      at: "2026-08-19T08:35:18.166Z",
      outcome: "awaiting_approval",
      risk: "high",
      commit: MISFILED_ID,
      summary: "Face-ID card: report each unaccounted event ONCE via a gitignored seen-ledger",
    },
  ],
  verify_after: null,
  ...over,
});

test("a git sha in attempts[].commit is NEVER matched, however much leading hex it shares", () => {
  // The collision this guard exists to stop: an abbreviated sha whose hex is a
  // legal 8-char prefix of a real approval uuid.
  const shaId = "bead1234-1c40-4a2e-9db8-63a0f4c1e5b7"; // an approval uuid
  const SHORT_SHA = "bead1234";                          // `git log --oneline`
  const LONG_SHA = "bead12347c93b1e0a5d4f28c6b91e3a7d0c4b8e2";

  // Both real collision directions the raw prefix logic admits. (A >8-char sha
  // vs the full uuid is safe by accident — the uuid has a dash at index 8 —
  // which is exactly the kind of accident not to rely on.)
  assert.equal(idMatches(SHORT_SHA, shaId), true, "8-char sha vs full uuid WOULD have collided");
  assert.equal(idMatches(SHORT_SHA, LONG_SHA), true, "an 8-char id prefix vs a full sha WOULD have collided");

  for (const [sha, rowId] of [[SHORT_SHA, shaId], [LONG_SHA, SHORT_SHA], [LONG_SHA, shaId], ["bead12347c40", shaId]]) {
    assert.equal(isUuidShaped(sha), false, `${sha} is a git sha, not a uuid`);
    const c = misfiledCluster({ attempts: [{ at: "2026-08-19T08:35:18.166Z", outcome: "awaiting_approval", commit: sha }] });
    assert.equal(clusterCarriesApproval(c, rowId), false, `a ${sha.length}-char sha must not be read as an approval id`);
    const res = applyApprovalWriteback(state({ clusters: [c] }), rowId, "applied", NOW);
    assert.equal(res.changed, false, "an unrelated issue must never be rewritten off a sha collision");
    assert.equal(res.reason, "no-matching-cluster");
    assert.equal(res.state.clusters[0].status, "awaiting_approval");
  }
});

test("isUuidShaped accepts only a full 8-4-4-4-12 hex uuid", () => {
  assert.equal(isUuidShaped(MISFILED_ID), true);
  assert.equal(isUuidShaped(MISFILED_ID.toUpperCase()), true);
  assert.equal(isUuidShaped(` ${MISFILED_ID} `), true, "trimmed like idMatches does");
  for (const bad of [
    "c0ffee01",                                     // the 8-char prefix alone
    "c0ffee0100004000800000000000004a",             // dashless
    "c0ffee01-0000-4000-8000-00000000000",          // one hex short
    "zoffee01-0000-4000-8000-000000000004",         // non-hex
    "abc1234", "", null, undefined, 42, {}, [],
  ]) {
    assert.equal(isUuidShaped(bad), false, `${String(bad)} must not pass as a uuid`);
  }
});

test("an approval misfiled into attempts[].commit is found and advanced to verifying", () => {
  const res = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), MISFILED_ID, "applied", NOW);
  assert.equal(res.changed, true, "the 5-day stall: this used to return no-matching-cluster");
  assert.equal(res.cluster_id, "sic-calendar-audit-unexplained-invites");
  assert.equal(res.from, "awaiting_approval");
  assert.equal(res.to, "verifying");

  const c = res.state.clusters[0];
  assert.equal(c.status, "verifying");
  assert.equal(Date.parse(c.verify_after) - Date.parse(NOW), VERIFY_WINDOW_MS, "the verification window finally opens");
  assert.equal(c.attempts[0].outcome, "applied");
  assert.equal(c.attempts[0].applied_at, NOW);
});

test("a commit-field match backfills approval_id so the next lookup takes the canonical path", () => {
  const res = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), MISFILED_ID, "applied", NOW);
  const a = res.state.clusters[0].attempts[0];
  assert.equal(a.approval_id, MISFILED_ID, "self-healed into its canonical home");

  // And the healed record is now reachable by the original, unwidened path.
  const healed = { ...res.state.clusters[0], status: "awaiting_approval" };
  assert.equal(healed.attempts.some((x) => idMatches(x.approval_id, MISFILED_ID)), true);
  const again = applyApprovalWriteback(state({ clusters: [healed] }), MISFILED_ID, "applied", NOW);
  assert.equal(again.changed, true);
  assert.equal(again.to, "verifying");
});

test("an 8-char prefix of a misfiled approval id also matches, but the stored value must be a full uuid", () => {
  const res = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), "c0ffee01", "applied", NOW);
  assert.equal(res.changed, true, "the CLI and the channel card only ever surface the 8-char prefix");
  assert.equal(res.state.clusters[0].attempts[0].approval_id, MISFILED_ID, "backfilled with the full uuid, not the prefix");

  // …but a merely-8-char stored value is a sha, not an id, and stays ignored.
  const truncated = misfiledCluster({ attempts: [{ commit: "c0ffee01", outcome: "awaiting_approval" }] });
  assert.equal(applyApprovalWriteback(state({ clusters: [truncated] }), MISFILED_ID, "applied", NOW).changed, false);
});

test("a cluster-level approval_id matches, and is uuid-guarded too", () => {
  const c = misfiledCluster({ approval_id: MISFILED_ID, attempts: [] });
  assert.equal(clusterCarriesApproval(c, MISFILED_ID), true);
  const res = applyApprovalWriteback(state({ clusters: [c] }), MISFILED_ID, "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.to, "verifying");
  assert.deepEqual(res.state.clusters[0].attempts, [], "no attempt is ours to stamp — none is invented");

  // A non-uuid cluster-level value is ignored outright.
  for (const bad of ["c0ffee01", "bead12347c93b1e0a5d4f28c6b91e3a7d0c4b8e2", 7, null]) {
    const junk = misfiledCluster({ approval_id: bad, attempts: [] });
    assert.equal(clusterCarriesApproval(junk, MISFILED_ID), false);
    assert.equal(applyApprovalWriteback(state({ clusters: [junk] }), MISFILED_ID, "applied", NOW).changed, false);
  }
});

test("a cluster matched only at cluster level keeps a missing/malformed attempts field untouched", () => {
  for (const attempts of [undefined, null, "nope", 7]) {
    const c = misfiledCluster({ approval_id: MISFILED_ID, attempts });
    let res;
    assert.doesNotThrow(() => { res = applyApprovalWriteback(state({ clusters: [c] }), MISFILED_ID, "applied", NOW); });
    assert.equal(res.changed, true);
    assert.equal(res.state.clusters[0].status, "verifying");
    assert.equal(res.state.clusters[0].attempts, attempts, "carried through as-is; no key invented, none coerced");
  }
  // Genuinely absent stays absent rather than being added back as [].
  const bare = misfiledCluster({ approval_id: MISFILED_ID });
  delete bare.attempts;
  const res = applyApprovalWriteback(state({ clusters: [bare] }), MISFILED_ID, "applied", NOW);
  assert.equal("attempts" in res.state.clusters[0], false);
});

test("the widened lookup keeps the not-awaiting-approval vs no-matching-cluster distinction", () => {
  for (const status of ["verifying", "resolved", "wontfix"]) {
    const res = applyApprovalWriteback(state({ clusters: [misfiledCluster({ status })] }), MISFILED_ID, "applied", NOW);
    assert.equal(res.changed, false);
    assert.equal(res.reason, "not-awaiting-approval", "found, but already advanced — never clobber history");
  }
  const other = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), FULL_ID, "applied", NOW);
  assert.equal(other.reason, "no-matching-cluster");
});

test("a canonical approval_id still wins over a uuid-shaped commit on the same attempt", () => {
  // Both fields populated with DIFFERENT uuids: the canonical field decides,
  // and its value is not overwritten by the backfill.
  const c = misfiledCluster({
    attempts: [{ at: "2026-08-19T08:35:18.166Z", outcome: "awaiting_approval", approval_id: FULL_ID, commit: MISFILED_ID }],
  });
  const viaCanonical = applyApprovalWriteback(state({ clusters: [c] }), FULL_ID, "applied", NOW);
  assert.equal(viaCanonical.changed, true);
  assert.equal(viaCanonical.state.clusters[0].attempts[0].approval_id, FULL_ID, "not clobbered by the backfill");
  assert.equal(viaCanonical.state.clusters[0].attempts[0].commit, MISFILED_ID);

  // And the commit-field path must NOT claim it under the misfiled id. Once
  // `approval_id` is populated the attempt belongs to that card; matching on
  // `commit` here would backfill over a live approval id and lose it from the
  // only copy of this issue history — and would advance the cluster to
  // `verifying` under the wrong approval, so when FULL_ID later applies it gets
  // `not-awaiting-approval` and the original stall returns.
  const viaCommit = applyApprovalWriteback(state({ clusters: [c] }), MISFILED_ID, "applied", NOW);
  assert.equal(viaCommit.changed, false, "a populated approval_id is never overridden by commit");
  assert.equal(viaCommit.reason, "no-matching-cluster");
  assert.equal(viaCommit.state.clusters[0].attempts[0].approval_id, FULL_ID, "the live approval id survives");
  assert.equal(viaCommit.state.clusters[0].attempts[0].commit, MISFILED_ID);
});

test("a skip through the commit-field path is still terminal, with the same backfill", () => {
  const res = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), MISFILED_ID, "skipped", NOW);
  const c = res.state.clusters[0];
  assert.equal(c.status, "wontfix");
  assert.equal(c.resolution, "owner-skipped");
  assert.equal(c.verify_after, null);
  assert.equal(c.attempts[0].outcome, "skipped");
  assert.equal(c.attempts[0].skipped_at, NOW);
  assert.equal(c.attempts[0].approval_id, MISFILED_ID);
});

test("a real commit sha supplied in details still overwrites the misfiled uuid, after the backfill", () => {
  const res = applyApprovalWriteback(state({ clusters: [misfiledCluster()] }), MISFILED_ID, "applied", NOW, {
    commit: "abc1234",
    files: ["bin/calendar-attendee-audit"],
  });
  const a = res.state.clusters[0].attempts[0];
  assert.equal(a.approval_id, MISFILED_ID, "the id is preserved in its canonical field");
  assert.equal(a.commit, "abc1234", "and `commit` goes back to meaning a commit");
  assert.deepEqual(a.files, ["bin/calendar-attendee-audit"]);
});

test("the widened lookup round-trips through the real file writer", () => {
  const dir = tmpdir();
  const p = path.join(dir, "system-issue-review-state.json");
  fs.writeFileSync(p, JSON.stringify(state({ clusters: [misfiledCluster()] }), null, 2) + "\n");

  const res = writebackApprovalOutcome(p, "c0ffee01", "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.cluster_id, "sic-calendar-audit-unexplained-invites");

  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.clusters[0].status, "verifying");
  assert.equal(after.clusters[0].attempts[0].approval_id, MISFILED_ID);
  assert.deepEqual(fs.readdirSync(dir), ["system-issue-review-state.json"], "no .tmp left behind");

  // Idempotent, exactly as on the canonical path.
  assert.equal(writebackApprovalOutcome(p, "c0ffee01", "applied", NOW).reason, "not-awaiting-approval");
});

// ─── (e) I/O: a missing or corrupt state file is a silent no-op ───────────

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "si-writeback-"));
}

test("a missing state file is a silent no-op that does not throw", () => {
  const p = path.join(tmpdir(), "nope.json");
  let res;
  assert.doesNotThrow(() => { res = writebackApprovalOutcome(p, FULL_ID, "applied", NOW); });
  assert.equal(res.changed, false);
  assert.equal(res.reason, "state-file-missing");
  assert.equal(fs.existsSync(p), false, "a missing file is not created");
});

test("a corrupt state file is a silent no-op that leaves the bytes untouched", () => {
  const p = path.join(tmpdir(), "state.json");
  const corrupt = '{"clusters": [ truncated mid-writ';
  fs.writeFileSync(p, corrupt);
  let res;
  assert.doesNotThrow(() => { res = writebackApprovalOutcome(p, FULL_ID, "applied", NOW); });
  assert.equal(res.changed, false);
  assert.equal(res.reason, "state-file-unparseable");
  assert.equal(fs.readFileSync(p, "utf8"), corrupt);
});

test("a real write round-trips, is atomic, and leaves no temp file behind", () => {
  const dir = tmpdir();
  const p = path.join(dir, "system-issue-review-state.json");
  fs.writeFileSync(p, JSON.stringify(state(), null, 2) + "\n");

  const res = writebackApprovalOutcome(p, SHORT_ID, "applied", NOW);
  assert.equal(res.changed, true);
  assert.equal(res.to, "verifying");

  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.clusters[0].status, "verifying");
  assert.equal(Date.parse(after.clusters[0].verify_after) - Date.parse(NOW), VERIFY_WINDOW_MS);
  assert.equal(after.schema_version, 1, "unrelated top-level fields survive");
  assert.equal(after.cursor_ts, "2026-08-13T19:50:02.869893+00:00");
  assert.equal(fs.readFileSync(p, "utf8").endsWith("\n"), true, "2-space JSON + trailing newline, as written by the job");
  assert.deepEqual(fs.readdirSync(dir), ["system-issue-review-state.json"], "no .tmp left behind");

  // Idempotent: the second tick sees `verifying`, not `awaiting_approval`.
  const again = writebackApprovalOutcome(p, SHORT_ID, "applied", NOW);
  assert.equal(again.changed, false);
  assert.equal(again.reason, "not-awaiting-approval");
});

test("an unwritable target degrades to a logged no-op instead of throwing", () => {
  const dir = tmpdir();
  const p = path.join(dir, "state.json");
  fs.writeFileSync(p, JSON.stringify(state(), null, 2) + "\n");
  fs.chmodSync(dir, 0o500); // no write permission on the directory
  try {
    let res;
    assert.doesNotThrow(() => { res = writebackApprovalOutcome(p, FULL_ID, "applied", NOW); });
    assert.equal(res.changed, false);
    assert.equal(res.reason, "write-failed");
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).clusters[0].status, "awaiting_approval");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
