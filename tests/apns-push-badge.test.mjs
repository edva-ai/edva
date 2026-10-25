// apns-push-badge.test.mjs — the app-icon badge on an Improvements push must
// reflect pending Face-ID approvals, not chat-unread alone.
//
// Root cause: sendApnsPush() computed aps.badge from unread
// edva_messages(channel=chat) only, for every non-system channel — so a
// push announcing a brand-new high-risk self-improve card carried whatever
// chat-unread happened to be (often 0), with no signal a card was waiting.
// The in-app hamburger badge already knew about pending approvals
// (ChannelBadges.swift / SelfImproveApproval.pendingApprovalCount) — this
// locks the push badge to the same predicate so the two can't drift apart.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isApprovalRowPending,
  getPendingApprovalCount,
  computeBadgeCount,
} from "../lib/apns-push.mjs";

test("computeBadgeCount sums chat-unread and pending approvals", () => {
  assert.equal(
    computeBadgeCount(0, 1),
    1,
    "an improvements push with 0 chat-unread must still show 1 — this is the bug: it used to fall through to the chat-only 0",
  );
  assert.equal(computeBadgeCount(3, 2), 5);
  assert.equal(computeBadgeCount(0, 0), 1, "falls back to 1 so a real push never shows a 0 badge");
  assert.equal(computeBadgeCount(null, undefined), 1);
});

test("isApprovalRowPending: high risk (or unset), not expired, counts", () => {
  const now = 1_700_000_000_000;
  assert.equal(isApprovalRowPending({ risk: "high", expires_at_ms: null }, now), true);
  assert.equal(
    isApprovalRowPending({ risk: null, expires_at_ms: null }, now),
    true,
    'unset risk defaults to high, matching SelfImproveApproval.swift\'s (row.risk ?? "high")',
  );
  assert.equal(isApprovalRowPending({ risk: "high", expires_at_ms: now + 1000 }, now), true);
});

test("isApprovalRowPending: low/moderate risk or expired rows do not count", () => {
  const now = 1_700_000_000_000;
  assert.equal(isApprovalRowPending({ risk: "low", expires_at_ms: null }, now), false);
  assert.equal(isApprovalRowPending({ risk: "moderate", expires_at_ms: null }, now), false);
  assert.equal(
    isApprovalRowPending({ risk: "high", expires_at_ms: now - 1000 }, now),
    false,
    "an expired card must not keep the badge lit",
  );
});

function fakeSupabase(rows, { errorOnQuery = false } = {}) {
  const builder = {
    eq() {
      return builder;
    },
    select() {
      return builder;
    },
    then(resolve) {
      resolve(errorOnQuery ? { data: null, error: new Error("boom") } : { data: rows, error: null });
    },
  };
  return { from: () => builder };
}

test("getPendingApprovalCount filters rows via isApprovalRowPending", async () => {
  const now = Date.now();
  const rows = [
    { status: "pending", risk: "high", expires_at_ms: null },
    { status: "pending", risk: "low", expires_at_ms: null },
    { status: "pending", risk: "high", expires_at_ms: now - 1000 },
  ];
  const count = await getPendingApprovalCount(fakeSupabase(rows));
  assert.equal(count, 1);
});

test("getPendingApprovalCount fails open (0, not throw) on a query error", async () => {
  const count = await getPendingApprovalCount(fakeSupabase(null, { errorOnQuery: true }));
  assert.equal(count, 0);
});

test("system-channel pushes still skip the badge entirely", () => {
  // Guards the adjacent invariant this fix must not disturb: infra alerts on
  // `system` never touch the icon badge (agent/CLAUDE.md § System
  // Channel — a never-opened system backlog must not inflate every push).
  const src = fs.readFileSync(new URL("../lib/apns-push.mjs", import.meta.url), "utf8");
  assert.match(src, /channel !== "system"/, 'the badge computation must still be gated on channel !== "system"');
});
