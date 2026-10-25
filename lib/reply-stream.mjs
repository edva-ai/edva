// reply-stream.mjs — stream the chat agent's reply text while it is written.
//
// The chat agent answers by calling the phone-channel `reply` tool, so the
// answer is a tool ARGUMENT. With `claude -p --include-partial-messages` the
// CLI emits that argument as `input_json_delta` chunks while the model writes
// it. The supervisor feeds those events to a ReplyDraftTracker and serves the
// drafts on GET /reply-draft; phone-channel polls that and paints the text
// into the chat row, so a long answer starts appearing ~1s after the agent
// begins writing instead of when it finishes.
//
// Everything here is structural (JSON + markdown delimiters). Nothing reads
// meaning from what anyone wrote.

export const REPLY_TOOL_NAME = "mcp__phone-channel__reply";

// Decode the value of a top-level string field from a JSON object that may be
// cut off anywhere. Returns null when the field hasn't started yet. A dangling
// escape at the cut is dropped rather than guessed.
export function partialJsonStringField(json, key) {
  if (typeof json !== "string") return null;
  let i = json.indexOf("{");
  if (i < 0) return null;
  i++;
  const n = json.length;
  const skipWs = () => { while (i < n && " \t\r\n".includes(json[i])) i++; };
  // Reads a JSON string starting at the opening quote. Returns { value, complete }.
  const readString = () => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = json[i];
      if (c === '"') { i++; return { value: out, complete: true }; }
      if (c !== "\\") { out += c; i++; continue; }
      if (i + 1 >= n) { i = n; break; }
      const e = json[i + 1];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e in simple) { out += simple[e]; i += 2; continue; }
      if (e === "u") {
        if (i + 6 > n) { i = n; break; }
        const code = parseInt(json.slice(i + 2, i + 6), 16);
        if (Number.isNaN(code)) { i = n; break; }
        // A high surrogate cut before its pair is dropped.
        if (code >= 0xd800 && code <= 0xdbff && i + 12 > n) { i = n; break; }
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      i += 2; // unknown escape: skip it
    }
    return { value: out, complete: false };
  };
  // Skips any JSON value (only scalars, strings, and flat nesting appear here).
  const skipValue = () => {
    skipWs();
    if (json[i] === '"') { readString(); return; }
    let depth = 0;
    while (i < n) {
      const c = json[i];
      if (c === '"') { readString(); continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { if (depth === 0) return; depth--; }
      else if (c === "," && depth === 0) return;
      i++;
    }
  };
  while (i < n) {
    skipWs();
    if (json[i] !== '"') return null;
    const k = readString();
    if (!k.complete) return null;
    skipWs();
    if (json[i] !== ":") return null;
    i++;
    skipWs();
    if (i >= n) return null;
    if (k.value === key) return json[i] === '"' ? readString().value : null;
    skipValue();
    skipWs();
    if (json[i] === ",") i++;
    else return null;
  }
  return null;
}

// Accumulates reply-tool argument chunks from stream-json `stream_event`s.
// One draft per reply tool_use, keyed by its tool_use id, so several replies
// in one turn each stream into their own row.
export class ReplyDraftTracker {
  constructor({ toolName = REPLY_TOOL_NAME, maxDrafts = 8 } = {}) {
    this.toolName = toolName;
    this.maxDrafts = maxDrafts;
    this.byIndex = new Map(); // content-block index (per API message) → draft
    this.drafts = new Map();  // tool_use id → draft
  }

  // Returns true when the event was a stream_event (so callers can skip
  // logging it — there are hundreds per reply).
  observe(ev) {
    if (ev?.type !== "stream_event") return false;
    const e = ev.event || {};
    if (e.type === "message_start") {
      this.byIndex.clear();
    } else if (e.type === "content_block_start") {
      const b = e.content_block;
      if (b?.type === "tool_use" && b.name === this.toolName && b.id) {
        const d = { id: b.id, json: "", text: "", done: false, startedAt: Date.now() };
        this.byIndex.set(e.index, d);
        this.drafts.set(b.id, d);
        while (this.drafts.size > this.maxDrafts) this.drafts.delete(this.drafts.keys().next().value);
      }
    } else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
      const d = this.byIndex.get(e.index);
      if (d && typeof e.delta.partial_json === "string") {
        d.json += e.delta.partial_json;
        const text = partialJsonStringField(d.json, "message");
        if (text != null) d.text = text;
      }
    } else if (e.type === "content_block_stop") {
      const d = this.byIndex.get(e.index);
      if (d) { d.done = true; this.byIndex.delete(e.index); }
    }
    return true;
  }

  reset() {
    this.byIndex.clear();
    this.drafts.clear();
  }

  snapshot() {
    return [...this.drafts.values()].map(({ id, text, done }) => ({ id, text, done }));
  }
}

// Trim a partial reply to what renders cleanly: drop a half-written last word
// and an unclosed bold/code marker, so the app doesn't flash raw `**` or a
// stray backtick mid-stream. The final reply replaces all of this anyway.
export function displayableDraft(text) {
  if (typeof text !== "string" || !text) return "";
  let t = text;
  const lastBreak = Math.max(t.lastIndexOf(" "), t.lastIndexOf("\n"));
  if (lastBreak > 0) t = t.slice(0, lastBreak);
  if ((t.split("```").length - 1) % 2) return t.slice(0, t.lastIndexOf("```")).trimEnd();
  if ((t.split("**").length - 1) % 2) t = t.slice(0, t.lastIndexOf("**"));
  if ((t.split("```").join("").split("`").length - 1) % 2) t = t.slice(0, t.lastIndexOf("`"));
  return t.trimEnd();
}
