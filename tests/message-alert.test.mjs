// message-alert: structural candidate gate, chat context from an inbox tail,
// and the ping text. The model judgment itself runs through decide().
import { SYNTHETIC } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alertCandidate, recentFromInbox, alertText, judgeInput, rubricPrompt, CHANNEL_SITE } from "../lib/message-alert.mjs";

test("alertCandidate: only others' real messages", () => {
  assert.equal(alertCandidate({ kind: "message", text: "Can you call me?", chat_id: "a" }), true);
  assert.equal(alertCandidate({ kind: "message", text: "Can you call me?", from_me: true }), false);
  assert.equal(alertCandidate({ kind: "reaction", text: "Loved it" }), false);
  assert.equal(alertCandidate({ kind: "message", text: "[image]" }), false);
  assert.equal(alertCandidate({ kind: "message", text: "hi", chat_id: "status@broadcast" }), false);
  assert.equal(alertCandidate({ kind: "message", text: "news", chat_id: "1@newsletter" }), false);
  assert.equal(alertCandidate({ kind: "message", text: "deploy done", is_bot: true }), false);
});

test("recentFromInbox: the chat's last messages, oldest first, own rows as me", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ma-")), "inbox.jsonl");
  const rows = [
    { ts: "1", chat_id: "c1", sender_name: "Alice", text: "dinner?" },
    { ts: "2", chat_id: "c2", sender_name: "Bob", text: "other chat" },
    { ts: "3", chat_id: "c1", from_me: true, text: "sure, 8pm" },
    { ts: "4", chat_id: "c1", kind: "sent", text: "booked" },
    { ts: "5", chat_id: "c1", sender_name: "Alice", text: "running late" },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = recentFromInbox(file, "chat_id", "c1", 3);
  assert.deepEqual(r.map((x) => `${x.from}:${x.text}`), ["Alice:dinner?", "me:sure, 8pm", "me:booked", "Alice:running late"]);
  assert.deepEqual(recentFromInbox(path.join(path.dirname(file), "missing.jsonl"), "chat_id", "c1"), []);
});

test("alertText names the level, channel, sender and group", () => {
  assert.equal(alertText("whatsapp", { sender_name: "Alice", is_group: true, chat_name: "Family", text: "Call me now" }, "urgent"),
    "Urgent WhatsApp from Alice (in Family): Call me now");
  assert.equal(alertText("imessage", { sender: "+15550001111", text: "Are we still on?" }, "important"),
    "Important iMessage from +15550001111: Are we still on?");
});

test("recentFromInbox: default context is RECENT_N messages", async () => {
  const { RECENT_N } = await import("../lib/message-alert.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-n-"));
  const file = path.join(dir, "inbox.jsonl");
  fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => JSON.stringify({ ts: String(i), chat_id: "g", sender_name: "a", text: `msg ${i}` })).join("\n") + "\n");
  const r = recentFromInbox(file, "chat_id", "g");
  assert.equal(RECENT_N, 10);
  assert.equal(r.length, RECENT_N + 1);
  assert.equal(r.at(-1).text, "msg 29");
});

test("judgeInput: channel traffic goes to the channel site with the owner's names; everything else to message-alert", () => {
  const message = { message_id: "1.0", chat_name: "#ops", is_group: true, sender_name: "Alice", text: "@Bob can you ship it?" };
  const recent = [{ from: "Carol", text: "morning" }, { from: "Alice", text: "@Bob can you ship it?" }];
  const std = judgeInput({ channel: "slack", message, recent });
  assert.equal(std.site, "message-alert");
  assert.equal(std.state.owner_names, undefined);
  assert.deepEqual(std.state.recent, [{ from: "Carol", text: "morning" }]);
  const ch = judgeInput({ channel: "slack", message, recent, rubric: "channel", ownerNames: ["Jane Doe", "jdoe"] });
  assert.equal(ch.site, CHANNEL_SITE);
  assert.equal(ch.site, "message-alert-channel");
  assert.deepEqual(ch.state.owner_names, ["Jane Doe", "jdoe"]);
  assert.equal(ch.state.chat, "#ops");
  assert.equal(ch.state.message.text, "@Bob can you ship it?");
});

test("the channel site's kernel rubric is on file, and the Sonnet rung reads that same wording", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../agent/config/jev-questions", `${CHANNEL_SITE}.json`);
  const def = JSON.parse(fs.readFileSync(file, "utf8").split("{{owner_name}}").join(SYNTHETIC.owner_name));
  const q = def.questions.level;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys(q.criteria).sort(), ["important", "normal", "urgent"]);
  assert.equal(JSON.stringify(def).includes("{{"), false);
  const state = judgeInput({ channel: "slack", message: { chat_name: "#ops", is_group: true, sender_name: "Alice", text: "the whole site is down" }, rubric: "channel", ownerNames: ["jdoe"] }).state;
  const prompt = rubricPrompt(CHANNEL_SITE, state, def);
  assert.ok(prompt.startsWith(`You triage incoming messages for ${SYNTHETIC.owner_name}'s personal assistant.`));
  assert.ok(prompt.includes(q.instructions));
  for (const level of ["urgent", "important", "normal"]) assert.ok(prompt.includes(`- ${level}: ${q.criteria[level]}`));
  assert.ok(prompt.includes(JSON.stringify(state)));
  assert.throws(() => rubricPrompt(CHANNEL_SITE, state, {}), /no rubric on file/);
});
