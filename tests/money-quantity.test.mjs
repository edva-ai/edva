// money-quantity.test.mjs — memory sources carry the KIND of money they state.
// A question like "what is the stock portfolio worth?" can be answered from
// summary emails, an accounts page and a contract page at once — three
// incompatible quantities. Run: node --test tests/money-quantity.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-quantity-"));
fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
process.env.MEMORY_INDEX_DIR = path.join(dir, "memory");
process.env.MEMORY_INDEX_DB = path.join(dir, "memory-index.db");
process.env.MEMORY_DB_AUTHORITATIVE = "1";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
const MANIFEST = path.join(dir, "sources.json");
fs.writeFileSync(MANIFEST, JSON.stringify({
  wiki: { reference_option_grant: ["equity_terms"], reference_accounts: ["net_worth", "brokerage_holdings"] },
  inbox: [{ sender: "agent@example.com", subject_prefix: "Totals report", quantity: ["net_worth"] }],
}));
process.env.MONEY_QUANTITY_SOURCES = MANIFEST;

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ws = require(path.resolve("lib/wiki-store.js"));
const mq = await import(path.resolve("lib/money-quantity.mjs"));
const { recall } = await import(path.resolve("lib/unified-recall.mjs"));
const { autoRecallBlock } = await import(path.resolve("lib/auto-recall.mjs"));
const { indexMessage } = await import(path.resolve("lib/inbox-mem.mjs"));

before(() => {
  ws.savePage("reference_option_grant",
    "---\nname: Option grant\ndescription: employee option grant equity stock vesting\ntype: reference\n---\nEmployee stock options, a fraction of the company fully diluted, vesting, portfolio of terms.\n", { editedBy: "test" });
  ws.savePage("reference_accounts",
    "---\nname: Accounts\ndescription: what we own and what it is worth\ntype: reference\n---\nBrokerco stock portfolio and net worth totals, refreshed live.\n", { editedBy: "test" });
  ws.savePage("brokerage_note",
    "---\nname: Brokerage note\ndescription: stock portfolio holdings\ntype: reference\nquantity: brokerage_holdings\n---\nStock portfolio holdings at Brokerco, market value worth.\n", { editedBy: "test" });
  indexMessage({ id: "m1", ts: "2030-03-01T12:00:00Z", sender: "Agent <agent@example.com>",
    subject: "Totals report — March 2030: $987,654", text: "Totals report net worth stock portfolio worth" });
});
after(() => { try { ws.closeDb(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

test("normalizeQuantity keeps only known types, accepts string or array", () => {
  assert.deepEqual(mq.normalizeQuantity("net_worth"), ["net_worth"]);
  assert.deepEqual(mq.normalizeQuantity(["income", "bogus", "income"]), ["income"]);
  assert.equal(mq.normalizeQuantity("bogus"), null);
  assert.equal(mq.normalizeQuantity(null), null);
});

test("a page's own frontmatter tag wins; the manifest tags the rest; untagged is null", () => {
  assert.deepEqual(mq.wikiQuantity("brokerage_note"), ["brokerage_holdings"]);
  assert.deepEqual(mq.wikiQuantity("reference_option_grant"), ["equity_terms"]);
  assert.equal(mq.wikiQuantity("no_such_page"), null);
});

test("inbox: sender address + the agent's own subject template, never body text", () => {
  assert.deepEqual(mq.inboxQuantity({ sender: "Agent <agent@example.com>", subject: "Totals report — March 2030: $0.9M" }), ["net_worth"]);
  assert.equal(mq.inboxQuantity({ sender: "someone@else.com", subject: "Totals report — spoof" }), null);
  assert.equal(mq.inboxQuantity({ sender: "agent@example.com", subject: "Re: what is in my totals report" }), null);
});

test("preferQuantity: matching first, untagged kept, other quantities dropped", () => {
  const rows = [
    { id: "nw", quantity: ["net_worth"] }, { id: "u", quantity: null },
    { id: "bh", quantity: ["brokerage_holdings"] }, { id: "acc", quantity: ["net_worth", "brokerage_holdings"] },
    { id: "eq", quantity: ["equity_terms"] },
  ];
  assert.deepEqual(mq.preferQuantity(rows, "brokerage_holdings").map((r) => r.id), ["bh", "acc", "u"]);
  assert.equal(mq.preferQuantity(rows, null), rows);
});

test("mixedQuantities flags tags with nothing in common, ignores finance_context", () => {
  assert.deepEqual(mq.mixedQuantities([{ quantity: ["net_worth"] }, { quantity: ["equity_terms"] }]), ["equity_terms", "net_worth"]);
  assert.equal(mq.mixedQuantities([{ quantity: ["net_worth", "brokerage_holdings"] }, { quantity: ["brokerage_holdings"] }]), null);
  assert.equal(mq.mixedQuantities([{ quantity: ["net_worth"] }, { quantity: ["finance_context"] }, { quantity: null }]), null);
});

test("recall rows carry their tag; quantity= drops sources stating a different quantity", async () => {
  const all = await recall("stock portfolio worth", { chat: false, replies: false, wikiMatch: "or", k: 10 });
  const byKey = Object.fromEntries(all.results.map((r) => [`${r.source}:${r.id}`, r.quantity]));
  assert.deepEqual(byKey["wiki:reference_option_grant"], ["equity_terms"]);
  assert.deepEqual(byKey["inbox:m1"], ["net_worth"]);

  const asked = await recall("stock portfolio worth", { chat: false, replies: false, wikiMatch: "or", k: 10, quantity: "brokerage_holdings" });
  const ids = asked.results.map((r) => r.id);
  assert.ok(ids.includes("brokerage_note"), "the holdings source survives");
  assert.ok(ids.includes("reference_accounts"), "a multi-quantity page that includes it survives");
  assert.ok(!ids.includes("reference_option_grant"), "equity terms dropped");
  assert.ok(!ids.includes("m1"), "the totals email dropped");
});

test("the <recall> block shows each tag and warns when the kept set mixes quantities", async () => {
  const block = await autoRecallBlock("stock portfolio worth vesting", { judge: false, minBm25: 0 });
  assert.match(block, /quantity: equity_terms/);
  assert.match(block, /quantity: net_worth/);
  assert.match(block, /WARNING: these notes state DIFFERENT kinds of money/);
});
