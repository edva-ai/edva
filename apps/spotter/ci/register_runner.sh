#!/usr/bin/env bash
# Register a GitHub Actions self-hosted runner for $REPO.
#
# Run this ON the machine you want as the builder.
# It creates a NEW runner folder ~/actions-runner-spotter/ so it doesn't
# conflict with other self-hosted runners.
#
# Prereqs: gh CLI signed in as the repo owner, curl, tar.
#
# Usage:  REPO="<owner>/<repo>" ./register_runner.sh [LABELS]
#           LABELS defaults to "self-hosted,macos,macmini,ios" — match the
#           runs-on labels in .github/workflows/ios-testflight.yml.

set -euo pipefail

: "${REPO:?Set REPO=<owner>/<repo> before running}"
LABELS="${1:-macmini,ios}"
DIR="$HOME/actions-runner-spotter"

if [[ -d "$DIR" ]]; then
    echo "Runner dir $DIR already exists — removing stale install..."
    (cd "$DIR" && ./svc.sh uninstall 2>/dev/null || true; ./config.sh remove --token dummy 2>/dev/null || true)
    rm -rf "$DIR"
fi
mkdir -p "$DIR"
cd "$DIR"

# Download the latest runner package for macOS arm64
LATEST=$(curl -sL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
echo "Downloading actions-runner $LATEST..."
curl -sLO "https://github.com/actions/runner/releases/download/v${LATEST}/actions-runner-osx-arm64-${LATEST}.tar.gz"
tar xzf "actions-runner-osx-arm64-${LATEST}.tar.gz"
rm "actions-runner-osx-arm64-${LATEST}.tar.gz"

# Get a one-time registration token
TOKEN=$(gh api --method POST "repos/$REPO/actions/runners/registration-token" --jq .token)

# Configure
./config.sh \
    --url "https://github.com/$REPO" \
    --token "$TOKEN" \
    --name "$(hostname -s)-spotter" \
    --labels "$LABELS" \
    --work "_work" \
    --unattended \
    --replace

# Install as a LaunchAgent so it survives reboots
./svc.sh install
./svc.sh start

echo ""
echo "Runner registered. Verify:"
gh api "repos/$REPO/actions/runners" --jq '.runners[] | {name, status, labels: [.labels[].name]}'
