// edva dispatch — hand a job to the ops supervisors by hand.
//
// POSTs {"job": "<name>"} (plus an optional free-text task) to the webhook of
// the job's tier, the same routing the cron triggers use
// (agent/scripts/lib/webhook-auth.sh): a job whose job-routing.json model is
// haiku goes to ops-haiku (:9072), any other non-opus model to ops-light
// (:9082), opus / unknown / a Chrome job to ops (:9092); an unhealthy tier
// degrades upward. The supervisor loads agent/ops-agent/jobs/<job>.md (or the
// installation's jobs/_ext/<job>.md) plus agent/local/jobs/<job>.md.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { KERNEL, webhookToken, isHelp } from "./_common.mjs";

const require = createRequire(import.meta.url);

const TIERS = {
  haiku: [["ops-haiku", 9072, 9073], ["ops-light", 9082, 9083], ["ops", 9092, 9093]],
  light: [["ops-light", 9082, 9083], ["ops", 9092, 9093]],
  heavy: [["ops", 9092, 9093]],
};

function resolveTier(job) {
  try {
    const { loadRegistry } = require(path.join(KERNEL, "lib", "registry.cjs"));
    let chrome = new Set();
    try { chrome = new Set(loadRegistry("chrome-jobs").jobs || []); } catch {}
    const j = (loadRegistry("job-routing").jobs || {})[job];
    const m = j && j.model;
    if (m && !chrome.has(job)) {
      if (m === "haiku") return "haiku";
      if (m !== "opus") return "light";
    }
  } catch { /* unreadable registry: heavy, like the shell router */ }
  return "heavy";
}

async function healthy(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.json().catch(() => ({}));
    return body.childAlive === true;
  } catch { return false; }
}

function jobFiles() {
  const out = new Map();
  for (const dir of [path.join(KERNEL, "agent", "ops-agent", "jobs"), path.join(KERNEL, "agent", "ops-agent", "jobs", "_ext")]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch {}
    for (const f of names) {
      const name = f.slice(0, -3);
      if (!out.has(name)) out.set(name, dir.endsWith("_ext") ? "_ext" : "kernel");
    }
  }
  return out;
}

export default {
  summary: "POST a job to its tier's supervisor webhook (no args: list jobs)",
  usage: "dispatch <job> [--task T]",
  async run(args, ctx) {
    const { c, die, getFlag, hasFlag } = ctx;
    const job = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--task" && args[i - 1] !== "--port");
    if (!job || isHelp(args)) {
      console.log("Usage: edva dispatch <job> [--task \"extra instructions\"] [--port N] [--dry-run]");
      console.log("       edva dispatch            # list dispatchable jobs");
      if (!job && !isHelp(args)) {
        const files = jobFiles();
        if (files.size) {
          console.log("\nJob playbooks (agent/ops-agent/jobs/):");
          for (const [name, where] of [...files].sort()) console.log(`  ${name.padEnd(32)} ${c.dim(`${resolveTier(name)}${where === "_ext" ? "  (_ext)" : ""}`)}`);
        }
      }
      return;
    }
    const task = getFlag(args, "--task");
    const payload = JSON.stringify({ job, source: "edva-cli", ...(task ? { task } : {}) });
    let chain = TIERS[resolveTier(job)];
    const portFlag = getFlag(args, "--port");
    if (portFlag) chain = [["(--port)", Number(portFlag), null]];

    if (hasFlag(args, "--dry-run")) {
      console.log(c.dim("(dry-run — nothing sent)"));
      console.log(`tier chain: ${chain.map(([n, p]) => `${n}:${p}`).join(" → ")}`);
      console.log(`body: ${payload}`);
      return;
    }

    let target = null;
    for (const [name, wport, hport] of chain) {
      if (hport == null || await healthy(hport)) { target = [name, wport]; break; }
      console.log(c.dim(`  ${name} (:${hport}) not healthy — trying the next tier`));
    }
    if (!target) die("no healthy supervisor for this job. Is the stack running? Try `edva up`, then `edva status`.");

    const token = webhookToken(KERNEL);
    if (!token) die("no webhook token (secrets/webhook-token or WEBHOOK_TOKEN) — run `edva init` first.");
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${target[1]}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: payload,
      });
    } catch (e) { die(`dispatch failed: ${e.message}`); }
    if (res.ok) console.log(c.green("✓") + ` dispatched ${c.bold(job)} to ${target[0]} (HTTP ${res.status})`);
    else die(`dispatch failed: HTTP ${res.status} from ${target[0]} (:${target[1]})`);
  },
};
