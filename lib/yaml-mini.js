// yaml-mini.js — tiny YAML parser for the subset used by memory-system v2.
//
// Supports:
//   - nested mappings (indentation-based, 2 or 4 spaces)
//   - scalars: bare, "double quoted", 'single quoted'
//   - inline arrays: [a, b, "c d"]
//   - block arrays (key on its own line, children are `  - value`)
//   - line comments (# ...) and blank lines
//   - booleans (true/false/yes/no/null)
//   - numbers (ints + simple floats)
//
// NOT supported (throws or returns raw string):
//   - anchors/aliases (&foo *foo)
//   - multi-doc streams (---)
//   - folded/literal scalars (| >)
//   - explicit tags (!!str)
//
// This exists because the repo has a zero-deps discipline for memory tools.
// If we ever need more, adopt js-yaml.

"use strict";

function stripComment(line) {
  // Don't strip # inside quoted strings. Tracker-based.
  let inSingle = false,
    inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseInlineArray(raw) {
  // raw includes the brackets; e.g. `[a, "b c", 'd']`
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  const out = [];
  let buf = "";
  let inSingle = false,
    inDouble = false,
    depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        out.push(parseScalar(buf));
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim().length) out.push(parseScalar(buf));
  return out;
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

// Parse a block at a given minimum indent. Returns {value, consumed_lines}.
// Greedy: consumes as long as lines are indented ≥ minIndent.
function parseBlock(lines, startIx, minIndent) {
  // Check the first non-blank, non-comment line at/after startIx
  let i = startIx;
  // Skip blanks/comments
  while (i < lines.length) {
    const stripped = stripComment(lines[i]).replace(/\s+$/, "");
    if (stripped.trim() === "") {
      i++;
      continue;
    }
    break;
  }
  if (i >= lines.length) return { value: null, nextIx: i };

  const firstLine = stripComment(lines[i]).replace(/\s+$/, "");
  const firstIndent = indentOf(firstLine);

  // Block array detection: first significant line is `  - ...`
  if (firstIndent >= minIndent && firstLine.slice(firstIndent).startsWith("- ")) {
    const arr = [];
    let j = i;
    while (j < lines.length) {
      const L = stripComment(lines[j]).replace(/\s+$/, "");
      if (L.trim() === "") {
        j++;
        continue;
      }
      const ind = indentOf(L);
      if (ind < firstIndent) break;
      if (ind > firstIndent) break; // out of our block; will be consumed by caller
      const after = L.slice(firstIndent);
      if (!after.startsWith("- ")) break;
      const itemRaw = after.slice(2).trim();
      if (itemRaw === "") {
        // block child is a mapping on next lines
        const child = parseBlock(lines, j + 1, firstIndent + 2);
        arr.push(child.value);
        j = child.nextIx;
      } else if (itemRaw.includes(":") && !itemRaw.startsWith("[")) {
        // inline mapping on the same line as `- ` — parse as single-key map
        const kvMatch = itemRaw.match(/^([^:]+):\s*(.*)$/);
        if (kvMatch) {
          const obj = {};
          const k = kvMatch[1].trim();
          const v = kvMatch[2].trim();
          if (v === "") {
            const child = parseBlock(lines, j + 1, firstIndent + 2);
            obj[k] = child.value;
            j = child.nextIx;
          } else if (v.startsWith("[")) {
            obj[k] = parseInlineArray(v);
            j++;
          } else {
            obj[k] = parseScalar(v);
            j++;
          }
          arr.push(obj);
        } else {
          arr.push(parseScalar(itemRaw));
          j++;
        }
      } else if (itemRaw.startsWith("[")) {
        arr.push(parseInlineArray(itemRaw));
        j++;
      } else {
        arr.push(parseScalar(itemRaw));
        j++;
      }
    }
    return { value: arr, nextIx: j };
  }

  // Otherwise: mapping
  const map = {};
  let j = i;
  while (j < lines.length) {
    const L = stripComment(lines[j]).replace(/\s+$/, "");
    if (L.trim() === "") {
      j++;
      continue;
    }
    const ind = indentOf(L);
    if (ind < firstIndent) break;
    if (ind > firstIndent) {
      // Extra indent shouldn't happen at top of a block; skip defensively.
      j++;
      continue;
    }
    const body = L.slice(firstIndent);
    const kv = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      // Not a key:value; bail out of this block.
      break;
    }
    const k = kv[1];
    const v = kv[2];
    if (v === "") {
      // Nested value: either a mapping or a block array under next lines.
      const child = parseBlock(lines, j + 1, firstIndent + 2);
      map[k] = child.value;
      j = child.nextIx;
    } else if (v.startsWith("[")) {
      map[k] = parseInlineArray(v);
      j++;
    } else {
      map[k] = parseScalar(v);
      j++;
    }
  }
  return { value: map, nextIx: j };
}

function parse(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/);
  const { value } = parseBlock(lines, 0, 0);
  return value;
}

module.exports = { parse, parseScalar, parseInlineArray };
