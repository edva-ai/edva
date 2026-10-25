// event-log-rotation.test.mjs — size-bounded rotation of the supervisor's
// append-only NDJSON streams.
//
// Regression cover: unbounded, supervisor-ops/events.ndjson can reach
// multiple GB, which breaks every reader that slurps it and fills the disk.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { EventLog } from "../supervisor/event-log.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evlog-"));
}

// Rotation is fired from an async fs.stat callback and the gzip runs through a
// stream pipeline, so wait for the artifact rather than assuming it's immediate.
async function waitFor(predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const archives = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith("events.ndjson.") && f.endsWith(".gz"));

describe("EventLog rotation", () => {
  test("does not rotate a small stream", async () => {
    const dir = tmpDir();
    const log = new EventLog(dir);
    for (let i = 0; i < 2000; i++) log.append({ kind: "test", i });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(archives(dir).length, 0);
    assert.ok(fs.existsSync(path.join(dir, "events.ndjson")));
  });

  test("rotates past the size cap, gzips the old generation, and keeps appending", async () => {
    const dir = tmpDir();
    const log = new EventLog(dir);
    const eventsPath = path.join(dir, "events.ndjson");

    // Pre-seed past the 256MB cap without writing 256MB: the size check stats
    // the real file, so a sparse file of the right length is enough.
    const fd = fs.openSync(eventsPath, "w");
    fs.ftruncateSync(fd, 300 * 1024 * 1024);
    fs.closeSync(fd);
    assert.ok(fs.statSync(eventsPath).size > 256 * 1024 * 1024);

    // CHECK_EVERY is 500, so this crosses the amortised size check.
    for (let i = 0; i < 600; i++) log.append({ kind: "test", i });

    assert.ok(await waitFor(() => archives(dir).length === 1), "expected exactly one gzipped archive");

    // Between the rename and the next append the live path legitimately does
    // not exist — fs.appendFile recreates it by path. Readers tolerate this
    // (readTailLines returns [] for a missing file), so the assertion is
    // "small or absent", not "small".
    const liveSize = () => (fs.existsSync(eventsPath) ? fs.statSync(eventsPath).size : 0);
    assert.ok(await waitFor(() => liveSize() < 1024 * 1024), "live file should be small again");
    log.append({ kind: "after-rotation" });
    await new Promise((r) => setTimeout(r, 200));
    const tail = fs.readFileSync(eventsPath, "utf8");
    assert.ok(tail.includes("after-rotation"), "appends must continue after rotation");

    // The uncompressed intermediate must be cleaned up, and the archive must be
    // real gzip (history preserved, not discarded). The .gz path is created by
    // createWriteStream up front, so its mere existence doesn't mean the
    // pipeline finished — the unlink of the uncompressed file is the actual
    // completion signal, so wait on that.
    const leftover = () => fs.readdirSync(dir).filter((f) => f.startsWith("events.ndjson.") && !f.endsWith(".gz"));
    assert.ok(await waitFor(() => leftover().length === 0), "uncompressed rotated file should be removed after gzip");
    const gz = path.join(dir, archives(dir)[0]);
    assert.doesNotThrow(() => zlib.gunzipSync(fs.readFileSync(gz)).slice(0, 64));
  });

  test("cost and job-cost streams rotate independently of events", async () => {
    const dir = tmpDir();
    const log = new EventLog(dir);
    const costPath = path.join(dir, "cost.ndjson");
    const fd = fs.openSync(costPath, "w");
    fs.ftruncateSync(fd, 300 * 1024 * 1024);
    fs.closeSync(fd);

    for (let i = 0; i < 600; i++) log.appendCost({ total_cost_usd: 0.01 });

    assert.ok(
      await waitFor(() => fs.readdirSync(dir).some((f) => f.startsWith("cost.ndjson.") && f.endsWith(".gz"))),
      "cost.ndjson should rotate on its own size",
    );
    assert.equal(archives(dir).length, 0, "events.ndjson should be untouched");
  });
});
