// rollback-guard — a Claude Code PreToolUse hook (matcher "Bash") for
// Edva's own sessions: before a git command that throws away uncommitted
// work runs, snapshot that work to a ref; if the snapshot cannot be taken,
// block the command. Decision D2 on the 2026-10-20 review ("block + auto-stash").
//
// Why. One whole-tree undo on the host rolled two live files back
// five days (spam rules and a call's notes, rebuilt by hand). The only
// guard was a permission deny on one spelling, `Bash(git reset --hard*)`;
// `git checkout -- .`, `git checkout .`, `git restore .`, `git clean -fd`,
// `git switch --discard-changes`, `git -C dir reset --hard`, `cd x && git …`
// and `bash -c "git …"` all went through.
//
// What counts as destructive (code reads command STRUCTURE, never language):
//   reset --hard | --merge · checkout with -f/--force or any pathspec (incl. `.`
//   and `-- <paths>`) · restore without --staged-only (worktree is touched) ·
//   clean -f/--force (not -n/--dry-run) · switch -f/--force/--discard-changes ·
//   checkout-index -f · stash drop | clear (the stash entries themselves).
// Plain `git checkout <branch>` and `git switch <branch>` are left alone: git
// refuses them itself when they would overwrite a change.
//
// The snapshot. A temp index seeded from the real one, `git add -u` (plus the
// untracked, non-ignored files for `clean`, each up to MAX_UNTRACKED_BYTES),
// `write-tree`, and a commit whose tree is the working tree and whose parents
// are HEAD and a commit of the real index. It is stored at
// refs/edva/pre-destructive/<UTC stamp>-<pid> and never touches the working
// tree, the index or the shared stash stack. Restore a file with
//   git checkout <ref> -- <path>     (or: git show <ref>:<path>)
// For `stash drop|clear` the entries about to go are pinned under the same
// prefix instead. Nothing uncommitted → no snapshot, the command just runs.
// Refs older than KEEP_DAYS are pruned on the next snapshot.
//
// Outcomes (hook protocol): exit 0 = let the command run (the normal permission
// rules still apply; a {"systemMessage"} line names the ref); exit 2 = block,
// with the reason on stderr for the model. A guard bug must not wedge every
// command, so an unexpected error with nothing destructive detected exits 0;
// once a destructive command is detected, anything short of a confirmed
// snapshot blocks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installRoot } from "./root.cjs";

export const REF_PREFIX = "refs/edva/pre-destructive/";
export const KEEP_DAYS = 30;
export const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;

// ─── shell structure ────────────────────────────────────────────────────────
// Split a command line into simple commands (on ; && || | & and newlines),
// each a list of words with quotes removed. Enough of POSIX sh for what an
// agent types; a construct it cannot follow ($(…), heredoc bodies) stays a
// word, which at worst hides a git call inside it (still caught if it is the
// argument of `bash -c`/`sh -c`/`eval`, which are re-parsed below).
export function splitCommands(src) {
  const cmds = [];
  let words = [], cur = "", inWord = false, q = null;
  const endWord = () => { if (inWord) words.push(cur); cur = ""; inWord = false; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) cur += src[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < src.length) { if (src[i + 1] !== "\n") { cur += src[i + 1]; inWord = true; } i++; continue; }
    if (c === "#" && !inWord) { while (i < src.length && src[i] !== "\n") i++; endCmd(); continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")") { endCmd(); continue; }
    if (c === " " || c === "\t") { endWord(); continue; }
    cur += c; inWord = true;
  }
  endCmd();
  return cmds;
}

const WRAPPERS = new Set(["command", "exec", "nice", "nohup", "time", "sudo", "builtin", "caffeinate"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/; // lang-regex-ok: shell VAR=value assignment syntax

const expandHome = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

// Walk the simple commands in order, tracking `cd`, and return each git call as
// { dir, args } (args after the global options), recursing into `sh -c`/`eval`.
export function gitCalls(src, cwd, depth = 0) {
  const out = [];
  let dir = cwd;
  for (let words of splitCommands(src)) {
    words = words.slice();
    while (words.length && ASSIGN.test(words[0])) words.shift();
    while (words.length) {
      const w = path.basename(words[0]);
      if (WRAPPERS.has(w)) { words.shift(); while (words[0]?.startsWith("-")) words.shift(); continue; }
      if (w === "env") { words.shift(); while (words.length && (words[0].startsWith("-") || ASSIGN.test(words[0]))) words.shift(); continue; }
      if (w === "timeout" || w === "gtimeout") { words.shift(); while (words[0]?.startsWith("-")) words.shift(); words.shift(); continue; }
      break;
    }
    if (!words.length) continue;
    const head = path.basename(words[0]);
    if (head === "cd") { const t = words[1]; dir = !t || t === "-" ? dir : path.resolve(dir, expandHome(t)); continue; }
    if (depth < 3 && SHELLS.has(head)) {
      const i = words.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x)); // lang-regex-ok: shell option flags like -c / -lc
      if (i > 0 && words[i + 1] != null) out.push(...gitCalls(words[i + 1], dir, depth + 1));
      continue;
    }
    if (depth < 3 && head === "eval") { out.push(...gitCalls(words.slice(1).join(" "), dir, depth + 1)); continue; }
    if (head === "xargs") { const k = words.findIndex((x) => path.basename(x) === "git"); if (k > 0) words = words.slice(k); else continue; }
    if (path.basename(words[0]) !== "git") continue;
    let gdir = dir, k = 1;
    while (k < words.length && words[k].startsWith("-")) {
      const o = words[k];
      if (o === "-C") { gdir = path.resolve(gdir, expandHome(words[k + 1] || ".")); k += 2; continue; }
      if (o === "-c" || o === "--git-dir" || o === "--work-tree" || o === "--namespace") { k += 2; continue; }
      if (o.startsWith("--work-tree=")) { gdir = path.resolve(gdir, expandHome(o.slice(12))); k++; continue; }
      k++;
    }
    out.push({ dir: gdir, args: words.slice(k) });
  }
  return out;
}

// ─── classification ─────────────────────────────────────────────────────────
const shortFlags = (a) => a.filter((x) => /^-[A-Za-z]+$/.test(x)).join(""); // lang-regex-ok: bundled short CLI flags like -fdx

// { destructive: bool, kind, untracked: bool, stash: "drop"|"clear"|null, stashArgs }
export function classify(args) {
  const [sub, ...rest] = args;
  const no = { destructive: false };
  if (!sub) return no;
  const has = (...f) => rest.some((x) => f.includes(x));
  const dd = rest.indexOf("--");
  const opts = dd >= 0 ? rest.slice(0, dd) : rest;
  const afterDd = dd >= 0 ? rest.slice(dd + 1) : [];
  switch (sub) {
    case "reset":
      return has("--hard", "--merge") ? { destructive: true, kind: `reset ${has("--hard") ? "--hard" : "--merge"}` } : no;
    case "checkout": {
      if (has("-f", "--force") || shortFlags(opts).includes("f")) return { destructive: true, kind: "checkout --force" };
      if (afterDd.length) return { destructive: true, kind: "checkout -- <paths>" };
      // Creating a branch never overwrites a change (git refuses instead).
      if (has("-b", "-B", "--orphan")) return no;
      // `git checkout .` / `git checkout <tree-ish> <path>`: a pathspec without --.
      const pos = opts.filter((x) => !x.startsWith("-"));
      if (pos.includes(".") || pos.includes(":/") || pos.length >= 2) return { destructive: true, kind: "checkout <pathspec>" };
      return no;
    }
    case "restore": {
      const staged = has("--staged", "-S") || shortFlags(opts).includes("S");
      const worktree = has("--worktree", "-W") || shortFlags(opts).includes("W");
      return !staged || worktree ? { destructive: true, kind: "restore (worktree)" } : no;
    }
    case "clean": {
      const f = shortFlags(opts);
      const dry = has("-n", "--dry-run") || f.includes("n");
      const force = has("--force") || f.includes("f");
      return force && !dry ? { destructive: true, kind: "clean --force", untracked: true } : no;
    }
    case "switch":
      return has("-f", "--force", "--discard-changes") || shortFlags(opts).includes("f") ? { destructive: true, kind: "switch --discard-changes" } : no;
    case "checkout-index":
      return has("-f", "--force") || shortFlags(opts).includes("f") ? { destructive: true, kind: "checkout-index --force" } : no;
    case "stash": {
      const op = rest[0];
      if (op === "drop") return { destructive: true, kind: "stash drop", stash: "drop", stashArgs: rest.slice(1).filter((x) => !x.startsWith("-")) };
      if (op === "clear") return { destructive: true, kind: "stash clear", stash: "clear" };
      return no;
    }
    default:
      return no;
  }
}

// ─── snapshot ───────────────────────────────────────────────────────────────
export function gitRunner(dir, extraEnv = {}) {
  return (args, opts = {}) => execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...extraEnv, ...(opts.env || {}) },
    input: opts.input,
  }).trim();
}

const utcStamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // lang-regex-ok: ISO timestamp punctuation

function pruneOld(git, now) {
  try {
    const lines = git(["for-each-ref", "--format=%(refname) %(creatordate:unix)", REF_PREFIX]).split("\n").filter(Boolean);
    for (const l of lines) {
      const [ref, ts] = l.split(" ");
      if (now.getTime() / 1000 - Number(ts) > KEEP_DAYS * 86400) git(["update-ref", "-d", ref]);
    }
  } catch {}
}

// Returns { ref|null, note }. Throws when a snapshot was needed and failed.
export function snapshot(dir, cls, { now = new Date(), git = gitRunner(dir) } = {}) {
  let top;
  try { top = git(["rev-parse", "--show-toplevel"]); }
  catch { return { ref: null, note: "not a git work tree; nothing to protect" }; }
  const g = top === dir ? git : gitRunner(top);
  const stamp = `${utcStamp(now)}-${process.pid}`;

  if (cls.stash) {
    let shas = [];
    if (cls.stash === "clear") shas = g(["stash", "list", "--format=%H"]).split("\n").filter(Boolean);
    else {
      const which = cls.stashArgs?.[0] || "stash@{0}";
      try { shas = [g(["rev-parse", "--verify", `${which}^{commit}`])]; } catch { return { ref: null, note: `no ${which} to drop` }; }
    }
    if (!shas.length) return { ref: null, note: "stash is empty" };
    shas.forEach((sha, i) => g(["update-ref", `${REF_PREFIX}${stamp}-stash-${i}`, sha]));
    pruneOld(g, now);
    return { ref: `${REF_PREFIX}${stamp}-stash-*`, note: `pinned ${shas.length} stash entr${shas.length === 1 ? "y" : "ies"}` };
  }

  let head = null;
  try { head = g(["rev-parse", "--verify", "HEAD"]); } catch {}
  const gitDir = g(["rev-parse", "--absolute-git-dir"]);
  const realIndex = path.join(gitDir, "index");
  const tmpIndex = path.join(os.tmpdir(), `edva-git-guard-${process.pid}-${Date.now()}.index`);
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const gi = gitRunner(top, { GIT_INDEX_FILE: tmpIndex });
    // An index with unmerged entries (mid-merge) cannot be written as a tree;
    // the worktree snapshot then stands in for it (conflict markers and all),
    // so a `reset --hard` out of a failed merge is still saved, not blocked.
    let indexTree = null;
    try { indexTree = g(["write-tree"]); } catch {}
    gi(["add", "-u"]);
    const skipped = [];
    if (cls.untracked) {
      const others = g(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
      const keep = [];
      for (const f of others) {
        let size = 0;
        try { size = fs.lstatSync(path.join(top, f)).size; } catch { continue; }
        if (size > MAX_UNTRACKED_BYTES) skipped.push(f); else keep.push(f);
      }
      if (keep.length) gi(["add", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], { input: keep.join("\0") });
    }
    const workTree = gi(["write-tree"]);
    if (!indexTree) indexTree = workTree;
    const headTree = head ? g(["rev-parse", `${head}^{tree}`]) : null;
    if (workTree === headTree && indexTree === headTree) return { ref: null, note: "nothing uncommitted" };
    const parents = head ? ["-p", head] : [];
    const indexCommit = g(["commit-tree", indexTree, ...parents, "-m", "index at rollback-guard snapshot"]);
    const msg = `rollback-guard: uncommitted work before \`${cls.kind}\`` + (skipped.length ? `\n\nnot captured (over ${MAX_UNTRACKED_BYTES} bytes): ${skipped.join(", ")}` : "");
    const commit = g(["commit-tree", workTree, ...parents, "-p", indexCommit, "-m", msg]);
    const ref = `${REF_PREFIX}${stamp}`;
    g(["update-ref", ref, commit]);
    if (g(["rev-parse", ref]) !== commit) throw new Error("ref did not stick");
    pruneOld(g, now);
    return { ref, note: skipped.length ? `${skipped.length} large untracked file(s) not captured` : "" };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch {}
  }
}

// ─── hook entry ─────────────────────────────────────────────────────────────
function logLine(root, s) {
  try {
    const f = path.join(root || installRoot(), "agent/logs/rollback-guard.log");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${new Date().toISOString()} ${s}\n`);
  } catch {}
}

// Returns { code, stdout, stderr } — pure apart from the snapshot itself.
export function runHook(inputText, { snap = snapshot, log = logLine } = {}) {
  let detected = false;
  try {
    const input = JSON.parse(inputText || "{}");
    if (input.tool_name !== "Bash") return { code: 0 };
    const command = String(input.tool_input?.command || "");
    if (!command.includes("git")) return { code: 0 };
    const cwd = input.cwd || process.cwd();
    const hits = gitCalls(command, cwd).map((c) => ({ ...c, cls: classify(c.args) })).filter((c) => c.cls.destructive);
    if (!hits.length) return { code: 0 };
    detected = true;
    const refs = [];
    for (const h of hits) {
      let r;
      try { r = snap(h.dir, h.cls); }
      catch (e) {
        const why = String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 200);
        log(null, `BLOCKED ${h.cls.kind} in ${h.dir}: snapshot failed (${why}) :: ${command.slice(0, 300)}`);
        return { code: 2, stderr: `rollback-guard: blocked \`git ${h.args.join(" ")}\` — it would discard uncommitted changes in ${h.dir}, and saving them first failed (${why}). Commit the files you mean to keep (bin/edva-commit), or fix the snapshot, then retry.` };
      }
      log(null, `${r.ref ? "SNAPSHOT " + r.ref : "ALLOW"} ${h.cls.kind} in ${h.dir}${r.note ? ` (${r.note})` : ""} :: ${command.slice(0, 300)}`);
      if (r.ref) refs.push(`${r.ref} (${h.dir})`);
    }
    if (!refs.length) return { code: 0 };
    return { code: 0, stdout: JSON.stringify({ systemMessage: `rollback-guard saved uncommitted work before this command: ${refs.join("; ")}. Restore a file with: git checkout <ref> -- <path>` }) };
  } catch (e) {
    if (detected) return { code: 2, stderr: `rollback-guard: blocked — guard error after detecting a destructive git command (${String(e?.message || e).slice(0, 200)}).` };
    return { code: 0 };
  }
}
