// quote-check.mjs — is a model's `evidence` quote really on the page?
//
// The grounding half of the associative-memory writers' validation (trigger
// cues in wiki-embed.mjs, facts in wiki-facts.mjs, eval questions in
// bin/wiki-recall-eval-gen): a claim must arrive with the words that support
// it, and those words must appear verbatim in the source. An invented claim
// has nothing to quote. See model-ladder.mjs for the full rationale.
//
// Character-level normalization only (case, runs of whitespace), so a quote
// survives line wrapping and markdown re-flow. It compares strings; it decides
// nothing about what anyone meant.

function norm(s) {
  let out = "";
  let space = false;
  for (const ch of String(s || "").toLowerCase()) {
    const ws = ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
    if (ws) { space = true; continue; }
    if (space && out) out += " ";
    space = false;
    out += ch;
  }
  return out;
}

// Is `quote` (at least minLen chars after normalization) verbatim inside
// `source`?
export function quoteIn(quote, source, { minLen = 8 } = {}) {
  const q = norm(quote);
  if (q.length < minLen) return false;
  return norm(source).includes(q);
}
