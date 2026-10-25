"use strict";
// root.cjs — where the kernel lives, for every kernel module, bin and test.
//
// Kernel code never finds the repo by counting `..` from its own file, and
// never spells the kernel's position inside the repo: this installation keeps
// the kernel under <repo>/<KERNEL_SUBDIR>/, and a published copy may keep the
// same files at its repo root, so a depth that is right in one is one level off
// in the other. Ask here instead.
//
// Two roots, kept apart because callers mean different things:
//
//   REPO_ROOT / TOOLS_DIR  the checkout this code is running from (a worktree,
//                          a CI clone, the live install). Fixed at load.
//                          TOOLS_DIR is the kernel tree: lib/, bin/, agent/, ...
//   installRoot() /        the installation under the operator's HOME
//   installTools(...p)     (~/Dev/edva), where the running system keeps its
//                          state. Read per call, so a test that points HOME at
//                          a sandbox sees it.
//
// EDVA_HOME, when set, is the installation and the checkout both.
//
// Paths below the kernel tree are joined onto TOOLS_DIR / installTools() with
// their kernel-relative spelling ("agent/logs", "bin/foo"), never with a
// leading "tools/" — that spelling is the same in every layout.
//
// The shell twin is agent/scripts/lib/root.sh (it reads KERNEL_SUBDIR
// from this file, so the layout is written down once).

const os = require("node:os");
const path = require("node:path");

// LAYOUT — the one layout-specific line in the kernel: the kernel tree's
// directory under the repo root. The publishing sync rewrites it to
// `const KERNEL_SUBDIR = "";` for a copy whose kernel is its repo root (see
// architecture.md § Kernel boundary). Keep it on one line, in exactly this form.
const KERNEL_SUBDIR = "";

// This file sits in <kernel>/lib/ in every layout.
const CODE_TOOLS = path.resolve(__dirname, "..");
const CODE_ROOT = KERNEL_SUBDIR ? path.resolve(CODE_TOOLS, path.relative(KERNEL_SUBDIR, ".")) : CODE_TOOLS;

const ENV_HOME = process.env.EDVA_HOME ? path.resolve(process.env.EDVA_HOME) : "";

const REPO_ROOT = ENV_HOME || CODE_ROOT;
const TOOLS_DIR = ENV_HOME ? path.join(ENV_HOME, KERNEL_SUBDIR) : CODE_TOOLS;

function toolsPath(...segments) {
  return path.join(TOOLS_DIR, ...segments);
}

function installRoot() {
  return process.env.EDVA_HOME || path.join(os.homedir(), "Dev/edva");
}

function installTools(...segments) {
  return path.join(installRoot(), KERNEL_SUBDIR, ...segments);
}

// The node binary to run kernel scripts with: $EDVA_NODE, else a stable
// package-manager path when one exists (a symlink that survives a node upgrade,
// unlike the versioned binary a long-lived process was started from), else the
// running interpreter. The shell twin is EDVA_NODE in root.sh.
const NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
function nodeBin() {
  if (process.env.EDVA_NODE) return process.env.EDVA_NODE;
  const fs = require("node:fs");
  for (const p of NODE_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return process.execPath;
}

module.exports = { KERNEL_SUBDIR, REPO_ROOT, TOOLS_DIR, toolsPath, installRoot, installTools, nodeBin };

// `node lib/root.cjs [--sh]`: print the roots (debugging; --sh as
// shell assignments).
if (require.main === module) {
  const vals = { REPO_ROOT, TOOLS_DIR, INSTALL_ROOT: installRoot(), INSTALL_TOOLS: installTools(), KERNEL_SUBDIR, NODE: nodeBin() };
  for (const [k, v] of Object.entries(vals)) process.stdout.write(process.argv[2] === "--sh" ? `${k}=${JSON.stringify(v)}\n` : `${k.padEnd(14)} ${v}\n`);
}
