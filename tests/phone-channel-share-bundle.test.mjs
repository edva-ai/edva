// A share-sheet send is several edva_messages rows (one per photo, then the
// user's note); phone-channel used to dispatch each on its own, so one share got
// two or three answers. Replays that shape with realistic timing, and pins the
// wiring in phone-channel/index.mjs.
//
// Run: node --test tests/phone-channel-share-bundle.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ShareBundler, SHARE_BUNDLE_GAP_MS as GAP, SHARE_CONSUMED_TTL_MS, isShareRow, laterTimestamp } from "../agent/phone-channel/share-bundle.mjs";

const META = { source: "share", timezone: "UTC", utc_offset: "0" };
const URL0 = "https://project.supabase.invalid/storage/v1/object/public/edva-attachments";
const row = (id, created_at, content, metadata = META) => ({ id, created_at, role: "user", channel: "chat", metadata, content });
// Photo row, then the note row, ~0.5 s apart (one share).
const SHARE_A = [
  row("a-photo", "2026-01-15T12:00:57.825063+00:00", `${URL0}/AAAA/photo.jpg`),
  row("a-note", "2026-01-15T12:00:58.341868+00:00", "Having lunch here today"),
];
// Photo row, then a note with curly quotes, ~0.26 s apart.
const SHARE_B = [
  row("b-photo", "2026-01-16T05:46:22.790246+00:00", `${URL0}/BBBB/photo.jpg`),
  row("b-note", "2026-01-16T05:46:23.051889+00:00", "Remember that “this one” is my favorite snack"),
];
const ids = (rows) => rows.map((r) => r.id);

// A bundler on a fake clock; `tick(ms)` fires due timers in order.
function rig() {
  let now = 1e6, n = 0;
  const timers = new Map(), flushed = [];
  const b = new ShareBundler({
    onFlush: (m) => flushed.push(m), now: () => now,
    setTimer: (fn, ms) => (timers.set(++n, { at: now + ms, fn }), n), clearTimer: (id) => timers.delete(id),
  });
  const tick = (ms) => {
    const end = now + ms;
    for (let due; (due = [...timers].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at)[0]);) {
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  };
  return { b, flushed, tick, timers };
}

// Realtime delivers the rows `gaps` ms apart; then the sweep re-delivers all of them.
function replay(rows, gaps) {
  const { b, flushed, tick } = rig();
  rows.forEach((r, i) => { if (i) tick(gaps[i - 1]); assert.equal(b.add(r), true); });
  assert.equal(flushed.length, 0, "nothing goes out while the share may still be arriving");
  tick(GAP);
  tick(36_000);
  for (const r of rows) assert.equal(b.add(r), true, "a re-delivered member is swallowed");
  tick(GAP * 2);
  return flushed;
}

test("replay: photo + 'Having lunch here today' are ONE message", () => {
  const flushed = replay(SHARE_A, [517]);
  assert.equal(flushed.length, 1, "one dispatch (it was three)");
  const [m] = flushed;
  assert.equal(m.id, SHARE_A[1].id, "the note's id: the row the reply attaches to");
  assert.equal(m.created_at, SHARE_A[1].created_at, "so the cursor lands past every member");
  assert.deepEqual(m.shareBundleIds, ids(SHARE_A));
  assert.equal(m.content, `${SHARE_A[0].content}\n\n${SHARE_A[1].content}`, "photo first, then the note");
  assert.ok(isShareRow(m) && m.role === "user" && m.channel === "chat", "keeps the newest row's columns");
});

test("replay: photo + a quoted note are ONE message", () => {
  const flushed = replay(SHARE_B, [261]);
  assert.equal(flushed.length, 1, "one dispatch (it was two, contradicting each other)");
  assert.equal(flushed[0].content, `${SHARE_B[0].content}\n\n${SHARE_B[1].content}`);
});

test("rows delivered out of order still merge oldest first", () => {
  const flushed = replay([SHARE_A[1], SHARE_A[0]], [120]);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].shareBundleIds, ids(SHARE_A));
});

test("a typed message never waits, and sends an open share ahead of itself", () => {
  const { b, flushed, tick, timers } = rig();
  assert.equal(b.add(row("t1", "2026-01-15T12:02:16.216972+00:00", "Yes! It's great.", { latitude: "10.00" })), false);
  assert.equal(timers.size, 0, "no quiet window for a typed message");
  assert.equal(b.flush(), null);
  b.add(SHARE_A[0]);
  b.add(SHARE_A[1]);
  b.flush(); // what handleIncomingMessage does for a non-share row
  assert.equal(flushed.length, 1);
  assert.equal(timers.size, 0, "the quiet window is cancelled");
  tick(GAP * 2);
  assert.equal(flushed.length, 1, "nothing fires later");
});

test("two shares 6.7 s apart stay two messages, even when the sweep delivers them together", () => {
  const { b, flushed, tick } = rig();
  const second = [row("c-photo", "2026-01-15T12:01:05.050000+00:00", `${URL0}/C/photo.jpg`), row("c-note", "2026-01-15T12:01:05.400000+00:00", "And this one")];
  for (const r of [...SHARE_A, ...second]) b.add(r);
  tick(GAP);
  assert.deepEqual(flushed.map((m) => m.shareBundleIds), [ids(SHARE_A), ids(second)]);
});

test("a photo-only share goes out after the quiet window; a failed one is retried whole after the TTL", () => {
  const { b, flushed, tick } = rig();
  b.add(SHARE_B[0]);
  tick(GAP - 1);
  assert.equal(flushed.length, 0);
  tick(1);
  assert.equal(flushed[0].content, SHARE_B[0].content, "a one-row share passes through unchanged");
  assert.equal(b.has(SHARE_B[0].id), true);
  tick(SHARE_CONSUMED_TTL_MS + 1);
  assert.equal(b.has(SHARE_B[0].id), false, "forgotten after the pending TTL, so the sweep can retry");
  for (const r of SHARE_B) b.add(r);
  tick(GAP);
  assert.deepEqual(flushed[1].shareBundleIds, ids(SHARE_B), "re-bundled whole");
});

// What the sweep selects: role=user, read=false, created_at > cursor.
const sweepPicks = (rows, cursor) => rows.filter((r) => Date.parse(r.created_at) > Date.parse(cursor));

test("replay: the cursor never moves back, so the sweep does not resend the caption", () => {
  const finishOrder = [SHARE_A[1], SHARE_A[0]]; // the caption finished dispatching first, then the photo
  const oldCursor = finishOrder.at(-1).created_at; // last writer wins
  assert.deepEqual(sweepPicks(SHARE_A, oldCursor).map((r) => r.id), [SHARE_A[1].id], "old rule: the answered caption is picked again");
  const cursor = finishOrder.reduce((c, r) => laterTimestamp(c, r.created_at), "2026-01-15T11:06:55.000Z");
  assert.equal(cursor, SHARE_A[1].created_at);
  assert.deepEqual(sweepPicks(SHARE_A, cursor), []);
});

test("laterTimestamp compares instants across formats and microseconds within a millisecond", () => {
  const r = "2026-01-15T12:00:57.825063+00:00";
  assert.equal(laterTimestamp("2026-01-15T12:00:58.000Z", r), "2026-01-15T12:00:58.000Z"); // fallback cursor is toISOString()
  assert.equal(laterTimestamp("2026-01-15T12:00:57.000Z", r), r);
  assert.equal(laterTimestamp("2026-01-15T12:00:57.825900+00:00", r), "2026-01-15T12:00:57.825900+00:00");
  assert.equal(laterTimestamp(null, r), r);
  assert.equal(laterTimestamp(r, undefined), r);
  assert.equal(laterTimestamp(r, "garbage"), r);
});

const src = fs.readFileSync(new URL("../agent/phone-channel/index.mjs", import.meta.url), "utf8");

test("handleIncomingMessage gives share rows to the bundler before anything else", () => {
  const start = src.indexOf("async function handleIncomingMessage(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const take = body.indexOf("shareBundler.add(row)");
  assert.ok(take >= 0);
  for (const later of ["shareBundler.flush()", "pendingMessages.set(", "startAck(", "fetch(DISPATCH_URL"]) {
    assert.ok(body.indexOf(later) > take, `the bundler runs before ${later}`);
  }
  assert.ok(body.includes("!otherShareRows.has(m.id)"), "the share's other rows are not repeated as Recent conversation");
});

test("every cursor write goes through advanceCursor", () => {
  assert.equal(src.includes("lastSeenAt = row.created_at"), false, "no direct, possibly backwards, assignment left");
  assert.equal(src.split("saveCursor(").length - 1, 2, "saveCursor: its definition plus the one call in advanceCursor");
  assert.ok(src.includes("const next = laterTimestamp(lastSeenAt, ts);"));
});
