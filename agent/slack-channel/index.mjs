// slack-channel: realtime Slack runner over the user's own logged-in Slack web
// session. Holds an RTM websocket as the user (an `xoxc-` client token plus the
// browser's `d` cookie, both read from .env), logs every message event it
// sees to data/slack-inbox.jsonl, pushes the few that the config says
// matter to the chat channel, and exposes a localhost HTTP server for sends.
//
// This is an unofficial client of Slack's web session (the same token the
// Slack web app uses), not a Slack app. See docs/slack-channel-setup.md
// for capture (bin/slack-session-capture), lifetime and the TOS caveat.
//
// Env:  SLACK_XOXC_TOKEN, SLACK_D_COOKIE   (re-read from .env on every
//       connect, so a re-capture lands without a restart)
//       SLACK_CHANNEL_PORT                 (overrides config `port`, default 9108)
// Config: agent/local/config/slack-channel.json (see core.mjs DEFAULTS).

import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { installTools } from "../../lib/root.cjs";
import { alertCandidate, queueAlert, recentFromInbox } from "../../lib/message-alert.mjs";
import {
  DEFAULTS, AUTH_ERRORS, SESSION_DEAD, cookieHeader, parseEnv, backoffSeconds, channelTypeOf,
  eventToEntry, classifyForPush, pushBody, renderMentions, mentionedUserIds, parseTarget,
  userDisplayName, userHandles, alertAudience, selfNames,
} from "./core.mjs";

const require = createRequire(import.meta.url);
const { loadEnv, DEFAULT_ENV_PATH } = require("../../lib/load-env.js");
const { localConfig } = require("../../lib/instance.cjs");

loadEnv();

const INBOX = installTools("data/slack-inbox.jsonl");
const DECISIONS = installTools("data/slack-filter-log.jsonl");
const STATE_FILE = installTools("data/slack-channel-state.json");
const CHAT_BIN = installTools("bin/edva-send-curl");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function config() {
  return localConfig("slack-channel", DEFAULTS);
}
const PORT = Number(process.env.SLACK_CHANNEL_PORT || config().port || 9108);

function log(msg) {
  console.error(`[slack-channel] ${new Date().toISOString()} ${msg}`);
}

function appendJsonl(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch (err) {
    log(`append ${path.basename(file)} failed: ${err.message}`);
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log(`state write failed: ${err.message}`);
  }
}

// ── credentials (re-read from .env so a re-capture needs no restart) ────────
let envCache = { mtime: 0, values: {} };
function creds() {
  try {
    const st = fs.statSync(DEFAULT_ENV_PATH);
    if (st.mtimeMs !== envCache.mtime) {
      envCache = { mtime: st.mtimeMs, values: parseEnv(fs.readFileSync(DEFAULT_ENV_PATH, "utf8")) };
    }
  } catch { /* no .env: fall back to process.env */ }
  const v = envCache.values;
  return {
    token: v.SLACK_XOXC_TOKEN || process.env.SLACK_XOXC_TOKEN || "",
    cookie: v.SLACK_D_COOKIE || process.env.SLACK_D_COOKIE || "",
    // The official app (Socket Mode): a user token (xoxp) for the Web API and
    // an app-level token (xapp, connections:write) for the event socket.
    userToken: v.SLACK_USER_TOKEN || process.env.SLACK_USER_TOKEN || "",
    appToken: v.SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN || "",
  };
}

// Which credentials the Web API uses: the official app's user token when it is
// configured and not known dead, else the web session (token + d cookie).
let officialDead = null; // the user/app token pair that last failed auth
const officialKey = (c) => `${c.userToken}|${c.appToken}`;
function useOfficial(c = creds()) {
  return !!(c.userToken && c.appToken) && officialDead !== officialKey(c);
}

// ── Slack Web API as the user ───────────────────────────────────────────────
async function api(method, params = {}, { retry = 1, bearer = null } = {}) {
  const c = creds();
  const official = bearer || useOfficial(c);
  if (!official && (!c.token || !c.cookie)) return { ok: false, error: "missing_credentials" };
  const body = new URLSearchParams(official ? {} : { token: c.token });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
  const headers = official
    ? { Authorization: `Bearer ${bearer || c.userToken}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }
    : { Cookie: cookieHeader(c.cookie), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA };
  let res;
  try {
    res = await fetch(`${config().api_base || DEFAULTS.api_base}/${method}`, { method: "POST", headers, body });
  } catch (err) {
    return { ok: false, error: `network:${err.message}` };
  }
  if (res.status === 429 && retry > 0) {
    const wait = Math.min(60, Number(res.headers.get("retry-after") || 5));
    log(`${method} rate-limited, retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(method, params, { retry: retry - 1, bearer });
  }
  try { return await res.json(); } catch { return { ok: false, error: `http_${res.status}` }; }
}

// ── name caches ─────────────────────────────────────────────────────────────
const users = new Map();      // id → { name, handles, at }
const channels = new Map();   // id → { name, type, user, at }
const USER_TTL = 24 * 3600e3;
const CHANNEL_TTL = 6 * 3600e3;
let userDirectory = { at: 0, loading: null };

function rememberUser(u) {
  if (!u?.id) return;
  users.set(u.id, { name: userDisplayName(u), handles: userHandles(u), at: Date.now() });
}

async function userName(id) {
  if (!id) return null;
  const hit = users.get(id);
  if (hit && Date.now() - hit.at < USER_TTL) return hit.name;
  if (!id.startsWith("U") && !id.startsWith("W")) return hit?.name || null; // bot ids
  const r = await api("users.info", { user: id });
  if (r.ok) { rememberUser(r.user); return users.get(id).name; }
  return hit?.name || null;
}

async function loadUserDirectory() {
  if (Date.now() - userDirectory.at < 3600e3) return;
  if (userDirectory.loading) return userDirectory.loading;
  userDirectory.loading = (async () => {
    let cursor = "";
    for (let page = 0; page < 50; page++) {
      const r = await api("users.list", { limit: 200, cursor: cursor || undefined });
      if (!r.ok) { log(`users.list failed: ${r.error}`); break; }
      for (const u of r.members || []) rememberUser(u);
      cursor = r.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
    userDirectory.at = Date.now();
  })().finally(() => { userDirectory.loading = null; });
  return userDirectory.loading;
}

async function channelInfo(id) {
  if (!id) return { name: null, type: null };
  const hit = channels.get(id);
  if (hit && Date.now() - hit.at < CHANNEL_TTL) return hit;
  const r = await api("conversations.info", { channel: id });
  const info = r.ok ? r.channel : null;
  const type = channelTypeOf(info, id);
  let name = info?.name || null;
  if (type === "im") name = (await userName(info?.user)) || info?.user || null;
  const out = { name, type, user: info?.user || null, at: Date.now() };
  channels.set(id, out);
  return out;
}

let conversationsCache = { at: 0, list: [] };
async function listConversations({ fresh = false } = {}) {
  if (!fresh && Date.now() - conversationsCache.at < 600e3) return conversationsCache.list;
  await loadUserDirectory();
  const list = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const r = await api("users.conversations", {
      types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200, cursor: cursor || undefined,
    });
    if (!r.ok) throw new Error(`users.conversations: ${r.error}`);
    for (const c of r.channels || []) {
      const type = channelTypeOf(c, c.id);
      const name = type === "im" ? (users.get(c.user)?.name || c.user) : c.name;
      list.push({ id: c.id, name, type, ...(type === "im" ? { user: c.user } : {}) });
      channels.set(c.id, { name, type, user: c.user || null, at: Date.now() });
    }
    cursor = r.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  conversationsCache = { at: Date.now(), list };
  return list;
}

async function resolveUserId(handle) {
  await loadUserDirectory();
  const h = handle.toLowerCase();
  const matches = [...users.entries()].filter(([, u]) => u.handles.includes(h)).map(([id]) => id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`@${handle} is ambiguous (${matches.length} users); use the user id`);
  throw new Error(`no Slack user named @${handle}`);
}

// { channel | user } from an HTTP /send payload → a channel id to post to.
async function resolveSendChannel(payload) {
  const raw = String(payload.channel || payload.user);
  const t = parseTarget(raw) || parseTarget(payload.channel ? `#${raw}` : `@${raw}`);
  if (!t) throw new Error(`cannot resolve target: ${raw}`);
  if (t.channel) return t.channel;
  if (t.channel_name) {
    const list = await listConversations();
    let hit = list.find((c) => c.type !== "im" && (c.name || "").toLowerCase() === t.channel_name);
    if (!hit) hit = (await listConversations({ fresh: true })).find((c) => c.type !== "im" && (c.name || "").toLowerCase() === t.channel_name);
    if (!hit) throw new Error(`not a member of #${t.channel_name}`);
    return hit.id;
  }
  const userId = t.user || (await resolveUserId(t.user_name));
  const r = await api("conversations.open", { users: userId });
  if (!r.ok) throw new Error(`conversations.open: ${r.error}`);
  return r.channel.id;
}

// ── alerts (system channel, once per outage) ────────────────────────────────
function systemPost(text) {
  try {
    const child = spawn(CHAT_BIN, ["--channel", "system", "--skip-precheck", text], { detached: true, stdio: "ignore" });
    child.on("error", (err) => log(`edva-send-curl failed: ${err.message}`));
    child.unref();
  } catch (err) {
    log(`edva-send-curl spawn failed: ${err.message}`);
  }
}

function pageAuthOnce(error) {
  const st = readState();
  if (st.auth_alert) return;
  st.auth_alert = { at: new Date().toISOString(), error };
  writeState(st);
  const why = error === "missing_credentials"
    ? "SLACK_XOXC_TOKEN / SLACK_D_COOKIE are not set in .env"
    : `Slack rejected the saved web session (${error})`;
  systemPost(`⚠️ Slack channel offline: ${why}. Sign in to Slack in the host's automation Chrome, then run bin/slack-session-capture. Retrying every ${Math.round(config().auth_backoff_s / 3600)}h until then.`);
}

// One notice when the official app's tokens stop working and the runner falls
// back to the web session (still connected, so not "offline").
function pageOfficialFallbackOnce(error) {
  const st = readState();
  if (st.official_alert) return;
  st.official_alert = { at: new Date().toISOString(), error };
  writeState(st);
  systemPost(`⚠️ Slack official app tokens rejected (${error}); the Slack channel fell back to the browser session. Reinstall the Edva app and update SLACK_USER_TOKEN / SLACK_APP_TOKEN in .env.`);
}

function clearAuthAlert() {
  const st = readState();
  if (!st.auth_alert) return;
  delete st.auth_alert;
  writeState(st);
  systemPost("✅ Slack channel reconnected.");
}

// ── inbound ─────────────────────────────────────────────────────────────────
const session = {
  connected: false, selfId: null, selfName: null, team: null, teamId: null,
  connectedSince: null, lastEventAt: null, authState: "unknown", reconnects: 0, transport: null,
};
const sentTs = new Map(); // ts we posted → time, to drop their RTM echo

function chatPing(body) {
  try {
    const child = spawn(CHAT_BIN, ["--suppress-hook", "--intent", "slack-inbound", body], { detached: true, stdio: "ignore" });
    child.on("error", (err) => log(`edva-send-curl failed: ${err.message}`));
    child.unref();
  } catch (err) {
    log(`edva-send-curl spawn failed: ${err.message}`);
  }
}

async function onMessageEvent(ev) {
  // Our own post's echo can beat the chat.postMessage reply; give the reply a
  // moment to record its ts, then drop the echo (it is logged as kind "sent").
  if (!ev.subtype && ev.user && ev.user === session.selfId) {
    await sleep(2);
    if (ev.ts && sentTs.has(ev.ts)) return;
  }
  const authorId = ev.subtype === "message_changed" ? ev.message?.user
    : ev.subtype === "message_deleted" ? ev.previous_message?.user
    : ev.user;
  const [channel, name] = await Promise.all([channelInfo(ev.channel), userName(authorId)]);
  const entry = eventToEntry(ev, { selfId: session.selfId, channel, userName: name });
  if (!entry) return;
  appendJsonl(INBOX, entry);

  const decision = classifyForPush(entry, config());
  appendJsonl(DECISIONS, {
    ts: entry.ts, slack_ts: entry.slack_ts, channel_id: entry.channel_id, user_id: entry.user_id,
    kind: entry.kind, push: decision.push, reason: decision.reason,
  });
  log(`${entry.kind} ch=${entry.channel_id}(${entry.channel_type}) from=${entry.user_id}${entry.from_me ? "(me)" : ""} push=${decision.push} reason=${decision.reason}`);
  if (!decision.push) {
    // Not pushed by the configured senders: a model still judges whether it
    // is important or urgent (lib/message-alert.mjs). Ordinary channel
    // traffic that does not @-mention the user is held to the higher bar in
    // config `channel_alerts`: it calls them by name, or it is a really major issue.
    const message = {
      message_id: entry.slack_ts, kind: entry.kind, from_me: entry.from_me, is_bot: !!(ev.bot_id || ev.subtype === "bot_message"),
      chat_id: entry.channel_id, chat_name: entry.channel_type === "im" ? null : entry.channel_name ? (entry.channel_type === "mpim" ? entry.channel_name : `#${entry.channel_name}`) : null,
      is_group: entry.channel_type !== "im", sender: entry.user_id, sender_name: entry.user_name, text: entry.text,
    };
    if (!alertCandidate({ ...message, channel: "slack" })) return;
    // A blocked channel never pings, judged or not.
    if ((config().block_channels || []).includes(entry.channel_id)) return;
    // The judge reads `<@U…>` markup as @Name, so it can tell who a message is addressed to.
    await Promise.all([...mentionedUserIds(entry.text), session.selfId].map((id) => userName(id)));
    const nameOf = (id) => users.get(id)?.name || null;
    const strict = alertAudience(entry) === "channel" && config().channel_alerts !== "standard";
    queueAlert({
      channel: "slack",
      message: { ...message, text: renderMentions(entry.text, nameOf) },
      recent: recentFromInbox(INBOX, "channel_id", entry.channel_id).map((r) => ({ ...r, text: renderMentions(r.text, nameOf) })),
      log,
      ...(strict ? { rubric: "channel", ownerNames: selfNames(users.get(session.selfId), session.selfName) } : {}),
    });
    return;
  }

  const ids = mentionedUserIds(entry.text);
  await Promise.all(ids.map((id) => userName(id)));
  const rendered = renderMentions(entry.text, (id) => users.get(id)?.name || null);
  chatPing(pushBody(entry, rendered));
}

function onRtmEvent(ev) {
  session.lastEventAt = new Date().toISOString();
  if (ev.type === "message") {
    onMessageEvent(ev).catch((err) => log(`message handler error: ${err.message}`));
  } else if (ev.type === "user_change" && ev.user) {
    rememberUser(ev.user);
  } else if ((ev.type === "channel_rename" || ev.type === "group_rename") && ev.channel?.id) {
    channels.delete(ev.channel.id);
  }
}

// ── connection loop ─────────────────────────────────────────────────────────
let stopping = false;
let currentWs = null;
const sleep = (s) => new Promise((r) => { const t = setTimeout(r, s * 1000); t.unref?.(); });

// The web client's own gateway, tried only when rtm.connect refuses the
// session token. Same token + cookie.
function fallbackWsUrl(token, teamId) {
  const q = new URLSearchParams({ token, sync_desync: "1", slack_client: "desktop", batch_presence_aware: "1" });
  if (teamId) q.set("gateway_server", `${teamId}-1`);
  return `${config().ws_gateway || DEFAULTS.ws_gateway}/?${q}`;
}

// The official app: auth.test with the user token, then a Socket Mode URL from
// apps.connections.open with the app-level token. Events arrive as envelopes
// that must be acked; the event inside has the same shape as an RTM event.
async function connectOfficial(c) {
  const who = await api("auth.test");
  if (!who.ok) return { reason: SESSION_DEAD.has(who.error) || AUTH_ERRORS.has(who.error) ? "official_auth" : "error", error: `official auth.test: ${who.error}` };
  const open = await api("apps.connections.open", {}, { bearer: c.appToken });
  if (!open.ok || !open.url) {
    return { reason: SESSION_DEAD.has(open.error) || AUTH_ERRORS.has(open.error) ? "official_auth" : "error", error: `apps.connections.open: ${open.error}` };
  }
  session.authState = "ok";
  session.selfId = who.user_id;
  session.selfName = who.user;
  session.team = who.team;
  session.teamId = who.team_id;
  session.transport = "socket-mode";
  return new Promise((resolve) => {
    const ws = new WebSocket(open.url);
    currentWs = ws;
    let opened = 0;
    ws.addEventListener("open", () => { opened = Date.now(); });
    ws.addEventListener("message", (msg) => {
      let env;
      try { env = JSON.parse(typeof msg.data === "string" ? msg.data : Buffer.from(msg.data).toString("utf8")); } catch { return; }
      if (env.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch {} }
      if (env.type === "hello") {
        session.connected = true;
        session.connectedSince = new Date().toISOString();
        log(`connected via socket-mode as ${session.selfId} team=${session.teamId}`);
        clearAuthAlert();
        const st = readState();
        if (st.official_alert) { delete st.official_alert; writeState(st); systemPost("✅ Slack is back on the official app."); }
      } else if (env.type === "disconnect") {
        log(`socket mode disconnect (${env.reason || "?"}); reconnecting`);
        try { ws.close(); } catch {}
      } else if (env.type === "events_api" && env.payload?.event) {
        onRtmEvent(env.payload.event);
      }
    });
    ws.addEventListener("error", (e) => log(`websocket error: ${e.message || e.error?.message || "unknown"}`));
    ws.addEventListener("close", (e) => {
      session.connected = false;
      currentWs = null;
      const lived = opened ? (Date.now() - opened) / 1000 : 0;
      log(`socket mode closed code=${e.code} after ${lived.toFixed(0)}s`);
      resolve({ reason: "closed", lived });
    });
  });
}

async function connectOnce() {
  const c = creds();
  if (useOfficial(c)) {
    const r = await connectOfficial(c);
    if (r.reason !== "official_auth") return r;
    // The official tokens were revoked or are wrong: fall back to the web
    // session until the tokens in .env change.
    officialDead = officialKey(c);
    log(`${r.error}; falling back to the web session`);
    pageOfficialFallbackOnce(r.error);
  }
  if (!c.token || !c.cookie) return { reason: "auth", error: "missing_credentials" };
  const who = await api("auth.test");
  if (!who.ok) {
    if (SESSION_DEAD.has(who.error)) return { reason: "auth", error: who.error };
    return { reason: "error", error: `auth.test: ${who.error}` };
  }
  session.authState = "ok";
  session.selfId = who.user_id;
  session.selfName = who.user;
  session.team = who.team;
  session.teamId = who.team_id;

  let url;
  const rtm = await api("rtm.connect", { batch_presence_aware: 1 });
  if (rtm.ok && rtm.url) {
    url = rtm.url;
    session.transport = "rtm.connect";
  } else if (SESSION_DEAD.has(rtm.error)) {
    return { reason: "auth", error: rtm.error };
  } else if (AUTH_ERRORS.has(rtm.error) || rtm.error === "method_deprecated") {
    log(`rtm.connect refused (${rtm.error}); trying the web client gateway`);
    url = fallbackWsUrl(c.token, who.team_id);
    session.transport = "web-gateway";
  } else {
    return { reason: "error", error: `rtm.connect: ${rtm.error}` };
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookieHeader(c.cookie), "User-Agent": UA, Origin: "https://app.slack.com" } });
    currentWs = ws;
    let pingId = 0;
    let lastPong = Date.now();
    let opened = 0;
    const interval = Math.max(10, Number(config().ping_interval_s) || DEFAULTS.ping_interval_s);
    const pinger = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > interval * 3 * 1000) {
        log("no pong in 3 intervals; reconnecting");
        try { ws.close(); } catch {}
        return;
      }
      try { ws.send(JSON.stringify({ id: ++pingId, type: "ping" })); } catch {}
    }, interval * 1000);

    ws.addEventListener("open", () => { opened = Date.now(); });
    ws.addEventListener("message", (msg) => {
      let ev;
      try { ev = JSON.parse(typeof msg.data === "string" ? msg.data : Buffer.from(msg.data).toString("utf8")); } catch { return; }
      lastPong = Date.now();
      if (ev.type === "hello") {
        session.connected = true;
        session.connectedSince = new Date().toISOString();
        log(`connected via ${session.transport} as ${session.selfId} team=${session.teamId}`);
        clearAuthAlert();
      } else if (ev.type === "goodbye") {
        log("server said goodbye; reconnecting");
        try { ws.close(); } catch {}
      } else if (ev.type === "error") {
        log(`rtm error: ${JSON.stringify(ev.error || ev).slice(0, 200)}`);
      } else if (ev.type !== "pong" && ev.reply_to === undefined) {
        onRtmEvent(ev);
      }
    });
    ws.addEventListener("error", (e) => log(`websocket error: ${e.message || e.error?.message || "unknown"}`));
    ws.addEventListener("close", (e) => {
      clearInterval(pinger);
      session.connected = false;
      currentWs = null;
      const lived = opened ? (Date.now() - opened) / 1000 : 0;
      log(`websocket closed code=${e.code} after ${lived.toFixed(0)}s`);
      resolve({ reason: "closed", lived });
    });
  });
}

// Sleep up to `seconds`, waking early when the token or cookie in .env changes
// (a fresh slack-session-capture), so a re-capture lands within a minute.
async function sleepUntilCredsChange(seconds) {
  const before = JSON.stringify(creds());
  const until = Date.now() + seconds * 1000;
  while (!stopping && Date.now() < until) {
    await sleep(Math.min(60, Math.max(1, (until - Date.now()) / 1000)));
    if (JSON.stringify(creds()) !== before) { log("credentials changed; retrying now"); return; }
  }
}

async function runLoop() {
  let attempt = 0;
  while (!stopping) {
    let r;
    try { r = await connectOnce(); } catch (err) { r = { reason: "error", error: err.message }; }
    if (stopping) break;
    if (r.reason === "auth") {
      session.authState = r.error === "missing_credentials" ? "missing" : "invalid";
      log(`auth failure (${r.error}); backing off ${config().auth_backoff_s}s`);
      pageAuthOnce(r.error);
      await sleepUntilCredsChange(Number(config().auth_backoff_s) || DEFAULTS.auth_backoff_s);
      attempt = 0;
      continue;
    }
    if (r.reason === "closed" && r.lived > 60) attempt = 0;
    attempt++;
    session.reconnects++;
    const wait = backoffSeconds(attempt, Number(config().max_backoff_s) || DEFAULTS.max_backoff_s);
    if (r.error) log(`connect failed: ${r.error}`);
    log(`reconnecting in ${wait.toFixed(1)}s (attempt ${attempt})`);
    await sleep(wait);
  }
}

// ── HTTP (localhost only) ───────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); reject(new Error("body too large")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: session.connected, port: PORT, transport: session.transport, auth: session.authState,
        self_id: session.selfId, self_name: session.selfName, team: session.team, team_id: session.teamId,
        connected_since: session.connectedSince, last_event_at: session.lastEventAt, reconnects: session.reconnects,
      });
    }
    if (req.method === "GET" && url.pathname === "/conversations") {
      const list = await listConversations({ fresh: url.searchParams.has("fresh") });
      return json(res, 200, { ok: true, conversations: list });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      let p;
      try { p = JSON.parse(await readBody(req)); } catch (err) { return json(res, 400, { ok: false, error: `bad json: ${err.message}` }); }
      if (!p.channel && !p.user) return json(res, 400, { ok: false, error: "missing 'channel' or 'user'" });
      if (!p.text || !String(p.text).trim()) return json(res, 400, { ok: false, error: "missing 'text'" });
      if (session.authState !== "ok") return json(res, 503, { ok: false, error: `slack session ${session.authState}` });
      let channelId;
      try { channelId = await resolveSendChannel(p); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      const r = await api("chat.postMessage", { channel: channelId, text: p.text, thread_ts: p.thread_ts || undefined });
      if (!r.ok) { log(`send failed: ${r.error}`); return json(res, 502, { ok: false, error: r.error }); }
      sentTs.set(r.ts, Date.now());
      for (const [ts, at] of sentTs) if (Date.now() - at > 600e3) sentTs.delete(ts);
      const ch = await channelInfo(r.channel);
      const row = {
        ts: new Date().toISOString(), kind: "sent", source: "runner", channel_id: r.channel,
        channel_name: ch.name, channel_type: ch.type, user_id: session.selfId, user_name: session.selfName,
        from_me: true, reason: null, slack_ts: r.ts, thread_ts: p.thread_ts || null, text: p.text,
        originating_task: p.originating_task || null,
      };
      if (!p.logged_by_caller) appendJsonl(INBOX, row);
      log(`sent ch=${r.channel} ts=${r.ts}`);
      return json(res, 200, { ok: true, ts: r.ts, channel: r.channel, channel_name: ch.name, channel_type: ch.type, user_id: session.selfId, user_name: session.selfName });
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    log(`http ${url.pathname} error: ${err.message}`);
    json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => log(`HTTP on 127.0.0.1:${PORT}`));

function shutdown(signal) {
  log(`${signal} received, shutting down`);
  stopping = true;
  server.close();
  try { currentWs?.close(); } catch {}
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

runLoop().catch((err) => {
  log(`fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
