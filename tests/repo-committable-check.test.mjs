// repo-committable-check.test.mjs — drives the checker against REAL temporary
// git repositories, because every condition it detects is a property of git's
// index that a hand-written fixture would only approximate.
//
// The condition that motivated it: a stash pop left a tracked doc unmerged in
// the shared clone. Nothing noticed, because nothing in the system asks
// whether the repo can accept a commit — it is only ever discovered when
// something tries to commit and fails, usually an already-approved change.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { findCommitBlockers, describeBlockers } = require_(
  path.join(ROOT, "lib/repo-committable-check.js"),
);

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "committable-"));
  const git = (a) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "other\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  return { dir, git, run: (a) => { try { return git(a); } catch (e) { return String(e.stdout || ""); } } };
}

const kinds = (r) => r.blockers.map((b) => b.kind).sort();

test("a clean repo is committable", () => {
  const { run, dir } = makeRepo();
  const r = findCommitBlockers(run);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  assert.deepEqual(r.blockers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stash-pop conflict is reported as unmerged", () => {
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "shared.txt"), "stashme\n");
  git(["stash", "-q"]);
  fs.writeFileSync(path.join(dir, "shared.txt"), "upstream\n");
  git(["commit", "-qam", "upstream"]);
  try { git(["stash", "pop"]); } catch {}

  const r = findCommitBlockers(run);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes("unmerged"), JSON.stringify(kinds(r)));
  const unmerged = r.blockers.find((b) => b.kind === "unmerged");
  assert.deepEqual(unmerged.files, ["shared.txt"]);

  // And prove the consequence the checker exists to predict: edva-commit's
  // plain `git commit` really does refuse while this is true.
  fs.writeFileSync(path.join(dir, "other.txt"), "changed\n");
  git(["add", "other.txt"]);
  let refused = false;
  try { git(["commit", "-m", "unrelated"]); } catch { refused = true; }
  assert.equal(refused, true, "plain git commit should refuse with an unmerged path");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file another session left staged is reported, and not double-counted as unmerged", () => {
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "other.txt"), "someone else's work\n");
  git(["add", "other.txt"]);

  const r = findCommitBlockers(run);
  assert.equal(r.ok, false);
  assert.deepEqual(kinds(r), ["foreign-staged"]);
  assert.deepEqual(r.blockers[0].files, ["other.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conflict markers that survived into tracked content are caught", () => {
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(
    path.join(dir, "doc.md"),
    "intro\n<<<<<<< Updated upstream\nmine\n=======\ntheirs\n>>>>>>> Stashed changes\nrest\n",
  );
  git(["add", "doc.md"]);
  git(["commit", "-qm", "oops"]);

  const r = findCommitBlockers(run);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes("conflict-markers"));
  assert.deepEqual(r.blockers.find((b) => b.kind === "conflict-markers").files, ["doc.md"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prose that merely mentions the marker string does not trip it", () => {
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(
    path.join(dir, "notes.md"),
    "Git writes <<<<<<< and >>>>>>> around a conflict.\nIndented:\n    <<<<<<< HEAD\n",
  );
  git(["add", "notes.md"]);
  git(["commit", "-qm", "docs"]);

  const r = findCommitBlockers(run);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("describeBlockers names the condition and stays one line", () => {
  const s = describeBlockers([
    { kind: "unmerged", files: ["a", "b", "c", "d", "e"], why: "because" },
  ]);
  assert.match(s, /^unmerged: a, b, c, d \(\+1 more\) — because$/);
  assert.equal(s.includes("\n"), false);
});

test("an unmerged file is not ALSO reported for its markers", () => {
  // An unmerged file essentially always carries markers in the worktree. It is
  // already named under the more specific heading, and reporting it twice
  // makes the marker condition look like it fires on its own when it does not.
  // What that condition is actually for is the NEXT test.
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "shared.txt"), "stashme\n");
  git(["stash", "-q"]);
  fs.writeFileSync(path.join(dir, "shared.txt"), "upstream\n");
  git(["commit", "-qam", "upstream"]);
  try { git(["stash", "pop"]); } catch {}

  const r = findCommitBlockers(run);
  assert.deepEqual(kinds(r), ["unmerged"], "markers must not double-report the unmerged file");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("markers DO report when `git add` marked the file resolved and left them in", () => {
  // The dangerous case the condition exists for: index looks clean, content is
  // corrupt, and a commit would ship it.
  const { run, git, dir } = makeRepo();
  fs.writeFileSync(path.join(dir, "shared.txt"), "stashme\n");
  git(["stash", "-q"]);
  fs.writeFileSync(path.join(dir, "shared.txt"), "upstream\n");
  git(["commit", "-qam", "upstream"]);
  try { git(["stash", "pop"]); } catch {}
  git(["add", "shared.txt"]); // "resolved" without touching the content

  const r = findCommitBlockers(run);
  assert.equal(r.ok, false);
  assert.ok(kinds(r).includes("conflict-markers"), JSON.stringify(kinds(r)));
  assert.equal(kinds(r).includes("unmerged"), false, "git add cleared the unmerged state");
  fs.rmSync(dir, { recursive: true, force: true });
});
