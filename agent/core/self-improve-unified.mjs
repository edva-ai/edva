// self-improve-unified.mjs — WP11 + nightly-executor UNIFIED high-risk approval.
//
// One flow for every improvement that needs the user's authorization: a high-risk
// item (a new capability, or a nightly code-fix the rubric flagged HIGH) creates
// ONE approval request, is surfaced in the app's "Improvements" channel, and is
// applied ONLY after the user's Face-ID/Enclave signature verifies (core/app-approval).
// Low/moderate items keep auto-applying elsewhere — they never come here.
//
// Transport is Supabase (app<->host) but the SECURITY is the signature: the host
// verifies deterministically against the registered device key before applying.
// No LLM authorizes anything. Pure orchestration over injected deps → unit-tested
// with fakes; the real Supabase/git/load mechanics are injected by the poller.

import crypto from "node:crypto";
import { buildApprovalRequest, checkApproval, itemHash } from "./app-approval.mjs";
import { isApprovalRowPending } from "../../lib/apns-push.mjs";

// The expiry a row actually carries, in epoch-ms. Prefer the verbatim
// `expires_at_ms` (exactly what the device signs); fall back to the timestamp
// for any row written before that column existed. null = no expiry recorded.
export function approvalExpiresAtMs(row) {
  if (row?.expires_at_ms != null) return Number(row.expires_at_ms);
  return row?.expires_at ? new Date(row.expires_at).getTime() : null;
}

// Does an existing row with the same item_hash make a new card for that item a
// duplicate? Without this check the queue can hold byte-identical twins of
// cards the user has ALREADY signed, filed minutes later.
//
//   - applied, or mid-apply (signed / approved / retry_requested): the change
//     happened or is happening. A twin would re-apply it on top of itself.
//   - pending and skipped: the user decided against it. Re-filing it is exactly the
//     re-proposal improvement-plan's Critical Rule 2 forbids.
//   - pending and live: the SAME test the badge uses (isApprovalRowPending),
//     so "is there already a card waiting for this?" cannot disagree with
//     what the user's phone shows. An expired, unsigned pending row does NOT block —
//     it can never be signed, so the only way to get the decision made is a
//     fresh card.
//   - failed / apply_failed / expired / denied: do not block. apply_failed
//     belongs to Retry, and the other three are dead cards.
const DUP_BLOCKING_STATUSES = ["applied", "signed", "approved", "retry_requested"];
export function blocksDuplicate(row, nowMs = Date.now()) {
  if (!row) return false;
  if (DUP_BLOCKING_STATUSES.includes(row.status)) return true;
  if (row.status !== "pending") return false;
  if (row.skipped) return true;
  return isApprovalRowPending(row, nowMs);
}

export function createUnifiedApproval({
  store,               // { insertApproval(row), updateApproval(id,patch), listSignedPending(), getApproval(id),
                       //   findByItemHash?(hash) => rows, listUnsignedPending?() => rows }
  deviceKeys,          // { getKey(deviceId) => { public_key_raw } | null }
  postSuggestion,      // async (summary, rationale, itemType, id) => post to the Improvements channel
  applyItem,           // async (row) => { ok, result } — load capability / apply diff (injected)
  checkFreshness = null, // async (input) => {verdict,...} — lib/claim-freshness.mjs; defaults to the real module, injectable for tests
  ttlMs = 24 * 3600 * 1000,
  now = () => Date.now(),
  genId = () => crypto.randomUUID(),
} = {}) {
  if (!store || !deviceKeys) throw new Error("unified-approval: store + deviceKeys are required");

  // Staleness recheck, right before the card is shown. A card can be filed on
  // an argument that something the user says before signing overturns, and
  // nothing re-reads the world between filing and the signature. This is Rule #2 (every
  // message into the chat must be relevant AND true) applied to the one
  // release point a Face-ID card has: the text shown when it's posted.
  //
  // A self-improvement card is proactive — nobody asked for THIS one — so
  // `solicited: false`, same posture as a hum ping: a stale claim that memory
  // can't confirm gets dropped rather than hedged.
  //
  // It is NOT undated. "No caller here has a reliable 'when did I observe
  // this' stamp" is wrong for the kind of item that dominates this path: a
  // code-fix card carries its files INLINE, as content the caller wrote and
  // verified in the very turn that is submitting them. That is live by
  // construction, and Rule #2 asks for exactly this declaration in as many
  // words — "Composed the message from work you just did? Pass
  // evidence_as_of: live. It exits at stage 0 for free, and it is the honest
  // declaration."
  //
  // Why it matters: undated means stale, stale means the full
  // re-read-the-source-of-record pass, and that pass is specified for a
  // stateful claim SOMEONE ELSE controls ("has X enrolled / paid / replied").
  // A code change has no such claim and no source of record, so the test
  // degenerates into topic-matching against Edva's own recent output — and
  // since the reviews that generate these cards also email the user nightly
  // about what they found, the better they report, the harder their own
  // follow-up work becomes to land (a sound fix refused again and again, each
  // time citing a Edva message that had settled a DIFFERENT claim).
  //
  // This narrows nothing the gate was built for. A card surfacing something
  // STORED must still not claim live (claim-freshness's own rule), and
  // `rewrite` plus `drop`-on-a-genuinely-old-stamp are untouched.
  async function recheckFreshness(summary, rationale, itemType) {
    try {
      const check = checkFreshness || (await import("../../lib/claim-freshness.mjs")).checkFreshness;
      const combined = `${summary}${rationale ? `\n\n${rationale}` : ""}`;
      return await check({ text: combined, subject: itemType, solicited: false, evidence_as_of: "live" });
    } catch {
      return null; // fail-open — same posture as every other claim-freshness call site
    }
  }

  // The same gate at the moment of signing (see decideRow). Dated by the row's
  // own created_at: undated would mean "stale" and is only the fallback for a
  // row that somehow lacks one. Fail-open, like the filing check.
  async function recheckAtSigning(row) {
    try {
      const check = checkFreshness || (await import("../../lib/claim-freshness.mjs")).checkFreshness;
      const combined = `${row.summary || ""}${row.rationale ? `\n\n${row.rationale}` : ""}`;
      const input = { text: combined, subject: row.item_type, solicited: false };
      if (row.created_at) input.evidence_as_of = row.created_at;
      // The same clock that stamped created_at, so the age is measured consistently.
      return await check(input, { nowMs: now() });
    } catch {
      return null;
    }
  }

  async function findDuplicate(item) {
    if (typeof store.findByItemHash !== "function") return null;
    try {
      const rows = (await store.findByItemHash(itemHash(item))) || [];
      const t = now();
      return rows.find((r) => blocksDuplicate(r, t)) || null;
    } catch {
      return null;
    }
  }

  // Create a high-risk approval request: persist it + surface it in the channel.
  // NOTHING is applied — it waits for a verified owner signature.
  async function requestApproval({ id = null, itemType, summary, rationale = "", item } = {}) {
    if (!itemType || !summary || item == null) throw new Error("requestApproval: itemType, summary, item required");

    // Duplicate check FIRST — it is one indexed lookup, and it saves the
    // freshness model call for a card that would be refused anyway. Reuses the
    // freshness gate's "dropped, nothing filed" shape: no row, no post. Fails
    // open: a lookup error must never stop a genuine card from being filed.
    const dup = await findDuplicate(item);
    if (dup) {
      return { ok: false, dropped: true, duplicate_of: dup.id, reason: `duplicate of card ${dup.id} (${dup.skipped ? "skipped" : dup.status})` };
    }

    let finalRationale = rationale;
    const fresh = await recheckFreshness(summary, rationale, itemType);
    if (fresh?.verdict === "drop") {
      // The finding this card would ask the user to sign off on looks resolved
      // or contradicted since it was written. Per Rule #2, a proactive ask
      // nobody asked for does not get hedged into existence — it simply isn't
      // shown. No row, no channel post, nothing for the user to react to.
      return { ok: false, dropped: true, reason: fresh.reasons?.[0] || "stale_evidence", staleness: fresh };
    }
    let rewritten = false;
    if (fresh?.verdict === "rewrite" && fresh.corrected_text) {
      // Mirrors self-improve-request's own "heads up" append pattern below —
      // add the re-checked framing rather than silently overwriting the
      // original, so the card's history stays visible on `self-improve-show`.
      finalRationale = `${rationale}${rationale ? "\n\n" : ""}⚠️ Freshness check: this card's evidence looked stale, so here's what's actually current — ${fresh.corrected_text}`;
      rewritten = true;
    }

    const rid = id || genId();
    const req = buildApprovalRequest(rid, item, { ttlMs, now: now() });
    await store.insertApproval({
      id: rid, item_type: itemType, summary, rationale: finalRationale,
      item_json: item, item_hash: req.hash, nonce: req.nonce,
      risk: "high", status: "pending",
      created_at: new Date(now()).toISOString(),
      expires_at: new Date(req.expiresAt).toISOString(),
      // The EXACT epoch-ms bound into the signed message. Stored verbatim so the
      // Swift signer and this verifier agree to the millisecond — reconstructing
      // it from the `expires_at` timestamp risks sub-ms round-trip drift that
      // would silently break every signature.
      expires_at_ms: req.expiresAt,
    });
    try { await postSuggestion?.(summary, finalRationale, itemType, rid); } catch {}
    return { ok: true, id: rid, hash: req.hash, nonce: req.nonce, expiresAt: req.expiresAt, staleness_rewritten: rewritten };
  }

  // Drain signed-but-not-applied approvals: verify each signature, apply on
  // success. Deterministic; safe to run on a tick. Returns per-item outcomes.
  async function processSigned() {
    const rows = (await store.listSignedPending?.()) || [];
    const out = [];
    for (const row of rows) {
      const res = await decideRow(row);
      out.push({ id: row.id, ...res });
    }
    return out;
  }

  async function decideRow(row) {
    // Skipped means the user decided NOT to implement this. It is checked before
    // everything else — including the retry fast-path — because skip is a
    // decision about the item, not about any one attempt at it. The poller's
    // query already filters these out; this guard closes the race where the user
    // signs on one device and skips on another before the next tick.
    if (row.skipped) return { ok: false, reason: "skipped" };
    // A retry re-runs the apply step ONLY, skipping expiry + signature checks.
    // Those checks gate AUTHORIZATION (did the user say yes) — and that already
    // happened: the row can only reach `retry_requested` from `apply_failed`,
    // which itself is only reached after a signature verified successfully
    // (see below). A mechanical apply failure (a git-hook conflict, a stale
    // ext/ dir, a transient error) isn't a fresh authorization decision, and
    // re-demanding a signature — or worse, silently failing on a now-expired
    // TTL for an item the user already approved — would make retry pointless.
    if (row.status === "retry_requested") {
      const applied = await applyAndRecord(row);
      return { ...applied, retried: true };
    }
    // Expiry first (don't apply a stale approval). Prefer the verbatim epoch-ms
    // (exactly what the device signed); fall back to the timestamp for any row
    // written before the expires_at_ms column existed.
    const expMs = approvalExpiresAtMs(row);
    if (expMs != null && now() > expMs) {
      await store.updateApproval(row.id, { status: "expired", decided_at: iso() });
      return { ok: false, reason: "expired" };
    }
    const key = row.signed_by ? await deviceKeys.getKey(row.signed_by) : null;
    if (!key?.public_key_raw) {
      await store.updateApproval(row.id, { status: "failed", result: { error: "unknown device" } });
      return { ok: false, reason: "unknown device" };
    }
    const request = { id: row.id, hash: row.item_hash, nonce: row.nonce, expiresAt: expMs };
    const chk = checkApproval({ request, item: row.item_json, signatureB64: row.signature, publicKeyRawB64: key.public_key_raw, now: now() });
    if (!chk.ok) {
      await store.updateApproval(row.id, { status: "failed", result: { error: chk.reason } });
      return { ok: false, reason: chk.reason };
    }
    // Signature valid → is what the user signed still TRUE? (a user decision)
    // recheckFreshness above runs when the card is FILED, which is not enough:
    // hours can pass before the signature, and something said in between can
    // overturn the card's whole argument. So the
    // truth check runs again here, with the card's real vintage — the evidence
    // was observed when it was filed, so `evidence_as_of` is created_at, never
    // "live". A card signed within claim-freshness's 90-minute window passes for
    // free; an older one gets the full re-read.
    //
    // A drop refuses before anything is written. It lands as `apply_failed`
    // with result.stale, so the poller tells the user why, and the user's Retry is
    // the override (the retry fast-path above re-applies without asking the check
    // again) — the gate has refused sound code changes before, and
    // an approval the user still wants must never be a dead end. A `rewrite` verdict
    // only re-frames text, and a signed card's text is frozen, so it proceeds.
    const truth = await recheckAtSigning(row);
    if (truth?.verdict === "drop") {
      const result = { ok: false, stale: true, error: truth.reasons?.[0] || "the finding behind it looks resolved since it was filed", staleness: truth };
      await store.updateApproval(row.id, { status: "apply_failed", decided_at: iso(), result });
      return { ok: false, result };
    }
    await store.updateApproval(row.id, { status: "approved", decided_at: iso() });
    return applyAndRecord(row);
  }

  // Runs applyItem and records the outcome. `apply_failed` (not `failed`) marks
  // a mechanical apply failure on an ALREADY-VERIFIED item — distinct from
  // `failed`, which means the signature/authorization check itself didn't pass
  // and retrying without a fresh Face-ID signature would defeat the gate.
  async function applyAndRecord(row) {
    let applied;
    try { applied = await applyItem(row); }
    catch (e) { applied = { ok: false, error: e?.message || String(e) }; }
    await store.updateApproval(row.id, { status: applied?.ok ? "applied" : "apply_failed", applied_at: iso(), result: applied });
    return { ok: !!applied?.ok, result: applied };
  }

  // Flag a mechanically-failed apply for retry. Only valid from `apply_failed`
  // — anything else either never got a verified signature (`failed`) or is
  // already mid-flight/done, and re-running those would bypass the
  // authorization gate or double-apply a change.
  async function requestRetry(id) {
    const row = await store.getApproval(id);
    if (!row) return { ok: false, reason: "not found" };
    if (row.skipped) return { ok: false, reason: "skipped — unskip it first" };
    if (row.status !== "apply_failed") return { ok: false, reason: `not retryable (status=${row.status})` };
    await store.updateApproval(id, { status: "retry_requested" });
    return { ok: true };
  }

  // Skip / unskip a card. Skip records "we are not implementing
  // this" WITHOUT destroying the lifecycle: `status` is left exactly as it was,
  // so unskip restores the prior state with nothing to remember. That is why
  // skip is its own boolean rather than another `status` value — a card skipped
  // out of `apply_failed` has to come back as `apply_failed` (retryable), not as
  // `pending` (which would offer a Face-ID approval for work already authorized).
  //
  // Refused mid-flight and after the fact. `approved`/`retry_requested` mean the
  // poller has already claimed the row and is writing files RIGHT NOW, and
  // `applied` is on disk and committed — "we won't be implementing it" is not a
  // statement either one can honour. (Undoing an applied change is a revert: a
  // different operation with a different risk profile.)
  //
  // `signed` IS skippable on purpose: the signature is written the instant
  // the user's Face ID clears, but the poller only ticks every 2 minutes, so that
  // window is a real "wrong card / changed my mind" escape hatch. decideRow's
  // skipped guard is what makes it safe — a row skipped inside the window is
  // dropped when the tick arrives instead of being applied.
  const IN_FLIGHT = ["approved", "retry_requested"];
  async function setSkipped(id, skipped) {
    const row = await store.getApproval?.(id);
    if (!row) return { ok: false, reason: "not found" };
    if (!!row.skipped === !!skipped) return { ok: true, already: true, status: row.status };

    if (skipped) {
      if (IN_FLIGHT.includes(row.status)) return { ok: false, reason: `in flight (status=${row.status}) — it is being applied now` };
      if (row.status === "applied") return { ok: false, reason: "already applied — skipping cannot un-apply it; revert the commit instead" };
      await store.updateApproval(id, { skipped: true, skipped_at: iso() });
      return { ok: true, status: row.status };
    }

    const patch = { skipped: false, skipped_at: null };
    // Re-arm the approval window. A pending card's TTL keeps running while it
    // sits skipped, and an expired one is doubly dead: the app hides it, and
    // decideRow refuses to apply it. Unskip is the user reopening the decision, so
    // give a fresh window to decide in. Safe to rewrite here precisely
    // because a pending row carries no signature yet — the signed bytes bind
    // whatever expiry the row holds at signing time, so there is nothing to
    // invalidate. (An in-flight/applied row can't be skipped, hence can't be
    // unskipped, hence can never reach this branch with a signature on it.)
    if (row.status === "pending") {
      const exp = now() + ttlMs;
      patch.expires_at = new Date(exp).toISOString();
      patch.expires_at_ms = exp;
    }
    await store.updateApproval(id, patch);
    return { ok: true, status: row.status };
  }

  // Close out cards nobody signed in time. decideRow only sees SIGNED rows, so
  // without this an unsigned card stays `status: "pending"` forever after its
  // 24h TTL, reads as "waiting on the user", and improvement-plan's
  // 5-unsigned-card cap counts it and files nothing at all.
  //
  // Only unsigned, NOT-skipped, pending rows are touched:
  //   - a signed row belongs to decideRow, which already expires it with the
  //     signature in hand;
  //   - a skipped row is already a decision, and it must stay `pending` so
  //     unskip can re-arm its TTL (setSkipped above; the app keeps skipped
  //     pending rows visible for exactly that reason).
  // Idempotent: an `expired` row is not listed again.
  async function sweepExpired() {
    const rows = (await store.listUnsignedPending?.()) || [];
    const t = now();
    const swept = [];
    for (const row of rows) {
      if (row.signature || row.skipped || row.status !== "pending") continue;
      const exp = approvalExpiresAtMs(row);
      if (exp == null || t <= exp) continue;
      await store.updateApproval(row.id, { status: "expired", decided_at: iso() });
      swept.push(row.id);
    }
    return swept;
  }

  function iso() { return new Date(now()).toISOString(); }

  return { requestApproval, processSigned, requestRetry, setSkipped, sweepExpired, _decideRow: decideRow };
}
