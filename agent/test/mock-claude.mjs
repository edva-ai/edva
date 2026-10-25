#!/usr/bin/env node
// mock-claude.mjs — fake Claude CLI that speaks stream-json protocol.
//
// Used by chat-supervisor tests instead of the real Claude binary.
// Reads user messages from stdin (NDJSON), emits init + result events on stdout.
//
// Flags:
//   --delay <ms>         Delay before emitting result (default: 50)
//   --fail-after <n>     Exit with code 1 after N turns
//   --hang               Read messages but never emit result (tests interrupt)
//   --crash-on-start     Exit immediately with code 1
//   --record <path>      Append each received user-message content to <path>
//                        (one line each) — lets tests assert no message was
//                        lost or duplicated across a session rotation/restart.
//   --emit-usage <n>     Attach message.usage.input_tokens=<n> to each assistant
//                        event, so the supervisor's context-size guard sees a
//                        growing context. Off by default (no usage block).
//   --num-turns <n>      Report num_turns=<n> on each result (default 1) — a
//                        dispatch that took many tool steps, for the
//                        dispatch-count rotation cap.
//   --bg-wake            On the first message, register a background task,
//                        finish the turn, then emit its <task-notification>
//                        and a second (unsolicited) result — a wake turn.

import readline from "node:readline";
import fs from "node:fs";

const args = process.argv.slice(2);
function flagVal(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : def;
}
function flag(name) { return args.includes(name); }

const delay = parseInt(flagVal("--delay", "50"), 10);
const failAfter = flagVal("--fail-after", null);
const hang = flag("--hang");
const crashOnStart = flag("--crash-on-start");
const recordFile = flagVal("--record", null);
const emitUsage = flagVal("--emit-usage", null);
const numTurns = parseInt(flagVal("--num-turns", "1"), 10);
const bgWake = flag("--bg-wake");

// Extract session-id or resume id from args.
let sessionId = flagVal("--session-id", null) || flagVal("--resume", null) || "mock-session-id";

if (crashOnStart) {
  process.exit(1);
}

// One-shot text mode: a `claude -p "<prompt>" --output-format text` fork (the
// shape the old session-handoff Haiku fork used). Detect it (text output, no
// stream-json input) and emit a canned line, so any such fork resolves fast
// instead of hanging on stdin like the stream-json session.
if (args.includes("--output-format") && flagVal("--output-format", "") === "text") {
  process.stdout.write("Mock handoff digest: the previous session processed several dispatches and finished cleanly.\n");
  process.exit(0);
}

let turns = 0;
let initialized = false;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitInit() {
  if (initialized) return;
  initialized = true;
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "mock-claude",
    permissionMode: "bypassPermissions",
  });
}

function emitResult(content) {
  turns++;
  const message = { model: "mock-claude", role: "assistant", content: [{ type: "text", text: `mock reply to: ${content.slice(0, 50)}` }] };
  if (emitUsage) {
    message.usage = {
      input_tokens: parseInt(emitUsage, 10) || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
  }
  emit({
    type: "assistant",
    message,
    session_id: sessionId,
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: delay,
    num_turns: numTurns,
    result: `mock reply to: ${content.slice(0, 50)}`,
    session_id: sessionId,
    total_cost_usd: 0.001,
    modelUsage: {},
  });
}

const rl = readline.createInterface({ input: process.stdin });

// End of stdin ends the process. The real CLI exits there too (ClaudeSession.stop()
// closes stdin first), after finishing any turn in progress; this fake drops a reply
// it has not sent yet, which no test relies on. Without this, a test that killed its
// supervisor before the supervisor stopped its child left this mock running for good
// (it keeps itself alive below), and orphans accumulated over time.
rl.on("close", () => process.exit(0));

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "user" && msg.message?.content) {
    emitInit();

    if (failAfter !== null && turns >= parseInt(failAfter, 10)) {
      process.exit(1);
    }

    if (hang) return; // Read but never respond.

    const content = typeof msg.message.content === "string"
      ? msg.message.content
      : JSON.stringify(msg.message.content);

    if (recordFile) { try { fs.appendFileSync(recordFile, content + "\n"); } catch {} }

    if (bgWake && turns === 0) {
      // Launch a "background task" inside this turn, finish the turn, then
      // let the task's <task-notification> wake the model on its own — the
      // real CLI's shape for run_in_background / async subagents.
      emit({ type: "user", tool_use_result: { backgroundTaskId: "mock-bg-1" }, session_id: sessionId });
      setTimeout(() => emitResult(content), delay);
      setTimeout(() => {
        emit({ type: "user", message: { role: "user", content: "<task-notification><task-id>mock-bg-1</task-id><status>completed</status></task-notification>" }, session_id: sessionId });
        emitResult("background wake");
      }, delay + 300);
      return;
    }
    setTimeout(() => emitResult(content), delay);
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Keep alive.
setInterval(() => {}, 60_000);
