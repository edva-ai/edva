// spam-filter `--scam` / `--message` / `check --json`. A scam entry is
// what intake moves to Gmail's Spam folder; a plain entry only silences a real
// sender. Runs the real CLI against a temp HOME, with gmail-action stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = new URL("../bin/spam-filter", import.meta.url).pathname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spam-filter-"));
const DATA = path.join(HOME, "Dev/edva/data");
const FILE = path.join(DATA, "spam-blocklist.json");
const GA = path.join(HOME, "gmail-action-stub");
const GA_LOG = path.join(HOME, "gmail-action-calls.txt");
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(GA, `#!/bin/sh\necho "$@" >> "${GA_LOG}"\n[ "$2" = "refuse-me" ] && exit 3\nexit 0\n`, { mode: 0o755 });

function sf(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, HOME, SPAM_FILTER_GMAIL_ACTION: GA } });
  return { status: r.status, out: r.stdout };
}
function seed(senders = []) {
  fs.writeFileSync(FILE, JSON.stringify({ blocklist: { senders, topics: [] }, allowlist: { senders: [], topics: [] } }));
  fs.rmSync(GA_LOG, { force: true });
}
const entries = () => JSON.parse(fs.readFileSync(FILE, "utf8")).blocklist.senders;
const gaCalls = () => { try { return fs.readFileSync(GA_LOG, "utf8").trim().split("\n"); } catch { return []; } };

test("block --scam stores the flag; check --json reports it, still exit 2", () => {
  seed();
  assert.equal(sf("block", "--sender", "@Scam.example", "--reason", "fake insurance", "--scam").status, 0);
  assert.deepEqual(entries().map((e) => [e.pattern, e.scam]), [["@scam.example", true]]);
  const c = sf("check", "--sender", "no-reply@scam.example", "--json");
  assert.equal(c.status, 2);
  assert.deepEqual(JSON.parse(c.out), { result: "blocked", list: "sender", pattern: "@scam.example", reason: "fake insurance", scam: true });
});

test("a plain block carries no scam flag, and check --json says so", () => {
  seed();
  sf("block", "--sender", "payouts@marketplace.example");
  assert.equal(entries()[0].scam, undefined);
  assert.equal(JSON.parse(sf("check", "--sender", "payouts@marketplace.example", "--json").out).scam, false);
  assert.equal(JSON.parse(sf("check", "--sender", "a@clean.example", "--json").out).result, "pass");
});

test("--scam on an already-blocked pattern upgrades it instead of a no-op", () => {
  seed([{ pattern: "@old.example", reason: "r", added: "2026-01-01" }]);
  assert.match(sf("block", "--sender", "@old.example", "--scam").out, /Marked as scam/);
  assert.deepEqual(entries(), [{ pattern: "@old.example", reason: "r", added: "2026-01-01", scam: true }]);
});

test("--message moves the email to Spam on a scam block, marks it read on a plain one", () => {
  seed();
  sf("block", "--sender", "@scam.example", "--scam", "--message", "m1");
  sf("block", "--sender", "@quiet.example", "--message", "m2");
  assert.deepEqual(gaCalls(), ["spam m1", "mark-read m2"]);
});

test("a refused Spam move surfaces gmail-action's exit code; the block itself stays", () => {
  seed();
  assert.equal(sf("block", "--sender", "@scam.example", "--scam", "--message", "refuse-me").status, 3);
  assert.equal(entries()[0].scam, true);
});

test("plain text check output is unchanged apart from the scam tag", () => {
  seed([{ pattern: "@q.example", reason: "noise", added: "x" }, { pattern: "@s.example", reason: "", added: "x", scam: true }]);
  assert.equal(sf("check", "--sender", "a@q.example").out.trim(), 'BLOCKED: a@q.example matches "@q.example" (noise)');
  assert.match(sf("check", "--sender", "a@s.example").out, /\[scam: to Spam\]/);
});
