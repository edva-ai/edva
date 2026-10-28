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
      totalDispatches: 0,
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

  // Dispatch count for the rotation cap. A state file written before the
  // counter existed has none; treat it as 0 rather than falling back to the
  // tool-step total, which is the number that over-rotated.
  get dispatches() { return this.data.totalDispatches || 0; }

  touch() { this.data.lastEventTs = Date.now(); }

  // `totalTurns` sums num_turns — the TOOL STEPS inside each dispatch — and is
  // telemetry only. `totalDispatches` counts completed results that did work
  // (num_turns >= 1) and is what the session-rotation cap compares against.
  // A cap on totalTurns would let one 20-step job exhaust the ops-haiku cap of
  // 20, rotating the tiers every few dispatches, each paying a cold floor write.
  recordResult({ costUsd, turns }) {
    this.data.totalCostUsd += costUsd || 0;
    this.data.totalTurns += turns || 0;
    if ((turns || 0) >= 1) this.data.totalDispatches = (this.data.totalDispatches || 0) + 1;
    this.data.lastEventTs = Date.now();
    this.save();
  }

  // The context floor measured when this session started, kept with the
  // session so a supervisor restart that resumes it reuses that floor instead
  // of re-measuring it from the whole resumed conversation. A re-measured
  // floor reads every token of the conversation as uncompactable, which turns
  // off both /compact and the idle-cold rotation for the rest of the session.
  recordFloor(sessionId, tokens) {
    this.data.floor = { sessionId, tokens };
    this.save();
  }

  floorFor(sessionId) {
    const f = this.data.floor;
    return f && f.sessionId === sessionId && f.tokens > 0 ? f.tokens : 0;
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
    this.data.totalDispatches = 0;
    // A freshly-minted session id does NOT exist in claude -p yet, so it must
    // NOT be treated as resumable until it has actually initialized (the "ready"
    // handler calls markInitialized() once the new session is live). Leaving
    // everInitialized=true here made canResume report the brand-new id as
    // resumable → the next restart tried `--resume <never-created-id>` → the
    // child exited zero-turn before the ready-handler's resume-failed recovery
    // could run → the same bad id was retried on each restart until crash-loop
    // recovery (5 zero-turn exits ≈ 90s of exponential backoff) finally forced a
    // fresh session (a ~90s silence window).
    this.data.everInitialized = false;
    this.save();
  }

  snapshot() {
    return { ...this.data };
  }
}
