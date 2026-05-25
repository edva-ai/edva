// merlin-telemetry — single endpoint serving two purposes:
//
//   GET  /api/ping        → returns a 1×1 transparent GIF (README/docs pixel)
//   POST /api/ping        → accepts a JSON install ping from `bin/merlin install`
//
// Both branches log a single-line JSON record to Vercel Runtime Logs. No
// database, no cookies, no PII stored — the client IP is hashed with a daily
// salt so we get same-day uniqueness without retaining the raw address.
//
// Honors `Do-Not-Track: 1` and the `MERLIN_NO_TELEMETRY=1` env on the client
// side. There is no auth — anyone can hit either route; the only thing that
// happens is a log line.
//
// Run-config (Vercel edge):
//   - Edge runtime, no Node APIs needed.
//   - Free Vercel project, default *.vercel.app subdomain.
//
// To deploy:
//   cd apps/telemetry && vercel --prod
//
// See apps/telemetry/README.md.

export const config = { runtime: "edge" };

// 1×1 transparent GIF, base64.
const PIXEL_GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const PIXEL_BYTES = Uint8Array.from(atob(PIXEL_GIF_B64), (c) => c.charCodeAt(0));

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

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ipHash = await hashIP(clientIP(req));
  const ua = clip(req.headers.get("user-agent"));
  const ref = clip(req.headers.get("referer"));
  const dnt = req.headers.get("dnt") === "1";

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
      await logHit("install", {
        ipHash,
        ua,
        ref,
        host_fp: clip(String(body.host_fp ?? "")),
        os: clip(String(body.os ?? "")),
        arch: clip(String(body.arch ?? "")),
        ver: clip(String(body.ver ?? "")),
        sha: clip(String(body.sha ?? "")),
        // Free-form context (e.g. "fresh-install", "reinstall", "upgrade").
        ctx: clip(String(body.ctx ?? "")),
      });
    }
    return new Response("", { status: 204 });
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: "GET, POST" },
  });
}
