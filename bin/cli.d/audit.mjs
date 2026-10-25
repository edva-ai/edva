// edva audit — periodic review of the public/private boundary.
//
//   1. .tools/sanitize-guard.py --all (every tracked file vs. the baseline)
//   2. the last N commit messages against the same patterns (the pre-commit
//      hook only sees file content)
//   3. baseline size, so a growing baseline gets noticed
//   4. tracked files under agent/local/ or an `_ext/` dir (must be none but
//      the `.gitkeep` contract files — anything else slipped past .gitignore)
//   5. what none of this can see
//
// The identity patterns are not in the public tree: the guard loads them from
// $EDVA_SANITIZE_PATTERNS / $EDVA_SANITIZE_PATTERNS_JSON, else
// agent/local/sanitize-patterns.json. Without them only the generic detectors
// run, and this report says so. Exit 1 when the guard or the commit scan
// finds something, so CI can call it.

import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { CHECKOUT, isHelp } from "./_common.mjs";

export default {
  summary: "public/private boundary review (sanitize guard, commits, overlay files)",
  usage: "audit [--commits N]",
  async run(args, ctx) {
    const { c, getFlag } = ctx;
    if (isHelp(args)) {
      console.log("Usage: edva audit [--commits N]   (default N = 50)");
      console.log("Runs the sanitize guard over every tracked file, scans recent commit");
      console.log("messages, reports the baseline and checks no overlay file is tracked.");
      return;
    }
    const n = parseInt(getFlag(args, "--commits", "50"), 10) || 50;
    const guard = path.join(CHECKOUT, ".tools", "sanitize-guard.py");
    const baseline = path.join(CHECKOUT, ".tools", "sanitize-guard-baseline.json");
    console.log(c.bold("edva audit") + c.dim(` — public/private boundary review (${new Date().toISOString().slice(0, 10)})\n`));

    // 1 ──────────────────────────────────────────────────────────────────
    console.log(c.bold("1. sanitize-guard (all tracked files vs. baseline)"));
    let guardExit = 0;
    if (!fs.existsSync(guard)) {
      console.log(c.red("   guard missing at .tools/sanitize-guard.py"));
      guardExit = 2;
    } else {
      const r = spawnSync("python3", [guard, "--all"], { stdio: "inherit", cwd: CHECKOUT });
      guardExit = r.status ?? 1;
      if (guardExit === 0) console.log(c.green("   ✓ clean against baseline"));
    }

    // 2 ──────────────────────────────────────────────────────────────────
    console.log("\n" + c.bold(`2. commit message scan (last ${n} commits)`));
    const hits = [];
    let patterns = {};
    let overlayLoaded = false;
    try {
      const out = execFileSync("python3", [guard, "--list-patterns", "--json"], { cwd: CHECKOUT, stdio: ["ignore", "pipe", "pipe"] }).toString();
      const parsed = JSON.parse(out);
      overlayLoaded = parsed.overlay_loaded === true;
      for (const [name, src] of Object.entries(parsed.patterns || {})) {
        // Python-only syntax (inline flags, possessives) is rare; skip what JS cannot compile.
        try { patterns[name] = new RegExp(src, "i"); } catch {}
      }
    } catch (e) {
      console.log(c.red(`   couldn't load the guard's patterns: ${e.message.split("\n")[0]}`));
    }
    if (!overlayLoaded) console.log(c.yellow("   ! no private identity patterns loaded — generic detectors only (set EDVA_SANITIZE_PATTERNS)"));
    try {
      const log = execFileSync("git", ["log", "-n", String(n), "--format=%h%x09%s%x09%b%x1e"], { cwd: CHECKOUT }).toString();
      for (const entry of log.split("\x1e").map((s) => s.trim()).filter(Boolean)) {
        const [hash, subject, ...rest] = entry.split("\t");
        const text = `${subject}\n${rest.join("\t")}`;
        for (const [name, re] of Object.entries(patterns)) {
          if (re.test(text)) hits.push({ hash, name, subject: (subject || "").slice(0, 80) });
        }
      }
    } catch (e) {
      console.log(c.red(`   couldn't read git log: ${e.message.split("\n")[0]}`));
    }
    if (!hits.length) console.log(c.green("   ✓ no pattern hits in recent commit messages"));
    else {
      console.log(c.red(`   ✗ ${hits.length} hit(s):`));
      for (const h of hits) console.log(`     ${c.dim(h.hash)}  [${h.name}]  ${h.subject}`);
      console.log(c.dim("     Commit messages stay in history; removing them means rewriting history."));
    }

    // 3 ──────────────────────────────────────────────────────────────────
    console.log("\n" + c.bold("3. baseline"));
    if (!fs.existsSync(baseline)) console.log(c.dim("   no baseline file"));
    else {
      try {
        const b = JSON.parse(fs.readFileSync(baseline, "utf8"));
        const files = Object.keys(b).length;
        const total = Object.values(b).reduce((s, v) => s + v.length, 0);
        console.log(`   files with accepted hits: ${files}`);
        console.log(`   total accepted hits:      ${total}`);
        const top = Object.entries(b).map(([f, h]) => [f, h.length]).sort((x, y) => y[1] - x[1]).slice(0, 3);
        for (const [f, k] of top) console.log(c.dim(`     ${String(k).padStart(3)}  ${f}`));
        console.log(c.dim("   → accepting a hit should be a deliberate choice; review the list now and then."));
      } catch (e) { console.log(c.red(`   unreadable baseline: ${e.message}`)); }
    }

    // 4 ──────────────────────────────────────────────────────────────────
    console.log("\n" + c.bold("4. tracked files in overlay locations (only .gitkeep allowed)"));
    try {
      const tracked = execFileSync("git", ["ls-files", "--", "agent/local", ":(glob)**/_ext/**", "local"], { cwd: CHECKOUT })
        .toString().split("\n").filter(Boolean).filter((f) => !f.endsWith("/.gitkeep"));
      if (!tracked.length) console.log(c.green("   ✓ none"));
      else {
        console.log(c.red(`   ✗ ${tracked.length} tracked overlay file(s):`));
        for (const t of tracked) console.log(`     ${t}`);
        console.log(c.dim("     (added with `git add -f` or before the ignore rule existed — untrack them)"));
      }
    } catch (e) { console.log(c.dim(`   skipped: ${e.message.split("\n")[0]}`)); }

    // 5 ──────────────────────────────────────────────────────────────────
    console.log("\n" + c.bold("5. what this audit cannot see"));
    console.log(c.dim("   • paraphrased or narrative personal content (no pattern fires) — use `edva review-pr`"));
    console.log(c.dim("   • past commits: the guard scans the current tree only"));
    console.log(c.dim("   • forks, archives and search caches of anything already published"));

    process.exitCode = guardExit !== 0 || hits.length ? 1 : 0;
  },
};
