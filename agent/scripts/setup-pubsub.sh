#!/bin/bash
# setup-pubsub.sh — creates the Google Pub/Sub topic and subscription for Gmail push
# Run once during initial setup.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - A Google Cloud project with Gmail API and Pub/Sub API enabled
#
# Usage: bash scripts/setup-pubsub.sh YOUR_PROJECT_ID YOUR_HOOKDECK_URL

set -euo pipefail

PROJECT_ID="${1:?Usage: $0 PROJECT_ID HOOKDECK_PUSH_URL}"
HOOKDECK_URL="${2:?Usage: $0 PROJECT_ID HOOKDECK_PUSH_URL}"

echo "Setting project to $PROJECT_ID..."
gcloud config set project "$PROJECT_ID"

echo "Enabling required APIs..."
gcloud services enable gmail.googleapis.com pubsub.googleapis.com

echo "Creating Pub/Sub topic..."
gcloud pubsub topics create gmail-new-messages 2>/dev/null || echo "Topic already exists"

echo "Granting Gmail publish permission..."
gcloud pubsub topics add-iam-policy-binding gmail-new-messages \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

echo "Creating push subscription to Hookdeck..."
gcloud pubsub subscriptions create gmail-push-sub \
  --topic=gmail-new-messages \
  --push-endpoint="$HOOKDECK_URL" \
  --ack-deadline=30 \
  2>/dev/null || echo "Subscription already exists"

echo ""
echo "Done! Pub/Sub pipeline:"
echo "  Gmail -> topic:gmail-new-messages -> sub:gmail-push-sub -> $HOOKDECK_URL"
echo ""
echo "Next steps:"
echo "  1. Install hookdeck CLI: npm install -g hookdeck-cli"
echo "  2. Run: hookdeck listen 9090 gmail-source"
echo "  3. Run: node scripts/setup-gmail-watch.mjs"
