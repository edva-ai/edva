"use strict";
// host-identity — resolve which physical machine this process is running on.
//
// Shared by `edva whereami` and the SessionStart host banner
// (bin/wiki-session-context). Registry: system/hosts.json.
//
// Why this exists: Claude Code sessions had no reliable way to tell whether
// they were on the production host (where the always-on agent stack runs) or a
// dev laptop. A session that guesses from a cwd path string can get it
// backwards — concluding "laptop, nothing running" while sitting on the
// production host with every service healthy. Resolution here is
// deterministic: hostname / alias match first (instant, no spawn), then the
// immutable hardware UUID as a fallback that survives renames.
//
// Production: an entry with `"production": true`, or role "production". An
// installation that names its production role something else marks that entry
// `"production": true` and keeps its own role word (shown in the banner).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOSTS_JSON = path.join(__dirname, "..", "system", "hosts.json");

function loadRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(HOSTS_JSON, "utf8"));
    return Array.isArray(data.hosts) ? data.hosts : [];
  } catch {
    return [];
  }
}

// Hardware UUID via ioreg — immutable per machine, survives renames. Best-effort:
// returns null if ioreg is unavailable or restricted (e.g. inside some sandboxes).
function hardwareUUID() {
  try {
    const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function isProductionEntry(entry) {
  return !!entry && (entry.production === true || entry.role === "production");
}

function resolveHost() {
  const hostname = os.hostname();
  const hn = hostname.toLowerCase();
  const shortHn = hn.replace(/\.local$/, "");
  const registry = loadRegistry();

  // 1) hostname / alias match — instant, no process spawn.
  let entry = registry.find((h) => {
    const cands = [h.hostname, ...(h.aliases || [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    return cands.includes(hn) || cands.includes(shortHn);
  });

  // 2) fallback — immutable hardware UUID (catches a renamed host).
  let uuid = null;
  if (!entry) {
    uuid = hardwareUUID();
    if (uuid) entry = registry.find((h) => (h.uuid || "").toLowerCase() === uuid.toLowerCase());
  }
  if (entry && !uuid) uuid = entry.uuid || null;

  return {
    hostname,
    uuid: uuid || null,
    known: !!entry,
    id: entry ? entry.id : null,
    role: entry ? entry.role : "unknown",
    label: entry ? entry.label : "unregistered machine",
    notes: entry ? entry.notes || null : null,
    isProduction: isProductionEntry(entry),
  };
}

// Compact, ANSI-free banner — prepended to the SessionStart context bundle and
// emitted by `edva whereami --banner`. Carries the sandbox caveat because
// that is what masks the truth in practice.
function hostBanner(h) {
  const host = h || resolveHost();
  const roleWord = host.known ? String(host.role).toUpperCase() : "UNKNOWN";
  const uuidShort = host.uuid ? host.uuid.split("-")[0] + "…" : "uuid n/a";
  const lines = [
    `── Host: ${roleWord} (${host.label}) ──`,
    `${host.hostname} · UUID ${uuidShort}`,
  ];
  if (!host.known) {
    lines.push(
      "This machine is NOT in system/hosts.json — it is not the production Edva host. " +
        "Register it by adding an entry (hostname + UUID + role) to that file.",
    );
  }
  lines.push(
    "⚠ The default Bash-tool sandbox masks localhost connections and process listings (pgrep/launchctl/curl) — " +
      "a healthy machine can look dead. Re-run unsandboxed to check whether Edva services are actually up.",
  );
  return lines.join("\n");
}

module.exports = { resolveHost, hostBanner, hardwareUUID, HOSTS_JSON };
