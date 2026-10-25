// Local explanations (hum `nearby`): free sources only, ≤300 m at
// harvest AND at delivery, never the same subject twice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  alreadyTold, deliveryVerdict, splitWithdrawn, recordTold, retractTold, readLedger, newestFix, haversineM,
} from "../lib/local-history-ledger.mjs";
// (The installation's local-lore harvester: local-history-local.test.mjs.)

// A landmark and points due north of it.
const TOWER = { lat: 10.00000, lon: 20.00000 };
const north = (m) => ({ lat: TOWER.lat + m / 111320, lon: TOWER.lon });

test("geometry sanity: north(250) is ~250 m", () => {
  const p = north(250);
  assert.ok(Math.abs(haversineM(TOWER.lat, TOWER.lon, p.lat, p.lon) - 250) < 2);
});

test("another edition of the same subject (same QID) is already told", () => {
  const entries = [{ ping_id: "p-first", sent_at: "2026-03-02T09:00:00Z", title: "Old Clock Tower",
    ids: ["wp:en:1234", "Q9999001"], lat: TOWER.lat, lon: TOWER.lon }];
  const now = Date.parse("2026-03-03T09:00:00Z");
  const otherEdition = { title: "Torre dell'Orologio", ids: ["wp:it:5678", "Q9999001"], lat: TOWER.lat + 0.0002, lon: TOWER.lon };
  assert.equal(alreadyTold(otherEdition, { entries, now }).told, true);
  // An OSM node for the same tower with no QID, 12 m off: same spot.
  const osmNode = { title: "Clock Tower", ids: ["osm:node/42"], ...north(12) };
  const v = alreadyTold(osmNode, { entries, now });
  assert.equal(v.told, true);
  assert.match(v.reason, /same spot/);
  // A different subject 60 m away is NOT a repeat.
  assert.equal(alreadyTold({ title: "Old Market Hall", ids: ["wp:en:999"], ...north(60) }, { entries, now }).told, false);
});

test("a retracted explanation does not block the subject", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-"));
  const p = path.join(dir, "ledger.json");
  recordTold({ ping_id: "p1", subject: { title: "Tower", ids: ["Q1"], ...TOWER } }, p);
  assert.equal(alreadyTold({ ids: ["Q1"] }, { entries: readLedger(p) }).told, true);
  assert.equal(retractTold("p1", p), true);
  assert.equal(alreadyTold({ ids: ["Q1"] }, { entries: readLedger(p) }).told, false);
});

test("delivery: kept at harvest (250 m) but the user moved 400 m before delivery → dropped", () => {
  const subject = { title: "Thing", ...north(250) };
  const now = Date.now();
  const atHarvest = { ...TOWER, at: new Date(now - 60000).toISOString() };
  assert.equal(deliveryVerdict({ subject, fix: atHarvest, now }).ok, true);
  // The user walked 400 m the other way: now 650 m from the subject.
  const moved = { lat: TOWER.lat - 400 / 111320, lon: TOWER.lon, at: new Date(now).toISOString() };
  const v = deliveryVerdict({ subject, fix: moved, now });
  assert.equal(v.ok, false);
  assert.match(v.reason, /> 300m/);
});

test("delivery: a fix too stale to know counts as away; no coordinates fails closed", () => {
  const now = Date.now();
  const stale = { ...TOWER, at: new Date(now - 45 * 60000).toISOString() };
  assert.equal(deliveryVerdict({ subject: { ...north(50) }, fix: stale, now }).ok, false);
  assert.equal(deliveryVerdict({ subject: { title: "x" }, fix: { ...TOWER, at: new Date(now).toISOString() }, now }).ok, false);
  assert.equal(deliveryVerdict({ subject: { ...north(50) }, fix: null, now }).ok, false);
});

test("ping-flush: a parked explanation the user walked away from is withdrawn, others flush", () => {
  const now = Date.now();
  const queue = [{ messageId: "m-fact", body: "tower" }, { messageId: "m-other", body: "weather" }];
  const pending = { "m-fact": { ping_id: "p1", title: "Tower", ...north(250) } };
  const away = { lat: TOWER.lat - 400 / 111320, lon: TOWER.lon, at: new Date(now).toISOString() };
  const r = splitWithdrawn(queue, pending, away, now);
  assert.deepEqual(r.keep.map((e) => e.messageId), ["m-other"]);
  assert.equal(r.withdraw[0].entry.messageId, "m-fact");
  const still = splitWithdrawn(queue, pending, { ...TOWER, at: new Date(now).toISOString() }, now);
  assert.equal(still.keep.length, 2);
});

test("newestFix takes the freshest positioned stamp", () => {
  const f = newestFix([
    { latitude: 1, longitude: 1, arrived_at: "2026-03-20T08:00:00Z", departed_at: "2026-03-20T08:30:00Z" },
    { latitude: 2, longitude: 2, arrived_at: "2026-03-20T08:20:00Z" },
    { latitude: null, longitude: null, arrived_at: "2026-03-20T09:00:00Z" },
  ]);
  assert.deepEqual(f, { lat: 1, lon: 1, at: "2026-03-20T08:30:00.000Z" });
});

test("backfilled pre-ledger ping (title key only) still blocks the subject by name", () => {
  // An older sticky key was nearby:old-clock-tower; the backfill turns it into title:old-clock-tower.
  const entries = [{ ping_id: "p-old", sent_at: "2026-03-04T09:00:00Z", title: "old-clock-tower", ids: ["title:old-clock-tower"], lat: null, lon: null }];
  const v = alreadyTold({ title: "Old Clock Tower", ids: ["osm:way/1", "Q1000001"], lat: TOWER.lat, lon: TOWER.lon },
    { entries, now: Date.parse("2026-03-20T09:00:00Z") });
  assert.equal(v.told, true);
});
