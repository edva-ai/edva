// A made-up installation (agent address, owner, time zone), the same in every checkout.
// Its one code-performed side effect (`code_tags`) is a made-up receipt scan;
// the module reads local config at load, so it is imported after the write.
import { writeLocalConfig } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
writeLocalConfig("triage-decide", {
  code_tags: [{ tag: "receipt-scan", webhook: { job: "receipt-scan", source: "receipt-email" }, help: "receipt-scan = a purchase receipt to file;" }],
});
const {
  validateDecision, planActions, dueDate, evidenceAsOf, senderName, decide, compare, cutoverReady, EDVA_SENDER, buildPrompt,
} = await import("../lib/triage-decide.mjs");

const ctx = { messageId: "fake-msg-c01", from: "Acme Legal <docs@acme-legal.example>", subject: "Contract docs", date: "Sat, 3 Oct 2026 20:05:00 +0200" };

test("validateDecision rejects bad labels/priorities and normalises tags", () => {
  assert.equal(validateDecision(null).ok, false);
  assert.equal(validateDecision({ label: "work", priority: "P1" }).ok, false);
  assert.equal(validateDecision({ label: "vendor", priority: "P4" }).ok, false);
  const r = validateDecision({ label: "vendor", priority: "P3", notify: true, task: { action: "x" }, action_tags: ["receipt-scan", "made-up"] });
  assert.equal(r.ok, true);
  assert.equal(r.decision.notify, false, "notify only for P1");
  assert.equal(r.decision.task, null, "task only for P1");
  assert.deepEqual(r.decision.action_tags, ["receipt-scan", "other-agent"], "unknown tag → other-agent, never dropped");
});

test("an intake-stamped P1 stays P1 whatever the model says", () => {
  const r = validateDecision({ label: "personal", priority: "P3" }, { stamps: ["reply-to-me-p1"], from: "a@b.com" });
  assert.equal(r.decision.priority, "P1");
});

test("Edva's own mail never gets a pointer or a task", () => {
  const r = validateDecision({ label: "personal", priority: "P1", notify: true, task: { action: "read" } }, { from: `Edva <${EDVA_SENDER}>` });
  assert.equal(r.decision.notify, false);
  assert.equal(r.decision.task, null);
});

test("planActions is the Step-5 table", () => {
  const p3 = planActions(validateDecision({ label: "vendor", priority: "P3" }).decision, ctx);
  assert.deepEqual(p3.actions.map((a) => a.argv.slice(0, 1)[0]), ["label", "mark-read"]);
  const p2 = planActions(validateDecision({ label: "personal", priority: "P2" }).decision, ctx);
  assert.deepEqual(p2.actions.map((a) => a.argv[0]), ["label", "star", "mark-read"]);
  const p1 = planActions(validateDecision({ label: "personal", priority: "P1", notify: true, task: { action: "sign the docs" } }, ctx).decision, ctx, new Date("2026-10-03T18:10:00Z"));
  const kinds = p1.actions.map((a) => a.kind === "gmail-action" ? a.argv[0] + (a.argv[2] ? ":" + a.argv[2] : "") : a.kind);
  assert.deepEqual(kinds, ["label:personal", "star", "label:p1", "notify", "p1-task"]);
  assert.ok(!kinds.includes("mark-read"), "P1 stays unread");
  const notify = p1.actions.find((a) => a.kind === "notify").argv;
  assert.deepEqual(notify.slice(0, 6), ["--intent", "p1-email", "--evidence-as-of", "2026-10-03T18:05:00.000Z", "--p1-message", "fake-msg-c01"]);
  assert.equal(notify[6], "🚨 P1 Email: Contract docs from Acme Legal");
  const task = p1.actions.find((a) => a.kind === "p1-task").argv;
  assert.equal(task[task.indexOf("--due") + 1], "2026-10-05", "Saturday non-urgent → next Monday");
  assert.equal(p1.needsAgent, false);
});

test("agent-needing tags route to the agent; a code tag stays in code", () => {
  const travel = planActions(validateDecision({ label: "personal", priority: "P3", action_tags: ["receipt-scan"] }).decision, ctx);
  assert.equal(travel.needsAgent, false);
  assert.ok(travel.actions.some((a) => a.kind === "webhook" && a.payload.job === "receipt-scan" && a.payload.source === "receipt-email"));
  assert.match(buildPrompt({}, ""), /\n  receipt-scan = a purchase receipt to file;\n/);
  const cal = planActions(validateDecision({ label: "personal", priority: "P2", action_tags: ["calendar-event"] }).decision, ctx);
  assert.equal(cal.needsAgent, true);
  assert.deepEqual(cal.agentTags, ["calendar-event"]);
});

test("dueDate: weekday today, weekend next Monday, urgent today (the installation's zone)", () => {
  assert.equal(dueDate(new Date("2026-10-05T15:00:00Z")), "2026-10-05");   // Mon
  assert.equal(dueDate(new Date("2026-10-04T15:00:00Z")), "2026-10-05");   // Sun → Mon
  assert.equal(dueDate(new Date("2026-10-03T15:00:00Z"), true), "2026-10-03"); // Sat urgent
  assert.equal(dueDate(new Date("2026-10-05T23:30:00Z")), "2026-10-05");   // Mon 23:30 local (UTC)
  // The day is the instance zone's, not UTC's: Sunday 16:00Z is already Monday in Tokyo.
  process.env.EDVA_TZ = "Asia/Tokyo";
  try {
    assert.equal(dueDate(new Date("2026-10-04T16:00:00Z")), "2026-10-05");
  } finally {
    delete process.env.EDVA_TZ;
  }
});

test("evidenceAsOf and senderName", () => {
  assert.equal(evidenceAsOf("Sat, 3 Oct 2026 20:05:00 +0200"), "2026-10-03T18:05:00.000Z");
  const now = new Date("2026-10-04T00:00:00Z");
  assert.equal(evidenceAsOf("garbage", now), now.toISOString());
  assert.equal(senderName('"Acme Billing" <billing@acme.com>'), "Acme Billing");
  assert.equal(senderName("billing@acme.com"), "billing@acme.com");
});

test("decide parses model JSON through the validator", async () => {
  const r = await decide({ from: "x@y.com", subject: "s", body: "b" }, { rulesText: "RULES", runClaude: async (p) => {
    assert.ok(p.includes("RULES") && p.includes("SUBJECT: s"));
    return 'Here you go: {"label":"vendor","priority":"P3","action_tags":[],"reason":"receipt"}';
  } });
  assert.equal(r.ok, true);
  assert.equal(r.decision.label, "vendor");
  const bad = await decide({}, { rulesText: "", runClaude: async () => "no json" });
  assert.equal(bad.ok, false);
});

test("compare + cutoverReady", () => {
  const old = new Date(Date.now() - 3600e3).toISOString();
  const rows = [
    { ts: old, messageId: "a", ok: true, decision: { label: "vendor", priority: "P3" } },
    { ts: old, messageId: "b", ok: true, decision: { label: "personal", priority: "P3" } },
    { ts: old, messageId: "c", ok: false },
  ];
  const actual = { a: { label: "vendor", priority: "P3" }, b: { label: "personal", priority: "P1", decided_by: "agent" } };
  const s = compare(rows, (id) => actual[id]);
  assert.equal(s.compared, 2);
  assert.equal(s.missed_p1, 1);
  assert.equal(s.failed, 1);
  const v = cutoverReady(s, 8);
  assert.equal(v.ready, false);
  assert.ok(v.reasons.some((r) => r.includes("missed P1")));
});

// D1: the decide step owns "does this need the user to act?". The
// prompt must ask for it, and a P1 with notify=false still gets the full P1
// Gmail state but no ping.
test("D1: notify means 'needs the user to act'; a P1 without it is starred + p1, no ping", async () => {
  const { buildPrompt } = await import("../lib/triage-decide.mjs");
  assert.match(buildPrompt({ from: "x@y.com" }, ""), /notify=true ONLY when the email needs the user to act/); // lang-regex-ok: matching our own prompt text
  const plan = planActions({ label: "personal", priority: "P1", notify: false, urgent: false, task: null, action_tags: [], reason: "receipt" },
    { messageId: "m1", from: "Example Insurance <noreply@insurer.example>", subject: "We received your request", date: "" });
  const kinds = plan.actions.map((a) => a.kind + ":" + (a.argv || []).join(" "));
  assert.ok(kinds.includes("gmail-action:star m1"));
  assert.ok(kinds.includes("gmail-action:label m1 p1"));
  assert.ok(!plan.actions.some((a) => a.kind === "notify"));
});

// The ruleset a model reads is the kernel file merged with the instance's local
// companion (lib/triage-rules.mjs loadMergedRules), read at call time.
test("loadMergedRules: TRIAGE_RULES_FILE is read as is; without it the kernel and local files are merged by heading", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { loadMergedRules } = await import("../lib/triage-rules.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-rules-merge-"));
  const kernelPath = path.join(dir, "kernel.md");
  const localPath = path.join(dir, "local.md");
  const mergedPath = path.join(dir, "merged.md");
  fs.writeFileSync(kernelPath, "# Rules\n\n### Step 5: Act\nkernel step\n\n### Shipping\nkernel ship\n");
  fs.writeFileSync(localPath, "### Shipping\nlocal ship\n\n### Local sender\nlocal only\n");
  fs.writeFileSync(mergedPath, "MERGED BY THE SUPERVISOR");
  const saved = process.env.TRIAGE_RULES_FILE;
  try {
    delete process.env.TRIAGE_RULES_FILE;
    const m = loadMergedRules({ kernelPath, localPath });
    assert.match(m, /### Shipping\nkernel ship\n\nlocal ship/, "a same-heading local section extends the kernel section");
    assert.match(m, /local ship\n\n### Local sender\nlocal only/, "a new local section follows the one before it");
    assert.equal(loadMergedRules({ kernelPath, localPath: path.join(dir, "absent.md") }), fs.readFileSync(kernelPath, "utf8"),
      "no companion: the kernel text unchanged");
    assert.throws(() => loadMergedRules({ kernelPath: path.join(dir, "absent.md"), localPath }));

    process.env.TRIAGE_RULES_FILE = mergedPath;
    assert.equal(loadMergedRules({ kernelPath, localPath }), "MERGED BY THE SUPERVISOR");
    let seen = "";
    await decide({ from: "x@y.com", subject: "s", body: "b" }, { runClaude: async (p) => { seen = p; return "{}"; } });
    assert.match(seen, /MERGED BY THE SUPERVISOR/, "decide() reads the merged ruleset at call time");
    const { sonnetPrompt } = await import("../lib/jev-email-triage.mjs");
    assert.match(sonnetPrompt({ from: "a@b.c", subject: "s", body: "b" }), /MERGED BY THE SUPERVISOR/,
      "the Jev shadow prompt reads the merged ruleset at call time");
  } finally {
    if (saved === undefined) delete process.env.TRIAGE_RULES_FILE; else process.env.TRIAGE_RULES_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
