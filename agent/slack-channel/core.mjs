// core.mjs: the pure pieces of the Slack channel, shared by the runner
// (index.mjs), the send CLI (bin/slack-send) and their tests. No I/O here.
//
// The channel holds the user's own logged-in Slack web session (an `xoxc-`
// client token plus the browser's `d` cookie). Every decision below is made on
// Slack's machine-generated structure (event types, subtypes, ids, `<@U…>`
// mention markup), never on what a message says.

export const DEFAULTS = {
  port: 9108,
  api_base: "https://slack.com/api",
  // The web client's websocket gateway, used only when rtm.connect refuses the token.
  ws_gateway: "wss://wss-primary.slack.com", // kernel-guard-ok: Slack's public gateway host, not a workspace
  // Slack user ids whose DMs to the user, or mentions of the user, push to the
  // chat channel. Empty = nothing ever pushes; everything is still logged.
  always_push_users: [],
  // Which of an always_push_users sender's messages push: "im" (1:1 DM),
  // "mpim" (group DM), "mention" (a <@user> mention of the user anywhere).
  push_on: ["im", "mention"],
  // Channel ids that never push (still logged).
  block_channels: [],
  // What the importance judge (lib/message-alert.mjs) holds ordinary
  // channel traffic to, i.e. a channel message that does not @-mention the
  // user (DMs, group DMs and @-mentions always get the standard rubric):
  //   "named-or-major"  ping only when a model reads it as calling the user by
  //                     name or as a really major issue
  //   "standard"        the same urgent / important rubric as a DM
  channel_alerts: "named-or-major",
  ping_interval_s: 30,
  max_backoff_s: 300,
  // After invalid_auth / not_authed the runner sleeps this long before trying
  // again (the session must be re-captured; hammering Slack would not help).
  auth_backoff_s: 6 * 3600,
};

export const AUTH_ERRORS = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired",
  "no_permission", "missing_scope", "not_allowed_token_type",
]);
// Of those, the ones that mean "this session is dead, re-capture it".
export const SESSION_DEAD = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"]);

// Subtypes of a normal message that can push. Everything else (joins, topic
// changes, bot posts, etc.) is logged but never pushed.
const PUSHABLE_SUBTYPES = new Set([undefined, "", "thread_broadcast", "file_share", "me_message"]);

// The `d` cookie as Chrome stores it is already URL-encoded (xoxd-…%2F…). A
// value pasted in decoded form is encoded here so the header is valid.
export function cookieHeader(d) {
  const v = String(d || "").trim();
  if (!v) return "";
  return `d=${v.includes("%") ? v : encodeURIComponent(v)}`;
}

// KEY=VALUE lines (same subset lib/load-env.js reads), as an object.
export function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

// Replace or append KEY=VALUE lines in a .env text, keeping everything else.
export function upsertEnv(text, values) {
  const lines = String(text || "").split("\n");
  const done = new Set();
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    const key = t.slice(0, t.indexOf("=")).trim();
    if (key in values) { done.add(key); return `${key}=${values[key]}`; }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

export function backoffSeconds(attempt, max = DEFAULTS.max_backoff_s) {
  const base = Math.min(max, 2 ** Math.max(0, attempt - 1));
  return Math.min(max, base + Math.random() * Math.min(5, base));
}

// Conversation type from a conversations.info `channel` object, else from the
// id's prefix (D = 1:1 DM; C/G are refined by the info when there is one).
export function channelTypeOf(info, id = "") {
  if (info) {
    if (info.is_im) return "im";
    if (info.is_mpim) return "mpim";
    if (info.is_private || info.is_group) return "private";
    if (info.is_channel || info.is_general) return "channel";
  }
  if (id.startsWith("D")) return "im";
  if (id.startsWith("G")) return "private";
  if (id.startsWith("C")) return "channel";
  return null;
}

// The user ids a message mentions, from Slack's `<@U…>` markup and from rich
// text blocks. Structure Slack generates, not the user's words.
export function mentionedUserIds(text, blocks) {
  const ids = new Set();
  const s = String(text || "");
  let i = s.indexOf("<@");
  while (i !== -1) {
    const end = s.indexOf(">", i);
    if (end === -1) break;
    const id = s.slice(i + 2, end).split("|")[0];
    if (id) ids.add(id);
    i = s.indexOf("<@", end);
  }
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === "user" && node.user_id) ids.add(node.user_id);
    if (node.elements) walk(node.elements);
  };
  walk(blocks);
  return [...ids];
}

// Replace `<@U…>` markup with `@name` for display (push bodies, the reader).
export function renderMentions(text, nameOf = () => null) {
  const s = String(text || "");
  let out = "";
  let pos = 0;
  let i = s.indexOf("<@");
  while (i !== -1) {
    const end = s.indexOf(">", i);
    if (end === -1) break;
    const [id, label] = s.slice(i + 2, end).split("|");
    out += s.slice(pos, i) + "@" + (label || nameOf(id) || id);
    pos = end + 1;
    i = s.indexOf("<@", pos);
  }
  return out + s.slice(pos);
}

function filesSuffix(files) {
  if (!Array.isArray(files) || !files.length) return "";
  return files.map((f) => `[file: ${f.name || f.title || "file"}]`).join(" ");
}

function joinText(text, files) {
  const t = String(text || "");
  const f = filesSuffix(files);
  return t && f ? `${t} ${f}` : t || f;
}

// eventToEntry(event, ctx) → one slack-inbox.jsonl row, or null when the event
// is not a message worth recording.
//   ctx.selfId     the user's own Slack id
//   ctx.channel    { name, type } for event.channel (already resolved)
//   ctx.userName   display name for the author (already resolved), or null
//   ctx.now        Date (tests)
export function eventToEntry(ev, ctx = {}) {
  if (!ev || ev.type !== "message") return null;
  const selfId = ctx.selfId || null;
  const now = (ctx.now || new Date()).toISOString();
  const base = {
    ts: now,
    source: "rtm",
    channel_id: ev.channel || null,
    channel_name: ctx.channel?.name || null,
    channel_type: ctx.channel?.type || channelTypeOf(null, ev.channel || ""),
  };

  if (ev.subtype === "message_changed") {
    const m = ev.message || {};
    const prev = ev.previous_message || {};
    // An unfurl or reaction-count refresh re-sends the message unchanged.
    if ((m.text || "") === (prev.text || "") && !m.files) return null;
    const userId = m.user || prev.user || null;
    return {
      ...base,
      kind: "edit",
      user_id: userId,
      user_name: ctx.userName || null,
      from_me: !!selfId && userId === selfId,
      reason: null,
      slack_ts: m.ts || null,
      thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null,
      text: joinText(m.text, m.files),
      previous_text: prev.text || null,
    };
  }
  if (ev.subtype === "message_deleted") {
    const prev = ev.previous_message || {};
    const userId = prev.user || null;
    return {
      ...base,
      kind: "delete",
      user_id: userId,
      user_name: ctx.userName || null,
      from_me: !!selfId && userId === selfId,
      reason: null,
      slack_ts: ev.deleted_ts || prev.ts || null,
      thread_ts: prev.thread_ts && prev.thread_ts !== prev.ts ? prev.thread_ts : null,
      text: prev.text || "",
    };
  }
  // Thread-parent bookkeeping (reply counts) and any other hidden update.
  if (ev.subtype === "message_replied" || ev.hidden) return null;

  const userId = ev.user || ev.bot_id || null;
  const fromMe = !!selfId && ev.user === selfId;
  const type = base.channel_type;
  let reason = null;
  if (!fromMe) {
    if (type === "im") reason = "dm";
    else if (type === "mpim") reason = "mpim";
    if (selfId && mentionedUserIds(ev.text, ev.blocks).includes(selfId)) reason = "mention";
  }
  const entry = {
    ...base,
    kind: "message",
    user_id: userId,
    user_name: ctx.userName || ev.username || ev.bot_profile?.name || null,
    from_me: fromMe,
    reason,
    slack_ts: ev.ts || null,
    thread_ts: ev.thread_ts && ev.thread_ts !== ev.ts ? ev.thread_ts : null,
    text: joinText(ev.text, ev.files),
  };
  if (ev.subtype) entry.subtype = ev.subtype;
  return entry;
}

// classifyForPush(entry, config) → { push, reason }. Config-driven only:
// who sent it (always_push_users) and where (DM / mention), never its words.
export function classifyForPush(entry, config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config };
  if (!entry || entry.kind !== "message") return { push: false, reason: `kind:${entry?.kind}` };
  if (entry.from_me) return { push: false, reason: "from-me" };
  if (!PUSHABLE_SUBTYPES.has(entry.subtype)) return { push: false, reason: `subtype:${entry.subtype}` };
  if ((c.block_channels || []).includes(entry.channel_id)) return { push: false, reason: "block-channels" };
  if (!(c.always_push_users || []).includes(entry.user_id)) return { push: false, reason: "not-always-push-user" };
  const on = new Set(c.push_on || []);
  if (entry.reason === "mention" && on.has("mention")) return { push: true, reason: "always-push-user:mention" };
  if (entry.channel_type === "im" && on.has("im")) return { push: true, reason: "always-push-user:im" };
  if (entry.channel_type === "mpim" && on.has("mpim")) return { push: true, reason: "always-push-user:mpim" };
  return { push: false, reason: "always-push-user:not-dm-or-mention" };
}

// Who a message is addressed to, for the importance judge: "direct" (a 1:1 or
// group DM), "mention" (Slack's `<@user>` markup names the user) or "channel"
// (ordinary channel traffic). Structure only; whether the words call the user
// by name is the judge's call, never a string match here.
export function alertAudience(entry) {
  if (entry?.channel_type === "im" || entry?.channel_type === "mpim") return "direct";
  if (entry?.reason === "mention") return "mention";
  return "channel";
}

// The names the user goes by in the workspace (display name, real name,
// handle), deduped case-insensitively, for the judge to recognise them by.
//   user    a name-cache entry { name, handles }, or null
//   handle  auth.test's `user` (the login handle), or null
export function selfNames(user, handle) {
  const out = [];
  const seen = new Set();
  for (const n of [user?.name, ...(user?.handles || []), handle]) {
    const s = String(n || "").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

export function pushBody(entry, renderedText) {
  const who = entry.user_name || entry.user_id || "someone";
  const where = entry.channel_type === "im" ? ""
    : entry.channel_type === "mpim" ? " (group DM)"
    : ` (in #${entry.channel_name || entry.channel_id})`;
  const thread = entry.thread_ts ? " [thread]" : "";
  return `Slack from ${who}${where}${thread}: ${String(renderedText ?? entry.text ?? "").slice(0, 280)}`;
}

// ── send side ───────────────────────────────────────────────────────────────

function isId(s, firstLetters) {
  if (s.length < 7 || !firstLetters.includes(s[0])) return false;
  for (const ch of s) if (!((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"))) return false;
  return true;
}

// parseTarget("#general" | "@jane" | "C0123ABC" | "U0123ABC") →
//   { channel } | { channel_name } | { user } | { user_name } | null
export function parseTarget(to) {
  const s = String(to || "").trim();
  if (!s) return null;
  if (s.startsWith("#") && s.length > 1) return { channel_name: s.slice(1).toLowerCase() };
  if (s.startsWith("@") && s.length > 1) return { user_name: s.slice(1).toLowerCase() };
  if (isId(s, "CGD")) return { channel: s };
  if (isId(s, "UW")) return { user: s };
  return null;
}

// parseSendArgs(argv without node + script) → options, or { error }.
export function parseSendArgs(argv, readFile = null) {
  const a = { to: null, text: null, thread: null, list: false, health: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    try {
      if (k === "--to") a.to = need();
      else if (k === "--text") a.text = need();
      else if (k === "--text-file") {
        const p = need();
        if (!readFile) return { error: "--text-file not supported here" };
        a.text = readFile(p);
      } else if (k === "--thread") a.thread = need();
      else if (k === "--list") a.list = true;
      else if (k === "--health") a.health = true;
      else if (k === "--json") a.json = true;
      else if (k === "-h" || k === "--help") a.help = true;
      else return { error: `unknown flag: ${k}` };
    } catch (err) {
      return { error: err.message };
    }
  }
  if (a.help || a.list || a.health) return a;
  if (!a.to) return { error: "missing --to" };
  if (!a.text || !a.text.trim()) return { error: "missing --text" };
  if (!parseTarget(a.to)) return { error: `--to must be #channel, @user, or a Slack id (C…/G…/D…/U…): ${a.to}` };
  if (a.thread && !isThreadTs(a.thread)) return { error: `--thread must be a Slack ts like 1712345678.123456: ${a.thread}` };
  return a;
}

function isThreadTs(s) {
  const parts = String(s).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return [...parts[0], ...parts[1]].every((ch) => ch >= "0" && ch <= "9");
}

// The em/en dash gate: messages on Slack go out as the user, to other people,
// so (like gmail-action's third-party path) dashes are refused. Returns a short
// excerpt around the first dash, or null when there is none.
export function findDash(text) {
  const s = String(text || "");
  let i = -1;
  for (const d of ["—", "–"]) {
    const j = s.indexOf(d);
    if (j !== -1 && (i === -1 || j < i)) i = j;
  }
  if (i === -1) return null;
  return s.slice(Math.max(0, i - 40), i + 41);
}

// The name a users.info / users.list member shows as.
export function userDisplayName(u) {
  if (!u) return null;
  const p = u.profile || {};
  return p.display_name || p.real_name || u.real_name || u.name || null;
}

// The names a member can be addressed by with `@name` (lowercased).
export function userHandles(u) {
  const p = u?.profile || {};
  return [u?.name, p.display_name, p.display_name_normalized, p.real_name, p.real_name_normalized, u?.real_name]
    .filter(Boolean).map((s) => String(s).toLowerCase());
}
