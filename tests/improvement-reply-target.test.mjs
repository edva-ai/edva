// improvement-reply-target.test.mjs — the reply_to → improvement-card join.
//
// Run: node --test tests/improvement-reply-target.test.mjs
//
// The block this builds is what stops the chat agent from answering "what does
// this change actually do?" out of a one-line summary. The assertions below pin
// the two properties that make it safe: the LIVE status wins over the anchor's
// frozen snapshot, and the agent is never told it can approve anything.

// A made-up installation (owner "the user"), the same in every checkout.
import "./synthetic-instance.mjs";
import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-key";
process.env.SUPABASE_URL ||= "https://test-project.supabase.co"; // fetch is stubbed; any base will do

const { improvementRoutingBlock, findImprovementByAnchor } =
  await import("../lib/improvement-reply-target.mjs");

const ANCHOR = "11111111-1111-1111-1111-111111111111";
const FILE = "bin/report-scan";

function stubFetch(rows) {
  return mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => rows,
  }));
}

let fetchMock;
after(() => fetchMock?.mock.restore());

describe("improvement-reply-target", () => {
  it("returns '' for a reply that isn't threaded to anything", async () => {
    assert.equal(await improvementRoutingBlock({ replyTo: null }), "");
  });

  it("returns '' when the anchor belongs to no card (an ordinary threaded reply)", async () => {
    fetchMock = stubFetch([]);
    assert.equal(await improvementRoutingBlock({ replyTo: ANCHOR }), "");
    fetchMock.mock.restore();
  });

  it("flattens item_json.files to a name list, never the file bodies", async () => {
    fetchMock = stubFetch([{
      id: "abc", item_type: "code-fix", summary: "s", status: "pending", skipped: false,
      item_json: { files: { "bin/x": "SECRET BODY", "lib/y.mjs": "more" } },
    }]);
    const row = await findImprovementByAnchor(ANCHOR);
    assert.deepEqual(row.files, ["bin/x", "lib/y.mjs"]);
    assert.equal(row.item_json, undefined, "the payload itself is not carried into the prompt");
    fetchMock.mock.restore();
  });

  it("reports the LIVE status, not whatever the anchor said when it was written", async () => {
    fetchMock = stubFetch([{
      id: "abc", item_type: "code-fix", summary: "Wire gdate into report-scan",
      status: "apply_failed", risk: "high", skipped: false,
      item_json: { files: { [FILE]: "…" } },
      result: { error: "git hook refused the commit" },
    }]);
    const block = await improvementRoutingBlock({ replyTo: ANCHOR });
    assert.match(block, /apply step failed mechanically/);
    assert.match(block, /git hook refused the commit/);
    assert.match(block, /self-improve-show abc/);
    assert.ok(block.includes(`  - ${FILE}\n`), "the file list names the changed file");
    fetchMock.mock.restore();
  });

  it("folds `skipped` back in — it is orthogonal to status, so both must show", async () => {
    fetchMock = stubFetch([{
      id: "abc", item_type: "code-fix", summary: "s", status: "pending", skipped: true,
      item_json: { files: {} },
    }]);
    const block = await improvementRoutingBlock({ replyTo: ANCHOR });
    assert.match(block, /SKIPPED by the user/); // lang-regex-ok: asserts on our own generated text (owner_name "the user")
    assert.match(block, /underlying state: waiting on the user's Face-ID approval/);
    fetchMock.mock.restore();
  });

  it("never offers the agent a way to approve or apply", async () => {
    fetchMock = stubFetch([{
      id: "abc", item_type: "new-capability", summary: "s", status: "pending", skipped: false,
      item_json: { files: { "manifest.json": "{}" } },
    }]);
    const block = await improvementRoutingBlock({ replyTo: ANCHOR });
    assert.match(block, /may NOT do: approve, sign, or apply/);
    assert.match(block, /Face ID on \S+ device only/);
    assert.doesNotMatch(block, /self-improve-request/, "no path to filing an approval from a chat reply");
    fetchMock.mock.restore();
  });

  it("is fail-soft: a broken Supabase call yields no block, not an exception", async () => {
    fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("network down"); });
    assert.equal(await improvementRoutingBlock({ replyTo: ANCHOR }), "");
    fetchMock.mock.restore();
  });
});
