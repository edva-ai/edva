// event-log.mjs — NDJSON append writer for supervisor events.
// Three streams:
//   events.ndjson     full event firehose
//   cost.ndjson       one line per turn result (session-level aggregate)
//   job-costs.ndjson  one line per turn result attributed to its job/source
//                     (added 2026-04-23 — drives per-job usage rollups for
//                     `merlin-cost-report` + nightly-review cost lens)

import fs from "node:fs";
import path from "node:path";

export class EventLog {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.eventsPath = path.join(dir, "events.ndjson");
    this.costPath = path.join(dir, "cost.ndjson");
    this.jobCostsPath = path.join(dir, "job-costs.ndjson");
  }

  append(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFile(this.eventsPath, line, (err) => { if (err) console.error(`[event-log] write failed: ${err.message}`); });
  }

  appendCost(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFile(this.costPath, line, (err) => { if (err) console.error(`[event-log] cost write failed: ${err.message}`); });
  }

  appendJobCost(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFile(this.jobCostsPath, line, (err) => { if (err) console.error(`[event-log] job-cost write failed: ${err.message}`); });
  }
}
