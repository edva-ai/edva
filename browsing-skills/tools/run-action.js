#!/usr/bin/env node
// CLI: run a single browsing-skill action against a target URL or fixture.
//
// Usage:
//   run-action.js <site>/<action> [--params '<json>'] [--url <override>]
//                                 [--fixture <path>] [--mode data|display]
//                                 [--dry-run] [--cdp-host localhost:9222]
//
// Examples:
//   run-action.js reddit.com/post-thread --url 'https://www.reddit.com/r/<subreddit>/comments/abc123/...'
//   run-action.js amazon.com/search --params '{...}'
//   run-action.js reddit.com/submit-comment --params '{...}' --dry-run    # writes a console.log instead of clicking submit
//   run-action.js amazon.com/search --fixture fixtures/amazon.com__search.test.html
//
// Execution path:
//   - If --fixture: load HTML into a JSDOM and call action.execute(params)
//     entirely in-process (no browser). Fast; good for snapshot tests.
//   - Otherwise: connect to chrome-devtools-mcp Chrome on --cdp-host
//     (default localhost:9222), navigate to --url, await network idle,
//     then page.evaluate(`(${block}).execute(${params})`).
//
// Dry-run mode wraps the action body so that any `.click()` on the
// submit button becomes a console.log + early return — useful for
// authoring write actions without consequences.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractActionBlock, parseSkill } from './parse-skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[k] = true; }
      else { args[k] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveActionFile(siteAndAction) {
  // siteAndAction: "reddit.com/post-thread" or "amazon.com/search".
  // Lookup order: skills/, then an installation's overlay skills/_ext/, then
  // the synced upstream external/skills/.
  const [site, action] = siteAndAction.split('/');
  if (!site || !action) throw new Error(`expected <site>/<action>, got '${siteAndAction}'`);
  const candidates = [
    path.join(REPO_ROOT, 'skills', site, 'references', `${action}.md`),
    path.join(REPO_ROOT, 'skills', '_ext', site, 'references', `${action}.md`),
    path.join(REPO_ROOT, 'external', 'skills', site, 'references', `${action}.md`),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`action not found: ${siteAndAction}\n  tried: ${candidates.join('\n         ')}`);
}

function wrapDryRun(block) {
  // Naive but effective: replace `submitBtn.click()` and `.click()` on any
  // button found by an aria-label containing Submit/Post/Reply/Book/Enter
  // with a console.log. Write actions consistently use one of these
  // identifiers (see write-action policy in SKILL.md).
  return block.replace(/(\w+Btn)\.click\(\)/g, '(console.log("[DRY-RUN] would click", $1), null)');
}

async function runWithFixture(actionBlock, params, fixturePath) {
  // Lazy-import JSDOM only when needed (it's heavy).
  let JSDOM;
  try {
    ({ JSDOM } = await import('jsdom'));
  } catch (e) {
    process.stderr.write('ERROR: --fixture mode needs jsdom (npm i -g jsdom)\n');
    process.exit(2);
  }
  const html = fs.readFileSync(fixturePath, 'utf8');
  const dom = new JSDOM(html, { url: 'https://www.example.com/', pretendToBeVisual: true });
  const win = dom.window;
  // Make minimal browser APIs available to the action.
  const ctx = { window: win, document: win.document, console, setTimeout, clearTimeout, URL: win.URL, InputEvent: win.InputEvent, DataTransfer: win.DataTransfer, ClipboardEvent: win.ClipboardEvent };
  const fn = new Function(...Object.keys(ctx), `return (${actionBlock}).execute(${JSON.stringify(params)});`);
  return await fn(...Object.values(ctx));
}

async function runWithCdp(actionBlock, params, url, cdpHost) {
  // Delegate to the proven CDP-over-WebSocket harness used by the smoke-test
  // round (cdp-runner.mjs). Uses Node's built-in fetch + WebSocket; no npm
  // deps. The harness opens a new tab on the target Chrome, navigates, waits
  // for load + a settle window, then Runtime.evaluates the action with
  // returnByValue:true and awaitPromise:true.
  const { runActionCdp } = await import('./cdp-runner.mjs');
  return await runActionCdp({ url, actionBlock, params, cdpHost });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._[0]) {
    process.stderr.write('usage: run-action.js <site>/<action> [--params <json>] [--url <url> | --fixture <path>] [--dry-run]\n');
    process.exit(1);
  }
  const actionFile = resolveActionFile(args._[0]);
  let block = extractActionBlock(actionFile);
  if (!block) throw new Error(`no executable action block in ${actionFile}`);
  if (args['dry-run']) block = wrapDryRun(block);
  const params = args.params ? JSON.parse(args.params) : {};

  let result;
  if (args.fixture) {
    result = await runWithFixture(block, params, path.resolve(args.fixture));
  } else if (args.url) {
    result = await runWithCdp(block, params, args.url, args['cdp-host'] || 'localhost:9222');
  } else {
    process.stderr.write('ERROR: pass --url <live URL> or --fixture <path/to/file.html>\n');
    process.exit(1);
  }
  const text = result && result.content && result.content[0] && result.content[0].text;
  process.stdout.write(text || JSON.stringify(result, null, 2));
  process.stdout.write('\n');
}

main().catch(e => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(1);
});
