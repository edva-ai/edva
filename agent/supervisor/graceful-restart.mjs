// graceful-restart.mjs — shared CLAUDE.md watcher + graceful-restart scheduler.
//
// Both chat-supervisor and the ops supervisor need to reload their agent's
// CLAUDE.md without manual intervention when the file changes mid-session.
// This module installs a polling watcher (fs.watch is flaky on macOS) that
// schedules a graceful restart, waiting for the dispatcher to reach a safe
// point before firing. If the dispatcher stays busy for longer than
// MAX_DEFER_MS, the restart fires anyway — the existing restart() path
// transfers in-flight + queued messages to the new dispatcher, so at most
// one turn is interrupted and requeued.
//
// Usage:
//   import { attachClaudeMdWatcher } from "./graceful-restart.mjs";
//   attachClaudeMdWatcher(supervisor, {
//     claudeMdPath: "/path/to/CLAUDE.md",
//     logPrefix: "[chat-supervisor]",  // for console logging
//   });
//
// The supervisor gains three methods: watchClaudeMd(), scheduleGracefulRestart(reason),
// _tryGracefulRestart(), and stopClaudeMdWatcher(). Call watchClaudeMd() once after
// startHttp(), call _tryGracefulRestart() from the dispatcher's turn_complete handler,
// and call stopClaudeMdWatcher() from shutdown().
//
// The supervisor MUST already have:
//   - this.restarting (boolean)
//   - this.dispatcher (with .inFlight and .queue)
//   - this.restart() (async)
//   - this.eventLog (with .append) — optional, used for audit trail

import fs from "node:fs";

const POLL_MS = 30_000;
const MAX_DEFER_MS = 10 * 60 * 1000;

export function attachClaudeMdWatcher(supervisor, { claudeMdPath, logPrefix }) {
  supervisor._claudeMd = {
    path: claudeMdPath,
    mtime: 0,
    watcher: null,
    pendingReason: null,
    pendingSince: 0,
  };
  try { supervisor._claudeMd.mtime = fs.statSync(claudeMdPath).mtimeMs; } catch {}

  supervisor.watchClaudeMd = function () {
    if (this._claudeMd.watcher) return;
    if (!fs.existsSync(this._claudeMd.path)) {
      console.error(`${logPrefix} CLAUDE.md not found at ${this._claudeMd.path}, skipping watcher`);
      return;
    }
    this._claudeMd.watcher = setInterval(() => {
      try {
        const mtime = fs.statSync(this._claudeMd.path).mtimeMs;
        if (this._claudeMd.mtime && mtime > this._claudeMd.mtime) {
          console.error(`${logPrefix} CLAUDE.md changed (mtime=${new Date(mtime).toISOString()}) — scheduling graceful restart`);
          this.eventLog?.append({ kind: "claude_md_changed", path: this._claudeMd.path, mtime });
          this._claudeMd.mtime = mtime;
          this.scheduleGracefulRestart("claude-md-changed");
        } else if (!this._claudeMd.mtime) {
          this._claudeMd.mtime = mtime;
        }
      } catch {}
      // Retry a pending restart each poll in case turn_complete isn't firing
      // (idle queue + no incoming dispatches means no events to trigger it).
      this._tryGracefulRestart();
    }, POLL_MS);
    console.error(`${logPrefix} watching ${this._claudeMd.path} for changes (poll ${POLL_MS / 1000}s)`);
  };

  supervisor.scheduleGracefulRestart = function (reason) {
    if (this.restarting) return;
    if (this._claudeMd.pendingReason) {
      console.error(`${logPrefix} graceful restart already pending (current: ${this._claudeMd.pendingReason}, new: ${reason})`);
      return;
    }
    this._claudeMd.pendingReason = reason;
    this._claudeMd.pendingSince = Date.now();
    console.error(`${logPrefix} queued graceful restart (${reason}) — will fire at next safe point (max defer ${MAX_DEFER_MS / 60000}min)`);
    this._tryGracefulRestart();
  };

  supervisor._tryGracefulRestart = function () {
    if (!this._claudeMd.pendingReason || this.restarting) return;
    const inFlight = !!this.dispatcher?.inFlight;
    const queued = this.dispatcher?.queue?.length || 0;
    const ageMs = Date.now() - this._claudeMd.pendingSince;
    const force = ageMs >= MAX_DEFER_MS;

    if (!force && (inFlight || queued > 0)) {
      return;
    }

    const reason = this._claudeMd.pendingReason;
    this._claudeMd.pendingReason = null;
    this._claudeMd.pendingSince = 0;
    const note = force
      ? `force after ${Math.floor(ageMs / 60000)}min defer (inFlight=${inFlight}, queue=${queued})`
      : "dispatcher idle";
    console.error(`${logPrefix} restarting now — ${reason} (${note})`);
    this.restart().catch((e) => console.error(`${logPrefix} graceful restart failed: ${e.message}`));
  };

  supervisor.stopClaudeMdWatcher = function () {
    if (this._claudeMd?.watcher) {
      clearInterval(this._claudeMd.watcher);
      this._claudeMd.watcher = null;
    }
  };
}
