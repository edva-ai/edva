// email-mem-supersede.test.mjs — a superseded memory must not reach the classifier.
//
// `email-mem supersede <id> --by <id>` wrote a `superseded-by-#N` tag that
// nothing ever read, so retiring a triage rule left its precedent rows still
// ranking in the block triage consults at Step 2. When one exception was
// retired, dozens of rows describing the OLD behavior
// ("personal + mark-read, no p1, no star") kept out-ranking the single policy
// row that replaced them. The filter lives on the classifier-facing path only —
// `search` / `list` still show superseded rows, because history matters.
//
// Runs against a throwaway copy of the module with its own database, so nothing
// here can reach the live store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function freshModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-mem-supersede-"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.mkdirSync(path.join(dir, "data"));
  const target = path.join(dir, "lib", "email-memory.js");
  fs.copyFileSync(path.join(ROOT, "lib", "email-memory.js"), target);
  return createRequire(import.meta.url)(target);
}

test("searchForEmail drops superseded rows and promotes live ones", () => {
  const em = freshModule();

  // Six rows on the same subject, so the top-5 window is genuinely contested.
  const stale = [];
  for (let i = 0; i < 5; i++) {
    stale.push(
      em.add({
        text: `Reply-echo from edva on the Weekly Digest thread (#${i}) — personal + mark-read, no p1, no star.`,
        tags: "personal,example.com,reply-echo",
      })
    );
  }
  const policy = em.add({
    text: "POLICY 2026-08-17: a Weekly Digest reply-echo from edva IS P1 — star + p1 label, left unread.",
    tags: "policy,example.com,reply-echo",
  });

  const query = { from: "Edva <edva@example.com>", subject: "Re: Weekly Digest: 3 new shows" };
  assert.equal(em.searchForEmail(query).length, 5, "baseline: the block is full");

  for (const id of stale) em.update(id, { tags: `personal,example.com,reply-echo,superseded-by-#${policy}` });

  const after = em.searchForEmail(query);
  assert.deepEqual(
    after.map((r) => r.id),
    [policy],
    "only the superseding policy row survives on the classifier path"
  );
  assert.ok(
    em.formatForPrompt(query).includes("IS P1"),
    "the prompt block carries the live policy, not the retired one"
  );

  // History is untouched: `search` still sees every row.
  assert.equal(em.search("reply-echo edva", 30).length, 6, "search still returns superseded rows");
});
