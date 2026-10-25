"use strict";
// instance.cjs — who and where this installation is, and per-instance config.
//
// Kernel code never hard-codes the operator's identity, accounts, hosts, time
// zone or personal lists. It asks this module, which layers (later wins):
//   1. the generic default passed by the caller,
//   2. agent/local/instance.json / agent/local/config/<name>.json
//      (the operator's own values; tracked in a private install, absent in a
//      fresh one),
//   3. environment variables (EDVA_OWNER_EMAIL, EDVA_TZ, …), so a host
//      or a test can override without editing files.
// EDVA_LOCAL_DIR points the local dir elsewhere (tests).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT: ROOT, TOOLS_DIR } = require("./root.cjs");

function localDir() {
  return process.env.EDVA_LOCAL_DIR || path.join(TOOLS_DIR, "agent", "local");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file}: ${e.message}`);
  }
}

// Instance identity. Keys and the env var that overrides each one.
const INSTANCE_KEYS = {
  owner_name: "EDVA_OWNER_NAME",
  owner_id: "EDVA_OWNER_ID",
  owner_email: "EDVA_OWNER_EMAIL",
  agent_email: "EDVA_AGENT_FROM_EMAIL",
  domain: "EDVA_DOMAIN",
  tz: "EDVA_TZ",
  host: "EDVA_HOST",
  host_label: "EDVA_HOST_LABEL",
  host_title: "EDVA_HOST_TITLE",
  supabase_project: "EDVA_SUPABASE_PROJECT",
  gcp_project: "EDVA_GCP_PROJECT",
  github_owner: "EDVA_OWNER",
};

const INSTANCE_DEFAULTS = {
  owner_name: "the user",
  owner_id: "",
  owner_email: "",
  agent_email: "",
  domain: "",
  tz: "",
  host: "",
  // How alerts and replies name the machine the agents run on: in a sentence
  // ("… is not loaded on the host") and at the start of one ("Host disk space low").
  host_label: "the host",
  host_title: "Host",
  supabase_project: "",
  gcp_project: "",
  github_owner: "",
};

function hostTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The identifier form of an owner name: lowercase, a leading "the" dropped,
// every other run of non-alphanumerics an underscore ("the user" → "user").
function ownerIdOf(name) {
  return String(name || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "user";
}

// instance() → the merged identity object. `tz` always resolves to a zone
// (local value, else the host's zone, else UTC). `owner_id` is the owner as an
// identifier, used where a stored or external name embeds the owner (a Jev
// question key `needs_<owner_id>`, an idea scope `manual_<owner_id>`, a Jev
// state key `<owner_id>_said`), so an installation keeps the names its data
// already uses; when not set it is derived from owner_name.
function instance() {
  const file = readJson(path.join(localDir(), "instance.json")) || {};
  const out = { ...INSTANCE_DEFAULTS };
  for (const k of Object.keys(INSTANCE_KEYS)) {
    if (file[k] != null && file[k] !== "") out[k] = file[k];
    const envName = INSTANCE_KEYS[k];
    if (process.env[envName]) out[k] = process.env[envName];
  }
  if (!out.tz) out.tz = hostTz();
  if (!out.owner_id) out.owner_id = ownerIdOf(out.owner_name);
  return out;
}

function instanceValue(key) {
  if (!(key in INSTANCE_KEYS)) throw new Error(`unknown instance key: ${key}`);
  return instance()[key];
}

// localConfig(name, defaults) → defaults shallow-merged with
// agent/local/config/<name>.json. Arrays in the local file replace the
// default arrays; use `extend_<key>` in the local file to append instead.
function localConfig(name, defaults = {}) {
  const file = readJson(path.join(localDir(), "config", `${name}.json`));
  const out = { ...defaults };
  if (!file) return out;
  for (const [k, v] of Object.entries(file)) {
    if (k.startsWith("_")) continue;
    if (k.startsWith("extend_")) {
      const base = k.slice("extend_".length);
      out[base] = [...(Array.isArray(out[base]) ? out[base] : []), ...(Array.isArray(v) ? v : [v])];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// The REST base of this installation's Supabase project
// (https://<supabase_project>.supabase.co), or "" when none is configured.
// Callers let SUPABASE_URL win over it, as before.
function supabaseUrl() {
  const project = instanceValue("supabase_project");
  return project ? `https://${project}.supabase.co` : "";
}

// This installation's Supabase public anon key (row-level-security protected),
// from agent/local/config/supabase.json `anon_key`; "" when none. One
// home for every reader (context-sync, edva-notify).
function supabaseAnonKey() {
  return localConfig("supabase", { anon_key: "" }).anon_key || "";
}

// Claude Code keeps each project's sessions and auto-memory under
// ~/.claude/projects/<slug>, where the slug is the absolute path the sessions
// are started from with every non-alphanumeric character replaced by "-".
// Edva's sessions start from ~/Dev/edva (EDVA_PROJECT_DIR overrides).
function claudeProjectSlug(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, "-");
}

function claudeProjectDir(sub = "") {
  const home = os.homedir();
  const project = process.env.EDVA_PROJECT_DIR || path.join(home, "Dev", "edva");
  return path.join(home, ".claude", "projects", claudeProjectSlug(sub ? path.join(project, sub) : project));
}

// The auto-memory dir (memory pages): ~/.claude/projects/<slug>/memory.
function claudeMemoryDir() {
  return path.join(claudeProjectDir(), "memory");
}

module.exports = {
  ROOT, localDir, instance, instanceValue, localConfig, INSTANCE_KEYS, hostTz, supabaseUrl, supabaseAnonKey, ownerIdOf,
  claudeProjectSlug, claudeProjectDir, claudeMemoryDir,
};

// CLI for shell scripts:  node lib/instance.cjs <key>   (prints value)
//                         node lib/instance.cjs --env   (KEY=value lines)
//                         node lib/instance.cjs --memory-dir
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--memory-dir") {
    process.stdout.write(claudeMemoryDir() + "\n");
  } else if (arg === "--env") {
    const inst = instance();
    for (const [k, envName] of Object.entries(INSTANCE_KEYS)) {
      process.stdout.write(`${envName}=${JSON.stringify(String(inst[k] ?? ""))}\n`);
    }
  } else if (arg) {
    process.stdout.write(String(instanceValue(arg)) + "\n");
  } else {
    process.stdout.write(JSON.stringify(instance(), null, 2) + "\n");
  }
}
