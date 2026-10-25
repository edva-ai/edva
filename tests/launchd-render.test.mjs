// launchd-render.test.mjs — the kernel's launchd plists are templates
// (__EDVA_HOME__ / __EDVA_TOOLS__ / __HOME__) and render into complete, machine-specific
// plists; agent/launch-agents/install.sh renders the same thing.
// Run: node --test tests/launchd-render.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { REPO_ROOT as REPO, KERNEL_SUBDIR } from "../lib/root.cjs";
const LIB = path.join(REPO, "agent/scripts/lib/launchd-render.sh");
const INSTALL = path.join(REPO, "agent/launch-agents/install.sh");
// The kernel's plists: the manifest's list where the checkout has one (an
// installation keeps its own plists in the same directory), else every plist
// in the directory.
const AGENTS_DIR = "agent/launch-agents";
const MANIFEST_FILE = path.join(REPO, "system/kernel-manifest.json");
const KERNEL_PLISTS = fs.existsSync(MANIFEST_FILE)
  ? Object.keys(JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).files).filter((f) => f.startsWith(`${AGENTS_DIR}/`) && f.endsWith(".plist"))
  : fs.readdirSync(path.join(REPO, AGENTS_DIR)).filter((f) => f.endsWith(".plist")).map((f) => `${AGENTS_DIR}/${f}`);
const HOME = "/Users/someone";

function render(rel, env = {}) {
  const r = spawnSync("/bin/bash", ["-c", `source "${LIB}"; launchd_render_plist "$1" -`, "x", path.join(REPO, rel)],
    { encoding: "utf8", env: { ...process.env, HOME, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("the kernel ships launchd plists as templates", () => {
  assert.ok(KERNEL_PLISTS.length > 0);
  for (const rel of KERNEL_PLISTS) {
    const text = fs.readFileSync(path.join(REPO, rel), "utf8");
    assert.doesNotMatch(text, /\/Users\/[^_<\s]/, `${rel} holds a machine path`);
    assert.match(text, /__EDVA_(HOME|TOOLS)__/, `${rel} is not a template`);
  }
});

test("a rendered plist has no placeholder left and points at the checkout under $HOME", () => {
  for (const rel of KERNEL_PLISTS) {
    const out = render(rel);
    assert.doesNotMatch(out, /__EDVA_HOME__|__EDVA_TOOLS__|__HOME__/, rel);
    const label = path.basename(rel, ".plist");
    assert.match(out, new RegExp(`<key>Label</key>\\s*<string>${label.replace(/\./g, "\\.")}</string>`), rel);
    const install = `${HOME}/Dev/edva`, kernel = path.join(install, KERNEL_SUBDIR);
    assert.ok(out.includes(`${kernel}/`), rel);
    // Nothing but the placeholders changes.
    const template = fs.readFileSync(path.join(REPO, rel), "utf8");
    assert.equal(out, template.replaceAll("__EDVA_TOOLS__", kernel).replaceAll("__EDVA_HOME__", install).replaceAll("__HOME__", HOME), rel);
  }
});

test("EDVA_LAUNCHD_ROOT points the plists at another checkout", () => {
  const out = render(KERNEL_PLISTS[0], { EDVA_LAUNCHD_ROOT: "/opt/a&b#c" });
  assert.ok(out.includes(`${path.join("/opt/a&b#c", KERNEL_SUBDIR)}/`), "the kernel paths follow the other checkout");
});

test("install.sh --dry-run prints the rendered plist and touches nothing", () => {
  const label = path.basename(KERNEL_PLISTS[0], ".plist");
  const r = spawnSync("/bin/bash", [INSTALL, "--dry-run", label], { encoding: "utf8", env: { ...process.env, HOME } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, render(KERNEL_PLISTS[0]));
});

test("install.sh refuses an unknown label", () => {
  const r = spawnSync("/bin/bash", [INSTALL, "--dry-run", "ai.claude.no-such-agent"], { encoding: "utf8", env: { ...process.env, HOME } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no plist/);
});
