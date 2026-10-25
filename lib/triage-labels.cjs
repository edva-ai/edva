"use strict";
// triage-labels.cjs — the email-triage label taxonomy, in one place.
//
// Every triage path (local-triage, jev-email-triage, triage-decide,
// triage-decisions, p1-sender) labels mail with the same small set of labels.
// The kernel's set is generic; an installation names its own topical labels
// (a business, a project, a side venture) in
// agent/local/config/triage-labels.json:
//   labels       — the full ordered list (the order is the order prompts show);
//   descriptions — label → the short gloss the local classifier's prompt shows;
//   vendor_examples — platforms the user uses, named in the spam-vs-vendor line.
// "spam" must stay in the list: it maps to Gmail's own Spam folder.

const { localConfig } = require("./instance.cjs");

const DEFAULTS = {
  labels: ["personal", "vendor", "spam"],
  descriptions: {
    personal: "personal, tickets, family, finance",
    vendor: "SaaS/billing/status/app-store/CI",
    spam: "junk",
  },
  vendor_examples: "a ticketing site, a forum, an analytics tool, etc.",
};

function triageLabels() {
  const c = localConfig("triage-labels", DEFAULTS);
  return {
    labels: Array.isArray(c.labels) && c.labels.length ? c.labels.slice() : DEFAULTS.labels.slice(),
    descriptions: { ...DEFAULTS.descriptions, ...(c.descriptions || {}) },
    vendor_examples: c.vendor_examples || DEFAULTS.vendor_examples,
  };
}

const LABELS = Object.freeze(triageLabels().labels);

module.exports = { triageLabels, LABELS, DEFAULTS };
