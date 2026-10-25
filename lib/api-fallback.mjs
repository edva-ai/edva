// api-fallback.mjs — the ONE API-billed Anthropic call in Edva: the wiki's
// model steps, and only while the Max subscription is unavailable.
//
// The user asked for an automatic switch to the API (Sonnet) when the Max
// subscription is unavailable, scoped to the wiki answers only, capped at
// $25 a month. agent/CLAUDE.md § Auth Model carries the carve-out; read
// it before widening anything here. Agents, the supervisors and every other
// job still stop when Max is down — this module refuses any caller that is not
// in WIKI_CALLERS, so a new call site cannot quietly join.
//
// What it does:
//   - Calls Claude Sonnet (the id pinned in agent/config/models.env) via
//     the official SDK, no tools, one user message, `fallbacks: "default"`
//     (server-side refusal fallback, beta server-side-fallback-2026-07-01).
//   - Key: EDVA_WIKI_API_KEY in .env (canonical in 1Password). NOT
//     ANTHROPIC_API_KEY: max-auth-guard.sh scrubs every ANTHROPIC_* variable,
//     and that name would make every `claude -p` child bill the API instead of
//     Max. The key is passed to the SDK explicitly and never exported.
//   - Ledger: one row per call in agent/logs/api-fallback/ledger.ndjson
//     with tokens and dollars (Sonnet list price, $2 in / $10 out per MTok;
//     cache writes 1.25x, cache reads 0.1x of input). Monthly spend is the sum
//     of this UTC month's rows.
//   - Breaker: before each call the worst case (prompt estimate + max_tokens
//     at full price) is checked against the cap, so a call can never take the
//     month over it. Over the cap it refuses until the 1st, and pages the
//     system channel once per month. A rejected key (401/403: the key is a
//     30-day one) pages once per local day. It also pages once at 80%, and once
//     per local day the fallback is used at all — an API bill should never be silent
//     (a wiki server started where it cannot read the Max login would
//     otherwise bill quietly every day).
//
// Returns {out, error} like jev-claude.mjs runToollessDetailed, so callers
// read one shape. error.kind: "disabled" | "no_key" | "no_sdk" | "cap" |
// "caller" | "refusal" | "api_error" | "empty_output".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { installRoot } from "./root.cjs";

const require = createRequire(import.meta.url);
const { MODELS } = require("./models.cjs");
const { DEFAULT_ENV_PATH } = require("./load-env.js");
const { instanceValue, localConfig } = require("./instance.cjs");

const ROOT = installRoot();
const SEND_BIN = path.join(ROOT, "bin/edva-send-curl");

export const KEY_ENV = "EDVA_WIKI_API_KEY";
export const WIKI_CALLERS = new Set(["wiki-answer", "wiki-portal", "wiki-facts", "wiki-triggers"]);
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
// $ per token at Sonnet list price. The server-side fallback model (Sonnet 5)
// is priced the same, so one rate covers every attempt.
export const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheWrite: 2.5 / 1e6, cacheRead: 0.2 / 1e6 };
// Conservative chars→tokens for the pre-call estimate (English runs ~4).
const CHARS_PER_TOKEN = 3;

function ledgerDir() {
  return process.env.WIKI_API_LEDGER_DIR || path.join(ROOT, "agent/logs/api-fallback");
}
const ledgerFile = () => path.join(ledgerDir(), "ledger.ndjson");
const stateFile = () => path.join(ledgerDir(), "state.json");

export function monthlyCapUsd() {
  const v = Number(process.env.WIKI_API_MONTHLY_CAP_USD);
  return Number.isFinite(v) && v >= 0 ? v : 25;
}

// The key, from the environment or .env. Reads this ONE line rather than
// loadEnv(): loading the whole file into process.env would hand every other
// secret in it to the `claude -p` forks this process spawns.
function apiKey() {
  if (process.env[KEY_ENV]) return process.env[KEY_ENV];
  try {
    for (const line of fs.readFileSync(process.env.WIKI_API_ENV_FILE || DEFAULT_ENV_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith(`${KEY_ENV}=`)) return t.slice(KEY_ENV.length + 1).trim() || null;
    }
  } catch {}
  return null;
}

// Where the operator keeps the fallback key (e.g. a password-manager reference),
// named in the key-rejected page: agent/local/config/api-fallback.json
// `key_secret_ref`. Empty by default.
function keySecretRef() {
  const ref = localConfig("api-fallback", { key_secret_ref: "" }).key_secret_ref;
  return ref ? `${ref} and ` : "";
}

export function fallbackEnabled() {
  return process.env.WIKI_API_FALLBACK !== "0" && !!apiKey();
}

const monthOf = (d) => d.toISOString().slice(0, 7);
const localDay = (d) => d.toLocaleDateString("en-CA", { timeZone: instanceValue("tz") });

// Dollars for one response's usage. With server-side fallback, usage.iterations
// lists every attempt (the declined one included) and top-level usage covers
// only the attempt that answered, so the iterations are the bill when present.
export function usageCost(usage) {
  if (!usage) return 0;
  const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage];
  let usd = 0;
  for (const u of parts) {
    usd += (u.input_tokens || 0) * PRICE.input + (u.output_tokens || 0) * PRICE.output
      + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.cache_read_input_tokens || 0) * PRICE.cacheRead;
  }
  return usd;
}

export function worstCaseCost(prompt, maxTokens) {
  return Math.ceil(String(prompt).length / CHARS_PER_TOKEN) * PRICE.input + maxTokens * PRICE.output;
}

// This UTC month's spend from the ledger. An unreadable ledger reads as the
// cap (fail closed): the one thing this file must never do is spend blind.
export function monthSpend(now = new Date()) {
  let text;
  try { text = fs.readFileSync(ledgerFile(), "utf8"); } catch (e) { return e?.code === "ENOENT" ? 0 : Infinity; }
  const month = monthOf(now);
  let usd = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.month === month) usd += Number(r.usd) || 0;
    } catch {}
  }
  return usd;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function writeState(st) {
  try {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, stateFile());
  } catch {}
}

function sendSystem(msg) {
  if (process.env.WIKI_API_NO_ALERT) return;
  try {
    const child = spawn(SEND_BIN, ["--channel", "system", "--skip-precheck", "--intent", "wiki-api-fallback", msg], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// Page once per key (a month for the cap and the 80% mark, a local day for use).
function pageOnce(key, value, msg) {
  const st = readState();
  if (st[key] === value) return;
  st[key] = value;
  writeState(st);
  sendSystem(msg);
}

const money = (usd) => `$${usd.toFixed(2)}`;

// Spend reserved by calls still in flight in this process, so concurrent
// answers cannot each pass the check against the same headroom.
let inFlight = 0;

/**
 * One tool-less Sonnet completion on the API. `caller` must be in
 * WIKI_CALLERS. Resolves {out, error, usd}.
 */
export async function apiComplete(prompt, { caller, maxTokens = 8000, effort = "low", timeoutMs = 120000, client = null, now = () => new Date() } = {}) {
  if (!WIKI_CALLERS.has(caller)) return { out: "", error: { kind: "caller", message: `api fallback is wiki-only; refused caller ${caller}` }, usd: 0 };
  if (!client) {
    if (!fallbackEnabled()) {
      const kind = process.env.WIKI_API_FALLBACK === "0" ? "disabled" : "no_key";
      return { out: "", error: { kind, message: kind === "disabled" ? "WIKI_API_FALLBACK=0" : `${KEY_ENV} not set in .env` }, usd: 0 };
    }
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ apiKey: apiKey(), timeout: timeoutMs, maxRetries: 1 });
    } catch (e) {
      return { out: "", error: { kind: "no_sdk", message: String(e?.message || e).slice(0, 200) }, usd: 0 };
    }
  }

  const t = now();
  const cap = monthlyCapUsd();
  const reserve = worstCaseCost(prompt, maxTokens);
  const spent = monthSpend(t);
  if (spent + inFlight + reserve > cap) {
    pageOnce("cap_paged_month", monthOf(t),
      `🔴 The wiki's API fallback hit its ${money(cap)} monthly cap (${money(Number.isFinite(spent) ? spent : cap)} spent in ${monthOf(t)}). Max is unavailable, so wiki answers, topic curation, facts and trigger cues are paused until Max is back or the month turns. Agents were never on this path. Raise the cap with WIKI_API_MONTHLY_CAP_USD in .env.`);
    return { out: "", error: { kind: "cap", message: `monthly cap ${money(cap)} reached (${money(Number.isFinite(spent) ? spent : cap)} spent)` }, usd: 0 };
  }
  pageOnce("use_paged_day", localDay(t),
    `⚠️ Max is unavailable, so the wiki is answering on the Anthropic API (${caller}). Billed per call, capped at ${money(cap)} a month (${money(spent)} spent so far in ${monthOf(t)}). Agents and every other job stay stopped until Max is back.`);

  inFlight += reserve;
  let res;
  try {
    res = await client.beta.messages.create({
      model: MODELS.sonnet,
      max_tokens: maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort },
      messages: [{ role: "user", content: String(prompt ?? "") }],
    });
  } catch (e) {
    inFlight -= reserve;
    // A refused key needs a person, not a retry: the key is a 30-day one and
    // lapses on a date (watch edva-wiki-api-key-refresh reminds before it).
    if (e?.status === 401 || e?.status === 403) {
      pageOnce("key_rejected_day", localDay(t),
        `🔴 The wiki's API fallback key was rejected (HTTP ${e.status}), most likely expired. Max is unavailable, so wiki answers are down until Max returns or the key is replaced: create a new key in platform.claude.com → Settings → API keys, then update ${keySecretRef()}${KEY_ENV} in ${instanceValue("host_label")}'s .env.`);
    }
    const status = typeof e?.status === "number" ? ` ${e.status}` : "";
    return { out: "", error: { kind: "api_error", message: `${e?.constructor?.name || "Error"}${status}: ${String(e?.message || e).slice(0, 160)}` }, usd: 0 };
  }
  inFlight -= reserve;

  const usd = usageCost(res.usage);
  try {
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.appendFileSync(ledgerFile(), JSON.stringify({
      at: t.toISOString(), month: monthOf(t), caller, model: res.model, stop_reason: res.stop_reason,
      input_tokens: res.usage?.input_tokens ?? null, output_tokens: res.usage?.output_tokens ?? null, usd: Number(usd.toFixed(6)),
    }) + "\n");
  } catch {}

  const after = spent + usd;
  if (after >= 0.8 * cap) {
    pageOnce("warn_paged_month", monthOf(t),
      `⚠️ The wiki's API fallback has spent ${money(after)} of its ${money(cap)} cap for ${monthOf(t)}. It stops itself at the cap.`);
  }

  if (res.stop_reason === "refusal") {
    return { out: "", error: { kind: "refusal", message: `declined (${res.stop_details?.category ?? "no category"})` }, usd };
  }
  const out = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!out) return { out: "", error: { kind: "empty_output", message: `no text (stop_reason ${res.stop_reason})` }, usd };
  return { out, error: null, usd };
}
