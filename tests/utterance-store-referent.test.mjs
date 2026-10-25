// utterance-store — a reply to an ideas-lane ping must name the idea it answered.
//
// Every ideas-lane reply is stored with ping_text "(idea)". Rendered as is, the
// judges read "(in reply to: (idea))" with nothing to say what was answered,
// and a reply about one errand ("it's scheduled for tomorrow, not today") was
// later cited as the user's answer about an unrelated idea. The ping's
// headline lives in hum-feedback.jsonl under the same ping_id.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUtterances, searchUtterances } from "../lib/utterance-store.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utt-idea-"));
const files = {
  responses: path.join(dir, "responses.jsonl"),
  resolved: path.join(dir, "resolved.jsonl"),
  feedback: path.join(dir, "feedback.jsonl"),
};
fs.writeFileSync(files.responses, [
  JSON.stringify({
    ts: "2026-03-05T00:30:00.000Z", ping_id: "p-boiler", lane: "ideas", subject: "(idea)",
    ping_text: "(idea)", reply_text: "it's scheduled for tomorrow, not today",
    disposition: null, source: "tapback_edva_cli",
  }),
  JSON.stringify({
    ts: "2026-03-06T10:00:00.000Z", ping_id: "p-unknown", lane: "ideas", subject: "(idea)",
    ping_text: "(idea)", reply_text: "not interested in that one", source: "tapback_edva_cli",
  }),
].join("\n") + "\n");
fs.writeFileSync(files.resolved, "");
fs.writeFileSync(files.feedback, [
  JSON.stringify({
    ping_id: "p-boiler", sent_at: "2026-03-04T19:00:00.000Z", lane: "ideas",
    findings: [{ topic: "ideas", signal: "Boiler service expected today at the workshop — forms signed and ready for the technician?" }],
  }),
  JSON.stringify({ ping_id: "p-unknown", lane: "ideas", findings: [{ signal: "(idea)" }] }),
].join("\n") + "\n");

const byText = (rows, start) => rows.find((r) => r.text.startsWith(start));

test("a placeholder ping_text is shown as the headline of the ping it answered", () => {
  const u = byText(readUtterances({ files }), "it's scheduled");
  assert.ok(u.rendered.includes("(in reply to: Boiler service expected today at the workshop"), u.rendered);
  assert.ok(!u.rendered.includes("(idea)"), u.rendered);
});

test("a placeholder with no headline on record stays as stored", () => {
  const u = byText(readUtterances({ files }), "not interested");
  assert.ok(u.rendered.endsWith("(in reply to: (idea))"), u.rendered);
});

test("search still scores the stored text, not the resolved headline", () => {
  // claim-check's Stage-2 gate reads these scores. With the headline in the
  // haystack, 29 of 383 logged hum ideas newly crossed its 0.34 floor (nearly
  // all tapbacks matching one shared word), so the headline is display-only.
  assert.deepStrictEqual(searchUtterances("boiler service workshop technician", { files }), []);
  const hits = searchUtterances("scheduled tomorrow", { files });
  assert.ok(hits[0].rendered.includes("Boiler service expected today"), "a hit found on its own words still shows its referent");
});

test("a fixture set without a feedback file reads no headlines", () => {
  const u = byText(readUtterances({ files: { responses: files.responses, resolved: files.resolved } }), "it's scheduled");
  assert.ok(u.rendered.endsWith("(in reply to: (idea))"), u.rendered);
});
