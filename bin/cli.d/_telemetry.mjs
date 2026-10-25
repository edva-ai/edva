// _telemetry.mjs — Edva's anonymous first-run install ping.
//
// One POST per (host, context) to the telemetry endpoint (apps/telemetry/,
// a small open-source function; its README documents the payload and the
// privacy posture). The payload carries no PII and no raw IP: a 16-hex-char
// hash of hostname + username, the OS, the CPU arch, the package version, the
// git short SHA and the context label ("fresh-install", ...).
//
// Off switches, checked on every call:
//   EDVA_NO_TELEMETRY=1        in the environment: never ping
//   EDVA_TELEMETRY=off         in .env (the `edva init` answer, or
//                                `edva telemetry off`): never ping
// EDVA_TELEMETRY_URL points the ping at a fork's own deployment.
// A touchfile data/.install-pinged-<ctx> makes each context fire at most once.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readDotEnv } from "./_common.mjs";

export const DEFAULT_TELEMETRY_URL = "https://edva-telemetry.vercel.app/install";

export function telemetryUrl() {
  return process.env.EDVA_TELEMETRY_URL || DEFAULT_TELEMETRY_URL;
}

// → { enabled, reason }
export function telemetryState(base) {
  if (process.env.EDVA_NO_TELEMETRY === "1") return { enabled: false, reason: "EDVA_NO_TELEMETRY=1 in the environment" };
  const env = readDotEnv(path.join(base, ".env"));
  if (String(env.EDVA_TELEMETRY || "").toLowerCase() === "off") return { enabled: false, reason: "EDVA_TELEMETRY=off in .env" };
  if (env.EDVA_NO_TELEMETRY === "1") return { enabled: false, reason: "EDVA_NO_TELEMETRY=1 in .env" };
  return { enabled: true, reason: env.EDVA_TELEMETRY ? `EDVA_TELEMETRY=${env.EDVA_TELEMETRY} in .env` : "default (no opt-out set)" };
}

export function pingTouchfile(base, ctx) {
  return path.join(base, "data", `.install-pinged-${ctx}`);
}

export function payloadFor(base, ctx) {
  const hostFp = crypto.createHash("sha256")
    .update(`${os.hostname()}|${(() => { try { return os.userInfo().username; } catch { return ""; } })()}`)
    .digest("hex").slice(0, 16);
  let sha = "";
  try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: base, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  let ver = "";
  try { ver = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version || ""; } catch {}
  return { host_fp: hostFp, os: process.platform, arch: process.arch, ver, sha, ctx };
}

// Fire-and-forget; resolves to "sent" | "skipped:<why>". Never throws, never
// waits more than ~3 s.
export async function sendInstallPing(base, ctx, { force = false } = {}) {
  const st = telemetryState(base);
  if (!st.enabled) return `skipped:${st.reason}`;
  const touch = pingTouchfile(base, ctx);
  if (!force && fs.existsSync(touch)) return "skipped:already pinged";
  const payload = JSON.stringify(payloadFor(base, ctx));
  const url = telemetryUrl();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const ver = JSON.parse(payload).ver || "dev";
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `edva-cli/${ver} (${process.platform}; ${process.arch})` },
      body: payload,
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch { /* never fail an install over telemetry */ }
  // Written whatever the HTTP outcome, so a flaky network never causes repeat pings.
  try { fs.mkdirSync(path.dirname(touch), { recursive: true }); fs.writeFileSync(touch, new Date().toISOString() + "\n"); } catch {}
  return "sent";
}
