// state.mjs — persistent supervisor state: session_id, cumulative cost, counters.
// Atomic writes via temp file + rename. Survives restarts.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class State {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      console.error(`[state] load failed: ${err.message}, starting fresh`);
    }
    return {
      sessionId: randomUUID(),
      createdAt: new Date().toISOString(),
      totalCostUsd: 0,
      totalTurns: 0,
      lastEventTs: null,
      lastResumeAt: null,
      everInitialized: false,
    };
  }

  save() {
    const tmp = this.filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  get sessionId() { return this.data.sessionId; }

  touch() { this.data.lastEventTs = Date.now(); }

  recordResult({ costUsd, turns }) {
    this.data.totalCostUsd += costUsd || 0;
    this.data.totalTurns += turns || 0;
    this.data.lastEventTs = Date.now();
    this.save();
  }

  markResumed() {
    this.data.lastResumeAt = new Date().toISOString();
    this.save();
  }

  markInitialized() {
    this.data.everInitialized = true;
    this.save();
  }

  get canResume() {
    return this.data.everInitialized;
  }

  rotateSession() {
    // Called when --resume fails and we must start a fresh session.
    this.data.sessionId = randomUUID();
    this.data.createdAt = new Date().toISOString();
    this.data.totalCostUsd = 0;
    this.data.totalTurns = 0;
    this.save();
  }

  snapshot() {
    return { ...this.data };
  }
}
