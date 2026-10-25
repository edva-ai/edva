// kernel-layout.test.mjs — the kernel finds itself through lib/root.cjs
// (and its shell twin, agent/scripts/lib/root.sh) in either layout, and
// its extension points pick up an installation's own pieces when they exist:
// jobs/_ext/ playbooks, bin/_ext/ or bin/ optional CLIs, cli.d/ subcommands.
// Run: node --test tests/kernel-layout.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { REPO_ROOT, TOOLS_DIR, KERNEL_SUBDIR, installRoot, installTools } from "../lib/root.cjs";
import { optionalBin } from "../lib/ext-hooks.mjs";

const require = createRequire(import.meta.url);
const HERE_TOOLS = path.resolve(import.meta.dirname, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kernel-layout-"));
// The installation under a fake HOME (its spelling follows the distribution).
const IR = path.join("/home/someone", "Dev/edva");

// Copy root.cjs and root.sh into a fake tree whose kernel sits at <dir>/<sub>.
function fakeTree(sub) {
  const dir = tmp();
  const tools = sub ? path.join(dir, sub) : dir;
  fs.mkdirSync(path.join(tools, "lib"), { recursive: true });
  fs.mkdirSync(path.join(tools, "agent/scripts/lib"), { recursive: true });
  const src = fs.readFileSync(path.join(HERE_TOOLS, "lib/root.cjs"), "utf8");
  const line = /^const KERNEL_SUBDIR = "[^"]*";$/m;
  assert.match(src, line, "root.cjs keeps its layout on one line in the documented form");
  fs.writeFileSync(path.join(tools, "lib/root.cjs"), src.replace(line, `const KERNEL_SUBDIR = ${JSON.stringify(sub)};`));
  fs.copyFileSync(path.join(HERE_TOOLS, "agent/scripts/lib/root.sh"), path.join(tools, "agent/scripts/lib/root.sh"));
  return { dir: fs.realpathSync(dir), tools: fs.realpathSync(tools) };
}

const node = (file, env = {}) => JSON.parse(spawnSync(process.execPath, ["-e", `const r = require(${JSON.stringify(file)}); console.log(JSON.stringify({ root: r.REPO_ROOT, tools: r.TOOLS_DIR, ir: r.installRoot(), it: r.installTools("x") }))`], { encoding: "utf8", env: { ...process.env, EDVA_HOME: "", ...env } }).stdout);
const sh = (file, env = {}) => spawnSync("/bin/bash", ["-c", `source "${file}"; printf '%s\\n' "$EDVA_ROOT" "$EDVA_TOOLS" "$EDVA_INSTALL" "$EDVA_INSTALL_TOOLS" "$EDVA_KERNEL_SUBDIR"`], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/home/someone", ...env } }).stdout.trim().split("\n");

test("this checkout: the kernel tree is tools/ under the repo root", () => {
  assert.equal(TOOLS_DIR, HERE_TOOLS);
  assert.equal(path.join(REPO_ROOT, KERNEL_SUBDIR), TOOLS_DIR);
  assert.equal(installTools("data"), path.join(installRoot(), KERNEL_SUBDIR, "data"));
});

test("root.cjs: kernel under <repo>/tools and kernel at the repo root", () => {
  const g = fakeTree("tools");
  assert.deepEqual(node(path.join(g.tools, "lib/root.cjs"), { HOME: "/home/someone" }),
    { root: g.dir, tools: g.tools, ir: IR, it: [IR, "tools", "x"].join("/") });
  const m = fakeTree("");
  const r = node(path.join(m.tools, "lib/root.cjs"), { HOME: "/home/someone" });
  assert.equal(r.root, m.dir);
  assert.equal(r.tools, m.dir);
  assert.equal(r.it, path.join(r.ir, "x"));
});

test("root.cjs: EDVA_HOME is the installation and the checkout", () => {
  const g = fakeTree("tools");
  assert.deepEqual(node(path.join(g.tools, "lib/root.cjs"), { EDVA_HOME: "/srv/g" }),
    { root: "/srv/g", tools: "/srv/g/tools", ir: "/srv/g", it: "/srv/g/tools/x" });
});

test("root.sh agrees with root.cjs in both layouts, reading the layout from root.cjs", () => {
  const g = fakeTree("tools");
  assert.deepEqual(sh(path.join(g.tools, "agent/scripts/lib/root.sh")), [g.dir, g.tools, IR, [IR, "tools"].join("/"), "tools"]);
  const m = fakeTree("");
  assert.deepEqual(sh(path.join(m.tools, "agent/scripts/lib/root.sh")).slice(0, 4), [m.dir, m.dir, IR, IR]);
  assert.deepEqual(sh(path.join(g.tools, "agent/scripts/lib/root.sh"), { EDVA_HOME: "/srv/g" }).slice(0, 4), ["/srv/g", "/srv/g/tools", "/srv/g", "/srv/g/tools"]);
  assert.deepEqual(sh(path.join(g.tools, "agent/scripts/lib/root.sh"), { EDVA_ROOT: "/sandbox" }).slice(0, 2), ["/sandbox", "/sandbox/tools"]);
});

test("optionalBin: env override, then bin/_ext/, then bin/; null when none", () => {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(bin, "_ext"), { recursive: true });
  const exe = (p) => { fs.writeFileSync(p, "#!/bin/sh\n"); fs.chmodSync(p, 0o755); };
  assert.equal(optionalBin(bin, "tool"), null);
  exe(path.join(bin, "tool"));
  assert.equal(optionalBin(bin, "tool"), path.join(bin, "tool"));
  exe(path.join(bin, "_ext", "tool"));
  assert.equal(optionalBin(bin, "tool"), path.join(bin, "_ext", "tool"));
  exe(path.join(dir, "elsewhere"));
  process.env.KERNEL_LAYOUT_TEST_BIN = path.join(dir, "elsewhere");
  try { assert.equal(optionalBin(bin, "tool", "KERNEL_LAYOUT_TEST_BIN"), path.join(dir, "elsewhere")); }
  finally { delete process.env.KERNEL_LAYOUT_TEST_BIN; }
  fs.writeFileSync(path.join(bin, "plain"), "not executable");
  assert.equal(optionalBin(bin, "plain"), null);
});

test("a webhook job's playbook: jobs/<job>.md, else jobs/_ext/<job>.md", async () => {
  const { resolveJobFile } = await import("../agent/supervisor/http-server.mjs");
  const dir = tmp();
  const ext = path.join(dir, "_ext");
  fs.mkdirSync(ext);
  fs.writeFileSync(path.join(dir, "both.md"), "kernel");
  fs.writeFileSync(path.join(ext, "both.md"), "overlay");
  fs.writeFileSync(path.join(ext, "mine.md"), "overlay");
  assert.equal(resolveJobFile("both", { jobsDir: dir, extDir: ext }), path.join(dir, "both.md"));
  assert.equal(resolveJobFile("mine", { jobsDir: dir, extDir: ext }), path.join(ext, "mine.md"));
  assert.equal(resolveJobFile("none", { jobsDir: dir, extDir: ext }), path.join(dir, "none.md"));
});

test("cli.d: an installation's subcommand runs, is listed in help, and never shadows a built-in", () => {
  const dir = tmp();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(bin, "cli.d"), { recursive: true });
  fs.symlinkSync(path.join(HERE_TOOLS, "lib"), path.join(dir, "lib"));
  fs.copyFileSync(path.join(HERE_TOOLS, "bin/edva"), path.join(bin, "edva"));
  fs.writeFileSync(path.join(bin, "cli.d/hello.mjs"),
    'export default { summary: "say hello", usage: "hello <who>", async run(args, ctx) { console.log(`hello ${args[0]} from ${ctx.TOOLS ? "kernel" : "?"}`); } };\n');
  fs.writeFileSync(path.join(bin, "cli.d/status.mjs"), 'export default { summary: "shadow", run() { console.log("SHADOWED"); } };\n');
  fs.writeFileSync(path.join(bin, "cli.d/broken.mjs"), "export default { summary: 'no run' };\n");
  const run = (...a) => spawnSync(process.execPath, [path.join(bin, "edva"), ...a, "--no-color"], { encoding: "utf8", env: { ...process.env, HOME: dir, NO_COLOR: "1" } });
  let r = run("hello", "world");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^hello world from kernel$/m);
  r = run("help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /EXTENSIONS[\s\S]*hello <who>\s+say hello/);
  assert.doesNotMatch(r.stdout, /shadow/);
  assert.match(r.stderr, /cli\.d\/status\.mjs: 'status' is already a subcommand — skipped/);
  assert.match(r.stderr, /cli\.d\/broken\.mjs: no run\(args, ctx\) — skipped/);
  r = run("nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown subcommand: nope/);
});
