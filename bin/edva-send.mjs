#!/usr/bin/env node
// edva-send — Insert a message into edva_messages and send a push notification.
// Usage:
//   edva-send "Your message here"
//   edva-send --notify "Short summary" "Full message body..."
//   edva-send --silent "Message without any push"
//
// Auth: SUPABASE_SERVICE_ROLE_KEY from .env. NOT the anon key — the
// edva_messages INSERT policy is
//   (auth.role() = 'service_role') OR (role = 'user' AND auth.uid() IS NOT NULL)
// and this tool inserts role='assistant', so an anon client fails BOTH branches
// and every send is rejected by RLS. That is what happened until 2026-08-04:
// the key was hardcoded here as the anon JWT, so the location-confirm ask
// channel (its only caller, trigger-location-confirm.sh) never delivered a
// single message. Its sibling in the same pipeline,
// location-confirm-resolve.mjs, already read the service-role key correctly.

import { createClient } from "@supabase/supabase-js";
import { sendApnsPush } from "../lib/apns-push.mjs";
import { loadEnv, underTestRunner } from "../lib/load-env.js";
import { createRequire } from "node:module";

// Inside a test run (node --test sets NODE_TEST_CONTEXT, and what a test spawns
// inherits it) this tool never posts: its only target is the real chat. See
// "Test runs" in lib/load-env.js.
if (underTestRunner()) {
  console.error("edva-send: not sent — this is a test run (NODE_TEST_CONTEXT is set), and a test never posts to the real chat.");
  process.exit(9);
}

loadEnv();

const SUPABASE_URL = `https://${createRequire(import.meta.url)("../lib/instance.cjs").instance().supabase_project}.supabase.co`;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fail loudly rather than falling back to the anon key. A silent fallback is
// exactly the failure mode this replaced: RLS rejects the insert, the tool
// exits non-zero into a log nobody reads, and the channel looks alive.
if (!SUPABASE_KEY) {
  console.error(
    "edva-send: SUPABASE_SERVICE_ROLE_KEY not found in env or .env — refusing to send."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let notifySummary = null;
let silent = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--notify" || a === "-n") notifySummary = args[++i];
  else if (a === "--silent" || a === "-s") silent = true;
  else positional.push(a);
}

const message = positional.join(" ");
if (!message) {
  console.error("Usage: edva-send [--notify <summary>] [--silent] <message>");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const { data: inserted, error } = await supabase.from("edva_messages").insert({
  role: "assistant",
  content: message,
  read: false,
}).select("id").single();

if (error) {
  console.error(`Failed to insert: ${error.message}`);
  process.exit(1);
}

console.log("Message sent to Edva.");

if (silent) process.exit(0);

// Delay so foreground apps get a chance to mark as read via realtime
await new Promise((r) => setTimeout(r, 1500));

const msgId = inserted?.id;
if (msgId) {
  const { data: row } = await supabase
    .from("edva_messages")
    .select("read")
    .eq("id", msgId)
    .single();
  if (row?.read) {
    console.log("Message already read, skipping push.");
    process.exit(0);
  }
}

const body = notifySummary
  || (message.length > 100 ? message.slice(0, 100) + "…" : message);

try {
  const res = await sendApnsPush(supabase, { body, messageId: msgId });
  // The motion gate may have parked the alert until the user stops moving. The
  // message itself already landed above, so this is a deferred buzz, not a
  // failed send — say which, so a log reader is not misled.
  if (res?.held) console.log(`Push held (${res.reason}) — ping-flush will deliver it.`);
  else console.log("Push notification sent.");
} catch (e) {
  console.error(`Push skipped: ${e.message}`);
}

process.exit(0);
