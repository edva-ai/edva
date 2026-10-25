#!/bin/zsh
# Build, archive, and upload to TestFlight.
#
# Requires (via environment or 1Password):
#   APP_STORE_CONNECT_API_KEY_ID   (ASC API key ID)
#   APP_STORE_CONNECT_API_KEY_ISSUER_ID  (team issuer ID)
#   APP_STORE_CONNECT_API_KEY_PATH      (path to .p8 private key)
#   TEAM_ID                             (Apple Developer Team ID)
#
# Usage: ./scripts/testflight.sh

set -euo pipefail
cd "$(dirname "$0")/.."

: "${TEAM_ID:?Set TEAM_ID (10-char Apple Developer Team ID)}"

xcodegen generate

ARCHIVE="build/Exercise.xcarchive"
EXPORT_DIR="build/export"
rm -rf "$ARCHIVE" "$EXPORT_DIR"

echo "→ Archiving…"
xcodebuild \
    -project Exercise.xcodeproj \
    -scheme Exercise \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    archive

cat > build/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>destination</key>
    <string>export</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
EOF

echo "→ Exporting IPA…"
xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist build/ExportOptions.plist \
    -exportPath "$EXPORT_DIR"

if [[ -n "${APP_STORE_CONNECT_API_KEY_ID:-}" ]]; then
    echo "→ Uploading to TestFlight…"
    xcrun altool --upload-app \
        --type ios \
        --file "$EXPORT_DIR/Exercise.ipa" \
        --apiKey "$APP_STORE_CONNECT_API_KEY_ID" \
        --apiIssuer "$APP_STORE_CONNECT_API_KEY_ISSUER_ID"
else
    echo "⚠ ASC API key not set — skipping upload. IPA at $EXPORT_DIR/Exercise.ipa"
fi
