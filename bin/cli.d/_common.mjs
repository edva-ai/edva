// _common.mjs — helpers shared by Edva's own `edva` subcommands in
// bin/cli.d/. The leading underscore keeps bin/edva from loading this file
// as a subcommand (bin/cli.d/README.md).
//
// Roots: the CLI's ctx.ROOT is the installation (lib/root.cjs installRoot():
// $EDVA_HOME, else ~/Dev/edva). Commands that set up or inspect a checkout
// (init, overlay, audit, review-pr) work on the checkout this CLI runs from
// instead — CHECKOUT below (EDVA_HOME when set, else the clone holding this
// file) — so `./bin/edva init` in a fresh clone configures that clone.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = require(path.join(HERE, "..", "..", "lib", "root.cjs"));

export const CHECKOUT = root.REPO_ROOT;      // the clone (or EDVA_HOME)
export const KERNEL = root.TOOLS_DIR;        // its kernel tree (same dir in Edva)
export const installRoot = root.installRoot;

// Parse a dotenv file into an object (KEY=value lines; # comments; optional
// surrounding quotes). Missing file → {}.
export function readDotEnv(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Set (or add) KEY=value in a dotenv file, keeping every other line as it is.
export function setDotEnv(file, key, value) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { /* new file */ }
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, entry);
    else lines.push(entry);
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// The supervisors' shared webhook token (supervisor/http-server.mjs checkAuth):
// secrets/webhook-token, else WEBHOOK_TOKEN from the environment or .env.
export function webhookToken(base) {
  try {
    const t = fs.readFileSync(path.join(base, "secrets", "webhook-token"), "utf8").trim();
    if (t) return t;
  } catch { /* fall through */ }
  if (process.env.WEBHOOK_TOKEN) return process.env.WEBHOOK_TOKEN;
  return readDotEnv(path.join(base, ".env")).WEBHOOK_TOKEN || null;
}

export function isHelp(args) {
  return args[0] === "help" || args.includes("--help") || args.includes("-h");
}
