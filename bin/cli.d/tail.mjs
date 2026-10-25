// edva tail — follow a supervisor's event stream or a job log.
//
//   edva tail                    ops supervisor events (default)
//   edva tail ops|ops-light|ops-haiku|chat
//                                  agent/logs/supervisor-<agent>/events.ndjson
//   edva tail --all              every supervisor stream at once
//   edva tail <name>             agent/logs/<name>.log, else logs/<name>.log

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isHelp } from "./_common.mjs";

const AGENTS = ["ops", "ops-light", "ops-haiku", "chat"];

export default {
  summary: "follow a supervisor event stream or a job log (tail -F)",
  usage: "tail [ops|chat|<log>|--all]",
  async run(args, ctx) {
    const { c, TOOLS, hasFlag } = ctx;
    if (isHelp(args)) {
      console.log("Usage: edva tail [ops|ops-light|ops-haiku|chat] | tail <log-name> | tail --all");
      return;
    }
    const which = args.find((a) => !a.startsWith("--")) || "ops";
    const all = hasFlag(args, "--all");
    const stream = (a) => path.join(TOOLS, "agent", "logs", `supervisor-${a}`, "events.ndjson");
    let candidates;
    if (all) candidates = AGENTS.map(stream);
    else if (AGENTS.includes(which)) candidates = [stream(which)];
    else candidates = [path.join(TOOLS, "agent", "logs", `${which}.log`), path.join(TOOLS, "logs", `${which}.log`)];
    const found = candidates.filter((p) => fs.existsSync(p));
    if (!found.length) {
      console.log(c.dim("No log yet — start the system with `edva up` and try again."));
      for (const p of candidates) console.log(c.dim(`  expected: ${p}`));
      return;
    }
    const files = all || AGENTS.includes(which) ? found : found.slice(0, 1);
    const child = spawn("tail", ["-F", ...files], { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
    await new Promise((resolve) => child.on("exit", (code) => { process.exitCode = code ?? 0; resolve(); }));
  },
};
