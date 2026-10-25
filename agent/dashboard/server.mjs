// dashboard/server.mjs — WP12 live dashboard (server-push). A STANDALONE,
// READ-ONLY observer of the running supervisors: it polls their /health
// endpoints and broadcasts snapshots to browser clients over SSE. It never
// touches the supervisors' live request handling (dispatch/health) — a wrong
// move in those paths would break production — so this is a separate process
// (like the wiki browser at :9096), safe to restart independently.
//
// Uses the WP12 core mechanism (core/app-screens.mjs): registerRoute for HTML +
// JSON routes, registerAppScreen for the native manifest the Swift client reads
// in WP13, createStreamHub for emitStreamEvent → SSE. HTML is served from a file
// (dashboard.html), never an inline template literal (Conway's warning).
//
// Routes:
//   GET /            → dashboard.html (live status of ops + chat supervisors)
//   GET /_stream     → SSE stream of {type:"snapshot", ops, chat, ts}
//   GET /_screens    → JSON app-screen manifest (for the Swift client, WP13)
//   GET /api/health  → one-shot aggregated snapshot (ops + chat)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouteRegistry, createStreamHub, SSE_HEADERS } from "../core/app-screens.mjs";
import { allTelemetry } from "../core/telemetry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT) || 9098;
const POLL_MS = Number(process.env.DASHBOARD_POLL_MS) || 3000;
const SUPERVISORS = {
  ops: process.env.OPS_HEALTH_URL || "http://127.0.0.1:9093/health",
  chat: process.env.CHAT_HEALTH_URL || "http://127.0.0.1:9094/health",
};

const registry = createRouteRegistry();
const hub = createStreamHub({ heartbeatMs: 20_000 });

async function fetchHealth(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
  }
}

async function snapshot() {
  const [ops, chat] = await Promise.all([fetchHealth(SUPERVISORS.ops), fetchHealth(SUPERVISORS.chat)]);
  // WP13: live task telemetry (status line + checklist) from any producer,
  // dropping rows idle > 10 min so a crashed producer's line doesn't linger.
  let telemetry = [];
  try { telemetry = allTelemetry({ maxAgeMs: 10 * 60_000 }); } catch {}
  return { type: "snapshot", ops, chat, telemetry, ts: Date.now() };
}

// ---- routes ---------------------------------------------------------------

registry.registerRoute("/", () => {
  let body;
  try { body = fs.readFileSync(path.join(HERE, "dashboard.html"), "utf8"); }
  catch { return { status: 500, body: "dashboard.html missing" }; }
  return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
});

registry.registerRoute("/_screens", () => ({
  status: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ screens: registry.listScreens() }),
}));

registry.registerRoute("/api/health", async () => ({
  status: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(await snapshot()),
}));

registry.registerAppScreen("Edva Live", "/", { icon: "gauge", order: 1 });

// ---- HTTP server ----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // SSE stream — hand the socket to the hub; the poller broadcasts to it.
  if (url.pathname === "/_stream") {
    res.writeHead(200, SSE_HEADERS);
    res.write(": connected\n\n");
    hub.subscribe(res);
    snapshot().then((s) => { try { res.write(`event: snapshot\ndata: ${JSON.stringify(s)}\n\n`); } catch {} });
    return;
  }

  const handler = registry.resolve(url.pathname);
  if (!handler) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
  try {
    const out = (await handler(req)) || {};
    res.writeHead(out.status || 200, out.headers || { "Content-Type": "text/plain" });
    res.end(out.body ?? "");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`error: ${err.message}`);
  }
});

// Poll the supervisors and push a snapshot to all SSE clients.
function startPolling() {
  hub.startHeartbeat();
  const tick = async () => {
    if (hub.clientCount() === 0) return;   // nobody watching → don't poll
    hub.emitStreamEvent(await snapshot());
  };
  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  console.error(`[dashboard] polling ${Object.values(SUPERVISORS).join(", ")} every ${POLL_MS / 1000}s`);
}

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[dashboard] WP12 live dashboard on http://127.0.0.1:${PORT}`);
  startPolling();
});

process.on("SIGTERM", () => { try { hub.stop(); server.close(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { hub.stop(); server.close(); } catch {} process.exit(0); });
