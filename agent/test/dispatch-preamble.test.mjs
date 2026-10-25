// dispatch-preamble.test.mjs — the per-turn live-state preamble + its wiring
// into the Dispatcher (prepend at send, never mutate the stored item).
//
// Run: node --test agent/test/dispatch-preamble.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A synthetic installation: home zone and owner come from the env layer of
// lib/instance.cjs, never from this host's local config.
process.env.EDVA_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "preamble-local-"));
process.env.EDVA_TZ = "America/Denver";
process.env.EDVA_OWNER_NAME = "Alex";
const { Dispatcher } = await import("../supervisor/dispatcher.mjs");
const { buildPreamble, shouldPreamble } = await import("../supervisor/dispatch-preamble.mjs");

function withTmpCacheDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preamble-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Minimal mock session: records everything sent, emits a result to complete.
class MockSession extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(content) {
    this.sent.push(content);
    // Complete the turn asynchronously so the dispatcher clears inFlight.
    queueMicrotask(() => this.emit("result", { num_turns: 1 }));
  }
}

describe("dispatch preamble", () => {
  it("buildPreamble includes a home-zone timestamp and wraps in <live-state>", () => {
    const p = buildPreamble();
    assert.match(p, /^<live-state>\n/);
    assert.match(p, /now: .+\d{4}/);
    assert.match(p, /<\/live-state>\n\n$/);
  });

  it("surfaces the user's current-location local time when it differs from home tz (fresh)", () => {
    withTmpCacheDir(
      { "user-timezone.json": { timezone: "Asia/Tokyo", utc_offset: "9", updated_at: new Date().toISOString() } },
      (dir) => {
        const p = buildPreamble({ cacheDir: dir });
        assert.match(p, /Alex's current local time \(where they actually are\): .*\(Tokyo\) — this is what quiet-hours\/sleep-window gates use/);
        assert.match(p, /quiet-hours\/sleep-window gates use/);
      },
    );
  });

  it("omits the current-location line when the cached tz matches home tz", () => {
    withTmpCacheDir(
      { "user-timezone.json": { timezone: "America/Denver", updated_at: new Date().toISOString() } },
      (dir) => {
        const p = buildPreamble({ cacheDir: dir });
        assert.doesNotMatch(p, /current local time/);
      },
    );
  });

  it("omits the current-location line when user-timezone.json is stale (>48h)", () => {
    const stale = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    withTmpCacheDir(
      { "user-timezone.json": { timezone: "Asia/Tokyo", updated_at: stale } },
      (dir) => {
        const p = buildPreamble({ cacheDir: dir });
        assert.doesNotMatch(p, /current local time/);
      },
    );
  });

  it("omits the current-location line when user-timezone.json is absent", () => {
    withTmpCacheDir({}, (dir) => {
      const p = buildPreamble({ cacheDir: dir });
      assert.doesNotMatch(p, /current local time/);
    });
  });

  it("shouldPreamble skips control sources and slash-commands", () => {
    assert.equal(shouldPreamble({ source: "gmail:1", content: "triage" }), true);
    assert.equal(shouldPreamble({ source: "webhook", content: "do a thing" }), true);
    assert.equal(shouldPreamble({ source: "context-guard", content: "/compact" }), false);
    assert.equal(shouldPreamble({ source: "session-handoff", content: "[SESSION HANDOFF]" }), false);
    assert.equal(shouldPreamble({ source: "webhook", content: "/compact" }), false);
    assert.equal(shouldPreamble(null), false);
  });

  it("prepends the preamble to the SENT content but never mutates item.content", async () => {
    const session = new MockSession();
    const d = new Dispatcher(session, { preamble: (item) => (shouldPreamble(item) ? "PRE::" : null) });
    d.dispatch("triage this email", "gmail:99");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.sent.length, 1);
    assert.equal(session.sent[0], "PRE::triage this email", "sent content carries the preamble");
    // The stored/queued item content must stay clean (dedup + persistence rely on it).
    assert.equal(d.completed, 1);
  });

  it("sends bare content for control dispatches (no preamble)", async () => {
    const session = new MockSession();
    const d = new Dispatcher(session, { preamble: (item) => (shouldPreamble(item) ? "PRE::" : null) });
    d.dispatch("/compact", "context-guard");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.sent[0], "/compact", "control message sent bare");
  });

  it("is fail-soft: a throwing preamble still sends the bare content", async () => {
    const session = new MockSession();
    const d = new Dispatcher(session, { preamble: () => { throw new Error("boom"); } });
    d.dispatch("real work", "webhook");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.sent[0], "real work");
  });

  it("no preamble option → content unchanged (back-compat)", async () => {
    const session = new MockSession();
    const d = new Dispatcher(session);
    d.dispatch("plain", "webhook");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.sent[0], "plain");
  });
});
