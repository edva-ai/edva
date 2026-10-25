// jev-claude.mjs — the ONE way the Jev batches spawn a `claude -p` judgment
// (legacy Sonnet/Haiku verdicts and every shadow run).
//
// Why a shared helper (code review 2026-09-23): each site had hand-rolled its
// own spawn with `--allowedTools ""`, which does NOT remove tools — it only
// grants no extra ones. Built-ins, MCP servers and whatever the user/project
// settings already allow (defaultMode auto, hundreds of allow rules) stayed
// live, so a "shadow" whose prompt quotes a playbook (p1-resolve.md explains
// how to run p1-downgrade) could actually act. And only one of them stripped
// ANTHROPIC_API_KEY, so the rest silently billed the metered API instead of
// Max (agent/CLAUDE.md § Auth Model forbids that).
//
// What this does, and why each flag:
//   --tools ""                         no tools at all (built-ins included)
//   --strict-mcp-config --mcp-config {} no MCP servers, not even user-level ones
//   --setting-sources project + cwd=tmp no user/project/local settings, hooks or
//                                      permissions from the edva tree apply
//   --no-session-persistence           these are throwaway judgments
//   NOT --bare: it skips keychain reads, i.e. the Max credential.
//   env without ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN → Max session only.
//   Prompt on STDIN (a positional prompt is not reliably picked up — CLAUDE.md).
// Async (execFile) so a long-lived caller (phone-channel, hum-sense) never
// blocks its event loop.

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { extractJsonObject } from "./extract-json.mjs";

export const DEFAULT_CLAUDE_BIN = path.join(os.homedir(), ".local/bin/claude");

export function toollessArgs(model, effort = "low") {
  return [
    "-p", "--model", model, "--effort", effort,
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "project",
    "--no-session-persistence",
    "--output-format", "text",
  ];
}

export function maxOnlyEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * Run one tool-less judgment. Resolves stdout (trimmed) or "" on any failure —
 * callers keep their own fail-open semantics.
 */
export function runToolless(opts) {
  return runToollessDetailed(opts).then((r) => r.out);
}

/**
 * Same run, but says WHY it came back empty. Resolves {out, error} where
 * `error` is null on success or {kind, message} with kind one of
 * "timeout" | "spawn_error" | "exit_nonzero" | "empty_output" |
 * "not_logged_in" | "usage_limit". `out` follows runToolless exactly (stdout survives a
 * non-zero exit), except that the CLI's own auth banner is never `out`.
 * Added 2026-10-06 for claim-freshness, whose log could not tell "checked,
 * nothing mutable" from "the 45s extractor call timed out" — both read as a
 * pass.
 *
 * "not_logged_in" (2026-10-14):
 * a fork that cannot read the Max login (spawned inside an agent's Bash
 * sandbox, from cron, over SSH) prints `Not logged in · Please run /login` on
 * stdout. That used to come back as an ordinary 33-char model answer, so the
 * 2026-10-13 system alerts blamed the model ("claim-freshness extractor failed
 * … unparseable 11", "outbound precheck got no usable answer … no_json 6")
 * instead of the login. Now it is "" + this kind, which the callers log as
 * extractor_unavailable:not_logged_in / precheck_sonnet_unavailable:not_logged_in.
 *
 * "usage_limit" (2026-10-24): the same failure for a Max account that is
 * signed in but out of usage — the CLI prints its limit status line instead of
 * an answer. Both kinds mean "Max is unavailable", which is the one condition
 * the wiki's API fallback acts on (model-ladder.mjs sonnetRung, api-fallback.mjs).
 */
export function runToollessDetailed({ bin = DEFAULT_CLAUDE_BIN, model, prompt, timeoutMs = 60000, effort = "low" }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out, error) => { if (!done) { done = true; resolve({ out, error }); } };
    try {
      const child = execFile(bin, toollessArgs(model, effort),
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, cwd: os.tmpdir(), env: maxOnlyEnv() },
        (err, stdout, stderr) => {
          const out = err && !stdout ? "" : String(stdout || "").trim();
          const errText = String(stderr || "").trim();
          const authErr = notLoggedIn(out) || (!out && notLoggedIn(errText)) || usageLimit(out) || (!out && usageLimit(errText));
          if (authErr) return finish("", authErr);
          if (err && !out) return finish("", classifyExecError(err, timeoutMs));
          if (!out) return finish("", { kind: "empty_output", message: "model returned no output" });
          finish(out, null);
        });
      child.on("error", (e) => finish("", { kind: "spawn_error", message: String(e?.message || e).slice(0, 200) }));
      child.stdin.on("error", () => {});
      child.stdin.end(String(prompt ?? ""));
    } catch (e) { finish("", { kind: "spawn_error", message: String(e?.message || e).slice(0, 200) }); }
  });
}

// The claude CLI's own machine status line when it has no usable credential —
// a fixed CLI string, not model language, so a literal prefix check (no regex:
// bin/lint-no-language-regex). Checked before anything treats the
// output as an answer.
export const NOT_LOGGED_IN_PREFIX = "Not logged in";
function notLoggedIn(text) {
  if (!text.startsWith(NOT_LOGGED_IN_PREFIX)) return null;
  return { kind: "not_logged_in", message: text.split("\n", 1)[0].slice(0, 200) };
}

// The CLI's usage-limit status lines, across the wordings it has used. Fixed
// CLI strings, matched as literal prefixes (no regex), and only when the whole
// output is one short line: a model answer that happens to open with these
// words is never one line under 200 characters with nothing else in it.
export const USAGE_LIMIT_PREFIXES = [
  "Claude AI usage limit reached",
  "Claude usage limit reached",
  "5-hour limit reached",
  "Weekly limit reached",
  "You've hit your limit",
  "You\u2019ve hit your limit",
];
function usageLimit(text) {
  const line = text.trim();
  if (!line || line.length > 200 || line.includes("\n")) return null;
  if (!USAGE_LIMIT_PREFIXES.some((p) => line.startsWith(p))) return null;
  return { kind: "usage_limit", message: line };
}

// Structural fields of a Node child_process error — never message text.
function classifyExecError(err, timeoutMs) {
  const message = String(err?.message || err).slice(0, 200);
  if (err?.killed && err?.signal) return { kind: "timeout", message: `killed (${err.signal}) after ${timeoutMs}ms` };
  if (typeof err?.code === "string") return { kind: "spawn_error", message };
  return { kind: "exit_nonzero", message: `exit ${err?.code ?? "?"}${err?.signal ? ` signal ${err.signal}` : ""}` };
}

/** Pull the JSON object out of a model's reply. Operates on MODEL output. */
export function parseModelJson(modelOut) {
  if (!modelOut) return null;
  // Balanced, string-aware span scan (lib/extract-json.mjs) — the old
  // greedy `/\{[\s\S]*\}/` swallowed any prose brace before/after the object.
  return extractJsonObject(String(modelOut));
}
