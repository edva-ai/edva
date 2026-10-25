// hum-run-log — the tick trace must survive whatever the agent turn put in it.
//
// These cases are taken from the real corruption modes measured in
// data/hum-runs.jsonl on 2026-09-15 (494 bad lines of 5137, first at
// line 81): a raw newline inside a harvester error string, a pretty-printed
// record, and a record glued onto a previous append that had no trailing
// newline. Each one used to break the one-record-per-line invariant; each one
// is now impossible to produce through `append`.
//
// Paths are derived from import.meta.url, never $HOME — pinned to $HOME a test
// running inside a git worktree silently exercises the MAIN checkout, so a
// change could pass its own tests without ever having been executed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "../bin/hum-run-log");

function run(args, { input = "", file, lastHarvest = "/nonexistent/hum-last-harvest.json" } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, HUM_RUNS_FILE: file, HUM_LAST_HARVEST: lastHarvest },
  });
}

function freshFile(contents = "") {
  const dir = mkdtempSync(join(tmpdir(), "hum-run-log-"));
  const f = join(dir, "hum-runs.jsonl");
  writeFileSync(f, contents);
  return f;
}

function lines(f) {
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
}

describe("append writes exactly one line, whatever is in the payload", () => {
  test("a raw newline inside a string value does not split the record", () => {
    const file = freshFile();
    const rec = {
      tick_id: "t-20260915-0900",
      ts: "2026-09-15T13:00:00Z",
      harvest: { errors: [{ topic: "stocks", err: "no cached positions\nretrying later" }] },
    };
    const r = run(["append"], { input: JSON.stringify(rec), file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(file).length, 1, "record must occupy exactly one line");
    assert.deepEqual(JSON.parse(lines(file)[0]), rec);
  });

  test("quotes, backslashes and unicode round-trip", () => {
    const file = freshFile();
    const rec = {
      tick_id: "t-1",
      ts: "2026-09-15T13:00:00Z",
      sonnet: { rationale: 'he said "no" \\ then left — café ☕\nsecond line' },
    };
    const r = run(["append"], { input: JSON.stringify(rec), file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(file).length, 1);
    assert.deepEqual(JSON.parse(lines(file)[0]), rec);
  });

  test("pretty-printed input collapses to a single compact line", () => {
    const file = freshFile();
    const rec = { tick_id: "t-2", ts: "2026-09-15T13:00:00Z", outcome: { sent: false } };
    const r = run(["append"], { input: JSON.stringify(rec, null, 2), file });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(file).length, 1);
    assert.deepEqual(JSON.parse(lines(file)[0]), rec);
  });

  test("a previous append with no trailing newline is healed, not glued", () => {
    // This is the "Extra data" mode: 386 of the 494 bad lines.
    const file = freshFile('{"tick_id":"t-old","ts":"2026-09-15T12:00:00Z"}');
    const rec = { tick_id: "t-new", ts: "2026-09-15T13:00:00Z" };
    const r = run(["append"], { input: JSON.stringify(rec), file });
    assert.equal(r.status, 0, r.stderr);
    const ls = lines(file);
    assert.equal(ls.length, 2, "must not glue the new record onto the old one");
    assert.equal(JSON.parse(ls[0]).tick_id, "t-old");
    assert.equal(JSON.parse(ls[1]).tick_id, "t-new");
  });

  test("appends accumulate without corrupting each other", () => {
    const file = freshFile();
    for (let i = 0; i < 25; i++) {
      const r = run(["append"], {
        input: JSON.stringify({ tick_id: `t-${i}`, ts: "2026-09-15T13:00:00Z", note: "a\nb" }),
        file,
      });
      assert.equal(r.status, 0, r.stderr);
    }
    const ls = lines(file);
    assert.equal(ls.length, 25);
    for (const l of ls) JSON.parse(l); // must not throw
  });

  test("non-object and non-JSON payloads are refused, not written", () => {
    const file = freshFile();
    assert.notEqual(run(["append"], { input: "not json", file }).status, 0);
    assert.notEqual(run(["append"], { input: "[1,2]", file }).status, 0);
    assert.notEqual(run(["append"], { input: "", file }).status, 0);
    assert.equal(lines(file).length, 0);
  });
});

describe("read does not abort at the first bad line, and never hides the skip", () => {
  // jq aborts here; the JS readers in bin/edva drop silently. Neither
  // is acceptable: the caller must get the good records AND the damage count.
  const damaged = [
    '{"tick_id":"t-1","ts":"2026-09-15T10:00:00Z"}',
    '{"tick_id":"t-2","ts":"2026-09-15T11:00:00Z","err":"split',
    'across lines"}',
    '{"tick_id":"t-3","ts":"2026-09-15T12:00:00Z"}',
    "{",
  ].join("\n") + "\n";

  test("returns every well-formed record past the damage", () => {
    const file = freshFile(damaged);
    const r = run(["read", "--json"], { file });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.records.map((x) => x.tick_id), ["t-1", "t-3"]);
    assert.equal(out.skipped, 3);
  });

  test("reports the skipped count on stderr for a human caller", () => {
    const file = freshFile(damaged);
    const r = run(["read"], { file });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /skipped 3 unparseable line/);
  });

  test("a clean file reports nothing on stderr", () => {
    const file = freshFile('{"tick_id":"t-1","ts":"2026-09-15T10:00:00Z"}\n');
    const r = run(["read"], { file });
    assert.equal(r.stderr.trim(), "");
  });

  test("--tail and --since narrow the well-formed records", () => {
    const file = freshFile(damaged);
    const tail = JSON.parse(run(["read", "--json", "--tail", "1"], { file }).stdout);
    assert.deepEqual(tail.records.map((x) => x.tick_id), ["t-3"]);
    const since = JSON.parse(
      run(["read", "--json", "--since", "2026-09-15T11:30:00Z"], { file }).stdout
    );
    assert.deepEqual(since.records.map((x) => x.tick_id), ["t-3"]);
  });

  test("a missing file reads as empty rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hum-run-log-"));
    const r = run(["read", "--json"], { file: join(dir, "absent.jsonl") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).records, []);
  });
});

describe("check reports integrity without changing anything", () => {
  test("locates the first and last bad line", () => {
    const file = freshFile(
      [
        '{"tick_id":"t-1","ts":"2026-09-15T10:00:00Z"}',
        "{",
        '{"tick_id":"t-2","ts":"2026-09-15T11:00:00Z"}',
        "oops",
      ].join("\n") + "\n"
    );
    const before = readFileSync(file, "utf8");
    const out = JSON.parse(run(["check", "--json"], { file }).stdout);
    assert.equal(out.total_lines, 4);
    assert.equal(out.parsed, 2);
    assert.equal(out.skipped, 2);
    assert.equal(out.first_bad_line, 2);
    assert.equal(out.last_bad_line, 4);
    assert.equal(readFileSync(file, "utf8"), before, "check must be read-only");
  });
});

describe("repair (2026-10-06)", () => {
  test("rejoins split strings, pretty-printed and glued records; quarantines the truncated; backs up", () => {
    const dir = mkdtempSync(join(tmpdir(), "hum-run-log-repair-"));
    const file = join(dir, "hum-runs.jsonl");
    const lines = [
      '{"ts":"2026-04-01T00:00:00Z","n":1}',
      '{"ts":"2026-04-01T00:20:00Z","err":"fetch failed', 'at line 2"}',      // raw newline inside a string
      "{", '  "ts": "2026-04-01T00:40:00Z",', '  "n": 3', "}",               // pretty-printed
      '{"ts":"2026-04-01T01:00:00Z","n":4}{"ts":"2026-04-01T01:20:00Z","n":5}', // glued
      '{"ts":"2026-04-01T01:40:00Z","n":',                                    // truncated
      '{"ts":"2026-04-01T02:00:00Z","n":7}',
    ];
    writeFileSync(file, lines.join("\n") + "\n");
    const r = run(["repair"], { file });
    assert.equal(r.status, 0, r.stderr);
    const sum = JSON.parse(r.stdout);
    assert.equal(sum.changed, true);
    assert.equal(sum.recovered_records, 4);
    assert.equal(sum.quarantined_fragments, 1);
    const after = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(after.map((x) => x.ts.slice(11, 16)), ["00:00", "00:20", "00:40", "01:00", "01:20", "02:00"]);
    assert.equal(after[1].err, "fetch failed\nat line 2");
    assert.equal(readFileSync(sum.backup, "utf8"), lines.join("\n") + "\n");
    assert.match(readFileSync(sum.quarantine_file, "utf8"), /01:40/);
    const chk = JSON.parse(run(["check", "--json"], { file }).stdout);
    assert.equal(chk.skipped, 0);
  });

  test("--dry-run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hum-run-log-repair-"));
    const file = join(dir, "hum-runs.jsonl");
    writeFileSync(file, '{"a":1}\n{"b":\n2}\n');
    const r = run(["repair", "--dry-run"], { file });
    assert.equal(JSON.parse(r.stdout).recovered_records, 1);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"b":\n2}\n');
  });
});

test("repair closes a tick that only lost its final brace, but not one that lost an inner brace", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-run-log-repair-"));
  const file = join(dir, "hum-runs.jsonl");
  writeFileSync(file, [
    '{"tick_id":"t-1","ts":"2026-04-17T20:00:00Z","decision":{"score":0.3},"outcome":{"sent":false}',
    '{"tick_id":"t-2","ts":"2026-04-17T20:20:00Z","decision":{"score":0.3,"outcome":{"sent":false}}',
  ].join("\n") + "\n");
  const sum = JSON.parse(run(["repair"], { file }).stdout);
  assert.equal(sum.recovered_records, 1);
  assert.equal(sum.quarantined_fragments, 1);
  const after = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(after.map((r) => r.tick_id), ["t-1"]);
  assert.equal(after[0].outcome.sent, false);
});

test("an indented line that parses is a torn array item, not a record — repair rejoins it", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-run-log-repair-"));
  const file = join(dir, "hum-runs.jsonl");
  writeFileSync(file, ["{", '  "tick_id": "t-1",', '  "harvest": [', '      {"topic":"music","err":"x"}', "  ]", "}"].join("\n") + "\n");
  assert.equal(JSON.parse(run(["check", "--json"], { file }).stdout).parsed, 0);
  const sum = JSON.parse(run(["repair"], { file }).stdout);
  assert.equal(sum.recovered_records, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).harvest, [{ topic: "music", err: "x" }]);
});

test("repair restores a brace lost mid-record when exactly one position fits the tick shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "hum-run-log-repair-"));
  const file = join(dir, "hum-runs.jsonl");
  writeFileSync(file, '{"tick_id":"t-9","ts":"2026-05-07T21:13:44Z","situation":{},"harvest":{"n":1,"sonnet":{"score":0.4,"memory_hook":null},"outcome":{"sent":false}}\n');
  const sum = JSON.parse(run(["repair"], { file }).stdout);
  assert.equal(sum.recovered_records, 1);
  const r = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(r), ["tick_id", "ts", "situation", "harvest", "sonnet", "outcome"]);
  assert.deepEqual(r.harvest, { n: 1 });
  assert.equal(r.sonnet.memory_hook, null);
});

test("append replaces the turn's harvest candidates with the same tick's saved harvest", () => {
  const f = freshFile();
  const lh = join(dirname(f), "last.json");
  const long = "Harbor Jazz Festival 2026 at the Town Hall, Oct 5-7 — " + "x".repeat(120);
  writeFileSync(lh, JSON.stringify({
    meta: { ts: "2026-10-07T17:05:00Z" },
    candidates: [{ topic: "music", signal: long, dedup_key: "music:harbor-jazz", urgency: 0.4, freshness_min: 5, supporting_data: { big: true } }],
  }));
  const rec = { ts: "2026-10-07T17:06:00Z", harvest: { candidates: [{ topic: "music", signal: "jazz fest (paraphrased)" }] }, sonnet: { near_miss_candidates: [{ topic: "music", signal: "kept" }] } };
  const r = run(["append"], { input: JSON.stringify(rec), file: f, lastHarvest: lh });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(lines(f)[0]);
  assert.deepEqual(got.harvest.candidates, [{ topic: "music", urgency: 0.4, freshness_min: 5, dedup_key: "music:harbor-jazz", signal: long }]);
  assert.equal(got.harvest.candidates_source, "hum-last-harvest");
  assert.equal(got.sonnet.near_miss_candidates[0].signal, "kept");
});

test("append keeps each candidate's own link, from the harvester's structured fields only", () => {
  const f = freshFile();
  const lh = join(dirname(f), "last.json");
  const nyt = "https://news.example.com/2026/03/15/world/winter-energy-plan.html";
  writeFileSync(lh, JSON.stringify({
    meta: { ts: "2026-10-15T13:32:00Z" },
    candidates: [
      { topic: "news", signal: "Why the City Is Rethinking", dedup_key: `news:${nyt}`, supporting_data: { top: { title: "t", link: nyt } } },
      { topic: "talks", signal: "Talk\nhttps://lot.example/e/1", dedup_key: "talks:1", supporting_data: { url: "https://lot.example/e/1" } },
      { topic: "dining", signal: "Place", dedup_key: "dining:p", supporting_data: { maps_url: "https://maps.google.com/?cid=1" } },
      { topic: "art", signal: "Show", dedup_key: "art:a", supporting_data: { candidate: { url: "not a link" } } },
      { topic: "music", signal: "x".repeat(300), dedup_key: "music:m" },
    ],
  }));
  run(["append"], { input: JSON.stringify({ ts: "2026-10-15T13:33:00Z", harvest: { candidates: [] } }), file: f, lastHarvest: lh });
  const got = JSON.parse(lines(f)[0]).harvest.candidates;
  assert.deepEqual(got.map((c) => c.url ?? null), [nyt, "https://lot.example/e/1", "https://maps.google.com/?cid=1", null, null]);
  assert.equal(got[4].signal.length, 240);
  assert.equal("url" in got[3], false, "no url key when there is no link");
});

test("append leaves the trace alone when the saved harvest is from a different tick", () => {
  const f = freshFile();
  const lh = join(dirname(f), "last.json");
  writeFileSync(lh, JSON.stringify({ meta: { ts: "2026-10-07T10:00:00Z" }, candidates: [{ topic: "art", signal: "Show", dedup_key: "art:a1" }] }));
  run(["append"], { input: JSON.stringify({ ts: "2026-10-07T17:06:00Z", harvest: { candidates: [{ topic: "art", signal: "Show" }] } }), file: f, lastHarvest: lh });
  assert.deepEqual(JSON.parse(lines(f)[0]).harvest.candidates, [{ topic: "art", signal: "Show" }]);
});
