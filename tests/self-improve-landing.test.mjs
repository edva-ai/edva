// self-improve-landing.test.mjs — pins the schema-v4 landing boundary: what
// lands on its own, what needs the user's Face-ID, and what nothing may touch.
// Source of truth: lib/self-improve-landing.mjs, mirrored in
// data/self-improvement-risk-rubric.md §1.0 and §2.
//
// Run: node --test tests/self-improve-landing.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// A synthetic installation: its own high-blast-radius paths come from
// agent/local/config/self-improve-landing.json (`force_high`). This
// install's real list is pinned in self-improve-landing-local.test.mjs.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "si-landing-"));
fs.mkdirSync(path.join(LOCAL, "config"));
// The sources match repo-relative paths, so they carry the kernel's directory
// (KERNEL_SUBDIR in lib/root.cjs: "tools" here, "" where the kernel is the repo root).
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");
const K = KERNEL_SUBDIR ? `${KERNEL_SUBDIR}\\/` : "";
fs.writeFileSync(path.join(LOCAL, "config", "self-improve-landing.json"), JSON.stringify({
  force_high: [`^${K}bin\\/vault-[^/]*$`, `^${K}agent\\/local\\/jobs\\/high-risk-[^/]*\\.md$`],
}));
process.env.EDVA_LOCAL_DIR = LOCAL;
test.after(() => fs.rmSync(LOCAL, { recursive: true, force: true }));
const { changedLines, composeCard, decideLanding: decide, installationRefusals, railsFor, MAX_CHANGED_LINES, MAX_FILES } = await import("../lib/self-improve-landing.mjs");
// Judged as a fresh install: no _ext/self-improve-landing.mjs hook. The hook
// contract is pinned below with synthetic hooks; this install's own hook in
// self-improve-landing-local.test.mjs.
const decideLanding = (p) => decide({ hook: null, ...p });

const safe = { risk: "low", category: "bug-fix", critic: "SAFE" };
const one = (path, content = "x\n", before = "y\n") => ({ files: { [path]: content }, before: { [path]: before } });

test("a small, safe fix in an ordinary file lands on its own", () => {
  const r = decideLanding({ ...one("bin/day-segments"), ...safe });
  assert.equal(r.mode, "auto");
});

test("moderate risk still lands on its own — only high blast radius asks", () => {
  const r = decideLanding({ ...one("agent/scripts/trigger-hum.sh"), ...safe, risk: "moderate" });
  assert.equal(r.mode, "auto");
});

for (const path of [
  "bin/email-send",
  "bin/edva-send-curl",
  "bin/edva-calendar",
  "bin/vault-sync",
  "agent/supervisor/index.mjs",
  "agent/config/agents.json",
  "agent/ops-agent/email-triage-rules.md",
  "data/spam-blocklist.json",
  "lib/claim-freshness.mjs",
  "githooks/pre-commit",
  "bin/lint-no-language-regex",
]) {
  test(`high blast radius needs a card: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /high blast radius/);
  });
}

for (const path of [
  "data/self-improvement-risk-rubric.md",
  "agent/ops-agent/jobs/improvement-plan.md",
  "agent/ops-agent/jobs/nightly-review.md",
  "lib/self-improve-landing.mjs",
  "bin/self-improve-auto-apply",
  "bin/self-improve-request",
  "agent/CLAUDE.md",
  "lib/self-improve-rebase.mjs",
  "lib/self-improve-rebuild.mjs",
  "lib/skill-repair.mjs",
]) {
  test(`the pipeline may not touch its own controls: ${path}`, () => {
    assert.equal(decideLanding({ ...one(path), ...safe }).mode, "refuse");
  });
}

// The instance's local twins (agent/local/) of the guarded rule files:
// its own agent rules (appended to every system prompt beside the CLAUDE.md
// files) and its additions to the guarded playbooks are the same rules, so the
// same rail — and the local triage rules are as high-blast-radius as the kernel
// ruleset they are merged into.
for (const path of [
  "agent/local/shared.md",
  "agent/local/chat.md",
  "agent/local/ops.md",
  "agent/local/jobs/nightly-review.md",
  "agent/local/jobs/self-improvement-executor.md",
  "agent/local/jobs/improvement-plan.md",
  "agent/local/jobs/system-issue-review.md",
  "agent/local/jobs/skill-repair.md",
]) {
  test(`the pipeline may not touch the local twin of its own controls: ${path}`, () => {
    assert.equal(decideLanding({ ...one(path), ...safe }).mode, "refuse");
  });
}

for (const path of [
  "agent/local/email-triage-rules.md",
  "agent/local/jobs/purchase.md",
  "agent/local/jobs/high-risk-job.md",
]) {
  test(`a local twin of a high-blast-radius file needs a card: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /high blast radius/);
  });
}

test("an ordinary local playbook addition is not swept into a rail", () => {
  assert.equal(decideLanding({ ...one("agent/local/jobs/morning-digest.md"), ...safe }).mode, "auto");
});

test("the daily-summary repair loop's local playbook twin is card-only", () => {
  const r = decideLanding({ ...one("agent/local/jobs/daily-summary-fix.md"), ...safe });
  assert.equal(r.mode, "card");
  assert.match(r.reasons.join(" "), /Face-ID card/);
});

// The daily-summary repair loop's own rules (a list self-improve-landing.mjs
// carries) may change on a Face-ID card, still never automatically.
for (const path of [
  "bin/daily-summary-fix",
  "agent/ops-agent/jobs/daily-summary-fix.md",
  "agent/scripts/trigger-daily-summary-fix.sh",
  "tests/daily-summary-fix.test.mjs",
]) {
  test(`the repair loop's own file goes on a card, never lands on its own: ${path}`, () => {
    const r = decideLanding({ ...one(path), ...safe });
    assert.equal(r.mode, "card");
    assert.match(r.reasons.join(" "), /Face-ID card/);
    // However small and safe the change, and alongside an ordinary file.
    const mixed = decideLanding({ files: { [path]: "x\n", "bin/day-segments": "x\n" }, before: {}, ...safe });
    assert.equal(mixed.mode, "card");
  });
}

test("secrets are refused outright", () => {
  assert.equal(decideLanding({ ...one(".env"), ...safe }).mode, "refuse");
  assert.equal(decideLanding({ ...one("credentials/token.json"), ...safe }).mode, "refuse");
});

test("complex changes need a card: too many files, or too many lines", () => {
  const files = {};
  for (let i = 0; i <= MAX_FILES; i++) files[`lib/f${i}.mjs`] = "a\n";
  assert.equal(decideLanding({ files, before: {}, ...safe }).mode, "card");

  const big = Array.from({ length: MAX_CHANGED_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
  const r = decideLanding({ files: { "lib/big.mjs": big }, before: { "lib/big.mjs": "" }, ...safe });
  assert.equal(r.mode, "card");
  assert.match(r.reasons.join(" "), /changed lines/);
});

test("a new capability, a high label, or a hesitant critic needs a card", () => {
  assert.equal(decideLanding({ ...one("bin/new-thing"), ...safe, category: "new-capability" }).mode, "card");
  assert.equal(decideLanding({ ...one("bin/day-segments"), ...safe, risk: "high" }).mode, "card");
  assert.equal(decideLanding({ ...one("bin/day-segments"), ...safe, critic: "DEFER_TO_OPERATOR: unsure" }).mode, "card");
});

test("two viable approaches are the user's choice, not a draft", () => {
  const r = decideLanding({ ...one("bin/day-segments"), ...safe, architecturalOptions: 2 });
  assert.equal(r.mode, "refuse");
  assert.deepEqual(r.reasons, ["more than one viable approach — the user picks"]);
});

test("the task registry, kernel and local halves, is shared process machinery (never low)", () => {
  for (const p of ["system/tasks.json", "agent/local/tasks.json"]) {
    assert.deepEqual(railsFor([p]).forceModerate, [p]);
  }
});

test("a path outside the installation's force_high list is not swept in", () => {
  assert.equal(decideLanding({ ...one("bin/banking-notes"), ...safe }).mode, "auto");
});

test("changed lines counts additions and removals", () => {
  assert.equal(changedLines("a\nb\nc", "a\nB\nc"), 2);
  assert.equal(changedLines(null, "a\nb"), 2);
  assert.equal(changedLines("a\nb", "a\nb"), 0);
});

test("the card is plain language in the four parts the user asked for", () => {
  const text = composeCard({ problem: "p", impact: "i", fix: "f", sideEffects: "none expected" });
  assert.match(text, /^What's wrong: p\n\nWhy it matters now: i\n\nThe fix: f\n\nSide effects: none expected$/);
  assert.throws(() => composeCard({ problem: "p", impact: "", fix: "f", sideEffects: "s" }), /impact/);
});

// The installation's landing hook (_ext/self-improve-landing.mjs
// `landingRefusals`): whatever it rejects is refused for a redraft — neither a
// card nor a signature lands it — after the kernel's own refusals and before
// the card rails.
const refusing = { landingRefusals: ({ files }) => Object.keys(files).filter((p) => files[p].includes("NOT-HERE")).map((p) => `misplaced content in ${p}`) };

test("a change the installation's hook rejects is refused for a redraft, whatever its rails", () => {
  const r = decide({ ...one("lib/some-module.mjs", "x NOT-HERE\n"), ...safe, hook: refusing });
  assert.equal(r.mode, "refuse");
  assert.equal(r.redraft, true);
  assert.deepEqual(r.reasons, ["misplaced content in lib/some-module.mjs"]);
  // A high-blast-radius path is refused too, not carded: a signature cannot fix the content.
  assert.equal(decide({ ...one("bin/email-send", "NOT-HERE\n"), ...safe, hook: refusing }).mode, "refuse");
});

test("a change the hook accepts goes on to the ordinary rails", () => {
  assert.equal(decide({ ...one("lib/some-module.mjs"), ...safe, hook: refusing }).mode, "auto");
  assert.equal(decide({ ...one("bin/email-send"), ...safe, hook: refusing }).mode, "card");
});

test("the kernel's own refusals come first, and are not marked for a redraft", () => {
  const r = decide({ ...one("agent/CLAUDE.md", "NOT-HERE\n"), ...safe, hook: refusing });
  assert.equal(r.mode, "refuse");
  assert.equal(r.redraft, undefined);
  assert.match(r.reasons[0], /own controls/);
});

test("a hook that throws refuses the change; no hook refuses nothing", () => {
  const broken = { landingRefusals: () => { throw new Error("boom"); } };
  const r = decide({ ...one("lib/some-module.mjs"), ...safe, hook: broken });
  assert.equal(r.mode, "refuse");
  assert.match(r.reasons[0], /landing check failed: boom/);
  assert.deepEqual(installationRefusals({ files: { a: "NOT-HERE" }, hook: null }), []);
  assert.deepEqual(installationRefusals({ files: { a: "NOT-HERE" }, hook: {} }), []);
});
