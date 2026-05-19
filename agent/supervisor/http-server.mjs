// http-server.mjs — HTTP endpoints for supervisor.
// Three ports matching the pre-migration assignments so Hookdeck + cron scripts
// don't need to change:
//   9090  POST /    Gmail Pub/Sub push (from Hookdeck)
//   9092  POST /    webhook task dispatch (from cron / trigger scripts)
//   9093  GET  /    supervisor state snapshot (for watchdog)
//        GET  /cost  cost summary
//        POST /restart graceful session restart (watchdog-triggered)
//        POST /dispatch alt dispatch endpoint (JSON: {content,source})

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_BODY = 64 * 1024;
const HOME = process.env.HOME;
const JOBS_DIR = path.join(HOME, "dev/merlin/agent/ops-agent/jobs");
const TOKEN_PATH = path.join(HOME, "dev/merlin/secrets/webhook-token");
const EMAIL_INBOUND_SECRET_PATH = path.join(HOME, "dev/merlin/secrets/email-inbound-secret");
const EMAIL_INBOUND_PLAYBOOK_PATH = path.join(JOBS_DIR, "email-inbound.md");

const _secretCache = new Map();
function readSecret(p, label) {
  if (_secretCache.has(p)) return _secretCache.get(p);
  let v = null;
  try { v = fs.readFileSync(p, "utf8").trim(); }
  catch { console.error(`[http] WARNING: ${label} missing at ${p}`); }
  _secretCache.set(p, v);
  return v;
}
const getWebhookToken = () => readSecret(TOKEN_PATH, "webhook token");
const getEmailInboundSecret = () => readSecret(EMAIL_INBOUND_SECRET_PATH, "email-inbound secret");

let _emailInboundPlaybook;
function getEmailInboundPlaybook() {
  if (_emailInboundPlaybook === undefined) {
    try { _emailInboundPlaybook = fs.readFileSync(EMAIL_INBOUND_PLAYBOOK_PATH, "utf8"); }
    catch { _emailInboundPlaybook = ""; }
  }
  return _emailInboundPlaybook;
}

function checkAuth(req, res) {
  const token = getWebhookToken();
  if (!token) return true; // no token file = auth disabled (degrades open)
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${token}`) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function startServers({ ports, gmailSource, supervisor }) {
  const servers = [];

  // :9090 — Gmail Pub/Sub (default) AND CF Email Worker inbound (path /email-inbound)
  const gmailSrv = http.createServer(async (req, res) => {
    if (req.method === "GET") { json(res, 200, { ok: true, port: ports.gmailPubsubPort }); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

    // CF Email Worker inbound — dispatched on X-Inbound-Secret header (path-independent
     // so Hookdeck connection rules don't matter). Playbook + parsed email are inlined
     // so the dispatched content is self-contained.
    const presented = req.headers["x-inbound-secret"];
    if (presented) {
      const secret = getEmailInboundSecret();
      const ok = secret && presented.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(secret));
      if (!ok) { json(res, 401, { error: "unauthorized" }); return; }
      try {
        const body = await readBody(req, 1024 * 1024);
        const email = JSON.parse(body);
        const content = `${getEmailInboundPlaybook()}\n\n## Inbound Email (parsed)\n\n\`\`\`json\n${JSON.stringify(email, null, 2)}\n\`\`\``;
        supervisor.dispatcher.dispatch(content, "email-inbound");
        res.writeHead(200); res.end("OK");
      } catch (err) {
        console.error(`[http] email-inbound error: ${err.message}`);
        res.writeHead(500); res.end(err.message);
      }
      return;
    }

    try {
      const body = await readBody(req);
      const result = gmailSource.handlePush(body);
      if (!result.accept) { res.writeHead(200); res.end(`OK (${result.reason})`); return; }
      // Batched pushes are dispatched by GmailSource after the batch window.
      // Non-batched (legacy fallback) dispatch directly.
      if (!result.batched && result.content) {
        supervisor.dispatcher.dispatch(result.content, `gmail:${result.historyId}`);
      }
      res.writeHead(200); res.end("OK");
    } catch (err) {
      res.writeHead(500); res.end(err.message);
    }
  });
  gmailSrv.listen(ports.gmailPubsubPort, "127.0.0.1",() => console.error(`[http] gmail pubsub on :${ports.gmailPubsubPort}`));
  servers.push(gmailSrv);

  // :9092 — webhook task dispatch
  // If payload has a "job" field, load instructions from jobs/<job>.md and use
  // that as the dispatch content. This ensures task instructions are always in
  // recent context regardless of session age / compression.
  const webhookSrv = http.createServer(async (req, res) => {
    if (req.method === "GET") { json(res, 200, { ok: true, port: ports.webhookPort }); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    if (!checkAuth(req, res)) return;
    try {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { payload = { task: body }; }

      let task;
      if (payload.job) {
        const jobFile = path.join(JOBS_DIR, `${payload.job}.md`);
        try {
          task = fs.readFileSync(jobFile, "utf8");
          // No log line here — the subsequent `[supervisor] disp NNNNNN → <job>`
          // already records the dispatch. The former `loaded job instructions`
          // line fired on every webhook and drowned real signal.
        } catch (err) {
          console.error(`[http] job file not found: ${jobFile} — falling back to payload`);
          task = payload.task || payload.message || payload.content || JSON.stringify(payload);
        }
      } else {
        task = payload.task || payload.message || payload.content || JSON.stringify(payload);
      }

      const src = payload.source || payload.job || "webhook";
      // Hum coalescing: if a hum dispatch is already queued or in-flight, drop
      // this one. The 20-min cron tick re-fetches situation at dispatch time,
      // so stacking multiple queued hum items is pure duplicate work — and
      // when the dispatcher is slow/stuck, hum ticks are the single biggest
      // contributor to runaway queue depth.
      if (payload.job === "hum") {
        const already = (supervisor.dispatcher.inFlight?.source === "hum") ||
          supervisor.dispatcher.queue.some((i) => i.source === "hum");
        if (already) {
          console.error(`[http] hum coalesced — already queued/in-flight`);
          res.writeHead(200); res.end("COALESCED");
          return;
        }
      }
      supervisor.dispatcher.dispatch(String(task), src);
      res.writeHead(200); res.end("OK");
    } catch (err) {
      res.writeHead(500); res.end(err.message);
    }
  });
  webhookSrv.listen(ports.webhookPort, "127.0.0.1",() => console.error(`[http] webhook on :${ports.webhookPort}`));
  servers.push(webhookSrv);

  // :9093 — control / health
  const controlSrv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${ports.healthPort}`);
    // Health and cost endpoints are read-only — skip auth for watchdog polling
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, supervisor.snapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/cost") {
      json(res, 200, supervisor.costSummary());
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      // Returns the tail of events.ndjson. Query params:
      //   limit=N (default 100, max 2000)
      //   since=<ISO8601>  (only events with ts >= since)
      //   kind=<substr>    (filter by event.kind substring, repeatable)
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1), 2000);
      const since = url.searchParams.get("since");
      const kind = url.searchParams.get("kind");
      try {
        const eventsPath = supervisor.eventLog.eventsPath;
        const raw = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "";
        const lines = raw.split("\n").filter(Boolean);
        const events = [];
        // Walk backward so we can stop as soon as we have `limit` matching.
        for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
          let e; try { e = JSON.parse(lines[i]); } catch { continue; }
          if (since && e.ts && e.ts < since) break; // file is append-only and time-ordered
          if (kind && !(e.kind || "").includes(kind)) continue;
          events.push(e);
        }
        events.reverse();
        json(res, 200, { count: events.length, events });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }
    // POST endpoints require auth
    if (req.method === "POST" && !checkAuth(req, res)) return;
    if (req.method === "POST" && url.pathname === "/restart") {
      json(res, 202, { restarting: true });
      supervisor.restart().catch((e) => console.error(`[http] restart error: ${e.message}`));
      return;
    }
    if (req.method === "POST" && url.pathname === "/rotate") {
      const result = supervisor.rotateIfIdle();
      json(res, result.rotated ? 200 : 409, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/dispatch") {
      try {
        const body = await readBody(req);
        const payload = JSON.parse(body);
        const id = supervisor.dispatcher.dispatch(payload.content, payload.source || "manual");
        json(res, 200, { id });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }
    json(res, 404, { error: "not found" });
  });
  controlSrv.listen(ports.healthPort, "127.0.0.1",() => console.error(`[http] control on :${ports.healthPort}`));
  servers.push(controlSrv);

  return {
    close: () => Promise.all(servers.map(s => new Promise(r => s.close(r)))),
  };
}
