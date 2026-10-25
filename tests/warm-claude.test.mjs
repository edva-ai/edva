// warm-claude: serialized calls over one stream-json child, fail-open on
// timeout/exit, recycled after maxCalls. Uses a fake child — no real claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WarmClaude } from "../lib/warm-claude.mjs";

function fakeSpawn(behavior) {
  const spawned = [];
  const fn = (bin, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.args = args;
    child.kill = () => child.emit("exit", 0);
    child.stdin.on("data", (d) => {
      for (const line of String(d).split("\n").filter(Boolean)) {
        const msg = JSON.parse(line).message.content;
        behavior(child, msg);
      }
    });
    spawned.push(child);
    return child;
  };
  fn.spawned = spawned;
  return fn;
}
const reply = (child, text) => setImmediate(() => child.stdout.write(JSON.stringify({ type: "result", result: text }) + "\n"));

test("answers serialized calls from one warm child", async () => {
  const sp = fakeSpawn((c, msg) => reply(c, msg.endsWith("A") ? "[1]" : "[2]"));
  const w = new WarmClaude({ model: "m", spawnFn: sp });
  const [a, b] = await Promise.all([w.run("A"), w.run("B")]);
  assert.equal(a, "[1]");
  assert.equal(b, "[2]");
  assert.equal(sp.spawned.length, 1);
  assert.ok(sp.spawned[0].args.includes("stream-json"));
  assert.ok(!sp.spawned[0].args.includes("text"), "no --output-format text left over");
  w.close();
});

test("prompts are marked independent", async () => {
  let seen = "";
  const sp = fakeSpawn((c, msg) => { seen = msg; reply(c, "ok"); });
  const w = new WarmClaude({ model: "m", spawnFn: sp });
  await w.run("judge this");
  assert.match(seen, /independent task/);
  assert.match(seen, /judge this$/);
  w.close();
});

test("timeout fails open with empty string and recycles the child", async () => {
  const sp = fakeSpawn(() => {}); // never answers
  const w = new WarmClaude({ model: "m", spawnFn: sp });
  assert.equal(await w.run("x", { timeoutMs: 30 }), "");
  const sp2Count = sp.spawned.length;
  // next call spawns a fresh child
  const p = w.run("y", { timeoutMs: 30 });
  assert.equal(await p, "");
  assert.equal(sp.spawned.length, sp2Count + 1);
  w.close();
});

test("recycles after maxCalls", async () => {
  const sp = fakeSpawn((c) => reply(c, "ok"));
  const w = new WarmClaude({ model: "m", spawnFn: sp, maxCalls: 2 });
  for (let i = 0; i < 5; i++) await w.run(String(i));
  assert.equal(sp.spawned.length, 3);
  w.close();
});

test("child exit mid-call resolves empty", async () => {
  const sp = fakeSpawn((c) => setImmediate(() => c.emit("exit", 1)));
  const w = new WarmClaude({ model: "m", spawnFn: sp });
  assert.equal(await w.run("x"), "");
  w.close();
});
