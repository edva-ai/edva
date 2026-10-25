// app-approval.test.mjs — verify the Face-ID/Enclave signature model
// (device-key model) with generated P-256 keys standing in for the Secure Enclave.
//
// Run: node --test agent/test/app-approval.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { rawP256ToKey, canonicalMessage, verifySignature, itemHash, buildApprovalRequest, checkApproval } from "../core/app-approval.mjs";

// Make a device: a P-256 keypair + its raw uncompressed public point (what the
// app registers), + a sign() that mimics the Enclave (DER ECDSA over SHA-256).
function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const pad = (b64) => { const b = Buffer.from(b64, "base64url"); return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]); };
  const raw = Buffer.concat([Buffer.from([0x04]), pad(jwk.x), pad(jwk.y)]);
  return {
    publicKeyRawB64: raw.toString("base64"),
    sign: (message) => crypto.sign("sha256", Buffer.from(message, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64"),
  };
}

describe("app-approval crypto (device-key model)", () => {
  it("rawP256ToKey accepts a 65-byte uncompressed point, rejects junk", () => {
    const d = makeDevice();
    assert.ok(rawP256ToKey(d.publicKeyRawB64));
    assert.throws(() => rawP256ToKey(Buffer.from([0x02, 1, 2]).toString("base64")), /uncompressed P-256/);
  });

  it("verifies a genuine Enclave-style signature over the canonical message", () => {
    const d = makeDevice();
    const req = buildApprovalRequest("appr-1", { module: "kelvin" }, { now: 1000, nonce: "abc", ttlMs: 10_000 });
    const sig = d.sign(req.message);
    assert.equal(verifySignature({ message: req.message, signatureB64: sig, publicKeyRawB64: d.publicKeyRawB64 }), true);
  });

  it("checkApproval: valid → ok; tampered item / expired / wrong key → rejected", () => {
    const d = makeDevice();
    const item = { type: "new-capability", module: "kelvin-convert" };
    const req = buildApprovalRequest("appr-2", item, { now: 1000, nonce: "n1", ttlMs: 10_000 });
    const sig = d.sign(req.message);

    // happy path
    assert.deepEqual(checkApproval({ request: req, item, signatureB64: sig, publicKeyRawB64: d.publicKeyRawB64, now: 2000 }), { ok: true });

    // the item was swapped after signing → hash mismatch
    const swapped = checkApproval({ request: req, item: { type: "new-capability", module: "EVIL" }, signatureB64: sig, publicKeyRawB64: d.publicKeyRawB64, now: 2000 });
    assert.equal(swapped.ok, false); assert.equal(swapped.reason, "item changed since request");

    // expired
    const exp = checkApproval({ request: req, item, signatureB64: sig, publicKeyRawB64: d.publicKeyRawB64, now: 1000 + 10_000 + 1 });
    assert.equal(exp.ok, false); assert.equal(exp.reason, "expired");

    // signed by a DIFFERENT device
    const attacker = makeDevice();
    const forged = d.sign(req.message); // real sig but verified against attacker's key
    const wrong = checkApproval({ request: req, item, signatureB64: forged, publicKeyRawB64: attacker.publicKeyRawB64, now: 2000 });
    assert.equal(wrong.ok, false); assert.equal(wrong.reason, "bad signature");
  });

  it("a tampered signature does not verify", () => {
    const d = makeDevice();
    const req = buildApprovalRequest("appr-3", { x: 1 }, { now: 1000, nonce: "n" });
    const sig = Buffer.from(d.sign(req.message), "base64");
    sig[sig.length - 1] ^= 0xff; // flip a byte
    assert.equal(verifySignature({ message: req.message, signatureB64: sig.toString("base64"), publicKeyRawB64: d.publicKeyRawB64 }), false);
  });

  it("itemHash is stable + binds the item to the signed message", () => {
    assert.equal(itemHash({ a: 1 }), itemHash({ a: 1 }));
    assert.notEqual(itemHash({ a: 1 }), itemHash({ a: 2 }));
    const req = buildApprovalRequest("id", { a: 1 }, { now: 1, nonce: "n" });
    assert.match(req.message, /^edva-approve\.v1\nid\n/);
    assert.equal(req.hash, itemHash({ a: 1 }));
  });
});
