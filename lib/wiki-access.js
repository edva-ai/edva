"use strict";
// wiki-access.js — identity and page-scoping for the public wiki hostname.
//
// WHY THE ORIGIN VERIFIES TOO. Cloudflare Access sits in front of
// the wiki hostname, but `wiki serve` was written as a localhost browser and had
// NO authentication of any kind — so Access would have been the single thing
// between the open internet and every page, including the most sensitive
// personal pages. A deleted
// policy, a misconfigured application, or a request that reaches the tunnel by
// another route would expose all of it. So the origin independently verifies
// the `Cf-Access-Jwt-Assertion` header and refuses anything without a valid
// one. Access is then a second lock, not the only lock.
//
// The verified JWT is also what makes per-person scoping trustworthy: the email
// comes from a signature we checked, not from a header a client could set.
//
// Env (.env):
//   CF_ACCESS_TEAM_DOMAIN   e.g. "<team>.cloudflareaccess.com"
//   CF_ACCESS_AUD           the Access application's Audience tag
//   WIKI_PUBLIC             set to "1" on the process that serves the tunnel

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { scopeFromConfig } = require("./wiki-scope.js");

// Who may read what: data/wiki-share-scopes.json, or the file named by
// WIKI_SHARE_SCOPES_FILE (read per call, so a test can point it at a synthetic config).
const SCOPES_FILE = path.join(__dirname, "..", "data", "wiki-share-scopes.json");
function scopesFile() {
  return process.env.WIKI_SHARE_SCOPES_FILE || SCOPES_FILE;
}
const JWKS_TTL_MS = 60 * 60 * 1000; // Cloudflare rotates rarely; an hour is ample.

let jwksCache = { keys: null, fetchedAt: 0 };

function teamDomain() {
  return (process.env.CF_ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); // lang-regex-ok: normalising a configured hostname
}

/** Cloudflare's public keys for this team. Cached, and refreshed on an unknown kid. */
async function getJwks({ force = false } = {}) {
  const now = Date.now();
  if (!force && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const domain = teamDomain();
  if (!domain) throw new Error("CF_ACCESS_TEAM_DOMAIN is not set");
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  jwksCache = { keys: body.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

function b64uToBuf(s) {
  return Buffer.from(s, "base64url");
}

/**
 * Verify a Cloudflare Access JWT and return its verified email.
 *
 * Throws on ANY doubt — bad signature, wrong audience, wrong issuer, expired,
 * unknown key. There is no partial success: a token we cannot fully verify is
 * treated exactly like no token. `opts.aud` overrides CF_ACCESS_AUD.
 */
async function verifyAccessJwt(token, { aud: audOverride } = {}) {
  if (!token || typeof token !== "string") throw new Error("no Access token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed Access token");
  const [h, p, sig] = parts;

  const header = JSON.parse(b64uToBuf(h).toString("utf8"));
  const payload = JSON.parse(b64uToBuf(p).toString("utf8"));

  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  let keys = await getJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // A rotated key is the one legitimate reason for an unknown kid.
    keys = await getJwks({ force: true });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown signing key");

  const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), pubKey, b64uToBuf(sig));
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error("token expired");
  if (payload.nbf && now < payload.nbf) throw new Error("token not yet valid");

  // `aud` lets another origin behind the same Access team (another
  // Access-protected page of this installation) check against ITS application's
  // Audience tag; a wiki token must never open that page, nor the reverse.
  const expectedAud = audOverride || process.env.CF_ACCESS_AUD;
  if (!expectedAud) throw new Error("CF_ACCESS_AUD is not set");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expectedAud)) throw new Error("audience mismatch");

  const expectedIss = `https://${teamDomain()}`;
  if (payload.iss !== expectedIss) throw new Error("issuer mismatch");

  const email = (payload.email || "").toLowerCase();
  if (!email) throw new Error("token carries no email");
  return { email, payload };
}

function loadScopes() {
  return JSON.parse(fs.readFileSync(scopesFile(), "utf8"));
}

/** Resolve an email to what it may read — see wiki-scope.js for the rules. */
function scopeFor(email) {
  return scopeFromConfig(loadScopes(), email);
}

/**
 * Decide who is asking.
 *
 * In public mode (WIKI_PUBLIC=1) a verified Access JWT is mandatory. Otherwise
 * the server is the localhost browser it has always been and the caller is the
 * owner — which keeps `wiki serve` working on the host with no ceremony, while
 * the tunnel-facing process cannot fall back to that.
 */
async function identify(req, { publicMode = process.env.WIKI_PUBLIC === "1" } = {}) {
  const token =
    (req.headers && (req.headers["cf-access-jwt-assertion"] || req.headers["Cf-Access-Jwt-Assertion"])) || null;

  if (!publicMode) {
    if (!token) return { email: "local", scope: { label: "local", unrestricted: true, known: true, canRead: () => true } };
    // Even locally, a presented token is honoured if it verifies — so the public
    // path can be exercised on the host without flipping the whole server over.
    try {
      const { email } = await verifyAccessJwt(token);
      return { email, scope: scopeFor(email) };
    } catch {
      return { email: "local", scope: { label: "local", unrestricted: true, known: true, canRead: () => true } };
    }
  }

  const { email } = await verifyAccessJwt(token); // throws → caller sends 403
  return { email, scope: scopeFor(email) };
}

module.exports = { identify, scopeFor, verifyAccessJwt, loadScopes };
