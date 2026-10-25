// jev-pending.test.mjs — the "compare this later" store resolves each id once and
// compaction never loses a resolved mark or a freshly appended row (review 2026-09-23).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-pending-"));
process.env.JEV_SHADOW_DIR = tmp;
const P = await import("../lib/jev-pending.mjs");
const S = "t-site";
const resolvedFile = path.join(tmp, `${S}-resolved.json`);

beforeEach(() => { for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); });

test("markResolved is once-only", () => {
  P.appendPending(S, { id: "a" });
  assert.equal(P.markResolved(S, "a"), true);
  assert.equal(P.markResolved(S, "a"), false);
});

test("compaction drops resolved rows and their marks, keeps unresolved rows and their state", () => {
  P.appendPending(S, { id: "done" });
  P.appendPending(S, { id: "open" });
  P.markResolved(S, "done");
  P.compactPending(S);
  assert.deepEqual(P.readPending(S).map((r) => r.id), ["open"]);
  assert.deepEqual(Object.keys(P.loadResolved(S)), [], "mark forgotten only with its row");
});

test("a mark written for a row that is still pending survives compaction", () => {
  P.appendPending(S, { id: "x", ts: new Date(Date.now() - 1000).toISOString() });
  // Simulate the detached shadow resolving `x` after the compactor snapshotted:
  // write the mark straight to disk, bypassing any in-memory snapshot.
  P.appendPending(S, { id: "late" });
  fs.writeFileSync(resolvedFile, JSON.stringify({ late: { how: "shadow", ts: new Date().toISOString() } }));
  P.compactPending(S);
  // `late` was resolved → its row goes; nothing else is lost, and the file is valid JSON.
  assert.deepEqual(P.readPending(S).map((r) => r.id), ["x"]);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(resolvedFile, "utf8")));
});

test("no stray tmp or lock files after compaction", () => {
  P.appendPending(S, { id: "a" });
  P.markResolved(S, "a");
  P.compactPending(S);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => /tmp-|\.lock$/.test(f)), []);
});
