// reply-file.mjs — hand a long, tool-generated chat reply to the phone-channel
// `reply` tool by path instead of having the agent retype it.
//
// A tool that composes a finished phone message (next-show, …) writes it here
// and prints the path; the agent calls `reply({ message_file })`. The agent
// then emits a ~20-token tool call instead of retyping ~2k characters, which
// was ~6s of every watchlist answer — and "relay verbatim" becomes a property
// of the pipe rather than a rule the agent has to keep.
//
// Reads are confined to REPLY_FILE_DIR so the reply tool can't be pointed at
// an arbitrary file on the box.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPLY_FILE_DIR = process.env.EDVA_REPLY_FILE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/reply-files");
export const REPLY_FILE_MAX_BYTES = 64 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

export function writeReplyFile(text, { dir = REPLY_FILE_DIR, now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch {}
  }
  const p = path.join(dir, `${now}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(p, text);
  return p;
}

// Returns the file's text. Throws a message fit to hand back to the agent.
export function readReplyFile(p, { dir = REPLY_FILE_DIR } = {}) {
  if (typeof p !== "string" || !p) throw new Error("message_file must be a path");
  let real, root;
  try { real = fs.realpathSync(p); } catch { throw new Error(`message_file not found: ${p}`); }
  try { root = fs.realpathSync(dir); } catch { throw new Error(`reply-file dir missing: ${dir}`); }
  if (!real.startsWith(root + path.sep)) throw new Error(`message_file must be under ${dir}`);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error(`message_file is not a file: ${p}`);
  if (st.size > REPLY_FILE_MAX_BYTES) throw new Error(`message_file too large (${st.size} bytes)`);
  const text = fs.readFileSync(real, "utf8");
  if (!text.trim()) throw new Error(`message_file is empty: ${p}`);
  return text;
}

// The text the reply tool sends: optional lead-in `message`, then the file.
export function composeReply({ message, message_file }, opts) {
  const lead = typeof message === "string" ? message.trim() : "";
  if (!message_file) {
    if (!lead) throw new Error("reply needs `message` or `message_file`");
    return message;
  }
  const body = readReplyFile(message_file, opts);
  return lead ? `${lead}\n\n${body}` : body;
}
