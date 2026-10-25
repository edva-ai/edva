// wiki-render.js — the wiki's HTML: Markdown renderer, page shell and CSS.
//
// Pure functions with NO Node dependencies, so the same code renders the wiki
// on the host (`wiki serve`, lib/wiki-serve.js) and in the Cloudflare
// Worker that serves the wiki site from the Supabase mirror
// (wiki-worker/). Change the look or the Markdown subset here, once.

"use strict";

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

function renderInline(text, { resolveLink, labelFor } = {}) {
  let s = escapeHtml(text);
  // The regex rules below capture substrings of the *already-escaped* `s`,
  // so the captured groups are themselves valid escaped HTML — DO NOT
  // re-run escapeHtml on them. Doing so produced `&amp;amp;` in wikilink
  // display text and broke URLs containing `&` in [text](url) / ![alt](url).
  // [[target|display]] or [[target]] — wikilinks
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => {
    const id = target.trim().replace(/\.md$/, "");
    // A bare [[id]] reads better as the page's title, when the caller knows it.
    const known = !display && labelFor ? labelFor(id) : null;
    const label = known ? escapeHtml(known) : (display || target).trim();
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
  // skipped: identifiers like `user_<name>` and `bin/memory_chunks`
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
      const tableLines = [`<div class="table"><table><thead><tr>`];
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
      tableLines.push(`</tbody></table></div>`);
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

// ── Design system ───────────────────────────────────────────────────────
//
// "Commonplace": Edva's memory read like a personal almanac. Ask-first
// (the search box is the front door, and it goes through the model), topic
// shelves for browsing, and a strip of remembered days as the one element only
// this subject has. Apple-native type on purpose — New York for titles, the kernel-guard-ok: "New York" is Apple's serif typeface
// system sans for reading — so nothing is fetched from a font host (the site
// is private, and the user reads it on Apple devices), with real fallbacks
// everywhere else. Cool porcelain and ink, one ultramarine accent.
const CSS = `
/* Layout: sticky bar · portal at 1120px (topics grid + right rail) · reading column 680px + rail */
:root {
  --paper: #f3f5f7;
  --surface: #ffffff;
  --sunk: #eaeef2;
  --ink: #17202a;
  --ink-2: #566472;
  --ink-3: #8592a0;
  --rule: #dce2e8;
  --accent: #2f45c9;
  --accent-ink: #ffffff;
  --accent-soft: #e8ecfb;
  --mark: #fff1b8;
  --danger: #b4232c;
  --cell: #dfe5ec;
  --cell-on: #2f45c9;
  --shadow: 0 1px 2px rgba(23, 32, 42, 0.05), 0 6px 24px rgba(23, 32, 42, 0.06);
  --f-display: "New York", ui-serif, "Iowan Old Style", Charter, Georgia, serif; /* kernel-guard-ok: Apple's serif typeface */
  --f-body: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --f-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --t-xs: 0.78rem; --t-sm: 0.875rem; --t-md: 1rem; --t-lg: 1.25rem; --t-xl: 1.6rem; --t-2xl: 2.15rem; --t-3xl: 2.75rem;
  --gutter: max(16px, env(safe-area-inset-left, 0px));
  --gutter-r: max(16px, env(safe-area-inset-right, 0px));
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0e1217; --surface: #151a21; --sunk: #1b222b; --ink: #e7ebf0; --ink-2: #a0acb9; --ink-3: #6f7c8a;
    --rule: #26303b; --accent: #8c9cff; --accent-ink: #0e1217; --accent-soft: #1c2342; --mark: #4a3f12;
    --danger: #ff8a8f; --cell: #222b36; --cell-on: #8c9cff; --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 28px rgba(0,0,0,0.25);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #0e1217; --surface: #151a21; --sunk: #1b222b; --ink: #e7ebf0; --ink-2: #a0acb9; --ink-3: #6f7c8a;
  --rule: #26303b; --accent: #8c9cff; --accent-ink: #0e1217; --accent-soft: #1c2342; --mark: #4a3f12;
  --danger: #ff8a8f; --cell: #222b36; --cell-on: #8c9cff; --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 28px rgba(0,0,0,0.25);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 400 1.0625rem/1.6 var(--f-body);
  -webkit-font-smoothing: antialiased;
}
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--surface); }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 0.18em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
h1, h2, h3, h4 { text-wrap: balance; line-height: 1.2; }
.wrap { max-width: 1120px; margin: 0 auto; padding-left: var(--gutter); padding-right: var(--gutter-r); }
.wrap.narrow { max-width: 1040px; }

/* ── Top bar ── */
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: saturate(1.4) blur(12px); -webkit-backdrop-filter: saturate(1.4) blur(12px); border-bottom: 1px solid var(--rule); }
.bar .wrap { display: flex; align-items: center; gap: 18px; padding-block: 10px; }
.brand { display: flex; align-items: baseline; gap: 8px; color: var(--ink); text-decoration: none; white-space: nowrap; }
.brand b { font: 600 1.2rem/1 var(--f-display); letter-spacing: -0.01em; }
.brand span { font-size: var(--t-xs); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); }
.bar nav { display: flex; gap: 4px; }
.bar nav a { color: var(--ink-2); text-decoration: none; font-size: var(--t-sm); padding: 6px 10px; border-radius: 999px; }
.bar nav a:hover { color: var(--ink); background: var(--sunk); }
.bar nav a[aria-current="page"] { color: var(--ink); background: var(--sunk); font-weight: 600; }
.bar form { margin-left: auto; flex: 0 1 300px; min-width: 0; }
.bar input[type=search] { width: 100%; font: inherit; font-size: var(--t-sm); padding: 7px 12px; border: 1px solid var(--rule); border-radius: 999px; background: var(--paper); color: var(--ink); }
.bar input[type=search]::placeholder { color: var(--ink-3); }
.who { font-size: var(--t-xs); color: var(--ink-3); white-space: nowrap; }
.who a { color: var(--ink-2); }

main { padding-block: 28px 80px; }
.eyebrow { font-size: var(--t-xs); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; margin: 0 0 10px; }
.crumbs { font-size: var(--t-sm); color: var(--ink-3); margin: 0 0 14px; display: flex; flex-wrap: wrap; gap: 6px; }
.crumbs a { color: var(--ink-2); text-decoration: none; }
.crumbs a:hover { color: var(--accent); }
.mono, .id { font-family: var(--f-mono); font-size: 0.82em; }
.num { font-variant-numeric: tabular-nums; }
.dim { color: var(--ink-2); }

/* ── Ask (the front door) ── */
.ask { padding-block: 34px 26px; }
.ask h1 { font: 500 var(--t-3xl)/1.05 var(--f-display); letter-spacing: -0.02em; margin: 0 0 8px; }
.ask p.lede { color: var(--ink-2); margin: 0 0 22px; max-width: 60ch; }
.askbox { display: flex; gap: 8px; align-items: center; background: var(--surface); border: 1px solid var(--rule); border-radius: 16px; padding: 8px 8px 8px 18px; box-shadow: var(--shadow); max-width: 780px; }
.askbox:focus-within { border-color: var(--accent); }
.askbox input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 400 1.15rem/1.4 var(--f-body); padding: 8px 0; }
.askbox input::placeholder { color: var(--ink-3); }
.askbox button { border: 0; border-radius: 11px; background: var(--accent); color: var(--accent-ink); font: 600 var(--t-sm)/1 var(--f-body); padding: 12px 18px; cursor: pointer; }
.askbox button:hover { filter: brightness(1.08); }
.askmeta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; font-size: var(--t-sm); color: var(--ink-3); }
.askmeta b { color: var(--ink-2); font-weight: 600; }

/* ── Portal grid ── */
.portal { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; align-items: start; }
.section-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 36px 0 14px; }
.section-h h2 { font: 500 var(--t-xl)/1.2 var(--f-display); margin: 0; letter-spacing: -0.01em; }
.section-h a { font-size: var(--t-sm); text-decoration: none; }
.topics { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; align-items: start; }
.topic { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.topic:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--rule)); }
.topic header { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.topic h3 { font: 500 var(--t-lg)/1.2 var(--f-display); margin: 0; }
.topic h3 a { color: var(--ink); text-decoration: none; }
.topic h3 a:hover { color: var(--accent); }
.count { font: 500 var(--t-xs)/1 var(--f-mono); color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.topic p { margin: 0; font-size: var(--t-sm); color: var(--ink-2); line-height: 1.5; }
.topic ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.topic li a { display: block; padding: 4px 0; font-size: var(--t-sm); color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topic li a:hover { color: var(--accent); }
.topic .more { margin-top: auto; padding-top: 6px; font-size: var(--t-sm); text-decoration: none; }

/* ── Rail ── */
.rail { display: grid; gap: 22px; position: sticky; top: calc(env(safe-area-inset-top, 0px) + 72px); }
.rail section { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: 16px 16px 10px; min-width: 0; }
.rail h2 { font: 600 var(--t-xs)/1 var(--f-body); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 10px; }
.rail ul { list-style: none; margin: 0; padding: 0; }
.rail li { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid var(--rule); font-size: var(--t-sm); min-width: 0; }
.rail li:first-child { border-top: 0; }
.rail li a { color: var(--ink); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail li a:hover { color: var(--accent); }
.rail li .when { color: var(--ink-3); font-size: var(--t-xs); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rail .note { font-size: var(--t-xs); color: var(--ink-3); margin: 8px 0 4px; }

/* ── Remembered days strip ── */
.days { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: 16px 18px; overflow-x: auto; }
.month-row { display: grid; grid-template-columns: 76px minmax(0, 1fr) 44px; align-items: center; gap: 12px; padding: 5px 0; }
.month-row .m { font: 500 var(--t-sm)/1 var(--f-display); color: var(--ink-2); white-space: nowrap; }
.month-row .m a { color: inherit; text-decoration: none; }
.month-row .m a:hover { color: var(--accent); }
.cells { display: grid; grid-template-columns: repeat(31, minmax(0, 1fr)); gap: 3px; min-width: 0; }
.cells i, .cells a { display: block; height: 14px; border-radius: 3px; background: var(--cell); }
.cells a { background: var(--cell-on); opacity: 0.85; }
.cells a:hover { opacity: 1; outline: 2px solid var(--ink); outline-offset: 1px; }
.cells i.pad { background: transparent; }
.month-row .n { font: 500 var(--t-xs)/1 var(--f-mono); color: var(--ink-3); text-align: right; font-variant-numeric: tabular-nums; }
.latest { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 14px; }
.latest a { display: block; padding: 12px 14px; border: 1px solid var(--rule); border-radius: var(--radius); background: var(--surface); text-decoration: none; color: var(--ink); min-width: 0; }
.latest a:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--rule)); }
.latest .d { font: 500 var(--t-xs)/1 var(--f-mono); color: var(--ink-3); }
.latest .t { display: block; font: 500 var(--t-md)/1.3 var(--f-display); margin-top: 6px; }
.latest .s { display: block; font-size: var(--t-sm); color: var(--ink-2); margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

/* ── Lists (topic pages, search) ── */
.page-head h1 { font: 500 var(--t-2xl)/1.12 var(--f-display); letter-spacing: -0.015em; margin: 0 0 8px; }
.page-head .dek { font-size: 1.1rem; color: var(--ink-2); margin: 0 0 16px; max-width: 62ch; }
.rows { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); }
.rows li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; padding: 12px 16px; border-top: 1px solid var(--rule); }
.rows li:first-child { border-top: 0; }
.rows .t { font-weight: 600; color: var(--ink); text-decoration: none; min-width: 0; }
.rows .t:hover { color: var(--accent); }
.rows .s { grid-column: 1 / -1; font-size: var(--t-sm); color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.rows .s mark { background: var(--mark); color: inherit; border-radius: 2px; padding: 0 1px; }
.rows .r { font-size: var(--t-xs); color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chip { display: inline-block; font: 500 var(--t-xs)/1 var(--f-body); color: var(--ink-2); background: var(--sunk); border-radius: 999px; padding: 4px 8px; white-space: nowrap; text-decoration: none; }
a.chip:hover { color: var(--accent); }
.chip.pin { color: var(--accent); background: var(--accent-soft); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
.groups { display: grid; gap: 26px; }
.group h2 { font: 600 var(--t-xs)/1 var(--f-body); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 10px; display: flex; justify-content: space-between; }
.featured { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; margin: 6px 0 30px; }
.featured a { display: block; padding: 14px 16px; background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); text-decoration: none; color: var(--ink); min-width: 0; }
.featured a:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--rule)); }
.featured .t { display: block; font: 500 var(--t-md)/1.3 var(--f-display); }
.featured .s { display: block; font-size: var(--t-sm); color: var(--ink-2); margin-top: 4px; }

/* ── The answer (search) ── */
.answer { background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; padding: 18px 20px; margin: 0 0 26px; box-shadow: var(--shadow); }
.answer .who-says { display: flex; align-items: center; gap: 8px; font-size: var(--t-xs); letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin: 0 0 10px; }
.answer .who-says::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.answer .text { font: 400 1.15rem/1.6 var(--f-display); margin: 0; max-width: 68ch; }
.answer .text a.cite { font: 600 0.7rem/1 var(--f-mono); vertical-align: super; text-decoration: none; background: var(--accent-soft); color: var(--accent); border-radius: 4px; padding: 2px 4px; margin-left: 2px; }
.answer .sources { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.answer.pending .text { color: var(--ink-3); }
.answer.pending .who-says::before { animation: pulse 1.2s ease-in-out infinite; }
.answer.quiet { box-shadow: none; background: transparent; border-style: dashed; }
@keyframes pulse { 50% { opacity: 0.25; } }
.notice { font-size: var(--t-sm); color: var(--ink-2); background: var(--sunk); border-radius: var(--radius); padding: 10px 14px; margin: 0 0 18px; }
.how { font: 500 var(--t-xs)/1 var(--f-mono); color: var(--ink-3); }

/* ── Reading view ── */
.reading { display: grid; grid-template-columns: minmax(0, 680px) 280px; gap: 48px; justify-content: space-between; align-items: start; }
.reading .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 28px; }
.prose { min-width: 0; }
.prose > :first-child { margin-top: 0; }
.prose h1 { font: 500 var(--t-xl)/1.2 var(--f-display); margin: 36px 0 12px; }
.prose h2 { font: 500 var(--t-xl)/1.2 var(--f-display); margin: 36px 0 12px; letter-spacing: -0.01em; }
.prose h3 { font: 600 var(--t-lg)/1.3 var(--f-body); margin: 28px 0 8px; }
.prose h4 { font: 600 var(--t-md)/1.3 var(--f-body); margin: 22px 0 6px; }
.prose p, .prose li { max-width: 68ch; }
.prose ul, .prose ol { padding-left: 1.3em; }
.prose li { margin: 3px 0; }
.prose a.wikilink { color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); }
.prose a.wikilink:hover { border-bottom-color: var(--accent); }
.prose a.wikilink.dangling, a.wikilink.dangling { color: var(--danger); border-bottom: 1px dashed var(--danger); }
.prose code { font-family: var(--f-mono); font-size: 0.85em; background: var(--sunk); padding: 1px 5px; border-radius: 4px; }
.prose pre { background: var(--sunk); padding: 14px 16px; border-radius: var(--radius); overflow-x: auto; font-size: 0.85rem; }
.prose pre code { background: none; padding: 0; }
.prose hr { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
.prose blockquote { margin: 0; padding-left: 16px; border-left: 2px solid var(--rule); color: var(--ink-2); }
.prose img { max-width: 100%; height: auto; border-radius: 8px; }
.prose p > img:only-child { display: block; margin: 14px 0; }
.prose p:has(> img + img) { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; max-width: none; }
.prose p:has(> img + img) img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; margin: 0; }
.prose .table { overflow-x: auto; margin: 16px 0; }
.prose table { border-collapse: collapse; font-size: var(--t-sm); min-width: 100%; }
.prose th, .prose td { padding: 8px 12px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
.prose th { font-weight: 600; color: var(--ink-2); background: var(--sunk); }
.side { display: grid; gap: 18px; position: sticky; top: calc(env(safe-area-inset-top, 0px) + 72px); }
.side section { min-width: 0; }
.side h2 { font: 600 var(--t-xs)/1 var(--f-body); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-3); margin: 0 0 8px; display: flex; justify-content: space-between; }
.side ul { list-style: none; margin: 0; padding: 0; }
.side li { padding: 5px 0; border-top: 1px solid var(--rule); font-size: var(--t-sm); min-width: 0; }
.side li:first-child { border-top: 0; }
.side li a { color: var(--ink); text-decoration: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side li a:hover { color: var(--accent); }
.side li a.dangling { color: var(--danger); }
.side .via { font-size: var(--t-xs); color: var(--ink-3); }
.side details summary { cursor: pointer; font-size: var(--t-sm); color: var(--accent); padding: 6px 0; }
.empty { color: var(--ink-3); font-size: var(--t-sm); }
.ascii-404 h1 { font: 500 var(--t-2xl)/1.1 var(--f-display); }

@media (max-width: 960px) {
  .portal, .reading { grid-template-columns: minmax(0, 1fr); gap: 28px; }
  .rail, .side { position: static; }
}
@media (max-width: 640px) {
  body { font-size: 1rem; }
  .bar .wrap { flex-wrap: wrap; gap: 8px 12px; }
  .bar nav { order: 2; overflow-x: auto; max-width: 100%; }
  .bar form { order: 3; flex: 1 1 100%; margin-left: 0; }
  .bar input[type=search] { font-size: 16px; }
  .who { margin-left: auto; }
  .ask { padding-block: 18px 14px; }
  .ask h1 { font-size: var(--t-2xl); }
  .askbox { padding-left: 14px; border-radius: 14px; }
  .askbox input { font-size: 1.05rem; }
  .askbox button { padding: 11px 14px; }
  .page-head h1 { font-size: var(--t-xl); }
  .month-row { grid-template-columns: 52px minmax(0, 1fr) 30px; gap: 8px; }
  .cells { gap: 1px; }
  .cells i, .cells a { height: 12px; border-radius: 2px; }
  .days { padding: 12px; }
  .rows li { padding: 11px 13px; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

// `identity` = { label, scoped } for the signed-in viewer, or null on the
// localhost instance, which has no session to end — a "sign out" there would
// be a dead link. `opts.active` marks the current nav item; `opts.q` refills the
// search box; `opts.script` is inline JS appended at the end of the body.
function shell(title, body, identity = null, opts = {}) {
  const { active = null, q = "", script = "" } = opts || {};
  const nav = [
    ["home", "/", "Home"],
    ["timeline", "/timeline", "Timeline"],
    ["pinned", "/?pinned=1", "Pinned"],
  ]
    .map(([k, href, label]) => `<a href="${href}"${active === k ? ' aria-current="page"' : ""}>${label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · Edva Memory</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="bar"><div class="wrap">
  <a class="brand" href="/"><b>Edva</b><span>Memory</span></a>
  <nav aria-label="Sections">${nav}</nav>
  <form method="get" action="/search" role="search"><input type="search" id="bar-q" name="q" value="${escapeHtml(q)}" placeholder="Ask your memory…" autocomplete="off" aria-label="Ask your memory"></form>
  ${identity ? `<span class="who">${escapeHtml(identity.label)}${identity.scoped ? " · shared view" : ""} · <a href="/logout">Sign out</a></span>` : ""}
</div></header>
<main><div class="wrap">
${body}
</div></main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

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

module.exports = { escapeHtml, renderInline, renderMarkdown, CSS, shell, relativeTime };
