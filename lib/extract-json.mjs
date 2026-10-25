// extract-json.mjs — pull a JSON object out of a model's text reply, robustly.
//
// Why this exists (2026-10-04 determinism review). The hum harvesters that
// fork a `claude -p`, and another job's error-recovery path, all extracted their JSON with a GREEDY `/\{[\s\S]*\}/`
// match. Greedy means "from the first `{` anywhere to the last `}` anywhere",
// so any prose with a brace in it — a model saying "I found {two} options"
// before the object, or a trailing note after it — produced a span that is not
// JSON, the parse threw, and the lane silently emitted nothing for that tick.
//
// This scans for balanced `{…}` spans instead, honouring JSON string literals
// and escapes (a `}` inside "a } b" is not a closing brace), and returns the
// first span that parses — optionally the first that carries a required key,
// so a stray `{}` in prose can never win over the real payload.
//
// It operates on MACHINE OUTPUT (a model asked to emit a JSON object), never on
// anything the user said — structure, not language (Rule #0b).

/**
 * Every balanced top-level `{...}` span in `text`, in order of appearance.
 * String-literal aware: braces inside "..." (with \" escapes) do not count.
 */
export function balancedObjectSpans(text) {
  const s = String(text ?? "");
  const spans = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { spans.push(s.slice(start, i + 1)); start = -1; }
    }
  }
  return spans;
}

/**
 * The first balanced span that parses as a JSON object (and, when `requireKey`
 * is given, has that own property). Returns null when nothing qualifies — the
 * caller keeps its own fail-open path.
 *
 * Falls back to re-scanning from every `{` when the left-to-right scan found
 * nothing, which recovers an object that follows an unbalanced brace in prose
 * (e.g. "use { carefully: {\"items\":[]}").
 */
export function extractJsonObject(text, { requireKey = null } = {}) {
  const s = String(text ?? "");
  const tryParse = (span) => {
    try {
      const v = JSON.parse(span);
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      if (requireKey && !Object.prototype.hasOwnProperty.call(v, requireKey)) return null;
      return v;
    } catch { return null; }
  };
  for (const span of balancedObjectSpans(s)) {
    const v = tryParse(span);
    if (v) return v;
  }
  // Recovery: an unmatched `{` earlier in the prose swallows the real object
  // into one unterminated span. Re-scan from each later `{`.
  for (let i = s.indexOf("{", 1); i > 0; i = s.indexOf("{", i + 1)) {
    for (const span of balancedObjectSpans(s.slice(i))) {
      const v = tryParse(span);
      if (v) return v;
    }
  }
  return null;
}
