"use strict";
// models.cjs — node reader for agent/config/models.env, the single place
// Edva's model ids are pinned (2026-10-06). See that file for the why and for
// what is not wired yet. CommonJS so both `require` (CJS bins) and ESM
// (`createRequire`, or a default import) can use it.
//
//   const { MODELS } = require("../lib/models.cjs");
//   MODELS.opus   // "claude-opus-5-5"
//   MODELS.sonnet // "claude-sonnet-5-5"
//
// No fallback ids in code on purpose: a missing or unreadable file throws at
// load, loudly, instead of silently running whatever id was last hard-coded.

const fs = require("node:fs");
const path = require("node:path");

const MODELS_ENV = path.join(__dirname, "../agent/config/models.env");

function parseModelsEnv(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function loadModels(file = MODELS_ENV) {
  const env = parseModelsEnv(fs.readFileSync(file, "utf8"));
  const pick = (key) => {
    const v = env[key];
    if (!v) throw new Error(`models.cjs: ${key} missing from ${file}`);
    return v;
  };
  return Object.freeze({ opus: pick("EDVA_MODEL_OPUS"), sonnet: pick("EDVA_MODEL_SONNET") });
}

const MODELS = loadModels();

module.exports = { MODELS, loadModels, parseModelsEnv, MODELS_ENV };
