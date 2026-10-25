// jev-private-screen.mjs — on-device gate that keeps health, bank/financial and
// CREDENTIAL content away from Jev (an EXTERNAL model, reached through Vercel AI
// Gateway).
//
// The rule it enforces (agent/CLAUDE.md): raw biometric/clinical records
// and bank rows (balances, transactions, account numbers) are edva-model-only
// — never sent to a third-party/external LLM. Jev is one, so any decision whose
// state might carry such content stays on the legacy (Max-session Claude) path.
//
// It is a MODEL, not a pattern match (Rule: never regex on language): the local
// Ollama model is the only thing allowed to read the text before we decide
// whether it may leave the machine, and on-device Ollama is explicitly permitted
// for this data.
//
// FAIL-CLOSED on purpose. Ollama down, a timeout, or an answer that isn't a
// clean NO all count as private → the caller uses legacy. Over-flagging costs a
// Sonnet call; under-flagging leaks a lab result. gemma3:1b is known to be
// permissive/unreliable on judgment tasks (see auto-recall.mjs), so this errs
// toward YES by prompt and by parse.

import { localLlmChat } from "./local-llm.mjs";

// CREDENTIALS ARE THE THIRD CLASS (2026-09-25). Found by the Jev disagreement
// review: on a chat message about an API, the auto-recall candidate list
// included a wiki reference page whose body carries a live vendor API key in
// plain text, and that snippet was sent to Jev.
// Nothing stopped it — the screen below names only health and finance, and
// gemma3:1b answers NO to an API key because no rule told it otherwise. Gateway
// traffic runs WITHOUT zero data retention on the Hobby plan (docs/jev.md),
// so a key that reaches it must be treated as disclosed.
//
// This half is deliberately NOT a model call. A vendor-prefixed token is
// machine-generated STRUCTURE, not language, which is the declared exception in
// Rule #0b — and it is the half the model provably cannot be trusted with, since
// a 1B model asked about health and finance has no reason to flag `ghp_...`.
// It runs BEFORE the model, so it costs nothing and cannot be talked out of.
// Over-flagging is cheap here by the same argument the file header already makes:
// a false YES costs one Sonnet call, a false NO discloses a credential.
//
// lang-regex-ok: matches machine-generated credential structure (vendor token
// prefixes, PEM headers, a labelled key/secret assignment), never a judgement
// about what a human meant.
const CREDENTIAL_PATTERNS = [
  // Vendor-prefixed tokens: Stripe, OpenAI, GitHub, Slack, Google, AWS,
  // Browserbase, Supabase, Resend, and JWTs.
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bbb_live_[A-Za-z0-9_-]{10,}/,
  /\bsbp_[a-f0-9]{40,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A labelled secret with a long, space-free, mixed-class value:
  // "API key: `abc123...`", "token=...", "client_secret: ...".
  /\b(?:api[-_ ]?key|secret|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|password|bearer)\b["'`\s]*[:=]["'`\s]*[A-Za-z0-9_\-.]{24,}/i,
];

export function hasCredential(text) {
  return CREDENTIAL_PATTERNS.some((re) => re.test(text));
}


const SYSTEM = `You screen text before it is sent to an outside service. Answer with exactly one word: YES or NO.
Answer YES if the text contains ANY of:
- health or medical information: symptoms, conditions, diagnoses, medications, doctors, appointments, lab or test results, biometrics (heart rate, sleep, weight, blood pressure, glucose), therapy, hospital
- private financial account data: bank or card balances, transactions, account numbers, portfolio holdings or positions, net worth, tax figures
Answer NO only if you are sure none of that is present. If unsure, answer YES.`;

const CHUNK = 6000;
const MAX_CHUNKS = 4;

/**
 * Screens EVERY character of `content` — the exact thing the caller will send
 * to Jev — in CHUNK-sized pieces, stopping at the first YES. Content longer than
 * MAX_CHUNKS × CHUNK is treated as private rather than partially screened
 * (code review 2026-09-23: screening only a 6000-char prefix let a health page
 * late in memory-write-precheck's related_memory through). Callers keep their
 * Jev state well under that bound.
 * @param {string|object} content  what would be sent to Jev
 * @returns {Promise<{private: boolean, reason: string}>}
 */
export async function isPrivateForJev(content, { timeoutMs = 4000 } = {}) {
  if (process.env.JEV_PRIVATE_SCREEN === "off") return { private: false, reason: "screen-disabled" };
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (!text || !text.trim()) return { private: false, reason: "empty" };
  // Deterministic, and first: the model cannot veto it and it costs nothing.
  if (hasCredential(text)) return { private: true, reason: "credential" };
  if (text.length > CHUNK * MAX_CHUNKS) return { private: true, reason: `too-long-to-screen:${text.length}` };
  for (let i = 0; i < text.length; i += CHUNK) {
    let out = "";
    try {
      out = await localLlmChat({
        system: SYSTEM, user: text.slice(i, i + CHUNK), maxTokens: 4, temperature: 0,
        numCtx: 4096, think: false, timeoutMs,
      });
    } catch (err) {
      return { private: true, reason: `screen-error: ${String(err?.message || err).slice(0, 80)}` };
    }
    const word = String(out).trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (word !== "NO") return { private: true, reason: word === "YES" ? "screen-yes" : `screen-unclear:${word.slice(0, 10)}` };
  }
  return { private: false, reason: "screen-no" };
}
