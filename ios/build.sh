#!/bin/sh
# Generates the Xcode project and builds Cloudy for iOS.
#   ./build.sh            → simulator build (no signing), checks that everything compiles
#   ./build.sh archive    → signed App Store archive in dist/Cloudy.xcarchive (needs DEVELOPMENT_TEAM)
#   ./build.sh upload     → archive + upload to App Store Connect (TestFlight). Also used by CI.
# Signing is automatic. With an App Store Connect API key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH = the .p8 file)
# Xcode signs and uploads without a signed-in Apple ID (cloud-managed certificates; the key needs the Admin role).
# Needs Xcode and XcodeGen (`brew install xcodegen`).
set -e
cd "$(dirname "$0")"
xcodegen generate --quiet

if [ "$1" = "archive" ] || [ "$1" = "upload" ]; then
  : "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM to your Apple Team ID}"
  set -- "$1" -allowProvisioningUpdates
  if [ -n "$ASC_KEY_ID" ]; then
    set -- "$@" -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  fi
  mode=$1
  shift
  rm -rf dist/Cloudy.xcarchive
  # Sign the archive with the (cloud-managed) Apple Distribution certificate right away. The default would sign
  # with a development certificate first, which a fresh CI runner has to create every time until the account hits
  # Apple's certificate limit ("Choose a certificate to revoke"); App Store profiles also need no registered device.
  xcodebuild -project Cloudy.xcodeproj -scheme Cloudy -configuration Release -destination 'generic/platform=iOS' \
    -archivePath dist/Cloudy.xcarchive DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_IDENTITY="Apple Distribution" "$@" archive
  if [ "$mode" = "upload" ]; then
    cat > dist/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
EOF
    xcodebuild -exportArchive -archivePath dist/Cloudy.xcarchive -exportOptionsPlist dist/ExportOptions.plist \
      -exportPath dist/export "$@"
    echo "Uploaded to App Store Connect: it shows up in TestFlight after processing."
  else
    echo "Archive: ios/dist/Cloudy.xcarchive — upload it from Xcode → Window → Organizer → Distribute App."
  fi
else
  xcodebuild -project Cloudy.xcodeproj -scheme Cloudy -configuration Debug -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO build | grep -E "error|warning: .*\.swift|BUILD" || true
  test -d build/Build/Products/Debug-iphonesimulator/Cloudy.app
fi
