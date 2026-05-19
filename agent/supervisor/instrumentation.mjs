// instrumentation.mjs — latency metrics derived from the stream-json event stream.
// Emits one NDJSON entry per tool call + per-turn summaries to timing.ndjson.
//
// Metrics captured:
//   - mcp_init: server names + pending/connected status from init event
//   - tool_call: per-tool duration (tool_use → matching tool_result)
//   - first_tool_delay: time from user dispatch → first tool_use
//   - turn_summary: total cost, duration, tool count

import fs from "node:fs";
import path from "node:path";

export class Instrumentation {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.path = path.join(dir, "timing.ndjson");
    this.pending = new Map();   // tool_use_id -> { name, startedAt }
    this.currentTurn = null;    // { dispatchedAt, firstToolAt, toolCount }
  }

  _write(entry) {
    fs.appendFile(this.path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", (err) => { if (err) console.error(`[instrumentation] write failed: ${err.message}`); });
  }

  // Called before we write a user message to stdin.
  markDispatch(itemId, source) {
    this.currentTurn = { itemId, source, dispatchedAt: Date.now(), firstToolAt: null, toolCount: 0 };
  }

  // Consume every event from the claude stream.
  observe(event) {
    // Lazy cleanup: drop orphaned tool_use entries older than 5 minutes
    if (this.pending.size > 0 && (!this._lastCleanup || Date.now() - this._lastCleanup > 60_000)) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [id, entry] of this.pending) {
        if (entry.startedAt < cutoff) this.pending.delete(id);
      }
      this._lastCleanup = Date.now();
    }

    if (event.type === "system" && event.subtype === "init") {
      this._write({
        kind: "mcp_init",
        session_id: event.session_id,
        model: event.model,
        mcp_servers: (event.mcp_servers || []).map(s => ({ name: s.name, status: s.status })),
        tool_count: (event.tools || []).length,
        mcp_tool_count: (event.tools || []).filter(t => t.startsWith("mcp__")).length,
      });
      return;
    }

    // tool_use appears inside assistant messages
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          this.pending.set(block.id, { name: block.name, startedAt: Date.now() });
          if (this.currentTurn) {
            this.currentTurn.toolCount++;
            if (!this.currentTurn.firstToolAt) {
              this.currentTurn.firstToolAt = Date.now();
              this._write({
                kind: "first_tool_delay",
                turn_id: this.currentTurn.itemId,
                source: this.currentTurn.source,
                delay_ms: this.currentTurn.firstToolAt - this.currentTurn.dispatchedAt,
                tool_name: block.name,
              });
            }
          }
        }
      }
    }

    // tool_result lives in user messages (role:user with content[].tool_use_id)
    if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const pending = this.pending.get(block.tool_use_id);
          if (pending) {
            this._write({
              kind: "tool_call",
              tool_name: pending.name,
              duration_ms: Date.now() - pending.startedAt,
              is_error: !!block.is_error,
            });
            this.pending.delete(block.tool_use_id);
          }
        }
      }
    }

    if (event.type === "result") {
      const turn = this.currentTurn;
      this._write({
        kind: "turn_summary",
        turn_id: turn?.itemId || null,
        source: turn?.source || null,
        total_duration_ms: turn ? Date.now() - turn.dispatchedAt : event.duration_ms,
        api_duration_ms: event.duration_api_ms,
        first_tool_delay_ms: turn?.firstToolAt ? (turn.firstToolAt - turn.dispatchedAt) : null,
        tool_count: turn?.toolCount || 0,
        num_turns: event.num_turns,
        total_cost_usd: event.total_cost_usd,
        permission_denials: (event.permission_denials || []).length,
      });
      this.currentTurn = null;
    }
  }
}
