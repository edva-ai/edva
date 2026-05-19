# Code signing — set this up before your first build

The companion app ships with placeholder values where personal identifiers used to live. You need to replace four things with your own Apple Developer credentials before either of the CI workflows (`ios-testflight.yml` / `macos-testflight.yml`) will work.

## What to change

| Token | Replace with | Where it appears |
|---|---|---|
| `TEAMID_PLACEHOLDER` | Your 10-character Apple Team ID | 11 places across `Merlin.xcodeproj`, fastlane configs, ExportOptions plists, and both workflow YAMLs |
| `com.example.Merlin` | Your reverse-DNS bundle ID for the app | xcodeproj, Info.plist, fastlane, ExportOptions |
| `com.example.Merlin.NotificationService` | Bundle ID for the notification-service extension | xcodeproj, ExportOptions |
| `com.example.merlin` (lowercase) | The URL-scheme variant | `Merlin/Info.plist` (`CFBundleURLSchemes` + `CFBundleURLName`) |
| `<Developer Name>` | The display name on your "Apple Distribution" certificate | `ios-testflight.yml` (used in a `grep` against `security find-identity` output) |

Find your Team ID at https://developer.apple.com/account → Membership.

## One-shot helper

Replace `ABCDEFGHIJ` with your Team ID and `com.yourname.Merlin` with your bundle ID, then run from the repo root:

```bash
TEAM=ABCDEFGHIJ
BUNDLE=com.yourname.Merlin
NAME="Your Name"

git ls-files apps/companion | xargs sed -i '' \
  -e "s/TEAMID_PLACEHOLDER/$TEAM/g" \
  -e "s/com\\.example\\.Merlin\\.NotificationService/$BUNDLE.NotificationService/g" \
  -e "s/com\\.example\\.Merlin/$BUNDLE/g" \
  -e "s/com\\.example\\.merlin/$(echo $BUNDLE | tr A-Z a-z)/g" \
  -e "s/<Developer Name>/$NAME/g"

git ls-files .github/workflows | xargs sed -i '' \
  -e "s/TEAMID_PLACEHOLDER/$TEAM/g" \
  -e "s/com\\.example\\.Merlin\\.NotificationService/$BUNDLE.NotificationService/g" \
  -e "s/com\\.example\\.Merlin/$BUNDLE/g" \
  -e "s/<Developer Name>/$NAME/g"

# Verify
git ls-files | xargs grep -lE "TEAMID_PLACEHOLDER|com\\.example\\.Merlin|<Developer Name>"
# Above should print nothing — anything that prints is something the script missed.
```

Then commit those changes in your fork. **Do not push them upstream** if you're contributing to the public Merlin repo — keep your signing identity local.

## GitHub Actions secrets you also need

The workflows authenticate with App Store Connect via API key + import a `.p12` distribution certificate. Set these as **GitHub Secrets** (Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `IOS_CERTIFICATE_P12` | Base64-encoded `.p12` of your Apple Distribution certificate |
| `IOS_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `MAC_CERTIFICATE_P12` | Same, but for the Mac Installer Distribution certificate |
| `MAC_CERTIFICATE_PASSWORD` | Password for the mac `.p12` |
| `MAC_PROVISIONING_PROFILE` | Base64-encoded mac app `.provisionprofile` |
| `MAC_NOTIFSERVICE_PROFILE` | Base64-encoded notification-service `.provisionprofile` (if you use the extension) |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | App Store Connect API key (see [Apple docs](https://developer.apple.com/documentation/appstoreconnectapi/creating_api_keys_for_app_store_connect_api)) |

## What the workflows do

- **`ios-testflight.yml`** — iOS build, archive via xcodebuild, upload to TestFlight via `xcrun altool`. Runs on a self-hosted macOS runner (label `[self-hosted, macos, ios]`).
- **`macos-testflight.yml`** — Mac Catalyst build, archive, `productbuild` into a `.pkg`, upload to TestFlight. Same runner labels.

Trigger both manually via the Actions tab → workflow → "Run workflow".

If you're not running a self-hosted runner, change the `runs-on:` line to `macos-latest` — be aware GitHub-hosted macOS runners are slower and have less reliable signing-keychain behavior.
