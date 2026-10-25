// claude-binaries.test.mjs — which Claude Code a Edva script runs.
// Run: node --test tests/claude-binaries.test.mjs  (CLAUDE_SCAN_ROOT=<clone> rescans another checkout)
// Doctor check on a faked fs; a scan of tracked scripts for bare `claude`. (A
// script run with a decoy `claude` first on PATH: claude-binaries-local.test.mjs.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import mod from "../lib/claude-binaries.js";

const { findClaudeBinaries, describeClaudeBinaries } = mod;
import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const HOME = "/Users/operator";
const BREW = "/opt/homebrew/bin/claude";
const BREW_REAL = "/opt/homebrew/Caskroom/claude-code/2.1.81/claude";
const PINNED = `${HOME}/.local/bin/claude`;
const PINNED_REAL = `${HOME}/.local/share/claude/versions/2.1.285`;
// A made-up third-party LaunchAgent that spawns a bare `claude` (an installation
// lists its own in agent/local/config/claude-binaries.json known_dependents).
const DEPENDENTS = [{ label: "com.example-proxy", what: "the example proxy (LaunchAgent com.example-proxy)" }];
const PROXY_PLIST = `${HOME}/Library/LaunchAgents/com.example-proxy.plist`;
const plist = (p) => `<?xml version="1.0"?><plist><dict><key>EnvironmentVariables</key><dict>\n<key>PATH</key>\n<string>${p}</string></dict></dict></plist>`;

// links: path -> realpath of an executable; plain: non-executable; files: path -> text
const fakeFs = ({ links = {}, plain = [], files = {} } = {}) => ({
  statSync(p) {
    if (Object.hasOwn(links, p)) return { isFile: () => true, mode: 0o755 };
    if (plain.includes(p)) return { isFile: () => true, mode: 0o644 };
    throw new Error(`ENOENT ${p}`);
  },
  realpathSync(p) { if (Object.hasOwn(links, p)) return links[p]; throw new Error(`ENOENT ${p}`); },
  readFileSync(p) { if (Object.hasOwn(files, p)) return files[p]; throw new Error(`ENOENT ${p}`); },
});
const check = (fsImpl, envPath = "/usr/bin:/bin") =>
  describeClaudeBinaries(findClaudeBinaries({ homedir: HOME, envPath, fsImpl, dependents: DEPENDENTS }), { homedir: HOME });
const BOTH = { [BREW]: BREW_REAL, [PINNED]: PINNED_REAL };

describe("doctor: one Claude Code on a job's PATH", () => {
  it("two copies, a stale one first on PATH: warns, says which one a job gets, and that the proxy still needs Homebrew's", () => {
    const fsImpl = fakeFs({ links: BOTH, files: { [PROXY_PLIST]: plist("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin") } });
    const r = findClaudeBinaries({ homedir: HOME, envPath: "/usr/bin:/bin", fsImpl, dependents: DEPENDENTS });
    assert.deepEqual(r.binaries.map((b) => [b.path, b.version]), [[BREW, "2.1.81"], [PINNED, "2.1.285"]]);
    const v = check(fsImpl);
    assert.equal(v.warn, true);
    for (const s of ["/opt/homebrew/bin/claude 2.1.81 (first on a job's PATH, so a bare `claude` in a job gets this one)",
      "~/.local/bin/claude 2.1.285 (pinned)", "still used by the example proxy", "means retiring that too", "brew upgrade --cask claude-code"]) {
      assert.ok(v.detail.includes(s), v.detail);
    }
  });

  it("without the proxy (or with its PATH on the pinned copy) the removal is a plain operator step", () => {
    for (const files of [{}, { [PROXY_PLIST]: plist(`${HOME}/.local/bin:/usr/bin`) }]) {
      const v = check(fakeFs({ links: BOTH, files }));
      assert.ok(!v.detail.includes("proxy"), v.detail);
      assert.ok(v.detail.includes("operator step (brew uninstall --cask claude-code)"), v.detail);
    }
  });

  it("is quiet once the Homebrew copy is gone, and with two names for one file", () => {
    assert.deepEqual(check(fakeFs({ links: { [PINNED]: PINNED_REAL } })), { warn: false, detail: "one install: ~/.local/bin/claude 2.1.285" });
    assert.equal(check(fakeFs({ links: { [PINNED]: PINNED_REAL, "/usr/local/bin/claude": PINNED_REAL } })).warn, false);
    assert.equal(check(fakeFs({ links: { [PINNED]: PINNED_REAL }, plain: [BREW] })).warn, false, "a non-executable file is not an install");
  });

  it("finds an npm install on the inherited PATH and reads its package.json", () => {
    const cli = "/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    const files = { [path.join(path.dirname(cli), "package.json")]: JSON.stringify({ version: "2.0.9" }) };
    const v = check(fakeFs({ links: { "/opt/node/bin/claude": cli, [PINNED]: PINNED_REAL }, files }), "/opt/node/bin:/usr/bin");
    assert.ok(v.warn && v.detail.includes("/opt/node/bin/claude 2.0.9") && v.detail.includes("npm uninstall -g @anthropic-ai/claude-code"), v.detail);
  });

  it("warns when the pinned install is missing, even with only one copy", () => {
    const v = check(fakeFs({ links: { [BREW]: BREW_REAL } })); assert.ok(v.warn && v.detail.includes("~/.local/bin/claude is missing"), v.detail);
  });
});

// (This installation's daily-summary-review honouring CLAUDE_BIN: claude-binaries-local.test.mjs.)

// Tracked files only (never agent/logs or untracked); 200 bytes decide the kind; only scripts are read whole.
describe("no Edva script spawns a bare `claude`", () => {
  const scanRoot = process.env.CLAUDE_SCAN_ROOT || ROOT;
  const tracked = execFileSync("git", ["-C", scanRoot, "ls-files", "-z", "--", "bin", "lib", "agent"], { encoding: "utf8" })
    .split("\0").filter((f) => f && !f.includes("node_modules/") && !f.includes("/logs/") && !f.includes("/data/"));
  const kind = (rel) => {
    if (/\.(m|c)?js$/.test(rel)) return "js";
    if (/\.(sh|bash|zsh)$/.test(rel)) return "sh";
    if (path.extname(rel)) return null;   // .md, .json, .plist, .py ... skipped on the name alone
    let head = "", fd;
    try { fd = fs.openSync(path.join(scanRoot, rel), "r"); const b = Buffer.alloc(200); head = b.toString("utf8", 0, fs.readSync(fd, b, 0, 200, 0)).split("\n")[0]; }
    catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (/^#!.*\bnode\b/.test(head)) return "js";
    if (/^#!.*\b(ba|z)?sh\b/.test(head)) return "sh";
    return null;
  };
  const byKind = { js: [], sh: [] };
  for (const rel of tracked) { const k = kind(rel); if (k) byKind[k].push(rel); }
  const scan = (list, bare, isComment) => list.flatMap((rel) => {
    let text = "";
    try { text = fs.readFileSync(path.join(scanRoot, rel), "utf8"); } catch { return []; }
    return text.split("\n").map((line, i) => (!isComment(line.trimStart()) && bare.test(line) ? `${rel}:${i + 1}` : null)).filter(Boolean);
  });

  it("JS: no execFile/spawn/exec of a bare \"claude\"", () => {
    const bare = /\b(execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*["'`]claude[\s"'`]/;
    assert.deepEqual(scan(byKind.js, bare, (t) => t.startsWith("//") || t.startsWith("*")), [],
      // kernel-closure-ok: an example named in the failure message, not a dependency
      "use CLAUDE_BIN || ~/.local/bin/claude (lib/max-judge.js)");
  });

  it("shell: no bare `claude -p` / `claude auth` command", () => {
    const bare = /(^|[;&|]|\$\(|\bexec|\bnohup)\s*claude\s+(-p|--print|auth|--version)\b/;
    assert.deepEqual(scan(byKind.sh, bare, (t) => t.startsWith("#")), [], "use \"${CLAUDE_BIN:-$HOME/.local/bin/claude}\"");
  });
});
