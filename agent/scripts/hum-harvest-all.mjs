#!/usr/bin/env node
// hum-harvest-all — reads the registry, fans out to every enabled harvester
// in parallel passing the situation snapshot on stdin, collects non-null
// candidates. Single JSON array on stdout.
//
// Skips topics whose cadence_min hasn't elapsed since last_run_at and topics
// whose active_window filter excludes the current time.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const MERLIN_HOME = process.env.MERLIN_HOME || path.join(HOME, "Dev/merlin");
const REGISTRY = path.join(MERLIN_HOME, "data/hum-interests.json");
const STATE = path.join(MERLIN_HOME, "data/hum-interests-state.json");
const HARVESTER_DIR = path.join(MERLIN_HOME, "agent/scripts/hum-harvesters");

function readJson(p, def = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

function minutesSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.round((Date.now() - t) / 60000);
}

function inActiveWindow(spec) {
  // spec examples: "mon-fri 09:30-16:00 ET", null, "sat-sun", "daily"
  if (!spec || spec === "daily") return true;
  // Use ET for any spec ending in "ET" — otherwise local time
  const useEt = /\bET\b/.test(spec);
  const now = useEt
    ? new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    : new Date();
  const day = now.getDay(); // 0=Sun .. 6=Sat
  const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dayToday = dayNames[day];

  // Day range
  const dayMatch = spec.match(/\b(sun|mon|tue|wed|thu|fri|sat)-(sun|mon|tue|wed|thu|fri|sat)\b/i);
  if (dayMatch) {
    const a = dayNames.indexOf(dayMatch[1].toLowerCase());
    const b = dayNames.indexOf(dayMatch[2].toLowerCase());
    const dn = day;
    const within = a <= b ? (dn >= a && dn <= b) : (dn >= a || dn <= b);
    if (!within) return false;
  }

  // Time range
  const timeMatch = spec.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const [, sh, sm, eh, em] = timeMatch.map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (nowMin < startMin || nowMin >= endMin) return false;
  }
  void dayToday;
  return true;
}

function runHarvester(topic, scriptPath, situationJson, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ topic, candidate: null, err: `timeout after ${timeoutMs}ms`, out });
    }, timeoutMs);

    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      clearTimeout(timer);
      const line = (out.trim().split("\n").pop() || "").trim();
      if (!line || line === "null") return resolve({ topic, candidate: null, err });
      try { resolve({ topic, candidate: JSON.parse(line), err }); }
      catch { resolve({ topic, candidate: null, err: `bad JSON: ${line.slice(0, 80)}` }); }
    });
    child.stdin.write(situationJson);
    child.stdin.end();
  });
}

async function main() {
  const registry = readJson(REGISTRY, { topics: [] });
  const state = readJson(STATE, {});
  const args = new Set(process.argv.slice(2));
  const forceAll = args.has("--force");
  const onlyTopic = (() => {
    const idx = process.argv.indexOf("--topic");
    return idx >= 0 ? process.argv[idx + 1] : null;
  })();

  // Read situation from stdin (one JSON object); empty stdin → empty object
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const situationJson = Buffer.concat(chunks).toString("utf8").trim() || "{}";

  // Build the unified merlin-context once per tick and pass it to every
  // harvester alongside the situation. Harvesters receive envelope shape:
  //   { situation, context }
  // on stdin. See lib/merlin-context.js for fields.
  let contextJson = "{}";
  try {
    const ctxBuilder = await import(path.join(HOME, "dev/merlin/lib/merlin-context.js"));
    const ctx = ctxBuilder.default.build ? ctxBuilder.default.build() : ctxBuilder.build();
    contextJson = JSON.stringify(ctx);
  } catch (e) {
    console.error(`hum-harvest-all: context build failed: ${e.message}`);
  }
  const envelope = JSON.stringify({
    situation: safeParse(situationJson),
    context: safeParse(contextJson),
  });

  const runnable = registry.topics.filter((t) => {
    if (!t.enabled) return false;
    if (onlyTopic && t.name !== onlyTopic) return false;
    if (forceAll) return true;
    if (!inActiveWindow(t.active_window)) return false;
    const ageMin = minutesSince(state[t.name]?.last_run_at);
    if (ageMin < (t.cadence_min ?? 20)) return false;
    return true;
  });

  // Run all in parallel. Web-search harvesters can take longer — give them 150s; rest 15s.
  const results = await Promise.all(runnable.map((t) => {
    const timeout = ["art", "music", "dining", "crossref"].includes(t.name) ? 150000 : 15000;
    return runHarvester(t.name, path.join(HARVESTER_DIR, t.script), envelope, timeout);
  }));

  const candidates = results.filter((r) => r.candidate).map((r) => r.candidate);
  const skipped = registry.topics
    .filter((t) => t.enabled)
    .filter((t) => !runnable.find((r) => r.name === t.name))
    .map((t) => t.name);
  const errors = results.filter((r) => r.err && !r.candidate).map((r) => ({ topic: r.topic, err: r.err }));
  // Distinguish "every harvester ran but produced no signal" (low-signal day,
  // expected) from "harvest pipeline broken" (errors dominate, candidates
  // empty by failure not by signal).
  const harvestEmpty = candidates.length === 0 && runnable.length > 0;
  const allFailed = harvestEmpty && errors.length === runnable.length;

  console.log(JSON.stringify({
    candidates,
    meta: {
      attempted: runnable.map((t) => t.name),
      skipped_cadence: skipped,
      errors,
      harvest_empty: harvestEmpty,
      all_failed: allFailed,
      ts: new Date().toISOString(),
    },
  }));
}

main().catch((e) => {
  console.error(`hum-harvest-all fatal: ${e.message}`);
  console.log(JSON.stringify({ candidates: [], meta: { error: e.message } }));
});
