// choice-reply — resolve a tapped multiple-choice answer without waking an agent.
//
// THE PROBLEM THIS FIXES. The tap UX inserts an ordinary `role:user` message
// carrying the option's label (see client/Edva/ChoicePrompt.swift), which is
// what makes it generic — phone-channel, the chat-agent and `findme resolve`
// all treat it as typed text. But "ordinary user message" also means the full
// dispatch path: one tapped place name took ~45 seconds of "Working…" to
// answer while a Sonnet turn re-read a ~146k
// session prefix to write "Saved —". One tap, one agent turn, real money. At
// several stops a day that is the wrong trade.
//
// So the tap keeps its generic shape and gets a SHORT CIRCUIT: when the message
// replies to a prompt we sent, everything needed to act is already in that
// prompt's `metadata.choices` — `kind` (what sort of question) and `ref` (what
// it is about). Resolve it here, answer from code, skip the agent entirely.
//
// THIS IS NOT LANGUAGE INTERPRETATION (Rule #0b). Nothing here reads what
// the user meant. It compares the user's message against the exact option labels WE
// generated and put in the payload — a set membership test over our own
// strings. Anything that is not an exact match falls through to the agent
// untouched, which is also what happens when the user types a real sentence instead
// of tapping. Adding a fuzzy match here would cross the line; do not.
//
// Every unknown `kind` falls through too, so a new use case is opt-in: it works
// through the agent on day one and gets a fast path when someone adds a handler.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installRoot } from "./root.cjs";

const execFileP = promisify(execFile);
const REPO = installRoot();
// Mirrors OTHER_VALUE in bin/stop-identify and PROTOCOL_NOT_A_NAME in
// bin/findme: the stored value of a "none of these" button.
export const OTHER_VALUE = "__other__";
export const LEGACY_OTHER_LABELS = new Set(["Somewhere else", "No, somewhere else", "Type it in"]);

/**
 * Handlers by prompt `kind`. Each gets {ref, label, prompt} and returns a short
 * confirmation string, or null to decline and let the agent handle it.
 */
const HANDLERS = {
  // A decision card (hum `decisions` lane, bin/decision-ask). The tapped
  // option's value is the source entry's own option text; decision-answer
  // writes it back to the source's state file so the job that asked acts on it
  // on its next run. It refuses (non-zero) on an unknown or already-closed ref
  // — let that throw so the agent takes it.
  async decision({ ref, label }) {
    if (!ref) return null;
    const { stdout } = await execFileP(path.join(REPO, "bin/decision-answer"),
                                       ["--ref", ref, "--option", label], { timeout: 30000 });
    let out = {};
    try { out = JSON.parse(stdout); } catch { /* recorded; no detail to word */ }
    return decisionReply(out, ref);
  },
};

const DECISION_OPENERS = ["Thanks, that settles it.", "Okay, going with that.", "Good, that's decided."];

/**
 * The line the user reads after tapping a decision card: what the answer leads
 * to and by when, worded from decision-answer's structured `next` ({who, does,
 * after, when, changes_nothing}). Our own fields, composed in code; nothing
 * here reads what the user meant. Never promises more than the source does: a
 * tap starts nothing itself, so the line names the run that will act on it,
 * and with no time known it says "on its next run". The opener rotates by ref
 * so two answers in a week do not read like the same form letter.
 */
export function decisionReply(out, seed = "") {
  if (out?.already_answered) return "That one's already settled — I kept the answer you gave before.";
  const next = out?.next || {};
  if (next.changes_nothing === true) return "Okay, we'll leave it as it is, so nothing changes.";
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const opener = DECISION_OPENERS[h % DECISION_OPENERS.length];
  if (!next.who) return `${opener} It's with the job that asked, which picks it up on its next run.`;
  const who = next.who.charAt(0).toUpperCase() + next.who.slice(1);
  const after = next.after ? `, ${next.after},` : "";
  return `${opener} ${who} picks it up ${next.when || "on its next run"}${after} and ${next.does || "takes it from there"}.`;
}

// A checklist (metadata.checklist; client ChoicePrompt.swift § Checklist). A tap is a reply of
// CHECK or UNCHECK plus the item's label — OUR prefix and OUR label, matched exactly, the same
// Rule #0b line as above. The item's `ref` (what to act on) rides in the checklist itself.
// Ticks are silent: the box on the user's screen is the confirmation, so no reply bubble.
export const CHECK = "✓ ", UNCHECK = "↩ ";
const CHECKLIST_HANDLERS = {};

// Handlers for one installation's own card kinds plug in here instead of
// living in this file: registerChoiceHandler / registerChecklistHandler, or
// lib/_ext/choice-handlers.mjs exporting
// `{ choices: {kind: fn}, checklists: {kind: fn} }` (loaded once, lazily;
// kernel kinds win on a name conflict). EDVA_CHOICE_HANDLERS points the
// overlay path elsewhere (tests).
export function registerChoiceHandler(kind, fn) {
  if (kind && typeof fn === "function" && !HANDLERS[kind]) HANDLERS[kind] = fn;
}

export function registerChecklistHandler(kind, fn) {
  if (kind && typeof fn === "function" && !CHECKLIST_HANDLERS[kind]) CHECKLIST_HANDLERS[kind] = fn;
}

const EXT_HANDLERS = process.env.EDVA_CHOICE_HANDLERS
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "_ext", "choice-handlers.mjs");
let extLoaded = null;
function loadExtHandlers() {
  if (!extLoaded) {
    extLoaded = (async () => {
      if (!fs.existsSync(EXT_HANDLERS)) return;
      const mod = await import(pathToFileURL(EXT_HANDLERS).href);
      for (const [k, fn] of Object.entries(mod.choices || {})) registerChoiceHandler(k, fn);
      for (const [k, fn] of Object.entries(mod.checklists || {})) registerChecklistHandler(k, fn);
    })().catch((e) => console.error(`[choice-reply] overlay handlers failed to load: ${e?.message || e}`));
  }
  return extLoaded;
}

async function checklistTap(raw, text) {
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return { handled: false }; }
  if (list?.v !== 1 || !Array.isArray(list.items)) return { handled: false };
  const typed = String(text || "").trim();
  const done = typed.startsWith(CHECK) ? true : typed.startsWith(UNCHECK) ? false : null;
  if (done === null) return { handled: false };
  const label = typed.slice((done ? CHECK : UNCHECK).length);
  const item = list.items.find((i) => i?.label === label);
  const handler = CHECKLIST_HANDLERS[list.kind];
  if (!item || !handler) return { handled: false };
  if (!(await handler({ ref: item.ref, done }))) return { handled: false };
  return { handled: true, reply: null, kind: `checklist:${list.kind}` };
}

/**
 * Try to resolve `row` as a tapped choice answer.
 *
 * @returns {Promise<{handled: boolean, reply?: string|null, kind?: string}>}
 *   reply=null means handled silently (a checklist tick). handled=false means "not a choice reply, or nothing here can act on it" —
 *   the caller must continue to the normal ack + dispatch path unchanged.
 */
export async function handleChoiceReply(supabase, row, text) {
  try {
    if (!row?.reply_to || row.role !== "user") return { handled: false };
    await loadExtHandlers();

    const { data: parent } = await supabase
      .from("edva_messages")
      .select("id, metadata")
      .eq("id", row.reply_to)
      .single();

    if (parent?.metadata?.checklist) return await checklistTap(parent.metadata.checklist, text);
    const raw = parent?.metadata?.choices;
    if (!raw) return { handled: false };

    let prompt;
    try { prompt = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { return { handled: false }; }
    if (prompt?.v !== 1 || !Array.isArray(prompt.options)) return { handled: false };

    // Exact match against OUR OWN labels. Trim only — no case folding, no fuzzy
    // matching, no "closest option". See the Rule #0b note at the top.
    const typed = String(text || "").trim();
    const option = prompt.options.find(o => o.label === typed);
    if (!option) return { handled: false };

    const handler = HANDLERS[prompt.kind];
    if (!handler) return { handled: false };

    // MATCH on the label (that is what the user tapped and what the message carries),
    // but ACT on the value when the option defines one. A yes/no button reads
    // "Yes — the rental" and means "the rental"; storing the label verbatim put
    // the word "Yes" into the name of the place it was naming.
    const reply = await handler({
      ref: prompt.ref, label: option.value || option.label, prompt,
    });
    if (!reply) return { handled: false };

    return { handled: true, reply, kind: prompt.kind };
  } catch (err) {
    // Fail OPEN to the agent. A broken fast path must never swallow an answer —
    // the slow route still works, it just costs a turn.
    console.error(`[choice-reply] falling through to agent: ${err.message}`);
    return { handled: false };
  }
}
