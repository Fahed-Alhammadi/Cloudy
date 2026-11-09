#!/usr/bin/env python3
"""Versions of the four products (stdlib only).

Every product has its own version and is released by pushing its tag:
  server   server-X.Y.Z   → container image ghcr.io/<owner>/cloudy:X.Y.Z + :latest (notes: CHANGELOG.md)
  android  android-X.Y.Z  → Google Play internal testing (notes: android/whatsnew/whatsnew-en-US)
  ios      ios-X.Y.Z      → App Store Connect / TestFlight (notes: ios/whatsnew/en-US.txt)
  desktop  desktop-X.Y.Z  → GitHub release titled vX.Y.Z with the packages

  scripts/version.py status                     versions and whether they are tagged (run `git fetch --tags` first)
  scripts/version.py bump X.Y.Z <product>...    set those products to X.Y.Z (Android versionCode / iOS build number + 1)
  scripts/version.py get <product>              print the version (used by the workflows)
  scripts/version.py build <product>            print the Android versionCode / iOS build number
  scripts/version.py tag <product>              print the release tag for the version in the files
  scripts/version.py check <tag>                for the workflows: the tag matches the files (and CHANGELOG.md has the server version)

Products: server (server/package.json), android (versionName in android/app/build.gradle.kts),
ios (MARKETING_VERSION in ios/project.yml), desktop (desktop/package.json).
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# product → (file, regex of the version with one group, optional regex of the build number)
FILES = {
    'server': ('server/package.json', r'^  "version": "([^"]+)"', None),
    'android': ('android/app/build.gradle.kts', r'versionName = "([^"]+)"', r'versionCode = (\d+)'),
    'ios': ('ios/project.yml', r'MARKETING_VERSION: "([^"]+)"', r'CURRENT_PROJECT_VERSION: "(\d+)"'),
    'desktop': ('desktop/package.json', r'^  "version": "([^"]+)"', None),
}
# Release tag of each product: <product>-X.Y.Z. <product>-vX.Y.Z (renamed 2026-11-06) is still read.
PREFIX = {p: f'{p}-' for p in FILES}
LEGACY = {p: [f'{p}-v'] for p in FILES}
# What to update with a bump: the store release notes (sent with each upload) and the server changelog for admins.
NOTES = {'android': 'android/whatsnew/whatsnew-en-US', 'ios': 'ios/whatsnew/en-US.txt', 'server': 'CHANGELOG.md'}


def read(path):
    with open(os.path.join(ROOT, path)) as f:
        return f.read()


def write(path, text):
    with open(os.path.join(ROOT, path), 'w') as f:
        f.write(text)


def get(product):
    path, pattern, _ = FILES[product]
    return re.search(pattern, read(path), re.M).group(1)


def build_number(product):
    path, _, pattern = FILES[product]
    return int(re.search(pattern, read(path)).group(1)) if pattern else None


def parse(v):
    if not re.fullmatch(r'\d+\.\d+\.\d+', v):
        sys.exit(f'version must look like 1.2.3, got {v!r}')
    return tuple(map(int, v.split('.')))


def tag_of(product, version):
    return PREFIX[product] + version


def tags():
    return set(subprocess.run(['git', 'tag', '--list'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split())


def released_versions(product, have):
    out = []
    for prefix in [PREFIX[product]] + LEGACY.get(product, []):
        out += [t[len(prefix):] for t in have if t.startswith(prefix) and re.fullmatch(r'\d+\.\d+\.\d+', t[len(prefix):])]
    return sorted(set(out), key=parse)


def changelog_has(version):
    path = os.path.join(ROOT, NOTES['server'])
    return os.path.exists(path) and re.search(rf'^## {re.escape(version)}\b', read(path), re.M) is not None


def sub_once(text, pattern, repl, path):
    new, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    if n != 1:
        sys.exit(f'version not found in {path}')
    return new


def set_version(product, version):
    path, pattern, build = FILES[product]
    text = read(path)
    text = sub_once(text, pattern, lambda m: m.group(0).replace(m.group(1), version), path)
    if build:
        n = build_number(product) + 1
        text = sub_once(text, build, lambda m: m.group(0).replace(m.group(1), str(n)), path)
    write(path, text)
    if product in ('server', 'desktop'):  # keep the lock file's own version in step (top level and packages[""])
        lock = f'{product}/package-lock.json'
        text = read(lock)
        text = re.sub(r'^(  "version": ")[^"]+(")', rf'\g<1>{version}\2', text, count=1, flags=re.M)
        text = re.sub(r'^(      "version": ")[^"]+(")', rf'\g<1>{version}\2', text, count=1, flags=re.M)
        write(lock, text)


def bump(version, products):
    bad = [p for p in products if p not in FILES]
    if not products or bad:
        sys.exit(f'name the products to bump: {", ".join(FILES)}')
    have = tags()
    for p in products:  # check all first, so a refusal changes nothing
        done = released_versions(p, have)
        floor = max([get(p)] + done[-1:], key=parse)
        if parse(version) <= parse(floor):
            sys.exit(f'{p}: {version} must be higher than {floor} (its version or newest tag so far)')
    for p in products:
        old = get(p)
        set_version(p, version)
        extra = f' (build {build_number(p)})' if FILES[p][2] else ''
        print(f'{p}: {old} → {version}{extra}')
    for p in products:
        if p in NOTES:
            what = f'the server changes for admins (## {version})' if p == 'server' else "the \"What's new\" text"
            print(f'Update {NOTES[p]}: {what}.')
    print('Then commit, push to main, and release by tagging that commit:')
    for p in products:
        print(f'  git tag {tag_of(p, version)} && git push origin {tag_of(p, version)}')


def check(tag):
    """The workflows run this on a tag push: the tag must name the version in the files."""
    for p, prefix in PREFIX.items():
        if tag.startswith(prefix) and re.fullmatch(r'\d+\.\d+\.\d+', tag[len(prefix):]):
            version = tag[len(prefix):]
            break
    else:
        sys.exit(f'{tag} is not a release tag ({", ".join(p + "X.Y.Z" for p in PREFIX.values())})')
    if get(p) != version:
        sys.exit(f'{tag}: the files at this commit have {p} {get(p)}. '
                 f'Run scripts/version.py bump {version} {p}, commit, and tag that commit.')
    if p == 'server' and not changelog_has(version):
        sys.exit(f'{tag}: CHANGELOG.md has no "## {version}" section')
    print(f'{tag}: {p} {version}' + (f' build {build_number(p)}' if FILES[p][2] else ''))


def main(args):
    if not args or args[0] in ('-h', '--help'):
        sys.exit(__doc__)
    cmd, rest = args[0], args[1:]
    if cmd == 'status':
        have = tags()
        for p in FILES:
            v, b = get(p), build_number(p)
            tag = tag_of(p, v)
            state = 'released' if v in released_versions(p, have) else f'not released: push tag {tag}'
            print(f'{p:8} {v:8} {("build " + str(b)) if b else "":10} {state}')
    elif cmd == 'bump' and len(rest) >= 2:
        parse(rest[0])
        bump(rest[0], rest[1:])
    elif cmd in ('get', 'build', 'tag') and len(rest) == 1 and rest[0] in FILES:
        p = rest[0]
        if cmd == 'get':
            print(get(p))
        elif cmd == 'tag':
            print(tag_of(p, get(p)))
        elif FILES[p][2]:
            print(build_number(p))
        else:
            sys.exit(f'{p} has no build number')
    elif cmd == 'check' and len(rest) == 1:
        check(rest[0])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
