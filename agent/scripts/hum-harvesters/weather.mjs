#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readStdinJson, readCache, writeCache, emit, emitNull, stampRun } from "./_common.mjs";

const { situation: sit, context } = await readStdinJson();

// Use cached weather if fresh (60m TTL); otherwise fetch
const TTL_MIN = 60;
let cur = readCache("weather");
let prev = cur; // for delta detection
if (!cur || cur._age_min >= TTL_MIN) {
  try {
    const out = execSync("${MERLIN_HOME_USER}/dev/merlin/bin/apple-weather --findme --json 2>/dev/null", {
      encoding: "utf8", timeout: 10000,
    });
    const w = JSON.parse(out);
    const c = w?.currentWeather || w?.current || null;
    if (!c) { emitNull("no current weather in payload"); process.exit(0); }
    cur = {
      temp_f: c.temperature,
      condition: c.conditionCode,
      precip_chance: c.precipitationChance || 0,
      uv: c.uvIndex || 0,
    };
    writeCache("weather", cur);
  } catch (e) {
    emitNull(`weather fetch: ${e.message}`);
    process.exit(0);
  }
}

// Check for significant change vs prior cached snapshot
const findings = [];
if (prev && prev._cached_at) {
  const dTemp = Math.abs((cur.temp_f ?? 0) - (prev.temp_f ?? 0));
  if (dTemp >= 10) findings.push(`Temp shifted ${dTemp.toFixed(0)}F`);
  if (prev.precip_chance < 0.3 && (cur.precip_chance || 0) >= 0.5) {
    findings.push(`Rain likely (${Math.round((cur.precip_chance || 0) * 100)}%)`);
  }
  if (cur.condition !== prev.condition && cur.condition) {
    findings.push(`Conditions: ${cur.condition}`);
  }
}

// Proactive "heading out with weather concern" trigger — only relevant if outside
// or about to go outside. Hum's Sonnet ranker can use the supporting data.
const rainSoon = (cur.precip_chance || 0) >= 0.5;
// C-as-F mislabel guard: when the upstream feed reports a Celsius value (~0–10C
// for cool/cold conditions) but the units field still says F, we'd fire
// extreme=true on a perfectly ordinary 11F-but-actually-11C "Cloudy" day.
// 22 false hits in one day per the 2026-04-29 hum review.
const mislabeledCold = cur.temp_f < 32 && ["Cloudy", "PartlyCloudy", "MostlyCloudy"].includes(cur.condition);
const extreme = !mislabeledCold && (cur.temp_f < 25 || cur.temp_f > 90);

if (findings.length === 0 && !rainSoon && !extreme) {
  stampRun("weather", false);
  emitNull("no material change");
  process.exit(0);
}

const urgency = rainSoon ? 0.6 : (extreme ? 0.5 : 0.3);
stampRun("weather", true);
emit({
  topic: "weather",
  signal: findings.length ? findings.join("; ") : `${cur.condition || "clear"}, ${cur.temp_f}F, rain ${Math.round((cur.precip_chance || 0) * 100)}%`,
  urgency,
  freshness_min: 0,
  dedup_key: `weather:${cur.condition}:${Math.round(cur.temp_f / 5)}`,
  supporting_data: { current: cur, findings, rain_soon: rainSoon, extreme },
});
