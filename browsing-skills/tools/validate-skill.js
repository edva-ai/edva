#!/usr/bin/env node
// Validates every SKILL.md + references/*.md under skills/ and external/skills/.
//
// Checks:
//   1. Frontmatter present, has `name` + `description`.
//   2. `name` is kebab-case.
//   3. Action index in SKILL.md links to references/*.md that actually exist.
//   4. Every references/*.md has at least one ```js block whose top-level
//      shape is `({ ..., execute: ... })`.
//   5. Action JS block parses (we do a syntactic require-style check).
//
// Exits 1 on any failure. Designed for pre-commit + CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseSkill, listSiteSkills, listReferenceFiles, extractActionBlock } from './parse-skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

function validateOne(skillFile, errors) {
  const siteDir = path.dirname(skillFile);
  const siteName = path.basename(siteDir);

  let parsed;
  try {
    parsed = parseSkill(skillFile);
  } catch (e) {
    errors.push(`${skillFile}: ${e.message}`);
    return;
  }
  const { frontmatter, body } = parsed;

  if (!frontmatter.name) errors.push(`${skillFile}: frontmatter missing 'name'`);
  else if (!KEBAB.test(frontmatter.name)) errors.push(`${skillFile}: 'name' must be kebab-case (got '${frontmatter.name}')`);

  if (!frontmatter.description) errors.push(`${skillFile}: frontmatter missing 'description'`);

  // Link discipline: every references/*.md referenced in body must exist.
  const linked = new Set(
    [...body.matchAll(/\]\((references\/[^)#\s]+\.md)(?:#[^)]+)?\)/g)].map(m => path.join(siteDir, m[1]))
  );
  for (const ref of linked) {
    if (!fs.existsSync(ref)) errors.push(`${skillFile}: links to ${path.relative(siteDir, ref)} but file is missing`);
  }

  // Every references/*.md must validate as an executable action — unless
  // it's a `_*.md` companion file or a `*.test.md` snapshot.
  for (const refFile of listReferenceFiles(siteDir)) {
    const base = path.basename(refFile);
    if (base.startsWith('_')) continue;
    const block = extractActionBlock(refFile);
    if (!block) {
      errors.push(`${refFile}: missing a \`\`\`js ... \`\`\` block containing an action object`);
      continue;
    }
    // Syntactic check: wrap as expression, vm.compileFunction.
    try {
      new vm.Script(`(${block})`);
    } catch (e) {
      errors.push(`${refFile}: JS block does not parse — ${e.message.split('\n')[0]}`);
    }
  }

  // Display
  if (errors.length === 0 || !errors[errors.length - 1].startsWith(skillFile)) {
    process.stdout.write(`  ✓ ${path.relative(REPO_ROOT, skillFile)}\n`);
  }
}

function main() {
  const roots = [
    path.join(REPO_ROOT, 'skills'),
    path.join(REPO_ROOT, 'skills', '_ext'),        // an installation's overlay skills
    path.join(REPO_ROOT, 'external', 'skills'),
  ];
  const errors = [];
  let total = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = listSiteSkills(root);
    if (files.length === 0) continue;
    process.stdout.write(`\nValidating ${path.relative(REPO_ROOT, root)}/ (${files.length} sites)\n`);
    for (const f of files) {
      total++;
      validateOne(f, errors);
    }
  }
  if (errors.length) {
    process.stderr.write('\nERRORS:\n');
    for (const e of errors) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write(`\n${errors.length} error(s) across ${total} sites\n`);
    process.exit(1);
  }
  process.stdout.write(`\n✓ ${total} sites valid\n`);
}

main();
