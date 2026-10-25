import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReplyFile, readReplyFile, composeReply } from "../lib/reply-file.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reply-file-"));

test("round-trips a message and composes a lead-in", () => {
  const dir = tmp();
  const p = writeReplyFile("**A** — b\n\nc", { dir });
  assert.equal(readReplyFile(p, { dir }), "**A** — b\n\nc");
  assert.equal(composeReply({ message_file: p }, { dir }), "**A** — b\n\nc");
  assert.equal(composeReply({ message: "Tonight:", message_file: p }, { dir }), "Tonight:\n\n**A** — b\n\nc");
  assert.equal(composeReply({ message: "plain" }, { dir }), "plain");
});

test("refuses files outside the reply dir, traversal and symlinks out", () => {
  const dir = tmp();
  const outside = path.join(tmp(), "secret.txt");
  fs.writeFileSync(outside, "nope");
  assert.throws(() => readReplyFile(outside, { dir }), /must be under/);
  assert.throws(() => readReplyFile(path.join(dir, "..", path.basename(outside)), { dir }), /not found|must be under/);
  fs.symlinkSync(outside, path.join(dir, "link.md"));
  assert.throws(() => readReplyFile(path.join(dir, "link.md"), { dir }), /must be under/);
});

test("refuses missing, empty, and absent input", () => {
  const dir = tmp();
  assert.throws(() => readReplyFile(path.join(dir, "x.md"), { dir }), /not found/);
  fs.writeFileSync(path.join(dir, "e.md"), "  \n");
  assert.throws(() => readReplyFile(path.join(dir, "e.md"), { dir }), /empty/);
  assert.throws(() => composeReply({}, { dir }), /needs/);
});

test("prunes files older than a day on write", () => {
  const dir = tmp();
  const old = writeReplyFile("old", { dir, now: Date.now() });
  const past = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(old, past, past);
  writeReplyFile("new", { dir });
  assert.equal(fs.existsSync(old), false);
});
