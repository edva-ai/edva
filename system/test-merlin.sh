#!/bin/bash
# test-merlin.sh — smoke + integration tests for the merlin CLI.
# Safe to run anytime: no dispatches to ops-agent, no mutations to state,
# except pause/resume roundtrip (which is quickly reverted).
#
# Exit 0 = all green. Exit 1 = a test failed.

set -u
: "${MERLIN_HOME:=${HOME}/Dev/merlin}"

G="${MERLIN_HOME}/bin/merlin"
PASS=0
FAIL=0
FAILURES=()

pass() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '    \033[2m%s\033[0m\n' "$2"; }

run() {
  local name="$1"; shift
  local expected_code="${EXPECT_CODE:-0}"
  local out; out=$("$@" 2>&1); local code=$?
  if [ "$code" = "$expected_code" ]; then pass "$name"
  else fail "$name" "exit=$code (wanted $expected_code): ${out:0:100}"; fi
}

assert_json() {
  local name="$1"; local filter="$2"; shift 2
  local expected="$1"; shift
  local got; got=$("$@" --json 2>&1 | jq -r "$filter" 2>&1)
  if [ "$got" = "$expected" ]; then pass "$name"
  else fail "$name" "got='$got' wanted='$expected'"; fi
}

echo
echo "=== merlin CLI test suite ==="

# --- core ---
echo
echo "[core]"
run "help exits 0" "$G" help
EXPECT_CODE=1 run "unknown subcommand exits 1" "$G" nonexistent

# --- tasks ---
echo
echo "[tasks]"
run "tasks list" "$G" tasks
run "tasks list --json" "$G" tasks --json
assert_json "tasks.json has 6 entries" '. | length' '6' "$G" tasks
run "tasks show morning-digest" "$G" tasks show morning-digest
EXPECT_CODE=1 run "tasks show unknown exits 1" "$G" tasks show nonexistent

# Matching
assert_json "match 'morning briefing' → morning-digest" '.matches[0].name' 'morning-digest' "$G" tasks match "morning briefing"
assert_json "match 'weekend activity list' → weekend-events" '.matches[0].name' 'weekend-events' "$G" tasks match "weekend activity list"
assert_json "match 'send the newsletters' → newsletter-digest" '.matches[0].name' 'newsletter-digest' "$G" tasks match "send the newsletters"
assert_json "match confidence is high when 1 match" '.confidence' 'high' "$G" tasks match "morning brief"
assert_json "match gibberish → none" '.confidence' 'none' "$G" tasks match "bla bla bla bla"
run "tasks match exit 0 for high-confidence" "$G" tasks match "morning brief"
EXPECT_CODE=1 run "tasks match exit 1 for no match" "$G" tasks match "bla bla bla"
run "tasks run --dry-run" "$G" tasks run morning-digest --dry-run
EXPECT_CODE=1 run "tasks run unknown exits 1" "$G" tasks run nonexistent

# --- services ---
echo
echo "[services]"
run "services" "$G" services
run "services --json" "$G" services --json

# --- status ---
echo
echo "[status]"
run "status" "$G" status
run "status --json" "$G" status --json

# --- cron ---
echo
echo "[cron]"
run "cron" "$G" cron

# --- git ---
echo
echo "[git]"
run "git" "$G" git

# --- ci ---
echo
echo "[ci]"
run "ci --limit 3" "$G" ci --limit 3

# --- logs ---
echo
echo "[logs]"
run "logs ops-agent --tail 3" "$G" logs ops-agent --tail 3
EXPECT_CODE=1 run "logs unknown exits 1" "$G" logs nonexistent-log

# --- triage ---
echo
echo "[triage]"
run "triage help" "$G" triage help
run "triage status" "$G" triage status
run "triage status --json" "$G" triage status --json
run "triage stats" "$G" triage stats
run "triage stats --since 24h" "$G" triage stats --since 24h
run "triage recent 5" "$G" triage recent 5
run "triage pending" "$G" triage pending
run "triage rules" "$G" triage rules
run "triage playbook" "$G" triage playbook

# pause/resume roundtrip
PAUSE_FLAG="${MERLIN_HOME}/data/.triage-paused"
echo "  (pause/resume roundtrip — will dispatch a CATCH UP task on resume)"
"$G" triage pause > /dev/null
[ -f "$PAUSE_FLAG" ] && pass "pause creates flag" || fail "pause creates flag"
"$G" triage resume > /dev/null
[ ! -f "$PAUSE_FLAG" ] && pass "resume clears flag" || fail "resume clears flag"

# --- arch ---
echo
echo "[arch]"
run "arch" "$G" arch

# --- where ---
echo
echo "[where]"
run "where example" "$G" where example
EXPECT_CODE=1 run "where nothing-matches exits 1" "$G" where xyz-no-such-thing

# --- doctor ---
echo
echo "[doctor]"
run "doctor (expect clean)" "$G" doctor
run "doctor --json" "$G" doctor --json

# doctor drift injection
echo "  (drift injection test)"
cp ${MERLIN_HOME}/system/tasks.json /tmp/_tasks_backup.json
sed -i '' 's/"Morning Digest"/"Drift-Injected"/' ${MERLIN_HOME}/system/tasks.json
if "$G" doctor > /dev/null 2>&1; then fail "drift detection catches bad playbook section"
else pass "drift detection catches bad playbook section"; fi
cp /tmp/_tasks_backup.json ${MERLIN_HOME}/system/tasks.json
rm /tmp/_tasks_backup.json

# --- summary ---
echo
echo "=== $((PASS+FAIL)) tests, $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
