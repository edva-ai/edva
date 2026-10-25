// The chat agent's context windows read edva_messages, which holds several
// channels: chat, system (infra alerts) and improvements (approval cards).
// Each window must read only the channel the inbound message came from, or
// alerts the user never saw in Chat show up in the agent's idea of the
// conversation (unscoped, about a third of messages reached the agent with
// system or improvements rows mixed in). The ack no longer reads any history:
// the status line is canned copy.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const src = fs.readFileSync(new URL("../agent/phone-channel/index.mjs", import.meta.url), "utf8");

/** The query chain assigned to `lhs`, up to the `.limit(` that ends it. */
function queryFor(lhs) {
  const start = [`const ${lhs} = await supabase`, `const ${lhs} = supabase`]
    .map((s) => src.indexOf(s))
    .find((i) => i >= 0);
  assert.ok(start !== undefined, `${lhs} query not found in phone-channel/index.mjs`);
  return src.slice(start, src.indexOf(".limit(", start));
}

const CHANNEL_SCOPE = '.eq("channel", row.channel || "chat")';

test("Recent conversation reads only the inbound message's channel", () => {
  const q = queryFor("historyP");
  assert.ok(q.includes('.from("edva_messages")'), "historyP reads edva_messages");
  assert.ok(q.includes(CHANNEL_SCOPE), "historyP is channel-scoped");
});

// The ack used to read its own history window and have a local model write a
// status line. It is now fixed copy: no model and no history read, so nothing
// can leak into it from any channel and it can never state a fact.
test("the working status line is canned copy, never a model", () => {
  const ack = src.slice(src.indexOf("async function startAck("), src.indexOf("// --- Reply streaming ---"));
  assert.ok(ack.length > 0, "startAck found");
  assert.ok(ack.includes("ACK_INITIAL_MESSAGE"), "initial ack is the canned line");
  assert.ok(ack.includes("CANNED_REFRESH_MESSAGES"), "refresh rotates canned lines");
  assert.ok(!/localLlmChat|generateAck|ackHistory/.test(ack), "no model call or history read in the ack path");
  assert.ok(!src.includes("localLlmChat"), "phone-channel no longer imports the local model");
});
