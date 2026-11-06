#!/bin/sh
# Marks release vX.Y.Z as out. Run by .github/workflows/release.yml after every product in it was published
# (needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA):
#   scripts/github-release.sh X.Y.Z            tag vX.Y.Z only (server → GHCR, Android → Play, iOS → App Store)
#   scripts/github-release.sh X.Y.Z desktop    GitHub release of the desktop app (marked Latest), then tag vX.Y.Z
# Only the desktop app has GitHub releases: its packages (every file in ASSETS=<dir>, attached in the same step so
# the release never exists without them) and the latest*.yml files installed apps update from. The notes list the
# commits that touched desktop/ since the previous desktop release. Server changes are in CHANGELOG.md.
# The tag vX.Y.Z is what marks the release as done, so it comes last; every step can be re-run.
set -e
version=$1
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 X.Y.Z [desktop]" >&2; exit 2; }
tag="v$version"

# Creates refs/tags/$1 at GITHUB_SHA; fine if it already points there (a re-run), an error if it points elsewhere.
make_tag() {
  if sha=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$1" -q .object.sha 2>/dev/null); then
    [ "$sha" = "$GITHUB_SHA" ] || { echo "::error::$1 already exists at $sha" >&2; exit 1; }
  else
    gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$1" -f sha="$GITHUB_SHA" >/dev/null
  fi
  echo "Tagged $1"
}

if [ "$2" = desktop ]; then
  prev=$(gh release view --json tagName -q .tagName 2>/dev/null || true) # the Latest release = newest desktop release
  release_tag=$tag
  # Desktop 1.2.0 and older only look for releases tagged desktop-v…: the first release after it keeps that prefix
  # (it brings the updater that also reads v… tags), so those installs still find it. Later releases are plain v….
  # (Older releases were renamed to v… on 2026-11-06, so this goes by the newest release's version, not its name.)
  prev_version=${prev#desktop-}
  prev_version=${prev_version#v}
  if [ -n "$prev_version" ] && [ "$(printf '%s\n' "$prev_version" 1.2.0 | sort -V | tail -1)" = 1.2.0 ]; then
    release_tag="desktop-v$version"
  fi
  [ "$prev" = "desktop-v$version" ] && release_tag=$prev # a re-run after the bridge release was made
  if [ "$prev" = "$release_tag" ]; then
    echo "Release $release_tag already exists"
  else
    {
      echo "## What's changed"
      git log --no-merges --format='- %s (%h)' ${prev:+"$prev"..}HEAD -- desktop
      [ -n "$prev" ] && echo && echo "Since $prev."
    } > release-notes.md
    gh release create "$release_tag" ${ASSETS:+"$ASSETS"/*} --target "$GITHUB_SHA" --title "$release_tag" \
      --notes-file release-notes.md --latest
    echo "Released $release_tag"
  fi
fi
make_tag "$tag"
