#!/usr/bin/env node
// mock-service.mjs — configurable mock child process for testing.
//
// Spawned by tests via ManagedProcess. Behavior controlled by CLI flags:
//
//   --exit-after <ms>         Exit with code 0 after N ms
//   --exit-code <n>           Exit with specific code (used with --exit-after or --crash-after)
//   --crash-after <ms>        Exit after N ms (default code 1)
//   --ignore-sigterm          Trap SIGTERM, stay alive
//   --echo-stdin              Pipe stdin to stdout
//   --output <text>           Print text to stdout at startup
//   --output-after <ms:text>  Print text after delay (repeatable)
//   --http <port>             Start HTTP server responding to /health
//   --report-tty              Print TTY=true or TTY=false
//   --exit-on-stdin <text>    Exit when text received on stdin

import http from "node:http";

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function flagVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

function flagAll(name) {
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      vals.push(args[++i]);
    }
  }
  return vals;
}

const exitCode = parseInt(flagVal("--exit-code") || "0", 10);

// --ignore-sigterm
if (flag("--ignore-sigterm")) {
  process.on("SIGTERM", () => {});
}

// --report-tty
if (flag("--report-tty")) {
  process.stdout.write(`TTY=${!!process.stdin.isTTY}\n`);
}

// --output <text>
const outputText = flagVal("--output");
if (outputText) {
  process.stdout.write(outputText + "\n");
}

// --output-after <ms:text> (repeatable)
for (const spec of flagAll("--output-after")) {
  const sep = spec.indexOf(":");
  if (sep === -1) continue;
  const ms = parseInt(spec.slice(0, sep), 10);
  const text = spec.slice(sep + 1);
  setTimeout(() => process.stdout.write(text), ms);
}

// --echo-stdin
if (flag("--echo-stdin")) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
}

// --exit-on-stdin <text>
const exitOnText = flagVal("--exit-on-stdin");
if (exitOnText) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (buf.includes(exitOnText)) {
      process.exit(exitCode);
    }
  });
}

// --http <port>
const httpPort = flagVal("--http");
if (httpPort) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", pid: process.pid }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(parseInt(httpPort, 10));
}

// --exit-after <ms>
const exitAfter = flagVal("--exit-after");
if (exitAfter !== null) {
  setTimeout(() => process.exit(exitCode), parseInt(exitAfter, 10));
}

// --crash-after <ms>
const crashAfter = flagVal("--crash-after");
if (crashAfter !== null) {
  const code = exitCode || 1;
  setTimeout(() => process.exit(code), parseInt(crashAfter, 10));
}

// Keep alive if no exit timer set (for long-running mock services).
if (exitAfter === null && crashAfter === null) {
  setInterval(() => {}, 60_000);
}

// Prevent unhandled stdin errors from crashing the mock.
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
