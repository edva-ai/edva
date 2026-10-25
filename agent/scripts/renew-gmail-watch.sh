#!/bin/bash
# renew-gmail-watch.sh — refreshes the Gmail push notification watch
# Gmail watch expires every 7 days. Run daily to stay ahead.
# Add to crontab: 0 6 * * * $HOME/Dev/edva/agent/scripts/renew-gmail-watch.sh
#
# Writes data/gmail-watch-last.json {at, expiresAt, ok, error} on every
# run so watchdog.sh can alert on failure or near-expiry before pushes break.

LOG="$HOME/Dev/edva/agent/logs/gmail-watch.log"
TOKEN_FILE="$HOME/Dev/edva/credentials/gmail-push-token.json"
LAST_FILE="$HOME/Dev/edva/data/gmail-watch-last.json"
# The GCP project that owns the Pub/Sub topic: this installation's gcp_project
# (lib/instance.cjs, exported as EDVA_GCP_PROJECT).
source "$(dirname "${BASH_SOURCE[0]}")/lib/instance.sh"
PROJECT_ID="${EDVA_GCP_PROJECT:-}"

NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

write_last() {
  local ok="$1" expires_at="$2" error="$3"
  jq -n \
    --arg at "$NOW_ISO" \
    --arg expiresAt "$expires_at" \
    --argjson ok "$ok" \
    --arg error "$error" \
    '{at:$at, expiresAt:(if $expiresAt == "" then null else $expiresAt end), ok:$ok, error:(if $error == "" then null else $error end)}' \
    > "$LAST_FILE"
}

CLIENT_ID=$(jq -r '.client_id' "$TOKEN_FILE")
CLIENT_SECRET=$(jq -r '.client_secret' "$TOKEN_FILE")
REFRESH_TOKEN=$(jq -r '.refresh_token' "$TOKEN_FILE")

# Get fresh access token
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "grant_type=refresh_token" | jq -r '.access_token')

if [ "${#ACCESS_TOKEN}" -lt 20 ]; then
  echo "$(date): ERROR — failed to get access token" >> "$LOG"
  write_last false "" "failed to obtain access token from refresh_token"
  exit 1
fi

# Call Gmail watch
RESULT=$(curl -s -X POST \
  "https://gmail.googleapis.com/gmail/v1/users/me/watch" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"topicName\": \"projects/$PROJECT_ID/topics/gmail-new-messages\",
    \"labelIds\": [\"INBOX\"],
    \"labelFilterBehavior\": \"INCLUDE\"
  }")

EXPIRATION=$(echo "$RESULT" | jq -r '.expiration // empty')

if [ -n "$EXPIRATION" ]; then
  EXPIRY_DATE=$(date -r $((EXPIRATION / 1000)) '+%Y-%m-%d %H:%M:%S')
  EXPIRY_ISO=$(date -u -r $((EXPIRATION / 1000)) '+%Y-%m-%dT%H:%M:%SZ')
  echo "$(date): Gmail watch renewed. Expires: $EXPIRY_DATE" >> "$LOG"
  write_last true "$EXPIRY_ISO" ""
else
  ERR_SUMMARY=$(echo "$RESULT" | tr -d '\n' | head -c 300)
  echo "$(date): ERROR — watch renewal failed: $RESULT" >> "$LOG"
  write_last false "" "$ERR_SUMMARY"
  exit 1
fi
