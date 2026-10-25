// edva init — interactive first-run setup for a Edva checkout.
//
// Writes, in the checkout this CLI runs from (EDVA_HOME when set):
//   .env                       secrets + host settings (asks before overwriting)
//   agent/local/instance.json  who and where this installation is (read by
//                              lib/instance.cjs; EDVA_* env vars override it)
//   agent/local/config/supabase.json   the project's public anon key, if given
//   secrets/webhook-token      the supervisors' shared webhook Bearer token
// creates the runtime dirs, seeds data/ and agent/local/ from examples/
// (never overwriting a file), and — only with consent — sends one anonymous
// install ping (bin/cli.d/_telemetry.mjs).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { CHECKOUT, readJson, isHelp } from "./_common.mjs";
import { sendInstallPing } from "./_telemetry.mjs";

const RUNTIME_DIRS = [
  "data", "data/hum-cache", "data/logs", "data/watchdog-incidents", "logs",
  "agent/logs", "agent/logs/supervisor-ops", "agent/logs/supervisor-chat",
  "agent/logs/supervisor-ops-light", "agent/logs/supervisor-ops-haiku",
  "agent/supervisor/state/ops", "agent/supervisor/state/chat",
  "agent/local", "agent/local/config", "secrets", "credentials",
];

// examples/<src> → <dst>, copied only when <dst> does not exist yet.
const SEEDS = [
  ["examples/hum-interests.example.json", "data/hum-interests.json"],
  ["examples/hum-intent.example.md", "data/hum-intent.md"],
  ["examples/user-timezone.example.json", "data/user-timezone.json"],
];

function hostTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function printHelp(c) {
  console.log(c.bold("edva init") + " — interactive first-run setup\n");
  console.log("Usage: edva init [--force]\n");
  console.log("Asks a few questions and writes, in this checkout:");
  console.log("  .env                         secrets and host settings (see .env.example)");
  console.log("  agent/local/instance.json    owner name, email, time zone, ... (lib/instance.cjs)");
  console.log("  secrets/webhook-token        random token the supervisors' webhooks require");
  console.log("then creates data/, logs/, supervisor state dirs and seeds starter config");
  console.log("from examples/ (existing files are never overwritten).\n");
  console.log("  --force   overwrite an existing .env / instance.json without asking\n");
  console.log("Telemetry: init asks before sending one anonymous install ping (no PII,");
  console.log("no raw IP; payload in apps/telemetry/README.md). EDVA_NO_TELEMETRY=1 in");
  console.log("the environment disables it outright. Change later: edva telemetry on|off.");
}

export default {
  summary: "first-run setup: .env, agent/local/instance.json, webhook token",
  usage: "init [--force]",
  async run(args, ctx) {
    const { c, hasFlag } = ctx;
    if (isHelp(args)) { printHelp(c); return; }
    const force = hasFlag(args, "--force");
    const base = CHECKOUT;
    const envPath = path.join(base, ".env");
    const instPath = path.join(base, "agent", "local", "instance.json");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Buffer lines so piped answers (tests, scripted installs) are not lost
    // between questions.
    const queue = [];
    let waiting = null;
    let closed = false;
    rl.on("line", (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l); });
    rl.on("close", () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(""); } });
    const ask = (q, def = "") => new Promise((resolve) => {
      process.stdout.write(`  ${q}${def ? c.dim(` [${def}]`) : ""}: `);
      const done = (ans) => { if (!process.stdin.isTTY) process.stdout.write("\n"); resolve(String(ans).trim() || def); };
      if (queue.length) done(queue.shift());
      else if (closed) done("");
      else waiting = done;
    });

    try {
      console.log(c.bold("Edva init") + c.dim(` — ${base}\n`));
      if (fs.existsSync(envPath) && !force) {
        const ans = await ask(".env already exists. Overwrite? (yes/no)", "no");
        if (!/^y(es)?$/i.test(ans)) { console.log(c.dim("  aborted — .env left alone")); return; }
      }
      console.log(c.dim("  Enter accepts the default; leave optional fields blank to skip.\n"));

      const env = {};
      env.EDVA_HOME = await ask("EDVA_HOME (absolute path to this checkout)", base);

      console.log(c.bold("\n  Anthropic auth"));
      console.log(c.dim("  Paste an API key, or leave blank to run on a `claude` login (Max subscription)."));
      env.ANTHROPIC_API_KEY = await ask("ANTHROPIC_API_KEY", "");

      console.log(c.bold("\n  Identity") + c.dim(" (stored in agent/local/instance.json)"));
      const existing = readJson(instPath, {}) || {};
      const inst = { ...existing };
      inst.owner_name = await ask("Your name, as the agents should address you", existing.owner_name || "the user");
      inst.owner_email = await ask("Your primary email", existing.owner_email || "");
      inst.agent_email = await ask("From: address for mail the agent sends (optional)", existing.agent_email || "");
      inst.tz = await ask("Home time zone (IANA)", existing.tz || hostTz());
      inst.github_owner = await ask("GitHub user or org that owns your fork (optional)", existing.github_owner || "");

      console.log(c.bold("\n  Webhook channel"));
      const token = crypto.randomBytes(32).toString("hex");
      console.log(c.dim("  generated a random webhook token → secrets/webhook-token"));

      console.log(c.bold("\n  Optional integrations") + c.dim(" (blank = skip; edit .env later)"));
      inst.supabase_project = await ask("Supabase project ref (the <ref> in <ref>.supabase.co)", existing.supabase_project || "");
      let anonKey = "";
      if (inst.supabase_project) {
        env.SUPABASE_SERVICE_ROLE_KEY = await ask("SUPABASE_SERVICE_ROLE_KEY", "");
        env.SUPABASE_ACCESS_TOKEN = await ask("SUPABASE_ACCESS_TOKEN (for the Supabase MCP server)", "");
        anonKey = await ask("Supabase anon (public) key", "");
      }
      env.OLLAMA_URL = await ask("OLLAMA_URL", "http://127.0.0.1:11434");
      env.LOCAL_LLM_MODEL = await ask("LOCAL_LLM_MODEL", "gemma3:1b");
      env.LOCAL_EMBED_MODEL = await ask("LOCAL_EMBED_MODEL", "nomic-embed-text");

      let telemetry = "off";
      if (process.env.EDVA_NO_TELEMETRY === "1") {
        console.log(c.dim("\n  Telemetry: EDVA_NO_TELEMETRY=1 is set — no ping, not asking."));
      } else {
        console.log(c.bold("\n  Telemetry"));
        console.log(c.dim("  One anonymous first-run ping tells the maintainers how many installs exist."));
        console.log(c.dim("  No PII, no raw IP, nothing from your .env. Payload: apps/telemetry/README.md."));
        const ans = await ask("Send the anonymous install ping? (Y/n)", "Y");
        telemetry = /^n(o)?$/i.test(ans) ? "off" : "on";
      }
      env.EDVA_TELEMETRY = telemetry;
      rl.close();

      // ── write ───────────────────────────────────────────────────────────
      for (const d of RUNTIME_DIRS) fs.mkdirSync(path.join(base, d), { recursive: true });

      const lines = [
        "# Edva environment — written by `edva init`. Every variable is documented in .env.example.",
        `# Generated ${new Date().toISOString()}`,
        "",
        ...Object.entries(env).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`),
        "",
      ];
      fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });

      const cleanInst = Object.fromEntries(Object.entries(inst).filter(([, v]) => v !== "" && v != null));
      fs.writeFileSync(instPath, JSON.stringify(cleanInst, null, 2) + "\n");

      if (anonKey) {
        const supaPath = path.join(base, "agent", "local", "config", "supabase.json");
        const cur = readJson(supaPath, {}) || {};
        fs.writeFileSync(supaPath, JSON.stringify({ ...cur, anon_key: anonKey }, null, 2) + "\n");
      }

      const tokenPath = path.join(base, "secrets", "webhook-token");
      if (!fs.existsSync(tokenPath) || force) fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

      const seeded = [];
      for (const [src, dst] of SEEDS) {
        const from = path.join(base, src);
        const to = path.join(base, dst);
        if (fs.existsSync(to) || !fs.existsSync(from)) continue;
        fs.copyFileSync(from, to);
        seeded.push(dst);
      }

      console.log(c.green("\n  ✓ .env written"));
      console.log(c.green("  ✓ agent/local/instance.json written"));
      console.log(c.green("  ✓ runtime dirs created (data/, logs/, agent/logs/, supervisor state/, secrets/)"));
      console.log(c.green("  ✓ webhook token at secrets/webhook-token"));
      if (seeded.length) {
        console.log(c.green(`  ✓ seeded ${seeded.length} file(s) from examples/:`));
        for (const s of seeded) console.log(c.dim("      " + s));
      }
      console.log(c.dim("\nNext: ") + c.bold("./bin/edva doctor") + c.dim(", then ") + c.bold("./bin/edva up"));
      console.log(c.dim("Per-installation rules and config: docs/architecture-public-private.md."));

      if (telemetry === "on") {
        // Short and bounded (3 s); never fails the install.
        await sendInstallPing(base, "fresh-install");
      }
    } finally {
      if (!closed) rl.close();
    }
  },
};
