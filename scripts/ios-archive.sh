#!/bin/sh
# Archive the iOS app and export it for TestFlight / the App Store into build/ios/.
# Signing comes from ios/Signing.xcconfig (copy ios/Signing.xcconfig.example). Nothing is uploaded:
# upload the exported .ipa with Xcode's Organizer or Transporter yourself.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
[ -f ios/Signing.xcconfig ] || { echo "ios/Signing.xcconfig is missing: copy ios/Signing.xcconfig.example and set DEVELOPMENT_TEAM." >&2; exit 2; }
pnpm build:ios-editor
xcodegen generate --spec ios/project.yml
out=build/ios
rm -rf "$out" && mkdir -p "$out"
xcodebuild -project ios/CENTCOM.xcodeproj -scheme CENTCOM -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$out/CENTCOM.xcarchive" -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath "$out/CENTCOM.xcarchive" -exportOptionsPlist ios/ExportOptions-AppStore.plist \
  -exportPath "$out" -allowProvisioningUpdates
echo "Exported $(ls "$out"/*.ipa). Bump CURRENT_PROJECT_VERSION in ios/project.yml before every upload."
