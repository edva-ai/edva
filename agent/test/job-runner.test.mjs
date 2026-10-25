// job-runner.test.mjs — tests for lib/job-runner.mjs + job-runner-wrapper.mjs.
//
// Run: node --test agent/test/job-runner.test.mjs
//
// These exercise the real detached-process mechanism (not mocks) — the whole
// point of job-runner is that the target process survives independently of
// whatever launched it, so a real spawn + poll is the only faithful test.
// Uses the real data/jobs directory (gitignored runtime state); every
// job created here is cleaned up in the matching test or in `after`.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readRegistry, cancelJob, registryPath, logPath } from "../../lib/job-runner.mjs";
import { startJob } from "../../lib/job-runner.mjs";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const createdIds = [];

async function waitForTerminal(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readRegistry(id);
    if (job && ["done", "failed", "canceled", "lost"].includes(job.status)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not reach a terminal status within ${timeoutMs}ms`);
}

function cleanup(id) {
  try { fs.unlinkSync(registryPath(id)); } catch {}
  try { fs.unlinkSync(logPath(id)); } catch {}
}

after(() => {
  for (const id of createdIds) cleanup(id);
});

describe("job-runner", () => {
  it("runs a command to completion and records status=done, exit_code=0", async () => {
    const { id } = startJob({ name: "test-ok", command: "/bin/sh", args: ["-c", "echo hi; exit 0"] });
    createdIds.push(id);
    const job = await waitForTerminal(id);
    assert.equal(job.status, "done");
    assert.equal(job.exit_code, 0);
    assert.ok(fs.existsSync(job.log_file));
    assert.match(fs.readFileSync(job.log_file, "utf8"), /hi/);
  });

  it("treats a non-zero exit as status=done (not failed) — exit_code carries the real outcome", async () => {
    // Regression test: some scripts use multi-value exit
    // codes (0=sent, 1=failure, 2=idempotent no-op). job-runner must not
    // collapse "exit 2" into a misleading "failed" label every routine day.
    const { id } = startJob({ name: "test-nonzero-exit", command: "/bin/sh", args: ["-c", "exit 2"] });
    createdIds.push(id);
    const job = await waitForTerminal(id);
    assert.equal(job.status, "done");
    assert.equal(job.exit_code, 2);
  });

  it("marks status=failed when the process is killed by an unrequested signal", async () => {
    const { id } = startJob({ name: "test-crash", command: "/bin/sh", args: ["-c", "kill -SEGV $$"] });
    createdIds.push(id);
    const job = await waitForTerminal(id);
    assert.equal(job.status, "failed");
    assert.ok(job.signal);
  });

  it("cancelJob signals the target and the wrapper records status=canceled", async () => {
    const { id } = startJob({ name: "test-cancel", command: "/bin/sh", args: ["-c", "sleep 30; exit 0"] });
    createdIds.push(id);
    await sleep(400); // let the wrapper spawn the target and write its pid
    const { alreadyTerminal } = cancelJob(id);
    assert.equal(alreadyTerminal, false);
    const job = await waitForTerminal(id);
    assert.equal(job.status, "canceled");
    assert.equal(job.signal, "SIGTERM");
  });

  it("startJob returns immediately without waiting for the command to finish", async () => {
    const start = Date.now();
    const { id } = startJob({ name: "test-nonblocking", command: "/bin/sh", args: ["-c", "sleep 2; exit 0"] });
    createdIds.push(id);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `startJob took ${elapsed}ms — should return well before the 2s target command finishes`);
    await waitForTerminal(id);
  });
});
