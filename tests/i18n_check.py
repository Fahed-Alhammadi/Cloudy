#!/usr/bin/env python3
"""Checks translations (stdlib only, no server needed): python3 tests/i18n_check.py

- web: every t('…') text in server/public/js has an entry in each server/public/i18n/<lang>.json, same {placeholders}
- Android: every string in res/values has each res/values-<lang> translation, same %1$s/%1$d arguments
- iOS: every string in Localizable.xcstrings / InfoPlist.xcstrings is translated into each language, same %@/%lld
- desktop: every t('…') text in desktop/src (main process and window) has an entry in each desktop/i18n/<lang>.json
- the language list is the same in server/src/i18n.ts, js/i18n.js, locales_config.xml, Lang.kt, the iOS and Drive Info.plist
  and desktop/src/main/i18n.ts
"""
import glob, json, os, re, sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'server/public')
RES = os.path.join(ROOT, 'android/app/src/main/res')
IOS = os.path.join(ROOT, 'ios/Cloudy')
DESKTOP = os.path.join(ROOT, 'desktop')
errors = []


def langs_in(path, pattern):
    return re.findall(pattern, open(os.path.join(ROOT, path)).read())


# ---- language lists
server = re.search(r"LANGUAGES = \[([^\]]+)\]", open(os.path.join(ROOT, 'server/src/i18n.ts')).read()).group(1)
lists = {
    'server/src/i18n.ts': re.findall(r"'(\w+)'", server),
    'server/public/js/i18n.js': langs_in('server/public/js/i18n.js', r"\['(\w+)', '[^']+'\]"),
    'locales_config.xml': langs_in('android/app/src/main/res/xml/locales_config.xml', r'android:name="(\w+)"'),
    'iOS Info.plist': re.findall(r'<string>(\w\w)</string>', re.search(r'CFBundleLocalizations</key>\s*<array>(.*?)</array>', open(os.path.join(IOS, 'Info.plist')).read(), re.S).group(1)),
    'desktop/src/main/i18n.ts': re.findall(r"'(\w+)'", re.search(r"LANGUAGES = \[([^\]]+)\]", open(os.path.join(DESKTOP, 'src/main/i18n.ts')).read()).group(1)),
    'Lang.kt': re.findall(r'"(\w+)"', re.search(r'val CODES = listOf\(([^)]*)\)', open(os.path.join(ROOT, 'android/app/src/main/java/io/cloudy/app/data/Lang.kt')).read()).group(1)),
}
first = next(iter(lists.values()))
for where, codes in lists.items():
    if codes != first:
        errors.append(f'language list in {where} is {codes}, expected {first}')
translated = [c for c in first if c != 'en']

# ---- web
call = re.compile(r"""\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")""")
keys = set()
for f in glob.glob(os.path.join(WEB, 'js/*.js')):
    src = open(f).read()
    for m in call.finditer(src):
        keys.add((m.group(1) if m.group(1) is not None else m.group(2)).replace("\\'", "'").replace('\\"', '"'))
    # Labels kept in tables and translated where they are drawn, e.g. NAV in app.js.
    keys.update(re.findall(r"\['[\w-]+', '([^']+)', '\w+'\]", src))
ph = lambda s: sorted(re.findall(r'\{\w+\}', s))
for lang in translated:
    path = os.path.join(WEB, f'i18n/{lang}.json')
    d = json.load(open(path)) if os.path.exists(path) else {}
    for k in sorted(keys):
        if k not in d: errors.append(f'web {lang}: missing "{k}"')
        elif ph(k) != ph(d[k]): errors.append(f'web {lang}: placeholders differ in "{k}"')

# ---- desktop (texts in the main process and the settings window, plus the activity labels in KIND)
desktop_keys = set()
for f in glob.glob(os.path.join(DESKTOP, 'src/**/*.[jt]s'), recursive=True):
    src = open(f).read()
    for m in call.finditer(src):
        desktop_keys.add((m.group(1) if m.group(1) is not None else m.group(2)).replace("\\'", "'").replace('\\"', '"'))
    kind = re.search(r'const KIND = \{(.*?)\};', src, re.S)
    if kind: desktop_keys.update(re.findall(r":\s*'([^']+)'", kind.group(1)))
for lang in translated:
    path = os.path.join(DESKTOP, f'i18n/{lang}.json')
    d = json.load(open(path)) if os.path.exists(path) else {}
    for k in sorted(desktop_keys):
        if k not in d: errors.append(f'desktop {lang}: missing "{k}"')
        elif ph(k) != ph(d[k]): errors.append(f'desktop {lang}: placeholders differ in "{k}"')
    for k in sorted(d.keys() - desktop_keys):
        errors.append(f'desktop {lang}: "{k}" is not used')

# ---- Android
def strings(path):
    return {e.get('name'): (e.text or '', e.get('translatable') != 'false') for e in ET.parse(path).getroot().iter('string')}
base = strings(os.path.join(RES, 'values/strings.xml'))
args = lambda s: sorted(re.findall(r'%\d\$[sd]', s))
for lang in translated:
    path = os.path.join(RES, f'values-{lang}/strings.xml')
    tr = strings(path) if os.path.exists(path) else {}
    for name, (text, translatable) in base.items():
        if not translatable: continue
        if name not in tr: errors.append(f'android {lang}: missing {name}')
        elif args(text) != args(tr[name][0]): errors.append(f'android {lang}: format arguments differ in {name}')
    for name in tr.keys() - base.keys():
        errors.append(f'android {lang}: {name} is not in values/strings.xml')

# ---- iOS (String Catalogs; Xcode adds new keys from the Swift code when the app is built in Xcode)
ios_count = 0
fmt = lambda s: sorted(re.findall(r'%(?:\d\$)?(?:lld|ld|d|@)', s))
for path in (f'{IOS}/Resources/Localizable.xcstrings', f'{IOS}/Resources/InfoPlist.xcstrings'):
    catalog = os.path.relpath(path, ROOT)
    cat = json.load(open(path))
    for key, entry in cat['strings'].items():
        if entry.get('shouldTranslate') is False: continue
        ios_count += 1
        for lang in translated:
            unit = entry.get('localizations', {}).get(lang, {}).get('stringUnit')
            if not unit or unit.get('state') != 'translated' or not unit.get('value'):
                errors.append(f'ios {lang}: missing "{key}" in {catalog}')
            elif fmt(key) != fmt(unit['value']):
                errors.append(f'ios {lang}: format arguments differ in "{key}"')

if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(f'i18n OK: {len(first)} languages, {len(keys)} web strings, {len(base)} Android strings, {ios_count} iOS strings, {len(desktop_keys)} desktop strings')
