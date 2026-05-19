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

import readline from "node:readline";

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

// Extract session-id or resume id from args.
let sessionId = flagVal("--session-id", null) || flagVal("--resume", null) || "mock-session-id";

if (crashOnStart) {
  process.exit(1);
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
  emit({
    type: "assistant",
    message: { model: "mock-claude", role: "assistant", content: [{ type: "text", text: `mock reply to: ${content.slice(0, 50)}` }] },
    session_id: sessionId,
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: delay,
    num_turns: 1,
    result: `mock reply to: ${content.slice(0, 50)}`,
    session_id: sessionId,
    total_cost_usd: 0.001,
    modelUsage: {},
  });
}

const rl = readline.createInterface({ input: process.stdin });

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

    setTimeout(() => emitResult(content), delay);
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Keep alive.
setInterval(() => {}, 60_000);
