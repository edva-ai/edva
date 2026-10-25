#!/bin/bash
# setup-pubsub.sh — create/repoint the Google Pub/Sub topic + push subscription
# that delivers Gmail "new message" events to the Edva ops-supervisor.
#
# The push endpoint is a Cloudflare Tunnel hostname
# ($PUSH_HOST → localhost:9090 on the host), NOT a relay service. The
# subscription is OIDC-authenticated: Pub/Sub signs every push with a Google
# OIDC JWT minted as the edva-pubsub service account, and the supervisor's
# :9090 handler verifies that JWT (audience + SA email) before accepting it.
# See agent/supervisor/oidc-verify.mjs.
#
# Idempotent — safe to re-run. Repointing an existing subscription's push
# endpoint/auth is done with `subscriptions update`.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Gmail API + Pub/Sub API enabled in the project
#   - The Cloudflare Tunnel ingress for $PUSH_HOST already live
#
# Usage: bash scripts/setup-pubsub.sh [PROJECT_ID] [PUSH_HOST]
#   PROJECT_ID defaults to this instance's GCP project (see below)
#   PUSH_HOST  defaults to this instance's push hostname (see below)

set -euo pipefail

# Defaults: this installation's gcp_project and gmail-push.<domain>
# (lib/instance.cjs; EDVA_PUSH_HOST overrides the host).
source "$(dirname "${BASH_SOURCE[0]}")/lib/instance.sh"
PROJECT_ID="${1:-${EDVA_GCP_PROJECT:-}}"
PUSH_HOST="${2:-${EDVA_PUSH_HOST:-${EDVA_DOMAIN:+gmail-push.$EDVA_DOMAIN}}}"
if [ -z "$PROJECT_ID" ] || [ -z "$PUSH_HOST" ]; then
  echo "usage: setup-pubsub.sh PROJECT_ID PUSH_HOST (no instance gcp_project/domain configured)" >&2
  exit 2
fi
TOPIC="gmail-new-messages"
SUBSCRIPTION="gmail-push-sub"
SA_NAME="edva-pubsub"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
# Audience the supervisor checks the OIDC token's `aud` claim against. Pub/Sub
# sends the bare endpoint by default; we set it explicitly (no trailing slash)
# and the supervisor config must match.
AUDIENCE="https://${PUSH_HOST}"
PUSH_ENDPOINT="https://${PUSH_HOST}/"
OIDC_CONFIG_PATH="$HOME/Dev/edva/secrets/pubsub-oidc.json"

echo "Project:       $PROJECT_ID"
echo "Push endpoint: $PUSH_ENDPOINT"
echo "OIDC SA:       $SA_EMAIL"
echo "Audience:      $AUDIENCE"
echo

gcloud config set project "$PROJECT_ID" >/dev/null

echo "Enabling required APIs..."
gcloud services enable gmail.googleapis.com pubsub.googleapis.com iamcredentials.googleapis.com >/dev/null

echo "Ensuring topic $TOPIC exists..."
gcloud pubsub topics create "$TOPIC" 2>/dev/null || echo "  (topic already exists)"

echo "Granting Gmail permission to publish to the topic..."
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" >/dev/null

echo "Ensuring OIDC service account $SA_NAME exists..."
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Edva Pub/Sub push OIDC signer" >/dev/null

# Pub/Sub's service agent must be allowed to mint OIDC tokens as the SA.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
PUBSUB_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
echo "Granting Pub/Sub service agent token-creator on the SA..."
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --member="serviceAccount:${PUBSUB_AGENT}" \
  --role="roles/iam.serviceAccountTokenCreator" >/dev/null

echo "Creating/updating the push subscription with OIDC auth..."
if gcloud pubsub subscriptions describe "$SUBSCRIPTION" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update "$SUBSCRIPTION" \
    --push-endpoint="$PUSH_ENDPOINT" \
    --push-auth-service-account="$SA_EMAIL" \
    --push-auth-token-audience="$AUDIENCE" >/dev/null
  echo "  (updated existing subscription)"
else
  gcloud pubsub subscriptions create "$SUBSCRIPTION" \
    --topic="$TOPIC" \
    --ack-deadline=30 \
    --push-endpoint="$PUSH_ENDPOINT" \
    --push-auth-service-account="$SA_EMAIL" \
    --push-auth-token-audience="$AUDIENCE" >/dev/null
  echo "  (created new subscription)"
fi

echo "Writing supervisor OIDC config to $OIDC_CONFIG_PATH..."
mkdir -p "$(dirname "$OIDC_CONFIG_PATH")"
umask 077
cat > "$OIDC_CONFIG_PATH" <<JSON
{
  "audience": "$AUDIENCE",
  "serviceAccount": "$SA_EMAIL"
}
JSON

echo
echo "Done. Pipeline:"
echo "  Gmail -> topic:$TOPIC -> sub:$SUBSCRIPTION -> $PUSH_ENDPOINT (OIDC: $SA_EMAIL)"
echo "                                              -> Cloudflare Tunnel -> localhost:9090"
echo
echo "Next steps:"
echo "  1. Restart the ops-supervisor so it reads the new OIDC config:"
echo "       curl -X POST http://localhost:9093/restart -H \"Authorization: Bearer \$(cat ~/Dev/edva/secrets/webhook-token)\""
echo "     (or: launchctl kickstart -k gui/\$(id -u)/ai.claude.session)"
echo "  2. Ensure the Gmail watch is active: node scripts/setup-gmail-watch.mjs"
echo "  3. Send a test email and confirm a dispatch in agent/logs/ops-supervisor.log"
