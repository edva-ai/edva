// The git-rollback guard. Every spelling of a destructive whole-tree git
// command is caught, uncommitted work is saved to refs/edva/pre-destructive/*
// before it runs, and the command is blocked when that save fails. Harmless git
// commands pass untouched.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitCalls, classify, splitCommands, runHook, snapshot, REF_PREFIX } from "../lib/rollback-guard.mjs";
import { gitGuardHooks } from "../lib/rollback-guard-settings.mjs";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const BIN = path.join(ROOT, "bin/rollback-guard");
const destructive = (cmd, cwd = "/repo") => gitCalls(cmd, cwd).some((c) => classify(c.args).destructive);

test("every destructive spelling is caught", () => {
  for (const cmd of [
    "git reset --hard", "git reset --hard origin/main", "git reset --merge",
    "git checkout -- .", "git checkout .", "git checkout -- data/spam-blocklist.json",
    "git checkout HEAD~3 data", "git checkout -f main", "git checkout --force main",
    "git restore .", "git restore data/notes.md", "git restore --staged --worktree .", "git restore -SW .",
    "git restore --source=HEAD~2 .",
    "git clean -f", "git clean -fd", "git clean -xfd", "git clean --force -d",
    "git stash drop", "git stash drop stash@{2}", "git stash clear",
    "git switch --discard-changes main", "git switch -f main",
    "git checkout-index -f -a",
    "git -C ~/Dev/edva reset --hard", "git -c core.pager=cat checkout .",
    "cd ~/Dev/edva && git checkout -- .", "git fetch && git reset --hard origin/main",
    "bash -c 'git reset --hard'", "sh -lc \"cd /x; git clean -fd\"", "eval git restore .",
    "env GIT_TRACE=1 git reset --hard", "FOO=1 git reset --hard", "command git restore .",
    "timeout 30 git reset --hard", "/usr/bin/git reset --hard",
    "git status; git checkout .", "git log | head; git clean -fd",
  ]) assert.ok(destructive(cmd), `missed: ${cmd}`);
});

test("harmless git commands and look-alikes pass", () => {
  for (const cmd of [
    "git status", "git diff", "git log --oneline -5", "git checkout main", "git checkout -b fix origin/main",
    "git switch main", "git switch -c topic", "git restore --staged tools/x.js", "git reset", "git reset HEAD~1",
    "git reset --soft HEAD~1", "git clean -n", "git clean -fdn", "git clean --dry-run -fd",
    "git stash list", "git stash push -u -m tag", "git stash apply abc123", "git stash show",
    "git add -A", "git commit -m 'git reset --hard is blocked'", "echo 'git reset --hard'",
    "grep -rn 'git checkout .' tools", "# git reset --hard", "bin/edva-commit -m 'x' -- a",
    "git push origin main", "git merge --ff-only origin/main",
  ]) assert.ok(!destructive(cmd), `false positive: ${cmd}`);
});

test("the target directory follows cd and -C", () => {
  assert.equal(gitCalls("cd /a && git -C b reset --hard", "/w")[0].dir, "/a/b");
  assert.equal(gitCalls("git reset --hard", "/w")[0].dir, "/w");
  assert.equal(gitCalls("cd ~ ; git status", "/w")[0].dir, os.homedir());
  assert.deepEqual(splitCommands("a 'b c' \"d\\\"e\" && f"), [["a", "b c", 'd"e'], ["f"]]);
});

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-guard-")));
  const g = (...a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(d, "a.json"), "committed\n");
  g("add", "a.json"); g("commit", "-q", "-m", "init");
  return { d, g };
}
const hook = (command, cwd) => runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), { log: () => {} });

test("reset --hard: the uncommitted edit is saved to a ref and can be restored", () => {
  const { d, g } = repo();
  fs.writeFileSync(path.join(d, "a.json"), "live edit\n");
  fs.writeFileSync(path.join(d, "b.json"), "staged new\n");
  g("add", "b.json");
  const r = hook("git reset --hard", d);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /refs\/edva\/pre-destructive\//);
  const ref = g("for-each-ref", "--format=%(refname)", REF_PREFIX);
  assert.ok(ref.startsWith(REF_PREFIX));
  g("reset", "--hard");
  assert.equal(fs.readFileSync(path.join(d, "a.json"), "utf8"), "committed\n");
  assert.equal(g("show", `${ref}:a.json`), "live edit");
  assert.equal(g("show", `${ref}:b.json`), "staged new");
  assert.equal(g("show", `${ref}^2:b.json`), "staged new");      // the index, as a second parent
  assert.equal(g("stash", "list"), "");                          // the shared stash stack is untouched
  assert.equal(g("status", "--porcelain"), "");
});

test("clean -fd also saves untracked files; nothing dirty means no ref", () => {
  const { d, g } = repo();
  let r = hook("git clean -fd", d);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, undefined);
  assert.equal(g("for-each-ref", REF_PREFIX), "");
  fs.writeFileSync(path.join(d, "new.txt"), "untracked\n");
  r = hook("git clean -fd", d);
  assert.equal(r.code, 0);
  const ref = g("for-each-ref", "--format=%(refname)", REF_PREFIX);
  assert.equal(g("show", `${ref}:new.txt`), "untracked");
  // the real index was not touched by the snapshot
  assert.equal(g("status", "--porcelain"), "?? new.txt");
});

test("stash drop/clear pin the entries first", () => {
  const { d, g } = repo();
  fs.writeFileSync(path.join(d, "a.json"), "stashed\n");
  g("stash", "push", "-q", "-m", "keep-me");
  const sha = g("rev-parse", "stash@{0}");
  assert.equal(hook("git stash drop", d).code, 0);
  assert.equal(g("for-each-ref", "--format=%(objectname)", REF_PREFIX), sha);
});

test("a mid-merge reset --hard is saved, not blocked", () => {
  const { d, g } = repo();
  g("checkout", "-q", "-b", "other");
  fs.writeFileSync(path.join(d, "a.json"), "other\n"); g("commit", "-qam", "o");
  g("checkout", "-q", "-");
  fs.writeFileSync(path.join(d, "a.json"), "main\n"); g("commit", "-qam", "m");
  spawnSync("git", ["-C", d, "merge", "other"], { encoding: "utf8" });   // conflicts
  const r = hook("git reset --hard", d);
  assert.equal(r.code, 0);
  const ref = g("for-each-ref", "--format=%(refname)", REF_PREFIX);
  assert.match(g("show", `${ref}:a.json`), /<<<<<<<|=======/);
});

test("a failed snapshot blocks the command (exit 2), a guard bug on a harmless command does not", () => {
  const fail = () => { throw new Error("disk full"); };
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout ." }, cwd: "/repo" }), { snap: fail, log: () => {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /disk full/);
  const ok = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/repo" }), { snap: fail, log: () => {} });
  assert.equal(ok.code, 0);
  assert.equal(runHook("not json").code, 0);
  assert.equal(runHook(JSON.stringify({ tool_name: "Read", tool_input: {} })).code, 0);
});

test("outside a git work tree there is nothing to protect", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "git-guard-norepo-"));
  assert.deepEqual(snapshot(d, { kind: "reset --hard" }).ref, null);
});

test("the bin speaks the hook protocol and merges settings for forks", () => {
  const { d } = repo();
  fs.writeFileSync(path.join(d, "a.json"), "edit\n");
  const r = spawnSync(process.execPath, [BIN], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git restore ." }, cwd: d }), encoding: "utf8",
    env: { ...process.env, HOME: d } });   // keeps its log line out of the real repo
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).systemMessage.includes(REF_PREFIX));
  const m = spawnSync(process.execPath, [BIN, "--settings-json", '{"skillOverrides":{"x":"user-invocable-only"}}'], { encoding: "utf8" });
  const s = JSON.parse(m.stdout);
  assert.equal(s.skillOverrides.x, "user-invocable-only");
  assert.equal(s.hooks.PreToolUse[0].matcher, "Bash");
  assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes("bin/rollback-guard"));
});

test("both supervisors put the guard hook in their session settings", () => {
  const h = gitGuardHooks({ node: "/n/node", root: "/r" });
  assert.equal(h.PreToolUse[0].hooks[0].command, `'/n/node' '${path.join("/r", "bin/rollback-guard")}'`);
  for (const f of ["agent/supervisor/index.mjs", "agent/supervisor/chat-supervisor.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const line = src.slice(src.indexOf("async startSession(")).split("\n").find((l) => l.trim().startsWith("settings:"));
    assert.match(line, /hooks: gitGuardHooks\(\)/, f);
  }
  // (this installation's own runners: rollback-guard-local.test.mjs)
  for (const f of ["agent/scripts/lib/run-ephemeral-opus.sh"]) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes("edva_fork_settings"), `${f} does not merge the guard`);
  }
});
