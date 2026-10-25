// email-mem-args.test.mjs — a flag name must never become a memory body.
//
// `email-mem add` read the body positionally as args[1] and nothing else, so
// the flag form `email-mem add --text "..." --tags "..."` stored the literal
// string "--text", and a caller leading with --tags stored "--tags". Rows in a
// live store were corrupted that way. A corrupt
// row is not inert: email-mem rows are precedent the triage pass reads, so a
// body of "--tags" is a memory that matches nothing and dilutes the store.
//
// Runs the real CLI as a subprocess against a stubbed email-memory module, so
// nothing here can reach the live database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// Build a sandbox that mirrors the bin/lib layout email-mem requires, with a
// fake ../lib/email-memory that records calls to a JSON file.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-mem-test-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "lib"));
  const log = path.join(dir, "calls.json");
  fs.writeFileSync(path.join(dir, "lib", "email-memory.js"), `
    const fs = require("node:fs");
    const LOG = ${JSON.stringify(log)};
    const rows = [
      { id: 1001, created_at: "2026-07-01", text: "--text", tags: "" },
      { id: 1002, created_at: "2026-07-20", text: "--tags", tags: "" },
      { id: 1003, created_at: "2026-08-01", text: "A real memory", tags: "tax" },
    ];
    function record(call) {
      const prev = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
      prev.push(call); fs.writeFileSync(LOG, JSON.stringify(prev));
    }
    module.exports = {
      add(o) { record({ fn: "add", arg: o }); return 999; },
      list() { return rows; },
      remove(id) { record({ fn: "remove", arg: id }); },
      update() {}, search() { return []; }, searchForEmail() { return []; },
      formatForPrompt() { return ""; },
    };
  `);
  fs.copyFileSync(path.join(ROOT, "bin", "email-mem"), path.join(dir, "bin", "email-mem"));
  return { dir, bin: path.join(dir, "bin", "email-mem"), log };
}

function run(bin, args) {
  try {
    const stdout = execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

const calls = (log) => (fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : []);

test("the positional form still works", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["add", "Already handled the quarterly tax form", "--tags", "tax,forms"]);
  assert.equal(r.code, 0);
  assert.deepEqual(calls(log)[0].arg, { text: "Already handled the quarterly tax form", tags: "tax,forms", expiresAt: null });
});

test("--text is accepted as the body (the form that used to corrupt)", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["add", "--text", "Ignore noreply@example.com", "--tags", "example.com"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls(log)[0].arg.text, "Ignore noreply@example.com");
  assert.equal(calls(log)[0].arg.tags, "example.com");
});

test("a leading --tags is refused, not stored as the body", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["add", "--tags", "tax,forms"]);
  assert.notEqual(r.code, 0, "should exit non-zero");
  assert.match(r.stderr, /is a flag, not the memory text/);
  assert.equal(calls(log).length, 0, "nothing may reach the store");
});

test("no argument at all is still a usage error", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["add"]);
  assert.notEqual(r.code, 0);
  assert.equal(calls(log).length, 0);
});

test("repair reports corrupt rows and removes nothing by default", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["repair"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 corrupt memories/);
  assert.match(r.stdout, /#1001/);
  assert.match(r.stdout, /#1002/);
  assert.doesNotMatch(r.stdout, /#1003/, "a real memory must not be listed");
  assert.equal(calls(log).length, 0, "read-only without --apply");
});

test("repair --apply removes exactly the corrupt rows", () => {
  const { bin, log } = sandbox();
  const r = run(bin, ["repair", "--apply"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(calls(log).map((c) => c.arg), [1001, 1002]);
});
