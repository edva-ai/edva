// edva up — run the whole stack in the foreground.
//
// Spawns agent/bin/process-manager.mjs (which supervises the chat and ops
// supervisors and the channel processes) as a child of this process and
// forwards SIGINT/SIGTERM/SIGHUP, so Ctrl-C tears the tree down cleanly.
// process-manager loads .env itself. When EDVA_HOME is not set, the child
// gets EDVA_HOME=<this checkout>, so a clone outside ~/Dev/edva runs from
// where it is.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CHECKOUT, isHelp } from "./_common.mjs";

export default {
  summary: "start process-manager in the foreground (Ctrl-C stops everything)",
  usage: "up",
  async run(args, ctx) {
    const { c, die } = ctx;
    if (isHelp(args)) {
      console.log(c.bold("edva up") + " — run agent/bin/process-manager.mjs in the foreground\n");
      console.log("Ctrl-C stops the process manager and every process it supervises.");
      console.log("Logs: agent/logs/ (follow them with `edva tail`). To run as a service,");
      console.log("see docs/installer.md.");
      return;
    }
    const home = process.env.EDVA_HOME || CHECKOUT;
    const pm = path.join(home, "agent", "bin", "process-manager.mjs");
    if (!fs.existsSync(pm)) die(`process-manager not found at ${pm}`);
    if (!fs.existsSync(path.join(home, ".env"))) console.log(c.yellow("  no .env yet — run `edva init` first for a working setup"));
    console.log(c.bold("Edva up") + c.dim(" — Ctrl-C to stop"));
    console.log(c.dim(`  EDVA_HOME: ${home}\n`));
    const child = spawn(process.execPath, [pm], {
      stdio: "inherit",
      cwd: home,
      env: { ...process.env, EDVA_HOME: home },
    });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(sig, () => { try { child.kill(sig); } catch {} });
    }
    await new Promise((resolve) => {
      child.on("exit", (code, sig) => { process.exitCode = code ?? (sig ? 128 : 0); resolve(); });
    });
  },
};
