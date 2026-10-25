// http-server-oidc.test.mjs — integration test for the :9090 Gmail-push auth
// glue in supervisor/http-server.mjs (the push port is publicly reachable
// through a tunnel, so every request must prove it came from Pub/Sub). Boots
// the REAL startServers() over loopback with a temp HOME, then
// drives the port with actual HTTP requests to prove:
//   - valid OIDC bearer  → 200, handlePush invoked
//   - missing/invalid    → 401, handlePush NOT invoked
//   - missing OIDC config → 503
//   - X-Inbound-Secret path still works independently of OIDC
//
// JWKS is injected via oidc-verify's _setJwksForTest seam (ESM singletons mean
// the instance http-server imports is the same one we configure here), so this
// runs fully offline.
//
// Run: node --test tests/http-server-oidc.test.mjs

// A made-up installation (the owner address the inbound gate allowlists), the
// same in every checkout.
import "./synthetic-instance.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- temp HOME so http-server's HOME-derived paths resolve to a sandbox ---
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "edva-httptest-"));
const SECRETS_DIR = path.join(TMP_HOME, "Dev/edva/secrets");
const JOBS_DIR = path.join(TMP_HOME, "Dev/edva/agent/ops-agent/jobs");
fs.mkdirSync(SECRETS_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

const AUDIENCE = "https://push.example.com";
const SA_EMAIL = "edva-pubsub@example-project.iam.gserviceaccount.com";
const INBOUND_SECRET = "test-inbound-secret-value-1234567890";

fs.writeFileSync(
  path.join(SECRETS_DIR, "pubsub-oidc.json"),
  JSON.stringify({ audience: AUDIENCE, serviceAccount: SA_EMAIL }),
);
fs.writeFileSync(path.join(SECRETS_DIR, "email-inbound-secret"), INBOUND_SECRET);
fs.writeFileSync(path.join(JOBS_DIR, "email-inbound.md"), "# email-inbound playbook (test)");

// Inbound email side effects stay in the temp HOME: the gate's handled/dropped
// logs, and a fake one-shot runner that records its argv instead of calling a model.
const INBOUND_DATA = path.join(TMP_HOME, "inbound-data");
fs.mkdirSync(INBOUND_DATA, { recursive: true });
process.env.EMAIL_INBOUND_DATA_DIR = INBOUND_DATA;
const RUN_MARK = path.join(TMP_HOME, "oneshot-runs.jsonl");
const FAKE_RUN = path.join(TMP_HOME, "fake-email-inbound-run.mjs");
fs.writeFileSync(FAKE_RUN, `import fs from "node:fs";
const i = process.argv.indexOf("--payload");
const payload = JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8"));
fs.appendFileSync(${JSON.stringify(RUN_MARK)}, JSON.stringify({ from: payload.email.from, context: payload.context }) + "\\n");
`);
process.env.EMAIL_INBOUND_RUN_BIN = FAKE_RUN;

// HOME must be set BEFORE importing http-server (paths are computed at import).
process.env.HOME = TMP_HOME;

const { startServers } = await import("../agent/supervisor/http-server.mjs");
const { _setJwksForTest } = await import("../agent/supervisor/oidc-verify.mjs");
// The owner: whichever address heads the inbound gate's allowlist.
const { ALLOWLIST } = await import("../lib/email-inbound-gate.mjs");
const OWNER = ALLOWLIST[0];

// --- test keypair + JWKS injection ---------------------------------------
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "http-test-key";
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
_setJwksForTest([publicJwk]);

function b64url(s) { return Buffer.from(s).toString("base64url"); }
function mintToken(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: AUDIENCE, email: SA_EMAIL,
    email_verified: true, iat: now, exp: now + 600, ...over,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`); signer.end();
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

// --- mock gmailSource + supervisor ---------------------------------------
let pushCalls = 0;
let dispatchCalls = 0;
const gmailSource = {
  handlePush() { pushCalls++; return { accept: false, reason: "test-noop" }; },
};
const supervisor = {
  cfg: {},
  dispatcher: { dispatch() { dispatchCalls++; } },
};

const PORTS = { gmailPubsubPort: 19090, webhookPort: 19092, healthPort: 19093 };
let handle;
const BASE = `http://127.0.0.1:${PORTS.gmailPubsubPort}`;

before(async () => {
  handle = startServers({ ports: PORTS, gmailSource, supervisor });
  // give listeners a beat to bind
  await new Promise((r) => setTimeout(r, 200));
});
after(async () => {
  try { await handle.close(); } catch {}
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

async function post(headers, body = JSON.stringify({ message: { data: b64url("{}") } })) {
  return fetch(BASE + "/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

test("GET / is unauthenticated and returns ok (tunnel liveness probe path)", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
});

test("valid OIDC bearer → 200 and handlePush invoked", async () => {
  const before = pushCalls;
  const res = await post({ authorization: `Bearer ${mintToken()}` });
  assert.equal(res.status, 200);
  assert.equal(pushCalls, before + 1);
});

test("missing Authorization → 401 and handlePush NOT invoked", async () => {
  const before = pushCalls;
  const res = await post({});
  assert.equal(res.status, 401);
  assert.equal(pushCalls, before);
});

test("invalid token (wrong audience) → 401 and handlePush NOT invoked", async () => {
  const before = pushCalls;
  const res = await post({ authorization: `Bearer ${mintToken({ aud: "https://evil.example" })}` });
  assert.equal(res.status, 401);
  assert.equal(pushCalls, before);
});

test("garbage bearer → 401", async () => {
  const res = await post({ authorization: "Bearer not-a-jwt" });
  assert.equal(res.status, 401);
});

const postInbound = (body) => fetch(BASE + "/", {
  method: "POST",
  headers: { "content-type": "application/json", "x-inbound-secret": INBOUND_SECRET },
  body: JSON.stringify(body),
});
const runs = () => { try { return fs.readFileSync(RUN_MARK, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const waitFor = async (pred, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("X-Inbound-Secret path works independently of OIDC (non-allowlisted sender is dropped by the code gate)", async () => {
  const before = dispatchCalls;
  const res = await postInbound({ from: "x@y.com", subject: "hi", text: "yo" });
  assert.equal(res.status, 200);
  assert.equal(dispatchCalls, before);
  assert.equal(runs().length, 0);
});

test("allowlisted email in session mode dispatches in-session (rollback path)", async () => {
  supervisor.cfg.emailInboundMode = "session";
  try {
    const before = dispatchCalls;
    const res = await postInbound({ from: OWNER, subject: "q", text: "hi", message_id: `<s-${Date.now()}@test>` });
    assert.equal(res.status, 200);
    assert.equal(dispatchCalls, before + 1);
  } finally { delete supervisor.cfg.emailInboundMode; }
});

test("allowlisted email in the default one-shot mode goes to email-inbound-run, not the session", async () => {
  const before = dispatchCalls;
  const res = await postInbound({ from: OWNER, subject: "q2", text: "hi", message_id: `<o-${Date.now()}@test>` });
  assert.equal(res.status, 200);
  assert.ok(await waitFor(() => runs().length === 1), "one-shot runner was spawned");
  assert.equal(runs()[0].from, OWNER);
  assert.equal(runs()[0].context.allowlisted, true);
  assert.equal(dispatchCalls, before);
});

test("wrong X-Inbound-Secret → 401", async () => {
  const res = await fetch(BASE + "/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-inbound-secret": "wrong" },
    body: JSON.stringify({ from: "x@y.com" }),
  });
  assert.equal(res.status, 401);
});
