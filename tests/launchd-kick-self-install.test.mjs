// A launchd agent added in the repo but never installed no longer leaves its job
// dead until someone installs it by hand: launchd_kick installs it from the repo
// plist and kicks once more, and the System tab's "<job> did not run: its launchd
// agent <label> is not loaded on <host>" page goes out only when that fails
// (a newly added agent's runs failed "Could not find service" until someone
// installed it by hand). A copy already in
// ~/Library/LaunchAgents that is not loaded was booted out on purpose: left alone.
// Throwaway HOME, stubbed `launchctl` (state in a marker file) and `plutil`
// (records, then the real read-only /usr/bin/plutil); nothing real is loaded.
// Run: node --test tests/launchd-kick-self-install.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "scripts");
const LIB = path.join(SCRIPTS, "lib", "launchd-kick.sh");
const LABEL = "ai.claude.hum-explore";
const REPO_PLIST = read(path.join(SCRIPTS, "..", "launch-agents", `${LABEL}.plist`));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-kick-self-install-"));
const UID = process.getuid();
function write(f, body, mode = 0o755) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, { mode }); return f; }
function read(f) { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function sandbox({ loaded = false, repoPlist = REPO_PLIST, installed = null, bootstrapFails = false } = {}) {
  const home = fs.mkdtempSync(path.join(TMP, "home-"));
  const calls = path.join(home, "calls.log"), mark = path.join(home, "loaded");
  const tools = path.join(home, "Dev/edva/tools");
  fs.mkdirSync(path.join(tools, "agent/logs"), { recursive: true });
  if (loaded) write(mark, "");
  if (repoPlist) write(path.join(tools, `agent/launch-agents/${LABEL}.plist`), repoPlist, 0o644);
  const dst = path.join(home, `Library/LaunchAgents/${LABEL}.plist`);
  if (installed) write(dst, installed, 0o644);
  write(path.join(tools, "bin/edva-send-curl"), `#!/bin/bash\necho "edva-send-curl $*" >> "${calls}"\n`);
  const stub = path.join(home, "stub");
  write(path.join(stub, "launchctl"), `#!/bin/bash
echo "launchctl $*" >> "${calls}"
case "$1" in
  print|kickstart)
    [ -e "${mark}" ] && exit 0
    echo "Could not find service \\"\${2##*/}\\" in domain for user gui: ${UID}" >&2; exit 113 ;;
  bootstrap)
    if [ -n "\${STUB_BOOTSTRAP_FAIL:-}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    [ -f "$3" ] || { echo "no plist at $3" >&2; exit 2; }
    : > "${mark}" ;;
esac
`);
  write(path.join(stub, "plutil"), `#!/bin/bash\necho "plutil $*" >> "${calls}"\nexec /usr/bin/plutil "$@"\n`);
  // The page names the machine by the instance's host_label; pinned here so the
  // test reads the same in any installation.
  const env = { ...process.env, HOME: home, PATH: `${stub}:${process.env.PATH}`, EDVA_HOST_LABEL: "the server" };
  if (bootstrapFails) env.STUB_BOOTSTRAP_FAIL = "1";
  return {
    dst,
    // The repo plist is a template: what lands in ~/Library/LaunchAgents is it rendered for this HOME.
    rendered: (repoPlist || "").replaceAll("__EDVA_TOOLS__", path.join(home, "Dev/edva/tools")).replaceAll("__EDVA_HOME__", path.join(home, "Dev/edva")).replaceAll("__HOME__", home),
    // As strict as the strictest callers (the trigger scripts that run under set -euo pipefail).
    kick: () => spawnSync("/bin/bash", ["-c", `set -euo pipefail\nsource "${LIB}"\nlaunchd_kick ${LABEL} hum-explore`],
      { env, encoding: "utf8", timeout: 30000 }),
    calls: () => read(calls),
    resetCalls: () => fs.writeFileSync(calls, ""),
    pages: () => read(calls).match(/^edva-send-curl .*$/gm) || [],
    log: () => read(path.join(tools, "agent/logs/watchdog.log")),
  };
}

// The page as it read before this change (with the host_label above); system-issue-review clusters on "is not loaded on <host>".
const PAGE = `edva-send-curl --channel system --skip-precheck --intent hum-explore hum-explore did not run: its launchd agent ${LABEL} is not loaded on the server. Install it with: ~/Dev/edva/agent/launch-agents/install.sh ${LABEL} (renders agent/launch-agents/${LABEL}.plist into ~/Library/LaunchAgents and bootstraps it)`;

test("added but never installed: installs the repo plist, bootstraps it, kicks again, pages nobody", () => {
  const sb = sandbox();
  const r = sb.kick();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.calls().split("\n").filter(Boolean).filter((l) => l.startsWith("launchctl")), [
    `launchctl kickstart gui/${UID}/${LABEL}`,
    `launchctl print gui/${UID}/${LABEL}`,
    `launchctl bootstrap gui/${UID} ${sb.dst}`,
    `launchctl kickstart gui/${UID}/${LABEL}`,
  ]);
  assert.equal(read(sb.dst), sb.rendered, "the installed copy is the repo plist, rendered");
  assert.doesNotMatch(read(sb.dst), /__EDVA_HOME__|__EDVA_TOOLS__|__HOME__/);
  assert.deepEqual(sb.pages(), []);
  assert.match(sb.log(), /\[hum-explore\] installed launchd agent ai\.claude\.hum-explore from the repo \(it was added but never installed\)\n/);
  assert.match(sb.log(), /\[hum-explore\] kicked launchd agent ai\.claude\.hum-explore \(after installing it\)\n$/);
  // The next run finds it loaded and only kicks.
  sb.resetCalls();
  assert.equal(sb.kick().status, 0);
  assert.equal(sb.calls(), `launchctl kickstart gui/${UID}/${LABEL}\n`);
});

test("a copy present but not loaded was booted out on purpose: left alone, and the page goes out as before", () => {
  const sb = sandbox({ installed: "<!-- the operator's copy -->\n" });
  assert.equal(sb.kick().status, 1);
  assert.doesNotMatch(sb.calls(), /^(launchctl bootstrap|plutil) /m);
  assert.equal(read(sb.dst), "<!-- the operator's copy -->\n", "never overwritten");
  assert.deepEqual(sb.pages(), [PAGE]);
  assert.match(sb.log(), /present but not loaded — leaving it \(booted out on purpose\?\)\n$/);
});

test("bootstrap fails: the copy is removed so the next run retries, and the page carries the error", () => {
  const sb = sandbox({ bootstrapFails: true });
  assert.equal(sb.kick().status, 1);
  assert.match(sb.calls(), new RegExp(`^launchctl bootstrap gui/${UID} ${sb.dst}$`, "m"));
  assert.equal(fs.existsSync(sb.dst), false, "not left behind to read as booted out");
  assert.deepEqual(sb.pages(), [`${PAGE} (Installing it automatically failed: Bootstrap failed: 5: Input/output error)`]);
  assert.match(sb.log(), /ERROR: installing launchd agent ai\.claude\.hum-explore failed: Bootstrap failed: 5: Input\/output error\n/);
});

test("no plist in the repo: nothing to install, the page is word for word what it was", () => {
  const sb = sandbox({ repoPlist: null });
  assert.equal(sb.kick().status, 1);
  assert.doesNotMatch(sb.calls(), /^(launchctl bootstrap|plutil) /m);
  assert.equal(fs.existsSync(sb.dst), false);
  assert.deepEqual(sb.pages(), [PAGE]);
});

test("a repo plist that does not lint or names another label is never installed", () => {
  for (const bad of ["<plist><dict><key>Label</key>", REPO_PLIST.replace(`<string>${LABEL}</string>`, "<string>ai.claude.other</string>")]) {
    const sb = sandbox({ repoPlist: bad });
    assert.equal(sb.kick().status, 1);
    assert.match(sb.calls(), /^plutil -lint /m);
    assert.doesNotMatch(sb.calls(), /^launchctl bootstrap /m);
    assert.equal(fs.existsSync(sb.dst), false);
    assert.match(sb.pages()[0], /is not loaded on the server\. .*\(Installing it automatically failed: the repo plist ai\.claude\.hum-explore\.plist does not lint or its Label is not ai\.claude\.hum-explore\)$/);
  }
});

test("a repo plist that would start by itself (at load, kept alive, scheduled) is never installed by a kick", () => {
  const selfStarting = [
    ["RunAtLoad", REPO_PLIST.replace(/<key>RunAtLoad<\/key>\s*<false\/>/, "<key>RunAtLoad</key>\n    <true/>")],
    ["KeepAlive", REPO_PLIST.replace(/<key>KeepAlive<\/key>\s*<false\/>/, "<key>KeepAlive</key>\n    <true/>")],
    ["StartCalendarInterval", REPO_PLIST.replace(/<\/dict>\s*<\/plist>\s*$/, "    <key>StartCalendarInterval</key>\n    <dict><key>Hour</key><integer>3</integer></dict>\n</dict>\n</plist>\n")],
  ];
  for (const [key, plist] of selfStarting) {
    assert.notEqual(plist, REPO_PLIST, `fixture for ${key} changed nothing`);
    const sb = sandbox({ repoPlist: plist });
    assert.equal(sb.kick().status, 1);
    assert.doesNotMatch(sb.calls(), /^launchctl bootstrap /m);
    assert.equal(fs.existsSync(sb.dst), false);
    assert.match(sb.pages()[0], new RegExp(`is not loaded on the server\\. .*\\(Installing it automatically failed: the repo plist ai\\.claude\\.hum-explore\\.plist would start by itself \\(${key}\\), so it is installed by hand, not by a kick\\)$`));
  }
});

test("already loaded: one kickstart and nothing else", () => {
  const sb = sandbox({ loaded: true });
  assert.equal(sb.kick().status, 0);
  assert.equal(sb.calls(), `launchctl kickstart gui/${UID}/${LABEL}\n`);
  assert.match(sb.log(), /\[hum-explore\] kicked launchd agent ai\.claude\.hum-explore\n$/);
});
