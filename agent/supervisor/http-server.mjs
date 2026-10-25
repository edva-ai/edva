// http-server.mjs — HTTP endpoints for supervisor.
// Three ports, exposure model below:
//   9090  POST /              Gmail Pub/Sub push (OIDC-verified)
//         POST /email-inbound  CF Email Worker inbound (X-Inbound-Secret)
//         POST /<path>         the instance's own routes, registered by
//                              _ext/routes.mjs (each authenticates itself)
//   9092  POST /              webhook task dispatch (from cron / trigger scripts)
//   9093  GET  /              supervisor state snapshot (for watchdog)
//        GET  /cost  cost summary
//        POST /restart graceful session restart (watchdog-triggered)
//        POST /dispatch alt dispatch endpoint (JSON: {content,source})
//
// :9090 reaches the public internet through a Cloudflare Tunnel
// (gmail-push.<domain> → localhost:9090), so BOTH POST paths authenticate:
//   - Gmail Pub/Sub push: Google-signed OIDC JWT in `Authorization: Bearer`,
//     verified in oidc-verify.mjs (audience + service-account email). Config
//     for the expected aud/email lives in secrets/pubsub-oidc.json.
//   - CF Email Worker: shared X-Inbound-Secret header (timing-safe compare).
//   - _ext routes: each handler authenticates its own caller.
// The tunnel routes gmail-push.<domain> by HOSTNAME, so a new path on :9090
// needs no Cloudflare change — unlike the retired /slack/events rule, which
// pointed at a different port and therefore did.
// Before 2026-05-30 this port was only reachable via the Hookdeck CLI tunnel,
// so the Gmail-push path trusted its caller implicitly — that is no longer safe.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyGoogleIdToken } from "./oidc-verify.mjs";
import { readTailLines } from "../../lib/tail-file.mjs";
import { isHighPriority, isHumSource } from "./dispatcher.mjs";
import { loadHook } from "../../lib/ext-hooks.mjs";
import { prepareInbound, heldNotice } from "../../lib/email-inbound-gate.mjs";
import { readOptional, withLocalCompanion, localCompanionPath, sliceAll } from "./dispatch-preamble.mjs";

import { installTools } from "../../lib/root.cjs";
const MAX_BODY = 64 * 1024;
const HOME = process.env.HOME;
const JOBS_DIR = installTools("agent/ops-agent/jobs");
// An installation's own playbooks may sit in jobs/_ext/ (an overlay drop) and
// dispatch exactly like the kernel's; a kernel playbook wins on a name.
const JOBS_EXT_DIR = path.join(JOBS_DIR, "_ext");
// The operator's additions to a kernel playbook live at local/jobs/<job>.md and
// are appended to it at dispatch (dispatch-preamble.mjs withLocalCompanion).
const LOCAL_DIR = process.env.EDVA_LOCAL_DIR || installTools("agent/local");
const TOKEN_PATH = installTools("secrets/webhook-token");
const EMAIL_INBOUND_SECRET_PATH = installTools("secrets/email-inbound-secret");
const EMAIL_INBOUND_PLAYBOOK_PATH = path.join(JOBS_DIR, "email-inbound.md");
// OIDC expectations for the Gmail Pub/Sub push path. Written by setup-pubsub.sh;
// shape: {"audience":"https://gmail-push.<domain>","serviceAccount":"edva-pubsub@<proj>.iam.gserviceaccount.com"}.
const PUBSUB_OIDC_CONFIG_PATH = installTools("secrets/pubsub-oidc.json");

// The playbook file for a webhook-dispatched job: jobs/<job>.md, else
// jobs/_ext/<job>.md. Neither → the kernel path, so the not-found message
// names where a playbook belongs.
export function resolveJobFile(jobName, { jobsDir = JOBS_DIR, extDir = JOBS_EXT_DIR } = {}) {
  const kernel = path.join(jobsDir, `${jobName}.md`);
  if (fs.existsSync(kernel)) return kernel;
  const overlay = path.join(extDir, `${jobName}.md`);
  if (fs.existsSync(overlay)) return overlay;
  return kernel;
}

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

// Cached OIDC config (audience + expected service-account email). Cached once;
// a config change requires a supervisor restart (same as agents.json).
let _pubsubOidcConfig;
function getPubsubOidcConfig() {
  if (_pubsubOidcConfig === undefined) {
    try {
      _pubsubOidcConfig = JSON.parse(fs.readFileSync(PUBSUB_OIDC_CONFIG_PATH, "utf8"));
    } catch {
      _pubsubOidcConfig = null;
      console.error(`[http] WARNING: pubsub OIDC config missing at ${PUBSUB_OIDC_CONFIG_PATH} — Gmail push path will reject all requests`);
    }
  }
  return _pubsubOidcConfig;
}

let _emailInboundPlaybook;
// Hand an allowlisted inbound email to bin/email-inbound-run (detached —
// answering can take minutes; the Worker only needs a 200). The payload goes in
// a private temp file the runner deletes, so a runner crash can still re-read
// it and escalate. Returns false if the spawn itself failed, so the caller
// falls back to the in-session dispatch and nothing is dropped.
// Overridable so tests never write the live handled/dropped logs.
const INBOUND_DATA_DIR = process.env.EMAIL_INBOUND_DATA_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), "../../data");

function spawnEmailInboundRun(email, context) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-inbound-in-"));
    const file = path.join(dir, "payload.json");
    fs.writeFileSync(file, JSON.stringify({ email, context }), { mode: 0o600 });
    const bin = process.env.EMAIL_INBOUND_RUN_BIN || path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/email-inbound-run");
    const child = spawn(process.execPath, [bin, "--payload", file], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });
    child.on("error", (e) => console.error(`[http] email-inbound-run spawn error: ${e.message}`));
    child.unref();
    console.log(`[http] email-inbound → one-shot (pid ${child.pid}): ${email.message_id || "(no message-id)"}`);
    return !!child.pid;
  } catch (err) {
    console.error(`[http] email-inbound one-shot unavailable (${err.message}) — dispatching in-session`);
    return false;
  }
}

function getEmailInboundPlaybook() {
  if (_emailInboundPlaybook === undefined) {
    _emailInboundPlaybook = {
      kernel: readOptional(EMAIL_INBOUND_PLAYBOOK_PATH) ?? "",
      local: readOptional(localCompanionPath(LOCAL_DIR, "email-inbound")) ?? "",
    };
  }
  // The in-session dispatch (emailInboundMode "session", or a one-shot spawn
  // failure) gets the same ops-agent section the one-shot escalates with: the
  // kernel playbook's escalation block, then the local companion's own
  // escalation block when it has one.
  const start = "<!-- escalation:start -->", end = "<!-- escalation:end -->";
  const { kernel, local } = _emailInboundPlaybook;
  return withLocalCompanion(sliceAll(kernel, start, end) ?? kernel, sliceAll(local, start, end)).trim();
}

function checkAuth(req, res) {
  const token = getWebhookToken();
  if (!token) return true; // no token file = auth disabled (degrades open)
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${token}`) return true;
  json(res, 401, { error: "unauthorized" });
  return false;
}

// Raw bytes, for callers that must hash exactly what the sender sent. A signed
// webhook's body hash covers the wire bytes, and re-serializing parsed JSON does
// not reliably reproduce them (key order, unicode escapes, whitespace).
function readBodyRaw(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req, max = MAX_BODY) {
  return readBodyRaw(req, max).then((b) => b.toString("utf8"));
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// The instance's own routes: agent/supervisor/_ext/routes.mjs (absent in
// a plain install) exports register(api) and may claim
//   - POST paths on :9090 (api.post(pathname, handler(req, res, url))), matched
//     before the email-inbound and Gmail-push branches; each handler
//     authenticates its own caller and writes its own response;
//   - authenticated inbound emails (api.emailInbound(async (email) => bool)),
//     asked in order before the alignment gate; true answers the Worker 200
//     and nothing else runs.
// Loaded once, at import. A hook that exists and fails to load is a real
// failure (the supervisor does not start), as a broken static import would be.
// The quoted path keeps the hook in supervisor-code-reload's import closure:
// "./_ext/routes.mjs".
const extPostRoutes = new Map();
const extInboundRoutes = [];
{
  const mod = await loadHook(path.dirname(fileURLToPath(import.meta.url)), "routes");
  if (mod && typeof mod.register === "function") {
    mod.register({
      post: (pathname, handler) => { extPostRoutes.set(pathname, handler); },
      emailInbound: (fn) => { extInboundRoutes.push(fn); },
      json, readBody, readBodyRaw, readSecret,
    });
  }
}

export function startServers({ ports, gmailSource, supervisor }) {
  const servers = [];

  // :9090 — Gmail Pub/Sub (default) AND CF Email Worker inbound (path /email-inbound).
  // Gated on gmailPubsubPort: only the ops agent has one. The ops-light (Sonnet)
  // supervisor omits it, so the Gmail push/inbound path stays single-instance on
  // ops and ops-light serves webhook + control ports only.
  if (ports.gmailPubsubPort) {
  const gmailSrv = http.createServer(async (req, res) => {
    if (req.method === "GET") { json(res, 200, { ok: true, port: ports.gmailPubsubPort }); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, `http://localhost:${ports.gmailPubsubPort}`);

    // The instance's own routes (_ext/routes.mjs), matched on PATH so a payload
    // for one of them can never fall through into the branches below.
    const extRoute = extPostRoutes.get(url.pathname);
    if (extRoute) { await extRoute(req, res, url); return; }

    // CF Email Worker inbound — dispatched on X-Inbound-Secret header
     // (path-independent so it works whether the Worker posts to / or
     // /email-inbound through the tunnel). Playbook + parsed email are inlined
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
        // The instance's own pre-routes (_ext/routes.mjs api.emailInbound), e.g.
        // a scoped, read-only one-shot for particular senders instead of the
        // full assistant.
        let claimed = false;
        for (const route of extInboundRoutes) {
          if (await route(email)) { claimed = true; break; }
        }
        if (claimed) {
          res.writeHead(200); res.end("OK");
          return;
        }
        // Forged-From gate for the full-assistant path (2026-10-04). The email
        // Worker attaches DKIM/DMARC alignment; mail claiming an allowlisted
        // address that is not aligned never reaches the ops agent. While an
        // older Worker without `auth` is deployed this is a no-op.
        if (email.auth && email.auth.aligned !== true) {
          try {
            fs.appendFileSync(path.join(INBOUND_DATA_DIR, "email-inbound-dropped.jsonl"),
              JSON.stringify({ ts: new Date().toISOString(), from: email.from, subject: email.subject, message_id: email.message_id, reason: "sender-not-verified", auth: email.auth }) + "\n");
          } catch {}
          res.writeHead(200); res.end("OK");
          return;
        }
        // Structural steps in code (2026-10-04, lib/email-inbound-gate.mjs):
        // allowlist, Worker-retry dedup on Message-ID, reply-to-Edva lookup
        // and the handled-log row. Only an allowlisted, new message reaches
        // the agent, and it arrives with its reply context already resolved.
        const gate = prepareInbound(email, { dataDir: INBOUND_DATA_DIR });
        // Held mail from an unknown person (2026-10-22, gate § Held mail): one
        // chat line naming the exact address. Nothing is granted here; only their
        // explicit "add <address>" → the installation's sender-add tool adds it.
        // A content send, so it takes the outbound precheck like any other.
        if (gate.action === "hold" && gate.notify) {
          try {
            const p = spawn(installTools("bin/edva-send-curl"),
              ["--intent", "email-held", "--agent", "ops", heldNotice(gate.held)],
              { detached: true, stdio: "ignore" });
            p.unref();
          } catch (e) { console.error(`[http] email-inbound held notice failed: ${e.message}`); }
        }
        if (gate.action !== "dispatch") {
          console.log(`[http] email-inbound ${gate.action}: ${email.message_id || "(no message-id)"}`);
          res.writeHead(200); res.end("OK");
          return;
        }
        // One-off session (2026-10-04, agents.json ops.emailInboundMode, default
        // "oneshot"): bin/email-inbound-run answers in a stateless
        // `claude -p` with an explicit read-only grant and escalates to this
        // session only for actions. "session" = the old in-session dispatch
        // (rollback). A spawn failure falls back to the session too.
        if ((supervisor.cfg?.emailInboundMode || "oneshot") === "oneshot" && spawnEmailInboundRun(email, gate.context)) {
          res.writeHead(200); res.end("OK");
          return;
        }
        const content = `${getEmailInboundPlaybook()}\n\n## Inbound Email (parsed)\n\n\`\`\`json\n${JSON.stringify(email, null, 2)}\n\`\`\`\n\n## Resolved by code\n\n\`\`\`json\n${JSON.stringify(gate.context, null, 2)}\n\`\`\``;
        supervisor.dispatcher.dispatch(content, "email-inbound");
        res.writeHead(200); res.end("OK");
      } catch (err) {
        console.error(`[http] email-inbound error: ${err.message}`);
        res.writeHead(500); res.end(err.message);
      }
      return;
    }

    // Gmail Pub/Sub push path. :9090 is now publicly reachable via the
    // Cloudflare Tunnel, so we require a valid Google-signed OIDC token proving
    // the request actually came from our Pub/Sub push subscription. Fail closed:
    // if the OIDC config is missing or the token is absent/invalid, reject.
    const oidcCfg = getPubsubOidcConfig();
    if (!oidcCfg) { json(res, 503, { error: "oidc config unavailable" }); return; }
    const authz = req.headers["authorization"] || "";
    const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    try {
      await verifyGoogleIdToken(bearer, {
        audience: oidcCfg.audience,
        email: oidcCfg.serviceAccount,
      });
    } catch (err) {
      console.error(`[http] gmail push OIDC rejected: ${err.message}`);
      json(res, 401, { error: "unauthorized" });
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
  } // end if (ports.gmailPubsubPort)

  // :9092 — webhook task dispatch
  // If payload has a "job" field, load instructions from jobs/<job>.md (or an
  // installation's jobs/_ext/<job>.md; resolveJobFile) and use
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
        const jobFile = resolveJobFile(payload.job);
        try {
          task = fs.readFileSync(jobFile, "utf8");
          // + the operator's additions to this playbook, when there are any.
          task = withLocalCompanion(task, readOptional(localCompanionPath(LOCAL_DIR, payload.job)));
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
      // Hum coalescing: keep at most one QUEUED hum item, but never lose the
      // newest moment.
      //
      // The original rule (cadence era) dropped any hum dispatch while another
      // was queued or in-flight, on the reasoning that "the 20-min cron tick
      // re-fetches situation at dispatch time, so stacking hum items is pure
      // duplicate work". That held when every hum tick was the same generic
      // question. It is actively wrong now that hum is event-driven: a
      // `location.arrival` dispatch is NOT interchangeable with a queued
      // `daypart.lunch` tick, and dropping it discarded exactly the specific,
      // perishable moment while keeping the generic one. Live on 2026-08-03,
      // three of eleven dispatches were swallowed this way — all of them
      // arrivals, the highest-value events the framework produces.
      //
      // It also lied about it: `res.end("COALESCED")` returns 200, and
      // hum-events.mjs `dispatch()` treats any 2xx as delivered, so the ledger
      // recorded `delivered: true` for a dispatch that never became a turn.
      // The distinct 202 + body below is what lets the ledger tell the truth.
      //
      // New behaviour: FOLD the new moment into the queued turn rather than
      // drop it. hum-sense has already written this dispatch's context to the
      // context list, and the harvest consumes every unconsumed entry — so the
      // queued turn will represent both moments when it runs. What the queued
      // item still needs is the newer moment's *urgency*: if the arrival is
      // perishable and the waiting item is ordinary cadence work, promote it so
      // it stops sitting behind the cron backlog.
      if (payload.job === "hum") {
        const queued = supervisor.dispatcher.queue.find((i) => isHumSource(i.source));
        if (queued) {
          const promote = payload.source === "hum:moment" && !isHighPriority(queued.source, queued.content);
          if (promote) {
            queued.source = "hum:moment";
            supervisor.dispatcher.promote(queued.id);
          }
          supervisor.dispatcher.persist();
          console.error(`[http] hum folded into queued item ${queued.id}${promote ? " (promoted — perishable)" : ""}`);
          res.writeHead(202); res.end(promote ? "FOLDED+PROMOTED" : "FOLDED");
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
        // Bounded tail read — events.ndjson is append-only and unbounded, so
        // readFileSync() on it throws once the file passes V8's ~512MB max
        // string length (it hit 2.6GB on 2026-07-20 and this endpoint had been
        // 500ing on every call). Back-window is sized for the 2000-event cap.
        const lines = readTailLines(eventsPath, { limit: 200000, maxBytes: 32 * 1024 * 1024 });
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
        // `task` is accepted too: location-confirm's re-render and the
        // nightly-review playbook sent {"task": …}, which dispatched the
        // literal "undefined" until 2026-10-08. An empty task is refused.
        const content = payload.content ?? payload.task;
        if (typeof content !== "string" || !content.trim()) {
          json(res, 400, { error: "dispatch needs a non-empty `content` (or `task`)" });
          return;
        }
        const id = supervisor.dispatcher.dispatch(content, payload.source || "manual");
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
