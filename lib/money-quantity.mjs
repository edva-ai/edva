// money-quantity.mjs — which KIND of money a memory source answers.
//
// THE PROBLEM. Sources that all talk about money can answer different
// questions: a periodic summary email (a grand total of everything owned), an
// accounts page (several totals at once), and a contract (equity PERCENTAGES)
// are three incompatible quantities that share words like "portfolio", "worth"
// and "stock". Ranked together by similarity, with nothing saying they answer
// different questions, they blend into a wrong figure.
//
// THE DESIGN: TAG each source once with the quantity
// it states, so every consumer can tell them apart — retrieval can prefer the
// asked quantity, and an answer can refuse to blend a net worth figure with a
// holdings figure. Tags are EXPLICIT METADATA (data/money-quantity-
// sources.json, or a page's own `quantity:` frontmatter), assigned by a person
// or a model once, never by pattern-matching text at query time (Rule #0b).
// Deciding WHICH quantity a question asks for is language, so a model does it:
// the auto-recall judge (lib/auto-recall.mjs) sees each candidate's tag,
// and a caller that already knows (a finance job) passes `quantity` to recall().
//
// A source with no tag is simply untagged — not "not money". Filtering only
// ever removes a row tagged with a DIFFERENT quantity; untagged rows pass.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { installTools } from "./root.cjs";
const require = createRequire(import.meta.url);

// The quantity kinds and the one-line description a tagging prompt shows for
// each. An installation may reword a description (e.g. name its own brokers)
// in agent/local/config/money-quantity.json `descriptions` — the set of
// kinds and their order stay the kernel's.
const BASE_QUANTITY_TYPES = {
  net_worth: "total across everything owned, minus debts",
  brokerage_holdings: "market value of public securities in brokerage/retirement accounts — 'the stock portfolio'",
  private_holdings: "private company stakes, marked at the latest valuation",
  cash_balances: "bank and money-market cash",
  property_value: "real-estate values",
  liabilities: "debts, card balances, mortgages",
  equity_terms: "ownership percentages, vesting and grant TERMS in a contract — not a dollar holding",
  income: "salary and other income",
  spending: "expenses and subscriptions",
  portfolio_targets: "target weights and rebalance plans — what the portfolio SHOULD hold, not what it is worth",
  plan_projection: "long-term plans and projections — dated snapshots, not live figures",
  finance_context: "about money but states no figure to answer from (routing, process, credentials, decisions)",
};
const LOCAL_DESCRIPTIONS = require("./instance.cjs").localConfig("money-quantity", { descriptions: {} }).descriptions || {};
export const QUANTITY_TYPES = Object.fromEntries(
  Object.entries(BASE_QUANTITY_TYPES).map(([k, v]) => [k, typeof LOCAL_DESCRIPTIONS[k] === "string" ? LOCAL_DESCRIPTIONS[k] : v]),
);

const SOURCES_FILE = process.env.MONEY_QUANTITY_SOURCES
  || installTools("data/money-quantity-sources.json");

let _manifest = null;
function manifest() {
  if (_manifest) return _manifest;
  try { _manifest = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")) || {}; } catch { _manifest = {}; }
  return _manifest;
}
/** Test seam: drop the cached manifest. */
export function _resetManifest() { _manifest = null; }

/** Normalize a tag value (string or array) to a sorted array of known types, or null. */
export function normalizeQuantity(v) {
  const list = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
  const out = [...new Set(list.map((x) => String(x).trim()).filter((x) => x in QUANTITY_TYPES))].sort();
  return out.length ? out : null;
}

let _ws = null;
function wikiStore() {
  if (_ws === false) return null;
  try { _ws ||= require("./wiki-store.js"); return _ws; } catch { _ws = false; return null; }
}

/** A wiki page's quantity: its own frontmatter first, else the manifest. */
export function wikiQuantity(id) {
  try {
    const row = wikiStore()?.getPage(id);
    const fm = row ? JSON.parse(row.frontmatter_json || "{}") : {};
    const own = normalizeQuantity(fm.quantity);
    if (own) return own;
  } catch {}
  return normalizeQuantity(manifest().wiki?.[id]);
}

/** An indexed email's quantity, from the manifest's sender + subject-template rules. */
export function inboxQuantity({ sender = "", subject = "" } = {}) {
  const from = String(sender).toLowerCase();
  const subj = String(subject).trim();
  for (const rule of manifest().inbox || []) {
    if (!rule?.sender || !rule?.subject_prefix) continue;
    if (from.includes(String(rule.sender).toLowerCase()) && subj.startsWith(rule.subject_prefix)) {
      return normalizeQuantity(rule.quantity);
    }
  }
  return null;
}

/**
 * Prefer rows that answer `asked`: rows tagged with the asked quantity first,
 * untagged rows after them, rows tagged ONLY with other quantities dropped.
 * Order within each group is preserved. No `asked` → rows unchanged.
 */
export function preferQuantity(rows, asked) {
  const want = normalizeQuantity(asked);
  if (!want) return rows;
  const match = [], untagged = [];
  for (const r of rows || []) {
    const q = r?.quantity;
    if (!q || !q.length) untagged.push(r);
    else if (q.some((t) => want.includes(t))) match.push(r);
  }
  return [...match, ...untagged];
}

/**
 * Does this set mix incompatible quantities? Considers rows tagged with at
 * least one real quantity (finance_context states no figure, so it is ignored).
 * Mixed = two or more such rows with NO quantity common to all of them — e.g.
 * a net worth email next to an equity-terms page. Returns the sorted union of
 * their types when mixed, else null. Code reads tags here, never text.
 */
export function mixedQuantities(rows) {
  const sets = [];
  for (const r of rows || []) {
    const q = (r?.quantity || []).filter((t) => t !== "finance_context");
    if (q.length) sets.push(q);
  }
  if (sets.length < 2) return null;
  const common = sets.reduce((acc, s) => acc.filter((t) => s.includes(t)));
  if (common.length) return null;
  return [...new Set(sets.flat())].sort();
}
