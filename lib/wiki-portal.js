// wiki-portal.js — the wiki's home portal, topic pages, timeline, reading view
// and search page, as pure HTML builders.
//
// Same contract as wiki-render.js: NO Node dependencies, so the host's
// `wiki serve` (lib/wiki-serve.js) and the Cloudflare Worker behind
// the wiki site (wiki-worker/) render identical pages from their own
// data (the live DB vs the Supabase mirror). Callers pass page rows of the
// shape { id, type, title, description, status, pinned, updated_at }.
//
// Topics come from data/wiki-portal.json, which a model curates
// (bin/wiki-portal build) — deciding what a page is ABOUT is language
// (Rule #0b), so code never guesses a topic from a title. Code only applies the
// curated membership (explicit ids and id prefixes, which are machine
// structure) and the scope filter. With no curated file, topics fall back to
// page types.
//
// Scope: every builder receives rows ALREADY filtered to what the viewer may
// read. Topic blurbs are written for the owner and can mention things outside a
// shared scope, so they are shown only in the full view.

"use strict";

const { escapeHtml, relativeTime } = require("./wiki-render.js");

const EPISODIC = new Set(["day", "week", "month"]);
const TYPE_LABEL = {
  user: "About us",
  feedback: "Rules & preferences",
  project: "Projects",
  reference: "Reference",
  day: "Days",
  week: "Weeks",
  month: "Months",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const esc = escapeHtml;
const href = (id) => `/p/${encodeURIComponent(id)}`;
const titleOf = (p) => (p && (p.title || p.id)) || "";
// Supabase returns "YYYY-MM-DD HH:MM:SS" (no zone, UTC); SQLite the same.
const isoOf = (t) => {
  const s = String(t || "");
  if (!s) return "";
  return s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
};
const byTitle = (a, b) => titleOf(a).localeCompare(titleOf(b));
const byRecent = (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""));

// The structural prefix of an id — its first two `_` segments
// (<family>_<kind>_<name> → <family>_<kind>). Machine-made ids, so this is geometry.
function idPrefix(id) {
  const parts = String(id || "").split("_");
  return parts.length >= 3 ? `${parts[0]}_${parts[1]}` : parts[0];
}

// ── Topics ──────────────────────────────────────────────────────────────────

function structuralTopics(pages) {
  const order = ["user", "project", "feedback", "reference"];
  const types = [...new Set(pages.filter((p) => !EPISODIC.has(p.type)).map((p) => p.type || "other"))]
    .sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0)));
  return types.map((t) => ({ slug: t, name: TYPE_LABEL[t] || t, blurb: "", types: [t], ids: [], prefixes: [], featured: [] }));
}

// A curated config is usable when it has at least one well-formed topic.
function usableConfig(config) {
  return !!(config && Array.isArray(config.topics) && config.topics.some((t) => t && t.slug && t.name));
}

/**
 * Resolve topics against the visible pages.
 *   pages     visible, active rows
 *   config    the curated portal ({ topics: [{ slug, name, blurb, ids, prefixes, featured }] }) or null
 *   fullView  the owner's view (shows blurbs)
 * Returns { topics: [{ slug, name, blurb, pages, featured }], curated, ofPage(id) → topic|null }.
 * Non-episodic pages no topic claims land in "Everything else", so nothing
 * visible is unreachable from the portal.
 */
function resolvePortal({ pages, config = null, fullView = false }) {
  const curated = usableConfig(config);
  const defs = curated ? config.topics.filter((t) => t && t.slug && t.name) : structuralTopics(pages);
  const shelf = pages.filter((p) => !EPISODIC.has(p.type));
  const claimed = new Set();
  const topics = [];
  for (const def of defs) {
    const ids = new Set(def.ids || []);
    const prefixes = (def.prefixes || []).filter((x) => typeof x === "string" && x.length >= 3);
    const types = new Set(def.types || []);
    const members = shelf.filter(
      (p) => ids.has(p.id) || prefixes.some((x) => p.id.startsWith(x)) || types.has(p.type),
    );
    if (!members.length) continue; // a topic with nothing visible does not exist for this viewer
    for (const p of members) claimed.add(p.id);
    const byId = new Map(members.map((p) => [p.id, p]));
    let featured = (def.featured || []).map((id) => byId.get(id)).filter(Boolean);
    if (featured.length < 4) {
      const extra = [...members].sort((a, b) => (!!b.pinned - !!a.pinned) || byRecent(a, b));
      for (const p of extra) {
        if (featured.length >= 5) break;
        if (!featured.includes(p)) featured.push(p);
      }
    }
    topics.push({
      slug: String(def.slug),
      name: String(def.name),
      blurb: fullView ? String(def.blurb || "") : "",
      pages: members.sort(byTitle),
      featured: featured.slice(0, 5),
    });
  }
  const rest = shelf.filter((p) => !claimed.has(p.id));
  if (rest.length) {
    topics.push({
      slug: "everything-else",
      name: "Everything else",
      blurb: fullView ? "Pages not filed under a topic yet." : "",
      pages: rest.sort(byTitle),
      featured: [...rest].sort(byRecent).slice(0, 5),
    });
  }
  const owner = new Map();
  for (const t of topics) for (const p of t.pages) if (!owner.has(p.id)) owner.set(p.id, t);
  return { topics, curated, ofPage: (id) => owner.get(id) || null };
}

// ── Timeline (day pages by month) ───────────────────────────────────────────

/** Months that have day pages, newest first: [{ ym, label, year, month, days: Map(dayNum → page), monthPage }] */
function timelineMonths(pages) {
  const months = new Map();
  const monthPages = new Map();
  for (const p of pages) {
    const id = String(p.id);
    if (id.startsWith("day_") && id.length === 14) {
      const ym = id.slice(4, 11);
      const day = Number(id.slice(12, 14));
      if (!months.has(ym)) months.set(ym, new Map());
      months.get(ym).set(day, p);
    } else if (id.startsWith("month_") && id.length === 13) {
      monthPages.set(id.slice(6), p);
    }
  }
  return [...months.keys()]
    .sort()
    .reverse()
    .map((ym) => {
      const year = Number(ym.slice(0, 4));
      const month = Number(ym.slice(5, 7));
      return { ym, year, month, label: `${MONTHS[month - 1]} ${year}`, days: months.get(ym), monthPage: monthPages.get(ym) || null };
    });
}

function monthRow(m) {
  const len = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
  const cells = [];
  for (let d = 1; d <= 31; d++) {
    const p = m.days.get(d);
    if (d > len) cells.push(`<i class="pad"></i>`);
    else if (p) {
      const label = `${MONTHS[m.month - 1]} ${d}: ${titleOf(p)}`;
      cells.push(`<a href="${href(p.id)}" title="${esc(label)}" aria-label="${esc(label)}"></a>`);
    } else cells.push(`<i title="${MONTHS[m.month - 1]} ${d}"></i>`);
  }
  const name = m.monthPage ? `<a href="${href(m.monthPage.id)}">${esc(m.label)}</a>` : esc(m.label);
  return `<div class="month-row"><span class="m">${name}</span><span class="cells">${cells.join("")}</span><span class="n">${m.days.size}</span></div>`;
}

function dayLabel(id) {
  const ymd = String(id).slice(4);
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${MONTHS[m - 1]} ${d}, ${y}`;
}

// ── Shared fragments ────────────────────────────────────────────────────────

function rowLi(p, { right = null, snippetHtml = null } = {}) {
  const r = right != null ? right : [TYPE_LABEL[p.type] || p.type || "", p.updated_at ? relativeTime(isoOf(p.updated_at)) : ""].filter(Boolean).join(" · ");
  const s = snippetHtml != null ? snippetHtml : p.description ? esc(p.description) : "";
  return `<li><a class="t" href="${href(p.id)}">${esc(titleOf(p))}</a><span class="r">${esc(r)}</span>${s ? `<span class="s">${s}</span>` : ""}</li>`;
}

function railList(title, pages, whenOf) {
  if (!pages.length) return "";
  return `<section><h2>${esc(title)}</h2><ul>${pages
    .map((p) => `<li><a href="${href(p.id)}" title="${esc(titleOf(p))}">${esc(titleOf(p))}</a>${whenOf ? `<span class="when">${esc(whenOf(p))}</span>` : ""}</li>`)
    .join("")}</ul></section>`;
}

function askBox({ q = "", big = true } = {}) {
  return `<form class="askbox" method="get" action="/search" role="search">
<input type="search" id="ask-q" name="q" value="${esc(q)}" placeholder="Ask anything you have told Edva…" autocomplete="off" aria-label="Ask your memory"${big ? " autofocus" : ""}>
<button type="submit">Ask</button></form>`;
}

// ── Home ────────────────────────────────────────────────────────────────────

/**
 * pages: visible active rows · portal: resolvePortal() · fullView · note: optional
 * line under the ask box (e.g. the cloud copy's sync lag).
 */
function homeBody({ pages, portal, fullView = false, note = "" }) {
  const days = pages.filter((p) => p.type === "day");
  const months = timelineMonths(pages);
  const shelf = pages.filter((p) => !EPISODIC.has(p.type));
  const newest = [...pages].sort(byRecent)[0];
  const meta = [
    `<span><b class="num">${shelf.length.toLocaleString("en-US")}</b> pages</span>`,
    days.length ? `<span><b class="num">${days.length.toLocaleString("en-US")}</b> days remembered</span>` : "",
    portal.topics.length ? `<span><b class="num">${portal.topics.length}</b> topics</span>` : "",
    newest && newest.updated_at ? `<span>last changed ${esc(relativeTime(isoOf(newest.updated_at)))}</span>` : "",
    note ? `<span>${esc(note)}</span>` : "",
  ].filter(Boolean).join("");

  const ask = `<section class="ask">
<p class="eyebrow">Edva's memory</p>
<h1>What would you like to remember?</h1>
<p class="lede">Ask in your own words. Edva searches everything it knows, follows the connections between pages, and answers with its sources.</p>
${askBox({})}
<div class="askmeta">${meta}</div>
</section>`;

  const topicCards = portal.topics
    .map((t) => {
      const items = t.featured.map((p) => `<li><a href="${href(p.id)}" title="${esc(titleOf(p))}">${esc(titleOf(p))}</a></li>`).join("");
      return `<article class="topic">
<header><h3><a href="/t/${encodeURIComponent(t.slug)}">${esc(t.name)}</a></h3><span class="count">${t.pages.length}</span></header>
${t.blurb ? `<p>${esc(t.blurb)}</p>` : ""}
<ul>${items}</ul>
<a class="more" href="/t/${encodeURIComponent(t.slug)}">All ${t.pages.length} →</a>
</article>`;
    })
    .join("");

  const recentMonths = months.slice(0, 6);
  const latestDays = [...days].sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, 3);
  const timeline = months.length
    ? `<div class="section-h"><h2>Days remembered</h2><a href="/timeline">Every month →</a></div>
<div class="days" role="group" aria-label="Days with a memory page, by month">${recentMonths.map(monthRow).join("")}</div>
<div class="latest">${latestDays
        .map((p) => `<a href="${href(p.id)}"><span class="d">${esc(dayLabel(p.id))}</span><span class="t">${esc(titleOf(p))}</span>${p.description ? `<span class="s">${esc(p.description)}</span>` : ""}</a>`)
        .join("")}</div>`
    : "";

  const pinned = shelf.filter((p) => p.pinned).sort(byTitle).slice(0, 12);
  const recent = [...shelf].sort(byRecent).slice(0, 10);
  const rail = `<aside class="rail">
${railList("Always in mind", pinned)}
${railList("Recently changed", recent, (p) => relativeTime(isoOf(p.updated_at)))}
</aside>`;

  return `${ask}
<div class="portal">
<div>
<div class="section-h"><h2>Topics</h2>${portal.curated ? "" : `<span class="how">grouped by page type</span>`}</div>
<div class="topics">${topicCards || `<p class="empty">Nothing here yet.</p>`}</div>
${timeline}
</div>
${rail}
</div>`;
}

// ── Topic page ──────────────────────────────────────────────────────────────

function topicBody({ topic }) {
  const featured = topic.featured.length
    ? `<p class="eyebrow">Start here</p><div class="featured">${topic.featured
        .map((p) => `<a href="${href(p.id)}"><span class="t">${esc(titleOf(p))}</span>${p.description ? `<span class="s">${esc(p.description)}</span>` : ""}</a>`)
        .join("")}</div>`
    : "";
  // Group by type; a large group is split by id prefix (machine structure:
  // <family>_<kind>_*) so a 400-page shelf is navigable.
  const byType = new Map();
  for (const p of topic.pages) {
    const k = p.type || "other";
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(p);
  }
  const groups = [];
  for (const [type, list] of byType) {
    if (list.length > 40) {
      const byPrefix = new Map();
      for (const p of list) {
        const k = idPrefix(p.id);
        if (!byPrefix.has(k)) byPrefix.set(k, []);
        byPrefix.get(k).push(p);
      }
      const big = [...byPrefix].filter(([, l]) => l.length >= 4).sort((a, b) => b[1].length - a[1].length);
      const small = [...byPrefix].filter(([, l]) => l.length < 4).flatMap(([, l]) => l);
      for (const [k, l] of big) groups.push({ label: `${TYPE_LABEL[type] || type} · ${k.replace(/_/g, " ")}`, list: l }); // lang-regex-ok: id prefix to a label
      if (small.length) groups.push({ label: `${TYPE_LABEL[type] || type} · other`, list: small });
    } else {
      groups.push({ label: TYPE_LABEL[type] || type, list });
    }
  }
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>›</span><span>${esc(topic.name)}</span></nav>
<div class="page-head"><h1>${esc(topic.name)}</h1>${topic.blurb ? `<p class="dek">${esc(topic.blurb)}</p>` : ""}</div>
<div class="chips"><span class="chip num">${topic.pages.length} pages</span></div>
${featured}
<div class="groups">${groups
    .map((g) => `<section class="group"><h2><span>${esc(g.label)}</span><span class="num">${g.list.length}</span></h2><ul class="rows">${g.list.map((p) => rowLi(p)).join("")}</ul></section>`)
    .join("")}</div>`;
}

// ── Timeline page ───────────────────────────────────────────────────────────

function timelineBody({ pages }) {
  const months = timelineMonths(pages);
  const years = new Map();
  for (const m of months) {
    if (!years.has(m.year)) years.set(m.year, []);
    years.get(m.year).push(m);
  }
  const total = months.reduce((n, m) => n + m.days.size, 0);
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>›</span><span>Timeline</span></nav>
<div class="page-head"><h1>Timeline</h1><p class="dek">Every day Edva wrote down, by month. Each filled square is a day with its own page.</p></div>
<div class="chips"><span class="chip num">${total} days</span><span class="chip num">${months.length} months</span></div>
<div class="groups">${[...years]
    .map(([y, ms]) => `<section class="group"><h2><span>${y}</span><span class="num">${ms.reduce((n, m) => n + m.days.size, 0)} days</span></h2><div class="days">${ms.map(monthRow).join("")}</div></section>`)
    .join("") || `<p class="empty">No day pages yet.</p>`}</div>`;
}

// ── Plain listing (pinned, a page type) ─────────────────────────────────────

function listingBody({ title, dek = "", pages, crumb = null }) {
  return `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>›</span><span>${esc(crumb || title)}</span></nav>
<div class="page-head"><h1>${esc(title)}</h1>${dek ? `<p class="dek">${esc(dek)}</p>` : ""}</div>
<div class="chips"><span class="chip num">${pages.length} pages</span></div>
${pages.length ? `<ul class="rows">${pages.map((p) => rowLi(p)).join("")}</ul>` : `<p class="empty">Nothing here.</p>`}`;
}

// ── Reading view ────────────────────────────────────────────────────────────

/**
 * page: the full row · bodyHtml: rendered Markdown · fwd/back: [{ id, type? }]
 * already scope-filtered · titles: Map(id → title) for link labels · topic:
 * the topic it is filed under (or null) · revCount · connected: true when this
 * origin can answer /api/related (the host; the worker proxies it).
 */
function pageBody({ page, bodyHtml, fwd = [], back = [], titles = new Map(), topic = null, revCount = 0, connected = true }) {
  const label = (id) => titles.get(id) || id;
  const chips = [];
  if (page.type) chips.push(`<span class="chip">${esc(TYPE_LABEL[page.type] || page.type)}</span>`);
  if (page.pinned) chips.push(`<span class="chip pin">Always in mind</span>`);
  if (page.status && page.status !== "active") chips.push(`<span class="chip">${esc(page.status)}</span>`);
  if (page.updated_at) chips.push(`<span class="chip">Updated ${esc(relativeTime(isoOf(page.updated_at)))}</span>`);
  if (page.last_verified_at) chips.push(`<span class="chip">Verified ${esc(page.last_verified_at)}</span>`);
  if (revCount) chips.push(`<span class="chip num">${revCount} revision${revCount === 1 ? "" : "s"}</span>`);
  if (page.confidence) chips.push(`<span class="chip">${esc(page.confidence)}</span>`);

  const linkList = (title, links, key) => {
    if (!links.length) return "";
    const uniq = [...new Map(links.map((l) => [l[key], l])).values()];
    const shown = uniq.slice(0, 12);
    const rest = uniq.slice(12);
    const li = (l) => `<li><a class="${l.resolved === false ? "dangling" : ""}" href="${href(l[key])}" title="${esc(label(l[key]))}">${esc(label(l[key]))}</a></li>`;
    return `<section><h2><span>${esc(title)}</span><span class="num">${uniq.length}</span></h2><ul>${shown.map(li).join("")}</ul>${
      rest.length ? `<details><summary>${rest.length} more</summary><ul>${rest.map(li).join("")}</ul></details>` : ""
    }</section>`;
  };

  const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${
    topic ? `<span>›</span><a href="/t/${encodeURIComponent(topic.slug)}">${esc(topic.name)}</a>` : page.type === "day" ? `<span>›</span><a href="/timeline">Timeline</a>` : ""
  }</nav>`;
  const related = connected
    ? `<section id="related" data-id="${esc(page.id)}" hidden><h2><span>Connected in memory</span></h2><ul></ul></section>`
    : "";
  return `${crumbs}
<div class="reading">
<article>
<div class="page-head"><h1>${esc(titleOf(page))}</h1>${page.description ? `<p class="dek">${esc(page.description)}</p>` : ""}</div>
<div class="meta">${chips.join("")}</div>
<div class="prose">${bodyHtml}</div>
</article>
<aside class="side">
${related}
${linkList("Links to", fwd, "dst_id")}
${linkList("Linked from", back, "src_id")}
</aside>
</div>`;
}

// Loads "Connected in memory" (association over the graph) after the page is
// shown. Quietly absent when the origin cannot answer.
const RELATED_SCRIPT = `(function(){var s=document.getElementById("related");if(!s)return;fetch("/api/related?id="+encodeURIComponent(s.dataset.id),{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j||!j.html)return;s.querySelector("ul").innerHTML=j.html;s.hidden=false}).catch(function(){})})();`;

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * query · results: [{ id, title, type, description, snippetHtml?, how? }] ·
 * connected: [{ id, title, via }] · answer: true when this origin can run the
 * model step (the panel then loads /api/ask) · offline: the cloud fallback's
 * notice text, when memory retrieval was unreachable.
 */
function searchBody({ query, results = [], connected = [], answer = true, offline = "" }) {
  const q = String(query || "").trim();
  if (!q) {
    return `<div class="page-head"><p class="eyebrow">Ask</p><h1>What would you like to remember?</h1></div>${askBox({})}`;
  }
  const panel = answer
    ? `<section class="answer pending" id="answer" data-q="${esc(q)}" aria-live="polite"><p class="who-says">Edva</p><div class="body"><p class="text">Reading ${Math.min(results.length, 12) || "the"} pages memory found…</p></div></section>`
    : "";
  const rows = results.length
    ? `<ul class="rows">${results
        .map((r) =>
          rowLi(r, {
            right: [TYPE_LABEL[r.type] || r.type, r.how].filter(Boolean).join(" · "),
            snippetHtml: r.snippetHtml != null ? r.snippetHtml : r.description ? esc(r.description) : "",
          }),
        )
        .join("")}</ul>`
    : `<p class="empty">Memory found no pages for this.</p>`;
  const conn = connected.length
    ? `<section class="group" style="margin-top:28px"><h2><span>Also connected</span><span class="num">${connected.length}</span></h2><ul class="rows">${connected
        .map((c) => rowLi(c, { right: c.via || "", snippetHtml: c.description ? esc(c.description) : "" }))
        .join("")}</ul></section>`
    : "";
  return `<div class="page-head"><p class="eyebrow">You asked</p><h1>${esc(q)}</h1></div>
${offline ? `<p class="notice">${esc(offline)}</p>` : ""}
${panel}
<div class="section-h" style="margin-top:6px"><h2>Pages</h2><span class="how">${results.length} found</span></div>
${rows}
${conn}`;
}

// Fetches the model's answer for the query on the page and swaps it in.
const ASK_SCRIPT = `(function(){var el=document.getElementById("answer");if(!el)return;var b=el.querySelector(".body");fetch("/api/ask?q="+encodeURIComponent(el.dataset.q),{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(j){el.classList.remove("pending");if(j&&j.html){b.innerHTML=j.html}else{el.classList.add("quiet");b.innerHTML='<p class="text dim">Edva could not answer just now. The pages below are what memory found.</p>'}}).catch(function(){el.classList.remove("pending");el.classList.add("quiet");b.innerHTML='<p class="text dim">Edva could not answer just now. The pages below are what memory found.</p>'})})();`;

/**
 * The answer panel's inner HTML from the model's output. The model wrote
 * `answer` with [n] markers pointing at the numbered sources it was shown;
 * every character it wrote is escaped first, then only well-formed markers that
 * name a real source become links. `sources` = [{ n, id, title }].
 */
function answerHtml({ answer, sources }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const used = new Set();
  const text = esc(String(answer || "")).replace(/\[(\d{1,2})\]/g, (m, n) => { // lang-regex-ok: [n] citation markers the prompt asked the model to emit
    const s = byN.get(Number(n));
    if (!s) return "";
    used.add(s.n);
    return `<a class="cite" href="${href(s.id)}" title="${esc(s.title)}">${s.n}</a>`;
  });
  const cited = sources.filter((s) => used.has(s.n));
  return `<p class="text">${text}</p>${
    cited.length ? `<div class="sources">${cited.map((s) => `<a class="chip" href="${href(s.id)}">${s.n} · ${esc(s.title)}</a>`).join("")}</div>` : ""
  }`;
}

/** "Connected in memory" list items for a page. items = [{ id, title, via, from }] */
function relatedHtml(items) {
  const VIA = { wikilink: "linked", backlink: "links here", next_day: "the next day", prev_day: "the day before", hebbian: "often recalled together", related: "related", supersedes: "replaces" };
  return items
    .map((r) => {
      const via = String(r.via || "").startsWith("fact:") ? String(r.via).slice(5).replace(/_/g, " ") : VIA[r.via] || ""; // lang-regex-ok: relation id to a label
      return `<li><a href="${href(r.id)}" title="${esc(r.title || r.id)}">${esc(r.title || r.id)}</a>${via ? `<span class="via">${esc(via)}</span>` : ""}</li>`;
    })
    .join("");
}

function notFoundBody(id) {
  return `<div class="page-head ascii-404"><p class="eyebrow">Not found</p><h1>There is no page here.</h1><p class="dek">No page with the id <span class="mono">${esc(id)}</span> is in memory, or it is outside what this account can see.</p></div>${askBox({ big: false })}`;
}

// ── Curated config validation ─────────────────────────────────────────────
//
// What bin/wiki-portal accepts from the model before writing the file.
// Structure only: slugs well-formed and unique, ids real, prefixes that match
// something, featured pages inside their topic, and enough of the shelf
// covered that browsing by topic reaches nearly everything. Returns
// { config, errors[], coverage } with unknown ids and dead prefixes dropped.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/; // lang-regex-ok: validates a model-emitted URL slug (structure)
function checkPortalConfig(raw, shelfIds, { minTopics = 4, maxTopics = 14, minCoverage = 0.85 } = {}) {
  const errors = [];
  const ids = new Set(shelfIds);
  const topicsIn = raw && Array.isArray(raw.topics) ? raw.topics : null;
  if (!topicsIn) return { config: null, errors: ["topics is not an array"], coverage: 0 };
  const seen = new Set();
  const topics = [];
  let unknown = 0;
  let listed = 0;
  for (const t of topicsIn) {
    if (!t || typeof t !== "object") { errors.push("a topic is not an object"); continue; }
    const slug = String(t.slug || "");
    if (!SLUG_RE.test(slug) || seen.has(slug) || slug === "everything-else") { errors.push(`bad or duplicate slug "${slug}"`); continue; }
    const name = String(t.name || "").trim();
    if (name.length < 2 || name.length > 40) { errors.push(`topic ${slug}: name length`); continue; }
    const blurb = String(t.blurb || "").trim().slice(0, 160);
    const tIds = (Array.isArray(t.ids) ? t.ids : []).map(String);
    listed += tIds.length;
    const keep = tIds.filter((id) => ids.has(id));
    unknown += tIds.length - keep.length;
    const prefixes = (Array.isArray(t.prefixes) ? t.prefixes : [])
      .map(String)
      .filter((x) => x.length >= 3 && shelfIds.filter((id) => id.startsWith(x)).length >= 2);
    const members = new Set([...keep, ...shelfIds.filter((id) => prefixes.some((x) => id.startsWith(x)))]);
    if (!members.size) { errors.push(`topic ${slug} claims no real pages`); continue; }
    const featured = (Array.isArray(t.featured) ? t.featured : []).map(String).filter((id) => members.has(id)).slice(0, 6);
    seen.add(slug);
    topics.push({ slug, name, blurb, ids: keep, prefixes, featured });
  }
  const claimed = new Set();
  for (const t of topics) {
    for (const id of t.ids) claimed.add(id);
    for (const id of shelfIds) if (t.prefixes.some((x) => id.startsWith(x))) claimed.add(id);
  }
  const coverage = shelfIds.length ? claimed.size / shelfIds.length : 1;
  if (topics.length < minTopics || topics.length > maxTopics) errors.push(`${topics.length} usable topics (want ${minTopics}-${maxTopics})`);
  if (listed && unknown / listed > 0.1) errors.push(`${unknown} of ${listed} listed ids do not exist`);
  if (coverage < minCoverage) errors.push(`topics cover ${(coverage * 100).toFixed(0)}% of pages (want ${(minCoverage * 100).toFixed(0)}%)`);
  return { config: { topics }, errors, coverage };
}

module.exports = {
  checkPortalConfig,
  EPISODIC,
  TYPE_LABEL,
  idPrefix,
  resolvePortal,
  timelineMonths,
  homeBody,
  topicBody,
  timelineBody,
  listingBody,
  pageBody,
  searchBody,
  answerHtml,
  relatedHtml,
  notFoundBody,
  RELATED_SCRIPT,
  ASK_SCRIPT,
};
