#!/bin/sh
# Builds Cloudy's Dolphin plugin into linux/dolphin/build/<arch>/cloudyoverlay.so (arch: x64, arm64) inside Debian 13
# (KDE Frameworks 6.13, Qt 6.8: the plugin loads there and in every newer KF6/Qt 6). Needs Docker; another
# architecture than the machine's runs emulated (slow). Already built ones are kept (CI downloads them first).
#   linux/dolphin/build.sh [x64] [arm64]      (default: both)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ $# -gt 0 ] || set -- x64 arm64
for arch in "$@"; do
  case $arch in x64) platform=linux/amd64 ;; arm64) platform=linux/arm64 ;; *) echo "unknown arch $arch" >&2; exit 2 ;; esac
  out="$here/build/$arch"
  if [ -f "$out/cloudyoverlay.so" ]; then echo "dolphin/$arch: already built"; continue; fi
  mkdir -p "$out"
  docker run --rm --platform "$platform" -v "$here:/src:ro" -v "$out:/out" debian:trixie sh -ec '
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends g++ make cmake extra-cmake-modules libkf6kio-dev qt6-base-dev >/dev/null
    cmake -S /src -B /tmp/b -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build /tmp/b
    strip /tmp/b/out/cloudyoverlay.so
    cp /tmp/b/out/cloudyoverlay.so /out/
    chown "$(stat -c %u:%g /out)" /out/cloudyoverlay.so'
  echo "dolphin/$arch: $out/cloudyoverlay.so"
done
