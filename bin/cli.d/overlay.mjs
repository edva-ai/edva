// edva overlay — attach a private overlay repo to this checkout.
//
// An installation's own rules, config and code live outside the public tree:
// in agent/local/ (identity, local rules, config, registries — read by
// lib/instance.cjs, lib/registry.cjs and the supervisors) and in the `_ext/`
// hook and drop directories next to the kernel code that loads them. Both are
// gitignored here. Keep them in a private repo and let this command symlink
// them in:
//
//   <overlay>/local/**                  → agent/local/**
//   <overlay>/<kernel-dir>/_ext/**      → <kernel-dir>/_ext/**   (any _ext dir
//                                         whose parent exists in this checkout,
//                                         e.g. lib/_ext/presence.mjs,
//                                         agent/supervisor/_ext/routes.mjs,
//                                         browsing-skills/skills/_ext/<site>/...)
//   shorthand, for overlays laid out flat:
//   <overlay>/jobs/*        → agent/ops-agent/jobs/_ext/*
//   <overlay>/harvesters/*  → agent/scripts/hum-harvesters/_ext/*
//   <overlay>/sensors/*     → agent/scripts/hum-sensors/_ext/*
//   <overlay>/tools-mcp/*   → agent/tools-mcp/_ext/*
//   <overlay>/bin/*         → bin/_ext/*
//
// Files are linked one by one (directories are created for real), so a
// kernel `.gitkeep` is never shadowed and an overlay file going missing only
// breaks its own link. Nothing outside agent/local/ and `_ext/` dirs is ever
// written, a real (non-symlink) file is never replaced, and the overlay repo
// itself is never modified. Registered overlays are kept in
// data/.overlay-registry.json.

import fs from "node:fs";
import path from "node:path";
import { CHECKOUT, isHelp } from "./_common.mjs";

const REGISTRY = () => path.join(CHECKOUT, "data", ".overlay-registry.json");

const SHORTHAND = {
  jobs: "agent/ops-agent/jobs/_ext",
  harvesters: "agent/scripts/hum-harvesters/_ext",
  sensors: "agent/scripts/hum-sensors/_ext",
  "tools-mcp": "agent/tools-mcp/_ext",
  bin: "bin/_ext",
};

const SKIP_NAMES = new Set([".git", ".github", "node_modules", ".DS_Store", "README.md", "LICENSE"]);

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY(), "utf8")); } catch { return { overlays: [] }; }
}
function writeRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY()), { recursive: true });
  fs.writeFileSync(REGISTRY(), JSON.stringify(reg, null, 2) + "\n");
}

function walkFiles(dir, rel = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name) || e.name.startsWith(".")) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
  return out;
}

// Where a path in the overlay lands in the checkout, or null when it is not
// part of the extension surface.
export function targetFor(rel) {
  const parts = rel.split(path.sep);
  if (parts[0] === "local" && parts.length > 1) return path.join("agent", "local", ...parts.slice(1));
  const ext = parts.indexOf("_ext");
  if (ext > 0 && ext < parts.length - 1) {
    const parent = parts.slice(0, ext).join(path.sep);
    // The _ext dir must sit in an existing kernel directory: an overlay can
    // extend the kernel, never add new top-level trees to it.
    if (!fs.existsSync(path.join(CHECKOUT, parent))) return null;
    return rel;
  }
  if (SHORTHAND[parts[0]] && parts.length > 1) return path.join(SHORTHAND[parts[0]], ...parts.slice(1));
  return null;
}

function allowed(target) {
  const abs = path.resolve(CHECKOUT, target);
  if (!abs.startsWith(path.resolve(CHECKOUT) + path.sep)) return false;
  const rel = path.relative(CHECKOUT, abs).split(path.sep);
  return (rel[0] === "agent" && rel[1] === "local") || rel.includes("_ext");
}

export function planLinks(overlayRoot) {
  const plan = [];
  const ignored = [];
  for (const rel of walkFiles(overlayRoot)) {
    const target = targetFor(rel);
    if (!target || !allowed(target)) { ignored.push(rel); continue; }
    plan.push({ from: path.join(overlayRoot, rel), to: path.join(CHECKOUT, target) });
  }
  return { plan, ignored };
}

function applyPlan(plan, c, { dryRun = false } = {}) {
  const made = [];
  for (const link of plan) {
    let existing = null;
    try { existing = fs.lstatSync(link.to); } catch { /* absent */ }
    if (existing) {
      if (existing.isSymbolicLink() && fs.readlinkSync(link.to) === link.from) continue;
      if (!existing.isSymbolicLink()) {
        console.error(c.yellow("  refuse: ") + `${path.relative(CHECKOUT, link.to)} is a real file — leaving it alone`);
        continue;
      }
      if (!dryRun) fs.unlinkSync(link.to);
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(link.to), { recursive: true });
      fs.symlinkSync(link.from, link.to);
    }
    made.push(link);
  }
  return made;
}

// Every symlink under agent/local/ and the _ext/ dirs that points into root.
function linksInto(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "data") continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const rel = path.relative(CHECKOUT, full);
        if (!allowed(rel)) continue;
        const t = fs.readlinkSync(full);
        if (t === root || t.startsWith(root + path.sep)) out.push(full);
      } else if (e.isDirectory()) visit(full);
    }
  };
  visit(CHECKOUT);
  return out;
}

function resolveOverlay(arg, HOME) {
  return path.resolve(String(arg).replace(/^~(?=$|\/)/, HOME));
}

function help(c) {
  console.log(c.bold("edva overlay") + " — link a private overlay repo into agent/local/ and the _ext/ dirs\n");
  console.log("Usage:");
  console.log("  edva overlay add <path> [--dry-run]   register an overlay and link its files");
  console.log("  edva overlay status                   registered overlays and the state of each link");
  console.log("  edva overlay sync                     re-link every registered overlay (after it changed)");
  console.log("  edva overlay remove <path>            unlink an overlay (the overlay repo is untouched)\n");
  console.log("Overlay layout (paths mirror this checkout):");
  console.log("  local/instance.json, local/shared.md, local/config/<name>.json, ...  → agent/local/");
  console.log("  lib/_ext/presence.mjs, agent/supervisor/_ext/routes.mjs, ...       → same path here");
  console.log("  jobs/ harvesters/ sensors/ tools-mcp/ bin/   (shorthand for the matching _ext/ dir)\n");
  console.log("Only agent/local/ and _ext/ dirs are written; real files are never replaced.");
  console.log("Contract: docs/architecture-public-private.md.");
}

export default {
  summary: "link a private overlay repo into agent/local/ + _ext/ (see: overlay help)",
  usage: "overlay <subcmd>",
  async run(args, ctx) {
    const { c, die, hasFlag, HOME } = ctx;
    const sub = args[0];
    if (!sub || isHelp(args)) { help(c); return; }

    if (sub === "add") {
      const target = args.find((a, i) => i > 0 && !a.startsWith("--"));
      if (!target) die("usage: edva overlay add <path-to-overlay-repo> [--dry-run]");
      const root = resolveOverlay(target, HOME);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`overlay path not found: ${root}`);
      if (root === path.resolve(CHECKOUT) || root.startsWith(path.resolve(CHECKOUT) + path.sep)) die("the overlay must live outside this checkout");
      const dryRun = hasFlag(args, "--dry-run");
      const { plan, ignored } = planLinks(root);
      if (!plan.length) {
        console.log(c.yellow(`  nothing to link — ${root} has no local/, */_ext/, jobs/, harvesters/, sensors/, tools-mcp/ or bin/ files`));
        return;
      }
      if (!dryRun) {
        const reg = readRegistry();
        if (!reg.overlays.some((o) => o.path === root)) {
          reg.overlays.push({ path: root, added_at: new Date().toISOString() });
          writeRegistry(reg);
        }
      }
      const made = applyPlan(plan, c, { dryRun });
      console.log(c.green(`  ✓ ${dryRun ? "would link" : "linked"} ${made.length} file(s) from ${root}`) + (dryRun ? "" : c.dim(" (registered)")));
      for (const l of made) console.log(c.dim(`      ${path.relative(CHECKOUT, l.to)}  →  ${path.relative(root, l.from)}`));
      if (ignored.length) console.log(c.dim(`  ignored ${ignored.length} file(s) outside the extension surface (e.g. ${ignored.slice(0, 3).join(", ")})`));
      return;
    }

    if (sub === "sync") {
      const reg = readRegistry();
      if (!reg.overlays.length) { console.log(c.dim("  no overlays registered. Use: edva overlay add <path>")); return; }
      for (const o of reg.overlays) {
        if (!fs.existsSync(o.path)) { console.log(c.yellow(`  ! ${o.path}: not found — skipped`)); continue; }
        const made = applyPlan(planLinks(o.path).plan, c);
        console.log(c.green(`  ✓ ${o.path}: ${made.length} link(s) created or updated`));
      }
      return;
    }

    if (sub === "status") {
      const reg = readRegistry();
      if (!reg.overlays.length) { console.log(c.dim("  no overlays registered")); return; }
      for (const o of reg.overlays) {
        console.log(c.bold(o.path) + c.dim(`  (added ${o.added_at})`));
        if (!fs.existsSync(o.path)) { console.log(c.red("  overlay repo missing")); continue; }
        for (const l of planLinks(o.path).plan) {
          let st = null;
          try { st = fs.lstatSync(l.to); } catch {}
          const ok = st && st.isSymbolicLink() && fs.readlinkSync(l.to) === l.from;
          const tag = ok ? c.green("linked ") : st ? c.yellow("blocked") : c.red("missing");
          console.log(`  ${tag}  ${path.relative(CHECKOUT, l.to)}`);
        }
      }
      return;
    }

    if (sub === "remove") {
      const target = args[1];
      if (!target) die("usage: edva overlay remove <path>");
      const root = resolveOverlay(target, HOME);
      const reg = readRegistry();
      const before = reg.overlays.length;
      reg.overlays = reg.overlays.filter((o) => o.path !== root);
      if (reg.overlays.length === before) die(`overlay not registered: ${root}`);
      writeRegistry(reg);
      // Walk the checkout rather than re-plan: the overlay may already be gone.
      const links = linksInto(root);
      for (const l of links) fs.unlinkSync(l);
      console.log(c.green(`  ✓ overlay removed: ${root} (${links.length} link(s) unlinked)`));
      return;
    }

    die(`unknown: overlay ${sub}. Try: edva overlay help`);
  },
};
