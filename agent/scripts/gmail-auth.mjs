#!/usr/bin/env node
/**
 * Gmail OAuth helper — gets a fresh refresh token using the existing
 * OAuth client from the Claude Agent GCP project.
 *
 * Usage: node scripts/gmail-auth.mjs
 * Then visit the URL, authorize, paste the code.
 */

import { createServer } from "http";

// Loaded from env (preferred) or 1Password via `op run --env-file=- -- node scripts/gmail-auth.mjs`.
// Item: op://Dev/Merlin Gmail OAuth Client
const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET, e.g.:");
  console.error('  export GMAIL_OAUTH_CLIENT_ID="$(op read \'op://Dev/Merlin Gmail OAuth Client/username\')"');
  console.error('  export GMAIL_OAUTH_CLIENT_SECRET="$(op read \'op://Dev/Merlin Gmail OAuth Client/credential\')"');
  process.exit(1);
}
const REDIRECT_URI = "http://localhost:3456";
const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for callback on localhost:3456...\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3456`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("No code received");
    return;
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json();

  if (tokens.error) {
    console.error("Error:", tokens);
    res.writeHead(500);
    res.end("Token exchange failed: " + tokens.error);
    server.close();
    return;
  }

  // Save to credentials
  const { writeFileSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const tokenPath = join(__dirname, "..", "..", "credentials", "gmail-push-token.json");

  const tokenData = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
    scopes: SCOPES.split(" "),
  };

  writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));
  console.log("\nTokens saved to:", tokenPath);
  console.log("Refresh token:", tokens.refresh_token ? "YES" : "NO");

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>Authorized! You can close this tab.</h1>");
  server.close();
  process.exit(0);
});

server.listen(3456);
