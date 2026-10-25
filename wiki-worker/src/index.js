// edva-wiki — the wiki site served from the Supabase wiki mirror.
//
// Same pages, same look, same per-person scopes as the host's `wiki serve`
// (lib/wiki-serve.js), but with no dependency on the host being up:
// data comes from the tables bin/wiki-cloud-sync pushes every 5 min.
// Read-only by design — every wiki write still goes through Edva so it
// carries a revision.
//
// Security model, in order:
//   1. Cloudflare Access in front of the hostname (Google sign-in).
//   2. This worker verifies the Access JWT itself (signature, aud, iss, exp)
//      and refuses anything it cannot fully verify.
//   3. The verified email picks a scope from wiki_config.share_scopes; a page
//      outside it is indistinguishable from a missing one, and is filtered out
//      of every listing, search result, outgoing-link and backlink box.
//
// Search is memory retrieval plus a model, and both live only on the host
// (local embeddings, the association graph, the Max-authenticated Claude). So
// /search and /api/* are passed through to the origin — `fetch(req)` from a
// route Worker goes to the zone's origin, the host's tunnel (wiki serve :9097),
// which verifies the same Access JWT itself. If the host cannot be reached,
// /search falls back to the mirror's full-text search with a notice saying so.

import render from "../../lib/wiki-render.js";
import portalLib from "../../lib/wiki-portal.js";
import scopeLib from "../../lib/wiki-scope.js";
// The site icon: the default export of the module the deploy config's [alias]
// maps "wiki-favicon" to — an installation's module re-exporting its PNG
// (bundled as Data by the [[rules]] in wrangler.toml), or the kernel default
// src/favicon-none.js (null: /favicon.* answers 404).
import FAVICON from "wiki-favicon";

const { escapeHtml, renderMarkdown, CSS, shell } = render;
const { scopeFromConfig } = scopeLib;

const CACHE_TTL_MS = 60 * 1000; // index + scopes; the mirror itself lags ≤5 min
let indexCache = { at: 0, rows: null };
let scopesCache = { at: 0, value: null };
let portalCache = { at: 0, value: null };
let jwksCache = { at: 0, keys: null };

// ── Supabase ───────────────────────────────────────────────────────────────

async function sb(env, pathAndQuery, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${pathAndQuery}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery.split("?")[0]}: HTTP ${res.status}`);
  return res;
}
const sbJson = async (env, q, opts) => (await sb(env, q, opts)).json();

/** Every page's listing fields. PostgREST caps a response at 1000 rows, so page. */
async function pageIndex(env) {
  if (indexCache.rows && Date.now() - indexCache.at < CACHE_TTL_MS) return indexCache.rows;
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await sbJson(
      env,
      `/rest/v1/wiki_pages?select=id,type,title,description,status,pinned,updated_at&order=id&limit=1000&offset=${offset}`,
    );
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  indexCache = { at: Date.now(), rows };
  return rows;
}

async function shareScopes(env) {
  if (scopesCache.value && Date.now() - scopesCache.at < CACHE_TTL_MS) return scopesCache.value;
  const rows = await sbJson(env, "/rest/v1/wiki_config?key=eq.share_scopes&select=value");
  if (!rows[0]) throw new Error("share_scopes missing from wiki_config");
  scopesCache = { at: Date.now(), value: rows[0].value };
  return scopesCache.value;
}

// The curated home-portal topics (bin/wiki-portal on the host, pushed by
// wiki-cloud-sync). Optional: without it the portal groups by page type.
async function portalConfig(env) {
  if (portalCache.at && Date.now() - portalCache.at < CACHE_TTL_MS) return portalCache.value;
  let value = null;
  try {
    const rows = await sbJson(env, "/rest/v1/wiki_config?key=eq.portal&select=value");
    value = rows[0] ? rows[0].value : null;
  } catch {}
  portalCache = { at: Date.now(), value };
  return value;
}

// ── Cloudflare Access JWT (WebCrypto port of lib/wiki-access.js) ─────

const b64uDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function getJwks(env, force = false) {
  if (!force && jwksCache.keys && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return jwksCache.keys;
}

/** Verified email, or throw. No partial success. */
async function verifyAccessJwt(env, token) {
  if (!token) throw new Error("no Access token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed Access token");
  const [h, p, sig] = parts;
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64uDecode(h)));
  const payload = JSON.parse(dec.decode(b64uDecode(p)));
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);

  let jwk = (await getJwks(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getJwks(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64uDecode(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error("token expired");
  if (payload.nbf && now < payload.nbf) throw new Error("token not yet valid");
  if (!env.CF_ACCESS_AUD) throw new Error("CF_ACCESS_AUD is not set");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.CF_ACCESS_AUD)) throw new Error("audience mismatch");
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) throw new Error("issuer mismatch");
  const email = String(payload.email || "").toLowerCase();
  if (!email) throw new Error("token carries no email");
  return email;
}

// ── Rendering (shared with wiki-serve.js via wiki-portal.js / wiki-render.js)

const byTitle = (a, b) => (a.title || a.id).localeCompare(b.title || b.id);
const page = (who, title, body, opts) => shell(title, body, who, opts);

async function renderPageView(env, id, pages, canRead, who, fullView) {
  // Out of scope renders exactly like missing — a 403 would confirm the page exists.
  if (!canRead(id)) return null;
  const q = encodeURIComponent(id);
  const [rows, fwdAll, backAll, revRes] = await Promise.all([
    sbJson(env, `/rest/v1/wiki_pages?id=eq.${q}&select=id,type,title,description,status,pinned,confidence,last_verified_at,body_md,updated_at`),
    sbJson(env, `/rest/v1/wiki_page_links?src_id=eq.${q}&select=dst_id,link_type&order=dst_id`),
    sbJson(env, `/rest/v1/wiki_page_links?dst_id=eq.${q}&select=src_id,link_type&order=src_id`),
    sb(env, `/rest/v1/wiki_page_revisions?page_id=eq.${q}&select=rev`, { method: "HEAD", prefer: "count=exact" }),
  ]);
  const row = rows[0];
  if (!row) return null;
  const revCount = Number((revRes.headers.get("content-range") || "").split("/")[1]) || 0;
  const titles = new Map(pages.map((p) => [p.id, p.title || p.id]));
  const fwd = fwdAll.filter((l) => canRead(l.dst_id)).map((l) => ({ ...l, resolved: titles.has(l.dst_id) }));
  const back = backAll.filter((l) => canRead(l.src_id));
  const bodyHtml = renderMarkdown(row.body_md, { resolveLink: (t) => titles.has(t), labelFor: (t) => titles.get(t) || null });
  const portal = portalLib.resolvePortal({ pages, config: await portalConfig(env), fullView });
  return page(who, row.title || row.id,
    portalLib.pageBody({ page: row, bodyHtml, fwd, back, titles, topic: portal.ofPage(id), revCount, connected: true }),
    { script: portalLib.RELATED_SCRIPT });
}

// The fallback when the host is unreachable: the mirror's full-text search,
// said plainly, with no model answer.
async function renderSearchFallback(env, q, canRead, who) {
  const query = String(q || "").trim();
  if (!query) return page(who, "Ask", portalLib.searchBody({ query: "" }), { q: "" });
  const raw = await sbJson(env, "/rest/v1/rpc/wiki_search", { method: "POST", body: { q: query, lim: 200 } });
  // ts_headline returns page text with <mark> tags but does NOT escape it.
  const snippet = (s) => escapeHtml(s || "").replace(/&lt;(\/?)mark&gt;/g, "<$1mark>");
  const results = raw.filter((h) => canRead(h.id)).slice(0, 25)
    .map((h) => ({ id: h.id, title: h.title || h.id, type: h.type, snippetHtml: `${snippet(h.snippet)}…` }));
  return page(who, query, portalLib.searchBody({
    query, results, answer: false,
    offline: "Edva's memory is offline right now, so these are plain text matches from the cloud copy, with no answer.",
  }), { q: query });
}

// Pass a request through to the origin (the host), bounded. Null when it did
// not answer usefully — a tunnel error page is not an answer.
async function viaOrigin(req, ms) {
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(ms) });
    if (res.status >= 500) return null;
    const out = new Response(res.body, res);
    out.headers.set("cache-control", "private, no-store");
    return out;
  } catch {
    return null;
  }
}

// ── Request handling ───────────────────────────────────────────────────────

const PRIVATE = { "cache-control": "private, no-store" };
const html = (status, body) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE } });
const deny = (msg) => html(403, shell("Not authorised", `<h1>Not authorised</h1><p>${escapeHtml(msg)}</p>`));

export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    // Liveness — before the identity gate, and reveals nothing.
    if (u.pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain", ...PRIVATE } });
    // The Access session lives on the cloudflareaccess.com domain; only Access can end it.
    if (u.pathname === "/logout") return Response.redirect(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`, 302);
    if (u.pathname === "/style.css") return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" } });
    if (u.pathname === "/favicon.png" || u.pathname === "/favicon.ico") {
      if (!FAVICON) return new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "public, max-age=86400" } });
      return new Response(FAVICON, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
    }

    let scope;
    try {
      const email = await verifyAccessJwt(env, req.headers.get("cf-access-jwt-assertion"));
      scope = scopeFromConfig(await shareScopes(env), email);
    } catch {
      return deny("A valid Cloudflare Access session is required.");
    }
    if (!scope.known) return deny("This account has no access.");
    const canRead = (id) => scope.unrestricted || scope.canRead(id);
    const who = { label: scope.label, scoped: !scope.unrestricted };

    const fullView = !!scope.unrestricted;
    try {
      // Memory search and the model live on the host.
      if (u.pathname === "/search") {
        if (!String(u.searchParams.get("q") || "").trim()) return html(200, page(who, "Ask", portalLib.searchBody({ query: "" })));
        return (await viaOrigin(req, 15000)) || html(200, await renderSearchFallback(env, u.searchParams.get("q"), canRead, who));
      }
      if (u.pathname.startsWith("/api/")) {
        const res = await viaOrigin(req, u.pathname === "/api/ask" ? 75000 : 12000);
        return res || new Response(JSON.stringify({ error: "Edva's memory is offline right now." }), { status: 503, headers: { "content-type": "application/json", ...PRIVATE } });
      }

      const pages = (await pageIndex(env)).filter((p) => canRead(p.id) && p.status === "active");
      if (u.pathname === "/" || u.pathname === "") {
        const type = u.searchParams.get("type");
        if (u.searchParams.get("pinned") === "1") {
          const pinned = pages.filter((p) => p.pinned).sort(byTitle);
          return html(200, page(who, "Always in mind", portalLib.listingBody({ title: "Always in mind", dek: "The pages Edva keeps in mind in every conversation.", pages: pinned }), { active: "pinned" }));
        }
        if (type) {
          const label = portalLib.TYPE_LABEL[type] || type;
          return html(200, page(who, label, portalLib.listingBody({ title: label, pages: pages.filter((p) => p.type === type).sort(byTitle) })));
        }
        const portal = portalLib.resolvePortal({ pages, config: await portalConfig(env), fullView });
        return html(200, page(who, "Home", portalLib.homeBody({ pages, portal, fullView, note: "cloud copy, synced every 5 min" }), { active: "home" }));
      }
      if (u.pathname === "/timeline") return html(200, page(who, "Timeline", portalLib.timelineBody({ pages }), { active: "timeline" }));
      const t = u.pathname.match(/^\/t\/([a-z0-9-]+)$/);
      if (t) {
        const portal = portalLib.resolvePortal({ pages, config: await portalConfig(env), fullView });
        const topic = portal.topics.find((x) => x.slug === t[1]);
        return topic ? html(200, page(who, topic.name, portalLib.topicBody({ topic }))) : html(404, page(who, "Not found", portalLib.notFoundBody(t[1])));
      }
      const m = u.pathname.match(/^\/p\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]).replace(/\.md$/, "");
        const out = await renderPageView(env, id, pages, canRead, who, fullView);
        return out ? html(200, out) : html(404, page(who, "Not found", portalLib.notFoundBody(id)));
      }
      return html(404, page(who, "Not found", portalLib.notFoundBody(u.pathname)));
    } catch (err) {
      console.error(err);
      // No stack to the browser — this is internet-facing.
      return html(500, page(who, "Error", `<div class="page-head"><h1>Something went wrong</h1><p class="dek">The wiki could not be read from the cloud copy. Try again shortly.</p></div>`));
    }
  },
};
