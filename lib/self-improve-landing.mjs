// self-improve-landing.mjs — how a finished, verified self-improvement lands:
// on its own, as a Face-ID card, or not at all. No clock; the only I/O is
// reading the installation's config and its optional landing hook at import.
//
// Improvement cards are reserved for complex, high-blast-radius items;
// everything else is applied automatically. Until then every change reached the
// user's phone as a card (rubric schema v3), and the user had signed hundreds of
// them and declined none — a gate with a 100% pass rate had stopped being a gate. Schema v4 of
// data/self-improvement-risk-rubric.md reopens automatic landing, and
// this module is the part of it that is code rather than prose, so that the
// boundary does not depend on an agent classifying its own work honestly.
//
// Three outcomes:
//
//   refuse — FORBIDDEN (secrets, credentials) or RECURSION_GUARD (the
//            improvement pipeline's own controls). Nothing is drafted, staged
//            or applied; a human edits these directly. Also refused, with
//            `redraft: true`: whatever the installation's landing hook rejects
//            (_ext/self-improve-landing.mjs `landingRefusals`, e.g. content that
//            does not belong in the file it was put in). The author fixes the
//            change and resubmits; neither a card nor a signature can land it.
//   card   — anything high-blast-radius or complex: a CARD_ONLY path (the
//            daily-summary repair loop's own files), a FORCE_HIGH path (money,
//            logins, outbound messages, calendar, triage, the supervisor, the
//            enforcement hooks), a new capability, more than MAX_FILES files or
//            MAX_CHANGED_LINES changed lines, a high risk label, or a critic
//            that did not say SAFE. Lands only on the user's Face-ID signature.
//   auto   — everything else. Committed directly, tagged [auto-impl], revertable
//            like any commit, and listed in the review email.
//
// The paths are judged from the ACTUAL file set, never from what an agent
// predicted it would touch, and the lists below are mirrored in the rubric and
// pinned by tests/self-improve-landing.test.mjs.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHook } from "./ext-hooks.mjs";

// The installation's own landing checks: lib/_ext/self-improve-landing.mjs
// may export landingRefusals({ files, before }) → string[] (synchronous). Each
// string refuses the change; an empty list (or no hook) lets it through to the
// rails below. A fresh install has no hook. A hook that fails to load refuses
// every change with the load error (an unchecked change does not land) rather
// than breaking the import for the callers that only compose cards.
const LANDING_HOOK = await loadHook(path.dirname(fileURLToPath(import.meta.url)), "self-improve-landing").catch((e) => ({
  landingRefusals: () => { throw new Error(`could not load _ext/self-improve-landing.mjs: ${e?.message ?? e}`); },
}));

// Path rails are written kernel-relative and matched against repo-relative
// paths: rail(/bin\/x$/) is /^tools\/bin\/x$/ where the kernel sits under
// tools/ (KERNEL_SUBDIR, lib/root.cjs) and /^bin\/x$/ where it is the repo root.
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("./root.cjs");
const KERNEL_PREFIX = KERNEL_SUBDIR ? KERNEL_SUBDIR.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "\\/" : "";
function rail(re) {
  return new RegExp(`^${KERNEL_PREFIX}${re.source}`, re.flags);
}

export const MAX_FILES = 5;
export const MAX_CHANGED_LINES = 300;

/** Never touched by the pipeline in any form. */
export const FORBIDDEN = [
  rail(/secrets\//),
  rail(/credentials\//),
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.credentials\.json$/,
  /\.p8$/,
];

/**
 * The improvement pipeline's own controls. A system that could rewrite these
 * could approve its own loosening, so nothing in the pipeline may even draft a
 * change to them — Face-ID or not. A human edits them directly.
 */
export const RECURSION_GUARD = [
  rail(/agent\/CLAUDE\.md$/),
  rail(/agent\/chat-agent\/CLAUDE\.md$/),
  // On-demand procedures split out of chat-agent/CLAUDE.md (2026-10-04): the
  // same rules, so the same guard.
  rail(/agent\/chat-agent\/procedures\//),
  // Rule text moved out of agent/CLAUDE.md into on-demand docs (same day).
  rail(/docs\/(calendar-invite-guard|agent-auth-model|agent-effort-policy|outbound-messaging|system-channel-and-precheck|financial-carveouts|agent-rules-detail)\.md$/),
  rail(/agent\/ops-agent\/CLAUDE\.md$/),
  rail(/agent\/ops-light-agent\/CLAUDE\.md$/),
  rail(/agent\/ops-agent\/jobs\/nightly-review\.md$/),
  rail(/agent\/ops-agent\/jobs\/self-improvement-executor\.md$/),
  rail(/agent\/ops-agent\/jobs\/improvement-plan\.md$/),
  rail(/agent\/ops-agent\/jobs\/system-issue-review\.md$/),
  // The instance's local twins of the files above (agent/local/): its
  // own agent rules, appended to every agent's system prompt beside the
  // CLAUDE.md files, and its additions to those playbooks, appended to them at
  // dispatch. The same rules, so the same guard.
  rail(/agent\/local\/(shared|chat|ops)\.md$/),
  rail(/agent\/local\/jobs\/(nightly-review|self-improvement-executor|improvement-plan|system-issue-review|skill-repair)\.md$/),
  rail(/data\/self-improvement-risk-rubric\.md$/),
  rail(/lib\/self-improve-landing\.mjs$/),
  rail(/bin\/self-improve-(auto-apply|request|approval-poll|feed-log)$/),
  rail(/agent\/core\/(self-improve-unified|app-approval)\.mjs$/),
  // The stale-base check and the once-only card rebuild (2026-10-22): what
  // decides whether a fix may overwrite a file, and whether a failed approval
  // comes back.
  rail(/lib\/self-improve-(rebase|rebuild)\.mjs$/),
  rail(/tests\/(self-improve-landing|auto-impl-policy|self-improve-rebase|self-improve-rebuild)\.test\.mjs$/),
  // The same-day browser-action repair loop (2026-10-16): a repair may rewrite
  // a broken action, never the loop's own admission rules or playbook.
  rail(/lib\/skill-repair\.mjs$/),
  rail(/bin\/skill-repair$/),
  rail(/agent\/scripts\/trigger-skill-repair\.sh$/),
  rail(/agent\/ops-agent\/jobs\/skill-repair\.md$/),
  rail(/tests\/skill-repair\.test\.mjs$/),
];

/**
 * The daily-summary repair loop's own files (2026-10-17): it fixes the day's
 * code, never its own plumbing or playbook. These used to sit in
 * RECURSION_GUARD, so nothing could even draft a change to them and every fix
 * waited for a hand apply (one patch sat in a build-queue result file). The
 * user chose to make the loop's own rules changeable by a Face-ID card, still
 * never automatically. So they
 * are card-only — a change to them is drafted and lands on the user's signature, and
 * self-improve-auto-apply still refuses them whatever the risk label says.
 */
export const CARD_ONLY = [
  rail(/bin\/daily-summary-fix$/),
  rail(/agent\/ops-agent\/jobs\/daily-summary-fix\.md$/),
  rail(/agent\/local\/jobs\/daily-summary-fix\.md$/),
  rail(/agent\/scripts\/trigger-daily-summary-fix\.sh$/),
  rail(/tests\/daily-summary-fix\.test\.mjs$/),
];

// geo-gate-ok: a list of path rails that names the send CLIs; this module sends nothing and recommends no event.
/** High blast radius: always a Face-ID card, whatever the classifier said. */
export const FORCE_HIGH = [
  // The reviewer of the daily summary (2026-10-17): the fix loop may need to add a
  // check, but a change to what the review looks for is the user's call, so it is a
  // card, never a silent landing (the fixer must not weaken its own judge).
  rail(/lib\/daily-summary-review\.js$/),
  rail(/bin\/daily-summary-review$/),
  rail(/tests\/daily-summary-review\.test\.mjs$/),
  // The supervisor and everything read once at boot.
  rail(/agent\/supervisor\//),
  rail(/agent\/phone-channel\//),
  rail(/agent\/chat-supervisor\.mjs$/),
  rail(/agent\/bin\/process-manager\.mjs$/),
  rail(/agent\/config\/agents\.json$/),
  rail(/agent\/[^/]+\/\.mcp\.json$/),
  // Outbound messages, and the gates in front of them.
  rail(/bin\/(email-send|gmail-action|edva-send-curl|edva-send|edva-notify|imsg|whatsapp-send)$/),
  rail(/bin\/outbound-precheck\.mjs$/),
  rail(/lib\/(claim-freshness|apns-push)\.mjs$/),
  // Calendar writes.
  rail(/bin\/edva-calendar$/),
  // Money: the installation's own purchase, banking, brokerage and holdings
  // tools are appended below from agent/local/config/self-improve-landing.json.
  // Face-ID purchases: the executor, its trust core, and the playbook.
  rail(/bin\/purchase(-queue|-approval-poll)?$/),
  rail(/lib\/purchase-approval\.mjs$/),
  rail(/agent\/core\/app-approval\.mjs$/),
  rail(/agent\/ops-agent\/jobs\/purchase\.md$/),
  rail(/agent\/local\/jobs\/purchase\.md$/),
  // Email triage, where a mistake misroutes a P1.
  rail(/agent\/ops-agent\/jobs\/(email-triage[^/]*|triage-learning)\.md$/),
  rail(/agent\/ops-agent\/email-triage-rules\.md$/),
  // ...and the instance's own triage rules, merged into that ruleset by heading.
  rail(/agent\/local\/jobs\/(email-triage[^/]*|triage-learning)\.md$/),
  rail(/agent\/local\/email-triage-rules\.md$/),
  rail(/data\/(email-triage-playbook\.md|spam-blocklist\.json|p1-senders\.json)$/),
  // The enforcement layer: hooks and lints that hold rules prose could not.
  rail(/githooks\//),
  rail(/bin\/lint-[^/]+$/),
  rail(/bin\/edva-commit$/),
];
// The installation's own high-blast-radius paths (its money tools, …):
// `force_high` in agent/local/config/self-improve-landing.json, as regex
// sources matched against the repo-relative path.
for (const src of createRequire(import.meta.url)("./instance.cjs").localConfig("self-improve-landing", { force_high: [] }).force_high || []) {
  FORCE_HIGH.push(new RegExp(src));
}

/** Shared process machinery: never labelled low, but may still land on its own. */
export const FORCE_MODERATE = [
  rail(/agent\/scripts\/watchdog\.sh$/),
  rail(/agent\/scripts\/trigger-[^/]+\.sh$/),
  rail(/system\/tasks(\.schema)?\.json$/),
  // ...and the installation's own task entries, merged into it by lib/registry.cjs.
  rail(/agent\/local\/tasks\.json$/),
  rail(/bin\/edva$/),
];

/** Categories that are complex or high-blast-radius by nature. */
export const CARD_CATEGORIES = new Set(["new-capability", "outbound", "auth", "financial", "recursion-guard"]);

function matchAll(paths, patterns) {
  return paths.filter((p) => patterns.some((re) => re.test(p)));
}

/** Which rails each path hits. */
export function railsFor(paths) {
  return {
    forbidden: matchAll(paths, FORBIDDEN),
    recursion: matchAll(paths, RECURSION_GUARD),
    cardOnly: matchAll(paths, CARD_ONLY),
    forceHigh: matchAll(paths, FORCE_HIGH),
    forceModerate: matchAll(paths, FORCE_MODERATE),
  };
}

/**
 * Lines changed between two versions of a file: lines added plus lines removed,
 * counted as a multiset. It ignores moves, which makes it a slight
 * over-estimate of `git diff --numstat` — the safe direction for a size limit.
 */
export function changedLines(before, after) {
  const count = (text) => {
    const m = new Map();
    for (const line of String(text ?? "").split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  if (before == null) return String(after ?? "").split("\n").length;
  const a = count(before);
  const b = count(after);
  let diff = 0;
  for (const [line, n] of a) diff += Math.max(0, n - (b.get(line) ?? 0));
  for (const [line, n] of b) diff += Math.max(0, n - (a.get(line) ?? 0));
  return diff;
}

/**
 * What the installation's landing hook refuses in this change (empty = nothing).
 * A hook that throws refuses the change too: an unchecked change does not land.
 * `hook` defaults to the installation's; pass null to judge as a fresh install.
 */
export function installationRefusals({ files, before = {}, hook = LANDING_HOOK }) {
  if (!hook || typeof hook.landingRefusals !== "function") return [];
  try {
    const r = hook.landingRefusals({ files: files ?? {}, before: before ?? {} });
    return Array.isArray(r) ? r.map(String) : [];
  } catch (e) {
    return [`the installation's landing check failed: ${e?.message ?? e}`];
  }
}

/**
 * Decide how a verified change lands.
 *
 * @param {object} p
 * @param {Record<string,string>} p.files      repo-relative path → new content
 * @param {Record<string,string|null>} p.before path → current content (null = new file)
 * @param {"low"|"moderate"|"high"} p.risk
 * @param {string} p.category
 * @param {string} p.critic                     the critic's verdict line ("SAFE", "DEFER_TO_OPERATOR: …", …)
 * @param {number} [p.architecturalOptions]     how many viable approaches the classifier saw
 * @param {object|null} [p.hook]                the installation's landing hook (default: its _ext module; null: none)
 * @returns {{mode: "auto"|"card"|"refuse", reasons: string[], rails: object, lines: number, fileCount: number, redraft?: true}}
 */
export function decideLanding({ files, before = {}, risk, category, critic, architecturalOptions = 0, hook = LANDING_HOOK }) {
  const paths = Object.keys(files ?? {});
  const rails = railsFor(paths);
  const lines = paths.reduce((s, p) => s + changedLines(before[p] ?? null, files[p]), 0);
  const base = { rails, lines, fileCount: paths.length };

  if (paths.length === 0) return { mode: "refuse", reasons: ["no files"], ...base };
  if (rails.forbidden.length) return { mode: "refuse", reasons: rails.forbidden.map((p) => `forbidden path: ${p}`), ...base };
  if (rails.recursion.length) {
    return { mode: "refuse", reasons: rails.recursion.map((p) => `the improvement pipeline's own controls: ${p}`), ...base };
  }
  const local = installationRefusals({ files, before, hook });
  if (local.length) return { mode: "refuse", redraft: true, reasons: local, ...base };
  if (architecturalOptions > 1) return { mode: "refuse", reasons: [`more than one viable approach — ${createRequire(import.meta.url)("./instance.cjs").instanceValue("owner_name")} picks`], ...base };

  const reasons = [];
  for (const p of rails.cardOnly) reasons.push(`the daily-summary repair loop's own files change only on a Face-ID card: ${p}`);
  for (const p of rails.forceHigh) reasons.push(`high blast radius: ${p}`);
  if (String(risk).toLowerCase() === "high") reasons.push("classified high risk");
  if (CARD_CATEGORIES.has(String(category))) reasons.push(`category ${category}`);
  if (paths.length > MAX_FILES) reasons.push(`${paths.length} files (auto-apply limit ${MAX_FILES})`);
  if (lines > MAX_CHANGED_LINES) reasons.push(`${lines} changed lines (auto-apply limit ${MAX_CHANGED_LINES})`);
  if (String(critic ?? "").trim().toUpperCase() !== "SAFE") reasons.push(`critic did not say SAFE (${String(critic ?? "none").slice(0, 80)})`);

  return reasons.length ? { mode: "card", reasons, ...base } : { mode: "auto", reasons: [], ...base };
}

/**
 * The text the user reads, on a card or in the email: four plain-language parts,
 * in the order the user asked for — the problem, what it is costing now, the fix, and
 * what else it could affect — written for someone without the background.
 * Technical detail (verification, revert) follows, set apart.
 */
export function composeCard({ problem, impact, fix, sideEffects, details = "" }) {
  const missing = Object.entries({ problem, impact, fix, sideEffects })
    .filter(([, v]) => !String(v ?? "").trim())
    .map(([k]) => k);
  if (missing.length) throw new Error(`card text is missing: ${missing.join(", ")}`);
  const parts = [
    `What's wrong: ${String(problem).trim()}`,
    `Why it matters now: ${String(impact).trim()}`,
    `The fix: ${String(fix).trim()}`,
    `Side effects: ${String(sideEffects).trim()}`,
  ];
  if (String(details).trim()) parts.push(`Details: ${String(details).trim()}`);
  return parts.join("\n\n");
}
