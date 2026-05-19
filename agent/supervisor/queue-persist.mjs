// queue-persist.mjs — durable disk persistence for the dispatcher queue.
//
// The dispatcher's queue + inFlight live in memory. The in-process restart()
// flow transfers them between dispatcher instances correctly, but a whole-
// process restart (launchd respawn, OOM, panic, cron-killed) drops them. On
// 2026-05-18 a queued `mkt-aso-baseline` was lost this way when the process
// started fresh at 08:01:57Z right after the 08:00 cron burst.
//
// This module saves queue+inFlight to disk atomically on every mutation so
// the next process can replay them.

import fs from "node:fs";
import path from "node:path";

export class QueuePersist {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  save(dispatcher) {
    const queue = dispatcher?.queue || [];
    const inFlight = dispatcher?.inFlight || null;
    if (queue.length === 0 && !inFlight) {
      try { fs.unlinkSync(this.filePath); } catch {}
      return;
    }
    const payload = {
      version: 1,
      savedAt: Date.now(),
      queue,
      inFlight,
    };
    const tmp = this.filePath + ".tmp." + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[queue-persist] save failed: ${err.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (data.version !== 1) return null;
      return { queue: data.queue || [], inFlight: data.inFlight || null };
    } catch (err) {
      console.error(`[queue-persist] load failed: ${err.message} — starting empty`);
      return null;
    }
  }
}
