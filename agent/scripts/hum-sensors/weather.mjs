// weather — only the turns, never the forecast.
//
// The weather harvester already reports conditions inside a tick. What this
// sensor adds is the moment: rain about to start, the temperature swinging
// enough to change what the user would wear or whether an outdoor plan moves. A steady
// 72°F afternoon produces nothing at all.

import { event, shJson, BIN } from "./_common.mjs";
import { optionalBin } from "../../../lib/ext-hooks.mjs";

export const meta = { name: "weather", lanes: ["weather", "situation", "exercise"] };

export default async function detect(ctx) {
  const { memo, setMemo } = ctx;
  // The installation's weather CLI (EDVA_WEATHER_BIN, else bin/_ext/ or
  // bin/apple-weather); none installed → no events.
  const bin = optionalBin(BIN, "apple-weather", "EDVA_WEATHER_BIN");
  if (!bin) return [];
  const w = await shJson(bin, ["--findme", "--json"], { timeout: 15000 });
  const cur = w?.currentWeather || w?.current || null;
  if (!cur) return [];

  const now = {
    temp_f: cur.temperature != null ? (cur.temperature * 9) / 5 + 32 : null,
    condition: cur.conditionCode || null,
    precip_chance: cur.precipitationChance ?? 0,
  };
  const out = [];

  if (memo?.condition !== undefined) {
    // ── rain becoming likely ──
    // The edge, not the level: crossing into likely is the moment to say
    // "bring the umbrella / head out now".
    if (now.precip_chance >= 0.5 && (memo.precip_chance ?? 0) < 0.5) {
      out.push(event("weather", "precip_incoming", {
        subject: now.condition || "rain",
        summary: `Rain becoming likely (${Math.round(now.precip_chance * 100)}%)`,
        salience: 0.62,
        lanes: ["weather", "situation", "exercise"],
        dedup_key: "weather:precip_incoming",
        ttl_min: 45,
        cooldown_min: 180,
        data: now,
      }));
    }
    // ── it cleared up ──
    if (now.precip_chance < 0.2 && (memo.precip_chance ?? 0) >= 0.5) {
      out.push(event("weather", "precip_cleared", {
        subject: "clearing",
        summary: "Rain has cleared",
        salience: 0.44,
        lanes: ["weather", "exercise", "situation", "experiences"],
        dedup_key: "weather:precip_cleared",
        ttl_min: 45,
        cooldown_min: 180,
        data: now,
      }));
    }
    // ── a swing big enough to matter ──
    const dTemp = Math.abs((now.temp_f ?? 0) - (memo.temp_f ?? 0));
    if (Number.isFinite(dTemp) && dTemp >= 12 && memo.temp_f != null) {
      out.push(event("weather", "temp_swing", {
        subject: `${Math.round(now.temp_f)}°F`,
        summary: `Temperature swung ${Math.round(dTemp)}°F to ${Math.round(now.temp_f)}°F`,
        salience: 0.4,
        lanes: ["weather", "situation"],
        dedup_key: `weather:temp_swing:${Math.round(now.temp_f / 5)}`,
        ttl_min: 60,
        cooldown_min: 240,
        data: { ...now, delta_f: Math.round(dTemp) },
      }));
    }
  }

  setMemo(now);
  return out;
}
