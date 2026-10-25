#!/usr/bin/env node
// Daily skill-health check (cron'd at 23:00 local on the host).
//
// Scans the cron logs under data/logs/ for skill-attributed failures:
// any line matching `error":"<code>"` AND `skill":"<site>/<action>"`
// (the convention each playbook uses when it calls into a skill).
//
// Only lines written in the last 24h count: a log touched today can still hold
// months-old lines, and re-counting them nightly turns two stale
// not_logged_in lines into a week-long streak and repeated pushes for a skill
// that works. A line's time is its own stamp (a leading
// `YYYY-MM-DD[T ]HH:MM:SS`, optionally bracketed, or a JSON "ts") or that of the
// nearest stamped line above it, e.g. run_script_job's `[job] start:` header.
// A line with no stamp above it is undated and not counted.
//
// Tracks consecutive-failure runs per (skill, action) pair in
// data/skill-health-state.json. If any pair has ≥3 consecutive
// failure days, pings the user via edva-notify with the skill name + the
// most recent error code + a pointer to the log line.
//
// A caller that deliberately chose not to report its own failure prints
//   {"skill_health":"quiet","skills":["<site>/<action>/<action>", ...],"reason":"..."}
// in the same log (e.g. a job that could not act on any date because the user
// is away for all of them). Those failures still extend the streak, but a
// pair whose every failure line in the window was quieted is not alerted.
//
// Silent on no findings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT as EDVA_ROOT } from '../../lib/root.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(EDVA_ROOT, 'data', 'logs');
const STATE_FILE = path.join(EDVA_ROOT, 'data', 'skill-health-state.json');
const NOTIFY_BIN = path.join(EDVA_ROOT, 'bin', 'edva-notify');
const ALERT_THRESHOLD = 3;
const WINDOW_MS = 24 * 3600 * 1000;
// v1 counters were built by the scanner that re-counted months-old lines, so
// they are discarded once rather than carried forward.
const STATE_VERSION = 2;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { version: STATE_VERSION, runs: {} };
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (state.version === STATE_VERSION) return state;
  process.stdout.write(`[skill-health] discarded v${state.version} counters (they re-counted old log lines)\n`);
  return { version: STATE_VERSION, runs: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// lang-regex-ok: timestamp structure of machine-written log lines
const LEADING_STAMP = /^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?/;
const TS_FIELD = /"ts":\s*"([^"]+)"/; // lang-regex-ok: JSON field of machine-written log lines

/** Epoch ms of a line's own timestamp, or null when it carries none. */
export function lineTime(line) {
  const ts = line.match(TS_FIELD);
  if (ts && !Number.isNaN(Date.parse(ts[1]))) return Date.parse(ts[1]);
  const m = line.match(LEADING_STAMP);
  if (!m) return null;
  const zone = m[3] ? m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : ''; // no zone = the host's local time
  const t = new Date(`${m[1]}T${m[2]}${zone}`).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Failure lines written in the last 24h, each marked quiet when its caller said so. */
function scanLogs(now) {
  const findings = []; // [{ skill, action, error, file, line, quiet }]
  if (!fs.existsSync(LOGS_DIR)) return findings;
  const cutoff = now - WINDOW_MS;
  const inWindow = (t) => t !== null && t > cutoff && t <= now;
  for (const f of fs.readdirSync(LOGS_DIR)) {
    const full = path.join(LOGS_DIR, f);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) continue;
    if (!f.endsWith('.log')) continue;
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = content.split('\n').slice(-2000); // bounded tail
    const fileFindings = [];
    const quietKeys = new Set();
    let lastStamp = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const own = lineTime(line);
      if (own !== null) lastStamp = own;
      if (!inWindow(lastStamp)) continue;
      if (line.includes('"skill_health"')) {
        try {
          const j = JSON.parse(line.slice(line.indexOf('{')));
          if (j.skill_health === 'quiet' && Array.isArray(j.skills)) j.skills.forEach((k) => quietKeys.add(String(k)));
        } catch { /* not a marker */ }
        continue;
      }
      const skillM = line.match(/"skill":\s*"([^"]+)"/);
      const actionM = line.match(/"action":\s*"([^"]+)"/);
      const errM = line.match(/"error":\s*"([^"]+)"/);
      if (skillM && actionM && errM && errM[1] !== 'null') {
        const diagM = line.match(/"diagnostic":\s*"([^"]{0,600})/); // lang-regex-ok: JSON field of machine-written log lines
        const urlM = line.match(/"url":\s*"([^"]+)"/); // lang-regex-ok: JSON field of machine-written log lines
        fileFindings.push({
          skill: skillM[1],
          action: actionM[1],
          error: errM[1],
          diagnostic: diagM ? diagM[1] : null,
          url: urlM ? urlM[1] : null,
          file: f,
          line: i + 1,
        });
      }
    }
    for (const x of fileFindings) findings.push({ ...x, quiet: quietKeys.has(`${x.skill}/${x.action}`) });
  }
  return findings;
}

function notify(msg) {
  // edva-notify is the canonical agent-to-user channel. The text goes as one
  // argv entry, never through a shell: it holds error codes read from logs, and
  // edva-notify has no --source/--task flags (they used to land in the push).
  try {
    execFileSync(NOTIFY_BIN, [msg], { stdio: 'inherit' });
  } catch (e) {
    process.stderr.write(`[skill-health] edva-notify failed: ${e.message}\n`);
  }
}

async function queueRepairs(findings) {
  let lib;
  try { lib = await import(path.join(EDVA_ROOT, 'lib', 'skill-repair.mjs')); } catch { return 0; }
  const file = path.join(EDVA_ROOT, 'data', 'skill-repair-queue.json');
  let n = 0;
  const done = new Set();
  for (const f of findings) {
    const key = `${f.skill}/${f.action}`;
    if (f.quiet || done.has(key) || !lib.isRepairableError(f.error)) continue;
    done.add(key);
    const id = lib.requestRepair({ skill: f.skill, action: f.action, error: f.error, diagnostic: f.diagnostic, url: f.url, producer: 'skill-health', log_file: `data/logs/${f.file}` },
      { file, kick: !process.env.SKILL_REPAIR_NO_KICK, log: (m) => process.stdout.write(`[skill-health] ${m}\n`) });
    if (id) n++;
  }
  return n;
}

async function main() {
  const findings = scanLogs(Date.now());
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);

  // Group findings by (skill, action) and count today's failures.
  const todayCounts = {};
  const loud = new Set(); // pairs with at least one failure its caller did not quiet
  for (const f of findings) {
    const key = `${f.skill}/${f.action}`;
    todayCounts[key] = (todayCounts[key] || 0) + 1;
    if (!f.quiet) loud.add(key);
  }

  // Update consecutive-failure counters.
  const newRuns = {};
  for (const key of new Set([...Object.keys(state.runs), ...Object.keys(todayCounts)])) {
    const hadFailureToday = !!todayCounts[key];
    const prior = state.runs[key] || { consecutive: 0, lastDay: null, lastError: null };
    if (hadFailureToday) {
      newRuns[key] = {
        consecutive: (prior.lastDay === today ? prior.consecutive : prior.consecutive + 1),
        lastDay: today,
        lastError: findings.find(f => `${f.skill}/${f.action}` === key)?.error || prior.lastError,
      };
    }
    // If no failure today and last failure was >1 day ago, reset.
    else if (prior.lastDay && prior.lastDay < today) {
      // Skill recovered — drop from state.
    }
  }
  state.runs = newRuns;
  state.lastRun = new Date().toISOString();
  saveState(state);

  // Alert on threshold crossings.
  const alerts = [];
  for (const [key, run] of Object.entries(newRuns)) {
    if (run.consecutive >= ALERT_THRESHOLD && loud.has(key)) {
      alerts.push(`${key} failing ${run.consecutive} days in a row — last error: ${run.lastError}`);
    }
  }
  if (alerts.length) {
    notify(`Browsing-skill health alert: ${alerts.length} action(s) repeatedly failing\n\n${alerts.join('\n')}\n\nInvestigate: data/logs/ and browsing-skills/skills/<site>/`);
  }
  // Same-day repair: a markup-break error on a read action is
  // queued for the skill-repair job on its FIRST failure day; the 3-day alert
  // above stays as the backstop. Admission rules live in lib/skill-repair.mjs.
  const repairs = await queueRepairs(findings);

  const quieted = findings.filter((f) => f.quiet).length;
  process.stdout.write(`[skill-health] ${findings.length} failure-line(s) today (${quieted} kept quiet by their caller); ${alerts.length} alert(s); ${repairs} repair(s) queued; state has ${Object.keys(newRuns).length} active run(s)\n`);
}

const invokedDirectly = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) main().catch((e) => { process.stderr.write(`[skill-health] ${e.stack || e.message}\n`); process.exitCode = 1; }); // importable for tests (lineTime) without running
