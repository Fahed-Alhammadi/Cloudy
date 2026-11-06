#!/usr/bin/env python3
"""Versions of the four products (stdlib only).

All products share one version line: a release is one tag vX.Y.Z, and it contains the products whose version is X.Y.Z
(the ones bumped for it). Products not bumped keep the version of the release they last shipped in, so a product's
version may skip numbers (Android 1.15.0 → 1.17.0 when 1.16.0 was a server-only release).

  scripts/version.py status                         versions, the next release and whether it is out (run `git fetch --tags` first)
  scripts/version.py bump X.Y.Z <product>... | all  set those products to X.Y.Z (Android versionCode / iOS build number + 1)
  scripts/version.py get <product>                  print the version (used by the workflows)
  scripts/version.py build <product>                print the Android versionCode / iOS build number
  scripts/version.py plan                           for .github/workflows/release.yml: version=, products=, pending= lines

Products: server (server/package.json), android (versionName in android/app/build.gradle.kts),
ios (MARKETING_VERSION in ios/project.yml), desktop (desktop/package.json).
Pushing a bump to main makes .github/workflows/release.yml publish those products, then tag vX.Y.Z.
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


def tags():
    return set(subprocess.run(['git', 'tag', '--list'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split())


def latest_tag(have):
    """Highest vX.Y.Z tag (older ones up to v1.10.0 are server + Android releases from before the split)."""
    vs = [parse(t[1:]) for t in have if re.fullmatch(r'v\d+\.\d+\.\d+', t)]
    return '.'.join(map(str, max(vs))) if vs else None


def current():
    """The newest version any product has, and the products that have it: that is the release in the files."""
    versions = {p: get(p) for p in FILES}
    top = max(versions.values(), key=parse)
    return top, [p for p, v in versions.items() if v == top]


def released(version, products, have):
    # From 2026-10-25 to 2026-11-04 every product had its own <product>-vX.Y.Z tag; those versions are out too.
    return f'v{version}' in have or all(f'{p}-v{version}' in have for p in products)


def stranded(top, have):
    """Products whose version is below the newest one but was never released (a failed release bumped past)."""
    return [(p, v) for p in FILES if (v := get(p)) != top and not released(v, [p], have)]


def warn_stranded(top, have, out=sys.stderr):
    for p, v in stranded(top, have):
        print(f'warning: {p} {v} was never released; bump it again to publish it', file=out)


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
    if products == ['all']:
        products = list(FILES)
    bad = [p for p in products if p not in FILES]
    if not products or bad:
        sys.exit(f'name the products for this release: {", ".join(FILES)} or all')
    have = tags()
    top, _ = current()
    floor = max(filter(None, [top, latest_tag(have)]), key=parse)
    if parse(version) <= parse(floor):
        sys.exit(f'{version} must be higher than {floor} (the newest version or tag so far)')
    for p in products:
        old = get(p)
        set_version(p, version)
        extra = f' (build {build_number(p)})' if FILES[p][2] else ''
        print(f'{p}: {old} → {version}{extra}')
    print(f'Commit and push to main to release v{version} ({", ".join(products)}).')
    for p in products:
        if p in NOTES:
            what = 'the server changes for admins (## ' + version + ')' if p == 'server' else "the \"What's new\" text"
            print(f'Update {NOTES[p]}: {what}.')


def main(args):
    if not args or args[0] in ('-h', '--help'):
        sys.exit(__doc__)
    cmd, rest = args[0], args[1:]
    if cmd == 'status':
        for p in FILES:
            b = build_number(p)
            print(f'{p:8} {get(p):10} {"build " + str(b) if b else ""}')
        top, products = current()
        have = tags()
        state = 'released' if released(top, products, have) else 'NOT released: pushing to main publishes it'
        print(f'\nnewest: v{top} ({", ".join(products)}) {state}')
        warn_stranded(top, have, sys.stdout)
    elif cmd == 'plan':
        top, products = current()
        have = tags()
        pending = not released(top, products, have)
        for p, v in stranded(top, have):
            print(f'::warning::{p} {v} was never released; bump it again to publish it', file=sys.stderr)
        if pending and 'server' in products and not changelog_has(top):
            sys.exit(f'CHANGELOG.md has no "## {top}" section for the server release')
        print(f'version={top}\nproducts={" ".join(products)}\npending={str(pending).lower()}')
    elif cmd == 'bump' and len(rest) >= 2:
        parse(rest[0])
        bump(rest[0], rest[1:])
    elif cmd in ('get', 'build') and len(rest) == 1 and rest[0] in FILES:
        if cmd == 'get':
            print(get(rest[0]))
        elif FILES[rest[0]][2]:
            print(build_number(rest[0]))
        else:
            sys.exit(f'{rest[0]} has no build number')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
