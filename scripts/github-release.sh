#!/bin/sh
# Marks the current commit as released: tag <product>-v<version>. Used by the workflows after a successful publish;
# the tag is what scripts/version.py checks to know a version is already out.
#   scripts/github-release.sh <product> --tag-only                           android / ios (needs GH_TOKEN)
#   scripts/github-release.sh <product> <title> <latest:true|false> <path>... desktop, server: tag + GitHub release
# Desktop: release with its packages + latest*.yml (installed apps update from it), marked Latest. Server: release with
# notes only (admins read what changed before `docker compose pull`), never Latest. The phone apps ship through the
# stores, so they get only the tag.
# With a release, the notes list the commits that touched <path>... since the product's previous tag, and
# ASSETS=<dir> attaches every file in that folder in the same step, so the release never exists without them.
set -e
product=$1
version=$(scripts/version.py get "$product")
tag="$product-v$version"
if [ "$2" = --tag-only ]; then
  gh api -X POST "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$tag" -f sha="$GITHUB_SHA" >/dev/null
  echo "Tagged $tag (no GitHub release)"
  exit 0
fi
title=$2 latest=$3
shift 3
prev=$(git tag --list "$product-v*" --sort=-v:refname | head -1)
{
  echo "## What's changed"
  git log --no-merges --format='- %s (%h)' ${prev:+"$prev"..}HEAD -- "$@"
  [ -n "$prev" ] && echo && echo "Since $prev."
} > release-notes.md
gh release create "$tag" ${ASSETS:+"$ASSETS"/*} --target "$GITHUB_SHA" --title "$title v$version" --notes-file release-notes.md --latest="$latest"
echo "Released $tag"
