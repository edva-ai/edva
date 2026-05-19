// Shared APNs push helper for Merlin.
// Sends a single push-notification payload to every device token in Supabase.

import http2 from "node:http2";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APNS_TEAM_ID = "TEAMID_PLACEHOLDER";
const APNS_KEY_ID = "S5723VD8JS";
const APNS_BUNDLE_ID = "com.example.Merlin";
const APNS_KEY_PATH = path.join(process.env.HOME, "dev/merlin/credentials/merlin-apns.p8");
const APNS_HOST = "api.push.apple.com";

let apnsKeyCache = null;
function getApnsKey() {
  if (!apnsKeyCache) apnsKeyCache = fs.readFileSync(APNS_KEY_PATH, "utf8");
  return apnsKeyCache;
}

function derToRaw(derSig) {
  let offset = 2;
  if (derSig[1] & 0x80) offset += (derSig[1] & 0x7f);
  offset += 1;
  const rLen = derSig[offset++];
  const r = derSig.subarray(offset, offset + rLen);
  offset += rLen + 1;
  const sLen = derSig[offset++];
  const s = derSig.subarray(offset, offset + sLen);
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - Math.min(r.length, 32), Math.max(r.length - 32, 0));
  s.copy(raw, 64 - Math.min(s.length, 32), Math.max(s.length - 32, 0));
  return raw;
}

function createApnsJwt() {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: APNS_KEY_ID })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: APNS_TEAM_ID, iat: now })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const key = crypto.createPrivateKey(getApnsKey());
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const rawSig = derToRaw(sign.sign(key));
  return `${signingInput}.${rawSig.toString("base64url")}`;
}

/**
 * Low-level send: post one JSON payload to one device with the given headers.
 * Resolves with `{ status, body }` so callers can distinguish 410 Unregistered
 * (token rot) from other failure modes. Treat any non-200 as a send failure;
 * a 410 specifically means the token should be retired.
 */
export function sendOne(jwt, deviceToken, payloadString, headers = {}) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${APNS_HOST}`);
    client.on("error", () => { try { client.close(); } catch {} resolve({ status: 0, body: "" }); });
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      ...headers,
    });
    let respBody = "";
    let status = 0;
    req.on("response", (h) => {
      status = Number(h[":status"]) || 0;
      if (status !== 200) console.error(`[apns-push] status ${status} for ${deviceToken.slice(0, 8)}…`);
    });
    req.on("data", (chunk) => { respBody += chunk; });
    req.on("end", () => {
      if (respBody) console.error(`[apns-push] response: ${respBody}`);
      client.close();
      resolve({ status, body: respBody });
    });
    req.on("error", () => { try { client.close(); } catch {} resolve({ status: 0, body: "" }); });
    req.write(payloadString);
    req.end();
  });
}

export { createApnsJwt };

const FAILURE_FILE = path.join(process.env.HOME, "dev/merlin/data/apns-token-failures.json");

function readFailureLog() {
  try { return JSON.parse(fs.readFileSync(FAILURE_FILE, "utf8")); } catch { return {}; }
}

function recordTokenFailure(token, status, body) {
  let reason = "";
  try { reason = JSON.parse(body || "{}")?.reason || ""; } catch {}
  const log = readFailureLog();
  const entry = log[token] || { token, fail_count: 0, statuses: [] };
  entry.fail_count = (entry.fail_count || 0) + 1;
  entry.last_status = status;
  entry.last_failure_reason = reason || null;
  entry.last_failure_at = new Date().toISOString();
  entry.statuses = [...(entry.statuses || []).slice(-9), status];
  log[token] = entry;
  try {
    fs.mkdirSync(path.dirname(FAILURE_FILE), { recursive: true });
    fs.writeFileSync(FAILURE_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error(`[apns-push] failure-log write failed: ${err?.message || err}`);
  }
}

function clearTokenFailure(token) {
  const log = readFailureLog();
  if (!log[token]) return;
  delete log[token];
  try {
    fs.writeFileSync(FAILURE_FILE, JSON.stringify(log, null, 2));
  } catch {}
}

/**
 * Send a single push notification to every registered Merlin device.
 *
 * @param {object} supabase   Supabase client (already initialized).
 * @param {object} opts
 * @param {string} opts.body         Notification body shown to the user (short summary).
 * @param {string} [opts.title]      Notification title. Defaults to "Merlin".
 * @param {string} [opts.messageId]  merlin_messages UUID to deep-link to on tap.
 */
export async function sendApnsPush(supabase, { body, title = "Merlin", messageId = null }) {
  const { data: tokens, error } = await supabase.from("device_tokens").select("token");
  if (error || !tokens || tokens.length === 0) {
    console.error(`[apns-push] no device tokens: ${error?.message || "empty"}`);
    return;
  }

  const { count: unreadCount } = await supabase
    .from("merlin_messages")
    .select("id", { count: "exact", head: true })
    .eq("role", "assistant")
    .eq("read", false);

  const aps = {
    alert: { title, body },
    sound: "default",
    badge: unreadCount || 1,
    "mutable-content": 1,
  };
  const payload = { aps };
  if (messageId) payload.message_id = messageId;
  const payloadString = JSON.stringify(payload);

  const jwt = createApnsJwt();
  for (const { token } of tokens) {
    const result = await sendOne(jwt, token, payloadString);
    if (result.status === 200) {
      clearTokenFailure(token);
    } else {
      recordTokenFailure(token, result.status, result.body);
    }
  }
}
