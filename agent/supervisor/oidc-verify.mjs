// oidc-verify.mjs — verify Google-signed OIDC ID tokens with zero npm deps.
//
// Why this exists: behind a relay service the :9090 push handler could trust
// that only the relay could reach it. Behind a Cloudflare Tunnel (the push
// hostname → localhost:9090), that endpoint is directly internet-reachable. Anyone could POST a forged {historyId,
// emailAddress} and trigger Gmail history fetches / dispatch loops.
//
// Defense: Pub/Sub is configured with --push-auth-service-account, so Google
// signs every push with an OIDC JWT in the `Authorization: Bearer <jwt>`
// header. We verify that JWT here:
//   1. RS256 signature against Google's published JWKS (cached).
//   2. iss ∈ {accounts.google.com, https://accounts.google.com}.
//   3. aud === expected audience (the push endpoint URL we configured).
//   4. email === expected service account, email_verified === true.
//   5. exp not passed, iat not absurdly in the future (small skew allowed).
//
// The supervisor has no node_modules by design (pure stdlib). google-auth-library
// would verify this in one call, but pulling it (and its transitive deps) onto
// the host just for one JWT check is not worth breaking that invariant. Node's
// crypto can do RS256 verification natively; JWKS is just JSON over HTTPS.

import crypto from "node:crypto";

// Google's OIDC signing keys. The certs endpoint returns PEM certs keyed by
// `kid`; the JWKS endpoint returns raw JWK. We use the JWK endpoint because
// crypto.createPublicKey accepts JWK directly (no cert parsing needed).
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);
const CLOCK_SKEW_SEC = 60;

// JWKS cache. Google rotates keys ~daily and sets Cache-Control max-age; we
// honor that with a conservative default and refetch on a kid miss.
let _jwksCache = { keys: new Map(), expiresAt: 0 };

function b64urlToBuffer(s) {
  return Buffer.from(s, "base64url");
}

function b64urlToJson(s) {
  return JSON.parse(b64urlToBuffer(s).toString("utf8"));
}

async function fetchJwks() {
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kid) keys.set(jwk.kid, jwk);
  }
  // Respect Cache-Control max-age when present; default 1h.
  let maxAgeSec = 3600;
  const cc = res.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  if (m) maxAgeSec = Math.max(60, parseInt(m[1], 10));
  _jwksCache = { keys, expiresAt: Date.now() + maxAgeSec * 1000 };
  return keys;
}

async function getKey(kid, { allowRefetch = true } = {}) {
  if (Date.now() < _jwksCache.expiresAt && _jwksCache.keys.has(kid)) {
    return _jwksCache.keys.get(kid);
  }
  // Expired cache, or kid not present — (re)fetch once.
  if (Date.now() >= _jwksCache.expiresAt || !_jwksCache.keys.has(kid)) {
    const keys = await fetchJwks();
    if (keys.has(kid)) return keys.get(kid);
  }
  // kid still missing after a fresh fetch: unknown signing key.
  if (allowRefetch && !_jwksCache.keys.has(kid)) return null;
  return _jwksCache.keys.get(kid) || null;
}

// verifyGoogleIdToken(token, { audience, email }) → claims object on success.
// Throws Error with a short reason on any failure. The caller treats any throw
// as a 401.
export async function verifyGoogleIdToken(token, { audience, email } = {}) {
  if (!token || typeof token !== "string") throw new Error("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [headerB64, payloadB64, sigB64] = parts;

  let header, claims;
  try {
    header = b64urlToJson(headerB64);
    claims = b64urlToJson(payloadB64);
  } catch {
    throw new Error("undecodable jwt segments");
  }

  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  if (!header.kid) throw new Error("no kid in header");

  const jwk = await getKey(header.kid);
  if (!jwk) throw new Error(`unknown signing key ${header.kid}`);

  // RS256 verification over the signing input `${header}.${payload}`.
  const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const ok = verifier.verify(pubKey, b64urlToBuffer(sigB64));
  if (!ok) throw new Error("signature verification failed");

  // Claims checks.
  const now = Math.floor(Date.now() / 1000);
  if (!VALID_ISSUERS.has(claims.iss)) throw new Error(`bad iss ${claims.iss}`);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SEC < now) {
    throw new Error("token expired");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SEC > now) {
    throw new Error("token issued in the future");
  }
  if (audience !== undefined) {
    // Tolerate a trailing slash on either side. Google Pub/Sub emits the
    // push-endpoint default as the JWT `aud` (e.g. `https://host/`) on the
    // subscriptions-update path, while a fresh subscriptions-create with
    // --push-auth-token-audience emits the configured value verbatim (no
    // slash). Both are legitimate for the same endpoint.
    const normAud = (s) => String(s).replace(/\/+$/, "");
    if (normAud(claims.aud) !== normAud(audience)) {
      throw new Error(`bad aud ${claims.aud}`);
    }
  }
  if (email !== undefined) {
    if (claims.email !== email) throw new Error(`bad email ${claims.email}`);
    if (claims.email_verified !== true) throw new Error("email not verified");
  }

  return claims;
}

// Test seam: let unit tests inject a known JWKS without hitting the network.
export function _setJwksForTest(keys, ttlMs = 3_600_000) {
  const map = new Map();
  for (const jwk of keys) if (jwk.kid) map.set(jwk.kid, jwk);
  _jwksCache = { keys: map, expiresAt: Date.now() + ttlMs };
}
