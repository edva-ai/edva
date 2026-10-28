// scratch-tree.test.mjs — pins bin/scratch-tree: a critic's copy of the
// repo holds no gitignored file (the installation's .env above all), carries the
// change under review, runs with EDVA_HOME at the copy and without the
// installation's secrets in its environment, and the nightly sweep removes old
// copies and any stray copy of a secrets file.
//
// Run: node --test tests/scratch-tree.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { KERNEL_SUBDIR } = createRequire(import.meta.url)("../lib/root.cjs");
const K = (rel) => (KERNEL_SUBDIR ? `${KERNEL_SUBDIR}/${rel}` : rel);
const SECRET = "SUPABASE_SERVICE_ROLE_KEY=not-a-real-key\n";

// A throwaway installation: the tool, root.cjs, a tracked file, a gitignored .env
// and data dir, plus a temp dir that stands in for /tmp. `extraEnv` is added to
// the environment the tool itself is started with.
function sandbox(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-home-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-tmp-"));
  for (const rel of ["bin/scratch-tree", "lib/root.cjs"]) {
    fs.mkdirSync(path.join(home, path.dirname(K(rel))), { recursive: true });
    fs.copyFileSync(path.join(KERNEL, rel), path.join(home, K(rel)));
  }
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(home, ".gitignore"), `${K(".env")}\n${K(".env.*")}\n${K("data/")}\n`);
  fs.writeFileSync(path.join(home, K("code.mjs")), "export const a = 1;\n");
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: home, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(home, K(".env")), SECRET);
  fs.writeFileSync(path.join(home, K(".env.bak-1")), SECRET + "OLD=1\n");
  fs.mkdirSync(path.join(home, K("data")));
  fs.writeFileSync(path.join(home, K("data/private.json")), "{}");
  const env = { ...process.env, ...extraEnv, EDVA_HOME: home, TMPDIR: tmp, SCRATCH_TREE_TMP_ROOTS: tmp };
  const cli = (...args) => spawnSync(process.execPath, [path.join(home, K("bin/scratch-tree")), ...args], { cwd: home, env, encoding: "utf8" });
  return { home, tmp, cli, cleanup: () => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test("make: tracked files and the change under review, nothing gitignored", (t) => {
  const s = sandbox(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.home, K("code.mjs")), "export const a = 2;\n");   // uncommitted change
  fs.writeFileSync(path.join(s.home, K("new.mjs")), "export const b = 1;\n");    // untracked, not ignored
  const r = s.cli("make", "--label", "critic");
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.ok(dir.startsWith(fs.realpathSync(s.tmp)) || dir.startsWith(s.tmp), dir);
  assert.equal(fs.readFileSync(path.join(dir, K("code.mjs")), "utf8"), "export const a = 2;\n");
  assert.equal(fs.existsSync(path.join(dir, K("new.mjs"))), true);
  assert.equal(fs.existsSync(path.join(dir, K(".env"))), false);
  assert.equal(fs.existsSync(path.join(dir, K(".env.bak-1"))), false);
  assert.equal(fs.existsSync(path.join(dir, K("data"))), false);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.equal(status.includes(".scratch-tree"), false, status);
});

test("make --bundle lays the bundle over HEAD instead of the working tree", (t) => {
  const s = sandbox(); t.after(s.cleanup);
  fs.writeFileSync(path.join(s.home, K("code.mjs")), "export const a = 99;\n");
  const b = path.join(s.tmp, "b.json");
  fs.writeFileSync(b, JSON.stringify({ files: { [K("code.mjs")]: "export const a = 3;\n" } }));
  const dir = s.cli("make", "--bundle", b).stdout.trim();
  assert.equal(fs.readFileSync(path.join(dir, K("code.mjs")), "utf8"), "export const a = 3;\n");
});

test("run: inside the copy, with EDVA_HOME at the copy; a plain directory is refused", (t) => {
  const s = sandbox(); t.after(s.cleanup);
  const dir = s.cli("make").stdout.trim();
  const r = s.cli("run", dir, "--", "sh", "-c", 'printf "%s|%s" "$EDVA_HOME" "$(pwd -P)"');
  assert.equal(r.status, 0, r.stderr);
  const [home, cwd] = r.stdout.split("|");
  assert.equal(home, path.resolve(dir));
  assert.equal(cwd, fs.realpathSync(dir));
  assert.equal(s.cli("run", s.home, "--", "true").status, 64);
});

// What the command run inside the copy can see, for the names asked about only
// (never the whole environment).
const SEEN = ["SUPABASE_SERVICE_ROLE_KEY", "FAKE_PLAIN_SETTING", "OLD", "SOME_OTHER_TOKEN", "KEEP_ME", "PATH", "HOME", "EDVA_HOME"];
const PROBE = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(SEEN)}.map((k) => [k, process.env[k] ?? null]))))`;

test("run: the installation's secrets stay out of the command's environment unless named with --keep-env", (t) => {
  // Every value below is a stand-in; the names come from the fixture .env, never the real one.
  const s = sandbox({ SUPABASE_SERVICE_ROLE_KEY: "fake-inherited-value", FAKE_PLAIN_SETTING: "fake-setting",
    OLD: "fake-old", SOME_OTHER_TOKEN: "fake-token", KEEP_ME: "1" });
  t.after(s.cleanup);
  // Named in .env (SUPABASE_SERVICE_ROLE_KEY, and an `export NAME =` spelling) or only in a
  // backup beside it (OLD); SOME_OTHER_TOKEN is in neither but is named like a credential.
  fs.appendFileSync(path.join(s.home, K(".env")), "# a comment\nexport FAKE_PLAIN_SETTING = x\n");
  const dir = s.cli("make").stdout.trim();

  const r = s.cli("run", dir, "--", process.execPath, "-e", PROBE);
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.equal(seen.SUPABASE_SERVICE_ROLE_KEY, null);
  assert.equal(seen.FAKE_PLAIN_SETTING, null);
  assert.equal(seen.OLD, null);
  assert.equal(seen.SOME_OTHER_TOKEN, null);
  assert.equal(seen.KEEP_ME, "1");
  assert.equal(seen.PATH, process.env.PATH);
  assert.equal(seen.HOME, process.env.HOME);
  assert.equal(seen.EDVA_HOME, path.resolve(dir));
  assert.equal(r.stderr, "");   // the default run says nothing
  const log = path.join(s.home, K("agent/logs/scratch-tree.log"));
  assert.equal(fs.existsSync(log), false);

  // The deliberate exception: one name passes through, said on stderr and logged
  // by name only; the rest stay out.
  const k = s.cli("run", dir, "--keep-env", "SUPABASE_SERVICE_ROLE_KEY", "--", process.execPath, "-e", PROBE);
  assert.equal(k.status, 0, k.stderr);
  const kept = JSON.parse(k.stdout);
  assert.equal(kept.SUPABASE_SERVICE_ROLE_KEY, "fake-inherited-value");
  assert.equal(kept.SOME_OTHER_TOKEN, null);
  assert.equal(kept.FAKE_PLAIN_SETTING, null);
  assert.match(k.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(k.stderr.includes("fake-inherited-value"), false);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].names, ["SUPABASE_SERVICE_ROLE_KEY"]);
  assert.equal(lines[0].dir, path.resolve(dir));
  assert.equal(fs.readFileSync(log, "utf8").includes("fake-inherited-value"), false);

  // Comma lists work; anything else before -- is refused.
  const two = JSON.parse(s.cli("run", dir, "--keep-env", "OLD,SOME_OTHER_TOKEN", "--", process.execPath, "-e", PROBE).stdout);
  assert.equal(two.OLD, "fake-old");
  assert.equal(two.SOME_OTHER_TOKEN, "fake-token");
  assert.equal(two.SUPABASE_SERVICE_ROLE_KEY, null);
  assert.equal(s.cli("run", dir, "--bogus", "--", "true").status, 64);
  assert.equal(s.cli("run", dir, "--keep-env", "--", "true").status, 64);
});

test("remove: deletes a scratch tree, refuses anything else", (t) => {
  const s = sandbox(); t.after(s.cleanup);
  const dir = s.cli("make").stdout.trim();
  assert.equal(s.cli("remove", s.home).status, 64);
  assert.equal(fs.existsSync(s.home), true);
  assert.equal(s.cli("remove", dir).status, 0);
  assert.equal(fs.existsSync(dir), false);
});

test("sweep: old scratch trees and stray copies of secrets go; everything else stays", (t) => {
  const s = sandbox(); t.after(s.cleanup);
  const old = s.cli("make", "--label", "old").stdout.trim();
  const young = s.cli("make", "--label", "young").stdout.trim();
  const past = (Date.now() - 7 * 3_600_000) / 1000;
  fs.utimesSync(path.join(old, ".scratch-tree"), past, past);
  // A hand-made copy of the tree, as a critic used to make it.
  const manual = path.join(s.tmp, "cer-critic-run", "edva", K(""));
  fs.mkdirSync(manual, { recursive: true });
  fs.writeFileSync(path.join(manual, ".env"), SECRET);
  fs.writeFileSync(path.join(manual, ".env.bak-1"), SECRET + "OLD=1\n");
  fs.writeFileSync(path.join(manual, ".env.example"), "SUPABASE_SERVICE_ROLE_KEY=\n");   // not a copy
  fs.writeFileSync(path.join(manual, "code.mjs"), "x");

  const dry = s.cli("sweep", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes("3 item(s) found"), dry.stdout);   // the old tree, .env, .env.bak-1
  assert.equal(fs.existsSync(old), true);

  const r = s.cli("sweep");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(path.join(manual, ".env")), false);
  assert.equal(fs.existsSync(path.join(manual, ".env.bak-1")), false);
  assert.equal(fs.existsSync(path.join(manual, ".env.example")), true);
  assert.equal(fs.existsSync(path.join(manual, "code.mjs")), true);
  assert.equal(fs.readFileSync(path.join(s.home, K(".env")), "utf8"), SECRET);   // the real one is untouched
});
