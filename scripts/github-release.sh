#!/bin/sh
# GitHub release of the desktop app. Run by .github/workflows/desktop.yml when a desktop-X.Y.Z tag is pushed
# (needs GH_TOKEN, GITHUB_REPOSITORY; ASSETS=<dir> with the packages):
#   scripts/github-release.sh desktop-X.Y.Z
# The release is titled vX.Y.Z and marked Latest. It carries every package and the latest*.yml files installed apps
# update from (desktop/src/main/updater.ts). The notes list the commits that touched desktop/ since the previous
# desktop release. A re-run replaces the files of the release it already made.
# Bridge: desktop 1.2.0 and older only see releases tagged desktop-vX.Y.Z. While the newest release is 1.2.0 or older,
# the release goes on an extra tag desktop-vX.Y.Z at the same commit, so those installs find it (and with it the updater
# that reads desktop-X.Y.Z). Later releases are on the pushed tag itself.
# Only the desktop app has GitHub releases: the server's changes are in CHANGELOG.md, the phone apps' in the stores.
set -e
tag=$1
version=${tag#desktop-}
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && [ "$tag" = "desktop-$version" ] ||
  { echo "usage: $0 desktop-X.Y.Z" >&2; exit 2; }
[ -n "$ASSETS" ] && ls "$ASSETS"/* >/dev/null || { echo "::error::no packages in ASSETS" >&2; exit 1; }

for t in "$tag" "desktop-v$version"; do # a re-run
  if gh release view "$t" >/dev/null 2>&1; then
    gh release upload "$t" "$ASSETS"/* --clobber
    echo "Replaced the files of release $t"
    exit 0
  fi
done

ver_of() { echo "${1#desktop-}" | sed 's/^v//'; }
latest=$(gh release view --json tagName -q .tagName 2>/dev/null || true)
release_tag=$tag
if [ -n "$latest" ] && [ "$(printf '%s\n' "$(ver_of "$latest")" 1.2.0 | sort -V | tail -1)" = 1.2.0 ]; then
  release_tag="desktop-v$version"
  sha=$(git rev-parse "$tag^{commit}")
  gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$release_tag" -f sha="$sha" >/dev/null 2>&1 ||
    [ "$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$release_tag" -q .object.sha)" = "$sha" ] # made by a failed run
  echo "Bridge release for desktop 1.2.0 and older: tagged $release_tag too"
fi

# Previous desktop release = the highest desktop tag (either form) below this version.
prev_version=$(git tag -l 'desktop-*' | sed 's/^desktop-v\{0,1\}//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' |
  { cat; echo "$version"; } | sort -uV | grep -B1 -x "$version" | head -1)
prev=
if [ "$prev_version" != "$version" ]; then
  prev=$(git tag -l "desktop-$prev_version" "desktop-v$prev_version" | head -1)
fi
{
  echo "## What's changed"
  git log --no-merges --format='- %s (%h)' ${prev:+"$prev"..}"$tag" -- desktop
  [ -n "$prev" ] && echo && echo "Since v$prev_version."
} > release-notes.md
gh release create "$release_tag" "$ASSETS"/* --verify-tag --title "v$version" --notes-file release-notes.md --latest
echo "Released $release_tag as v$version"
