// app-approval.mjs — verify Face-ID / Secure-Enclave-signed owner approvals,
// reusing the exact security model as the client's TradeApproval (client/Edva/
// TradeApproval.swift). The paired device holds a P-256 key in the Secure
// Enclave; signing is gated by Face ID; the app signs a canonical message and we
// verify the DER-ECDSA signature here against the device's REGISTERED raw public
// key. Only the paired device + owner's face can produce a valid signature — so
// no CLI, no email parsing, and (critically) no LLM ever authorizes anything.
//
// This is the trusted verifier for the unified self-improvement approval flow:
// a high-risk change / new capability creates a request; the app signs it; this
// module verifies before anything is applied. Pure crypto + request lifecycle —
// no I/O, no model — so it is unit-tested with generated keys.

import crypto from "node:crypto";

// P-256 (secp256r1 / prime256v1) SPKI DER prefix for an uncompressed point.
const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
  "hex",
);

// Convert a raw X9.62 uncompressed P-256 public point (65 bytes: 0x04|X|Y,
// base64 — exactly what TradeApproval.rawPublicKeyBase64 emits) into a node
// public KeyObject.
export function rawP256ToKey(rawB64) {
  const raw = Buffer.from(String(rawB64 || ""), "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("app-approval: expected a 65-byte uncompressed P-256 point (0x04|X|Y)");
  }
  const spki = Buffer.concat([P256_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

// The exact bytes the device signs. MUST match TradeApproval's message() shape
// (the trade-approval domain → edva-approve.v1 for self-improvement). Order + newlines
// are load-bearing (they're part of the signed payload).
//
// `domain` separates approval kinds: purchases sign `edva-purchase.v1`
// (lib/purchase-approval.mjs), so a self-improvement signature can never
// be replayed as a purchase authorization or vice versa. Absent → the original
// self-improvement domain, so existing rows verify unchanged.
export function canonicalMessage({ id, hash, nonce, expiresAt, domain }) {
  return `${domain || "edva-approve.v1"}\n${id}\n${hash}\n${nonce}\n${expiresAt}`;
}

// Verify a DER ECDSA (SHA-256) signature over the canonical message. Returns a
// boolean; never throws (a malformed key/sig is just "not verified").
export function verifySignature({ message, signatureB64, publicKeyRawB64 }) {
  try {
    if (!message || !signatureB64 || !publicKeyRawB64) return false;
    const key = rawP256ToKey(publicKeyRawB64);
    const sig = Buffer.from(String(signatureB64), "base64");
    return crypto.verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "der" }, sig);
  } catch {
    return false;
  }
}

// Deterministic JSON serialization: object keys sorted recursively. Plain
// JSON.stringify preserves insertion order, but item_json round-trips through
// a Postgres jsonb column between request-time (buildApprovalRequest) and
// verify-time (checkApproval) — jsonb does NOT preserve object key order, so
// a multi-file code-fix payload can come back with its keys shuffled even
// though the content is byte-identical. Sorting keys on both sides makes the
// hash immune to that reordering (otherwise a same-content, two-file proposal
// is falsely rejected as "item changed since request").
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Stable content hash of the item being approved (bound into the signed message
// so a signature can't be replayed against a different item).
export function itemHash(item) {
  const s = typeof item === "string" ? item : canonicalStringify(item ?? null);
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Build an approval REQUEST for a high-risk item. `nonce` defensible against
// replay; `ttlMs` bounds the window. now/nonce injectable for tests.
export function buildApprovalRequest(id, item, { ttlMs = 24 * 3600 * 1000, now = Date.now(), nonce = null } = {}) {
  const hash = itemHash(item);
  const n = nonce || crypto.randomBytes(16).toString("hex");
  const expiresAt = now + ttlMs;
  return { id, hash, nonce: n, expiresAt, message: canonicalMessage({ id, hash, nonce: n, expiresAt }) };
}

// Full check for an incoming signed approval: signature valid AND not expired
// AND the item still hashes to what was signed. Returns { ok, reason }.
export function checkApproval({ request, item, signatureB64, publicKeyRawB64, now = Date.now() }) {
  if (!request) return { ok: false, reason: "no request" };
  if (request.expiresAt != null && now > request.expiresAt) return { ok: false, reason: "expired" };
  if (itemHash(item) !== request.hash) return { ok: false, reason: "item changed since request" };
  const message = canonicalMessage(request);
  if (!verifySignature({ message, signatureB64, publicKeyRawB64 })) return { ok: false, reason: "bad signature" };
  return { ok: true };
}
