// D15: one shared atomic writer, lib/atomic-write.js, plus
// its Python twin. A reader must see the old file or the new one, never a
// truncated one; permissions and symlinks survive; no temp file is left behind.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileAtomic, writeJsonAtomic } from "../lib/atomic-write.js";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));

test("writes, replaces, and leaves no temp file", () => {
  const d = tmpdir(), f = path.join(d, "s.json");
  writeJsonAtomic(f, { a: 1 });
  assert.equal(fs.readFileSync(f, "utf8"), '{\n  "a": 1\n}\n');
  writeJsonAtomic(f, { a: 2 }, { indent: 0 });
  assert.equal(fs.readFileSync(f, "utf8"), '{"a":2}');
  assert.deepEqual(fs.readdirSync(d), ["s.json"]);
});

test("creates missing directories", () => {
  const f = path.join(tmpdir(), "x", "y", "z.txt");
  writeFileAtomic(f, "hi");
  assert.equal(fs.readFileSync(f, "utf8"), "hi");
});

test("keeps the existing file's mode, or takes an explicit one", () => {
  const f = path.join(tmpdir(), "tok.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(f, 0o600);
  writeFileAtomic(f, '{"t":1}');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  writeFileAtomic(f, '{"t":2}', { mode: 0o640 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
});

test("writes through a symlink instead of replacing it", () => {
  const d = tmpdir(), real = path.join(d, "real.json"), link = path.join(d, "link.json");
  fs.writeFileSync(real, "old");
  fs.symlinkSync(real, link);
  writeFileAtomic(link, "new");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(real, "utf8"), "new");
});

test("a failed write leaves the old content and no temp file", () => {
  const d = tmpdir(), f = path.join(d, "s.json");
  fs.writeFileSync(f, "old");
  // A BigInt cannot be JSON-serialised: the throw happens before any write.
  assert.throws(() => writeJsonAtomic(f, { n: 1n }));
  // A write into a directory that is the target: rename fails after the temp was written.
  const dirTarget = path.join(d, "adir");
  fs.mkdirSync(dirTarget);
  fs.writeFileSync(path.join(dirTarget, "keep"), "x");
  assert.throws(() => writeFileAtomic(dirTarget, "data"));
  assert.equal(fs.readFileSync(f, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(d).sort(), ["adir", "s.json"]);
});

test("a concurrent reader never sees a partial file", async () => {
  const f = path.join(tmpdir(), "hot.json");
  const big = (n) => ({ n, pad: "x".repeat(200_000) });
  writeJsonAtomic(f, big(0));
  // Writer and reader in two child processes, racing for ~1.2 s.
  const writer = `
    const { writeJsonAtomic } = require(${JSON.stringify(path.join(ROOT, "lib/atomic-write.js"))});
    const end = Date.now() + 1500; let i = 0;
    while (Date.now() < end) writeJsonAtomic(${JSON.stringify(f)}, { n: i++, pad: "x".repeat(200000) }, { fsync: false });
  `;
  const readerSrc = `
    const fs = require("fs"); let bad = 0, n = 0; const end = Date.now() + 1200;
    while (Date.now() < end) { try { JSON.parse(fs.readFileSync(${JSON.stringify(f)}, "utf8")); n++; } catch { bad++; } }
    process.stdout.write(JSON.stringify({ bad, n }));
  `;
  const { spawn } = await import("node:child_process");
  const w = spawn(process.execPath, ["-e", writer]);
  const r = spawn(process.execPath, ["-e", readerSrc]);
  let out = "";
  r.stdout.on("data", (c) => { out += c; });
  await Promise.all([new Promise((res) => w.on("exit", res)), new Promise((res) => r.on("exit", res))]);
  const { bad, n } = JSON.parse(out);
  assert.ok(n > 0, "the reader read nothing");
  assert.equal(bad, 0, `${bad} torn reads out of ${bad + n}`);
});

test("python twin: atomic_write.write_json_atomic", () => {
  const d = tmpdir(), f = path.join(d, "p.json");
  fs.writeFileSync(f, "{}");
  fs.chmodSync(f, 0o600);
  const r = spawnSync("python3", ["-I", "-c", `
import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "lib"))})
from atomic_write import write_json_atomic
write_json_atomic(${JSON.stringify(f)}, {"a": [1, 2]}, indent=2, newline=True)
`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(f, "utf8"), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(d), ["p.json"]);
});

// (this installation's own writers: atomic-write-local.test.mjs)
test("the migrated hot writers use the shared helper, not a bare writeFileSync", () => {
  const sites = {
    "lib/ping-hold.mjs": "writeFileAtomic(file, JSON.stringify(entries",
    "lib/claim-freshness.mjs": "writeFileAtomic(HEALTH_FILE",
    "lib/apns-push.mjs": "writeFileAtomic(FAILURE_FILE",
    "lib/edva-context.js": "writeFileAtomic(CACHE_FILE",
    "agent/phone-channel/index.mjs": "writeFileAtomic(LOCATION_EDGE_SEEN",
    "agent/supervisor/index.mjs": 'writeFileAtomic(path.join(this.dataDir, "handoff-digest.json")',
    "bin/cdp.py": "write_json_atomic(STATE, s)",
  };
  for (const [f, needle] of Object.entries(sites)) {
    assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes(needle), `${f} lost its atomic write (${needle})`);
  }
});
