"use strict";
// load-env.js — shared loader for .env (KEY=VALUE lines).
// Used by email-send, phone-channel, and any future tool that needs secrets
// from .env. Matches the same subset of dotenv syntax as the inline
// parsers it replaces: KEY=VALUE per line, # comments, blank lines ignored,
// does NOT override existing process.env values.
//
// Inside a test run it never hands out the live send credential — see
// "Test runs" below.

const fs = require("node:fs");
const path = require("node:path");

const { installTools } = require("./root.cjs");
const DEFAULT_ENV_PATH = installTools(".env");

// ── Test runs ──────────────────────────────────────────────────────────────
// `node --test` sets NODE_TEST_CONTEXT in every test process, and whatever a
// test spawns inherits it unless the test hands the child a fresh env. A chat
// writer started from a test that finds the live service-role key (in
// .env, or inherited from an agent whose environment carries .env)
// posts the test's fake lines into the user's real chat.
//
// So inside a test run loadEnv() never lets the live service-role key into
// process.env: it skips the key when reading the file, and drops one the
// process inherited when it is a real credential by shape (a test's own stand-in
// such as "fake" or "test-key" is left alone). The chat writers that do not
// load through here refuse on their own: bin/edva-send-curl,
// bin/edva-send.mjs, the chat supervisor's safety net, and APNs
// (lib/apns-push.mjs sendOne). Outside a test run nothing changes.
//
// Not covered: a test file run directly (`node x.test.mjs`) or with
// --test-isolation=none, and a child given a hand-built env without
// NODE_TEST_CONTEXT — none of those carry the variable.
const WITHHELD_IN_TEST_RUNS = ["SUPABASE_SERVICE_ROLE_KEY"];

function underTestRunner(env = process.env) {
  return Boolean(env.NODE_TEST_CONTEXT);
}

// True for a live Supabase service-role secret, judged by its machine shape:
// a new-style `sb_secret_` key, or a JWT whose payload carries
// role "service_role" (the legacy key).
function isLiveServiceRoleKey(value) {
  const v = String(value || "").trim();
  if (v.startsWith("sb_secret_")) return true;
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role === "service_role";
  } catch {
    return false;
  }
}

function loadEnv(envPath = DEFAULT_ENV_PATH) {
  const testRun = underTestRunner();
  if (testRun) {
    for (const k of WITHHELD_IN_TEST_RUNS) if (isLiveServiceRoleKey(process.env[k])) delete process.env[k];
  }
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && testRun && WITHHELD_IN_TEST_RUNS.includes(m[1])) continue;
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // Missing .env is not an error — tools may run without any secrets set.
  }
}

module.exports = { loadEnv, DEFAULT_ENV_PATH, underTestRunner, isLiveServiceRoleKey, WITHHELD_IN_TEST_RUNS };
