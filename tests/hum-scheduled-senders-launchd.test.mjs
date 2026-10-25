// The two hum senders the scheduler starts (hum-explore's borderline pick and
// the queued lane-diagnosis question) send only from the GUI session, where
// the resolve-first gate and the precheck can reach the Max login, and never
// unchecked from cron (a pick once logged "model unavailable: not_logged_in"
// and went out anyway).
// Throwaway HOME, stubbed `launchctl`, `claude`, `node` and the senders; nothing real runs.
// Run: node --test tests/hum-scheduled-senders-launchd.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "scripts");
const AGENTS = path.join(SCRIPTS, "..", "launch-agents");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hum-scheduled-senders-"));
const write = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, { mode: 0o755 }); return f; };
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const UID = process.getuid();

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function sandbox({ loaded = true, maxOk = true, queue = "", runningFor = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const calls = path.join(home, "calls.log");
  const tools = path.join(home, "Dev/edva/tools");
  fs.mkdirSync(path.join(tools, "agent/logs"), { recursive: true });
  if (queue) write(path.join(tools, "data/hum-qual-delivery-queue.json"), queue);
  write(path.join(tools, "bin/hum-explore-run"),
    `#!/bin/bash\necho "hum-explore-run key=\${ANTHROPIC_API_KEY:-} $*" >> "${calls}"\necho "hum-explore-run: sent p-1 (news)"\n`);
  write(path.join(tools, "bin/hum-deliver-qual"), "// stub; the stubbed node below records the call\n");
  write(path.join(tools, "bin/edva-send-curl"), `#!/bin/bash\necho "edva-send-curl $*" >> "${calls}"\n`);
  write(path.join(home, ".local/bin/claude"), `#!/bin/bash\necho "claude $*" >> "${calls}"\n` +
    `echo '{"loggedIn": ${maxOk}, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}'\n`);
  write(path.join(home, ".local/bin/node"), `#!/bin/bash\necho "node $*" >> "${calls}"\n`);
  const stub = path.join(home, "stub");
  // `print` reports the agent running for the first `runningFor` calls, then idle.
  const prints = path.join(home, "prints");
  write(path.join(stub, "launchctl"), `#!/bin/bash
echo "launchctl $*" >> "${calls}"
case "$1" in
  print)
    ${loaded ? "" : 'echo "Could not find service" >&2; exit 113'}
    n=$(( $(cat "${prints}" 2>/dev/null || echo 0) + 1 )); echo $n > "${prints}"
    if [ $n -le ${runningFor} ]; then echo "	state = running"; else echo "	state = not running"; fi ;;
  kickstart) ${loaded ? "exit 0" : 'echo "Could not find service \\"$2\\" in domain" >&2; exit 113'} ;;
esac
`);
  write(path.join(stub, "sleep"), `#!/bin/bash\necho "sleep $*" >> "${calls}"\n`);
  const { CLAUDE_BIN, ...base } = process.env;
  const env = { ...base, HOME: home, PATH: `${stub}:${process.env.PATH}`, ANTHROPIC_API_KEY: "sk-should-be-scrubbed" };
  return {
    queueFile: path.join(tools, "data/hum-qual-delivery-queue.json"),
    script: (name, ...args) => spawnSync("/bin/bash", [path.join(SCRIPTS, name), ...args], { env, encoding: "utf8", timeout: 30000 }),
    // trigger-hum.sh's qual-delivery block on its own: the rest of that script
    // is gates on the hour, calendar and supervisor health.
    qualBlock: (mode = "tick") => {
      const src = read(path.join(SCRIPTS, "trigger-hum.sh"));
      const block = src.slice(src.indexOf("# --- deliver a queued qualitative"), src.indexOf("# --- dispatch (with health retry)"));
      assert.ok(block.includes("QUAL_QUEUE="), "found the qual block");
      return spawnSync("/bin/bash", ["-c", `MODE=${mode}\n${block}`, path.join(SCRIPTS, "trigger-hum.sh")], { env, encoding: "utf8", timeout: 30000 });
    },
    calls: () => read(calls),
    log: () => read(path.join(tools, "agent/logs/watchdog.log")),
  };
}

test("cron only kicks hum-explore's launchd agent (no -k) and never runs the send itself", () => {
  const sb = sandbox();
  assert.equal(sb.script("trigger-hum-explore.sh").status, 0);
  assert.match(sb.calls(), new RegExp(`^launchctl kickstart gui/${UID}/ai\\.claude\\.hum-explore$`, "m"));
  assert.doesNotMatch(sb.calls(), /hum-explore-run|claude auth/);
  assert.match(sb.log(), /\[hum-explore\] kicked launchd agent ai\.claude\.hum-explore\n$/);
});

test("agent not installed: nothing is sent, and the System tab gets the install line", () => {
  const sb = sandbox({ loaded: false });
  assert.notEqual(sb.script("trigger-hum-explore.sh").status, 0);
  assert.doesNotMatch(sb.calls(), /hum-explore-run/);
  assert.match(sb.calls(), /edva-send-curl --channel system --skip-precheck --intent hum-explore .*ai\.claude\.hum-explore\.plist/);
});

test("under launchd the pick runs only after the Max check passes, with Anthropic keys scrubbed", () => {
  const ok = sandbox();
  assert.equal(ok.script("run-hum-explore.sh").status, 0);
  assert.match(ok.calls(), /^claude auth status --json\nhum-explore-run key= $/m);
  assert.match(ok.log(), /\[hum-explore\] ok: hum-explore-run: sent p-1 \(news\)\n$/);
});

test("no verified Max login: the pick is held, not sent unchecked, and nobody is paged", () => {
  const sb = sandbox({ maxOk: false });
  assert.equal(sb.script("run-hum-explore.sh").status, 0);
  assert.doesNotMatch(sb.calls(), /hum-explore-run|edva-send-curl/);
  assert.match(sb.log(), /\[hum-explore\] held: Max login check failed \(loggedIn=false .*\); no pick goes out without the resolve-first check\n$/);
});

const QUEUED = JSON.stringify({ id: "qual-location_context-20261015", lane: "location_context", question: "Still worth having?" });

test("a fallback tick kicks the lane-question agent only when a question is queued, never in manual mode", () => {
  const empty = sandbox();
  assert.equal(empty.qualBlock().status, 0);
  assert.equal(empty.calls(), "");
  const queued = sandbox({ queue: QUEUED });
  assert.equal(queued.qualBlock().status, 0);
  assert.match(queued.calls(), new RegExp(`^launchctl kickstart gui/${UID}/ai\\.claude\\.hum-deliver-qual$`, "m"));
  assert.doesNotMatch(queued.calls(), /^node /m, "no inline delivery from cron");
  const manual = sandbox({ queue: QUEUED });
  assert.equal(manual.qualBlock("manual").status, 0);
  assert.equal(manual.calls(), "");
  const missing = sandbox({ queue: QUEUED, loaded: false });
  assert.equal(missing.qualBlock().status, 0, "a missing agent never breaks the tick");
  assert.match(missing.calls(), /edva-send-curl --channel system .*ai\.claude\.hum-deliver-qual\.plist/);
  assert.doesNotMatch(missing.calls(), /sleep/, "no wait on a run that never started");
});

test("the fallback tick waits for the delivery to finish before hum is dispatched, as when it ran inline", () => {
  const sb = sandbox({ queue: QUEUED, runningFor: 2 });
  assert.equal(sb.qualBlock().status, 0);
  const seq = sb.calls().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(seq, ["launchctl kickstart", "launchctl print", "sleep 5", "launchctl print", "sleep 5", "launchctl print"]);
  const hung = sandbox({ queue: QUEUED, runningFor: 1000 });
  assert.equal(hung.qualBlock().status, 0);
  assert.equal((hung.calls().match(/^sleep 5$/gm) || []).length, 30, "bounded at 150s");
});

test("under launchd the queued question is delivered only after the Max check; otherwise it stays queued", () => {
  const ok = sandbox({ queue: QUEUED });
  assert.equal(ok.script("run-hum-deliver-qual.sh").status, 0);
  assert.match(ok.calls(), /^claude auth status --json\nnode \S+\/dev\/edva\/tools\/bin\/hum-deliver-qual$/m);
  const held = sandbox({ queue: QUEUED, maxOk: false });
  assert.equal(held.script("run-hum-deliver-qual.sh").status, 0);
  assert.doesNotMatch(held.calls(), /^node /m);
  assert.match(held.log(), /\[hum-deliver-qual\] held: Max login check failed .*question left queued\n$/);
  assert.equal(read(held.queueFile), QUEUED, "the question waits for a later tick");
});

test("both launchd agents are on-demand and run their runner through cron-run", () => {
  for (const [label, runner] of [["ai.claude.hum-explore", "run-hum-explore.sh"], ["ai.claude.hum-deliver-qual", "run-hum-deliver-qual.sh"]]) {
    const plist = read(path.join(AGENTS, `${label}.plist`));
    assert.match(plist, new RegExp(`<string>${label.replaceAll(".", "\\.")}</string>`));
    assert.match(plist, new RegExp(`bin/cron-run</string>[\\s\\S]*<string>/bin/bash</string>\\s*<string>\\S+/agent/scripts/${runner.replaceAll(".", "\\.")}</string>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
    assert.doesNotMatch(plist, /StartCalendarInterval|StartInterval/, "cron keeps the clock (local-time slots)");
    const lint = spawnSync("/usr/bin/plutil", ["-lint", path.join(AGENTS, `${label}.plist`)], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});
