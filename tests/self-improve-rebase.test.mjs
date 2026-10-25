// self-improve-rebase.test.mjs — an approved code-fix card whose file drifted is
// carried over by a 3-way merge when the changes don't overlap, and still refused
// when they do. Regression for a large approved card that was refused because a
// shared file (tasks.json) had gained an unrelated entry in the meantime.
//
// Run: node --test tests/self-improve-rebase.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { rebaseDrifted, findBaseContent, findMovedFiles, sha256, isLegacyArchCard, ARCH_REL, CHANGELOG_REL } from "../lib/self-improve-rebase.mjs";

function repo(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "si-rebase-test-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "f.txt"), initial);
  git("add", "f.txt"); git("commit", "-q", "-m", "base");
  return { dir, git };
}

const BASE = "a\nb\nc\nd\ne\nf\ng\nh\n";

test("a card authored before an unrelated change lands with both changes", async () => {
  const { dir, git } = repo(BASE);
  const card = BASE.replace("g\n", "g2\n");                 // the card's edit
  const current = BASE.replace("a\n", "a0\na\n");           // landed after authoring
  fs.writeFileSync(path.join(dir, "f.txt"), current); git("commit", "-qam", "drift");
  const r = await rebaseDrifted(dir, [{ rel: "f.txt", want: sha256(Buffer.from(BASE)), current: Buffer.from(current), card }]);
  assert.equal(r.ok, true);
  assert.equal(r.merged["f.txt"].toString(), "a0\na\nb\nc\nd\ne\nf\ng2\nh\n");
});

test("overlapping changes are still refused, and nothing is returned to write", async () => {
  const { dir, git } = repo(BASE);
  const card = BASE.replace("d\n", "dCARD\n");
  const current = BASE.replace("d\n", "dOTHER\n");
  fs.writeFileSync(path.join(dir, "f.txt"), current); git("commit", "-qam", "drift");
  const r = await rebaseDrifted(dir, [{ rel: "f.txt", want: sha256(Buffer.from(BASE)), current: Buffer.from(current), card }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /overlap/);
  assert.equal(r.merged, undefined);
});

test("a base that is not in git history refuses instead of guessing", async () => {
  const { dir } = repo(BASE);
  const r = await rebaseDrifted(dir, [{ rel: "f.txt", want: sha256(Buffer.from("never committed\n")), current: Buffer.from(BASE), card: "x\n" }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer in git history/);
});

test("re-running on an already-rebased file is a no-op (retry path stays idempotent)", async () => {
  const { dir, git } = repo(BASE);
  const card = BASE.replace("g\n", "g2\n");
  const merged = "a0\na\nb\nc\nd\ne\nf\ng2\nh\n";
  fs.writeFileSync(path.join(dir, "f.txt"), merged); git("commit", "-qam", "applied");
  const r = await rebaseDrifted(dir, [{ rel: "f.txt", want: sha256(Buffer.from(BASE)), current: Buffer.from(merged), card }]);
  assert.equal(r.ok, true);
  assert.equal(r.merged["f.txt"].toString(), merged);
});

test("findBaseContent finds an older committed version by its sha256", async () => {
  const { dir, git } = repo(BASE);
  fs.writeFileSync(path.join(dir, "f.txt"), "later\n"); git("commit", "-qam", "later");
  const b = await findBaseContent(dir, "f.txt", sha256(Buffer.from(BASE)));
  assert.equal(b.toString(), BASE);
});

test("two changelog entries at the same spot in a .md doc keep both, code still refuses", async () => {
  const doc = "# Recent changes\n- old entry\n";
  const { dir, git } = repo(doc);
  fs.renameSync(path.join(dir, "f.txt"), path.join(dir, "arch.md")); git("add", "-A"); git("commit", "-qm", "md");
  const card = "# Recent changes\n- card entry\n- old entry\n";
  const current = "# Recent changes\n- landed entry\n- old entry\n";
  fs.writeFileSync(path.join(dir, "arch.md"), current); git("commit", "-qam", "drift");
  const r = await rebaseDrifted(dir, [{ rel: "arch.md", want: sha256(Buffer.from(doc)), current: Buffer.from(current), card }]);
  assert.equal(r.ok, true);
  const out = r.merged["arch.md"].toString();
  assert.ok(out.includes("- landed entry") && out.includes("- card entry") && out.includes("- old entry"));
  assert.ok(!out.includes("<<<<<<<"));
});

// ── The changelog moved out of architecture.md ──
// A card authored before the move carries a whole architecture.md with the old
// "## Recent changes" section. It must land its entry in changelog.md and must
// not paste the old changelog back into the map.

function movedRepo() {
  const { dir, git } = repo("x\n");
  const MAP = "# Arch\n\n## Host\n\nOne host.\n\n## Data\n\nOne store.\n\n";
  const OLD_LOG = "## Recent changes\n\n- 2026-10-01 — **old entry.** details\n- 2026-09-30 — **older entry.** details\n";
  const base = MAP + OLD_LOG;
  fs.mkdirSync(path.join(dir, "system"), { recursive: true });
  fs.writeFileSync(path.join(dir, ARCH_REL), base);
  git("add", "-A"); git("commit", "-qm", "before move");
  const archNow = MAP.trimEnd() + "\n\n## Changelog\n\nSee changelog.md.\n";
  const logNow = "# Changelog\n\nPrivate.\n\n## Recent changes\n\n- 2026-10-02 — **landed after the move.** details\n" + OLD_LOG.replace("## Recent changes\n\n", "");
  fs.writeFileSync(path.join(dir, ARCH_REL), archNow);
  fs.writeFileSync(path.join(dir, CHANGELOG_REL), logNow);
  git("add", "-A"); git("commit", "-qm", "move changelog");
  return { dir, git, MAP, base, archNow, logNow };
}

test("changelog move: a pre-move card's entry lands in changelog.md, the map is not refilled", async () => {
  const { dir, base, archNow } = movedRepo();
  const card = base.replace("## Recent changes\n\n", "## Recent changes\n\n- 2026-10-02 — **card entry.** details\n");
  assert.equal(isLegacyArchCard(ARCH_REL, Buffer.from(archNow), card), true);
  const r = await rebaseDrifted(dir, [{ rel: ARCH_REL, want: sha256(Buffer.from(base)), current: Buffer.from(archNow), card }]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.merged[ARCH_REL].toString(), archNow);
  const log = r.merged[CHANGELOG_REL].toString();
  assert.ok(log.startsWith("# Changelog\n"));
  assert.ok(log.includes("card entry") && log.includes("landed after the move"));
  assert.equal(log.split("old entry").length - 1, 1);
  assert.equal(log.split("older entry").length - 1, 1);
  assert.ok(!log.includes("<<<<<<<"));
  assert.ok(log.indexOf("card entry") < log.indexOf("old entry"));
});

test("changelog move: a pre-move card that also edits the map lands both halves", async () => {
  const { dir, base, archNow } = movedRepo();
  const card = base
    .replace("One store.", "One store, and a cache.")
    .replace("## Recent changes\n\n", "## Recent changes\n\n- 2026-10-02 — **cache added.** details\n");
  const r = await rebaseDrifted(dir, [{ rel: ARCH_REL, want: sha256(Buffer.from(base)), current: Buffer.from(archNow), card }]);
  assert.equal(r.ok, true, r.error);
  const arch = r.merged[ARCH_REL].toString();
  assert.ok(arch.includes("One store, and a cache."));
  assert.ok(!arch.includes("## Recent changes") && !arch.includes("old entry"));
  assert.ok(arch.includes("## Changelog"));
  assert.ok(r.merged[CHANGELOG_REL].toString().includes("cache added"));
});

test("changelog move: a post-move card is an ordinary merge", async () => {
  const { dir, archNow, logNow, git } = movedRepo();
  assert.equal(isLegacyArchCard(ARCH_REL, Buffer.from(archNow), archNow.replace("One host.", "Two hosts.")), false);
  const card = logNow.replace("## Recent changes\n\n", "## Recent changes\n\n- 2026-10-03 — **card.** d\n");
  const current = logNow.replace("## Recent changes\n\n", "## Recent changes\n\n- 2026-10-03 — **other.** d\n");
  fs.writeFileSync(path.join(dir, CHANGELOG_REL), current); git("commit", "-qam", "drift");
  const r = await rebaseDrifted(dir, [{ rel: CHANGELOG_REL, want: sha256(Buffer.from(logNow)), current: Buffer.from(current), card }]);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(r.merged), [CHANGELOG_REL]);
  const out = r.merged[CHANGELOG_REL].toString();
  assert.ok(out.includes("**card.**") && out.includes("**other.**") && !out.includes("<<<<<<<"));
});

// ── findMovedFiles: the automatic path refuses, it never merges ──

const head = (git) => git("rev-parse", "HEAD").toString().trim();

test("auto-apply: a file unchanged since --base-rev passes", async () => {
  const { dir, git } = repo(BASE);
  const r = await findMovedFiles(dir, { "f.txt": BASE + "i\n" }, { baseRev: head(git) });
  assert.deepEqual(r, { moved: [], unpinned: [] });
});

test("auto-apply: a file another fix changed after --base-rev is refused, even when a merge would be clean", async () => {
  const { dir, git } = repo(BASE);
  const rev = head(git);
  fs.writeFileSync(path.join(dir, "f.txt"), BASE.replace("a\n", "a0\na\n")); git("commit", "-qam", "other fix");
  const r = await findMovedFiles(dir, { "f.txt": BASE.replace("g\n", "g2\n") }, { baseRev: rev });
  assert.equal(r.moved.length, 1);
  assert.match(r.moved[0].reason, /changed after this fix was written/);
});

test("auto-apply: a new file someone else created meanwhile is refused; a genuinely new one passes", async () => {
  const { dir, git } = repo(BASE);
  const rev = head(git);
  assert.deepEqual((await findMovedFiles(dir, { "new.txt": "x\n" }, { baseRev: rev })).moved, []);
  fs.writeFileSync(path.join(dir, "new.txt"), "theirs\n"); git("add", "new.txt"); git("commit", "-qm", "created");
  const r = await findMovedFiles(dir, { "new.txt": "x\n" }, { baseRev: rev });
  assert.match(r.moved[0].reason, /did not exist/);
});

test("auto-apply: base_sha256 pins per file and wins over --base-rev", async () => {
  const { dir, git } = repo(BASE);
  const rev = head(git);
  fs.writeFileSync(path.join(dir, "f.txt"), "later\n"); git("commit", "-qam", "later");
  const ok = await findMovedFiles(dir, { "f.txt": "mine\n" }, { baseRev: rev, baseSha256: { "f.txt": sha256(Buffer.from("later\n")) } });
  assert.deepEqual(ok.moved, []);
  const bad = await findMovedFiles(dir, { "f.txt": "mine\n" }, { baseSha256: { "f.txt": sha256(Buffer.from(BASE)) } });
  assert.equal(bad.moved.length, 1);
});

test("auto-apply: no base at all is reported as unpinned; content already on disk is a no-op", async () => {
  const { dir } = repo(BASE);
  assert.deepEqual((await findMovedFiles(dir, { "f.txt": "x\n" })).unpinned, ["f.txt"]);
  assert.deepEqual(await findMovedFiles(dir, { "f.txt": BASE }), { moved: [], unpinned: [] });
});

test("auto-apply: an unknown --base-rev counts as moved, the safe direction", async () => {
  const { dir } = repo(BASE);
  const r = await findMovedFiles(dir, { "f.txt": "x\n" }, { baseRev: "0123456789abcdef0123456789abcdef01234567" });
  assert.match(r.moved[0].reason, /not a commit/);
});
