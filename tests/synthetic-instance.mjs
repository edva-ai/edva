// synthetic-instance.mjs — run a test against a made-up installation, not the
// one whose checkout it runs in. Not a test file.
//
// Import it FIRST, before the module under test (ES modules evaluate their
// imports in order, so a module that reads instance() / localConfig() at load
// time sees this):
//
//   import { LOCAL_DIR, SYNTHETIC, writeLocalConfig } from "./synthetic-instance.mjs";
//
// It points EDVA_LOCAL_DIR (lib/instance.cjs) at a fresh temp dir
// holding SYNTHETIC as instance.json, and clears the EDVA_* identity
// overrides, so the test sees the same identity in every checkout (a private
// installation with its own agent/local/, or a fresh one without) and
// child processes inherit it. writeLocalConfig(name, obj) adds a
// config/<name>.json; writeLocalFile(rel, text) any other local file (a
// local rules file, say). The dir is removed at exit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const SYNTHETIC = Object.freeze({
  owner_name: "the user",
  owner_id: "user",
  owner_email: "owner@example.com",
  agent_email: "agent@example.com",
  domain: "example.com",
  tz: "UTC",
  host: "test-host",
});

export const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-instance-"));
fs.mkdirSync(path.join(LOCAL_DIR, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL_DIR, "instance.json"), JSON.stringify(SYNTHETIC, null, 1));

process.env.EDVA_LOCAL_DIR = LOCAL_DIR;
for (const env of Object.values(createRequire(import.meta.url)("../lib/instance.cjs").INSTANCE_KEYS)) delete process.env[env];

export function writeLocalConfig(name, obj) {
  fs.writeFileSync(path.join(LOCAL_DIR, "config", `${name}.json`), JSON.stringify(obj, null, 1));
}

export function writeLocalFile(rel, text) {
  const f = path.join(LOCAL_DIR, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

process.on("exit", () => { try { fs.rmSync(LOCAL_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });
