// Minimal SKILL.md parser. No external deps — supports the subset of YAML
// we actually use (string values, kebab-case keys, single-line arrays).
//
// Returns { frontmatter, body, jsBlocks } where jsBlocks is an ordered
// array of every ```js fenced block in the body.
//
// The runtime contract for executable skill blocks: each block parses as
// a JS expression `({ name, description, inputSchema, execute })`. The
// last such block in a reference.md is what run-action.js executes.

import fs from 'node:fs';
import path from 'node:path';

const SCALAR_RE = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/;

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // Inline array: [a, b, c] or ["a", "b"]
  const arr = v.match(/^\[(.*)\]$/);
  if (arr) {
    return arr[1].split(',').map(s => parseScalar(s.replace(/^["']|["']$/g, '').trim()));
  }
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(text) {
  const fm = {};
  let currentKey = null;
  let listAccumulator = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    // List item under previous key
    if (line.startsWith('- ') || line.startsWith('  - ')) {
      if (!listAccumulator) {
        listAccumulator = [];
        fm[currentKey] = listAccumulator;
      }
      listAccumulator.push(parseScalar(line.replace(/^\s*-\s+/, '')));
      continue;
    }
    const m = line.match(SCALAR_RE);
    if (m) {
      currentKey = m[1];
      const value = m[2];
      if (value === '' || value === '|' || value === '>') {
        // Multi-line value or list — list will accumulate via subsequent `- ` lines
        listAccumulator = null;
        fm[currentKey] = '';
      } else {
        listAccumulator = null;
        fm[currentKey] = parseScalar(value);
      }
    }
  }
  return fm;
}

export function parseSkill(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`${filePath}: missing YAML frontmatter (file must start with ---)`);
  }
  const frontmatter = parseFrontmatter(fmMatch[1]);
  const body = fmMatch[2];
  const jsBlocks = [...body.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
  return { frontmatter, body, jsBlocks };
}

export function domainFromPath(filePath, skillsRoot) {
  const rel = path.relative(skillsRoot, filePath);
  return rel.split(path.sep)[0];
}

export function listSiteSkills(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  const out = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    const dir = path.join(skillsRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile)) out.push(skillFile);
  }
  return out.sort();
}

export function listReferenceFiles(siteDir) {
  const refDir = path.join(siteDir, 'references');
  if (!fs.existsSync(refDir)) return [];
  return fs.readdirSync(refDir)
    .filter(n => n.endsWith('.md') && !n.endsWith('.test.md'))
    .map(n => path.join(refDir, n))
    .sort();
}

// Extract the LAST ```js fenced block containing an `execute:` from a
// reference.md — that's the canonical executable action body per the
// upstream convention. Reference files do NOT require frontmatter
// (unlike SKILL.md), so we parse the JS blocks directly from raw text.
export function extractActionBlock(referencePath) {
  const raw = fs.readFileSync(referencePath, 'utf8');
  const blocks = [...raw.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (/\bexecute\b\s*:/.test(blocks[i])) return blocks[i];
  }
  return null;
}
