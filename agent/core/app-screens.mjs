// app-screens.mjs — WP12: HTML routes + a server-push event stream (dashboards
// that push). Conway's ROUTE / APP contribution kinds + emitStreamEvent,
// adapted for Edva.
//
//   registerRoute(path, handler)      — handler(req) => { status, headers, body }
//   registerAppScreen(name, path, o)  — manifest a route as a full-screen app
//                                       (consumed by the Swift client when it lands)
//   createStreamHub()                 — emitStreamEvent(ev) broadcast to all
//                                       subscribed SSE clients; a browser page (or
//                                       the native app's stream) filters by ev.type
//
// Pure logic + a tiny SSE broadcaster — no supervisor coupling, no live-request
// path touched. A dashboard server (or a supervisor) mounts these; the stream
// hub is transport-agnostic (any object with write()+on('close') is a client),
// so it's unit-testable without real sockets. HTML is served from FILES, never
// inline template literals (Conway's warning: template-literal escaping corrupts
// embedded JS).

// ---- Route + app-screen registry ------------------------------------------

export function createRouteRegistry() {
  /** @type {Map<string, (req:any)=>({status?:number,headers?:object,body?:string}|Promise<...>)>} */
  const routes = new Map();
  const screens = [];

  function registerRoute(path, handler) {
    if (!path || typeof path !== "string") throw new Error("registerRoute: path is required");
    if (typeof handler !== "function") throw new Error(`registerRoute(${path}): handler must be a function`);
    routes.set(path, handler);
    return path;
  }

  // Surface a route as a native full-screen app entry. `opts.id` stable id;
  // `opts.icon`/`opts.order` optional presentation hints for the client.
  function registerAppScreen(name, path, opts = {}) {
    if (!name || !path) throw new Error("registerAppScreen: name and path are required");
    screens.push({ name, path, id: opts.id || name.toLowerCase().replace(/\s+/g, "-"), ...opts });
    return screens.at(-1);
  }

  function resolve(path) { return routes.get(path) || null; }
  function listScreens() { return screens.map((s) => ({ ...s })); }

  return {
    registerRoute, registerAppScreen, resolve, listScreens,
    routeCount: () => routes.size, has: (p) => routes.has(p),
  };
}

// ---- Server-push stream hub (SSE) ------------------------------------------

// A client is anything with write(chunk) and on('close', cb) — an http
// ServerResponse in SSE mode in production, a fake in tests.
export function createStreamHub({ heartbeatMs = 0, now = () => Date.now() } = {}) {
  const clients = new Set();
  let heartbeat = null;

  function subscribe(res) {
    clients.add(res);
    try { res.on?.("close", () => clients.delete(res)); } catch {}
    return () => clients.delete(res);
  }

  // Broadcast one event to every client as an SSE frame. A client whose write
  // throws (disconnected) is dropped. Returns the number delivered.
  function emitStreamEvent(ev) {
    const payload = { ...ev, ts: ev?.ts ?? now() };
    const frame = `event: ${payload.type || "message"}\ndata: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;
    for (const res of [...clients]) {
      try { res.write(frame); delivered++; } catch { clients.delete(res); }
    }
    return delivered;
  }

  function startHeartbeat() {
    if (heartbeat || heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      for (const res of [...clients]) {
        try { res.write(`: ping\n\n`); } catch { clients.delete(res); }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function stop() { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } clients.clear(); }

  return { subscribe, emitStreamEvent, startHeartbeat, stop, clientCount: () => clients.size };
}

// SSE response headers a route handler sets before handing the socket to the hub.
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};
