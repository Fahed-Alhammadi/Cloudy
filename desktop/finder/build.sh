#!/bin/sh
# Builds the Finder Sync extension (FinderSync.swift) as a universal, unsigned CloudyFinder.appex in finder/build/.
# The packaging hook (scripts/after-pack.cjs) puts it into Cloudy.app/Contents/PlugIns and signs it. macOS only.
set -eu
cd "$(dirname "$0")"
[ "$(uname)" = Darwin ] || { echo "finder/build.sh: macOS only, skipped"; exit 0; }
version=$(node -p "require('../package.json').version")
out=build/CloudyFinder.appex
rm -rf build
mkdir -p "$out/Contents/MacOS" build/obj
for arch in arm64 x86_64; do
  xcrun swiftc -O -module-name CloudyFinder -target "$arch-apple-macos12.0" -application-extension -parse-as-library \
    -framework Cocoa -framework FinderSync -Xlinker -e -Xlinker _NSExtensionMain \
    FinderSync.swift -o "build/obj/CloudyFinder-$arch"
done
lipo -create build/obj/CloudyFinder-arm64 build/obj/CloudyFinder-x86_64 -output "$out/Contents/MacOS/CloudyFinder"
sed "s/VERSION/$version/g" Info.plist > "$out/Contents/Info.plist"
plutil -lint "$out/Contents/Info.plist" >/dev/null
rm -rf build/obj
echo "Built $out ($version)"
