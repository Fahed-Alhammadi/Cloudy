#!/usr/bin/env python3
"""Versions of the four products (stdlib only). Each product is released on its own tag: <product>-vX.Y.Z.

  scripts/version.py status                 versions and whether each one is released (run `git fetch --tags` first)
  scripts/version.py bump <product> X.Y.Z   set the version (Android versionCode / iOS build number go up by one)
  scripts/version.py get <product>          print the version (used by the workflows)
  scripts/version.py build <product>        print the Android versionCode / iOS build number
  scripts/version.py released <product>     exit 0 if the current version already has a tag

Products: server (server/package.json), android (versionName in android/app/build.gradle.kts),
ios (MARKETING_VERSION in ios/project.yml), desktop (desktop/package.json). Pushing a bump to main makes CI publish that product.
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# product → (file, regex of the version with one group, optional (regex, group) of the build number)
FILES = {
    'server': ('server/package.json', r'^  "version": "([^"]+)"', None),
    'android': ('android/app/build.gradle.kts', r'versionName = "([^"]+)"', r'versionCode = (\d+)'),
    'ios': ('ios/project.yml', r'MARKETING_VERSION: "([^"]+)"', r'CURRENT_PROJECT_VERSION: "(\d+)"'),
    'desktop': ('desktop/package.json', r'^  "version": "([^"]+)"', None),
}
# Release notes sent with each store upload (see .github/workflows/android.yml and ios.yml).
NOTES = {'android': 'android/whatsnew/whatsnew-en-US', 'ios': 'ios/whatsnew/en-US.txt'}
# Before the split, server and Android were released together on plain vX.Y.Z tags; those count as released.
LEGACY = {'server', 'android'}


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


def tag(product, version=None):
    return f'{product}-v{version or get(product)}'


def tags():
    return set(subprocess.run(['git', 'tag', '--list'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split())


def released(product, have=None):
    have = tags() if have is None else have
    v = get(product)
    return tag(product, v) in have or (product in LEGACY and f'v{v}' in have)


def parse(v):
    if not re.fullmatch(r'\d+\.\d+\.\d+', v):
        sys.exit(f'version must look like 1.2.3, got {v!r}')
    return tuple(map(int, v.split('.')))


def sub_once(text, pattern, repl, path):
    new, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    if n != 1:
        sys.exit(f'version not found in {path}')
    return new


def bump(product, version):
    old = get(product)
    if parse(version) <= parse(old):
        sys.exit(f'{product}: {version} is not higher than the current {old}')
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
    extra = f' (build {build_number(product)})' if build else ''
    print(f'{product}: {old} → {version}{extra}. Commit and push to main to release it as {tag(product, version)}.')
    if product in NOTES:
        print(f'Update the "What\'s new" text in {NOTES[product]} for this version (it goes to the store with the upload).')


def main(args):
    if not args or args[0] in ('-h', '--help'):
        sys.exit(__doc__)
    cmd, rest = args[0], args[1:]
    if cmd == 'status':
        have = tags()
        for p in FILES:
            b = build_number(p)
            state = 'released' if released(p, have) else 'NOT released: pushing to main publishes it'
            print(f'{p:8} {get(p):10} {"build " + str(b) if b else "":10} {tag(p):22} {state}')
        return
    if not rest or rest[0] not in FILES:
        sys.exit(f'product must be one of: {", ".join(FILES)}')
    product = rest[0]
    if cmd == 'get':
        print(get(product))
    elif cmd == 'build' and FILES[product][2]:
        print(build_number(product))
    elif cmd == 'released':
        sys.exit(0 if released(product) else 1)
    elif cmd == 'bump' and len(rest) == 2:
        bump(product, rest[1])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
