"use strict";
// load-env.js — shared loader for .env (KEY=VALUE lines).
// Used by email-send, phone-channel, and any future tool that needs secrets
// from .env. Matches the same subset of dotenv syntax as the inline
// parsers it replaces: KEY=VALUE per line, # comments, blank lines ignored,
// does NOT override existing process.env values.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENV_PATH = path.join(process.env.HOME, "dev/merlin/.env");

function loadEnv(envPath = DEFAULT_ENV_PATH) {
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // Missing .env is not an error — tools may run without any secrets set.
  }
}

module.exports = { loadEnv, DEFAULT_ENV_PATH };
