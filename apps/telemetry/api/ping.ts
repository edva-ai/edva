// merlin-telemetry — single endpoint serving four purposes:
//
//   GET  /px[/anything]?r=<tag>  → 1×1 transparent GIF (README/docs pixel)
//   POST /install                → JSON install ping from `bin/merlin install`
//   GET  /stats                  → aggregate, anonymous install/px counters
//   GET|POST /usage              → private Claude usage/cost rollup (gated)
//
// All branches still log a single-line JSON record to Vercel Runtime Logs (the
// original, retention-limited signal). On top of that, the install branch now
// writes durable AGGREGATE counters to a KV store (Upstash Redis / Vercel KV)
// so we have a historical install count that survives log expiry.
//
// Privacy posture is unchanged: no raw IP retention, no cookies, no PII. The KV
// layer stores only counters and a HyperLogLog of host fingerprints — never the
// fingerprints themselves — so we get a unique-host count without keeping the
// values that produced it. Raw host_fp is logged (as before) but never stored.
//
// KV is strictly best-effort: every write is wrapped so a KV outage or missing
// credentials can never make an install ping fail. If the KV env vars are
// absent, the function behaves exactly like the pre-KV version.
//
// Honors `Do-Not-Track: 1` and the `MERLIN_NO_TELEMETRY=1` env on the client
// side. There is no auth on px/install — anyone can hit either route; the only
// thing that happens is a log line plus (for installs) a counter bump. The
// /stats route can optionally be gated with a STATS_TOKEN env var.
//
// Run-config (Vercel edge):
//   - Edge runtime; @upstash/redis talks over REST so no Node APIs are needed.
//   - Free Vercel project, default *.vercel.app subdomain.
//
// Env (set by the Upstash/Vercel KV marketplace integration, or by hand):
//   - KV_REST_API_URL / KV_REST_API_TOKEN            (Vercel KV naming), or
//   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   - STATS_TOKEN (optional) — if set, /stats requires ?token=<STATS_TOKEN>.
//
// To deploy:
//   cd apps/telemetry && vercel --prod
//
// See apps/telemetry/README.md.

import { Redis } from "@upstash/redis";

export const config = { runtime: "edge" };

// 1×1 transparent GIF, base64.
const PIXEL_GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PIXEL_BYTES = Uint8Array.from(atob(PIXEL_GIF_B64), (c) => c.charCodeAt(0));

// Namespace so this project can share a KV store with anything else.
const NS = "merlin";

// Lazily build a Redis client from whichever env-var pair is present. Returns
// null when no credentials are configured, which switches the function back to
// pure logging behavior. Never throws.
let _redis: Redis | null | undefined;
function kv(): Redis | null {
  if (_redis !== undefined) return _redis;
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  _redis = url && token ? new Redis({ url, token }) : null;
  return _redis;
}

// Daily salt — same calendar day produces the same hash for the same IP, so
// we get unique-per-day counting without storing addresses across days.
function daySalt(): string {
  return new Date().toISOString().slice(0, 10);
}

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + "|" + daySalt());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function clientIP(req: Request): string {
  // Vercel forwards the real client IP in x-forwarded-for (first entry).
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || "0.0.0.0";
}

// Cap to keep log lines bounded; UA/refs from random crawlers can get silly.
function clip(s: string | null, max = 256): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function logHit(kind: string, fields: Record<string, unknown>) {
  // One-line JSON so it's grep-able in `vercel logs`.
  console.log(JSON.stringify({ kind, ts: new Date().toISOString(), ...fields }));
}

// Persist durable, anonymous aggregates for an install ping. Best-effort: any
// failure is swallowed so the install never observes a telemetry error.
//
// Keys written (all under the `merlin:` namespace):
//   installs:total            INCR   running total of install pings
//   installs:day:<YYYY-MM-DD> INCR   per-day install count
//   installs:hosts            PFADD  HyperLogLog of host_fp → unique-host count
//   installs:os               HINCRBY per-OS breakdown
//   installs:arch             HINCRBY per-arch breakdown
//   installs:ver              HINCRBY per-version breakdown
//   installs:ctx              HINCRBY per-context breakdown (fresh/reinstall/…)
//   installs:last_ts          SET    ISO timestamp of the most recent install
//   installs:recent           LPUSH  capped (100) feed of {ts,os,arch,ver,ctx}
async function recordInstall(fields: {
  host_fp: string;
  os: string;
  arch: string;
  ver: string;
  ctx: string;
  ts: string;
}) {
  const redis = kv();
  if (!redis) return;
  const k = (s: string) => `${NS}:installs:${s}`;
  try {
    const p = redis.pipeline();
    p.incr(k("total"));
    p.incr(k(`day:${daySalt()}`));
    if (fields.host_fp) p.pfadd(k("hosts"), fields.host_fp);
    p.hincrby(k("os"), fields.os || "unknown", 1);
    p.hincrby(k("arch"), fields.arch || "unknown", 1);
    p.hincrby(k("ver"), fields.ver || "unknown", 1);
    p.hincrby(k("ctx"), fields.ctx || "unknown", 1);
    p.set(k("last_ts"), fields.ts);
    // Recent feed carries no IP/host_fp — just the coarse install descriptors.
    p.lpush(
      k("recent"),
      JSON.stringify({
        ts: fields.ts,
        os: fields.os,
        arch: fields.arch,
        ver: fields.ver,
        ctx: fields.ctx,
      }),
    );
    p.ltrim(k("recent"), 0, 99);
    await p.exec();
  } catch {
    /* best-effort: never let a KV hiccup break an install */
  }
}

// Read back the aggregate counters for /stats. Returns null on any failure or
// when KV isn't configured.
async function readStats(): Promise<Record<string, unknown> | null> {
  const redis = kv();
  if (!redis) return null;
  const k = (s: string) => `${NS}:installs:${s}`;
  try {
    const [total, uniqueHosts, lastTs, os, arch, ver, ctx, recentRaw] =
      await Promise.all([
        redis.get<number>(k("total")),
        redis.pfcount(k("hosts")),
        redis.get<string>(k("last_ts")),
        redis.hgetall<Record<string, number>>(k("os")),
        redis.hgetall<Record<string, number>>(k("arch")),
        redis.hgetall<Record<string, number>>(k("ver")),
        redis.hgetall<Record<string, number>>(k("ctx")),
        redis.lrange<string>(k("recent"), 0, 19),
      ]);
    const recent = (recentRaw || []).map((r) => {
      try {
        return typeof r === "string" ? JSON.parse(r) : r;
      } catch {
        return r;
      }
    });
    return {
      installs_total: total ?? 0,
      unique_hosts: uniqueHosts ?? 0,
      last_install: lastTs ?? null,
      by_os: os ?? {},
      by_arch: arch ?? {},
      by_version: ver ?? {},
      by_context: ctx ?? {},
      recent,
    };
  } catch {
    return null;
  }
}

// --- token gate shared by /stats and /usage ---
// Accepts the token either as ?token=… or an `Authorization: Bearer …` header.
// When STATS_TOKEN is unset the gate is open (matches the pre-token behavior of
// /stats); /usage additionally refuses entirely unless a token is configured.
function tokenOK(req: Request, url: URL): boolean {
  const required = process.env.STATS_TOKEN || "";
  if (!required) return true;
  const q = url.searchParams.get("token") || "";
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return q === required || bearer === required;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
      "access-control-allow-origin": "*",
    },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

// --- usage aggregation (Claude API token/cost monitoring) ---
//
// Unlike installs/px, usage data is private operational telemetry pushed by
// `merlin-cost-report --push` from the operator's own hosts, so /usage is
// ALWAYS token-gated. Per merlin's Max-only auth invariant the dollar figures
// are SDK ESTIMATES, not billed spend — we carry a `cost_is_estimated` flag and
// name the field `est_cost_usd` so nothing downstream mistakes it for real
// money. The signals that actually matter for cost reduction are token volume
// and cache-hit rate.
//
// Storage is idempotent per (host, day): re-pushing a day overwrites that
// host's snapshot rather than double-counting.
//   usage:day:<YYYY-MM-DD>  HASH  host_fp → {ts, ver, sha, jobs:{src:{…}}}
//   usage:days              SET   days that have at least one snapshot
//   usage:hosts             PF    HyperLogLog of host_fp → unique-host count
//   usage:last_push         STR   ISO ts of most recent push
//   usage:phantom           STR   "1" if last push reported estimated costs

type UsageAcc = {
  dispatches: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  web_search_requests: number;
  total_turns: number;
  total_duration_ms: number;
  est_cost_usd: number;
};

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function emptyUsage(): UsageAcc {
  return {
    dispatches: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_search_requests: 0,
    total_turns: 0,
    total_duration_ms: 0,
    est_cost_usd: 0,
  };
}

function accUsage(t: UsageAcc, j: Record<string, unknown>): void {
  t.dispatches += num(j.dispatches);
  t.input_tokens += num(j.input_tokens);
  t.output_tokens += num(j.output_tokens);
  t.cache_read_tokens += num(j.cache_read_tokens);
  t.cache_creation_tokens += num(j.cache_creation_tokens);
  t.web_search_requests += num(j.web_search_requests);
  t.total_turns += num(j.total_turns);
  t.total_duration_ms += num(j.total_duration_ms);
  t.est_cost_usd += num(j.total_cost_usd);
}

function roundCost(t: UsageAcc): UsageAcc {
  t.est_cost_usd = +t.est_cost_usd.toFixed(4);
  return t;
}

// Persist one per-host daily usage snapshot. Idempotent: HSET overwrites the
// host's field for that day. Best-effort — never throws.
async function recordUsage(body: Record<string, unknown>): Promise<boolean> {
  const redis = kv();
  if (!redis) return false;
  const rawDay = String(body.day ?? "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : daySalt();
  const host = clip(String(body.host_fp ?? "anon"), 64) || "anon";
  const jobsIn =
    body.jobs && typeof body.jobs === "object"
      ? (body.jobs as Record<string, Record<string, unknown>>)
      : {};
  // Store the snapshot with the SAME field names the push sends (notably
  // total_cost_usd) so readUsage's accUsage — which maps total_cost_usd →
  // est_cost_usd — finds it. Normalizing through accUsage here would rename
  // the field on write and silently zero out cost on read.
  const jobs: Record<string, Record<string, number>> = {};
  for (const [src, v] of Object.entries(jobsIn)) {
    const j = (v || {}) as Record<string, unknown>;
    jobs[clip(src, 64)] = {
      dispatches: num(j.dispatches),
      input_tokens: num(j.input_tokens),
      output_tokens: num(j.output_tokens),
      cache_read_tokens: num(j.cache_read_tokens),
      cache_creation_tokens: num(j.cache_creation_tokens),
      web_search_requests: num(j.web_search_requests),
      total_turns: num(j.total_turns),
      total_duration_ms: num(j.total_duration_ms),
      total_cost_usd: +num(j.total_cost_usd).toFixed(4),
    };
  }
  const snapshot = {
    ts: new Date().toISOString(),
    ver: clip(String(body.ver ?? "")),
    sha: clip(String(body.sha ?? "")),
    jobs,
  };
  const k = (s: string) => `${NS}:usage:${s}`;
  try {
    const p = redis.pipeline();
    p.hset(k(`day:${day}`), { [host]: snapshot });
    p.sadd(k("days"), day);
    p.pfadd(k("hosts"), host);
    p.set(k("last_push"), snapshot.ts);
    p.set(k("phantom"), body.phantom ? "1" : "0");
    await p.exec();
    return true;
  } catch {
    return false;
  }
}

// Aggregate the last `days` of per-host snapshots into totals + per-job +
// per-day breakdowns. Returns null on failure / when KV isn't configured.
async function readUsage(days: number): Promise<Record<string, unknown> | null> {
  const redis = kv();
  if (!redis) return null;
  const k = (s: string) => `${NS}:usage:${s}`;
  try {
    const allDays = ((await redis.smembers(k("days"))) as string[] | null) || [];
    const recentDays = allDays.sort().slice(-days);
    const totals = emptyUsage();
    const byJob: Record<string, UsageAcc> = {};
    const byDay: Record<string, UsageAcc> = {};
    for (const d of recentDays) {
      const hostMap =
        ((await redis.hgetall(k(`day:${d}`))) as Record<string, unknown> | null) || {};
      const dayTot = emptyUsage();
      for (const snapRaw of Object.values(hostMap)) {
        const snap = (typeof snapRaw === "string" ? JSON.parse(snapRaw) : snapRaw) as
          | { jobs?: Record<string, Record<string, unknown>> }
          | null;
        const jobs = (snap && snap.jobs) || {};
        for (const [src, j] of Object.entries(jobs)) {
          accUsage(totals, j);
          accUsage(dayTot, j);
          byJob[src] = byJob[src] || emptyUsage();
          accUsage(byJob[src], j);
        }
      }
      byDay[d] = roundCost(dayTot);
    }
    const [uniqueHosts, lastPush, phantom] = await Promise.all([
      redis.pfcount(k("hosts")),
      redis.get(k("last_push")),
      redis.get(k("phantom")),
    ]);
    for (const src of Object.keys(byJob)) roundCost(byJob[src]);
    roundCost(totals);
    const denom = totals.input_tokens + totals.cache_read_tokens;
    const cacheHitRate = denom > 0 ? +(totals.cache_read_tokens / denom).toFixed(4) : 0;
    return {
      window_days: days,
      unique_hosts: uniqueHosts ?? 0,
      last_push: lastPush ?? null,
      // Per merlin's Max-only auth invariant, est_cost_usd is an SDK estimate.
      cost_is_estimated: String(phantom) === "1",
      totals,
      cache_hit_rate: cacheHitRate,
      by_job: byJob,
      by_day: byDay,
    };
  } catch {
    return null;
  }
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ipHash = await hashIP(clientIP(req));
  const ua = clip(req.headers.get("user-agent"));
  const ref = clip(req.headers.get("referer"));
  const dnt = req.headers.get("dnt") === "1";

  // Stats branch — read-only aggregate install/px JSON. Optionally STATS_TOKEN.
  if (req.method === "GET" && url.pathname === "/stats") {
    if (!tokenOK(req, url)) return unauthorized();
    const stats = await readStats();
    if (!stats) return jsonResponse({ error: "stats unavailable (KV not configured)" }, 503);
    return jsonResponse(stats);
  }

  // Usage branch — private Claude usage/cost monitoring. ALWAYS token-gated
  // (unlike /px and /install): POST pushes a per-host daily rollup from
  // `merlin-cost-report --push`; GET returns the aggregate. Refuses entirely
  // unless STATS_TOKEN is configured, so cost data can't be ingested openly.
  if (url.pathname === "/usage") {
    if (!process.env.STATS_TOKEN) {
      return jsonResponse({ error: "usage requires STATS_TOKEN to be configured" }, 503);
    }
    if (!tokenOK(req, url)) return unauthorized();
    if (req.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* ignore — bad JSON yields an empty (no-op) push */
      }
      const ok = await recordUsage(body);
      return jsonResponse({ ok }, ok ? 200 : 503);
    }
    if (req.method === "GET") {
      const d = Number(url.searchParams.get("days"));
      const usage = await readUsage(Number.isFinite(d) && d > 0 ? Math.min(d, 365) : 30);
      if (!usage) return jsonResponse({ error: "usage unavailable (KV not configured)" }, 503);
      return jsonResponse(usage);
    }
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }

  if (req.method === "GET") {
    // Pixel branch. Always returns the GIF regardless of DNT — what we skip is
    // the log line, not the response. That keeps the README image working for
    // privacy-conscious viewers while not recording them.
    if (!dnt) {
      await logHit("px", {
        ipHash,
        ua,
        ref,
        tag: clip(url.searchParams.get("r")) || null,
      });
      // Cheap durable counter for total pixel hits (best-effort).
      const redis = kv();
      if (redis) {
        try {
          await redis.incr(`${NS}:px:total`);
        } catch {
          /* ignore */
        }
      }
    }
    return new Response(PIXEL_BYTES, {
      headers: {
        "content-type": "image/gif",
        // Cache-Control is intentionally short so locally-rendered README
        // previews (VS Code, JetBrains) re-fetch on each render. GitHub Camo
        // will cache aggressively regardless — see README pixel caveat doc.
        "cache-control": "no-store, max-age=0",
        "content-length": String(PIXEL_BYTES.length),
        "access-control-allow-origin": "*",
      },
    });
  }

  if (req.method === "POST") {
    // Install-ping branch. Body is a tiny JSON object the merlin CLI sends on
    // first run per-host. Keys are all client-supplied; we treat them as
    // opaque strings and clip them. Bad/missing JSON → 204 silently (we never
    // want a telemetry endpoint to be the reason an install fails).
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* ignore */
    }
    if (!dnt) {
      const ts = new Date().toISOString();
      const fields = {
        host_fp: clip(String(body.host_fp ?? "")),
        os: clip(String(body.os ?? "")),
        arch: clip(String(body.arch ?? "")),
        ver: clip(String(body.ver ?? "")),
        sha: clip(String(body.sha ?? "")),
        // Free-form context (e.g. "fresh-install", "reinstall", "upgrade").
        ctx: clip(String(body.ctx ?? "")),
      };
      await logHit("install", { ipHash, ua, ref, ...fields });
      // Durable aggregate counters. host_fp is used for the unique-host
      // HyperLogLog only; it is never stored as a value.
      await recordInstall({ ...fields, ts });
    }
    return new Response("", { status: 204 });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: "GET, POST" },
  });
}
