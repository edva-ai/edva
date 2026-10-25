// edva review-pr — LLM review of a diff for narrative personal-content leaks.
//
// The pattern-based sanitize guard catches explicit identifiers (names,
// handles, project refs, tokens). It cannot catch content that names nothing
// yet still points at a real person, event or transaction: "the car I
// bought in 2024 for $X", a code comment dated to a personal milestone,
// generated docs that paraphrase private context. This asks Claude to look
// for exactly that.
//
//   edva review-pr <PR#>            diff from `gh pr diff <N>`
//   edva review-pr --file <path>    any local text file
//   edva review-pr --stdin          a diff on stdin
//   --json  machine-readable output   --model M  --max-diff-bytes N
//
// Needs ANTHROPIC_API_KEY (environment or .env) and @anthropic-ai/sdk (the
// root package.json; `npm ci` at the repo root). Exit 1 on a "block" verdict.
// .github/workflows/narrative-review.yml runs it on every PR (advisory).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CHECKOUT, readDotEnv, isHelp } from "./_common.mjs";

export const SYSTEM_PROMPT = `You are reviewing a code diff for personal-content leaks that would land in a PUBLIC open-source repository called Edva. Your job is one thing only: catch personal/identity-coupled content that pattern-based scanners cannot.

## What's already screened (do NOT re-flag)

A pattern-based pre-commit hook (\`.tools/sanitize-guard.py\`) catches these and blocks the commit. Do not flag instances of:
- Canonical first names, GitHub handles, owner emails
- Known property names, business names, project codenames
- Known credentials, third-party service hostnames, known Supabase/GCP project IDs
- Hardcoded paths like \`/Users/<owner>/\`

If you see these in the diff, they are pre-approved (in the baseline) or will be blocked separately; the identity list itself is private, so do not guess at it. Do not waste a finding on them.

## What you ARE looking for

Content that, without using any of the above explicit identifiers, still:

1. **Narrative personal context** — descriptions of a specific real person, relationship, household, business operation, or life event that a reader could plausibly tie back to the operator.
   Examples: "the car I bought in 2024", "my cousin runs the sales side", "the office we moved into".

2. **Specific financial or transactional detail** — concrete dollar amounts, contract terms, or transaction details that appear personal rather than illustrative.
   Examples: "the $42,300 settlement", "a monthly retainer of $4,250", "the 18% commission on the X deal".
   NOT this: arbitrary numbers in code (port 9090, timeout 5000), illustrative pricing in docs ("$10/month for Pro plan").

3. **Specific dated events** — a date paired with a concrete event that reads as a real autobiographical reference, not a generic example.
   Examples: "the launch on March 15, 2026", "after the merger in Q3", "since my surgery last spring".
   NOT this: release dates, copyright years, schema migration timestamps, ISO date format examples.

4. **Geographic specificity that triangulates** — a city + a specific landmark/street/neighborhood/property type that narrows to a real address.
   Examples: "the 3rd-floor walkup two blocks from the old mill", "our lake house near the marina".
   NOT this: generic city names in API examples ("San Francisco, CA").

5. **Relationship reveal** — references to spouse, partner, child, business partner by role even without name.
   Examples: "my wife handles the books", "the kids' school schedule".

6. **AI-generated text with personal echoes** — auto-written prose (docs, comments, commit messages) that includes uniquely identifying details, even if no single pattern fires.

## What you are NOT looking for

- Generic technical content (port numbers, byte sizes, timeouts, hex colors)
- Generic examples in docs ("example.com", "Alice and Bob")
- Sanitized hypotheticals ("Suppose you have 3 cars")
- Standard open-source boilerplate (MIT license year, contributor guides)
- Public dates (release of Node.js 22, etc.)
- Public-facing URLs the project is intentionally publishing (e.g. project marketing links in the README)

## How to calibrate severity

- **high** — would clearly identify a real person/transaction/event to a stranger reading the public repo
- **medium** — adds personally identifying context that, combined with other public info, could narrow identity
- **low** — feels personal but is ambiguous; flag for human review

Be honest about uncertainty. If you can't tell whether a passage is generic or personal, mark it **low** and explain the ambiguity. Better to surface a borderline case than silently miss one.

## Output

You MUST emit valid JSON matching the schema provided. \`findings\` may be an empty array. \`summary.verdict\`:
- **ship** — no findings, or only \`low\` findings that are clearly false-positive territory
- **review** — at least one \`medium\` or borderline \`high\` finding; human should look
- **block** — at least one \`high\` finding that should be sanitized before merge`;

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "summary"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "severity", "category", "snippet", "why", "suggestion"],
        properties: {
          file: { type: "string", description: 'Path of the file in the diff ("(unknown)" if not derivable)' },
          line_hint: { type: "integer", description: "Approximate line number, or 0 if unknown" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          category: {
            type: "string",
            enum: ["narrative_personal", "specific_financial", "specific_event", "geographic_reveal", "relationship_reveal", "ai_generated_echo", "other"],
          },
          snippet: { type: "string", description: "The exact passage (≤200 chars)" },
          why: { type: "string", description: "One sentence on why this is a leak risk" },
          suggestion: { type: "string", description: "How to fix it — generalize, redact, or move to the private overlay" },
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["total_findings", "highest_severity", "verdict"],
      properties: {
        total_findings: { type: "integer" },
        highest_severity: { type: "string", enum: ["none", "low", "medium", "high"] },
        verdict: { type: "string", enum: ["ship", "review", "block"] },
      },
    },
  },
};

const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_DIFF_BYTES = 80 * 1024; // ~20k tokens — cost cap per call
// $/1M tokens [input, output] for the cost estimate; other models fall back to the default's.
const PRICES = { "claude-haiku-4-5": [1, 5], "claude-haiku-5-5": [0.1, 0.5], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
const SKIP_PATHS = [
  /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)Gemfile\.lock$/,
  /\.gitkeep$/, /(^|\/)node_modules\//,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|tar|gz|xcarchive|woff2?)$/i,
];

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || readDotEnv(path.join(CHECKOUT, ".env")).ANTHROPIC_API_KEY || null;
}

// Drop skip-listed files, then cut to maxBytes at a line boundary; keeps the
// per-file headers so findings can name their file.
export function filterAndTrimDiff(raw, maxBytes) {
  const kept = [];
  let skipped = 0;
  for (const part of raw.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const m = part.split("\n", 1)[0].match(/diff --git a\/(\S+) b\/(\S+)/);
    if (m && SKIP_PATHS.some((re) => re.test(m[2]))) { skipped++; continue; }
    kept.push(part);
  }
  let body = kept.join("");
  let truncated = false;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    const buf = Buffer.from(body, "utf8").subarray(0, maxBytes);
    const nl = buf.lastIndexOf(0x0a);
    body = (nl > 0 ? buf.subarray(0, nl) : buf).toString("utf8");
    truncated = true;
  }
  return { body, skipped, truncated };
}

function help(c) {
  console.log(c.bold("edva review-pr") + " — LLM review of a diff for narrative personal-content leaks\n");
  console.log("Usage:");
  console.log("  edva review-pr <PR#>          [--model M] [--max-diff-bytes N] [--json]");
  console.log("  edva review-pr --file <path>  [--model M] [--json]");
  console.log("  edva review-pr --stdin        [--model M] [--json]\n");
  console.log(`Defaults: --model ${DEFAULT_MODEL}  --max-diff-bytes ${MAX_DIFF_BYTES}`);
  console.log("Needs ANTHROPIC_API_KEY (environment or .env); a PR number needs the gh CLI.");
  console.log("Exit 1 on a \"block\" verdict.\n");
  console.log("Catches what the pattern guard cannot: paraphrased personal context, dated");
  console.log("events, financial detail, relationship reveals. See docs/architecture-public-private.md.");
}

export default {
  summary: "Claude review of a diff for narrative personal-content leaks",
  usage: "review-pr <PR#>|--file F",
  async run(args, ctx) {
    const { c, die, getFlag, hasFlag } = ctx;
    if (isHelp(args)) { help(c); return; }
    const model = getFlag(args, "--model", DEFAULT_MODEL);
    const maxBytes = parseInt(getFlag(args, "--max-diff-bytes", String(MAX_DIFF_BYTES)), 10) || MAX_DIFF_BYTES;
    const file = getFlag(args, "--file");
    const json = hasFlag(args, "--json");
    const pr = args.find((a) => /^\d+$/.test(a));

    let raw = "";
    let source = "";
    if (file) {
      try { raw = fs.readFileSync(file, "utf8"); } catch (e) { die(`can't read --file ${file}: ${e.code || e.message}`); }
      source = `file: ${file}`;
    } else if (hasFlag(args, "--stdin")) {
      raw = fs.readFileSync(0, "utf8");
      source = "stdin";
    } else if (pr) {
      try { raw = execFileSync("gh", ["pr", "diff", pr], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }); }
      catch (e) { die(`gh pr diff ${pr} failed: ${String(e.message).split("\n")[0]}`); }
      source = `PR #${pr}`;
    } else {
      die("usage: edva review-pr <PR#> | --file <path> | --stdin  (--help for flags)");
    }
    if (!raw.trim()) die(`no content from ${source}`);
    const { body, skipped, truncated } = filterAndTrimDiff(raw, maxBytes);
    if (!body.trim()) die("every file in the diff was skip-listed (lockfiles, binaries, ...)");

    const key = apiKey();
    if (!key) die("no ANTHROPIC_API_KEY in the environment or .env — set it, or run: edva init");
    let Anthropic;
    try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); }
    catch { die(`@anthropic-ai/sdk is not installed — run: npm ci --prefix ${CHECKOUT}`); }
    const client = new Anthropic({ apiKey: key });

    if (!json) {
      console.log(c.bold("edva review-pr") + c.dim(` — ${source}, model=${model}`));
      if (skipped) console.log(c.dim(`  skipped ${skipped} lockfile/binary file(s)`));
      if (truncated) console.log(c.yellow(`  warning: diff truncated to ${maxBytes} bytes — consider splitting the PR`));
      console.log(c.dim("  calling Claude…\n"));
    }

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 8000,
        // Cache marker on the fixed system prompt: a no-op below the model's
        // minimum cacheable prefix, a saving if the prompt grows past it.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Review this diff:\n\n\`\`\`diff\n${body}\n\`\`\`` }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) die("Anthropic auth failed — check ANTHROPIC_API_KEY");
      if (err instanceof Anthropic.RateLimitError) die("rate-limited by the Anthropic API — retry in a moment");
      if (err instanceof Anthropic.APIError && err.status) die(`Anthropic API error ${err.status}: ${err.message}`);
      die(`unexpected error calling Claude: ${err?.message || err}`);
    }
    if (response.stop_reason === "refusal") die("Claude declined to review this diff (stop_reason: refusal)");

    const text = (response.content || []).find((b) => b.type === "text");
    if (!text) die("no text block in Claude's response");
    let parsed;
    try { parsed = JSON.parse(text.text); } catch { die(`Claude returned non-JSON: ${text.text.slice(0, 200)}…`); }

    const usage = response.usage || {};
    const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    const cacheRead = usage.cache_read_input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
    const cost = (inTok / 1e6) * pin + (cacheRead / 1e6) * pin * 0.1 + (outTok / 1e6) * pout;
    const blocked = parsed.summary?.verdict === "block";

    if (json) {
      console.log(JSON.stringify({ ...parsed, _meta: { model, source, usage, est_cost_usd: cost } }, null, 2));
      process.exitCode = blocked ? 1 : 0;
      return;
    }
    const sev = (s) => (s === "high" ? c.red : s === "medium" ? c.yellow : c.dim);
    console.log(c.bold("Verdict: ") + sev(parsed.summary.highest_severity)(String(parsed.summary.verdict).toUpperCase()));
    console.log(c.dim(`  ${parsed.summary.total_findings} finding(s), highest severity: ${parsed.summary.highest_severity}`));
    console.log(c.dim(`  ${inTok} in + ${cacheRead} cache-read + ${outTok} out tokens · est $${cost.toFixed(4)}`));
    if (!parsed.findings.length) console.log("\n" + c.green("✓ no narrative leaks detected"));
    else {
      console.log("");
      for (const f of parsed.findings) {
        const loc = f.line_hint ? `${f.file}:${f.line_hint}` : f.file;
        console.log(`${sev(f.severity)(`[${f.severity.toUpperCase()}]`)} ${c.bold(loc)}  ${c.dim(`(${f.category})`)}`);
        console.log(`  ${c.dim("snippet:")} ${f.snippet}`);
        console.log(`  ${c.dim("why:    ")} ${f.why}`);
        console.log(`  ${c.dim("fix:    ")} ${f.suggestion}\n`);
      }
    }
    console.log(c.dim("LLM review is probabilistic (false positives and misses both happen); the pattern guard stays primary."));
    process.exitCode = blocked ? 1 : 0;
  },
};
