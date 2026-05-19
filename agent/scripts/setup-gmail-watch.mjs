#!/usr/bin/env node
const path = require("node:path");
const MERLIN_HOME = process.env.MERLIN_HOME || path.join(process.env.HOME, "Dev/merlin");

/**
 * Gmail Watch Setup — registers push notifications via Google Pub/Sub.
 * Run once to activate, then re-run every 7 days (Gmail watch expires).
 *
 * Prerequisites:
 *   1. gcloud CLI authenticated: gcloud auth application-default login
 *   2. Pub/Sub topic created: gcloud pubsub topics create gmail-new-messages
 *   3. Gmail API enabled in Google Cloud Console
 *   4. OAuth credentials saved to ${MERLIN_HOME}/credentials/gmail-oauth.json
 *
 * Usage: node scripts/setup-gmail-watch.mjs
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CREDS_PATH = join(ROOT, "..", "credentials", "gmail-oauth.json");
const TOKEN_PATH = join(ROOT, "..", "data", "gmail-push-token.json");

// UPDATE THIS to your Google Cloud project ID
const PROJECT_ID = "${MERLIN_GCP_PROJECT}";
const TOPIC_NAME = `projects/${PROJECT_ID}/topics/gmail-new-messages`;

async function getAuthClient() {
  const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    oauth2.setCredentials(token);
    return oauth2;
  }

  // First-time auth flow
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
  });

  console.log("Authorize this app by visiting:", authUrl);
  console.log("\nPaste the authorization code here:");

  const code = await new Promise((resolve) => {
    process.stdin.once("data", (data) => resolve(data.toString().trim()));
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("Token saved to", TOKEN_PATH);

  return oauth2;
}

async function main() {
  const auth = await getAuthClient();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: TOPIC_NAME,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });

  console.log("Gmail watch activated:");
  console.log(`  History ID: ${res.data.historyId}`);
  console.log(`  Expiration: ${new Date(Number(res.data.expiration)).toISOString()}`);
  console.log("\nRe-run this script before expiration (every 7 days).");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
