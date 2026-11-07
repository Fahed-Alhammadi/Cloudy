#!/bin/sh
# Compiles the Icon Composer icon assets/Cloudy.icon (blue in light AND dark, so macOS's dark/tinted icon styles keep
# the brand colors) into assets/Assets.car + assets/icon.icns. Needs Xcode 26+ (actool); run on a Mac after changing
# the icon and commit both outputs (CI packages them as they are, so it needs no Xcode 26).
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -R assets/Cloudy.icon "$tmp/Icon.icon"; mkdir "$tmp/out"
xcrun actool "$tmp/Icon.icon" --compile "$tmp/out" --output-format human-readable-text --notices --warnings \
  --output-partial-info-plist "$tmp/out/info.plist" --app-icon Icon --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en --target-device mac \
  --minimum-deployment-target 11.0 --platform macosx >/dev/null
cp "$tmp/out/Assets.car" assets/Assets.car
cp "$tmp/out/Icon.icns" assets/icon.icns
echo "Wrote assets/Assets.car and assets/icon.icns"
