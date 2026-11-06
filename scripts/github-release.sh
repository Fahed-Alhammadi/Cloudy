#!/bin/sh
# GitHub release of the desktop app. Run by .github/workflows/desktop.yml when a desktop-X.Y.Z tag is pushed
# (needs GH_TOKEN, GITHUB_REPOSITORY; ASSETS=<dir> with the packages):
#   scripts/github-release.sh desktop-X.Y.Z
# The release is on that tag, titled vX.Y.Z and marked Latest. It carries every package and the latest*.yml files
# installed apps update from (desktop/src/main/updater.ts). The notes list the commits that touched desktop/ since the
# previous desktop tag. A re-run replaces the files of the release it already made.
# Only the desktop app has GitHub releases: the server's changes are in CHANGELOG.md, the phone apps' in the stores.
set -e
tag=$1
version=${tag#desktop-}
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && [ "$tag" = "desktop-$version" ] ||
  { echo "usage: $0 desktop-X.Y.Z" >&2; exit 2; }
if [ -z "$ASSETS" ] || ! ls "$ASSETS"/* >/dev/null; then echo "::error::no packages in ASSETS" >&2; exit 1; fi

if gh release view "$tag" >/dev/null 2>&1; then # a re-run
  gh release upload "$tag" "$ASSETS"/* --clobber
  echo "Replaced the files of release $tag"
  exit 0
fi

# Previous desktop release = the highest desktop-X.Y.Z tag below this one.
prev=$(git tag -l 'desktop-*' | sed 's/^desktop-//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' |
  { cat; echo "$version"; } | sort -uV | grep -B1 -x "$version" | head -1)
[ "$prev" = "$version" ] && prev=
{
  echo "## What's changed"
  git log --no-merges --format='- %s (%h)' ${prev:+"desktop-$prev"..}"$tag" -- desktop
  [ -n "$prev" ] && echo && echo "Since v$prev."
} > release-notes.md
gh release create "$tag" "$ASSETS"/* --verify-tag --title "v$version" --notes-file release-notes.md --latest
echo "Released $tag as v$version"
