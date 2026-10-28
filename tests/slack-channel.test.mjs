// slack-channel — the pure pieces: an RTM event → slack-inbox.jsonl row, the
// config-only push policy, slack-send's argument parsing and its dash gate,
// and the .env helpers the capture script writes with. No network, no runner:
// the CLI tests point SLACK_RUNNER_URL at a closed port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  eventToEntry, classifyForPush, parseTarget, parseSendArgs, findDash, mentionedUserIds,
  renderMentions, channelTypeOf, cookieHeader, parseEnv, upsertEnv, pushBody, DEFAULTS,
  alertAudience, selfNames,
} from "../agent/slack-channel/core.mjs";

const SELF = "U0SELF0001";
const OTHER = "U0OTHER001";
const now = new Date("2026-01-02T03:04:05.000Z");
const im = { name: "Jane Doe", type: "im" };
const chan = { name: "general", type: "channel" };

test("plain DM → message row with the old reader's fields", () => {
  const e = eventToEntry({ type: "message", channel: "D0DM000001", user: OTHER, text: "hi there", ts: "1700000000.000100" },
    { selfId: SELF, channel: im, userName: "Jane Doe", now });
  assert.deepEqual(e, {
    ts: now.toISOString(), source: "rtm", channel_id: "D0DM000001", channel_name: "Jane Doe", channel_type: "im",
    kind: "message", user_id: OTHER, user_name: "Jane Doe", from_me: false, reason: "dm",
    slack_ts: "1700000000.000100", thread_ts: null, text: "hi there",
  });
});

test("thread reply keeps thread_ts; a thread parent does not", () => {
  const reply = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: "r", ts: "2.0", thread_ts: "1.0" }, { selfId: SELF, channel: chan });
  assert.equal(reply.thread_ts, "1.0");
  const parent = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: "p", ts: "1.0", thread_ts: "1.0" }, { selfId: SELF, channel: chan });
  assert.equal(parent.thread_ts, null);
});

test("own message → from_me, no reason", () => {
  const e = eventToEntry({ type: "message", channel: "D0DM000001", user: SELF, text: "mine", ts: "3.0" }, { selfId: SELF, channel: im });
  assert.equal(e.from_me, true);
  assert.equal(e.reason, null);
});

test("mention via markup or rich-text block → reason mention", () => {
  const a = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: `hey <@${SELF}> look`, ts: "4.0" }, { selfId: SELF, channel: chan });
  assert.equal(a.reason, "mention");
  const blocks = [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: SELF }] }] }];
  const b = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: "x", blocks, ts: "5.0" }, { selfId: SELF, channel: chan });
  assert.equal(b.reason, "mention");
  const c = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: "no one", ts: "6.0" }, { selfId: SELF, channel: chan });
  assert.equal(c.reason, null);
});

test("edit → kind edit with previous_text; an unchanged re-send is dropped", () => {
  const e = eventToEntry({
    type: "message", subtype: "message_changed", channel: "C0CHAN0001", hidden: true,
    message: { user: OTHER, text: "new", ts: "7.0" }, previous_message: { user: OTHER, text: "old", ts: "7.0" },
  }, { selfId: SELF, channel: chan });
  assert.equal(e.kind, "edit");
  assert.equal(e.text, "new");
  assert.equal(e.previous_text, "old");
  assert.equal(e.slack_ts, "7.0");
  const same = eventToEntry({
    type: "message", subtype: "message_changed", channel: "C0CHAN0001",
    message: { user: OTHER, text: "same", ts: "8.0" }, previous_message: { user: OTHER, text: "same", ts: "8.0" },
  }, { selfId: SELF, channel: chan });
  assert.equal(same, null);
});

test("delete → kind delete; message_replied and other hidden events dropped; non-messages dropped", () => {
  const d = eventToEntry({ type: "message", subtype: "message_deleted", channel: "C0CHAN0001", deleted_ts: "9.0", previous_message: { user: OTHER, text: "gone", ts: "9.0" } }, { selfId: SELF, channel: chan });
  assert.equal(d.kind, "delete");
  assert.equal(d.slack_ts, "9.0");
  assert.equal(eventToEntry({ type: "message", subtype: "message_replied", channel: "C0CHAN0001" }, {}), null);
  assert.equal(eventToEntry({ type: "message", hidden: true, channel: "C0CHAN0001" }, {}), null);
  assert.equal(eventToEntry({ type: "presence_change" }, {}), null);
});

test("files and bot posts", () => {
  const f = eventToEntry({ type: "message", subtype: "file_share", channel: "C0CHAN0001", user: OTHER, text: "see", files: [{ name: "a.pdf" }], ts: "10.0" }, { selfId: SELF, channel: chan });
  assert.equal(f.text, "see [file: a.pdf]");
  assert.equal(f.subtype, "file_share");
  const b = eventToEntry({ type: "message", subtype: "bot_message", channel: "C0CHAN0001", bot_id: "B0BOT00001", username: "CI", text: "built", ts: "11.0" }, { selfId: SELF, channel: chan });
  assert.equal(b.user_id, "B0BOT00001");
  assert.equal(b.user_name, "CI");
});

test("channel type from info, else from the id prefix", () => {
  assert.equal(channelTypeOf({ is_im: true }), "im");
  assert.equal(channelTypeOf({ is_mpim: true, is_private: true }), "mpim");
  assert.equal(channelTypeOf({ is_channel: true, is_private: true }), "private");
  assert.equal(channelTypeOf({ is_channel: true }), "channel");
  assert.equal(channelTypeOf(null, "D123"), "im");
  assert.equal(channelTypeOf(null, "C123"), "channel");
});

test("push policy: nothing by default; always_push_users push on DM and mention only", () => {
  const dm = eventToEntry({ type: "message", channel: "D0DM000001", user: OTHER, text: "hi", ts: "1.0" }, { selfId: SELF, channel: im });
  const mention = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: `<@${SELF}>`, ts: "2.0" }, { selfId: SELF, channel: chan });
  const plain = eventToEntry({ type: "message", channel: "C0CHAN0001", user: OTHER, text: "hi all", ts: "3.0" }, { selfId: SELF, channel: chan });
  const group = eventToEntry({ type: "message", channel: "G0MPIM0001", user: OTHER, text: "hi", ts: "4.0" }, { selfId: SELF, channel: { name: "mpdm", type: "mpim" } });
  assert.equal(classifyForPush(dm, DEFAULTS).push, false);
  assert.equal(classifyForPush(mention, DEFAULTS).push, false);
  const cfg = { ...DEFAULTS, always_push_users: [OTHER] };
  assert.deepEqual(classifyForPush(dm, cfg), { push: true, reason: "always-push-user:im" });
  assert.deepEqual(classifyForPush(mention, cfg), { push: true, reason: "always-push-user:mention" });
  assert.equal(classifyForPush(plain, cfg).push, false);
  assert.equal(classifyForPush(group, cfg).push, false);
  assert.equal(classifyForPush(group, { ...cfg, push_on: ["mpim"] }).push, true);
  assert.equal(classifyForPush(mention, { ...cfg, block_channels: ["C0CHAN0001"] }).push, false);
  const own = eventToEntry({ type: "message", channel: "D0DM000001", user: SELF, text: "x", ts: "5.0" }, { selfId: SELF, channel: im });
  assert.equal(classifyForPush(own, { ...cfg, always_push_users: [SELF] }).push, false);
  const edit = eventToEntry({ type: "message", subtype: "message_changed", channel: "D0DM000001", message: { user: OTHER, text: "b", ts: "6.0" }, previous_message: { text: "a" } }, { selfId: SELF, channel: im });
  assert.equal(classifyForPush(edit, cfg).push, false);
  const join = eventToEntry({ type: "message", subtype: "channel_join", channel: "C0CHAN0001", user: OTHER, text: `<@${SELF}> joined`, ts: "7.0" }, { selfId: SELF, channel: chan });
  assert.equal(classifyForPush(join, cfg).push, false);
});

test("alert audience: DMs and group DMs are direct, a <@self> mention is mention, the rest is channel traffic", () => {
  const at = (channel, text, type) => eventToEntry({ type: "message", channel, user: OTHER, text, ts: "1.0" }, { selfId: SELF, channel: type });
  assert.equal(alertAudience(at("D0DM000001", "hi", im)), "direct");
  assert.equal(alertAudience(at("G0MPIM0001", "hi", { name: "mpdm", type: "mpim" })), "direct");
  assert.equal(alertAudience(at("D0DM000001", `<@${SELF}> hi`, im)), "direct");
  assert.equal(alertAudience(at("C0CHAN0001", `<@${SELF}> can you look?`, chan)), "mention");
  assert.equal(alertAudience(at("C0CHAN0001", `<@${OTHER}> can you look?`, chan)), "channel");
  assert.equal(alertAudience(at("C0CHAN0001", "deploy complete", chan)), "channel");
  assert.equal(alertAudience(at("G0PRIV0001", "hi team", { name: "ops", type: "private" })), "channel");
  assert.equal(DEFAULTS.channel_alerts, "named-or-major");
});

test("selfNames: display name, handles and login handle, deduped case-insensitively", () => {
  assert.deepEqual(selfNames({ name: "Jane Doe", handles: ["jdoe", "jane doe", "Jane Doe"] }, "jdoe"), ["Jane Doe", "jdoe"]);
  assert.deepEqual(selfNames(null, "jdoe"), ["jdoe"]);
  assert.deepEqual(selfNames(undefined, null), []);
});

test("mentions are parsed and rendered from markup", () => {
  assert.deepEqual(mentionedUserIds(`a <@${SELF}> b <@${OTHER}|jane>`), [SELF, OTHER]);
  assert.equal(renderMentions(`a <@${SELF}> b <@${OTHER}|jane>`, (id) => (id === SELF ? "me" : null)), "a @me b @jane");
  assert.equal(renderMentions("no markup"), "no markup");
  const body = pushBody({ user_name: "Jane", channel_type: "channel", channel_name: "general", text: "t" }, "hello");
  assert.equal(body, "Slack from Jane (in #general): hello");
});

test("parseTarget", () => {
  assert.deepEqual(parseTarget("#General"), { channel_name: "general" });
  assert.deepEqual(parseTarget("@jane"), { user_name: "jane" });
  assert.deepEqual(parseTarget("C0123ABCD"), { channel: "C0123ABCD" });
  assert.deepEqual(parseTarget("D0123ABCD"), { channel: "D0123ABCD" });
  assert.deepEqual(parseTarget("U0123ABCD"), { user: "U0123ABCD" });
  assert.equal(parseTarget("general"), null);
  assert.equal(parseTarget("c0123abcd"), null);
  assert.equal(parseTarget("#"), null);
});

test("parseSendArgs", () => {
  assert.deepEqual(parseSendArgs(["--to", "#general", "--text", "hi", "--thread", "1712345678.123456"]),
    { to: "#general", text: "hi", thread: "1712345678.123456", list: false, health: false, json: false, help: false });
  assert.equal(parseSendArgs(["--list"]).list, true);
  assert.equal(parseSendArgs(["--health"]).health, true);
  assert.match(parseSendArgs(["--to", "#general"]).error, /missing --text/);
  assert.match(parseSendArgs(["--text", "hi"]).error, /missing --to/);
  assert.match(parseSendArgs(["--to", "general", "--text", "hi"]).error, /--to must be/);
  assert.match(parseSendArgs(["--to", "#g", "--text", "hi", "--thread", "abc"]).error, /--thread/);
  assert.match(parseSendArgs(["--bogus"]).error, /unknown flag/);
  assert.match(parseSendArgs(["--to"]).error, /needs a value/);
  assert.equal(parseSendArgs(["--to", "@jane", "--text-file", "/x"], () => "from file").text, "from file");
});

test("findDash", () => {
  assert.equal(findDash("plain - hyphen only"), null);
  assert.ok(findDash("one — two"));
  assert.ok(findDash("one – two"));
});

test("cookie header and .env helpers", () => {
  assert.equal(cookieHeader("xoxd-abc%2Fdef"), "d=xoxd-abc%2Fdef");
  assert.equal(cookieHeader("xoxd-abc/def+"), "d=xoxd-abc%2Fdef%2B");
  assert.equal(cookieHeader(""), "");
  assert.deepEqual(parseEnv("# c\nA=1\n\nB = two=2\n"), { A: "1", B: "two=2" });
  assert.equal(upsertEnv("# head\nA=1\nB=2\n", { B: "3", C: "4" }), "# head\nA=1\nB=3\nC=4\n");
  assert.equal(upsertEnv("", { A: "1" }), "A=1\n");
});

// ── the CLI's dash gate (refuses before contacting the runner) ──────────────
const BIN = new URL("../bin/slack-send", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-send-"));
function send(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: tmp, EDVA_HOME: tmp, SLACK_RUNNER_URL: "http://127.0.0.1:9", ...env },
    encoding: "utf8",
  });
}

test("slack-send refuses em/en dashes; SLACK_ALLOW_DASHES lets it through to the send", () => {
  const r = send(["--to", "#general", "--text", "one — two"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /em\/en dash found/);
  const ok = send(["--to", "#general", "--text", "one — two"], { SLACK_ALLOW_DASHES: "1" });
  assert.equal(ok.status, 1);
  assert.match(ok.stderr, /runner unreachable/);
  const plain = send(["--to", "@jane", "--text", "no dashes here"]);
  assert.match(plain.stderr, /runner unreachable/);
});

test("slack-send rejects bad args with exit 2", () => {
  const r = send(["--to", "general", "--text", "hi"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--to must be/);
});
