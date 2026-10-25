// jev-gate-harness.mjs — shared fixture for the Jev gate tests
// (jev-outbound-precheck / jev-claim-check / jev-claim-freshness). Not a test file.
//
// Hermetic by construction: a --import preload replaces global fetch in the
// child so the Jev endpoint answers from env, Ollama (the on-device privacy
// screen) answers STUB_SCREEN or refuses, and EVERY other host throws — no
// Supabase, no Google, no network. `claude` is a shell stub that counts its
// invocations and prints STUB_SONNET.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export function makeFixture(site, { copyQuestions = [site] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jev-${site}-`));
  const qdir = path.join(tmp, "questions");
  fs.mkdirSync(qdir, { recursive: true });
  for (const s of copyQuestions) fs.copyFileSync(new URL(`../agent/config/jev-questions/${s}.json`, import.meta.url), path.join(qdir, `${s}.json`));
  const f = {
    tmp, qdir,
    CFG: path.join(tmp, "jev-config.json"),
    SHADOW: path.join(tmp, "shadow"),
    CALLS: path.join(tmp, "jev-calls.log"),
    CLAUDE_COUNT: path.join(tmp, "claude-count.log"),
    CLAUDE: path.join(tmp, "claude-stub.sh"),
    PRELOAD: path.join(tmp, "stub-fetch.mjs"),
  };
  f.CLAUDE_ARGV = path.join(tmp, "claude-argv.log");
  // Records each run's argv + whether the metered-API key leaked into its env.
  fs.writeFileSync(f.CLAUDE, `#!/bin/bash\necho run >> "${f.CLAUDE_COUNT}"\necho "key=\${ANTHROPIC_API_KEY:-none} cwd=$PWD argv=$*" >> "${f.CLAUDE_ARGV}"\nprintf '%s' "$STUB_SONNET"\n`, { mode: 0o755 });
  f.claudeArgv = () => (fs.existsSync(f.CLAUDE_ARGV) ? fs.readFileSync(f.CLAUDE_ARGV, "utf8").trim().split("\n").filter(Boolean) : []);
  fs.writeFileSync(f.PRELOAD, `
import fs from "node:fs";
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("/v1/evaluate")) {
    fs.appendFileSync(process.env.JEV_TEST_CALLS, init.body + "\\n");
    return new Response(JSON.stringify({ model: "jev-latest", answers: JSON.parse(process.env.JEV_TEST_ANSWERS || "{}"), providerMetadata: { gateway: { cost: "0" } } }), { status: 200 });
  }
  if (u.includes("/api/") && process.env.STUB_SCREEN) {
    return new Response(JSON.stringify({ message: { content: process.env.STUB_SCREEN }, response: process.env.STUB_SCREEN, done: true }), { status: 200 });
  }
  throw new Error("offline (jev gate test): " + u);
};
`);
  f.reset = (cfg = {}) => {
    for (const p of [f.SHADOW, f.CALLS, f.CLAUDE_COUNT, f.CLAUDE_ARGV]) fs.rmSync(p, { recursive: true, force: true });
    fs.writeFileSync(f.CFG, JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {}, ...cfg }));
  };
  f.jevCalls = () => (fs.existsSync(f.CALLS) ? fs.readFileSync(f.CALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  f.claudeRuns = () => (fs.existsSync(f.CLAUDE_COUNT) ? fs.readFileSync(f.CLAUDE_COUNT, "utf8").trim().split("\n").filter(Boolean).length : 0);
  f.rows = () => (fs.existsSync(f.SHADOW) ? fs.readdirSync(f.SHADOW).filter((x) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(x))
    .flatMap((x) => fs.readFileSync(path.join(f.SHADOW, x), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))) : []);
  f.disagreements = () => { const p = path.join(f.SHADOW, "disagreements.jsonl"); return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
  f.baseEnv = (extra = {}) => {
    const env = {
      ...process.env,
      JEV_CONFIG_FILE: f.CFG, JEV_QUESTIONS_DIR: qdir, JEV_SHADOW_DIR: f.SHADOW,
      JEV_ENDPOINT: "https://jev.test/v1/evaluate", JEV_NO_ALERT: "1", TYPESAFE_API_KEY: "test-key",
      JEV_PRIVATE_SCREEN: "off", JEV_TEST_CALLS: f.CALLS,
      // outbound-precheck's rolling health file and its system-channel report
      // must never be the live ones during a test run.
      OUTBOUND_PRECHECK_HEALTH: path.join(tmp, "outbound-precheck-health.json"), OUTBOUND_PRECHECK_NO_ALERT: "1",
      ...extra,
    };
    delete env.SUPABASE_SERVICE_ROLE_KEY; delete env.SUPABASE_ANON_KEY;
    return env;
  };
  f.runCli = (bin, stdin, env, args = []) => new Promise((resolve) => {
    const c = execFile(process.execPath, ["--import", f.PRELOAD, bin, ...args], { env, timeout: 30000 },
      (err, stdout) => { let json = null; try { json = JSON.parse(String(stdout).trim().split("\n").pop()); } catch {} resolve({ err, json, stdout }); });
    c.stdin.end(stdin);
  });
  f.cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return f;
}

export const choice = (pick, p, options) => ({ verdict: { type: "choice", choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? p : (1 - p) / (options.length - 1)])) } });
