// triage-log.js — Append-only structured log for email triage actions
// Log file: <install>/logs/triage.log (current day; root.cjs installTools)
// Rotates daily: triage-YYYY-MM-DD.log (previous days, auto-cleaned after 30 days)
// Format: ISO timestamp | action | details (one line per event, greppable)

import fs from "node:fs";
import path from "node:path";

import { installTools } from "./root.cjs";
const LOG_DIR = installTools("logs");
const LOG_FILE = path.join(LOG_DIR, "triage.log");
const MAX_AGE_DAYS = 30;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Track which date triage.log is for, rotate when the date changes
let currentLogDate = null;

function rotateIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (currentLogDate && currentLogDate !== today) {
    // Rename yesterday's log to dated file
    try {
      if (fs.existsSync(LOG_FILE)) {
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, `triage-${currentLogDate}.log`));
      }
    } catch {}
    // Purge logs older than MAX_AGE_DAYS
    try {
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (!f.startsWith("triage-") || !f.endsWith(".log")) continue;
        const dateStr = f.slice(7, 17); // "triage-YYYY-MM-DD.log"
        const fileDate = new Date(dateStr);
        if (isNaN(fileDate.getTime())) continue;
        const ageDays = (Date.now() - fileDate.getTime()) / 86400000;
        if (ageDays > MAX_AGE_DAYS) fs.unlinkSync(path.join(LOG_DIR, f));
      }
    } catch {}
  }
  currentLogDate = today;
}

// Initialize date on load
rotateIfNeeded();

export function triageLog(action, details = {}) {
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const parts = Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" | ");
  const line = `${ts} | ${action}${parts ? " | " + parts : ""}\n`;
  fs.appendFileSync(LOG_FILE, line);
}
