// wiki-serve.js — minimal localhost HTTP browser for the wiki.
//
// Reads pages straight from the wiki DB (always current), renders body
// Markdown to HTML inline, turns [[wikilinks]] into clickable links, and
// shows backlinks / outgoing links / revisions per page. No external deps.
//
// Routes:
//   GET /                — index, grouped by type, pinned section first
//   GET /p/<id>          — page view
//   GET /search?q=...    — full-text search
//   GET /style.css       — inline CSS

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ws = require("./wiki-store.js");

// Merlin app icon — same 1024×1024 PNG the iOS client ships with, reused
// as the wiki's favicon so the tab matches the app. Read once at startup;
// served verbatim from /favicon.ico and /favicon.png.
const FAVICON_PATH = path.join(
  __dirname,
  "../../client/Merlin/Assets.xcassets/AppIcon.appiconset/icon.png",
);
let FAVICON_BYTES = null;
try {
  FAVICON_BYTES = fs.readFileSync(FAVICON_PATH);
} catch {
  // Missing icon is non-fatal — the wiki still serves; favicon routes 404.
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Minimal Markdown → HTML renderer ────────────────────────────────────
//
// Handles the subset of Markdown the memory pages actually use: headings,
// paragraphs, ordered + unordered lists, fenced + inline code, bold +
// italic, [text](url) links, and [[wikilinks]]. Not a general-purpose
// renderer — but lossless on every page in the corpus.

function renderInline(text, { resolveLink } = {}) {
  let s = escapeHtml(text);
  // The regex rules below capture substrings of the *already-escaped* `s`,
  // so the captured groups are themselves valid escaped HTML — DO NOT
  // re-run escapeHtml on them. Doing so produced `&amp;amp;` in wikilink
  // display text and broke URLs containing `&` in [text](url) / ![alt](url).
  // [[target|display]] or [[target]] — wikilinks
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => {
    const id = target.trim().replace(/\.md$/, "");
    const label = (display || target).trim();
    const resolved = resolveLink ? resolveLink(id) : true;
    const cls = resolved ? "wikilink" : "wikilink dangling";
    return `<a href="/p/${encodeURIComponent(id)}" class="${cls}">${label}</a>`;
  });
  // ![alt](url) — markdown image. Must run BEFORE the link rule so the
  // leading "!" doesn't get left behind as text.
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`,
  );
  // [text](url) — external links
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text, href) =>
      `<a href="${href}" rel="noopener" target="_blank">${text}</a>`,
  );
  // `inline code`
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // **bold**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // *italic* — only the asterisk form. Underscore italic is intentionally
  // skipped: identifiers like `user_pari` and `bin/memory_chunks`
  // appear in body text constantly and would all get mangled.
  s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
  return s;
}

function renderMarkdown(body, opts = {}) {
  const lines = String(body || "").split("\n");
  const out = [];
  let i = 0;
  let listKind = null; // "ul" | "ol" | null
  const closeList = () => {
    if (listKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (/^```/.test(line)) {
      closeList();
      const lang = line.replace(/^```/, "").trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`,
      );
      continue;
    }
    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    // Horizontal rule.
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      i++;
      continue;
    }
    // GitHub-flavored Markdown table: header `| a | b |` + separator
    // `|---|---|` (with optional `:` alignment) + zero or more data rows.
    // Cell `|` chars don't appear in our wikilinks/images but separators
    // can be escaped as `\|` if a row needs a literal pipe.
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      closeList();
      const splitRow = (row) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split(/(?<!\\)\|/)
          .map((c) => c.replace(/\\\|/g, "|").trim());
      const headerCells = splitRow(line);
      const tableLines = [`<table><thead><tr>`];
      for (const c of headerCells) {
        tableLines.push(`<th>${renderInline(c, opts)}</th>`);
      }
      tableLines.push(`</tr></thead><tbody>`);
      i += 2; // skip header + separator
      while (
        i < lines.length &&
        /^\s*\|.*\|\s*$/.test(lines[i])
      ) {
        const cells = splitRow(lines[i]);
        tableLines.push(`<tr>`);
        for (const c of cells) {
          tableLines.push(`<td>${renderInline(c, opts)}</td>`);
        }
        tableLines.push(`</tr>`);
        i++;
      }
      tableLines.push(`</tbody></table>`);
      out.push(tableLines.join(""));
      continue;
    }
    // Unordered list item.
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      if (listKind !== "ul") {
        closeList();
        out.push("<ul>");
        listKind = "ul";
      }
      out.push(`<li>${renderInline(ul[2], opts)}</li>`);
      i++;
      continue;
    }
    // Ordered list item.
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) {
      if (listKind !== "ol") {
        closeList();
        out.push("<ol>");
        listKind = "ol";
      }
      out.push(`<li>${renderInline(ol[2], opts)}</li>`);
      i++;
      continue;
    }
    // Blank line — paragraph break / list end.
    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }
    // Paragraph: collect contiguous non-blank, non-special lines.
    closeList();
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|---+\s*$|\*\*\*+\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(buf.join(" "), opts)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// ── HTML shell + CSS ────────────────────────────────────────────────────

const CSS = `
:root {
  --fg: #1a1a1a;
  --fg-dim: #555;
  --bg: #fafafa;
  --panel: #fff;
  --border: #e2e2e2;
  --link: #0b65c2;
  --link-dangling: #c44;
  --code-bg: #f0f0f0;
  --kbd-bg: #ececec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6e6e6;
    --fg-dim: #999;
    --bg: #181818;
    --panel: #222;
    --border: #333;
    --link: #6cb6ff;
    --link-dangling: #ff7a7a;
    --code-bg: #2a2a2a;
    --kbd-bg: #333;
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  font-size: 17px;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
}
.layout {
  max-width: 920px;
  margin: 0 auto;
  padding: 24px 20px 80px;
}
nav.top {
  border-bottom: 1px solid var(--border);
  padding: 12px 20px;
  background: var(--panel);
  display: flex;
  gap: 16px;
  align-items: center;
}
nav.top a { color: var(--fg); text-decoration: none; font-weight: 600; }
nav.top form { margin-left: auto; }
nav.top input[type=search] {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  width: 280px;
  font-size: 14px;
}
h1, h2, h3, h4 { line-height: 1.25; }
h1 { font-size: 30px; margin: 8px 0 16px; }
h2 { font-size: 23px; margin: 28px 0 10px; }
h3 { font-size: 19px; margin: 22px 0 8px; }
h4 { font-size: 17px; margin: 18px 0 6px; }
a { color: var(--link); text-decoration: underline; }
a:hover { text-decoration: underline; }
a.wikilink { color: var(--link); text-decoration: underline; font-weight: 500; }
a.wikilink.dangling { color: var(--link-dangling); text-decoration: underline; text-decoration-style: dashed; }
nav.top a { text-decoration: none; }
code {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 13px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
pre {
  background: var(--code-bg);
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
}
pre code { background: none; padding: 0; }
hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
p > img:only-child { display: block; margin: 12px 0; }
/* Multiple images in a single paragraph (the diary photo grid pattern) — */
/* render as a square-tile grid instead of a vertical stack. */
p:has(> img + img) { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; margin: 12px 0; }
p:has(> img + img) img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; margin: 0; }
.dim { color: var(--fg-dim); }
.meta {
  font-size: 13px;
  color: var(--fg-dim);
  background: var(--panel);
  border: 1px solid var(--border);
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 20px;
}
.meta b { color: var(--fg); }
.meta .kv { display: inline-block; margin-right: 14px; }
.pinned-badge {
  display: inline-block;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #fde68a;
  color: #78350f;
  vertical-align: middle;
  margin-right: 6px;
}
.section-title { color: var(--fg-dim); font-weight: 600; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; margin: 28px 0 8px; }
ul.pages { list-style: none; padding: 0; margin: 0; }
ul.pages li { padding: 4px 0; border-bottom: 1px solid var(--border); }
ul.pages li:last-child { border-bottom: none; }
ul.pages .id { color: var(--link); text-decoration: underline; }
ul.pages .title { margin-left: 8px; }
ul.pages .desc { color: var(--fg-dim); margin-left: 8px; }
.links-box li a, .search-hit a { color: var(--link); text-decoration: underline; }
.links-box {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  margin: 24px 0;
}
.links-box h3 { font-size: 13px; text-transform: uppercase; color: var(--fg-dim); margin: 0 0 8px; letter-spacing: 0.06em; }
.links-box ul { list-style: none; padding: 0; margin: 0; }
.links-box li { padding: 2px 0; font-size: 14px; }
.links-box li small { color: var(--fg-dim); }
table { border-collapse: collapse; margin: 12px 0; font-size: 14px; max-width: 100%; }
th, td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
th { background: var(--bg-alt, #f0f0f0); font-weight: 600; }
tbody tr:nth-child(even) { background: rgba(0, 0, 0, 0.02); }
.search-hit { padding: 8px 0; border-bottom: 1px solid var(--border); }
.search-hit .snippet { color: var(--fg-dim); font-size: 13px; }
.type-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 16px; }
.type-chip {
  display: inline-block;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--fg);
  text-decoration: none;
  font-size: 14px;
}
.type-chip:hover { border-color: var(--link); color: var(--link); }
.type-chip.active { border-color: var(--link); color: var(--link); font-weight: 600; }
ul.pages li > .desc { display: block; margin-left: 0; font-size: 13px; padding-top: 2px; }

/* ── Mobile (iPhone-sized viewports) ────────────────────────────────── */
/* The desktop nav puts 9 type filters + a 280px search input on one row, */
/* which overflows narrow screens and pushes the search box off-screen. */
/* Wrap the nav, let the type filters horizontally scroll, and make the */
/* search input fill the remaining row width. Also tighten typography. */
@media (max-width: 600px) {
  nav.top {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    font-size: 14px;
  }
  nav.top a { font-size: 14px; white-space: nowrap; }
  nav.top form {
    margin-left: 0;
    width: 100%;
    order: 99; /* push search to its own row below the link chips */
  }
  nav.top input[type=search] {
    width: 100%;
    font-size: 16px; /* ≥16px on iOS prevents zoom-on-focus */
    padding: 8px 10px;
  }
  .layout { padding: 16px 14px 60px; }
  h1 { font-size: 24px; margin: 4px 0 12px; }
  h2 { font-size: 19px; margin: 22px 0 8px; }
  h3 { font-size: 17px; margin: 18px 0 6px; }
  h4 { font-size: 15px; }
  .meta { padding: 8px 10px; font-size: 12px; }
  .meta .kv { display: block; margin-right: 0; margin-bottom: 2px; }
  table { font-size: 13px; display: block; overflow-x: auto; }
  th, td { padding: 5px 8px; }
  pre { font-size: 12px; padding: 10px; }
  /* Wikilinks get extra padding so they're tap-target friendly (≥44pt). */
  a.wikilink, ul.pages .id, .links-box li a, .search-hit a {
    display: inline-block;
    padding: 4px 0;
  }
  /* Tighter image grid on phone — 3 columns instead of auto-fill 160px+ */
  p:has(> img + img) { grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .type-chip { padding: 5px 10px; font-size: 13px; }
}
`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Merlin wiki</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<nav class="top">
  <a href="/">Wiki</a>
  <a href="/?type=user" class="dim">user</a>
  <a href="/?type=feedback" class="dim">feedback</a>
  <a href="/?type=project" class="dim">project</a>
  <a href="/?type=day" class="dim">day</a>
  <a href="/?type=week" class="dim">week</a>
  <a href="/?type=month" class="dim">month</a>
  <a href="/?type=reference" class="dim">reference</a>
  <a href="/?pinned=1" class="dim">pinned</a>
  <form method="get" action="/search">
    <input type="search" name="q" placeholder="search…" autocomplete="off">
  </form>
</nav>
<div class="layout">
${body}
</div>
</body>
</html>`;
}

// ── Page renderers ──────────────────────────────────────────────────────

// Format a UTC ISO timestamp as a short relative time ("2h", "3d", "Apr 21").
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Top-N pages by hit-count over the last `windowDays` of the access log.
// Returns [{id, count, page}] where `page` is the page row (or undefined if
// the id has since been deleted/superseded).
function hotPages({ limit = 10, windowDays = 7 } = {}) {
  const sinceMs = Date.now() - windowDays * 86400 * 1000;
  const { counts } = ws.readAccessLog({ sinceMs });
  const all = ws.listPages();
  const byId = new Map(all.map((p) => [p.id, p]));
  const ranked = [...counts.entries()]
    .map(([id, count]) => ({ id, count, page: byId.get(id) }))
    .filter((r) => r.page)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return ranked;
}

// One-line `<li>` for a page reference: id link + title + optional trailing
// muted suffix (relative time, hit count, etc.). No descriptions — those are
// reserved for pinned and individual page views to keep dashboards scannable.
function pageLi(page, suffix = "") {
  const pin = page.pinned ? `<span class="pinned-badge">pinned</span>` : "";
  const titleStr = page.title || page.id;
  const trail = suffix
    ? `<span class="desc">${escapeHtml(suffix)}</span>`
    : "";
  return `<li>${pin}<a class="id" href="/p/${encodeURIComponent(page.id)}">${escapeHtml(page.id)}</a><span class="title">${escapeHtml(titleStr)}</span>${trail}</li>`;
}

// Home dashboard: pinned + recently updated + hot last 7d + browse-by-type.
// Replaces the old "dump every page" index that was producing 200 KB of HTML
// for 742 rows — unscannable for both humans and LLMs. Full per-type
// listings still exist behind /?type=X.
function renderDashboard() {
  const stats = ws.stats();
  const summary = `<div class="meta"><span class="kv"><b>${stats.total}</b> pages</span><span class="kv"><b>${stats.pinned}</b> pinned</span><span class="kv"><b>${stats.links}</b> links</span><span class="kv"><b>${stats.dangling}</b> dangling</span></div>`;

  const pinned = ws
    .listPages({ pinned: true, status: "active" })
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  const pinnedLis = pinned.map((p) => {
    const titleStr = p.title || p.id;
    const desc = p.description
      ? `<div class="desc">${escapeHtml(p.description)}</div>`
      : "";
    return `<li><a class="id" href="/p/${encodeURIComponent(p.id)}">${escapeHtml(p.id)}</a><span class="title">${escapeHtml(titleStr)}</span>${desc}</li>`;
  });
  const pinnedSection = `<div class="section-title">Pinned (${pinned.length})</div>
<ul class="pages">${pinnedLis.join("")}</ul>`;

  const recent = ws.recentlyUpdated({ limit: 12 });
  const recentLis = recent.map((p) =>
    pageLi(p, relativeTime(p.updated_at)),
  );
  const recentSection = `<div class="section-title">Recently updated</div>
<ul class="pages">${recentLis.join("")}</ul>`;

  const hot = hotPages({ limit: 10, windowDays: 7 });
  const hotSection = hot.length
    ? `<div class="section-title">Hot pages — last 7 days</div>
<ul class="pages">${hot
        .map((h) =>
          pageLi(h.page, `${h.count} read${h.count === 1 ? "" : "s"}`),
        )
        .join("")}</ul>`
    : "";

  const order = ["user", "feedback", "project", "day", "week", "month", "reference"];
  const typeCounts = new Map(stats.byType.map((r) => [r.type, r.n]));
  const browseLinks = order
    .filter((t) => typeCounts.has(t))
    .map(
      (t) =>
        `<a class="type-chip" href="/?type=${encodeURIComponent(t)}">${escapeHtml(t)} <span class="dim">(${typeCounts.get(t)})</span></a>`,
    );
  // Catch any types we forgot to enumerate.
  for (const [t, n] of typeCounts) {
    if (!order.includes(t)) {
      browseLinks.push(
        `<a class="type-chip" href="/?type=${encodeURIComponent(t)}">${escapeHtml(t || "(untyped)")} <span class="dim">(${n})</span></a>`,
      );
    }
  }
  const browseSection = `<div class="section-title">Browse by type</div>
<div class="type-chips">${browseLinks.join("")}</div>`;

  return shell(
    "Wiki",
    `<h1>Wiki</h1>${summary}${pinnedSection}${recentSection}${hotSection}${browseSection}`,
  );
}

// Per-type listing page. Compact one-line entries (id + title), and for
// `reference` (>600 mostly-travel rows) an optional id-prefix sub-filter.
function renderTypeListing({ type, prefix }) {
  const pages = ws
    .listPages({ status: "active" })
    .filter((p) => p.type === type)
    .sort((a, b) => {
      if (!!b.pinned - !!a.pinned !== 0) return !!b.pinned - !!a.pinned;
      return a.id.localeCompare(b.id);
    });

  const heading = `Type: ${type}`;
  let prefixNav = "";
  let visible = pages;

  // Prefix sub-filter: surface the top id-prefixes when a single type is
  // dominated by a structured naming scheme (e.g. travel_city_*, travel_trip_*).
  // Only worth showing when there are enough pages to warrant it.
  if (pages.length > 50) {
    const prefixCounts = new Map();
    for (const p of pages) {
      const m = p.id.match(/^([a-z]+_[a-z]+)/);
      const key = m ? m[1] : "(other)";
      prefixCounts.set(key, (prefixCounts.get(key) || 0) + 1);
    }
    const ranked = [...prefixCounts.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length >= 2) {
      const chips = ranked.map(
        ([k, n]) =>
          `<a class="type-chip${k === prefix ? " active" : ""}" href="/?type=${encodeURIComponent(type)}&prefix=${encodeURIComponent(k)}">${escapeHtml(k)} <span class="dim">(${n})</span></a>`,
      );
      const allChip = `<a class="type-chip${!prefix ? " active" : ""}" href="/?type=${encodeURIComponent(type)}">all <span class="dim">(${pages.length})</span></a>`;
      prefixNav = `<div class="type-chips">${allChip}${chips.join("")}</div>`;
    }
    if (prefix) {
      visible = pages.filter((p) => p.id.startsWith(prefix + "_") || p.id === prefix);
    }
  }

  const lis = visible.map((p) => pageLi(p));
  const meta = `<div class="meta"><span class="kv"><b>${visible.length}</b> of ${pages.length} ${escapeHtml(type)} page${pages.length === 1 ? "" : "s"}${prefix ? ` matching <code>${escapeHtml(prefix)}</code>` : ""}</span></div>`;
  return shell(
    heading,
    `<h1>${escapeHtml(heading)}</h1>${meta}${prefixNav}<ul class="pages">${lis.join("")}</ul>`,
  );
}

// Pinned-only listing (linked from the nav). Full title + description per
// entry, since the curated subset is small (~10).
function renderPinnedListing() {
  const pinned = ws
    .listPages({ pinned: true, status: "active" })
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  const lis = pinned.map((p) => {
    const titleStr = p.title || p.id;
    const desc = p.description
      ? `<div class="desc">${escapeHtml(p.description)}</div>`
      : "";
    return `<li><a class="id" href="/p/${encodeURIComponent(p.id)}">${escapeHtml(p.id)}</a><span class="title">${escapeHtml(titleStr)}</span>${desc}</li>`;
  });
  const meta = `<div class="meta"><span class="kv"><b>${pinned.length}</b> pinned page${pinned.length === 1 ? "" : "s"}</span></div>`;
  return shell(
    "Pinned",
    `<h1>Pinned</h1>${meta}<ul class="pages">${lis.join("")}</ul>`,
  );
}

// Dispatcher kept under the old name so the request handler doesn't change.
function renderIndex({ type, pinnedOnly, prefix }) {
  if (pinnedOnly) return renderPinnedListing();
  if (type) return renderTypeListing({ type, prefix });
  return renderDashboard();
}

function renderPageView(id) {
  const page = ws.getPage(id);
  if (!page) return null;
  const fwd = ws.getForwardLinks(id);
  const back = ws.getBacklinks(id);
  const revs = ws.getRevisions(id);
  // Resolve wikilink targets on the fly so dangling ones get styled.
  const idsThatExist = new Set(ws.listPages().map((p) => p.id));
  const html = renderMarkdown(page.body_md, {
    resolveLink: (target) => idsThatExist.has(target),
  });
  const fm = JSON.parse(page.frontmatter_json || "{}");
  const metaParts = [];
  if (page.type) metaParts.push(`<span class="kv"><b>type</b> ${escapeHtml(page.type)}</span>`);
  if (page.status) metaParts.push(`<span class="kv"><b>status</b> ${escapeHtml(page.status)}</span>`);
  if (page.pinned) metaParts.push(`<span class="kv"><span class="pinned-badge">pinned</span></span>`);
  if (page.confidence) metaParts.push(`<span class="kv"><b>confidence</b> ${escapeHtml(page.confidence)}</span>`);
  if (page.last_verified_at) metaParts.push(`<span class="kv"><b>verified</b> ${escapeHtml(page.last_verified_at)}</span>`);
  if (revs.length) metaParts.push(`<span class="kv"><b>revs</b> ${revs.length}</span>`);
  const meta = `<div class="meta">${metaParts.join("")}</div>`;
  const description = page.description
    ? `<p class="dim">${escapeHtml(page.description)}</p>`
    : "";
  const fwdBox = fwd.length
    ? `<div class="links-box"><h3>Outgoing (${fwd.length})</h3><ul>${fwd
        .map((l) => {
          const dang = l.resolved ? "" : ` <small>(dangling)</small>`;
          const cls = l.resolved ? "wikilink" : "wikilink dangling";
          return `<li><a class="${cls}" href="/p/${encodeURIComponent(l.dst_id)}">${escapeHtml(l.dst_id)}</a> <small>${escapeHtml(l.link_type)}</small>${dang}</li>`;
        })
        .join("")}</ul></div>`
    : "";
  const backBox = back.length
    ? `<div class="links-box"><h3>Backlinks (${back.length})</h3><ul>${back
        .map(
          (l) =>
            `<li><a class="wikilink" href="/p/${encodeURIComponent(l.src_id)}">${escapeHtml(l.src_id)}</a> <small>${escapeHtml(l.link_type)}</small></li>`,
        )
        .join("")}</ul></div>`
    : "";
  const title = page.title || page.id;
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>${description}${meta}${html}${fwdBox}${backBox}`,
  );
}

function renderSearchResults(q) {
  const query = String(q || "").trim();
  if (!query) {
    return shell(
      "Search",
      `<h1>Search</h1><p class="dim">Enter a query in the search box above.</p>`,
    );
  }
  const hits = ws.searchPages(query, { mode: "fts", limit: 25 });
  const body = hits.length
    ? hits
        .map((h) => {
          const snippet = (h.body_md || "").slice(0, 240);
          return `<div class="search-hit"><a class="wikilink" href="/p/${encodeURIComponent(h.id)}">${escapeHtml(h.id)}</a> <span class="dim">${escapeHtml(h.title || "")}</span><div class="snippet">${escapeHtml(snippet)}…</div></div>`;
        })
        .join("")
    : `<p class="dim">No matches.</p>`;
  return shell(
    `Search: ${query}`,
    `<h1>Search: <code>${escapeHtml(query)}</code></h1><p class="dim">${hits.length} result${hits.length === 1 ? "" : "s"}</p>${body}`,
  );
}

// ── HTTP server ─────────────────────────────────────────────────────────

function serve({ port = 9096, host = "127.0.0.1" } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    const send = (status, body, contentType = "text/html; charset=utf-8") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    };
    try {
      if (u.pathname === "/style.css") {
        return send(200, CSS, "text/css; charset=utf-8");
      }
      if (u.pathname === "/favicon.png" || u.pathname === "/favicon.ico") {
        if (FAVICON_BYTES) {
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
          });
          return res.end(FAVICON_BYTES);
        }
        res.writeHead(404);
        return res.end();
      }
      if (u.pathname === "/search") {
        return send(200, renderSearchResults(u.searchParams.get("q")));
      }
      if (u.pathname === "/" || u.pathname === "") {
        return send(
          200,
          renderIndex({
            type: u.searchParams.get("type"),
            pinnedOnly: u.searchParams.get("pinned") === "1",
            prefix: u.searchParams.get("prefix") || undefined,
          }),
        );
      }
      const pageMatch = u.pathname.match(/^\/p\/(.+)$/);
      if (pageMatch) {
        const id = decodeURIComponent(pageMatch[1]).replace(/\.md$/, "");
        const html = renderPageView(id);
        if (!html) {
          return send(
            404,
            shell(
              "Not found",
              `<h1>Not found</h1><p>No page with id <code>${escapeHtml(id)}</code>.</p><p><a href="/">← back to index</a></p>`,
            ),
          );
        }
        return send(200, html);
      }
      send(
        404,
        shell("404", `<h1>404</h1><p>Not found: ${escapeHtml(u.pathname)}</p>`),
      );
    } catch (err) {
      send(
        500,
        shell(
          "500",
          `<h1>500</h1><pre>${escapeHtml(err.stack || err.message)}</pre>`,
        ),
      );
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = {
  serve,
  // exported for tests
  renderMarkdown,
  renderInline,
  escapeHtml,
};
