#!/usr/bin/env node
// NYT top stories RSS — free, no key, reputable source for breaking news.
// Cache 30m. Emits a candidate if the top story changed and looks time-sensitive.
import https from "node:https";
import { readStdinJson, readCache, writeCache, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson(); void sit; void context;
const NYT_HOME_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml";
const TTL_MIN = 30;

function fetchRss(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 6000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", () => resolve(null)).on("timeout", function () { this.destroy(); resolve(null); });
  });
}

function parseItems(xml) {
  if (!xml) return [];
  const out = [];
  const items = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of items) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "").trim().replace(/<[^>]+>/g, "");
    if (title && link) out.push({ title, link, pub, desc: desc.slice(0, 220) });
  }
  return out;
}

let cache = readCache("news");
let items;
if (!cache || cache._age_min >= TTL_MIN) {
  const xml = await fetchRss(NYT_HOME_RSS);
  items = parseItems(xml).slice(0, 10);
  if (items.length === 0) { emitNull("no news items fetched"); process.exit(0); }
  writeCache("news", { items });
  cache = { items };
} else {
  items = cache.items;
}

// Emit the top story with dedup_key on title. Sonnet decides if it's relevant
// given the user's situation + profile.
const top = items[0];
const pubMs = top.pub ? new Date(top.pub).getTime() : 0;
const freshMin = pubMs ? Math.round((Date.now() - pubMs) / 60000) : 9999;

stampRun("news", true);
emit({
  topic: "news",
  signal: top.title,
  urgency: freshMin < 60 ? 0.5 : 0.3,
  freshness_min: freshMin,
  dedup_key: `news:${top.link}`,
  supporting_data: { top, others: items.slice(1, 4) },
});
