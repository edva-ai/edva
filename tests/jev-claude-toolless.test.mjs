// jev-claude-toolless.test.mjs — every claude -p in the Jev batches is tool-less,
// Max-only, and runs off the edva tree's settings (lib/jev-claude.mjs).
// Regression for the 2026-09-23 review: `--allowedTools ""` left built-ins, MCP
// servers and allow rules live, and most spawns leaked ANTHROPIC_API_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-claude-"));
const REC = path.join(tmp, "rec.json");
const STUB = path.join(tmp, "claude-stub.mjs");
fs.writeFileSync(STUB, `#!/usr/bin/env node
import fs from "node:fs";
let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(REC)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
    apiKey: process.env.ANTHROPIC_API_KEY ?? null, authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null, stdin: input }));
  process.stdout.write('{"ok": true}');
});
`, { mode: 0o755 });

const { runToolless, toollessArgs, parseModelJson } = await import("../lib/jev-claude.mjs");

test("runToolless: no tools, no MCP, no project/user settings, neutral cwd, Max-only env, prompt on stdin", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-should-not-leak";
  try {
    const out = await runToolless({ bin: STUB, model: "claude-sonnet-5", prompt: "PROMPT-TEXT" });
    assert.equal(out, '{"ok": true}');
    const r = JSON.parse(fs.readFileSync(REC, "utf8"));
    const i = r.argv.indexOf("--tools");
    assert.ok(i >= 0 && r.argv[i + 1] === "", "--tools \"\" disables every built-in");
    assert.ok(r.argv.includes("--strict-mcp-config"));
    assert.equal(r.argv[r.argv.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.equal(r.argv[r.argv.indexOf("--setting-sources") + 1], "project");
    assert.ok(!r.argv.includes("--allowedTools"), "the leaky flag is gone");
    assert.ok(!r.argv.includes("--bare"), "--bare would skip the keychain (Max credential)");
    assert.equal(fs.realpathSync(r.cwd), fs.realpathSync(os.tmpdir()));
    assert.equal(r.apiKey, null); assert.equal(r.authToken, null);
    assert.equal(r.stdin, "PROMPT-TEXT"); assert.ok(!r.argv.includes("PROMPT-TEXT"));
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; }
});

test("runToolless fails soft: a missing binary resolves empty", async () => {
  assert.equal(await runToolless({ bin: path.join(tmp, "nope"), model: "haiku", prompt: "x" }), "");
});

test("parseModelJson handles fenced, nested and trailing-prose replies", () => {
  assert.deepEqual(parseModelJson('```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.deepEqual(parseModelJson('{"verdict":"pass"} and then {braces} in prose'), { verdict: "pass" });
  assert.equal(parseModelJson("no json"), null);
});

test("guard: no Jev-batch file spawns claude with the old leaky flags", () => {
  const files = [
    "bin/outbound-precheck.mjs", "bin/claim-check", "lib/claim-freshness.mjs",
    "bin/memory-write-precheck.mjs", "lib/auto-recall.mjs", "lib/jev-email-triage.mjs",
    "bin/jev-gate-shadow", "lib/jev-hum-gate.mjs", "lib/jev-gates.mjs",
  ]; // (this installation's P1 gate: jev-claude-toolless-local.test.mjs)
  for (const f of files) {
    const s = fs.readFileSync(path.resolve(f), "utf8");
    assert.ok(!/"--allowedTools",\s*""/.test(s), `${f} still spawns claude with --allowedTools ""`);
  }
  assert.deepEqual(toollessArgs("m").slice(0, 3), ["-p", "--model", "m"]);
});

test("parseModelJson uses the balanced extractor: prose braces before/after the object no longer break it", async () => {
  const { parseModelJson } = await import("../lib/jev-claude.mjs");
  assert.deepEqual(parseModelJson('I weighed {two} options. {"label":"P3","p":0.9} Hope that {helps}.'), { label: "P3", p: 0.9 });
  assert.deepEqual(parseModelJson('{"a":{"b":"x } y"}}'), { a: { b: "x } y" } });
  assert.equal(parseModelJson("no object"), null);
  assert.equal(parseModelJson(""), null);
});

// ─── not_logged_in ─────────
// Regression for the 2026-10-13 system alerts "claim-freshness extractor failed
// 11 of the last 50 checks (22%; unparseable 11)" and "outbound precheck got no
// usable answer for 6 of the last 21 messages (29%; no_json 6)": a fork that
// could not read the Max login printed the CLI's auth banner on stdout, and it
// came back as a 33-char "model answer". It must be "" + kind not_logged_in.
const BANNER = "Not logged in · Please run /login";
function stubPrinting({ stdout = "", stderr = "", exit = 0 }) {
  const f = path.join(tmp, `claude-stub-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = ${exit};
});
`, { mode: 0o755 });
  return f;
}
const { runToollessDetailed, NOT_LOGGED_IN_PREFIX } = await import("../lib/jev-claude.mjs");

test("not_logged_in: the CLI auth banner on stdout (exit 0) is an auth failure, not an answer", async () => {
  assert.equal(BANNER.length, 33, "the banner the 10-13 alerts counted as 33 chars of output");
  const bin = stubPrinting({ stdout: `${BANNER}\n` });
  const r = await runToollessDetailed({ bin, model: "claude-sonnet-5-5", prompt: "x" });
  assert.equal(r.out, "");
  assert.equal(r.error?.kind, "not_logged_in");
  assert.equal(r.error?.message, BANNER);
  assert.equal(await runToolless({ bin, model: "claude-sonnet-5-5", prompt: "x" }), "");
});

test("not_logged_in: the banner with a non-zero exit is still not_logged_in, not exit_nonzero", async () => {
  const bin = stubPrinting({ stdout: BANNER, exit: 1 });
  const r = await runToollessDetailed({ bin, model: "claude-sonnet-5-5", prompt: "x" });
  assert.deepEqual([r.out, r.error?.kind], ["", "not_logged_in"]);
  assert.equal(await runToolless({ bin, model: "claude-sonnet-5-5", prompt: "x" }), "");
});

test("not_logged_in: the banner on stderr with empty stdout is classified the same way", async () => {
  const bin = stubPrinting({ stderr: `${BANNER}\nmore detail`, exit: 1 });
  const r = await runToollessDetailed({ bin, model: "claude-sonnet-5-5", prompt: "x" });
  assert.deepEqual([r.out, r.error?.kind, r.error?.message], ["", "not_logged_in", BANNER]);
});

test("not_logged_in: a normal JSON reply (and one merely mentioning the phrase) is untouched", async () => {
  const ok = await runToollessDetailed({ bin: stubPrinting({ stdout: '{"claims": []}\n' }), model: "m", prompt: "x" });
  assert.deepEqual(ok, { out: '{"claims": []}', error: null });
  const mention = `{"reason": "${NOT_LOGGED_IN_PREFIX} appears mid-answer"}`;
  const r = await runToollessDetailed({ bin: stubPrinting({ stdout: mention }), model: "m", prompt: "x" });
  assert.deepEqual(r, { out: mention, error: null });
  const nz = await runToollessDetailed({ bin: stubPrinting({ exit: 2 }), model: "m", prompt: "x" });
  assert.deepEqual([nz.out, nz.error?.kind], ["", "exit_nonzero"]);
});

// ─── usage_limit (2026-10-24, the wiki's API fallback) ──────────────────────
// A Max account that is signed in but out of usage prints the CLI's limit
// status line instead of an answer. Like the auth banner, it must never come
// back as a model answer — and it is one of the two kinds the wiki's API
// fallback acts on (model-ladder.mjs MAX_UNAVAILABLE).
const { USAGE_LIMIT_PREFIXES } = await import("../lib/jev-claude.mjs");

test("usage_limit: the CLI's limit line (stdout or stderr) is classified, not answered", async () => {
  for (const line of ["You've hit your limit · resets 3pm (UTC)", "Claude AI usage limit reached|1761300000"]) {
    const r = await runToollessDetailed({ bin: stubPrinting({ stdout: `${line}\n` }), model: "m", prompt: "x" });
    assert.deepEqual([r.out, r.error?.kind, r.error?.message], ["", "usage_limit", line]);
    const e = await runToollessDetailed({ bin: stubPrinting({ stderr: line, exit: 1 }), model: "m", prompt: "x" });
    assert.deepEqual([e.out, e.error?.kind], ["", "usage_limit"]);
  }
});

test("usage_limit: an answer that merely opens with the words is untouched", async () => {
  const answer = `${USAGE_LIMIT_PREFIXES[4]} for the month on that card.\nThe statement shows the rest.`;
  const r = await runToollessDetailed({ bin: stubPrinting({ stdout: answer }), model: "m", prompt: "x" });
  assert.deepEqual(r, { out: answer, error: null });
});
