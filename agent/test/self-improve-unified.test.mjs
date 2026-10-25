// self-improve-unified.test.mjs — the unified high-risk approval flow: request →
// (app signs) → verify → apply. Fake store/keys/apply; a real P-256 device.
//
// Run: node --test agent/test/self-improve-unified.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createUnifiedApproval, blocksDuplicate } from "../core/self-improve-unified.mjs";
import { canonicalMessage } from "../core/app-approval.mjs";

function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const pad = (b) => { const x = Buffer.from(b, "base64url"); return x.length === 32 ? x : Buffer.concat([Buffer.alloc(32 - x.length), x]); };
  const raw = Buffer.concat([Buffer.from([0x04]), pad(jwk.x), pad(jwk.y)]).toString("base64");
  return { id: "device-1", publicKeyRawB64: raw, sign: (m) => crypto.sign("sha256", Buffer.from(m, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64") };
}

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async insertApproval(r) { rows.set(r.id, { ...r }); },
    async updateApproval(id, patch) { rows.set(id, { ...rows.get(id), ...patch }); },
    async getApproval(id) { return rows.get(id) || null; },
    async listSignedPending() { return [...rows.values()].filter((r) => r.signature && !["applied", "denied", "expired", "failed", "apply_failed"].includes(r.status)); },
    async findByItemHash(hash) { return [...rows.values()].filter((r) => r.item_hash === hash); },
    async listUnsignedPending() { return [...rows.values()].filter((r) => !r.signature && r.status === "pending" && !r.skipped); },
  };
}

// Every existing test in this file predates the staleness gate and exercises
// signing/apply/skip mechanics that have nothing to do with it, so the default
// fake always says "pass" — none of them should pay for (or depend on) a real
// claim-freshness call. Tests of the gate itself override this explicitly.
const PASS = async () => ({ verdict: "pass" });

function harness({ device, applyResult = { ok: true, result: "loaded" }, now = () => 1_000_000, checkFreshness = PASS } = {}) {
  const store = fakeStore();
  const posted = [];
  const applied = [];
  const u = createUnifiedApproval({
    store,
    deviceKeys: { getKey: async (id) => (id === device.id ? { public_key_raw: device.publicKeyRawB64 } : null) },
    postSuggestion: async (s, r, t, id) => posted.push({ s, r, t, id }),
    applyItem: async (row) => { applied.push(row.id); return applyResult; },
    checkFreshness,
    now, ttlMs: 10_000,
  });
  return { u, store, posted, applied, now };
}

// Simulate the app: sign the canonical message and write the signature.
function sign(store, id, device) {
  const row = store.rows.get(id);
  // Mirror the app: sign against the verbatim expires_at_ms integer (what the
  // client reads), not a value reconstructed from the timestamp.
  const msg = canonicalMessage({ id, hash: row.item_hash, nonce: row.nonce, expiresAt: Number(row.expires_at_ms) });
  store.rows.set(id, { ...row, signature: device.sign(msg), signed_by: device.id, status: "signed" });
}

describe("unified approval: request → surface (nothing applied)", () => {
  it("persists a pending row + posts to the Improvements channel, applies nothing", async () => {
    const device = makeDevice();
    const { u, store, posted, applied } = harness({ device });
    const r = await u.requestApproval({ itemType: "new-capability", summary: "add kelvin tool", rationale: "temps", item: { module: "kelvin" } });
    assert.ok(r.id && r.hash && r.nonce);
    const row = await store.getApproval(r.id);
    assert.equal(row.status, "pending");
    assert.equal(row.signature, undefined);
    // the verbatim epoch-ms is persisted and equals the request's expiresAt
    assert.equal(typeof row.expires_at_ms, "number");
    assert.equal(row.expires_at_ms, r.expiresAt);
    assert.equal(posted.length, 1);
    assert.equal(applied.length, 0, "nothing applied before a signature");
  });
});

// ── staleness recheck before a card is shown ─────────────────────────────
// A card filed in the morning can argue from a pattern the user overturned by
// the time it is shown. The fix wires the same claim-freshness gate that
// already guards outbound pings into the one release point a Face-ID card
// has: the text shown when it's posted.
describe("unified approval: staleness recheck before the card is shown", () => {
  it("a 'drop' verdict creates no row and posts nothing", async () => {
    const device = makeDevice();
    const seen = [];
    const checkFreshness = async (input) => { seen.push(input); return { verdict: "drop", reasons: ["memory shows it resolved"] }; };
    const { u, store, posted } = harness({ device, checkFreshness });
    const r = await u.requestApproval({ itemType: "code-fix", summary: "stale claim", rationale: "why", item: { files: { a: "1" } } });
    assert.equal(r.ok, false);
    assert.equal(r.dropped, true);
    assert.equal(r.reason, "memory shows it resolved");
    assert.equal(store.rows.size, 0, "no approval row was created");
    assert.equal(posted.length, 0, "nothing was posted to the Improvements channel");
    // the gate saw the combined summary+rationale, not just one field
    assert.equal(seen[0].text, "stale claim\n\nwhy");
    assert.equal(seen[0].subject, "code-fix");
    assert.equal(seen[0].solicited, false, "a self-improvement card is proactive — nobody asked for THIS one");
  });

  it("a 'rewrite' verdict appends the corrected framing to the rationale and still posts + persists it", async () => {
    const device = makeDevice();
    const checkFreshness = async () => ({ verdict: "rewrite", corrected_text: "as of Monday, the customer had not yet enrolled" });
    const { u, store, posted } = harness({ device, checkFreshness });
    const r = await u.requestApproval({ itemType: "code-fix", summary: "s", rationale: "original reasoning", item: { files: { a: "1" } } });
    assert.equal(r.ok, true);
    assert.equal(r.staleness_rewritten, true);
    const row = await store.getApproval(r.id);
    assert.match(row.rationale, /^original reasoning\n\n/);
    assert.match(row.rationale, /as of Monday, the customer had not yet enrolled/);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].r, row.rationale, "the posted message carries the same rewritten rationale that was persisted");
  });

  it("a 'pass' verdict leaves summary/rationale untouched", async () => {
    const device = makeDevice();
    const checkFreshness = async () => ({ verdict: "pass", reasons: ["fresh_evidence"] });
    const { u, store } = harness({ device, checkFreshness });
    const r = await u.requestApproval({ itemType: "code-fix", summary: "s", rationale: "unchanged", item: { files: { a: "1" } } });
    assert.equal(r.ok, true);
    assert.equal(r.staleness_rewritten, false);
    assert.equal((await store.getApproval(r.id)).rationale, "unchanged");
  });

  it("fails open: a throwing checkFreshness still creates and posts the card", async () => {
    const device = makeDevice();
    const checkFreshness = async () => { throw new Error("sonnet unavailable"); };
    const { u, store, posted } = harness({ device, checkFreshness });
    const r = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    assert.equal(r.ok, true);
    assert.equal(store.rows.size, 1);
    assert.equal(posted.length, 1);
  });
});

describe("unified approval: verify + apply", () => {
  it("applies exactly once on a valid owner signature", async () => {
    const device = makeDevice();
    const { u, store, applied } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "new-capability", summary: "s", item: { module: "k" } });
    sign(store, id, device);
    const out = await u.processSigned();
    assert.deepEqual(out, [{ id, ok: true, result: { ok: true, result: "loaded" } }]);
    assert.deepEqual(applied, [id]);
    assert.equal((await store.getApproval(id)).status, "applied");
    // idempotent: a second drain does nothing (row is now applied)
    assert.deepEqual(await u.processSigned(), []);
    assert.deepEqual(applied, [id]);
  });

  it("rejects a forged signature (different device) → failed, not applied", async () => {
    const device = makeDevice(), attacker = makeDevice();
    const { u, store, applied } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "new-capability", summary: "s", item: { m: 1 } });
    // attacker signs with their own key but claims the real device id
    const row = store.rows.get(id);
    const msg = canonicalMessage({ id, hash: row.item_hash, nonce: row.nonce, expiresAt: Number(row.expires_at_ms) });
    store.rows.set(id, { ...row, signature: attacker.sign(msg), signed_by: device.id, status: "signed" });
    const out = await u.processSigned();
    assert.equal(out[0].ok, false);
    assert.equal(out[0].reason, "bad signature");
    assert.equal(applied.length, 0);
    assert.equal((await store.getApproval(id)).status, "failed");
  });

  it("rejects an expired approval → expired, not applied", async () => {
    const device = makeDevice();
    let clock = 1_000_000;
    const { u, store, applied } = harness({ device, now: () => clock });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { diff: "x" } });
    sign(store, id, device);
    clock += 10_000 + 1;   // past ttl
    const out = await u.processSigned();
    assert.equal(out[0].reason, "expired");
    assert.equal(applied.length, 0);
  });

  it("rejects a swapped item (hash mismatch) → failed", async () => {
    const device = makeDevice();
    const { u, store, applied } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "new-capability", summary: "s", item: { module: "good" } });
    sign(store, id, device);
    // tamper the item AFTER signing
    store.rows.set(id, { ...store.rows.get(id), item_json: { module: "EVIL" } });
    const out = await u.processSigned();
    assert.equal(out[0].reason, "item changed since request");
    assert.equal(applied.length, 0);
  });
});

describe("unified approval: apply failure + retry", () => {
  it("a valid signature whose applyItem fails lands on apply_failed, not failed, and is NOT auto-retried", async () => {
    const device = makeDevice();
    const { u, store, applied } = harness({ device, applyResult: { ok: false, error: "no files" } });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: {} } });
    sign(store, id, device);
    const out = await u.processSigned();
    assert.equal(out[0].ok, false);
    assert.equal((await store.getApproval(id)).status, "apply_failed");
    assert.deepEqual(applied, [id]);
    // a second drain does NOT retry it on its own
    assert.deepEqual(await u.processSigned(), []);
    assert.deepEqual(applied, [id]);
  });

  it("requestRetry only accepts apply_failed rows", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device, applyResult: { ok: false, error: "boom" } });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    // still pending — not retryable yet
    assert.equal((await u.requestRetry(id)).ok, false);
    sign(store, id, device);
    await u.processSigned();   // → apply_failed
    const r = await u.requestRetry(id);
    assert.equal(r.ok, true);
    assert.equal((await store.getApproval(id)).status, "retry_requested");
    // already retry_requested — a second request is a no-op rejection, not a re-flag
    assert.equal((await u.requestRetry(id)).ok, false);
  });

  it("retry re-runs applyItem WITHOUT re-checking signature/expiry, and applies once the underlying issue is fixed", async () => {
    const device = makeDevice();
    let ok = false;
    let clock = 1_000_000;
    const store = fakeStore();
    const u = createUnifiedApproval({
      store,
      deviceKeys: { getKey: async (id) => (id === device.id ? { public_key_raw: device.publicKeyRawB64 } : null) },
      postSuggestion: async () => {},
      applyItem: async () => (ok ? { ok: true, files: ["fixed.txt"] } : { ok: false, error: "still broken" }),
      now: () => clock, ttlMs: 10_000,
    });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    sign(store, id, device);
    await u.processSigned();
    assert.equal((await store.getApproval(id)).status, "apply_failed");

    await u.requestRetry(id);
    assert.equal((await store.getApproval(id)).status, "retry_requested");

    // Push the clock well past the original 10s TTL AND "fix" the underlying
    // problem — a fresh signature verification would reject this as expired,
    // proving the retry path applies without re-checking expiry.
    clock += 10_000 + 1;
    ok = true;
    const out = await u.processSigned();
    assert.equal(out[0].ok, true);
    assert.equal(out[0].retried, true);
    assert.equal((await store.getApproval(id)).status, "applied");
  });
});

// ── skip / unskip ─────────────────────────────────────────────────────────────
// Skip marks an improvement card as "we won't be implementing it"; the user can
// reverse that decision by unskipping it.
//
// The invariant these tests pin down: skip is a decision ABOUT THE ITEM, kept
// orthogonal to the lifecycle. `status` survives untouched so unskip restores it
// exactly, and no skipped card is ever applied — including one that was signed
// on another device a second earlier.
describe("unified approval: skip / unskip", () => {
  it("skipping preserves status and blocks the apply, even with a valid signature", async () => {
    const device = makeDevice();
    const { u, store, applied } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    sign(store, id, device);
    // The race the DB filter alone can't close: signed on one device, skipped on
    // another before the poller's next tick.
    const res = await u.setSkipped(id, true);
    assert.equal(res.ok, true);
    assert.equal(res.status, "signed");

    const row = await store.getApproval(id);
    assert.equal(row.skipped, true);
    assert.ok(row.skipped_at, "skipped_at is stamped");
    assert.equal(row.status, "signed", "status is preserved, not overwritten with 'skipped'");

    const out = await u.processSigned();
    assert.equal(out[0].ok, false);
    assert.equal(out[0].reason, "skipped");
    assert.deepEqual(applied, [], "nothing was applied");
  });

  it("unskip restores the prior status verbatim — a failed apply comes back retryable", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device, applyResult: { ok: false, error: "boom" } });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    sign(store, id, device);
    await u.processSigned();                       // → apply_failed
    assert.equal((await store.getApproval(id)).status, "apply_failed");

    await u.setSkipped(id, true);
    assert.equal((await u.requestRetry(id)).ok, false, "a skipped card cannot be retried");

    await u.setSkipped(id, false);
    const row = await store.getApproval(id);
    assert.equal(row.skipped, false);
    assert.equal(row.skipped_at, null);
    assert.equal(row.status, "apply_failed", "comes back where it was, not as 'pending'");
    assert.equal((await u.requestRetry(id)).ok, true, "retryable again");
  });

  it("unskipping a pending card re-arms its TTL so it isn't dead on arrival", async () => {
    const device = makeDevice();
    let clock = 1_000_000;
    const store = fakeStore();
    const u = createUnifiedApproval({
      store,
      deviceKeys: { getKey: async (i) => (i === device.id ? { public_key_raw: device.publicKeyRawB64 } : null) },
      postSuggestion: async () => {}, applyItem: async () => ({ ok: true }),
      now: () => clock, ttlMs: 10_000,
    });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    await u.setSkipped(id, true);

    clock += 10_000 + 1;                           // TTL lapses while it sits skipped
    await u.setSkipped(id, false);
    const row = await store.getApproval(id);
    assert.equal(row.status, "pending");
    assert.ok(Number(row.expires_at_ms) > clock, "a fresh window to decide in");

    // And the re-armed window is the one the device signs against, so it applies.
    sign(store, id, device);
    const out = await u.processSigned();
    assert.equal(out[0].ok, true);
  });

  it("refuses to skip work that is already in flight or already on disk", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    sign(store, id, device);
    await store.updateApproval(id, { status: "approved" });
    assert.match((await u.setSkipped(id, true)).reason, /in flight/);

    await store.updateApproval(id, { status: "applied" });
    assert.match((await u.setSkipped(id, true)).reason, /already applied/);
  });

  it("is idempotent in both directions", async () => {
    const device = makeDevice();
    const { u } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    assert.equal((await u.setSkipped(id, false)).already, true);
    await u.setSkipped(id, true);
    assert.equal((await u.setSkipped(id, true)).already, true);
  });
});

// ── duplicate cards ─────────────────────────────────────────────────────────
// Cards were filed as byte-identical twins of cards the user had already
// signed, minutes later. item_hash was written on every row and never read
// before inserting.
describe("unified approval: duplicate content is dropped, nothing filed", () => {
  const ITEM = { files: { "tools/x.mjs": "export const x = 1;\n" } };

  it("filing the same card twice: the second is dropped — no row, no post, no freshness call", async () => {
    const device = makeDevice();
    let freshnessCalls = 0;
    const { u, store, posted } = harness({ device, checkFreshness: async () => { freshnessCalls++; return { verdict: "pass" }; } });
    const first = await u.requestApproval({ itemType: "code-fix", summary: "fix x", item: ITEM });
    assert.equal(first.ok, true);
    const second = await u.requestApproval({ itemType: "code-fix", summary: "fix x, reworded", item: ITEM });
    assert.equal(second.ok, false);
    assert.equal(second.dropped, true);
    assert.equal(second.duplicate_of, first.id);
    assert.equal(store.rows.size, 1);
    assert.equal(posted.length, 1);
    assert.equal(freshnessCalls, 1, "the duplicate check runs before the model call");
  });

  it("a twin of an APPLIED card is dropped", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    sign(store, id, device);
    await u.processSigned();
    assert.equal((await store.getApproval(id)).status, "applied");
    const again = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    assert.equal(again.dropped, true);
    assert.equal(again.duplicate_of, id);
  });

  it("a twin of a SKIPPED card is dropped (never re-propose a skip)", async () => {
    const device = makeDevice();
    const { u } = harness({ device });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    await u.setSkipped(id, true);
    const again = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    assert.equal(again.dropped, true);
    assert.equal(again.duplicate_of, id);
  });

  it("a twin of an EXPIRED unsigned card is filed — the old one can never be signed", async () => {
    const device = makeDevice();
    let clock = 1_000_000;
    const { u, store } = harness({ device, now: () => clock });
    await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    clock += 10_000 + 1;   // past ttl, still status "pending"
    const again = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    assert.equal(again.ok, true);
    assert.equal(store.rows.size, 2);
  });

  it("different content is never treated as a duplicate", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device });
    await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    const other = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { "tools/x.mjs": "export const x = 2;\n" } } });
    assert.equal(other.ok, true);
    assert.equal(store.rows.size, 2);
  });

  it("fails open: a throwing lookup still files the card", async () => {
    const device = makeDevice();
    const { u, store } = harness({ device });
    store.findByItemHash = async () => { throw new Error("supabase down"); };
    const r = await u.requestApproval({ itemType: "code-fix", summary: "s", item: ITEM });
    assert.equal(r.ok, true);
  });

  it("blocksDuplicate: which statuses block", () => {
    const now = 1_000_000;
    assert.equal(blocksDuplicate({ status: "applied" }, now), true);
    assert.equal(blocksDuplicate({ status: "signed" }, now), true);
    assert.equal(blocksDuplicate({ status: "retry_requested" }, now), true);
    assert.equal(blocksDuplicate({ status: "pending", risk: "high", expires_at_ms: now + 1 }, now), true);
    assert.equal(blocksDuplicate({ status: "pending", risk: "high", expires_at_ms: now - 1 }, now), false);
    assert.equal(blocksDuplicate({ status: "pending", skipped: true, expires_at_ms: now - 1 }, now), true);
    for (const s of ["expired", "failed", "apply_failed", "denied"]) assert.equal(blocksDuplicate({ status: s }, now), false, s);
  });
});

// ── expiring unsigned cards ─────────────────────────────────────────────────
// Only decideRow ever wrote `expired`, and it only sees SIGNED rows, so an
// unsigned card read `pending` forever and jammed improvement-plan's card cap.
describe("unified approval: sweepExpired closes out unsigned cards past their TTL", () => {
  it("expires an unsigned, unskipped card past its window and leaves a live one alone", async () => {
    const device = makeDevice();
    let clock = 1_000_000;
    const { u, store } = harness({ device, now: () => clock });
    const old = await u.requestApproval({ itemType: "code-fix", summary: "old", item: { files: { a: "1" } } });
    clock += 10_000 + 1;
    const fresh = await u.requestApproval({ itemType: "code-fix", summary: "fresh", item: { files: { a: "2" } } });
    const swept = await u.sweepExpired();
    assert.deepEqual(swept, [old.id]);
    assert.equal((await store.getApproval(old.id)).status, "expired");
    assert.equal((await store.getApproval(fresh.id)).status, "pending");
  });

  it("is idempotent, and leaves skipped and signed rows to their own paths", async () => {
    const device = makeDevice();
    let clock = 1_000_000;
    const { u, store } = harness({ device, now: () => clock });
    const skipped = await u.requestApproval({ itemType: "code-fix", summary: "a", item: { files: { a: "1" } } });
    await u.setSkipped(skipped.id, true);
    const signed = await u.requestApproval({ itemType: "code-fix", summary: "b", item: { files: { a: "2" } } });
    sign(store, signed.id, device);
    const plain = await u.requestApproval({ itemType: "code-fix", summary: "c", item: { files: { a: "3" } } });
    clock += 10_000 + 1;
    assert.deepEqual(await u.sweepExpired(), [plain.id]);
    assert.deepEqual(await u.sweepExpired(), []);
    assert.equal((await store.getApproval(skipped.id)).status, "pending", "skipped stays pending so unskip can re-arm it");
    assert.equal((await store.getApproval(signed.id)).status, "signed", "signed belongs to decideRow");
  });

  it("is a no-op for a store without listUnsignedPending", async () => {
    const u = createUnifiedApproval({ store: { insertApproval() {}, updateApproval() {} }, deviceKeys: {} });
    assert.deepEqual(await u.sweepExpired(), []);
  });
});

// ── truth check again at signing ───────────────────────────────────────────
// The filing-time check cannot see a correction the user makes between
// filing and signing.
describe("unified approval: truth check re-runs at signing", () => {
  // Filing passes (a card is always filed live); signing returns `atSigning`.
  const gate = (atSigning, seen = []) => async (input, opts) => {
    seen.push({ input, opts });
    return input.evidence_as_of === "live" ? { verdict: "pass" } : atSigning;
  };

  it("a drop at signing writes nothing and leaves a retryable apply_failed with result.stale", async () => {
    const device = makeDevice();
    const seen = [];
    const { u, store, applied } = harness({ device, checkFreshness: gate({ verdict: "drop", reasons: ["overturned since filing"] }, seen) });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", rationale: "r", item: { files: { a: "1" } } });
    sign(store, id, device);
    const out = await u.processSigned();
    assert.equal(out[0].ok, false);
    assert.equal(out[0].result.stale, true);
    assert.equal(out[0].result.error, "overturned since filing");
    assert.deepEqual(applied, [], "nothing applied");
    const row = await store.getApproval(id);
    assert.equal(row.status, "apply_failed");
    // Dated by the card's own filing time, never "live", on the core's clock.
    const signing = seen.find((s) => s.input.evidence_as_of !== "live");
    assert.equal(signing.input.evidence_as_of, row.created_at);
    assert.equal(signing.opts.nowMs, 1_000_000);
    assert.equal(signing.input.solicited, false);
  });

  it("Retry is the user's override: it applies without asking the truth check again", async () => {
    const device = makeDevice();
    const seen = [];
    const { u, store, applied } = harness({ device, checkFreshness: gate({ verdict: "drop", reasons: ["stale"] }, seen) });
    const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
    sign(store, id, device);
    await u.processSigned();
    const calls = seen.length;
    assert.equal((await u.requestRetry(id)).ok, true);
    const out = await u.processSigned();
    assert.equal(out[0].ok, true);
    assert.deepEqual(applied, [id]);
    assert.equal(seen.length, calls, "no second truth check on the retry");
  });

  it("pass, rewrite and a throwing gate all proceed to apply", async () => {
    for (const checkFreshness of [gate({ verdict: "pass" }), gate({ verdict: "rewrite", corrected_text: "x" }), async (i) => { if (i.evidence_as_of !== "live") throw new Error("down"); return { verdict: "pass" }; }]) {
      const device = makeDevice();
      const { u, store, applied } = harness({ device, checkFreshness });
      const { id } = await u.requestApproval({ itemType: "code-fix", summary: "s", item: { files: { a: "1" } } });
      sign(store, id, device);
      const out = await u.processSigned();
      assert.equal(out[0].ok, true);
      assert.deepEqual(applied, [id]);
    }
  });
});
