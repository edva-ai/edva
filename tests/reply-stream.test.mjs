import { test } from "node:test";
import assert from "node:assert/strict";
import { partialJsonStringField, ReplyDraftTracker, displayableDraft, REPLY_TOOL_NAME } from "../lib/reply-stream.mjs";

test("partialJsonStringField decodes a cut-off string", () => {
  assert.equal(partialJsonStringField('{"message": "Hello\\nwor', "message"), "Hello\nwor");
  assert.equal(partialJsonStringField('{"mess', "message"), null);
  assert.equal(partialJsonStringField('{"message": ', "message"), null);
  assert.equal(partialJsonStringField('{"message": "a\\', "message"), "a");
  assert.equal(partialJsonStringField('{"message": "caf\\u00e9 \\u00', "message"), "café ");
});

test("partialJsonStringField finds the field after other keys", () => {
  const j = '{"summary": "x, \\"y\\"", "time_sensitive": false, "message": "Hi there';
  assert.equal(partialJsonStringField(j, "message"), "Hi there");
  assert.equal(partialJsonStringField('{"summary": "abc', "message"), null);
});

test("partialJsonStringField handles a complete object", () => {
  const full = JSON.stringify({ message: 'He said "ok"\tthen 🎉 left', summary: "s" });
  assert.equal(partialJsonStringField(full, "message"), 'He said "ok"\tthen 🎉 left');
  // Every prefix decodes to a prefix of the final text.
  for (let k = 0; k <= full.length; k++) {
    const v = partialJsonStringField(full.slice(0, k), "message");
    if (v != null) assert.ok('He said "ok"\tthen 🎉 left'.startsWith(v), `prefix ${k}: ${v}`);
  }
});

const se = (event) => ({ type: "stream_event", event });

test("ReplyDraftTracker accumulates only the reply tool, per tool_use id", () => {
  const t = new ReplyDraftTracker();
  assert.equal(t.observe({ type: "assistant" }), false);
  t.observe(se({ type: "message_start" }));
  t.observe(se({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
  t.observe(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: REPLY_TOOL_NAME } }));
  t.observe(se({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "Bash" } }));
  t.observe(se({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"ls' } }));
  t.observe(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"message": "Hel' } }));
  assert.deepEqual(t.snapshot(), [{ id: "toolu_a", text: "Hel", done: false }]);
  t.observe(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'lo"}' } }));
  t.observe(se({ type: "content_block_stop", index: 1 }));
  assert.deepEqual(t.snapshot(), [{ id: "toolu_a", text: "Hello", done: true }]);
  // A second API message reuses block indexes; it must not append to the first draft.
  t.observe(se({ type: "message_start" }));
  t.observe(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_c", name: REPLY_TOOL_NAME } }));
  t.observe(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"message": "Second' } }));
  assert.deepEqual(t.snapshot().map((d) => [d.id, d.text]), [["toolu_a", "Hello"], ["toolu_c", "Second"]]);
  t.reset();
  assert.deepEqual(t.snapshot(), []);
});

test("displayableDraft hides a half word and unclosed markers", () => {
  assert.equal(displayableDraft("The show is on Net"), "The show is on");
  assert.equal(displayableDraft("Watch **Northern Lights tonight"), "Watch");
  assert.equal(displayableDraft("Watch **Northern Lights** tonight on"), "Watch **Northern Lights** tonight");
  assert.equal(displayableDraft("Run `edva hum x"), "Run");
  assert.equal(displayableDraft("Here:\n```\nls -la\nmore"), "Here:");
  assert.equal(displayableDraft("Done:\n```\nls\n```\nthen `x` and more"), "Done:\n```\nls\n```\nthen `x` and");
  assert.equal(displayableDraft(""), "");
});
