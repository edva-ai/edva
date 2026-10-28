// sms-core.mjs — the pure half of bin/sms-send: argument parsing, the
// recipient and identity-opener checks, the Twilio request form and the
// message-status vocabulary. No network and no secrets here; the CLI does both.
//
// Policy and setup: docs/sms-send.md.

// A message's status from Twilio's Messages resource. Past one of these it
// does not change again (`read` is reported only on channels with receipts).
export const FINAL_STATUSES = new Set(["delivered", "undelivered", "failed", "read", "canceled"]);

// Twilio splits a long text into segments and refuses a body over 1600 characters.
export const MAX_TEXT = 1600;

// The longest --wait the CLI accepts, in seconds.
export const MAX_WAIT = 300;

// parseArgs(argv, readFile) → { cmd, to, text, authorized, wait, dryRun, json, sid, help, error }
// argv is process.argv.slice(2). `status <sid>` is the one subcommand.
export function parseArgs(argv, readFile) {
  const a = { cmd: "send", to: null, text: null, authorized: null, wait: 0, dryRun: false, json: false, sid: null, help: false, error: null };
  const args = [...argv];
  if (args[0] === "status") {
    a.cmd = "status";
    args.shift();
    if (args[0] && !args[0].startsWith("--")) a.sid = args.shift();
  }
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined) a.error = `${k} needs a value`;
      return v;
    };
    if (k === "--to") a.to = val();
    else if (k === "--text") a.text = val();
    else if (k === "--text-file") {
      const p = val();
      if (p !== undefined) {
        try { a.text = readFile(p); } catch (e) { a.error = `cannot read ${p}: ${e.message}`; }
      }
    }
    else if (k === "--authorized") a.authorized = val();
    else if (k === "--wait") {
      const n = Number(val());
      if (!Number.isFinite(n) || n < 0 || n > MAX_WAIT) a.error = `--wait takes 0-${MAX_WAIT} seconds`;
      else a.wait = n;
    }
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--json") a.json = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else a.error = `unknown argument: ${k}`;
    if (a.error) break;
  }
  if (typeof a.text === "string") a.text = a.text.trimEnd(); // a file's trailing newline
  return a;
}

// isE164("+15551234567") → true. A phone number is machine structure, not language.
export function isE164(to) {
  return /^\+[1-9]\d{7,14}$/.test(String(to || ""));
}

// isMessageSid("SM…") → true for a Twilio message id (SM/MM + 32 hex).
export function isMessageSid(sid) {
  return /^(SM|MM)[0-9a-f]{32}$/.test(String(sid || ""));
}

// hasIdentityOpener(text, ownerName) → true when the text opens with one of the
// two identity lines the outbound policy fixes for a message to anyone other
// than the user (agent/CLAUDE.md § Outbound iMessage / WhatsApp Policy):
//   "Hi <Name>, this is Edva, <owner>'s AI assistant. …"   (", " or a dash)
//   "This is Edva on behalf of <owner> …"
// A check that the text starts with Edva's own fixed template, by plain
// string comparison; it decides nothing about what anyone meant.
const AGENT = "Edva";
const JOINERS = [", ", " — ", " – ", " - "];
const APOSTROPHES = ["'", "’"];
export function hasIdentityOpener(text, ownerName) {
  const t = String(text || "").trimStart();
  const owner = String(ownerName || "").trim();
  if (!owner) return false;
  if (t.startsWith(`This is ${AGENT} on behalf of ${owner}`)) return true;
  if (!t.startsWith("Hi ")) return false;
  const marker = `, this is ${AGENT}`;
  const at = t.indexOf(marker);
  if (at < 4) return false;
  const name = t.slice(3, at);
  if (!name.trim() || name.length > 40 || name.includes("\n")) return false;
  const rest = t.slice(at + marker.length);
  return JOINERS.some((j) => APOSTROPHES.some((ap) => rest.startsWith(`${j}${owner}${ap}s AI assistant`)));
}

// The form body of a Twilio "create message" request.
export function twilioForm({ to, from, text }) {
  return new URLSearchParams({ To: to, From: from, Body: text });
}

// One line describing a Twilio message resource, for the terminal.
export function describe(m) {
  const err = m.error_code ? ` (error ${m.error_code}${m.error_message ? `: ${m.error_message}` : ""})` : "";
  return `${m.sid} to ${m.to}: ${m.status}${err}`;
}
