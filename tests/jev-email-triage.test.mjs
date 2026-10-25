// jev-email-triage — Jev primary / legacy shadow for inbound email triage.
// Stubs global fetch (Jev), the Gmail body fetch, email-mem and local-classify;
// isolates every Jev file under a temp dir via the JEV_* env overrides.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jev-email-"));
process.env.JEV_CONFIG_FILE = path.join(TMP, "jev-config.json");
process.env.JEV_QUESTIONS_DIR = path.join(TMP, "q");
process.env.JEV_SHADOW_DIR = path.join(TMP, "shadow");
process.env.JEV_EXCLUDE_SENDERS_FILE = path.join(TMP, "exclude.json");
// The local triage rules are the installation's; this test brings its own: one
// content rule, the medical-subject one healthExcluded() reads.
process.env.LOCAL_TRIAGE_RULES_FILE = path.join(TMP, "local-triage-rules.json");
fs.writeFileSync(process.env.LOCAL_TRIAGE_RULES_FILE, JSON.stringify({ rules: [{ id: "medical-subject", subject: "test results|lab results|care team", label: "personal", priority: "P1", escalate: true, reason: "medical subject" }] }));
process.env.JEV_NO_ALERT = "1";
process.env.TYPESAFE_API_KEY = "test-key";
process.env.JEV_PRIVATE_SCREEN = "off"; // the content screen has its own test below
fs.mkdirSync(process.env.JEV_QUESTIONS_DIR, { recursive: true });
fs.copyFileSync(new URL("../agent/config/jev-questions/email-triage.json", import.meta.url), path.join(process.env.JEV_QUESTIONS_DIR, "email-triage.json"));
fs.writeFileSync(process.env.JEV_EXCLUDE_SENDERS_FILE, JSON.stringify({ senders: [{ domain: "patientportal.example" }, { contains: "labresults" }, { domain: "examplebank.example", category: "financial" }] }));

function setConfig(over = {}) {
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {}, ...over }));
}

let lib, calls;
// The needs-the-user question key is needs_<owner_id> (lib/instance.cjs).
const NEEDS = `needs_${createRequire(import.meta.url)("../lib/instance.cjs").instance().owner_id}`;
function stubJev(label, priority, { lp = 0.97, pp = 0.96, needs = 0.05 } = {}) {
  calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "jev-latest");
    assert.equal(body.providerOptions, undefined);
    assert.ok(body.questions.label && body.questions.priority && body.questions[NEEDS]);
    const answers = {
      label: { type: "choice", choice: label, probabilities: { [label]: lp } },
      priority: { type: "choice", choice: priority, probabilities: { [priority]: pp } },
      [NEEDS]: { type: "boolean", probability: needs },
    };
    return new Response(JSON.stringify({ answers, providerMetadata: { gateway: { cost: "0.00001" } } }), { status: 200 });
  };
}
const readLines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const daily = () => fs.readdirSync(process.env.JEV_SHADOW_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).flatMap((f) => readLines(path.join(process.env.JEV_SHADOW_DIR, f)));
const reset = () => fs.rmSync(process.env.JEV_SHADOW_DIR, { recursive: true, force: true });

function deps(localVerdict, extra = {}) {
  const d = { spawned: [], localCalls: 0 };
  return Object.assign(d, {
    classifyEmail: async () => { d.localCalls++; return localVerdict; },
    fetchBody: async () => "Your order has shipped.",
    senderHistory: async () => "#1: triaged abc P3 vendor",
    spawnSonnetShadow: (x) => d.spawned.push(x),
    ...extra,
  });
}
const E = { messageId: "fake-msg-e01", from: "Shop <orders@shop.example>", subject: "Your order shipped" };

before(async () => { lib = await import("../lib/jev-email-triage.mjs"); });

test("confident Jev P3 auto-handles; agrees with local P3 → no Sonnet shadow", async () => {
  reset(); setConfig(); stubJev("vendor", "P3");
  const d = deps({ label: "vendor", priority: "P3", escalate: false, source: "rule:x" });
  const r = await lib.classifyInbound(E, d);
  assert.deepEqual([r.auto, r.via, r.label, r.priority], [true, "jev", "vendor", "P3"]);
  assert.equal(d.spawned.length, 0);
  assert.equal(d.localCalls, 1, "legacy memoised: one local-classify per email");
  const rows = daily();
  assert.equal(rows.length, 1); assert.equal(rows[0].used, "jev"); assert.equal(rows[0].agree, true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.JEV_SHADOW_DIR, "window.json"), "utf8")).shadow_until, "first success starts the shadow window");
});

test("Jev P3 vs local non-escalated P3 with a different label → disagreement", async () => {
  reset(); setConfig(); stubJev("personal", "P3");
  const r = await lib.classifyInbound(E, deps({ label: "vendor", priority: "P3", escalate: false }));
  assert.equal(r.via, "jev");
  const dis = readLines(path.join(process.env.JEV_SHADOW_DIR, "disagreements.jsonl"));
  assert.equal(dis.length, 1); assert.equal(dis[0].site, "email-triage");
});

test("Jev auto-handles where local would have escalated → detached Sonnet shadow", async () => {
  reset(); setConfig(); stubJev("vendor", "P3");
  const d = deps({ escalate: true, label: null, priority: null });
  const r = await lib.classifyInbound(E, d);
  assert.equal(r.auto, true);
  assert.equal(d.spawned.length, 1);
  assert.equal(d.spawned[0].jev.label, "vendor");
  assert.equal(daily()[0].deferred, true, "escalated local is deferred, not a disagreement");
  assert.equal(daily()[0].agree, undefined);
  assert.equal(readLines(lib.PENDING_FILE)[0].compare, "sonnet-shadow");
});

test("Jev P1 → dispatch, pending row for reconcile; local P3 recorded as disagreement", async () => {
  reset(); setConfig(); stubJev("personal", "P1", { needs: 0.9 });
  const r = await lib.classifyInbound(E, deps({ label: "vendor", priority: "P3", escalate: false }));
  assert.deepEqual([r.auto, r.via], [false, "dispatch"]);
  assert.equal(readLines(lib.PENDING_FILE)[0].compare, "reconcile");
  assert.equal(readLines(path.join(process.env.JEV_SHADOW_DIR, "disagreements.jsonl")).length, 1);
});

test("the needs-the-user key is needs_<owner_id>: needs_user by default", async () => {
  assert.equal(lib.NEEDS_KEY, NEEDS);
  const { spawnSync } = await import("node:child_process");
  const keyWith = (inst) => {
    const dir = fs.mkdtempSync(path.join(TMP, "local-"));
    if (inst) fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify(inst));
    const env = { ...process.env, EDVA_LOCAL_DIR: dir };
    delete env.EDVA_OWNER_ID; delete env.EDVA_OWNER_NAME;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(new URL("../lib/jev-email-triage.mjs", import.meta.url).href)}); process.stdout.write(m.NEEDS_KEY);`], { env, encoding: "utf8" });
    return r.stdout;
  };
  assert.equal(keyWith(null), "needs_user");
  assert.equal(keyWith({ owner_name: "Alex" }), "needs_alex");
  assert.equal(keyWith({ owner_name: "Alex", owner_id: "legacy" }), "needs_legacy");
});

test("Jev P3 but needs-the-user → not auto-handled", async () => {
  reset(); setConfig(); stubJev("personal", "P3", { needs: 0.8 });
  const r = await lib.classifyInbound(E, deps({ escalate: true }));
  assert.equal(r.auto, false);
});

// ── never-auto-handle rules apply to Jev too ──────────────────────────────
// local-triage marks a message escalate:true when TRIAGING it has a side effect
// only the ops agent performs (the calendar event for a booking, the P1 stamp
// on a lab result). Jev's auto gate computed `auto` from its own answers
// alone and bypassed all of them. The gate can only ever withhold an
// auto-handle, so these pin both directions.

test("a confident Jev P3 is NOT auto-handled when a local rule says escalate", async () => {
  reset(); setConfig(); stubJev("personal", "P3", { needs: 0.04 });
  const d = deps({ escalate: true }, { applyRules: () => ({ escalate: true, source: "rule:reservation-platform", label: "personal", priority: "P2" }) });
  const r = await lib.classifyInbound({ ...E, from: "Bookings <reservations@booking.example>", subject: "Your reservation is confirmed" }, d);
  assert.deepEqual([r.auto, r.via], [false, "dispatch"], "the side effect must reach the agent");
  assert.equal(readLines(lib.PENDING_FILE)[0].withheld_by, "rule:reservation-platform", "the pending row records why");
});

test("the escalate gate sees the BODY, not just from/subject", async () => {
  reset(); setConfig(); stubJev("personal", "P3", { needs: 0.04 });
  let seen = null;
  const d = deps({ escalate: true }, { applyRules: (e) => { seen = e; return e.body?.includes("heater is broken") ? { escalate: true, source: "rule:report-problem" } : null; } });
  const r = await lib.classifyInbound(E, Object.assign(d, { fetchBody: async () => "A customer says the heater is broken." }));
  assert.equal(seen.body, "A customer says the heater is broken.", "body is passed to applyRules");
  assert.equal(r.auto, false);
});

test("the gate only WITHHOLDS: a non-escalating rule never creates an auto-handle", async () => {
  reset(); setConfig(); stubJev("personal", "P1", { needs: 0.04 });
  const d = deps({ escalate: false, label: "personal", priority: "P3" }, { applyRules: () => ({ escalate: false, source: "rule:x" }) });
  const r = await lib.classifyInbound(E, d);
  assert.equal(r.auto, false, "P1 still dispatches; the rule cannot promote it");
});

test("no matching rule → auto-handle is unchanged", async () => {
  reset(); setConfig(); stubJev("vendor", "P3");
  const d = deps({ label: "vendor", priority: "P3", escalate: false, source: "rule:x" }, { applyRules: () => null });
  const r = await lib.classifyInbound(E, d);
  assert.deepEqual([r.auto, r.via], [true, "jev"]);
  assert.equal(readLines(lib.PENDING_FILE)[0].withheld_by, undefined);
});

test("low confidence → legacy verdict acted on (local P3 still auto-handles)", async () => {
  reset(); setConfig(); stubJev("vendor", "P3", { lp: 0.6 });
  const r = await lib.classifyInbound(E, deps({ label: "vendor", priority: "P3", escalate: false, source: "mem-consensus" }));
  assert.deepEqual([r.auto, r.via, r.reason], [true, "local", "jev-low-confidence"]);
});

test("low-confidence Jev P1/P2 vetoes a legacy consensus auto-P3 → dispatch", async () => {
  for (const [prio, opts] of [["P2", { pp: 0.67 }], ["P1", { pp: 0.6 }], ["P3", { pp: 0.6, needs: 0.95 }]]) {
    reset(); setConfig(); stubJev("personal", prio, opts);
    const r = await lib.classifyInbound(E, deps({ label: "personal", priority: "P3", escalate: false, source: "mem-consensus" }));
    assert.deepEqual([r.auto, r.via], [false, "dispatch"], `${prio} needs=${opts.needs ?? 0.05}`);
  }
});

test("low-confidence Jev label that differs from the legacy label withholds the auto-P3 → dispatch", async () => {
  // A promo Jev correctly reads as vendor/P3/no-ask, but under the bar, while a
  // domain-spanning consensus says personal: the consensus must not file it.
  reset(); setConfig(); stubJev("vendor", "P3", { lp: 0.67, needs: 0.15 });
  const r = await lib.classifyInbound(E, deps({ label: "personal", priority: "P3", escalate: false, source: "mem-consensus" }));
  assert.deepEqual([r.auto, r.via], [false, "dispatch"]);
  // Same label under the bar still auto-files on the legacy verdict.
  reset(); setConfig(); stubJev("vendor", "P3", { lp: 0.67, needs: 0.15 });
  const r2 = await lib.classifyInbound(E, deps({ label: "vendor", priority: "P3", escalate: false, source: "mem-consensus" }));
  assert.deepEqual([r2.auto, r2.via, r2.label], [true, "local", "vendor"]);
});

test("low confidence + local escalated → dispatch + reconcile row for calibration", async () => {
  reset(); setConfig(); stubJev("vendor", "P2", { pp: 0.5 });
  const r = await lib.classifyInbound(E, deps({ escalate: true }));
  assert.equal(r.auto, false);
  const p = readLines(lib.PENDING_FILE)[0];
  assert.equal(p.jev_used, false); assert.equal(p.compare, "reconcile");
});

test("Jev HTTP error → legacy", async () => {
  reset(); setConfig();
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  const r = await lib.classifyInbound(E, deps({ label: "spam", priority: "P3", escalate: false }));
  assert.deepEqual([r.auto, r.via, r.reason], [true, "local", "jev-error"]);
});

test("health sender never reaches Jev", async () => {
  reset(); setConfig(); stubJev("personal", "P3");
  const r = await lib.classifyInbound({ ...E, from: "Care <noreply@patientportal.example>" }, deps({ escalate: true }));
  assert.equal(calls, 0); assert.equal(r.auto, false);
  assert.equal(daily()[0].reason, "health-excluded");
  const r2 = await lib.classifyInbound({ ...E, from: "x@labresults-center.example" }, deps({ escalate: true }));
  assert.equal(calls, 0); assert.equal(r2.reason, "health-excluded");
});

test("medical-subject rule excludes an unlisted provider", () => {
  assert.equal(lib.healthExcluded({ from: "a@newclinic.example", subject: "Your lab results are ready" }), "health:rule:medical-subject");
  assert.equal(lib.healthExcluded({ from: "a@shop.example", subject: "Order shipped" }), null);
});

test("outside the shadow window: no legacy run on a confident Jev decision", async () => {
  reset(); setConfig({ shadow_until: new Date(Date.now() - 1000).toISOString() }); stubJev("vendor", "P3");
  const d = deps({ escalate: true });
  const r = await lib.classifyInbound(E, d);
  assert.equal(r.via, "jev"); assert.equal(d.localCalls, 0); assert.equal(d.spawned.length, 0);
});

test("site disabled → pure legacy, Jev not called", async () => {
  reset(); setConfig({ sites: { "email-triage": { enabled: false } } }); stubJev("vendor", "P3");
  const r = await lib.classifyInbound(E, deps({ label: "vendor", priority: "P3", escalate: false }));
  assert.equal(calls, 0); assert.equal(r.via, "local");
});

test("Sonnet shadow records a late comparison", async () => {
  reset(); setConfig();
  const v = await lib.runSonnetShadow({ ...E, jev: { label: "vendor", priority: "P3", confidence: 0.95 } },
    { fetchBody: async () => "b", runClaude: async (p) => { assert.match(p, /CLASSIFY-ONLY/); return 'Sure: {"label":"personal","priority":"P2"}'; } });
  assert.equal(v.label, "personal");
  const rows = daily(); assert.equal(rows[0].late, true); assert.equal(rows[0].agree, false);
  assert.equal(readLines(path.join(process.env.JEV_SHADOW_DIR, "disagreements.jsonl")).length, 1);
});

test("extractBody prefers text/plain, strips html otherwise", () => {
  const enc = (s) => Buffer.from(s).toString("base64url");
  assert.equal(lib.extractBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: enc("<b>hi</b>") } }, { mimeType: "text/plain", body: { data: enc("plain hi") } }] }), "plain hi");
  assert.equal(lib.extractBody({ mimeType: "text/html", body: { data: enc("<p>Hello&nbsp;<b>there</b></p>") } }), "Hello there");
});

test("financial sender never reaches Jev; legacy verdict and input withheld from the log", async () => {
  reset(); setConfig(); stubJev("personal", "P3");
  const r = await lib.classifyInbound({ ...E, from: "Example Bank <alerts@ealerts.examplebank.example>", subject: "Large purchase $2,400" }, deps({ escalate: true }));
  assert.equal(calls, 0); assert.equal(r.auto, false); assert.equal(r.reason, "financial-excluded");
  const row = daily()[0];
  assert.equal(row.reason, "financial-excluded");
  assert.equal(row.input, "[withheld]");
  assert.doesNotMatch(JSON.stringify(row), /2,400/);
});

test("content screen fails closed: unlisted sender, screen can't clear it → legacy, no Jev", async () => {
  reset(); setConfig(); stubJev("personal", "P3");
  process.env.JEV_PRIVATE_SCREEN = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/")) throw new Error("ECONNREFUSED (test: no ollama)");
    return realFetch(url, init);
  };
  try {
    const r = await lib.classifyInbound(E, deps({ escalate: true }));
    assert.equal(calls, 0, "Jev not called");
    assert.equal(r.auto, false);
    assert.match(daily()[0].reason, /^sensitive-excluded/);
  } finally { process.env.JEV_PRIVATE_SCREEN = "off"; globalThis.fetch = realFetch; }
});

// --- withConsensus: the PAST DECISIONS line must be sender-anchored and honest -----
// Regression guard: email-mem's
// searchForEmail ranks on subject words as heavily as on the sender, so a sender with
// no history at all gets five strangers' decisions back. Asserting one of those as
// "consistently label=X" is wrong twice over: local-classify auto-files the mail on it
// at confidence 1, and the question file tells Jev that line IS the answer.

const HIST_OTHER = "3 matching memories:\n"
  + "  #1: Triaged abc — Voice service (voice-noreply@voice.example) number expiry notice. P3 personal, label + mark read.\n"
  + "  #2: Pat Doe (pat@engineer.example) offered to talk it through. P1 personal, star.\n"
  + "  #3: Jazz club marketing newsletter — vendor P3.";
const HIST_OWN = "2 matching memories:\n"
  + "  #1: Shop order-shipped mail from orders@shop.example — P3 vendor, label + mark read.\n"
  + "  #2: orders@shop.example delivery notice — P3 vendor, label + mark read.";

test("withConsensus: no retrieved memory names the sender → no consensus, and it says so", () => {
  const head = lib.withConsensus(HIST_OTHER, "Newapp <updates@email.newapp.example>").split("\n")[0];
  assert.match(head, /none\. The decisions below are about OTHER senders/);
  assert.doesNotMatch(head, /consistently label=/, "a stranger's verdict must never be replayed as this sender's pattern");
});

test("withConsensus: the sender's own history still yields a consensus", () => {
  const head = lib.withConsensus(HIST_OWN, "Shop <orders@shop.example>").split("\n")[0];
  assert.match(head, /consistently label=vendor, priority=P3/);
});

test("withConsensus: an excerpt cut off before any verdict is reported as cut off, not as mixed", () => {
  const head = lib.withConsensus("1 matching memory:\n  #1: Example Bank servicing pattern is locked (#5308 ToS upd", "Example Bank <communications@servicing.examplebank.example>").split("\n")[0];
  assert.match(head, /none visible .*cut off/);
  assert.doesNotMatch(head, /mixed labels/, "'we could not see far enough' is not 'mixed'");
});

test("withConsensus: a genuinely mixed sender history still reads as mixed", () => {
  const mixed = "2 matching memories:\n  #1: orders@shop.example receipt — P3 vendor.\n  #2: orders@shop.example account question — P3 personal.";
  const head = lib.withConsensus(mixed, "Shop <orders@shop.example>").split("\n")[0];
  assert.match(head, /no consistent label \(mixed labels/);
});

// --- the 600-char budget must not be what decides whether a verdict exists --------
// Regression guard: the sender's own past verdict sat a few characters past
// the cut, so withConsensus told Jev "nothing can be concluded"
// and Jev judged the body instead — vendor, for mail the agent had twice filed as
// personal. Passing the untruncated text lets the extraction see past the cut; the
// prose Jev reads is still 600 characters.

// #1 runs 620 characters before reaching its verdict; #2 is a stranger's P1.
const LONG_OWN = "2 matching memories:\n"
  + "  #1: Triaged abc — Corner Bookshop (contact@cornerbookshop.example) occasional-marketing blast. "
  + "x".repeat(520) + " P3 personal: label + mark read.\n"
  + "  #2: Pat Doe (pat@engineer.example) offered to talk it through. P1 personal, star.";

test("withConsensus: a verdict just past the 600-char cut is found in the full text", () => {
  const cut = LONG_OWN.slice(0, 600);
  const from = "Corner Bookshop <contact@cornerbookshop.example>";
  assert.match(lib.withConsensus(cut, from).split("\n")[0], /none visible .*cut off/,
    "precondition: the truncated excerpt alone shows no verdict");
  assert.match(lib.withConsensus(cut, from, LONG_OWN).split("\n")[0], /consistently label=personal, priority=P3/);
});

test("withConsensus: the widened extraction is scoped to the sender's own records", () => {
  // The stranger's P1 in #2 would veto the consensus if the whole text were read.
  // Only #1 names the sender, so the veto must not fire — and the sender's own P1
  // still must (second assertion).
  const cut = LONG_OWN.slice(0, 600);
  assert.ok(lib.withConsensus(cut, "Corner Bookshop <contact@cornerbookshop.example>", LONG_OWN).startsWith("PAST DECISIONS BY THE AGENT FOR THIS SENDER/TOPIC: consistently"));
  const ownP1 = "2 matching memories:\n  #1: contact@cornerbookshop.example blast. " + "x".repeat(560) + " P3 personal.\n"
    + "  #2: contact@cornerbookshop.example wrote about a refund — P1 personal, star.";
  assert.match(lib.withConsensus(ownP1.slice(0, 600), "Corner Bookshop <contact@cornerbookshop.example>", ownP1).split("\n")[0],
    /no consistent label \(mixed labels, or some were P1\/P2\)/);
});

test("withConsensus: a cut-off excerpt whose full text names no other record of the sender stays honest", () => {
  const full = "1 matching memory:\n  #1: Voice service (voice-noreply@voice.example) number expiry. " + "x".repeat(560) + " P3 personal.";
  const head = lib.withConsensus(full.slice(0, 600), "Newapp <updates@email.newapp.example>", full).split("\n")[0];
  assert.match(head, /none\. The decisions below are about OTHER senders/);
  assert.doesNotMatch(head, /consistently label=/);
});

test("withConsensus: without the full text, behaviour is byte-identical to before", () => {
  const cut = LONG_OWN.slice(0, 600);
  assert.equal(lib.withConsensus(cut, "Corner Bookshop <contact@cornerbookshop.example>"),
               lib.withConsensus(cut, "Corner Bookshop <contact@cornerbookshop.example>", ""));
});

test("withConsensus: a consensus already visible in the excerpt is never widened away", () => {
  // HIST_OWN yields vendor/P3 from the excerpt alone. Appending a stranger's P1 to
  // the full text must not change it — the retry only runs on "no-verdicts".
  const full = HIST_OWN + "\n  #3: Pat Doe (pat@engineer.example) — P1 personal, star.";
  assert.equal(lib.withConsensus(HIST_OWN, "Shop <orders@shop.example>", full),
               lib.withConsensus(HIST_OWN, "Shop <orders@shop.example>"));
});

// ── a curated spam fingerprint settles before Jev ─────────────────────────
// A rotating-domain scam matched its fingerprint rule at confidence 1, but its
// fake verification-code body pushed Jev's needs-the-user answer up and the
// sub-threshold veto dispatched it instead of filing it.

const LIFE_OFFER_SCAM = { messageId: "fake-msg-b01", from: "rotatingname <Reply@rotating-domain.example>", subject: "Welcome  to your  life offer  rotatingname" };

test("a curated spam fingerprint is filed as spam without asking Jev, so its veto cannot fire", async () => {
  reset(); setConfig(); stubJev("spam", "P3", { lp: 0.6, needs: 0.95 });
  // The fingerprint rule itself is per-install data (data/local-triage-rules.json); inject it.
  const fp = { label: "spam", priority: "P3", escalate: false, source: "rule:spam-life-offer" };
  const d = deps(fp, { applyRules: () => fp });
  const r = await lib.classifyInbound(LIFE_OFFER_SCAM, d);
  assert.deepEqual([r.auto, r.label, r.priority, r.via, r.source], [true, "spam", "P3", "local", "rule:spam-life-offer"]);
  assert.equal(calls, 0, "Jev is not called");
  assert.equal(d.localCalls, 0, "nor the legacy classifier");
});

test("only a non-escalating rule whose verdict is spam short-circuits", async () => {
  for (const ruled of [{ label: "vendor", priority: "P3", escalate: false, source: "rule:newsletter" }, { label: "spam", priority: "P3", escalate: true, source: "rule:x" }, { label: "spam", priority: "P3", escalate: false, source: "mem-consensus" }]) {
    reset(); setConfig(); stubJev("personal", "P2", { needs: 0.9 });
    const r = await lib.classifyInbound(E, deps({ escalate: true }, { applyRules: () => ruled }));
    assert.equal(r.auto, false, JSON.stringify(ruled));
    assert.equal(calls, 1, "Jev still decides");
  }
});

test("a listed P1 sender is never short-circuited to spam", async () => {
  reset(); setConfig(); stubJev("personal", "P1", { needs: 0.9 });
  const d = deps({ escalate: true }, {
    applyP1Senders: () => ({ priority: "P1", escalate: true, source: "p1-sender:x" }),
    applyRules: () => ({ label: "spam", priority: "P3", escalate: false, source: "rule:spam-x" }),
  });
  const r = await lib.classifyInbound(E, d);
  assert.equal(r.auto, false);
  assert.equal(calls, 1);
});

// --- a first-contact sender on a consumer mailbox is never auto-filed by Jev ------
// Regression guard: filler spam from a random gmail address (pasted text, the
// pitch in an image) read to Jev as a person — personal 0.95 / spam 0.00 — and
// was filed with no agent turn. Same blind spot on every free-mail junk message
// in the shadow window, so the class goes to the ops agent.

const STRANGER = { messageId: "fake-msg-b02", from: "Pat Random <random12345@gmail.com>", subject: "Re: handout" }; // kernel-guard-ok: a made-up free-mail sender; the rule under test keys on the consumer domain

test("a confident Jev P3 from a first-contact free-mail sender is withheld → dispatch", async () => {
  reset(); setConfig(); stubJev("personal", "P3", { needs: 0.41 });
  const r = await lib.classifyInbound(STRANGER, deps({ escalate: true }, { firstContact: () => true, applyRules: () => null }));
  assert.deepEqual([r.auto, r.via], [false, "dispatch"]);
  assert.equal(readLines(lib.PENDING_FILE)[0].withheld_by, "first-contact-free-mail");
});

test("the first-contact gate only WITHHOLDS: a known sender is auto-filed as before", async () => {
  reset(); setConfig(); stubJev("personal", "P3", { needs: 0.05 });
  const r = await lib.classifyInbound(STRANGER, deps({ escalate: true }, { firstContact: () => false, applyRules: () => null }));
  assert.deepEqual([r.auto, r.via], [true, "jev"]);
  assert.equal(readLines(lib.PENDING_FILE)[0].withheld_by, undefined);
});

test("first contact is decided from the address, never from the gmail.com domain", async () => {
  const lt = await import("../lib/local-triage.mjs");
  const none = { senderConsensus: () => ({ enough: false, n: 0 }) };
  const OTHERS = "2 matching memories:\n"
    + "  #1: Triaged 19e6 - Airline (no-reply@info.airline.example to OWNER@gmail.com) boarding pass. P2 personal, star.\n"
    + "  #2: Marketplace chat (sender@messages.marketplace.example) - P3 vendor.";
  assert.equal(lt.isFreeMailSender(STRANGER.from), true);
  assert.equal(lt.isFreeMailSender("Shop <orders@shop.example>"), false);
  assert.equal(lt.namesSender(OTHERS, STRANGER.from), false, "OWNER@gmail.com is not random12345@gmail.com"); // kernel-guard-ok: made-up free-mail addresses
  assert.equal(lt.senderKnown(STRANGER.from, OTHERS, { deps: { triageDecisions: none } }), false);
  assert.equal(lt.senderKnown(STRANGER.from, OTHERS + "\n  #3: random12345@gmail.com reply - P3 personal.", { deps: { triageDecisions: none } }), true); // kernel-guard-ok: a made-up free-mail sender
  assert.equal(lt.senderKnown(STRANGER.from, OTHERS, { deps: { triageDecisions: { senderConsensus: () => ({ enough: false, n: 1 }) } } }), true, "one agent-decided message is enough to be known");
  assert.equal(lt.namesSender("  #1: billing@mail.shop.example receipt - P3 vendor.", "Shop <orders@shop.example>"), true, "a company domain still anchors");
});

test("withConsensus: a gmail stranger is told the decisions are other senders', not 'mixed'", () => {
  const hist = "2 matching memories:\n"
    + "  #1: Triaged 19e6 - Airline (no-reply@info.airline.example to OWNER@gmail.com) boarding pass. P2 personal, star.\n"
    + "  #2: Marketplace chat (sender@messages.marketplace.example) - P3 vendor.";
  const head = lib.withConsensus(hist, STRANGER.from).split("\n")[0];
  assert.match(head, /none\. The decisions below are about OTHER senders/);
});
