// model-ladder.mjs — the Rule #0b ladder for the associative-memory writers
// (trigger cues in wiki-embed.mjs, fact extraction in wiki-facts.mjs, question
// generation in bin/wiki-recall-eval-gen).
//
// agent/CLAUDE.md § Rule #0b: language goes to a model, cost is handled by
// a ladder — local model first (`gemma3:1b` via Ollama), escalate to the Sonnet
// id from agent/config/models.env, climbing only when a rung's output
// FAILS VALIDATION. Never a regex standing in for the model, never a hunch.
//
// Every writer here validates two things, and the second is what makes the
// local rung usable at all:
//   1. shape  — the JSON the prompt asked for.
//   2. grounding — every claim carries an `evidence` quote, and the quote must
//      appear VERBATIM in the page (case- and whitespace-insensitive). The
//      aspect-cue sample had gemma3:1b invent "Check for overlapping
//      flights between flights from <airport> to <airport>" on a page that never said it —
//      well-formed and simply false, so no shape check could catch it. A
//      required quote can: an invented claim has nothing to quote. (It does not
//      prove the claim follows from the quote; it does stop the claim from
//      coming from nowhere.)
//
// Both rungs are Edva's own models (on-device Ollama, the Max session via a
// tool-less `claude -p`), so health and finance pages are in scope on either —
// the two the Health Data and Financial Operations rules name as acceptable.
//
// The one exception to "Sonnet means the Max session": a wiki caller can pass
// `apiCaller` to sonnetRung, and then — only when the fork reports Max itself
// unavailable (signed out, or out of usage) — the same prompt goes to the same
// Sonnet on the Anthropic API, through api-fallback.mjs's $25/month breaker.
// The user's carve-out; scope and rules in agent/CLAUDE.md § Auth Model.
// Any other fork failure (timeout, empty output) is NOT a reason to bill the
// API and fails the rung as before.

import { createRequire } from "node:module";
import { localLlmChat } from "./local-llm.mjs";
import { runToolless, runToollessDetailed } from "./jev-claude.mjs";
import { apiComplete } from "./api-fallback.mjs";
import { extractJsonObject } from "./extract-json.mjs";

const require = createRequire(import.meta.url);
const { MODELS } = require("./models.cjs");

// Local rung. Returns the model's text, or throws when Ollama is unreachable
// (the ladder treats a throw as "rung unavailable" and climbs).
export function localRung({ maxTokens = 700, timeoutMs = 45000 } = {}) {
  const fn = (prompt) =>
    localLlmChat({ messages: [{ role: "user", content: prompt }], maxTokens, timeoutMs, think: false, temperature: 0.2 });
  fn.rungName = "local";
  return fn;
}

// Sonnet rung: tool-less, on Max (see jev-claude.mjs for every flag's why).
// Only works where the Max login is readable — a launchd user agent, not cron
// (CLAUDE.md § Effort Policy) — and returns "" otherwise, which fails
// validation and ends the ladder without a write. With `apiCaller` (wiki
// callers only, see above) a Max-unavailable fork is retried on the API and
// the rung resolves {text, via: "api"}.
export const MAX_UNAVAILABLE = new Set(["not_logged_in", "usage_limit"]);
// Once a fork has said Max is unavailable, skip forking for a few minutes: the
// answer will not change between two questions, and each doomed fork costs a
// CLI start-up on the critical path of every wiki answer during an outage.
const MAX_DOWN_MS = 5 * 60e3;
let maxDownUntil = 0;
export function _resetMaxDown() { maxDownUntil = 0; }

export function sonnetRung({ timeoutMs = 120000, effort = "low", apiCaller = null, apiMaxTokens = 8000, deps = {} } = {}) {
  const fork = deps.runToollessDetailed || runToollessDetailed;
  const api = deps.apiComplete || apiComplete;
  const fn = !apiCaller
    ? (prompt) => runToolless({ model: MODELS.sonnet, prompt, timeoutMs, effort })
    : async (prompt) => {
        let why = "max_down_recently";
        if (Date.now() >= maxDownUntil) {
          const { out, error } = await fork({ model: MODELS.sonnet, prompt, timeoutMs, effort });
          if (!error || !MAX_UNAVAILABLE.has(error.kind)) return out;
          maxDownUntil = Date.now() + MAX_DOWN_MS;
          why = error.kind;
        }
        const r = await api(prompt, { caller: apiCaller, effort, timeoutMs, maxTokens: apiMaxTokens });
        if (r.error) throw new Error(`max ${why}; api ${r.error.kind}: ${r.error.message}`);
        return { text: r.out, via: "api" };
      };
  fn.rungName = "sonnet";
  return fn;
}

// Run `prompt` up the rungs. `validate(parsedJson)` returns null when usable or
// an error string. Resolves { value, rung, errors } — value null when no rung
// produced a valid answer. `budget` (optional) is an object with a numeric
// `sonnet` field decremented per Sonnet call, so a nightly pass over hundreds of
// pages cannot fork Sonnet hundreds of times when the local rung is having a
// bad night. `via` is "api" when the Sonnet rung's answer was API-billed.
export async function runLadder(prompt, { rungs, validate, budget = null } = {}) {
  const errors = [];
  for (const rung of rungs || []) {
    if (typeof rung !== "function") continue;
    const name = rung.rungName || "rung";
    if (budget && name === "sonnet") {
      if (!(budget.sonnet > 0)) { errors.push("sonnet: budget spent"); continue; }
      budget.sonnet--;
    }
    let text = "";
    let via = null;
    try {
      text = await rung(prompt);
      if (text && typeof text === "object") ({ text, via = null } = text);
    } catch (e) {
      errors.push(`${name}: ${String(e?.message || e).slice(0, 160)}`);
      continue;
    }
    const parsed = parseJson(text);
    const err = parsed ? validate(parsed) : "no JSON object in reply";
    if (!err) return { value: parsed, rung: name, errors, ...(via ? { via } : {}) };
    errors.push(`${name}: ${err}`);
  }
  return { value: null, rung: null, errors };
}

function parseJson(text) {
  if (!text) return null;
  try {
    const span = extractJsonObject(String(text));
    if (span && typeof span === "object") return span;
    if (typeof span === "string") return JSON.parse(span);
  } catch {}
  // Fallback: outermost braces (structure, not meaning).
  const s = String(text);
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

// The grounding check lives in its own dependency-free module so the recall
// hot path (wiki-embed.mjs) can use it without loading the model rungs.
export { quoteIn } from "./quote-check.mjs";
