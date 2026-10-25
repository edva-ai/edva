// oidc-verify.test.mjs — offline unit tests for the dependency-free Google OIDC
// verifier that guards the publicly reachable :9090 Gmail Pub/Sub push path
// (agent/supervisor/oidc-verify.mjs).
//
// These tests generate their own RSA keypair, mint JWTs locally, and inject the
// public key as the JWKS via the _setJwksForTest seam — so the whole suite runs
// offline with no network and no npm deps (mirrors the module itself). We prove
// the happy path AND that every tampering / forgery vector is rejected, since
// this is the only thing standing between the open internet and Gmail history
// fetches / dispatch loops.
//
// Run: node --test tests/oidc-verify.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../agent/supervisor/oidc-verify.mjs",
);
const { verifyGoogleIdToken, _setJwksForTest } = await import(MODULE_PATH);

// --- test keypair + JWT minting helpers ---------------------------------

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const KID = "test-key-1";

// Export the public key as JWK and attach the kid the tokens will reference.
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const AUDIENCE = "https://push.example.com";
const SA_EMAIL = "edva-pubsub@example-project.iam.gserviceaccount.com";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// mintToken({ claims overrides, header overrides, signWith key, tamper }) → jwt string
function mintToken({ claims = {}, header = {}, signKey = privateKey, tamperSig = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fullHeader = { alg: "RS256", kid: KID, typ: "JWT", ...header };
  const fullClaims = {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: SA_EMAIL,
    email_verified: true,
    iat: now,
    exp: now + 600,
    ...claims,
  };
  const headerB64 = b64url(JSON.stringify(fullHeader));
  const payloadB64 = b64url(JSON.stringify(fullClaims));
  const signingInput = `${headerB64}.${payloadB64}`;
  let sig;
  if (fullHeader.alg === "none") {
    sig = "";
  } else {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    sig = b64url(signer.sign(signKey));
  }
  if (tamperSig) sig = b64url(Buffer.from("not-the-real-signature"));
  return `${headerB64}.${payloadB64}.${sig}`;
}

// Install the test JWKS before each assertion group.
function installJwks() {
  _setJwksForTest([publicJwk]);
}

const OPTS = { audience: AUDIENCE, email: SA_EMAIL };

// --- happy path ----------------------------------------------------------

test("accepts a correctly-signed token with matching aud + email", async () => {
  installJwks();
  const token = mintToken();
  const claims = await verifyGoogleIdToken(token, OPTS);
  assert.equal(claims.email, SA_EMAIL);
  assert.equal(claims.aud, AUDIENCE);
});

test("accepts the bare-issuer variant (accounts.google.com)", async () => {
  installJwks();
  const token = mintToken({ claims: { iss: "accounts.google.com" } });
  const claims = await verifyGoogleIdToken(token, OPTS);
  assert.equal(claims.iss, "accounts.google.com");
});

// --- signature / structural forgeries -----------------------------------

test("rejects a token signed by an attacker's key", async () => {
  installJwks();
  const { privateKey: evilKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = mintToken({ signKey: evilKey });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /signature/);
});

test("rejects a token with a tampered signature", async () => {
  installJwks();
  const token = mintToken({ tamperSig: true });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /signature/);
});

test("rejects a tampered payload (claims changed after signing)", async () => {
  installJwks();
  const good = mintToken();
  const [h, , s] = good.split(".");
  // Swap in a forged payload (attacker email) but keep the original signature.
  const forgedPayload = b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: AUDIENCE,
    email: "attacker@evil.com", email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
  }));
  const forged = `${h}.${forgedPayload}.${s}`;
  await assert.rejects(() => verifyGoogleIdToken(forged, OPTS), /signature/);
});

test("rejects alg:none (signature stripped)", async () => {
  installJwks();
  const token = mintToken({ header: { alg: "none" } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /alg/);
});

test("rejects an unknown kid (key not in JWKS)", async () => {
  installJwks();
  const token = mintToken({ header: { kid: "some-other-kid" } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /unknown signing key/);
});

test("rejects malformed (non-3-part) tokens", async () => {
  installJwks();
  await assert.rejects(() => verifyGoogleIdToken("not.a.valid.jwt.token", OPTS), /malformed/);
  await assert.rejects(() => verifyGoogleIdToken("onlyonepart", OPTS), /malformed/);
  await assert.rejects(() => verifyGoogleIdToken("", OPTS), /missing token/);
});

// --- claims checks -------------------------------------------------------

test("rejects a token for the wrong audience", async () => {
  installJwks();
  const token = mintToken({ claims: { aud: "https://attacker.example.com" } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /bad aud/);
});

test("accepts a token whose aud has a trailing slash (Pub/Sub endpoint-default)", async () => {
  installJwks();
  // Pub/Sub's subscriptions-update path emits the push-endpoint default as the
  // JWT aud (with trailing slash) even when the configured audience has none.
  const token = mintToken({ claims: { aud: AUDIENCE + "/" } });
  const claims = await verifyGoogleIdToken(token, OPTS);
  assert.equal(claims.aud, AUDIENCE + "/");
});

test("accepts when configured audience has a trailing slash but aud does not", async () => {
  installJwks();
  const token = mintToken({ claims: { aud: AUDIENCE } });
  const claims = await verifyGoogleIdToken(token, { ...OPTS, audience: AUDIENCE + "/" });
  assert.equal(claims.aud, AUDIENCE);
});

test("rejects a token from the wrong service account", async () => {
  installJwks();
  const token = mintToken({ claims: { email: "someone-else@project.iam.gserviceaccount.com" } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /bad email/);
});

test("rejects a token whose email is not verified", async () => {
  installJwks();
  const token = mintToken({ claims: { email_verified: false } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /email not verified/);
});

test("rejects an expired token (beyond clock skew)", async () => {
  installJwks();
  const past = Math.floor(Date.now() / 1000) - 3600;
  const token = mintToken({ claims: { iat: past, exp: past + 600 } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /expired/);
});

test("rejects a token issued far in the future", async () => {
  installJwks();
  const future = Math.floor(Date.now() / 1000) + 3600;
  const token = mintToken({ claims: { iat: future, exp: future + 600 } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /future/);
});

test("rejects a bad issuer", async () => {
  installJwks();
  const token = mintToken({ claims: { iss: "https://accounts.evil.com" } });
  await assert.rejects(() => verifyGoogleIdToken(token, OPTS), /bad iss/);
});

// --- behavior of the audience/email options ------------------------------

test("when audience option omitted, aud is not enforced (still checks sig)", async () => {
  installJwks();
  const token = mintToken({ claims: { aud: "https://anything.example.com" } });
  const claims = await verifyGoogleIdToken(token, { email: SA_EMAIL });
  assert.equal(claims.aud, "https://anything.example.com");
});
