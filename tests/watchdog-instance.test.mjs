// watchdog-instance — watchdog.sh takes the installation's identity (tunnel
// host, Supabase project, owner address) from lib/instance.cjs via
// lib/instance.sh, never from literals. Synthetic values through the env
// overrides, which win over agent/local/instance.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT as ROOT } from "../lib/root.cjs";
const SCRIPTS = path.join(ROOT, "agent/scripts");
const SRC = fs.readFileSync(path.join(SCRIPTS, "watchdog.sh"), "utf8");
const line = (prefix) => SRC.split("\n").find((l) => l.startsWith(prefix));

// Source lib/instance.sh with the given env, then evaluate `body`.
function evalWith(env, body) {
  return execFileSync("bash", ["-c", `source ${JSON.stringify(path.join(SCRIPTS, "lib/instance.sh"))}\n${body}`],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } }).trim();
}

test("the tunnel host is EDVA_PUSH_HOST, else gmail-push.<domain>, else empty", () => {
  const l = line("CLOUDFLARED_HOST=");
  assert.ok(l, "CLOUDFLARED_HOST is assigned at top level");
  assert.equal(evalWith({ EDVA_DOMAIN: "example.test" }, `${l}\necho "$CLOUDFLARED_HOST"`), "gmail-push.example.test");
  assert.equal(evalWith({ EDVA_DOMAIN: "example.test", EDVA_PUSH_HOST: "push.example.org" }, `${l}\necho "$CLOUDFLARED_HOST"`), "push.example.org");
  // No domain at all (a fresh install): no host, and the probe has nothing to check.
  assert.equal(execFileSync("bash", ["-c", `EDVA_DOMAIN=""; ${l}\necho "[$CLOUDFLARED_HOST]"`], { encoding: "utf8" }).trim(), "[]");
});

test("the tunnel probe treats a missing host as nothing to probe", () => {
  const start = SRC.indexOf("\ncloudflared_tunnel_probe() {");
  const fn = SRC.slice(start + 1, SRC.indexOf("\n}\n", start) + 3);
  const out = execFileSync("bash", ["-c", `curl() { echo CALLED; return 1; }\n${fn}\nCLOUDFLARED_HOST=""\ncloudflared_tunnel_probe; echo "rc=$?"`], { encoding: "utf8" });
  assert.match(out, /rc=0/);
  assert.doesNotMatch(out, /CALLED/);
});

test("the Supabase URL comes from the instance project; none configured → empty", () => {
  const l = line("SUPABASE_URL=");
  assert.equal(evalWith({ EDVA_SUPABASE_PROJECT: "abcdefgh" }, `${l}\necho "$SUPABASE_URL"`), "https://abcdefgh.supabase.co");
  assert.equal(execFileSync("bash", ["-c", `EDVA_SUPABASE_PROJECT=""; ${l}\necho "[$SUPABASE_URL]"`], { encoding: "utf8" }).trim(), "[]");
});

test("no identity literal is left in watchdog.sh's code", () => {
  for (const re of [/--to [a-z0-9._%+-]+@/i, /\.supabase\.co"/, /--account=[a-z0-9._%+-]+@/i]) {
    const hit = SRC.split("\n").find((l) => re.test(l) && !l.includes("$"));
    assert.equal(hit, undefined, `literal identity in: ${hit}`);
  }
});

test("the instance's own checks are optional: _incident_label falls back to the key", () => {
  const start = SRC.indexOf("\n_incident_label() {");
  const fn = SRC.slice(start + 1, SRC.indexOf("\n}\n", start) + 3);
  assert.equal(execFileSync("bash", ["-c", `${fn}\n_incident_label some-new-key`], { encoding: "utf8" }).trim(), "some-new-key");
  const ext = `_ext_incident_label() { case "$1" in mine) echo "my label" ;; *) return 1 ;; esac; }`;
  assert.equal(execFileSync("bash", ["-c", `${ext}\n${fn}\n_incident_label mine; _incident_label gog-auth; _incident_label other`], { encoding: "utf8" }).trim(),
    "my label\ngog (Google Tasks/Calendar/Drive) auth\nother");
});
