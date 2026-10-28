// jev-hum-ping-gate.test.mjs — Jev in front of the hum agent turn (lib/jev-hum-gate.mjs).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-hum-gate-"));
Object.assign(process.env, {
  JEV_CONFIG_FILE: path.join(tmp, "jev-config.json"),
  JEV_QUESTIONS_DIR: fileURLToPath(new URL("../agent/config/jev-questions", import.meta.url)), // the kernel definitions
  JEV_SHADOW_DIR: path.join(tmp, "shadow"),
  JEV_NO_ALERT: "1",
  JEV_PRIVATE_SCREEN: "off",
  TYPESAFE_API_KEY: "test-key",
});

let jevCalls = 0;
let jevP = 0.03;
let jevStatus = 200;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/api/")) throw new Error("ECONNREFUSED (test: no ollama)");
  jevCalls++;
  const body = JSON.parse(init.body);
  assert.equal(body.providerOptions, undefined, "TypeSafe direct: no gateway pinning");
  assert.ok(!JSON.stringify(body.state).includes("\"data\""), "event data never sent to Jev");
  if (jevStatus !== 200) return new Response("boom", { status: jevStatus });
  return new Response(JSON.stringify({ answers: { worth_reaching_out: { type: "boolean", probability: jevP } } }), { status: 200 });
};

const g = await import("../lib/jev-hum-gate.mjs");
const { pruneState } = await import("../lib/hum-events.mjs");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SH = process.env.JEV_SHADOW_DIR;
const lines = (f) => (fs.existsSync(path.join(SH, f)) ? fs.readFileSync(path.join(SH, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const daily = () => (fs.existsSync(SH) ? fs.readdirSync(SH).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).flatMap(lines) : []);
const ev = (over = {}) => ({ id: `e${Math.random()}`, sensor: "location", type: "location.arrived", summary: "Arrived near Main Square", salience: 0.6, lanes: ["nearby", "dining"], dedup_key: `loc:main-sq:${Math.random()}` /* unique: the gate caches per bundle */, data: { lat: 10.0, lon: 20.0, hr: 150 }, ...over });
const verdict = (events) => ({ decision: "dispatch", accepted: events, lanes: [...new Set(events.flatMap((e) => e.lanes))], score: 0.62 });
let spawned;
// previewGate stubbed: the real one shells out to `edva hum situation` + a preview harvest.
const deps = () => ({ spawnShadow: (id) => spawned.push(id), previewGate: async () => ({ skip: false, reason: "stub: something eligible" }) });

beforeEach(() => {
  fs.rmSync(SH, { recursive: true, force: true });
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {} }));
  jevCalls = 0; jevP = 0.03; jevStatus = 200; spawned = [];
  process.env.JEV_PRIVATE_SCREEN = "off";
  g._clearVerdictCache();
});

test("confident 'nothing worth reaching out' skips the turn and queues a detached shadow", async () => {
  const r = await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_1" }, deps());
  assert.equal(r.dispatch, false);
  assert.equal(jevCalls, 1);
  assert.deepEqual(spawned, ["d_1"]);
  const [p] = lines("hum-ping-gate-pending.jsonl");
  assert.equal(p.kind, "skipped"); assert.equal(p.jev.dispatch, false);
  assert.equal(daily()[0].used, "jev");
});

test("confident 'worth it' dispatches; the silent outcome is calibration, not a disagreement", async () => {
  jevP = 0.97;
  const r = await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_2" }, deps());
  assert.equal(r.dispatch, true);
  assert.equal(spawned.length, 0);
  const out = [{ kind: "outcome", dispatch_id: "d_2", match: "time", sent: false, decision: "silent" }];
  assert.equal(g.reconcileHumOutcomes(out), 1);
  assert.equal(g.reconcileHumOutcomes(out), 0, "never recorded twice");
  // hum is silent on most runs by design, and a downstream gate can silence a
  // ping the moment deserved — so this is NOT evidence either side was wrong.
  assert.equal(lines("disagreements.jsonl").length, 0, "a dispatched-then-silent tick never pages");
  const row = daily().at(-1);
  assert.equal(row.site, "hum-ping-gate");
  assert.equal(row.calibration, true);
  assert.equal(row.outcome_sent, false, "the outcome is still recorded for the end-of-week report");
  assert.equal(row.agree, undefined, "no boolean agree — it stays out of the agreement rate");
  assert.equal(lines("hum-ping-gate-pending.jsonl").length, 0, "resolved row compacted away");
});

test("low confidence dispatches as today and queues nothing", async () => {
  jevP = 0.4;
  const r = await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_3" }, deps());
  assert.equal(r.dispatch, true);
  assert.equal(lines("hum-ping-gate-pending.jsonl").length, 0);
  assert.equal(daily()[0].reason, "jev-low-confidence");
});

test("health/exercise/finance lanes, the workout sensor and idle-only bundles never reach Jev", async () => {
  const cases = [
    [[ev({ sensor: "workout", type: "workout.finished", lanes: ["situation"] })], "health-excluded"],
    [[ev({ lanes: ["exercise", "situation"] })], "health-excluded"],
    [[ev({ lanes: ["finance"] })], "financial-excluded"],
    [[ev({ sensor: "idle", type: "idle.tick", lanes: [] })], "idle-bundle"],
    [[ev({ sensor: "questions", type: "questions.waiting", lanes: ["dream_asks"] })], "idle-bundle"],
  ];
  for (const [events, reason] of cases) {
    fs.rmSync(SH, { recursive: true, force: true });
    const r = await g.humJevGate({ verdict: verdict(events), gates: {}, state: {}, dispatchId: `d_${reason}` }, deps());
    assert.equal(r.dispatch, true, reason);
    const row = daily()[0];
    assert.equal(row.reason, reason);
    assert.equal(row.input, "[withheld]");
  }
  assert.equal(jevCalls, 0);
});

test("an idle-only bundle whose preview finds nothing eligible is skipped in code, without Jev", async () => {
  const idle = [ev({ sensor: "idle", type: "idle.quiet", lanes: [], dedup_key: "idle:preview-skip" })];
  const r = await g.humJevGate({ verdict: verdict(idle), gates: {}, state: {}, dispatchId: "d_pv" },
    { ...deps(), previewGate: async () => ({ skip: true, reason: "preview: nothing eligible (stub)" }) });
  assert.equal(r.dispatch, false);
  assert.equal(r.via, "preview");
  assert.equal(jevCalls, 0);
  // A throwing preview fails open into the normal idle path.
  const t = await g.humJevGate({ verdict: verdict([ev({ sensor: "idle", type: "idle.quiet", lanes: [], dedup_key: "idle:throw" })]), gates: {}, state: {}, dispatchId: "d_pt" },
    { ...deps(), previewGate: async () => { throw new Error("boom"); } });
  assert.equal(t.dispatch, true);
});

test("Jev error and privacy-screen failure both fail open to dispatch", async () => {
  jevStatus = 429;
  assert.equal((await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_e" }, deps())).dispatch, true);
  jevStatus = 200;
  process.env.JEV_PRIVATE_SCREEN = "";           // Ollama unreachable → screen fails closed
  const before = jevCalls;
  const r = await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_s" }, deps());
  assert.equal(r.dispatch, true);
  assert.equal(jevCalls, before, "Jev not called when the screen can't clear the state");
  assert.match(daily().pop().reason, /^sensitive-excluded/);
});

test("a Jev skip consumes the bundle without counting as a dispatch", () => {
  const state = { dedup: {}, pending: [{ id: "old" }], last_dispatch_at: "2026-09-23T10:00:00Z", dispatches: ["2026-09-23T10:00:00Z"] };
  g.applyJevSkip(state, verdict([ev({ dedup_key: "loc:x" })]), { pruneState, config: undefined, nowMs: Date.parse("2026-09-23T12:00:00Z") });
  assert.ok(state.dedup["loc:x"]);
  assert.deepEqual(state.pending, []);
  assert.equal(state.last_dispatch_at, "2026-09-23T10:00:00Z");
  assert.equal(state.dispatches.length, 1);
});

test("shadow CLI records one comparison for a skipped tick (stubbed Sonnet)", async () => {
  await g.humJevGate({ verdict: verdict([ev()]), gates: {}, state: {}, dispatchId: "d_sh" }, deps());
  const run = () => execFileSync(process.execPath, ["bin/jev-gate-shadow", "hum-ping-gate", "d_sh"],
    { env: { ...process.env, JEV_GATE_SHADOW_STUB: '{"ping": true, "why": "fresh arrival near a trusted spot"}' }, encoding: "utf8" });
  assert.match(run(), /sonnet-shadow/);
  run();
  const d = lines("disagreements.jsonl");
  assert.equal(d.length, 1, "Jev skipped, shadow says it would have pinged → one disagreement");
  assert.equal(d[0].shadow.value.includes("ping"), true);
});

test("a re-tick of the same bundle (failed dispatch) reuses the verdict: one Jev call, one pending row", async () => {
  jevP = 0.97;
  const v = verdict([ev({ dedup_key: "loc:retick" })]);
  const a = await g.humJevGate({ verdict: v, gates: {}, state: {}, dispatchId: "d-1" }, deps());
  const b = await g.humJevGate({ verdict: v, gates: {}, state: {}, dispatchId: "d-2" }, deps());
  assert.equal(a.dispatch, true); assert.equal(b.dispatch, true);
  assert.match(b.reason, /cached/);
  assert.equal(jevCalls, 1, "Jev asked once per bundle");
  assert.equal(lines("hum-ping-gate-pending.jsonl").length <= 1, true, "no second pending row");
});

test("the gate is time-bounded: a hung Jev dispatches (fail-open) and records nothing", async () => {
  const hung = { ...deps(), decide: () => new Promise(() => {}), budgetMs: 50 };
  const t0 = Date.now();
  const r = await g.humJevGate({ verdict: verdict([ev({ dedup_key: "loc:hung" })]), gates: {}, state: {}, dispatchId: "d-h" }, hung);
  assert.equal(r.dispatch, true);
  assert.match(r.reason, /budget/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(spawned.length, 0);
});
