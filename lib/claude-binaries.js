"use strict";
// claude-binaries — which Claude Code installs sit on a job's PATH, and which one
// a script is about to run. Used by `edva doctor` (check 17, WARN-level) and by
// the scripts that fork `claude -p` themselves. Tests: tests/claude-binaries.test.mjs.
// Why: a months-old Homebrew build once sat ahead of ~/.local/bin/claude on
// every job PATH, and two scripts calling a bare `claude` ran it.
// No spawn in the doctor path: versions come from install paths (or npm's
// package.json); running a stale build to ask its version is the hazard itself
// (2.1.277 fixed a logout caused by an older build running alongside).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const VERSION_SEGMENT = /^\d+\.\d+\.\d+$/; // an install-path segment like "2.1.81", not language
// launchd plist XML: the EnvironmentVariables PATH string (machine structure, not language)
const PLIST_PATH = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/;
const LAUNCHD_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// Non-Edva LaunchAgents on this host that spawn a bare `claude` on their own
// PATH: [{label, what}] from agent/local/config/claude-binaries.json
// `known_dependents` (none by default). Reported only while the plist is
// installed AND its PATH resolves to that install.
const KNOWN_DEPENDENTS = require("./instance.cjs").localConfig("claude-binaries", { known_dependents: [] }).known_dependents;

// A job's lookup order (script-job-env.sh prepends these three), plus the pinned
// ~/.local/bin every call site names, even when cron's bare PATH lacks it.
function candidateDirs(homedir, envPath) {
  const dirs = [`${homedir}/.local/node/bin`, "/opt/homebrew/bin", "/usr/local/bin",
    ...String(envPath || "").split(":"), `${homedir}/.local/bin`];
  return [...new Set(dirs.filter((d) => d && path.isAbsolute(d)))];
}

function versionOf(real, fsImpl) {
  const seg = real.split("/").reverse().find((s) => VERSION_SEGMENT.test(s));
  if (seg) return seg;
  try { return JSON.parse(fsImpl.readFileSync(path.join(path.dirname(real), "package.json"), "utf8")).version || null; }
  catch { return null; }
}

// realpath of the first executable `claude` along dirs, or null
function resolveIn(dirs, fsImpl) {
  for (const dir of dirs) {
    const p = path.join(dir, "claude");
    try {
      const st = fsImpl.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return { path: p, real: fsImpl.realpathSync(p) };
    } catch {}
  }
  return null;
}

// Every distinct install, in lookup order; two names for one file are one
// install. Each carries `usedBy`: known dependents whose own PATH resolves to it.
function findClaudeBinaries({ homedir = os.homedir(), envPath = process.env.PATH, fsImpl = fs, dependents = KNOWN_DEPENDENTS } = {}) {
  const pinnedPath = `${homedir}/.local/bin/claude`;
  const byReal = new Map();
  for (const dir of candidateDirs(homedir, envPath)) {
    const hit = resolveIn([dir], fsImpl);
    if (!hit) continue;
    if (byReal.has(hit.real)) byReal.get(hit.real).paths.push(hit.path);
    else byReal.set(hit.real, { path: hit.path, paths: [hit.path], real: hit.real, version: versionOf(hit.real, fsImpl), usedBy: [] });
  }
  for (const d of dependents) {
    let text;
    try { text = String(fsImpl.readFileSync(`${homedir}/Library/LaunchAgents/${d.label}.plist`, "utf8")); } catch { continue; }
    const m = PLIST_PATH.exec(text);
    if (!m && text.startsWith("bplist")) {   // binary plist: PATH unreadable here, so assume it may
      for (const b of byReal.values()) if (!b.paths.includes(pinnedPath)) b.usedBy.push(`${d.what}, possibly`);
      continue;
    }
    const hit = resolveIn((m ? m[1] : LAUNCHD_DEFAULT_PATH).split(":").filter(Boolean), fsImpl);
    if (hit && byReal.has(hit.real)) byReal.get(hit.real).usedBy.push(d.what);
  }
  const binaries = [...byReal.values()];
  return { binaries, pinnedPath, pinned: binaries.find((b) => b.paths.includes(pinnedPath)) || null };
}

const removalCommand = (b) => (b.real.includes("/Caskroom/claude-code/") ? "brew uninstall --cask claude-code"
  : b.real.includes("/node_modules/@anthropic-ai/claude-code/") ? "npm uninstall -g @anthropic-ai/claude-code" : `rm ${b.path}`);

// `warn` unless exactly one install and it is the pinned one. Never a failure:
// with no call site resolving a bare `claude`, a second copy is a latent hazard.
function describeClaudeBinaries({ binaries, pinnedPath, pinned }, { homedir = os.homedir() } = {}) {
  const tilde = (p) => (p.startsWith(homedir + "/") ? "~" + p.slice(homedir.length) : p);
  const label = (b) => `${tilde(b.path)} ${b.version || "(version unknown)"}`;
  if (!binaries.length) return { warn: true, detail: `no Claude Code found on a job's PATH (expected ${tilde(pinnedPath)})` };
  if (!pinned) return { warn: true, detail: `${tilde(pinnedPath)} is missing, and every call site names it; found only ${binaries.map(label).join(", ")}` };
  if (binaries.length === 1) return { warn: false, detail: `one install: ${label(pinned)}` };
  const listed = binaries.map((b, i) => {
    const notes = [i === 0 && "first on a job's PATH, so a bare `claude` in a job gets this one", b === pinned && "pinned"].filter(Boolean);
    return notes.length ? `${label(b)} (${notes.join("; ")})` : label(b);
  }).join(", ");
  const extras = binaries.filter((b) => b !== pinned).map((b) => (b.usedBy.length
    ? `${tilde(b.path)} is still used by ${b.usedBy.join(" and ")}, so removing it (${removalCommand(b)}) means retiring that too`
      + (b.real.includes("/Caskroom/claude-code/") ? "; upgrading it instead (brew upgrade --cask claude-code) keeps that working without the stale build" : "")
    : `nothing known still uses ${tilde(b.path)}; removing it is an operator step (${removalCommand(b)})`));
  return { warn: true, detail: `${binaries.length} Claude Code installs on a job's PATH: ${listed}. ${extras.join(". ")}.` };
}

// One log line naming the binary about to be forked and its version (key stripped anyway).
function claudeVersionLine(bin, { timeoutMs = 10000 } = {}) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  let version;
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: timeoutMs, env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    version = `version unreadable: ${String(e.message || e).split("\n")[0].slice(0, 100)}`;
  }
  return `claude: ${bin} (${version || "no version output"})`;
}

module.exports = { findClaudeBinaries, describeClaudeBinaries, claudeVersionLine };
