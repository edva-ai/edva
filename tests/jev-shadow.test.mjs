// jev-shadow.test.mjs — contract of the Jev-primary / legacy-shadow harness.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-shadow-"));
process.env.JEV_CONFIG_FILE = path.join(tmp, "jev-config.json");
process.env.JEV_QUESTIONS_DIR = path.join(tmp, "q");
process.env.JEV_SHADOW_DIR = path.join(tmp, "log");
process.env.JEV_NO_ALERT = "1";
process.env.TYPESAFE_API_KEY = "test-key";
fs.mkdirSync(process.env.JEV_QUESTIONS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.JEV_QUESTIONS_DIR, "t.json"), JSON.stringify({
  threshold: 0.8,
  questions: { yes: { type: "boolean", instructions: "Is {{thing}} true?" } },
}));

const { decide } = await import("../lib/jev-shadow.mjs");
const { answerConfidence } = await import("../lib/jev.mjs");

let lastBody = null;
function stubJev(probability) {
  globalThis.fetch = async (_url, init) => {
    lastBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ answers: { yes: { type: "boolean", probability } }, providerMetadata: { gateway: { cost: "0.00001" } } }), { status: 200 });
  };
}
const interpret = (a) => ({ value: a.yes.probability >= 0.5, confidence: answerConfidence(a.yes) });
function rows(file) {
  const f = path.join(process.env.JEV_SHADOW_DIR, file);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}
function logRows() {
  return fs.readdirSync(process.env.JEV_SHADOW_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).flatMap(rows);
}

beforeEach(() => {
  fs.rmSync(process.env.JEV_SHADOW_DIR, { recursive: true, force: true });
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: null, sites: {} }));
  lastBody = null;
});

test("confident Jev is primary; legacy runs as shadow; agreement logged", async () => {
  stubJev(0.97);
  let legacyCalls = 0;
  const r = await decide({ site: "t", id: "a", state: "s", vars: { thing: "X" }, interpret, legacy: async () => { legacyCalls++; return true; } });
  assert.equal(r.used, "jev");
  assert.equal(r.value, true);
  assert.equal(legacyCalls, 1);
  assert.equal(lastBody.questions.yes.instructions, "Is X true?");
  assert.equal(lastBody.model, "jev-latest");
  assert.equal(lastBody.providerOptions, undefined);
  const [row] = logRows();
  assert.equal(row.agree, true);
  assert.equal(rows("disagreements.jsonl").length, 0);
  // first success stamps the one-week window
  const win = JSON.parse(fs.readFileSync(path.join(process.env.JEV_SHADOW_DIR, "window.json"), "utf8"));
  assert.ok(win.shadow_until && Date.parse(win.shadow_until) - Date.now() > 6.9 * 864e5);
  // the tracked config file is never written at runtime
  assert.equal(JSON.parse(fs.readFileSync(process.env.JEV_CONFIG_FILE, "utf8")).shadow_until, null);
});

test("disagreement is recorded when Jev acted", async () => {
  stubJev(0.95);
  const r = await decide({ site: "t", id: "b", state: "s", interpret, legacy: async () => false });
  assert.equal(r.used, "jev");
  const d = rows("disagreements.jsonl");
  assert.equal(d.length, 1);
  assert.equal(d[0].site, "t");
  assert.ok(d[0].did);
});

// A "🔀 Jev disagreement" page in the System tab was not actionable, and that
// channel is only for things the operator can or should act on. A disagreement goes to its log and
// nowhere else. Run in a child whose HOME holds a stub edva-send-curl
// (jev-shadow resolves the sender from os.homedir()), with JEV_NO_ALERT unset
// so the old page path would have fired into the stub, never a real channel.
test("a disagreement is logged, never posted to a channel", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-shadow-home-"));
  const bin = path.join(home, "Dev/edva/bin");
  fs.mkdirSync(bin, { recursive: true });
  const sends = path.join(home, "sends.log");
  fs.writeFileSync(path.join(bin, "edva-send-curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sends}"\n`, { mode: 0o755 });
  const shadowDir = path.join(home, "shadow");
  const lib = new URL("../lib/jev-shadow.mjs", import.meta.url).href;
  const script = `
    const { recordLateComparison } = await import(${JSON.stringify(lib)});
    recordLateComparison({ site: "t", id: "late-1", jevRow: { jev: { value: "vendor", confidence: 0.9 }, used: "jev" }, legacyValue: "personal", agree: false });
    await new Promise((r) => setTimeout(r, 400));
  `;
  const env = { ...process.env, HOME: home, JEV_SHADOW_DIR: shadowDir };
  delete env.JEV_NO_ALERT;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const d = fs.readFileSync(path.join(shadowDir, "disagreements.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(d.length, 1);
  assert.equal(d[0].id, "late-1");
  assert.ok(d[0].did);
  assert.equal(fs.existsSync(sends), false, "no edva-send-curl call for a disagreement");
  fs.rmSync(home, { recursive: true, force: true });
});

test("low confidence falls back to legacy without running it twice", async () => {
  stubJev(0.6);
  let legacyCalls = 0;
  const r = await decide({ site: "t", id: "c", state: "s", interpret, legacy: async () => { legacyCalls++; return false; } });
  assert.equal(r.used, "legacy");
  assert.equal(r.reason, "jev-low-confidence");
  assert.equal(r.value, false);
  assert.equal(legacyCalls, 1);
});

test("side-effect-free shadow is used for comparison; acting legacy only on fallback", async () => {
  stubJev(0.99);
  let acted = 0, shadowed = 0;
  const r = await decide({ site: "t", id: "d", state: "s", interpret,
    legacy: async () => { acted++; return true; }, shadow: async () => { shadowed++; return true; } });
  assert.equal(r.used, "jev");
  assert.equal(acted, 0);
  assert.equal(shadowed, 1);
});

test("Jev transport error → legacy, logged", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  const r = await decide({ site: "t", id: "e", state: "s", interpret, legacy: async () => true });
  assert.equal(r.used, "legacy");
  assert.equal(r.reason, "jev-error");
  assert.match(logRows()[0].jev.error, /HTTP 500/);
});

test("after the window, legacy runs only as fallback", async () => {
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: new Date(Date.now() - 1000).toISOString() }));
  stubJev(0.99);
  let legacyCalls = 0;
  const r = await decide({ site: "t", id: "f", state: "s", interpret, legacy: async () => { legacyCalls++; return true; } });
  assert.equal(r.used, "jev");
  assert.equal(legacyCalls, 0);
});

test("site disabled → pure legacy, no Jev call", async () => {
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, sites: { t: { enabled: false } } }));
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not call"); };
  const r = await decide({ site: "t", id: "g", state: "s", interpret, legacy: async () => "L" });
  assert.equal(r.used, "legacy");
  assert.equal(r.value, "L");
  assert.equal(called, false);
});

test("skipJev keeps the call off Jev and withholds the input", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not call"); };
  const r = await decide({ site: "t", id: "h", state: "secret lab result", interpret, legacy: async () => "L", skipJev: "health-excluded" });
  assert.equal(r.used, "legacy");
  assert.equal(r.reason, "health-excluded");
  assert.equal(called, false);
  assert.equal(logRows()[0].input, "[withheld]");
});

test("privacyScreen: private state stays on legacy, input withheld, Jev not called", async () => {
  process.env.JEV_PRIVATE_SCREEN = "";
  let jevCalled = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("11434") || body.messages || body.prompt) {
      return new Response(JSON.stringify({ message: { content: "YES" }, response: "YES", done: true }), { status: 200 });
    }
    jevCalled = true; throw new Error("jev must not be called");
  };
  const r = await decide({ site: "t", id: "p", state: "my lab result came back high", interpret, legacy: async () => "L", privacyScreen: true });
  assert.equal(r.used, "legacy");
  assert.equal(r.reason, "sensitive-excluded");
  assert.equal(jevCalled, false);
  assert.equal(logRows()[0].input, "[withheld]");
});

test("privacy_exclusions:false → the content screen is skipped and Jev decides", async () => {
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: null, privacy_exclusions: false, sites: {} }));
  process.env.JEV_PRIVATE_SCREEN = "";
  let ollama = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/")) { ollama++; throw new Error("screen must not run"); }
    return new Response(JSON.stringify({ answers: { yes: { type: "boolean", probability: 0.97 } } }), { status: 200 });
  };
  const r = await decide({ site: "t", id: "po", state: "my lab result came back high", interpret, legacy: async () => false, privacyScreen: true });
  assert.equal(r.used, "jev");
  assert.equal(ollama, 0);
  const { privacyOn } = await import("../lib/jev-shadow.mjs");
  assert.equal(privacyOn(), false);
});

// --- gateway health: a refusal is not a wobble -----------------
// Guards the condition behind "🔴 Jev unavailable": the gateway answered 403
// "Free tier users do not have access to this model" on 569 consecutive calls
// over 5 days (2026-09-27 → 10-01) and the monitor still waited out its
// 4-errors-AND-an-hour noise filter before saying so, then kept calling.
const healthState = () => JSON.parse(fs.readFileSync(path.join(process.env.JEV_SHADOW_DIR, "health-state.json"), "utf8"));

test("a 403 refusal pages on the first error, opens the breaker, and stops calling", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: "Free tier users do not have access to this model." }), { status: 403 });
  };
  const r = await decide({ site: "t", id: "p1", state: "s", interpret, legacy: async () => true });
  assert.equal(r.used, "legacy");
  assert.equal(calls, 1);
  const st = healthState();
  assert.equal(st.permanent, true);
  assert.ok(st.alerted_at, "pages on the first refusal — no streak, no hour");
  assert.ok(Date.parse(st.breaker_until) > Date.now());

  // Second decision: the refusal is cached, so no round-trip is paid.
  const r2 = await decide({ site: "t", id: "p2", state: "s", interpret, legacy: async () => true });
  assert.equal(r2.used, "legacy");
  assert.equal(calls, 1, "breaker open → the gateway is not called again");
  const [, row2] = logRows();
  assert.equal(row2.jev.breaker, true);
  assert.match(row2.jev.error, /Free tier/);
  // One page per episode, not one per call.
  assert.equal(healthState().alerted_at, st.alerted_at);
});

test("the breaker is a window, not a latch — an expired one probes again", async () => {
  fs.mkdirSync(process.env.JEV_SHADOW_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.JEV_SHADOW_DIR, "health-state.json"), JSON.stringify({
    streak: 9, permanent: true, last_error: "jev: HTTP 403 Free tier users do not have access to this model.",
    since: new Date(Date.now() - 6 * 3600e3).toISOString(),
    alerted_at: new Date(Date.now() - 6 * 3600e3).toISOString(),
    breaker_until: new Date(Date.now() - 1000).toISOString(),
  }));
  stubJev(0.99);
  const r = await decide({ site: "t", id: "p3", state: "s", interpret, legacy: async () => false });
  assert.equal(r.used, "jev", "an elapsed breaker lets the next call through as a live probe");
  const st = healthState();
  assert.equal(st.streak, 0);
  assert.equal(st.breaker_until, undefined, "a success clears the breaker");
  assert.ok(st.ok_at);
});

// Guards the 2026-10-13 12:51Z "🔴 Jev is being refused" page, which said
// "last good call 2026-10-11T13:30:08Z" for a refusal only 16 minutes old:
// ok_at was written only on recovery, so it froze during healthy running.
test("ok_at is stamped on every success, so a refusal page names the real last good call", async () => {
  fs.mkdirSync(process.env.JEV_SHADOW_DIR, { recursive: true });
  const stale = new Date(Date.now() - 2 * 86400e3).toISOString();
  fs.writeFileSync(path.join(process.env.JEV_SHADOW_DIR, "health-state.json"), JSON.stringify({ streak: 0, ok_at: stale }));
  stubJev(0.99);
  const r = await decide({ site: "t", id: "ok1", state: "s", interpret, legacy: async () => true });
  assert.equal(r.used, "jev");
  const fresh = healthState().ok_at;
  assert.notEqual(fresh, stale, "a routine success refreshes ok_at");
  assert.ok(Math.abs(Date.now() - Date.parse(fresh)) < 5000);
  assert.equal(fs.readdirSync(process.env.JEV_SHADOW_DIR).filter((f) => f.endsWith(".tmp")).length, 0, "atomic write leaves no temp file");

  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Free tier users do not have access to this model." }), { status: 403 });
  await decide({ site: "t", id: "ok2", state: "s", interpret, legacy: async () => true });
  const st = healthState();
  assert.equal(st.permanent, true);
  assert.ok(st.alerted_at);
  assert.equal(st.ok_at, fresh, "the failing state carries the fresh ok_at the page will quote");
});

test("a transient wobble still has to clear both noise arms", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "The upstream provider is busy" }), { status: 429 });
  for (let i = 0; i < 5; i++) {
    await decide({ site: "t", id: `w${i}`, state: "s", interpret, legacy: async () => true });
  }
  const st = healthState();
  assert.equal(st.streak, 5, "every attempt is counted — no breaker for a 429");
  assert.equal(st.permanent, false);
  assert.equal(st.breaker_until, undefined);
  assert.equal(st.alerted_at, undefined, "5 errors inside a minute is a burst, not an outage");
});
