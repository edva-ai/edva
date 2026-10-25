// web-search.mjs — CAP A1. Max-safe web_search capability tool.
//
// Conway wraps Tavily. Edva has NO search-API key and a hard Max-only auth
// invariant, so the DEFAULT search provider is a `claude -p --allowedTools
// WebSearch` one-shot with ANTHROPIC_API_KEY stripped — the same Max-billed,
// zero-marginal-cost pattern as background research forks and the hum
// harvesters, never a raw Anthropic/third-party API call. The provider is
// INJECTED (`{ search }`), so a Tavily/Brave/Exa adapter can replace it later
// without touching the tool or any caller.
//
// Result discipline (Conway + OpenCLAW): <=5 {title,url,snippet}, snippets
// capped short — no full-article reproduction, minimal context cost.

import { execFile } from "node:child_process";

const MAX_RESULTS = 5;
const SNIPPET_CAP = 400;

function resolveClaudeBin() {
  return (
    process.env.CLAUDE_BIN ||
    (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : null) ||
    "claude"
  );
}

// Pull the first JSON array out of noisy model text and normalize it.
export function parseResults(text) {
  const start = (text || "").indexOf("[");
  const end = (text || "").lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && (x.url || x.title))
    .slice(0, MAX_RESULTS)
    .map((x) => ({
      title: String(x.title || "").slice(0, 200),
      url: String(x.url || ""),
      snippet: String(x.snippet || x.content || "").slice(0, SNIPPET_CAP),
    }));
}

// Default provider: one Max-authed `claude -p` WebSearch turn -> compact JSON.
// ANTHROPIC_API_KEY is stripped from the child env so this can NEVER bill the
// metered API even if a caller's environment carries the key.
export function makeClaudeWebSearch({
  claudeBin,
  model = "claude-sonnet-5-5",
  effort = "low",
  timeoutMs = 120000,
} = {}) {
  const bin = claudeBin || resolveClaudeBin();
  return function claudeWebSearch(query, { maxResults = MAX_RESULTS } = {}) {
    return new Promise((resolve, reject) => {
      const prompt =
        `Web-search for: ${query}\n` +
        `Return ONLY a compact JSON array of up to ${maxResults} objects, each ` +
        `{"title":..,"url":..,"snippet":..}. The snippet must be your own ` +
        `<=${SNIPPET_CAP}-char summary (no verbatim article text). ` +
        `No prose outside the JSON.`;
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; // Max-only invariant: never key-billed.
      execFile(
        bin,
        ["-p", "--model", model, "--effort", effort, "--allowedTools", "WebSearch", "--output-format", "text", prompt],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, env },
        (err, stdout) => {
          if (err && !stdout) return reject(err);
          resolve(parseResults(stdout || ""));
        }
      );
    });
  };
}

export function createWebSearchTool({ search } = {}) {
  const provider = search || makeClaudeWebSearch();
  return {
    name: "web_search",
    description:
      "Search the web. Returns up to 5 {title, url, snippet}. Use for current/verifiable facts.",
    schema: {
      type: "object",
      properties: { query: { type: "string", description: "1-6 word query" } },
      required: ["query"],
    },
    async handler({ query } = {}) {
      const q = (query || "").trim();
      if (!q) return { ok: false, error: "web_search: empty query" };
      try {
        const results = await provider(q, { maxResults: MAX_RESULTS });
        return {
          ok: true,
          query: q,
          results: Array.isArray(results) ? results.slice(0, MAX_RESULTS) : [],
        };
      } catch (e) {
        return { ok: false, error: `web_search failed: ${e?.message || e}` };
      }
    },
  };
}
