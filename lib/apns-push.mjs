// Shared APNs push helper for Edva.
// Sends a single push-notification payload to every device token in Supabase.

import http2 from "node:http2";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { writeFileAtomic } from "./atomic-write.js";

import { getMotionState } from "./motion-state.mjs";
import { holdPing } from "./ping-hold.mjs";

import { installTools } from "./root.cjs";
import { underTestRunner } from "./load-env.js";
// The installation's APNs identity: agent/local/config/apns.json
// { team_id, key_id, bundle_id } (the Apple Developer team that owns the .p8
// key, the key's id, and the companion app's bundle id = the APNs topic).
// EDVA_APNS_TEAM_ID / _KEY_ID / _BUNDLE_ID override.
const APNS_CFG = createRequire(import.meta.url)("./instance.cjs").localConfig("apns", { team_id: "", key_id: "", bundle_id: "" });
const APNS_TEAM_ID = process.env.EDVA_APNS_TEAM_ID || APNS_CFG.team_id;
const APNS_KEY_ID = process.env.EDVA_APNS_KEY_ID || APNS_CFG.key_id;
const APNS_BUNDLE_ID = process.env.EDVA_APNS_BUNDLE_ID || APNS_CFG.bundle_id;
const APNS_KEY_PATH = installTools("credentials/edva-apns.p8");
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
  // The one place a push leaves for Apple. Inside a test run (node --test) it
  // refuses before connecting: a test's push would buzz the user's real phone.
  // Tests hand the senders their own `send`. See "Test runs" in load-env.js.
  if (underTestRunner()) {
    return Promise.reject(new Error("apns-push: not sent — this is a test run (NODE_TEST_CONTEXT is set), and a test never pushes to a real device"));
  }
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

const FAILURE_FILE = installTools("data/apns-token-failures.json");

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
    // Atomic: concurrent pushes from several processes read-modify-write it (D15).
    writeFileAtomic(FAILURE_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error(`[apns-push] failure-log write failed: ${err?.message || err}`);
  }
}

function clearTokenFailure(token) {
  const log = readFailureLog();
  if (!log[token]) return;
  delete log[token];
  try {
    writeFileAtomic(FAILURE_FILE, JSON.stringify(log, null, 2));
  } catch {}
}

/**
 * True when a self_improve_approvals row should count toward the "pending
 * Face-ID approval" badge. Mirrors SelfImproveApproval.pendingApprovalCount()
 * in the client exactly (client/Edva/SelfImproveApproval.swift) — pending,
 * not skipped (both filtered by the query below), high risk or unset (which
 * defaults to high), not expired — so the push badge and the in-app badge
 * never disagree about what's actionable.
 */
export function isApprovalRowPending(row, nowMs = Date.now()) {
  if ((row.risk || "high") !== "high") return false;
  if (row.expires_at_ms == null) return true;
  return row.expires_at_ms > nowMs;
}

/**
 * Count of self_improve_approvals rows currently waiting on the user's Face ID.
 * A failed query counts as zero rather than throwing — same fail-open shape
 * as the rest of this file (an occasional undercounted badge beats a push
 * that never sends).
 */
export async function getPendingApprovalCount(supabase) {
  const { data: rows, error } = await supabase
    .from("self_improve_approvals")
    .select("status,risk,expires_at_ms")
    .eq("status", "pending")
    .eq("skipped", false);
  if (error || !rows) return 0;
  const nowMs = Date.now();
  return rows.filter((row) => isApprovalRowPending(row, nowMs)).length;
}

/**
 * Combine unread-chat + pending-approval counts into the single number APNs
 * shows on the app icon. Falls back to 1 when both are zero so a push that
 * genuinely just fired never shows a 0 badge (same fallback the chat-only
 * version always had).
 */
export function computeBadgeCount(unreadCount, pendingApprovals) {
  return (unreadCount || 0) + (pendingApprovals || 0) || 1;
}

/** "mac" or "mobile" (iPhone/iPad) for a device_tokens row. */
export function deviceClass(row) {
  return String(row?.platform || "ios").toLowerCase().startsWith("mac") ? "mac" : "mobile";
}

/**
 * Pick which device_tokens rows a visible push goes to. While the user is
 * actively using Edva on one device class (Mac or phone), notifications
 * should not go to the other. Each app renews `active_until` while in
 * active use (client/Edva/DeviceActivity.swift). While any lease is live,
 * only that device class gets the push — on the active device it lands silently
 * in the open chat (willPresent suppresses the banner). No live lease, or a
 * lease on both classes, means every device, so a crashed or asleep app can
 * never swallow a ping.
 */
export function selectPushTargets(rows, nowMs = Date.now()) {
  const all = rows || [];
  const activeClasses = new Set(
    all.filter((r) => r.active_until && Date.parse(r.active_until) > nowMs).map(deviceClass),
  );
  if (activeClasses.size !== 1) return all;
  return all.filter((r) => activeClasses.has(deviceClass(r)));
}

// ─── Push recipients ──────────────────────────────────────────────────────
// Which device classes each message's visible push reached, so reading it on
// one device can take the banner off the others (sendClearPush) and so "why
// did my phone buzz?" has an answer. Kept 7 days; written by every sender
// process, hence the atomic write.
const PUSH_RECIPIENTS_FILE = installTools("data/push-recipients.json");
const PUSH_RECIPIENTS_KEEP_MS = 7 * 86_400_000;

function readPushRecipients(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function recordPushRecipients(messageId, classes, { file = PUSH_RECIPIENTS_FILE, nowMs = Date.now() } = {}) {
  if (!messageId || !classes?.length) return;
  const log = readPushRecipients(file);
  for (const [id, e] of Object.entries(log)) {
    if (!(nowMs - Date.parse(e.at) < PUSH_RECIPIENTS_KEEP_MS)) delete log[id];
  }
  const prev = log[messageId]?.classes || [];
  log[messageId] = { at: new Date(nowMs).toISOString(), classes: [...new Set([...prev, ...classes])].sort() };
  try {
    writeFileAtomic(file, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error(`[apns-push] push-recipients write failed: ${err?.message || err}`);
  }
}

/** Device classes ("mac" / "mobile") a message's visible push went to; [] if none. */
export function pushRecipients(messageId, { file = PUSH_RECIPIENTS_FILE } = {}) {
  return readPushRecipients(file)[messageId]?.classes || [];
}

/**
 * Send a single push notification to the registered Edva devices —
 * the one the user is actively using, or all of them (selectPushTargets).
 *
 * @param {object} supabase   Supabase client (already initialized).
 * @param {object} opts
 * @param {string} opts.body         Notification body shown to the user (short summary).
 * @param {string} [opts.title]      Notification title. Defaults to "Edva".
 * @param {string} [opts.messageId]  edva_messages UUID to deep-link to on tap.
 * @param {string} [opts.channel]    Channel of the triggering message ("chat" |
 *                                   "system"). Defaults to "chat". System/infra
 *                                   alerts never touch the icon badge.
 * @param {boolean} [opts.urgent]    When true, deliver as a time-sensitive
 *                                   notification that breaks through Driving/DND
 *                                   Focus. Reserve for genuinely time-critical
 *                                   nudges ("leave now — tunnel's backing up");
 *                                   routine pings should stay non-urgent so they
 *                                   respect the user's Focus.
 * @param {boolean} [opts.skipMotionGate]  Bypass the mobile hold. Reserved for
 *                                   bin/ping-flush, which has already
 *                                   established the user is stationary and is
 *                                   delivering pings this gate parked earlier.
 *                                   No job should set this.
 * @returns {Promise<{delivered: boolean, held?: boolean, reason?: string}>}
 */
export async function sendApnsPush(supabase, { body, title = "Edva", messageId = null, channel = "chat", urgent = false, skipMotionGate = false }) {
  // ── Motion gate ────────────────────────────────────────────────────────
  // Urgent pings always go: they are time-sensitive, they pierce Focus, and on
  // AirPods they get announced aloud — which is exactly the delivery that works
  // when the user cannot look at a screen. Non-urgent pings wait for them to stop.
  //
  // This lives at the chokepoint rather than in the ~70 jobs that send pings,
  // so a new job inherits the behavior instead of having to remember it.
  if (!urgent && !skipMotionGate) {
    const motion = await getMotionState(supabase);
    if (motion.state === "mobile") {
      holdPing({ body, title, messageId, channel, reason: motion.reason });
      console.error(`[apns-push] held (${motion.reason}) — will flush when stationary`);
      return { delivered: false, held: true, reason: motion.reason };
    }
  }

  const { data: rows, error } = await supabase.from("device_tokens").select("token,platform,active_until");
  const tokens = selectPushTargets(rows);
  if (error || tokens.length === 0) {
    console.error(`[apns-push] no device tokens: ${error?.message || "empty"}`);
    return { delivered: false, reason: "no device tokens" };
  }

  const aps = {
    alert: { title, body },
    sound: "default",
  };

  // Plain notifications. We deliberately do NOT set mutable-content or a reply
  // category: the SiriKit messaging machinery (NSE communication-notification
  // upcast + INSendMessageIntent handler) never formed a real comm notification
  // on-device (always plain) and, once Siri was authorized, it reclassified the
  // app as a messaging provider and BROKE the plain-notification AirPods
  // announcement that had worked all along. Plain notifications announce; that's
  // the supported path until the iOS 27 messages App-schema lands.

  // Time-sensitive delivery pierces Focus (e.g. Driving / Reduce Interruptions).
  if (urgent) aps["interruption-level"] = "time-sensitive";

  // Badge = unread CHAT messages + pending high-risk Improvements approvals.
  // Infra alerts on the `system` channel must not change the icon badge, so we
  // omit the `badge` key entirely for them — APNs leaves the current badge
  // untouched when the key is absent. Setting it (even via computeBadgeCount's
  // `|| 1` fallback) would bump the badge to 1 on a system alert when nothing
  // else is outstanding, and counting the never-opened system backlog inflated
  // every push badge — both are why `system` stays excluded.
  //
  // Pending approvals are folded in alongside chat because a push landing on
  // the `improvements` channel — a brand-new Face-ID card — used to set the
  // badge from chat-unread alone, so it shipped with whatever number chat
  // already showed (often 0) and gave no visual signal a card was waiting
  // getPendingApprovalCount()/isApprovalRowPending() mirror the
  // in-app badge's own predicate so the two counts can't drift apart again.
  if (channel !== "system") {
    const { count: unreadCount } = await supabase
      .from("edva_messages")
      .select("id", { count: "exact", head: true })
      .eq("role", "assistant")
      .eq("read", false)
      .eq("channel", "chat");
    const pendingApprovals = await getPendingApprovalCount(supabase);
    aps.badge = computeBadgeCount(unreadCount, pendingApprovals);
  }
  const payload = { aps };
  if (messageId) payload.message_id = messageId;
  if (urgent) payload.urgent = true;
  const payloadString = JSON.stringify(payload);

  const jwt = createApnsJwt();
  const reached = new Set();
  for (const row of tokens) {
    const result = await sendOne(jwt, row.token, payloadString);
    if (result.status === 200) {
      clearTokenFailure(row.token);
      reached.add(deviceClass(row));
    } else {
      recordTokenFailure(row.token, result.status, result.body);
    }
  }
  console.error(`[apns-push] sent to ${[...reached].join("+") || "nobody"}${messageId ? ` (${messageId})` : ""}`);
  if (messageId) recordPushRecipients(messageId, [...reached]);
  return { delivered: true };
}

/**
 * Purchase-approval push (lib/purchase-approval.mjs). Time-sensitive and
 * past the motion gate by design: the cart behind it expires in minutes, and
 * nothing is bought until the user opens it and approves with Face ID. The category
 * has no action buttons (PurchaseApproval.swift) — opening it only shows the
 * review screen, which loads the row itself by `purchase_id` rather than
 * trusting anything in this payload. It goes to the device the user is actively
 * using, else every device — iPhone (Face ID) and Mac (Touch ID); whichever
 * paired device the user approves on first wins.
 */
export async function sendPurchaseApprovalPush(supabase, { purchaseId, body, send = sendOne, jwt = null }) {
  const { data: rows, error } = await supabase.from("device_tokens").select("token,platform,active_until");
  const tokens = selectPushTargets(rows);
  if (error || tokens.length === 0) {
    return { delivered: false, reason: error ? error.message : "no device tokens" };
  }
  const payloadString = JSON.stringify({
    aps: {
      alert: { title: "Approve purchase", body },
      sound: "default",
      "interruption-level": "time-sensitive",
      category: "EDVA_PURCHASE_APPROVAL",
    },
    kind: "edva-purchase-approval",
    purchase_id: purchaseId,
  });
  const bearer = jwt || createApnsJwt();
  let ok = 0;
  for (const { token } of tokens) {
    const r = await send(bearer, token, payloadString);
    if (r.status === 200) { ok++; clearTokenFailure(token); } else recordTokenFailure(token, r.status, r.body);
  }
  return { delivered: ok > 0, sent: tokens.length, ok };
}

/** True for a device_tokens row that can take an iOS background push. Rows
 *  saved before the platform column existed have none and count as iOS. */
export function isIosToken(row) {
  const p = String(row?.platform || "ios").toLowerCase();
  return !p.startsWith("mac");
}

/**
 * Background ("silent") push: wakes the iOS app with `data` merged next to
 * `aps.content-available`. No alert, no sound, no badge, no message row, and
 * no motion gate. Nothing is shown to the user, so there is nothing to hold.
 * Used by an installation's own probes, e.g. to ask the phone for photos.
 * iOS may delay or drop background pushes, so callers must not
 * depend on one arriving.
 *
 * @param supabase  supabase-js client (reads device_tokens)
 * @param data      extra top-level keys, e.g. {kind: "<probe kind>", probe_id}
 * @param opts.send injectable sendOne (tests)
 * @param opts.include which device_tokens rows to wake (default iOS only;
 *   sendClearPush also wakes the Mac app, which gets background pushes while running)
 * @returns {Promise<{delivered: boolean, sent: number, ok: number, results: Array<{token: string, status: number}>, reason?: string}>}
 */
export async function sendSilentPush(supabase, data = {}, { send = sendOne, jwt = null, include = isIosToken } = {}) {
  const { data: rows, error } = await supabase.from("device_tokens").select("token,platform");
  const tokens = (rows || []).filter(include);
  if (error || tokens.length === 0) {
    const none = include === isIosToken ? "no iOS device tokens" : "no matching device tokens";
    return { delivered: false, sent: 0, ok: 0, results: [], reason: error ? error.message : none };
  }
  const payloadString = JSON.stringify({ ...data, aps: { "content-available": 1 } });
  const bearer = jwt || createApnsJwt();
  const results = [];
  for (const { token } of tokens) {
    const r = await send(bearer, token, payloadString, { "apns-push-type": "background", "apns-priority": "5" });
    if (r.status === 200) clearTokenFailure(token); else recordTokenFailure(token, r.status, r.body);
    results.push({ token: token.slice(0, 8), status: r.status });
  }
  const ok = results.filter((r) => r.status === 200).length;
  return { delivered: ok > 0, sent: results.length, ok, results, ...(ok ? {} : { reason: "every send failed" }) };
}

/**
 * Read on one device → take the banner off the others. A question popped up on
 * the Mac, the user opened it there, and the iPhone's copy of the same push
 * landed seconds later (and the same in the other direction).
 * The device choice is made once at send time, so the fix is after the fact:
 * when a pushed message flips to read, a silent push {kind:
 * "clear_notifications", message_ids, badge} goes to every device class that
 * got its banner, and the app removes those delivered notifications and sets
 * the icon badge (EdvaApp.swift, DeliveredNotifications). Messages that
 * never pushed send nothing. Best-effort: iOS may delay or drop background
 * pushes, the Mac app only hears it while running, and a banner whose own
 * delivery is slower than this clear still shows.
 *
 * @param messageIds edva_messages ids that just became read
 * @param opts.badge icon badge to set; computed (unread chat + pending
 *   approvals, as sendApnsPush does) when omitted
 */
export async function sendClearPush(supabase, messageIds, { send = sendOne, jwt = null, file = PUSH_RECIPIENTS_FILE, badge } = {}) {
  const pushed = (messageIds || []).filter((id) => pushRecipients(id, { file }).length);
  if (pushed.length === 0) return { delivered: false, sent: 0, ok: 0, results: [], reason: "never pushed" };
  const classes = new Set(pushed.flatMap((id) => pushRecipients(id, { file })));
  if (badge === undefined) {
    try {
      const { count } = await supabase
        .from("edva_messages")
        .select("id", { count: "exact", head: true })
        .eq("role", "assistant")
        .eq("read", false)
        .eq("channel", "chat");
      badge = (count || 0) + ((await getPendingApprovalCount(supabase)) || 0);
    } catch {
      badge = undefined; // leave the badge alone rather than guess
    }
  }
  const data = { kind: "clear_notifications", message_ids: pushed };
  if (Number.isInteger(badge)) data.badge = badge;
  return sendSilentPush(supabase, data, { send, jwt, include: (r) => classes.has(deviceClass(r)) });
}
