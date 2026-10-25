// Regression guard for bin/self-improve-request.
//
// Defends against this system-channel alert:
//   insert 400 {"code":"22P05","message":"unsupported Unicode escape sequence"}
//
// Postgres `text` cannot hold U+0000, so staging a file that carries a raw NUL
// byte used to throw unhandled — four stack frames, with the status and body
// only on the first line, which a caller piping to `tail` never sees (a file
// can carry a literal NUL on purpose, e.g. as a hash separator).
//
// The guard must fail BEFORE the POST, name the file, and say what to do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const BIN = path.join(os.homedir(), "Dev/edva/bin/self-improve-request");
const NUL = String.fromCharCode(0);

// Point the binary at a dead local address. The NUL guard runs long before any
// request, so the cases that matter are unaffected — but a map that legitimately
// PASSES the guard would otherwise run on to createUnifiedApproval and file a
// real approval row plus a real Improvements card: a test asserting "clean
// content is allowed through" must not prove it by actually going through.
//
// CLAIM_FRESHNESS_CLAUDE_BIN also points at a nonexistent path (the staleness
// recheck before a card is shown): createUnifiedApproval now runs the
// claim-freshness gate BEFORE the insert this test relies on failing, and
// undated evidence (the default here) always reaches its Stage 1 extractor —
// a real `claude` binary would make this NUL-byte guard test spawn an actual
// billed Sonnet call. A dead bin path makes `askSonnet` fail fast and free
// (runToolless resolves "" on spawn error), same fail-open posture the gate
// already guarantees.
const OFFLINE = { ...process.env, SUPABASE_URL: "http://127.0.0.1:1", CLAIM_FRESHNESS_CLAUDE_BIN: "/nonexistent/claude" };

async function run(item) {
  const f = path.join(os.tmpdir(), `sir-nul-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(item));
  try {
    // The four plain-language card parts are required since rubric schema v4;
    // pass them so these tests reach the NUL guard they exercise.
    await exec(BIN, ["--type", "code-fix", "--summary", "nul-guard self-test",
      "--problem", "test", "--impact", "test", "--fix", "test", "--side-effects", "none",
      "--files-json", f],
      { timeout: 20000, env: OFFLINE });
    return { code: 0, stderr: "" };
  } catch (e) {
    return { code: e.code, stderr: String(e.stderr || "") };
  } finally {
    fs.unlinkSync(f);
  }
}

test("a staged file containing a raw NUL is rejected with exit 64, before any insert", async () => {
  const r = await run({ files: { "bin/example": `line one\nconst SEP = "${NUL}";\n` } });
  assert.equal(r.code, 64, `expected exit 64 (bad --files-json), got ${r.code}`);
  assert.match(r.stderr, /NUL byte \(U\+0000\)/);
  // lang-regex-ok: matches this CLI's own stderr, machine-generated structure, not language
  assert.ok(r.stderr.includes("bin/example"), "the error must name the offending file");
  // lang-regex-ok: matches this CLI's own stderr, machine-generated structure, not language
  assert.match(r.stderr, /22P05/, "the error must cite the Postgres code the caller would otherwise see");
  assert.doesNotMatch(r.stderr, /at async|at file:\/\//, "must not surface as a stack trace");
});

test("the rejection reports the NUL's line and byte offset", async () => {
  // "aa\n" = 3 bytes, then "bb" = 2 -> the NUL sits at byte offset 5, on line 2.
  const r = await run({ files: { "a/b.js": `aa\nbb${NUL}cc` } });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /line 2/);
  assert.match(r.stderr, /byte offset 5/);
});

test("a clean file map is not rejected by the NUL guard", async () => {
  // Runs against the dead address above, so it fails at the insert rather than
  // filing anything. The assertion is on WHICH failure: not the NUL guard.
  const r = await run({ files: { "bin/example": "no nul bytes here\n" } });
  assert.doesNotMatch(r.stderr, /NUL byte/, "clean content must pass the NUL guard");
  assert.notEqual(r.code, 64, "a clean map must get past --files-json validation entirely");
});
