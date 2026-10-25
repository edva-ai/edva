// app-screens.test.mjs — WP12 route registry + SSE stream hub. No real sockets
// (clients are fakes with write()+on('close')).
//
// Run: node --test agent/test/app-screens.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRouteRegistry, createStreamHub, SSE_HEADERS } from "../core/app-screens.mjs";

function fakeClient() {
  const c = { frames: [], closed: false, _onClose: null };
  c.write = (s) => { if (c.closed) throw new Error("closed"); c.frames.push(s); return true; };
  c.on = (ev, cb) => { if (ev === "close") c._onClose = cb; };
  c.close = () => { c.closed = true; c._onClose?.(); };
  return c;
}

describe("route + app-screen registry (WP12)", () => {
  it("registers and resolves routes", () => {
    const reg = createRouteRegistry();
    reg.registerRoute("/dashboard", () => ({ status: 200, body: "<html>" }));
    assert.equal(reg.has("/dashboard"), true);
    assert.equal(reg.routeCount(), 1);
    const h = reg.resolve("/dashboard");
    assert.equal(typeof h, "function");
    assert.deepEqual(h(), { status: 200, body: "<html>" });
    assert.equal(reg.resolve("/nope"), null);
  });

  it("registerRoute validates path + handler", () => {
    const reg = createRouteRegistry();
    assert.throws(() => reg.registerRoute("", () => {}), /path is required/);
    assert.throws(() => reg.registerRoute("/x", null), /handler must be a function/);
  });

  it("app screens are manifested with a stable id", () => {
    const reg = createRouteRegistry();
    reg.registerRoute("/dashboard", () => ({}));
    reg.registerAppScreen("Live Dashboard", "/dashboard", { icon: "chart" });
    const screens = reg.listScreens();
    assert.equal(screens.length, 1);
    assert.equal(screens[0].name, "Live Dashboard");
    assert.equal(screens[0].path, "/dashboard");
    assert.equal(screens[0].id, "live-dashboard");   // derived
    assert.equal(screens[0].icon, "chart");
  });
});

describe("stream hub (WP12 emitStreamEvent / SSE)", () => {
  it("broadcasts an SSE-framed event to all subscribers", () => {
    const hub = createStreamHub({ now: () => 1234 });
    const a = fakeClient(), b = fakeClient();
    hub.subscribe(a); hub.subscribe(b);
    const n = hub.emitStreamEvent({ type: "health", ok: true });
    assert.equal(n, 2);
    assert.equal(hub.clientCount(), 2);
    // SSE frame shape: `event: <type>\ndata: <json>\n\n`, ts injected.
    assert.match(a.frames[0], /^event: health\ndata: /);
    assert.match(a.frames[0], /\n\n$/);
    const data = JSON.parse(a.frames[0].split("data: ")[1]);
    assert.deepEqual(data, { type: "health", ok: true, ts: 1234 });
  });

  it("drops a client whose write throws, and on close", () => {
    const hub = createStreamHub();
    const a = fakeClient(), b = fakeClient();
    hub.subscribe(a); hub.subscribe(b);
    b.close();                                   // close-driven removal
    assert.equal(hub.clientCount(), 1);
    a.closed = true;                             // write-throw removal
    const n = hub.emitStreamEvent({ type: "x" });
    assert.equal(n, 0);
    assert.equal(hub.clientCount(), 0);
  });

  it("unsubscribe stops delivery", () => {
    const hub = createStreamHub();
    const a = fakeClient();
    const off = hub.subscribe(a);
    off();
    assert.equal(hub.emitStreamEvent({ type: "x" }), 0);
  });

  it("SSE_HEADERS declare an unbuffered event stream", () => {
    assert.equal(SSE_HEADERS["Content-Type"], "text/event-stream");
    assert.equal(SSE_HEADERS["Cache-Control"], "no-cache");
  });
});
