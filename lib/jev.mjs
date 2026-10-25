// jev.mjs — client for Jev (TypeSafe AI's "System One" decision model) through
// the Vercel AI Gateway evaluation endpoint.
//
// WHY. Jev is used for all the recommended decision use cases. Jev does not
// write text: it takes a `state` plus
// typed questions (boolean / choice / score) and returns probabilities, in
// ~70-500 ms, at $0.042 per million input tokens with free output. Every
// decision-shaped model call in Edva (email triage, the precheck gates, the
// relevance judges) was a `claude -p` Sonnet turn or an unreliable Gemma call.
// See docs/jev.md for the full design, the site list and the shadow week.
//
// Transport: POST https://api.typesafe.ai/v1/systemone, Bearer TYPESAFE_API_KEY
// (.env; canonical copy in the password manager). TypeSafe
// does not train on inputs; privacy_exclusions in jev-config.json is the user's call.
//
// This module is transport only. Deciding whether Jev's answer is trusted,
// running the legacy mechanism alongside it and logging the comparison is
// lib/jev-shadow.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { installRoot, toolsPath } from "./root.cjs";

const require = createRequire(import.meta.url);
const { loadEnv } = require("./load-env.js");
loadEnv();

const ROOT = installRoot();
export const JEV_CONFIG_FILE = process.env.JEV_CONFIG_FILE || path.join(ROOT, "data/jev-config.json");
export const JEV_QUESTIONS_DIR = process.env.JEV_QUESTIONS_DIR || path.join(ROOT, "data/jev-questions");
// The kernel's own definition of every kernel site, shipped with the code. An
// installation's file in JEV_QUESTIONS_DIR replaces it; an explicit
// JEV_QUESTIONS_DIR (a test's temp dir) is the only source.
export const JEV_QUESTIONS_KERNEL_DIR = toolsPath("agent/config/jev-questions");
export const JEV_OFF_FILE = path.join(ROOT, "data/.jev-off");
// TypeSafe direct ONLY (by the user's decision, not via a gateway). The Vercel
// AI Gateway path was removed: it 403'd every call for days ("Free tier users
// do not have access to this model").
// Key: TYPESAFE_API_KEY in .env (canonical copy in the password manager).
const ENDPOINT = process.env.JEV_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
const DIRECT_MODEL = process.env.JEV_MODEL || "jev-latest";

// Jev's state budget is 32k tokens (state + longest question). ~4 chars/token,
// with headroom for the question text.
export const MAX_STATE_CHARS = 90_000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function loadJevConfig() {
  return readJson(JEV_CONFIG_FILE, { sites: {} });
}

// Question definitions live in data, not code, so a disagreement review can fix
// a badly-worded question or criterion with a JSON edit: one file per decision
// site, data/jev-questions/<site>.json = {threshold?, enabled?, notes?, questions}.
// A kernel site with no file there uses its kernel definition
// (agent/config/jev-questions/<site>.json). `{{owner_id}}` /
// `{{owner_name}}` anywhere in a definition (a question key included, e.g.
// `needs_{{owner_id}}`) become this installation's values (lib/instance.cjs).
// `vars` fills the other {{name}} placeholders (e.g. the candidate list for a choice).
export function jevSiteDef(site) {
  const def = readJson(path.join(JEV_QUESTIONS_DIR, `${site}.json`), null)
    ?? (process.env.JEV_QUESTIONS_DIR ? null : readJson(path.join(JEV_QUESTIONS_KERNEL_DIR, `${site}.json`), null));
  return fillOwner(def);
}

function fillOwner(def) {
  if (!def) return def;
  const text = JSON.stringify(def);
  if (!text.includes("{{owner_")) return def;
  const { owner_id, owner_name } = require("./instance.cjs").instance();
  const esc = (v) => JSON.stringify(String(v)).slice(1, -1);
  return JSON.parse(text.split("{{owner_id}}").join(esc(owner_id)).split("{{owner_name}}").join(esc(owner_name)));
}

export function jevQuestions(site, vars = {}) {
  const q = jevSiteDef(site);
  if (!q || !q.questions) throw new Error(`jev: no questions defined for site ${site}`);
  const fill = (v) => typeof v === "string"
    ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ""))
    : Array.isArray(v) ? v.map(fill)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
    : v;
  return fill(q.questions);
}

export function jevAvailable() {
  if (fs.existsSync(JEV_OFF_FILE)) return false;
  return !!process.env.TYPESAFE_API_KEY;
}

function clampState(state) {
  if (typeof state === "string") return state.length > MAX_STATE_CHARS ? state.slice(0, MAX_STATE_CHARS) : state;
  const s = JSON.stringify(state);
  if (s.length <= MAX_STATE_CHARS) return state;
  return s.slice(0, MAX_STATE_CHARS);
}

// A gateway failure is either a WALL or a WOBBLE, and the caller has to be able
// to tell them apart without reading the message text (Rule #0b: no regex on a
// string to decide meaning). We produce the string ourselves, so we also carry
// the status as data: `status` is the HTTP code and `permanent` means retrying
// this exact request cannot succeed until a human changes something — a missing
// key (no 'jev:' credentials), 401 (bad key), 402 (out of credits) or 403 (the
// plan does not include this model). Everything else — 429 capacity, 5xx,
// timeouts — is transient and worth retrying.
// Measured 2026-09-27 → 10-01: a 403 "Free tier users do not have access to
// this model" repeated 569 consecutive times over 5 days with zero successes.
// The first one already proved the next 568.
const PERMANENT_STATUS = new Set([401, 402, 403]);
function jevError(message, status, permanent) {
  const e = new Error(message);
  e.status = status ?? null;
  e.permanent = permanent ?? (status != null && PERMANENT_STATUS.has(status));
  return e;
}

/**
 * Evaluate `state` against typed `questions`.
 * Resolves { answers, usage, cost, latencyMs }; rejects on transport/HTTP error.
 */
export async function jevEvaluate({ state, questions, timeoutMs = 8000 }) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw jevError("jev: TYPESAFE_API_KEY not set", null, true);
  return await callJev({ url: ENDPOINT, key, body: { model: DIRECT_MODEL, state: clampState(state), questions: toNative(questions) }, timeoutMs, via: "typesafe" });
}

// The native API names the boolean type "noul" (verified live 2026-10-05: "boolean"
// → 400 Invalid request; "noul" → {type:"noul", noul:p}). choice/score are the same
// shape on both transports. Answers already parse either name (answerConfidence/boolOf).
function toNative(questions) {
  if (!questions || typeof questions !== "object") return questions;
  return Object.fromEntries(Object.entries(questions).map(([k, q]) =>
    [k, q && q.type === "boolean" ? { ...q, type: "noul" } : q]));
}

async function callJev({ url, key, body: reqBody, timeoutMs, via }) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: ctl.signal,
    });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok || !body || !body.answers) {
    throw jevError(`jev(${via}): HTTP ${res.status} ${(body && (body.message || body.error?.message || (typeof body.error === "string" ? body.error : ""))) || text.slice(0, 200)}`, res.status);
  }
  // TypeSafe reports usage, not cost: price it at the published $0.042/MTok input rate.
  const cost = body.usage?.input_tokens != null ? Number(body.usage.input_tokens) * 0.042 / 1e6 : null;
  return { answers: body.answers, usage: body.usage || null, cost, latencyMs: Date.now() - t0, via };
}

// Confidence of a single answer, on one scale for all three types:
//   boolean → max(p, 1-p)       (0.5 = coin flip)
//   choice  → top option's probability
//   score   → top rung's probability
export function answerConfidence(a) {
  if (!a) return 0;
  if (a.type === "boolean" || a.type === "noul") {
    const p = a.type === "noul" ? a.noul : a.probability;
    return typeof p === "number" ? Math.max(p, 1 - p) : 0;
  }
  const probs = a.probabilities ? Object.values(a.probabilities).filter((x) => typeof x === "number") : [];
  return probs.length ? Math.max(...probs) : 0;
}

export function boolOf(a) {
  const p = a?.type === "noul" ? a.noul : a?.probability;
  return typeof p === "number" ? p >= 0.5 : null;
}
