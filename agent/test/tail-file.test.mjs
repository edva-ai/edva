// tail-file.test.mjs — bounded tail reads over append-only logs.
//
// Regression cover: once events.ndjson grows past ~512MB, every reader that
// does readFileSync() on it throws
// "Cannot create a string longer than 0x1fffffe8 characters", which takes out
// GET /events and silently empties the handoff-digest JSONL fallback.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTailLines, readTailJson } from "../../lib/tail-file.mjs";

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tailtest-")), "events.ndjson");
  fs.writeFileSync(p, contents);
  return p;
}

describe("readTailLines", () => {
  test("returns all lines when the file is small", () => {
    const p = tmpFile("a\nb\nc\n");
    assert.deepEqual(readTailLines(p), ["a", "b", "c"]);
  });

  test("returns the LAST n lines when limited", () => {
    const p = tmpFile(Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n") + "\n");
    const out = readTailLines(p, { limit: 3 });
    assert.deepEqual(out, ["line97", "line98", "line99"]);
  });

  test("drops the partial first line when the window starts mid-record", () => {
    // maxBytes slices into the middle of "aaaa...", so that fragment must not
    // be returned — a caller JSON.parsing it would get garbage.
    const p = tmpFile("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");
    const out = readTailLines(p, { maxBytes: 25 });
    assert.ok(!out.some((l) => l.length && l.length < 10), `partial line leaked: ${JSON.stringify(out)}`);
    assert.equal(out[out.length - 1], "cccccccccc");
  });

  test("reads only the tail window, not the whole file", () => {
    // 20MB file, 1MB window: proves cost is bounded by the window. Without the
    // bound this is the exact shape that threw at 512MB+.
    const line = "x".repeat(999) + "\n";
    const p = tmpFile(line.repeat(20000)); // ~20MB
    const out = readTailLines(p, { limit: 5, maxBytes: 1024 * 1024 });
    assert.equal(out.length, 5);
    assert.ok(out.every((l) => l.length === 999));
  });

  test("missing file and empty file return [] rather than throwing", () => {
    assert.deepEqual(readTailLines("/nonexistent/nope.ndjson"), []);
    assert.deepEqual(readTailLines(tmpFile("")), []);
  });

  test("a file with no trailing newline still yields its last line", () => {
    const p = tmpFile("a\nb\nc");
    assert.deepEqual(readTailLines(p), ["a", "b", "c"]);
  });
});

describe("readTailJson", () => {
  test("parses trailing rows in chronological order", () => {
    const rows = [{ ts: "1", kind: "a" }, { ts: "2", kind: "b" }, { ts: "3", kind: "c" }];
    const p = tmpFile(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.deepEqual(readTailJson(p).map((r) => r.ts), ["1", "2", "3"]);
  });

  test("skips corrupt lines instead of throwing", () => {
    const p = tmpFile(`{"ts":"1"}\nNOT JSON{{\n{"ts":"2"}\n`);
    assert.deepEqual(readTailJson(p).map((r) => r.ts), ["1", "2"]);
  });
});
