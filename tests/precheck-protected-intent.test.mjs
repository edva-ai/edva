// precheck-protected-intent.test.mjs — the suppress-override belt only covers
// the intents whose revocation vocabulary it actually speaks.
//
// edva-send-curl overrides a precheck `suppress` for "protected" intents
// unless the precheck's own reason text cites an explicit user revocation.
// That test is a regex (REVOCATION_RE) built from the installation's
// protected_revocation vocabulary (agent/local/config/hum-lanes.json),
// written and validated against its protected lanes' pings. These tests run
// against a synthetic installation (a "practice" nudge lane plus health); the
// installation's own vocabulary is pinned in precheck-protected-intent-local.
//
// `p1-email` was once in the protected list but never got
// vocabulary of its own. The belt stayed conditional for it in principle —
// `rest`/`stop` are unbounded substrings, so "not inte(rest)ed" matches — but
// across all 39 p1-email observations in outbound-precheck-log.jsonl it never
// once tripped, so in practice it force-sent every one. (Read that count as
// "39 observations", not as a rate: only edva-send-curl writes the `intent`
// field, so an intent-tagged row is an override by construction.) 24 of the 39
// were claim-freshness (Rule #2) verdicts, a rule written ten weeks AFTER the
// belt.
// Once that sent a security alert minutes after the user had told
// Edva in chat that the activity was their own.
//
// These tests pin BOTH halves so the pairing cannot silently break again:
// which intents the belt covers, and the fact that its vocabulary is
// lane-shaped. Add a lane and the second test tells you what you owe it.
//
// lang-regex-ok: this file does not classify anything the user said. It reads
// the two regexes a shell script builds and asserts how they behave, so
// that an existing language regex cannot quietly widen its scope. The
// subjects below are synthetic copies of recorded precheck reasons.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEND = path.join(ROOT, "bin/edva-send-curl");

// A synthetic installation: a "practice" nudge lane and health are protected,
// with revocation vocabulary written for the practice pings.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "protected-intent-"));
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
fs.writeFileSync(path.join(LOCAL, "config", "hum-lanes.json"), JSON.stringify({
  protected_lanes: ["practice", "health"],
  protected_revocation: {
    phrases: "skip (today|tonight|this|practice|it)|rest day (today|declared)|not practicing|no practice (today|tonight)|don.?t (need|want) (the |a )?(practice|reminder|nudge|ping)|stop (pinging|nagging|reminding|bugging) me",
    said: "skip|rest|stop|no practice|not going",
    transcript: "skip|rest|no practice|not going",
  },
}));
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), "protected-intent-none-"));

// The two regexes exactly as a send builds them (EDVA_SEND_PRINT_PROTECTION
// prints them and exits before anything is sent).
function protection(localDir) {
  const out = execFileSync("bash", [SEND], {
    encoding: "utf8", timeout: 20000,
    env: { ...process.env, EDVA_SEND_PRINT_PROTECTION: "1", EDVA_LOCAL_DIR: localDir, EDVA_OWNER_NAME: "Alex" },
  });
  const get = (k) => (out.split("\n").find((l) => l.startsWith(`${k}=`)) || "").slice(k.length + 1);
  return { protectedRe: get("PROTECTED_INTENT_RE"), revocationRe: get("REVOCATION_RE") };
}
const SYNTH = protection(LOCAL);

// Evaluate exactly as the script does: `[[ "$INTENT" =~ $PROTECTED_INTENT_RE ]]`
function isProtected(intent, re = SYNTH.protectedRe) {
  if (!re) return false; // no protected lanes: the belt never fires
  return spawnRc("bash", ["-c", 'RE=$1; V=$2; [[ "$V" =~ $RE ]]', "_", re, intent]) === 0;
}

// Evaluate exactly as the script does: `printf %s "$REASON" | grep -qiE "$RE"`
function readsAsRevocation(reason) {
  return spawnRc("bash", ["-c", 'RE=$1; V=$2; printf "%s" "$V" | grep -qiE "$RE"', "_", SYNTH.revocationRe, reason]) === 0;
}

function spawnRc(cmd, args) {
  try { execFileSync(cmd, args, { stdio: "ignore", timeout: 10000 }); return 0; }
  catch (e) { return e.status ?? -1; }
}

test("the installation's protected lanes are protected", () => {
  for (const i of [
    "hum:practice:pre-slot",
    "hum:practice:post-slot-miss",
    "hum:practice:evening-recovery",
    "hum:health:weight-stale",
  ]) assert.equal(isProtected(i), true, `${i} should be protected`);
});

test("without protected_lanes the belt protects nothing (the kernel default)", () => {
  const none = protection(EMPTY);
  assert.equal(none.protectedRe, "");
  for (const i of ["hum:practice:pre-slot", "hum:health:weight-stale", "p1-email"]) assert.equal(isProtected(i, none.protectedRe), false, i);
  assert.ok(none.revocationRe.includes("stop (pinging|nagging|reminding|bugging) me"), "lane-neutral default vocabulary");
});

test("p1-email is out of the belt's scope — the precheck's verdict stands", () => {
  assert.equal(isProtected("p1-email"), false);
});

test("ordinary intents are unaffected", () => {
  for (const i of ["hum:music", "ticket-confirmation", "finance-alert", "guest-checkin", ""])
    assert.equal(isProtected(i), false, `${i || "(empty)"} should not be protected`);
});

test("a real revocation is respected, an inferred one is overridden", () => {
  assert.equal(readsAsRevocation("the user wrote 'skip today' in chat at 14:32"), true);
  assert.equal(readsAsRevocation("User said in chat 'rest day today' at 09:15"), true);
  assert.equal(readsAsRevocation("Alex said practice is off, skip it"), true);
  assert.equal(readsAsRevocation("11am slot sliding was a real calendar conflict. Nagging is wrong"), false);
});

test("the belt is lane-SHAPED, not lane-only — so scope is the fix, not vocabulary", () => {
  // The tempting story is that a p1-email reason could never match, which
  // would make the override unconditional. It is false, and pinning it here
  // stops the false version being reintroduced as a justification.
  // `stop (pinging|…) me` is intent-neutral, and `rest`/`stop` sit in the
  // regex as unbounded substrings — "not inte(rest)ed" matches.
  assert.equal(readsAsRevocation("the user replied they are not interested in the Acme thread"), true);
  assert.equal(readsAsRevocation("the user asked me to stop pinging about this thread"), true);
});

test("none of the reasons the belt actually reversed looked like a revocation", () => {
  // Reasons in the shape outbound-precheck-log.jsonl records (synthetic
  // stand-ins). Each is a suppression the precheck got RIGHT and the old belt
  // force-sent anyway, because none of them contains a revocation phrase.
  // The first two are `stale premise:` verdicts from the claim-freshness gate
  // (Rule #2), which runs before Sonnet's prompt.
  const recorded = [
    "stale premise: inbox: Sam Doe already replied re: a quote request — claim overtaken by event",
    "stale premise: the app is already In Review (as of Monday), superseding the rejected status; nothing pending on the vendor",
    "the user confirmed earlier that both login alerts were their own sign-ins, no intruder — this repeats the same resolved topic.",
    "Same exact P1 email already pinged twice today (morning and afternoon) for this identical Acme Contact Form thread — third duplicate.",
    "stale premise: events: the user already replied to Acme themselves, closing the loop",
  ];
  for (const r of recorded) {
    assert.equal(readsAsRevocation(r), false,
      `this one WOULD have been respected, so it cannot illustrate the finding: ${r}`);
  }
});
