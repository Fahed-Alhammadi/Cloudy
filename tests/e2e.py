"""End-to-end smoke test for Cloudy. Usage: python3 -I e2e.py http://localhost:8088 admin <password>"""
import base64, hashlib, email, email.header, http.cookiejar, io, json, os, socketserver, sys, threading, time, urllib.request, urllib.error, zipfile, re, uuid

BASE, ADMIN, ADMIN_PW = sys.argv[1], sys.argv[2], sys.argv[3]
passed = failed = 0

def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1; print(f'  ok   {name}')
    else:
        failed += 1; print(f'  FAIL {name} {detail}')

class Client:
    def __init__(self, basic=None):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.basic = basic
    def req(self, method, path, body=None, headers=None, raw=False):
        h = {'X-Cloudy-Request': '1'}
        if self.basic: h['Authorization'] = 'Basic ' + base64.b64encode(self.basic.encode()).decode()
        h.update(headers or {})
        data = body
        if body is not None and not isinstance(body, (bytes, str)):
            data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
        elif isinstance(body, str):
            data = body.encode()
        r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
        try:
            resp = self.op.open(r)
        except urllib.error.HTTPError as e:
            resp = e
        content = resp.read()
        if raw: return resp.status, content, resp.headers
        ct = resp.headers.get('content-type') or ''
        return resp.status, (json.loads(content) if 'json' in ct and content else content.decode(errors='replace'))

def wait_for(pred, seconds=5):
    end = time.time() + seconds
    while time.time() < end:
        if pred(): return True
        time.sleep(0.1)
    return False

admin = Client()
print('== auth')
s, _ = admin.req('POST', '/api/login', {'user': ADMIN, 'password': 'wrong'})
check('bad password rejected', s == 401)
s, me = admin.req('POST', '/api/login', {'user': ADMIN, 'password': ADMIN_PW})
check('admin login', s == 200, me)
s, me = admin.req('GET', '/api/me')
root = me['rootId']
check('me has rootId', s == 200 and root)
s, _ = Client().req('GET', '/api/me')
check('anonymous /api/me is 401', s == 401)
# The web app's pages have plain addresses (no "#"): each is the app; other paths stay 404.
pages = ['/', '/files', f'/files/{root}', '/recent', '/shared-in', '/search?q=a%2Fb', '/settings', '/admin', '/forgot', '/reset', '/invite', '/app']
served = {p: Client().req('GET', p, raw=True)[:2] for p in pages}
check('app served at its plain addresses', all(st == 200 and b'/js/app.js' in body for st, body in served.values()),
      [p for p, (st, body) in served.items() if st != 200])
check('unknown addresses stay 404', all(Client().req('GET', p)[0] == 404 for p in ['/nope', '/files/1/2', '/filesx', '/s/abc/x']))
s, _ = admin.req('POST', '/api/nodes/%d/folders' % root, {'name': 'x'}, headers={'X-Cloudy-Request': '0'})
check('CSRF header required', s == 403)

print('== delete own account (apps + web)')
erin = 'erin' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/users', {'id': erin, 'password': 'erin-pass-123'})
ec = Client()
s, r = ec.req('POST', '/api/auth/token', {'user': erin, 'password': 'erin-pass-123', 'deviceName': 'phone'})
eh = {'Authorization': 'Bearer ' + r['token']}
s, em = ec.req('GET', '/api/me', headers=eh)
s, ef = ec.req('POST', f"/api/nodes/{em['rootId']}/files", {'name': 'mine.txt', 'content': 'private'}, headers=eh)
s, _ = ec.req('POST', f"/api/nodes/{ef['id']}/shares", {'type': 'user', 'shareWith': ADMIN, 'canEdit': False}, headers=eh)
s, inc = admin.req('GET', '/api/shares/incoming')
check('setup: deleted-to-be user shares a file', any(x['id'] == ef['id'] for x in inc))
s, _ = ec.req('POST', '/api/me/delete', {'password': 'wrong'}, headers=eh)
check('account deletion needs the right password', s == 403 and ec.req('GET', '/api/me', headers=eh)[0] == 200)
s, _ = ec.req('POST', '/api/me/delete', {'password': 'erin-pass-123'}, headers={**eh, 'X-Cloudy-Request': '0'})
check('account deletion needs the CSRF header', s == 403)
s, _ = ec.req('POST', '/api/me/delete', {'password': 'erin-pass-123'}, headers=eh)
check('delete own account with a device token', s == 204)
check('device token dead after deletion', ec.req('GET', '/api/me', headers=eh)[0] == 401)
# (no login attempt with the deleted account: it would count against the per-IP limit the 2FA tests below rely on)
s, users = admin.req('GET', '/api/admin/users')
check('deleted user gone from admin list', not any(u['id'] == erin for u in users))
s, inc = admin.req('GET', '/api/shares/incoming')
check("deleted user's shares gone", not any(x['id'] == ef['id'] for x in inc))
check("deleted user's file gone", admin.req('GET', f"/api/nodes/{ef['id']}")[0] == 404)
frank = 'frank' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/users', {'id': frank, 'password': 'frank-pass-123'})
fc = Client()
fc.req('POST', '/api/login', {'user': frank, 'password': 'frank-pass-123'})
s, _ = fc.req('POST', '/api/me/delete', {'password': 'frank-pass-123'})
check('delete own account from the web (session)', s == 204 and fc.req('GET', '/api/me')[0] == 401)
admins = [u for u in users if u['isAdmin'] and not u['disabled']]
if len(admins) == 1:
    s, err = admin.req('POST', '/api/me/delete', {'password': ADMIN_PW})
    check('only administrator cannot delete own account', s == 409 and admin.req('GET', '/api/me')[0] == 200, err)

print('== language (removed in 2.0)')
check('/api/me has no language field', 'language' not in me, me.get('language'))
s, _ = admin.req('PATCH', '/api/me', {'language': 'de'})
s2, me_l = admin.req('GET', '/api/me')
check('PATCH /api/me {language} is ignored (no language field)', s == 204 and s2 == 200 and 'language' not in me_l, (s, me_l.get('language')))

print('== users & groups')
bob = 'bob' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/groups', {'id': 'staff'})
s, _ = admin.req('POST', '/api/admin/users', {'id': bob, 'password': 'bob-pass-123', 'displayName': 'Bob', 'groups': ['staff']})
check('create user', s == 204, _)
bobc = Client()
s, _ = bobc.req('POST', '/api/login', {'user': bob, 'password': 'bob-pass-123'})
check('new user can log in', s == 200)
s, _ = bobc.req('GET', '/api/admin/users')
check('non-admin blocked from admin API', s == 403)

print('== profile pictures')
import struct, zlib
def png_pic(w, h, pad=0):
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    rows = b''.join(b'\0' + b'\x80\x40\x20' * w for _ in range(h)) if w * h <= 4096 else b''  # big ones: the header is what counts
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows))
            + (chunk(b'tEXt', b'pad\0' + b'x' * pad) if pad else b'') + chunk(b'IEND', b''))
def jpeg_pic(w, h):
    seg = lambda m, d: b'\xff' + bytes([m]) + struct.pack('>H', len(d) + 2) + d
    # EXIF with a frame header of its own (its small preview) comes before the real one: skipped
    return (b'\xff\xd8' + seg(0xe0, b'JFIF\0\x01\x01\0\0\x01\0\x01\0\0') + seg(0xe1, b'Exif\0\0\xff\xc0\0\x11\x08\x7f\xff\x7f\xff' + bytes(12))
            + seg(0xdb, bytes(65)) + seg(0xc0, struct.pack('>BHHB', 8, h, w, 1) + b'\x01\x11\0') + b'\xff\xd9')
def webp_x(w, h):
    body = b'WEBPVP8X' + struct.pack('<I', 10) + b'\0' * 4 + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little')
    return b'RIFF' + struct.pack('<I', len(body)) + body
webp_pics = {k: base64.b64decode(v) for k, v in {  # 1×1 pictures: simple lossy (VP8), lossless (VP8L), with alpha (VP8X)
    'lossy': 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    'lossless': 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
    'alpha': 'UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA=='}.items()}
pic_h = {'Content-Type': 'application/octet-stream'}
admin_pic = f'/api/users/{ADMIN}/avatar'
admin.req('DELETE', '/api/me/avatar')  # (a clean start)
s, _ = bobc.req('GET', admin_pic)
check('no profile picture: 404', s == 404, s)
pic = png_pic(48, 48)
s, r = admin.req('PUT', '/api/me/avatar', pic, headers=pic_h)
check('upload a PNG profile picture', s == 200 and re.fullmatch(r'[0-9a-f]{16}', r.get('avatar', '')), (s, r))
v1 = r.get('avatar')
check('/api/me names the picture version', admin.req('GET', '/api/me')[1].get('avatar') == v1)
s, body, hd = bobc.req('GET', admin_pic, raw=True)
check('another user sees it', s == 200 and body == pic and hd.get('Content-Type') == 'image/png' and hd.get('Content-Length') == str(len(pic)), (s, hd.get('Content-Type')))
check('picture headers: version, no sniffing, sandboxed, this site only', hd.get('ETag') == f'"{v1}"' and hd.get('X-Content-Type-Options') == 'nosniff'
      and hd.get('Content-Security-Policy') == "default-src 'none'; sandbox" and hd.get('Cross-Origin-Resource-Policy') == 'same-origin', dict(hd))
check('without ?v= the browser asks again each time', hd.get('Cache-Control') == 'private, no-cache', hd.get('Cache-Control'))
s, _, hd = bobc.req('GET', f'{admin_pic}?v={v1}', raw=True)
check('with ?v=<version> it is kept for good', s == 200 and hd.get('Cache-Control') == 'private, max-age=31536000, immutable', hd.get('Cache-Control'))
s, _, hd = bobc.req('GET', f'{admin_pic}?v=0123456789abcdef', raw=True)
check('an old ?v= is not kept', s == 200 and hd.get('Cache-Control') == 'private, no-cache', hd.get('Cache-Control'))
s, body, _ = bobc.req('GET', admin_pic, headers={'If-None-Match': f'"{v1}"'}, raw=True)
check('unchanged picture: 304', s == 304 and body == b'', s)
s, body, hd = bobc.req('HEAD', admin_pic, raw=True)
check('HEAD: headers only', s == 200 and body == b'' and hd.get('Content-Length') == str(len(pic)), (s, hd.get('Content-Length')))
s, _ = Client().req('GET', admin_pic)
check('pictures need a sign-in', s == 401, s)
for name, data, mime in [('JPEG', jpeg_pic(320, 200), 'image/jpeg')] + [(f'WebP ({k})', v, 'image/webp') for k, v in webp_pics.items()]:
    s, r = admin.req('PUT', '/api/me/avatar', data, headers=pic_h)
    s2, body, hd = bobc.req('GET', f"{admin_pic}?v={r.get('avatar') if s == 200 else ''}", raw=True)
    # Stored without what it says about the photo (the JPEG's EXIF segment); the WebPs carry none: unchanged.
    want = body == data if mime == 'image/webp' else (b'Exif' in data and b'Exif' not in body and b'JFIF' in body)
    check(f'{name} picture accepted', s == 200 and s2 == 200 and hd.get('Content-Type') == mime and want, (s, r, hd.get('Content-Type')))
s, r = admin.req('PUT', '/api/me/avatar', pic, headers=pic_h)
check('the same picture again: the same version', s == 200 and r.get('avatar') == v1, r)
for name, data in [('SVG', b'<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><script>alert(1)</script></svg>'),
                   ('GIF', base64.b64decode('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')),
                   ('text', b'just some text'), ('HTML', b'<!doctype html><script>alert(1)</script>'), ('empty', b''),
                   ('a cut-off PNG', pic[:20])]:
    s, e = admin.req('PUT', '/api/me/avatar', data, headers={'Content-Type': 'image/png'})  # the type the client claims is not believed
    check(f'{name} refused', s == 400 and e.get('error') == 'Use a JPEG, PNG or WebP picture', (s, e))
for name, data in [('PNG 4096 × 16', png_pic(4096, 16)), ('JPEG 1000 × 3000', jpeg_pic(1000, 3000)), ('WebP 1025 × 1025', webp_x(1025, 1025))]:
    s, e = admin.req('PUT', '/api/me/avatar', data, headers=pic_h)
    check(f'{name} refused (too many pixels for other browsers)', s == 400 and e.get('error') == 'Picture is too large (max 1024 × 1024 pixels)', (s, e))
# The server answers 413 from the Content-Length and closes the connection while the body is still being sent; the
# client may then see the answer or only a broken pipe / reset (timing). Either way the picture was refused.
try:
    s, e = admin.req('PUT', '/api/me/avatar', png_pic(8, 8, pad=1024 * 1024), headers=pic_h)
    check('over 1 MiB refused (413)', s == 413 and e.get('error') == 'Picture is too large (max 1 MB)', (s, e))
except (ConnectionError, urllib.error.URLError) as err:
    check('over 1 MiB refused (connection closed early)', True, err)
check('a refused picture keeps the one before', admin.req('GET', '/api/me')[1].get('avatar') == v1)
s, r = admin.req('PUT', '/api/me/avatar', png_pic(1024, 1024), headers=pic_h)
check('1024 × 1024 is allowed', s == 200, (s, r))
s, r = admin.req('PUT', '/api/me/avatar', png_pic(8, 8, pad=40), headers=pic_h)
s2, body, _ = bobc.req('GET', f"{admin_pic}?v={r.get('avatar')}", raw=True)
check('a PNG\'s text chunks are cut out', s == 200 and s2 == 200 and b'tEXt' not in body and b'IEND' in body, (s, r))
s, r = admin.req('PUT', '/api/me/avatar', pic, headers=pic_h)
# names in lists come with the picture's version
s, r = bobc.req('PUT', '/api/me/avatar', jpeg_pic(64, 64), headers=pic_h)
vb = r.get('avatar')
s, found = admin.req('GET', f'/api/sharees?q={bob}')
check('people search: their picture version', any(u['id'] == bob and u.get('avatar') == vb for u in found.get('users', [])), found)
s, pf = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'pictures-' + uuid.uuid4().hex[:6]})
admin.req('POST', f"/api/nodes/{pf['id']}/shares", {'type': 'user', 'shareWith': bob})
admin.req('POST', f"/api/nodes/{pf['id']}/shares", {'type': 'link'})
s, lst = admin.req('GET', f"/api/nodes/{pf['id']}/shares")
check("a share: the person's picture (links have none)", any(x['shareWith'] == bob and x.get('shareWithAvatar') == vb for x in lst)
      and all(x.get('shareWithAvatar') is None for x in lst if x['type'] == 'link'), lst)
s, inc = bobc.req('GET', '/api/shares/incoming')
check("shared with you: the owner's picture", any(x['id'] == pf['id'] and x.get('ownerAvatar') == v1 for x in inc), [(x['id'], x.get('ownerAvatar')) for x in inc])
s, users = admin.req('GET', '/api/admin/users')
check('administration: picture versions', all('avatar' in u for u in users) and any(u['id'] == bob and u['avatar'] == vb for u in users), users)
s, _ = admin.req('PATCH', f'/api/admin/users/{bob}', {'removeAvatar': True})
check('an administrator removes a picture', s == 204 and bobc.req('GET', f'/api/users/{bob}/avatar')[0] == 404 and bobc.req('GET', '/api/me')[1].get('avatar') is None)
admin.req('DELETE', f"/api/nodes/{pf['id']}")
s, _ = admin.req('DELETE', '/api/me/avatar')
check('delete own picture', s == 204 and bobc.req('GET', admin_pic)[0] == 404 and admin.req('GET', '/api/me')[1].get('avatar') is None, s)
check('unknown user: 404', bobc.req('GET', f'/api/users/nobody-{uuid.uuid4().hex[:6]}/avatar')[0] == 404)

print('== invitations')
# (wrong links count against a limit per address of their own, apart from sign-ins: this section uses at most 6 of 10)
import datetime
adm = admin.req('GET', '/api/me')[1]
invalid = 'This invitation is invalid or has expired. Ask for a new one.'
tok_of = lambda inv: inv.get('url', '#').split('#', 1)[1]
check_inv = lambda tok: Client().req('POST', '/api/invitations/check', {'token': tok})
inv_admin = [('GET', '/api/admin/invitations', None), ('POST', '/api/admin/invitations', {'email': 'x@example.com'}),
             ('POST', '/api/admin/invitations/1/resend', {}), ('DELETE', '/api/admin/invitations/1', None)]
check('invitations: administrators only', all(bobc.req(m, p, b)[0] == 403 for m, p, b in inv_admin) and all(Client().req(m, p, b)[0] == 401 for m, p, b in inv_admin))
for body, why in [({'email': 'not-an-address'}, 'Invalid email address'), ({'send': True}, 'Enter the email address to send the invitation to'),
                  ({'groups': ['nope-' + uuid.uuid4().hex[:6]]}, 'Unknown group: nope-'), ({'displayName': 'x' * 101}, 'Display name is too long (max 100)'),
                  ({'quotaBytes': 'lots'}, 'Invalid quota')]:
    s, e = admin.req('POST', '/api/admin/invitations', body)
    check(f'invitation refused: {why}', s == 400 and e.get('error', '').startswith(why), (s, e))
guest = 'guest' + uuid.uuid4().hex[:6]
s, inv = admin.req('POST', '/api/admin/invitations', {'email': f'{guest}@Example.com', 'displayName': 'Gina Guest', 'quotaBytes': 5_000_000,
                                                      'groups': ['staff'], 'isAdmin': True})
check('invitation: a link with the token in the fragment', s == 201 and re.search(r'/invite#[\w-]{43}$', inv.get('url', '')) and inv.get('emailed') is False
      and 'emailError' not in inv, inv)
expires = datetime.datetime.fromisoformat(inv.get('expiresAt', '2000-01-01T00:00:00Z').replace('Z', '+00:00'))
check('...valid for 7 days', abs((expires - datetime.datetime.now(datetime.timezone.utc)).total_seconds() - 7 * 86400) < 600, inv.get('expiresAt'))
s, lst = admin.req('GET', '/api/admin/invitations')
mine = next((i for i in lst if i['id'] == inv.get('id')), {})
check('invitation listed first, without its token and without any admin flag', lst and lst[0]['id'] == inv['id'] and mine.get('email') == f'{guest}@Example.com'
      and mine.get('displayName') == 'Gina Guest' and mine.get('invitedBy') == ADMIN and mine.get('invitedByName') == adm['displayName']
      and mine.get('quotaBytes') == 5_000_000 and mine.get('groups') == ['staff'] and mine.get('emailedAt') is None
      and mine.get('createdAt') and mine.get('expiresAt') and not any(k in mine for k in ('token', 'tokenHash', 'url', 'isAdmin')), mine)
itok = tok_of(inv)
s, c = check_inv(itok)
check('the link shows the invitation and suggests a username', s == 200 and c == {'email': f'{guest}@Example.com', 'displayName': 'Gina Guest',
      'invitedBy': adm['displayName'], 'expiresAt': inv['expiresAt'], 'username': guest}, c)
s, e = check_inv('A' * 43)
check('an unknown link is refused', s == 400 and e.get('error') == invalid, (s, e))
s, e = Client().req('POST', '/api/invitations/accept', {'token': 'cut-off', 'username': 'x' + guest, 'password': 'guest-pass-123'})
check('accepting with a broken link is refused', s == 400 and e.get('error') == invalid, (s, e))
s, _ = Client().req('POST', '/api/invitations/check', {'token': itok}, headers={'X-Cloudy-Request': '0'})
check('the invitation pages need the CSRF header too', s == 403, s)
gc2 = Client()
# Someone else's email address as a username would catch their password reset requests (reset looks the name up first).
holder = f'holder{uuid.uuid4().hex[:6]}'
admin.req('POST', '/api/admin/users', {'id': holder, 'password': 'holder-pass-123', 'email': f'{holder}@example.com'})
for change, st, why in [({'username': bob.upper()}, 409, 'User already exists'), ({'username': 'no spaces'}, 400, 'Username may contain'),
                        ({'username': '..'}, 400, 'Usernames start with a letter or a digit'), ({'username': '.'}, 400, 'Usernames start with a letter or a digit'),
                        ({'username': f'{holder}@EXAMPLE.com'}, 409, 'This username is the email address of another account'),
                        ({'password': 'short'}, 400, 'Password must be at least 8 characters'), ({'displayName': 'x' * 101}, 400, 'Display name is too long')]:
    s, e = gc2.req('POST', '/api/invitations/accept', {'token': itok, 'username': guest, 'password': 'guest-pass-123', **change})
    check(f'accept refused ({why}); the invitation still works', s == st and e.get('error', '').startswith(why) and check_inv(itok)[0] == 200, (s, e))
s, acc = gc2.req('POST', '/api/invitations/accept', {'token': itok, 'username': guest, 'password': 'guest-pass-123', 'isAdmin': True,
                                                     'email': 'someone-else@example.com'})
check('accept creates the account', s == 201 and acc.get('id') == guest and acc.get('rootId'), (s, acc))
admin.req('DELETE', f'/api/admin/users/{holder}', {'adminPassword': ADMIN_PW})
check("...never an administrator, with the invitation's address, name, quota and groups", acc.get('isAdmin') is False and acc.get('email') == f'{guest}@Example.com'
      and acc.get('displayName') == 'Gina Guest' and acc.get('quotaBytes') == 5_000_000 and acc.get('groups') == ['staff'], acc)
s, gme = gc2.req('GET', '/api/me')
check('...and signs the browser in', s == 200 and gme.get('id') == guest and gme.get('isAdmin') is False, (s, gme))
s, e = check_inv(itok)
check('the link works only once', s == 400 and e.get('error') == invalid, (s, e))
check('a used invitation leaves the list', not any(i['id'] == inv['id'] for i in admin.req('GET', '/api/admin/invitations')[1]))
s, _ = Client().req('POST', '/api/login', {'user': guest, 'password': 'guest-pass-123'})
check('the new account signs in with its own password', s == 200, s)
# a suggested name that is taken gets a number; a new invitation to the same address replaces the one before
s, inv2 = admin.req('POST', '/api/admin/invitations', {'email': f'{bob.upper()}+work@example.com'})
s, c2 = check_inv(tok_of(inv2))
check('suggested username: the taken one with a number', s == 200 and c2.get('username') == f'{bob}2', (s, c2))
s, inv2b = admin.req('POST', '/api/admin/invitations', {'email': f'{bob}+WORK@example.com'})
ids = [i['id'] for i in admin.req('GET', '/api/admin/invitations')[1]]
check('a new invitation to the same address replaces the one before', inv2b['id'] in ids and inv2['id'] not in ids, ids)
admin.req('DELETE', f"/api/admin/invitations/{inv2b['id']}")
# one link used three times at the same moment: one account
s, inv3 = admin.req('POST', '/api/admin/invitations', {})
racers = [f'racer{i}-{uuid.uuid4().hex[:6]}' for i in range(3)]
raced = [None] * 3
def race(i):
    raced[i] = Client().req('POST', '/api/invitations/accept', {'token': tok_of(inv3), 'username': racers[i], 'password': 'racer-pass-123',
                                                                 'email': f'{racers[i]}@example.com'})
threads = [threading.Thread(target=race, args=(i,)) for i in range(3)]
[t.start() for t in threads]; [t.join() for t in threads]
made = [u['id'] for u in admin.req('GET', '/api/admin/users')[1] if u['id'] in racers]
check('one invitation used three times at once: one account', sorted(r[0] for r in raced) == [201, 400, 400] and len(made) == 1, ([r[0] for r in raced], made))
winner = next((r[1] for r in raced if r[0] == 201), {})
check('an invitation without an address takes the one typed in', winner.get('email') == f"{winner.get('id')}@example.com", winner)
# withdraw, renew
s, inv4 = admin.req('POST', '/api/admin/invitations', {'displayName': 'Withdrawn'})
s, _ = admin.req('DELETE', f"/api/admin/invitations/{inv4['id']}")
check('a withdrawn invitation stops working', s == 204 and check_inv(tok_of(inv4))[0] == 400, s)
s, inv5 = admin.req('POST', '/api/admin/invitations', {'displayName': 'Renewed'})
s, re5 = admin.req('POST', f"/api/admin/invitations/{inv5['id']}/resend", {})
old_s = check_inv(tok_of(inv5))[0]
new_s, c5 = check_inv(tok_of(re5))
check('resending makes a new link; the old one stops working', s == 200 and re5.get('id') == inv5['id'] and re5.get('url') != inv5['url']
      and re5.get('emailed') is False and old_s == 400 and new_s == 200 and c5.get('displayName') == 'Renewed', (s, re5, old_s, new_s))
s, e = admin.req('POST', f"/api/admin/invitations/{inv5['id']}/resend", {'send': True})
check('emailing an invitation needs its address', s == 400 and e.get('error') == 'Enter the email address to send the invitation to', (s, e))
check('an unknown invitation: 404', admin.req('POST', '/api/admin/invitations/999999999/resend', {})[0] == 404)
admin.req('DELETE', f"/api/admin/invitations/{inv5['id']}")
for u in [guest] + made:
    admin.req('DELETE', f'/api/admin/users/{u}', {'adminPassword': ADMIN_PW})

print('== limits (Administration, applied without a restart)')
s, lim0 = admin.req('GET', '/api/admin/limits')
check('admin reads limits', s == 200 and all(isinstance(lim0.get(k), int) for k in ('trashDays', 'maxVersions', 'sessionDays', 'deviceDays', 'diskReserveMb')), lim0)
s, _ = bobc.req('GET', '/api/admin/limits')
check('non-admin cannot read limits', s == 403)
s, _ = bobc.req('PUT', '/api/admin/limits', {'trashDays': 5})
check('non-admin cannot change limits', s == 403)
for bad in ({'trashDays': -1}, {'maxVersions': -1}, {'sessionDays': 366}, {'trashDays': 2.5}, {'maxVersions': 'many'},
            {'deviceDays': -1}, {'deviceDays': 3651}, {'diskReserveMb': -1}, {'diskReserveMb': 1000001}, {'diskReserveMb': 0.5}):
    s, _ = admin.req('PUT', '/api/admin/limits', bad)
    check(f'limit rejected: {bad}', s == 400, s)
s, lim = admin.req('PUT', '/api/admin/limits', {'trashDays': 45, 'maxVersions': 2, 'sessionDays': 3})
check('limits saved (the ones left out keep their value)', s == 200 and lim == {**lim0, 'trashDays': 45, 'maxVersions': 2, 'sessionDays': 3}, lim)
s, lim = admin.req('PUT', '/api/admin/limits', {'deviceDays': 0, 'diskReserveMb': 12})
s2, lim2 = admin.req('GET', '/api/admin/limits')
check('device days (0 = never) and the free-space reserve are saved and listed', s == 200 and s2 == 200 and lim == lim2
      and lim2.get('deviceDays') == 0 and lim2.get('diskReserveMb') == 12 and lim2.get('trashDays') == 45, (lim, lim2))
# The reserve counts for every upload: with a terabyte to keep free there is no room (unless this disk really has more).
admin.req('PUT', '/api/admin/limits', {'diskReserveMb': 1000000})
s, r = admin.req('POST', '/api/uploads', {'parentId': root, 'name': f'no-room-{uuid.uuid4().hex[:6]}.bin', 'size': 1})
if s == 201:
    admin.req('DELETE', f"/api/uploads/{r['id']}")
    print('  skip the free-space check (more than 1,000,000 MB free here)')
else:
    check('an upload that does not fit above the reserve is 507 "Not enough space on the server"', s == 507 and r.get('error') == 'Not enough space on the server', (s, r))
    s, r = admin.req('POST', f'/api/nodes/{root}/files', {'name': f'no-room-{uuid.uuid4().hex[:6]}.txt', 'content': 'x'})
    check('...and so is a new text file', s == 507 and r.get('error') == 'Not enough space on the server', (s, r))
admin.req('PUT', '/api/admin/limits', {'diskReserveMb': lim0['diskReserveMb']})
s, me2 = admin.req('GET', '/api/me')
check('trash days shown to users at once', me2.get('trashDays') == 45, me2.get('trashDays'))
s, _, hd = Client().req('POST', '/api/login', {'user': bob, 'password': 'bob-pass-123'}, raw=True)
check('new sign-in uses the new length', 'Max-Age=259200' in (hd.get('Set-Cookie') or ''), hd.get('Set-Cookie'))
s, lnote = admin.req('POST', f'/api/nodes/{root}/files', {'name': f'limits-{uuid.uuid4().hex[:6]}.txt', 'content': 'v0'})
for i in range(1, 5):
    admin.req('PUT', f"/api/nodes/{lnote['id']}/content", f'v{i}'.encode())
s, vers = admin.req('GET', f"/api/nodes/{lnote['id']}/versions")
check('versions kept follow the new limit', s == 200 and len(vers) == 2, len(vers) if isinstance(vers, list) else vers)
admin.req('DELETE', f"/api/nodes/{lnote['id']}")
s, lim = admin.req('PUT', '/api/admin/limits', lim0)
check('limits restored', s == 200 and lim == lim0, lim)

print('== folders & chunked upload')
top = 'test-' + uuid.uuid4().hex[:6]
s, folder = admin.req('POST', f'/api/nodes/{root}/folders', {'name': top})
check('create folder', s == 201, folder)
fid = folder['id']
s, _ = admin.req('POST', f'/api/nodes/{root}/folders', {'name': top})
check('duplicate folder is 409', s == 409)
payload = os.urandom(9 * 1024 * 1024 + 123)
s, up = admin.req('POST', '/api/uploads', {'parentId': fid, 'name': 'big.bin', 'size': len(payload)})
check('start upload', s == 201, up)
cs = up['chunkSize']
s, r = admin.req('PUT', f"/api/uploads/{up['id']}", payload[:cs], headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
check('chunk 1', s == 200 and r['received'] == cs and not r['done'], r)
s, r = admin.req('PUT', f"/api/uploads/{up['id']}", payload[:10], headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
check('wrong offset is 409 with received', s == 409 and r['received'] == cs, r)
s, r = admin.req('PUT', f"/api/uploads/{up['id']}", payload[cs:], headers={'Upload-Offset': str(cs), 'Content-Type': 'application/octet-stream'})
check('final chunk completes', s == 200 and r['done'], r)
big = r['node']['id']
fin = r['node']
s, got = admin.req('GET', f'/api/nodes/{big}')
check('final chunk returns the full node (as GET /api/nodes/:id)',
      all(k in fin for k in ('etag', 'mtime', 'isDir', 'parentId', 'mime')) and fin['isDir'] is False
      and fin['parentId'] == fid and {k: v for k, v in fin.items() if k != 'sha256'} == {k: v for k, v in got['node'].items() if k != 'sha256'},
      (fin, got.get('node')))
big_sha = hashlib.sha256(payload).hexdigest()
def sha_of(node_id):
    return admin.req('GET', f'/api/nodes/{node_id}')[1]['node'].get('sha256')
check('final chunk returns sha256 of the content', fin.get('sha256') == big_sha, fin.get('sha256'))
check('sha256 in GET /api/nodes/:id', wait_for(lambda: sha_of(big) == big_sha), sha_of(big))
s, data = admin.req('GET', f'/api/nodes/{fid}')
ch = next(c for c in data['children'] if c['id'] == big)
check('sha256 in folder listing', ch.get('sha256') == big_sha, ch.get('sha256'))
check('folders have no sha256', 'sha256' not in data['node'], data['node'])
check('etag unchanged once the hash is known', got['node']['etag'] == fin['etag'])
s, cpy = admin.req('POST', f'/api/nodes/{big}/copy', {'parentId': fid, 'name': 'big-copy.bin'})
check('copy keeps sha256', s == 201 and wait_for(lambda: sha_of(cpy['id']) == big_sha), cpy)
admin.req('DELETE', f"/api/nodes/{cpy['id']}")
s, body, hd = admin.req('GET', f'/api/nodes/{big}/download', raw=True)
check('download matches upload', s == 200 and body == payload, len(body))
s, body, hd = admin.req('GET', f'/api/nodes/{big}/download', headers={'Range': 'bytes=100-199'}, raw=True)
check('range request', s == 206 and body == payload[100:200] and hd['Content-Range'].startswith('bytes 100-199/'))
s, data = admin.req('GET', f'/api/nodes/{root}')
entry = next(c for c in data['children'] if c['id'] == fid)
check('folder size propagated', entry['size'] == len(payload), entry['size'])

print('== text files, versions, rename, move, copy')
s, note = admin.req('POST', f'/api/nodes/{fid}/files', {'name': 'note.md', 'content': 'v1'})
check('create text file', s == 201)
s, _ = admin.req('PUT', f"/api/nodes/{note['id']}/content", b'version two')
check('save new content', s == 200)
check('text file sha256', wait_for(lambda: sha_of(note['id']) == hashlib.sha256(b'version two').hexdigest()), sha_of(note['id']))
check('overwrite changes sha256', note.get('sha256') == hashlib.sha256(b'v1').hexdigest() and sha_of(note['id']) != note['sha256'], note)
s, vers = admin.req('GET', f"/api/nodes/{note['id']}/versions")
check('previous version kept', s == 200 and len(vers) == 1 and vers[0]['size'] == 2, vers)
s, _ = admin.req('POST', f"/api/nodes/{note['id']}/versions/{vers[0]['id']}/restore")
s, body, _h = admin.req('GET', f"/api/nodes/{note['id']}/download", raw=True)
check('restore version', body == b'v1', body)
check('restored version brings its sha256 back', sha_of(note['id']) == hashlib.sha256(b'v1').hexdigest(), sha_of(note['id']))
s, sub = admin.req('POST', f'/api/nodes/{fid}/folders', {'name': 'sub'})
s, r = admin.req('PATCH', f"/api/nodes/{note['id']}", {'name': 'renamed.md', 'parentId': sub['id']})
check('rename + move', s == 200 and r['name'] == 'renamed.md' and r['parentId'] == sub['id'], r)
s, r = admin.req('PATCH', f"/api/nodes/{fid}", {'parentId': sub['id']})
check('cannot move folder into its child', s == 400)
s, cp = admin.req('POST', f"/api/nodes/{sub['id']}/copy", {'parentId': fid})
check('copy folder gets unique name', s == 201 and cp['name'] == 'sub (2)', cp)
s, res = admin.req('GET', '/api/search?q=renamed')
check('search finds file', s == 200 and any(x['name'] == 'renamed.md' for x in res))
admin.req('POST', f"/api/nodes/{note['id']}/favorite")
s, favs = admin.req('GET', '/api/favorites')
check('favorites', any(x['id'] == note['id'] for x in favs))

print('== zip download')
s, body, hd = admin.req('GET', f'/api/nodes/{fid}/download', raw=True)
z = zipfile.ZipFile(io.BytesIO(body))
check('zip valid', z.testzip() is None and 'big.bin' in z.namelist() and 'sub/renamed.md' in z.namelist(), z.namelist())
check('zip content correct', z.read('big.bin') == payload)
# Several selected items as one ZIP: posted ids → short-lived download address.
s, other = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'other-' + uuid.uuid4().hex[:6]})
s, twin = admin.req('POST', f"/api/nodes/{other['id']}/files", {'name': 'big.bin', 'content': 'same name'})
s, r = admin.req('POST', '/api/zip', {'ids': [big, sub['id']]})
check('multi-item zip: download address', s == 201 and r.get('url', '').startswith('/api/zip/'), r)
s, body, hd = admin.req('GET', r['url'], raw=True)
z = zipfile.ZipFile(io.BytesIO(body))
check('multi-item zip: the chosen items, folders with their contents', s == 200 and z.testzip() is None
      and sorted(z.namelist()) == ['big.bin', 'sub/', 'sub/renamed.md'] and z.read('big.bin') == payload, z.namelist())
check('multi-item zip named after their folder', f'filename="{top}.zip"' in hd.get('Content-Disposition', ''), hd.get('Content-Disposition'))
s, body, hd = admin.req('GET', r['url'], raw=True)
check('multi-item zip address works more than once (download retries)', s == 200 and len(body) > len(payload))
s, r2 = admin.req('POST', '/api/zip', {'ids': [big, twin['id']]})
s, body, hd = admin.req('GET', r2['url'], raw=True)
z = zipfile.ZipFile(io.BytesIO(body))
check('multi-item zip: same names from two folders both kept', sorted(z.namelist()) == ['big (2).bin', 'big.bin'] and z.read('big (2).bin') == b'same name', z.namelist())
check('multi-item zip from several folders named "files.zip"', 'filename="files.zip"' in hd.get('Content-Disposition', ''), hd.get('Content-Disposition'))
s, _ = bobc.req('GET', r['url'])
check("another user cannot fetch someone's zip address", s == 404)
s, _ = bobc.req('POST', '/api/zip', {'ids': [big]})
check("another user cannot zip someone's files", s == 404)
s, _ = admin.req('POST', '/api/zip', {'ids': []})
check('empty zip request is 400', s == 400)
s, _ = admin.req('GET', '/api/zip/not-a-real-key')
check('unknown zip address is 404', s == 404)
s, _ = Client().req('GET', r['url'])
check('zip address needs a sign-in', s == 401)
admin.req('DELETE', f"/api/nodes/{other['id']}")

print('== trash')
s, _ = admin.req('DELETE', f"/api/nodes/{sub['id']}")
check('delete to trash', s == 204)
s, trash = admin.req('GET', '/api/trash')
check('trash lists item', any(t['id'] == sub['id'] for t in trash))
s, _ = admin.req('GET', f"/api/nodes/{note['id']}")
check('child of trashed folder hidden', s == 404)
s, r = admin.req('POST', f"/api/trash/{sub['id']}/restore")
check('restore from trash', s == 200 and r['parentId'] == fid, r)
s, _ = admin.req('GET', f"/api/nodes/{note['id']}")
check('child visible after restore', s == 200)
s, tmp = admin.req('POST', f'/api/nodes/{fid}/files', {'name': 'gone.txt', 'content': 'bye'})
admin.req('DELETE', f"/api/nodes/{tmp['id']}")
s, _ = admin.req('DELETE', f"/api/trash/{tmp['id']}")
check('purge from trash', s == 204 and admin.req('GET', f"/api/nodes/{tmp['id']}")[0] == 404)

print('== user & group sharing')
s, sh = admin.req('POST', f'/api/nodes/{fid}/shares', {'type': 'user', 'shareWith': bob, 'canEdit': False})
check('share with user', s == 201, sh)
s, inc = bobc.req('GET', '/api/shares/incoming')
check('recipient sees share', s == 200 and any(x['id'] == fid for x in inc))
s, data = bobc.req('GET', f'/api/nodes/{fid}')
check('recipient can browse (read)', s == 200 and data['perm'] == 'read' and data['breadcrumb'][0]['id'] == fid)
s, _ = bobc.req('POST', f'/api/nodes/{fid}/folders', {'name': 'nope'})
check('read-only share blocks writes', s == 403)
s, _ = bobc.req('GET', f'/api/nodes/{root}')
check('recipient cannot see owner root', s == 404)
admin.req('PATCH', f"/api/shares/{sh['id']}", {'canEdit': True})
s, _ = bobc.req('POST', f'/api/nodes/{fid}/folders', {'name': 'from-bob'})
check('edit share allows writes', s == 201, _)
s, _ = bobc.req('DELETE', f'/api/nodes/{fid}')
check('recipient cannot delete share root', s in (403, 404))
admin.req('DELETE', f"/api/shares/{sh['id']}")
s, _ = admin.req('POST', f'/api/nodes/{fid}/shares', {'type': 'group', 'shareWith': 'staff'})
s, data = bobc.req('GET', f'/api/nodes/{fid}')
check('group share grants access', s == 200)

print('== public links')
s, link = admin.req('POST', f'/api/nodes/{fid}/shares', {'type': 'link', 'password': 'linkpw'})
check('create link', s == 201 and link['token'])
anon = Client()
tok = link['token']
s, info = anon.req('GET', f'/api/public/{tok}')
check('link asks for password', info.get('needsPassword') is True)
s, _ = anon.req('GET', f'/api/public/{tok}/nodes/{fid}')
check('listing blocked without password', s == 401)
s, _ = anon.req('POST', f'/api/public/{tok}/auth', {'password': 'bad'})
check('wrong link password', s == 403)
s, _ = anon.req('POST', f'/api/public/{tok}/auth', {'password': 'linkpw'})
s, data = anon.req('GET', f'/api/public/{tok}/nodes/{fid}')
check('listing after password', s == 200 and any(c['name'] == 'big.bin' for c in data['children']))
s, body, _h = anon.req('GET', f'/api/public/{tok}/nodes/{big}/download', raw=True)
check('public download', s == 200 and body == payload)
s, _ = anon.req('GET', f'/api/public/{tok}/nodes/{root}')
check('link cannot escape shared folder', s == 404)
s, up = anon.req('POST', f'/api/public/{tok}/uploads', {'parentId': fid, 'name': 'x.txt', 'size': 1})
check('upload blocked on read-only link', s == 403)
admin.req('PATCH', f"/api/shares/{link['id']}", {'canEdit': True})
s, up = anon.req('POST', f'/api/public/{tok}/uploads', {'parentId': fid, 'name': 'dropped.txt', 'size': 5})
s, r = anon.req('PUT', f"/api/uploads/{up['id']}", b'hello', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
check('upload into editable link', s == 200 and r['done'], r)
check('link upload answer stays minimal (no owner)', 'owner' not in r['node'] and r['node']['size'] == 5, r)
s, page, _h = anon.req('GET', f'/s/{tok}', raw=True)
check('public page served', s == 200 and b'public.js' in page)
s, page, _h = anon.req('GET', f"/s/{tok}/{sub['id']}", raw=True)
check('public page served for a folder address (/s/<token>/<id>)', s == 200 and b'public.js' in page)
admin.req('PATCH', f"/api/shares/{link['id']}", {'expiresAt': '2000-01-01T00:00:00Z'})
s, _ = anon.req('GET', f'/api/public/{tok}')
check('expired link is 404', s == 404)

print('== WebDAV and app passwords removed (2.1)')
s, _ = admin.req('POST', '/api/me/app-passwords', {'name': 'test', 'password': ADMIN_PW})
check('POST /api/me/app-passwords is gone (404/405)', s in (404, 405), s)
for method in ('PROPFIND', 'OPTIONS'):
    s, _, hd = Client(basic=f'{ADMIN}:{ADMIN_PW}').req(method, f'/dav/files/{ADMIN}/', headers={'Depth': '0'}, raw=True)
    check(f'{method} /dav/files/<user>/ with Basic credentials: no 207, no DAV header', s != 207 and not hd.get('DAV'), (s, hd.get('DAV')))
s, _ = Client(basic=f'{ADMIN}:{ADMIN_PW}').req('GET', '/api/me')
check('HTTP Basic credentials no longer sign in to the API', s == 401, s)

print('== calendars and contacts removed (2.0)')
s, _ = admin.req('GET', '/api/calendars')
check('GET /api/calendars is 404', s == 404, s)
s, _ = admin.req('GET', '/api/addressbooks')
check('GET /api/addressbooks is 404', s == 404, s)

print('== mobile token auth')
mob = Client()
s, r = mob.req('POST', '/api/auth/token', {'user': ADMIN, 'password': ADMIN_PW, 'deviceName': 'Test phone'})
check('token issued', s == 201 and r.get('token') and r['user']['rootId'], r)
tok_h = {'Authorization': 'Bearer ' + r['token']}
s, me2 = mob.req('GET', '/api/me', headers=tok_h)
check('bearer token authenticates API', s == 200 and me2['id'] == ADMIN)
s, aps = admin.req('GET', '/api/me/app-passwords')
check('token listed as app password', any(a['name'] == 'App: Test phone' for a in aps))
check('...with when it was last used', all(a.get('lastUsedAt') for a in aps if a['name'] == 'App: Test phone'), aps)
check('web session marks no token as current', not any(a.get('current') for a in aps))
s, aps_m = mob.req('GET', '/api/me/app-passwords', headers=tok_h)
check('the phone sees its own token as current', [a['name'] for a in aps_m if a.get('current')] == ['App: Test phone'], aps_m)
s, _ = Client(basic=f"{ADMIN}:{r['token']}").req('GET', '/api/me')
check('a device token is no Basic password', s == 401, s)
s, r2 = Client().req('POST', '/api/auth/token', {'user': ADMIN, 'password': ADMIN_PW, 'deviceName': 'Test tablet'})
tab_h = {'Authorization': 'Bearer ' + r2['token']}
tab = next((a for a in admin.req('GET', '/api/me/app-passwords')[1] if a['name'] == 'App: Test tablet'), None)
check('second device listed', s == 201 and tab is not None, r2)
s, _ = admin.req('DELETE', f"/api/me/app-passwords/{tab['id'] if tab else 0}")
check('signing a device out from the list', s == 204, s)
s, _ = Client().req('GET', '/api/me', headers=tab_h)
check('the signed-out device gets 401', s == 401, s)
check('and is gone from the list', not any(a['name'] == 'App: Test tablet' for a in admin.req('GET', '/api/me/app-passwords')[1]))
s, _ = mob.req('GET', '/api/me', headers=tok_h)
check('the other device stays signed in', s == 200, s)
s, _ = mob.req('POST', '/api/auth/revoke', headers=tok_h)
s, _ = mob.req('GET', '/api/me', headers=tok_h)
check('revoked token rejected', s == 401)
s, _ = mob.req('POST', '/api/auth/token', {'user': ADMIN, 'password': 'nope'})
check('token needs valid password', s == 401)

print('== server version')
s, st = Client().req('GET', '/status')
check('status reports version', s == 200 and st.get('version'), st)
s, _ = admin.req('GET', '/api/admin/app/android')
check('server-side APK publishing removed', s == 404)

s, _ = admin.req('GET', '/api/diagnostics')
check('connection diagnostics endpoint removed', s == 404)

print('== email (SMTP)')
mails = []
class FakeSMTP(socketserver.StreamRequestHandler):
    # Just enough SMTP for nodemailer without TLS/auth; stores each message.
    def handle(self):
        w = lambda line: self.wfile.write((line + '\r\n').encode())
        w('220 fake ESMTP')
        rcpt = []
        while True:
            raw = self.rfile.readline()
            if not raw: return
            cmd = raw.decode(errors='replace').strip(); up = cmd.upper()
            if up.startswith('EHLO'): w('250-fake'); w('250 8BITMIME')
            elif up.startswith('MAIL FROM'): rcpt = []; w('250 OK')
            elif up.startswith('RCPT TO'): rcpt.append(cmd.split(':', 1)[1].strip(' <>')); w('250 OK')
            elif up == 'DATA':
                w('354 go'); data = []
                while True:
                    l = self.rfile.readline()
                    if not l or l in (b'.\r\n', b'.\n'): break
                    data.append(l[1:] if l.startswith(b'..') else l)
                msg = email.message_from_bytes(b''.join(data))
                body = next((p.get_payload(decode=True).decode() for p in msg.walk() if p.get_content_type() == 'text/plain'), '')
                mails.append({'to': rcpt, 'subject': str(email.header.make_header(email.header.decode_header(msg['Subject']))), 'body': body})
                w('250 queued')
            elif up == 'QUIT': w('221 bye'); return
            else: w('250 OK')

s, _ = admin.req('PUT', '/api/admin/mail', {'host': 'smtp.invalid', 'port': 2525, 'security': 'none', 'fromEmail': 'no-mail', 'adminPassword': ADMIN_PW})
check('invalid sender address rejected', s == 400)
s, _ = Client().req('GET', '/api/admin/mail')
check('mail settings need admin', s == 401)
smtp_host = os.environ.get('CLOUDY_TEST_SMTP_HOST')
s, _ = admin.req('PUT', '/api/admin/mail', {'host': smtp_host or 'smtp.invalid', 'port': 2525, 'security': 'none', 'adminPassword': ADMIN_PW,
                                            'user': '', 'password': 'smtp-secret', 'fromName': 'Cloudy CI', 'fromEmail': 'cloudy@example.com'})
check('save mail settings', s == 204)
s, conf = admin.req('GET', '/api/admin/mail')
check('mail password never returned', s == 200 and 'password' not in conf and conf['hasPassword'] is True and conf['port'] == 2525, conf)
s, opts = Client().req('GET', '/api/auth/options')
check('login page offers password reset', s == 200 and opts['passwordReset'] is True)
s, _ = Client().req('POST', '/api/auth/forgot', {'login': 'nobody-' + uuid.uuid4().hex})
check('forgot password does not reveal accounts', s == 204)
s, r = Client().req('POST', '/api/auth/reset', {'token': 'bogus', 'password': 'whatever-123'})
check('bad reset token rejected', s == 400)

if not smtp_host:
    print('  skip delivery tests (set CLOUDY_TEST_SMTP_HOST to the address the server uses to reach this machine)')
else:
    srv = socketserver.ThreadingTCPServer(('0.0.0.0', 2525), FakeSMTP); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    got = lambda pred: wait_for(lambda: any(pred(m) for m in mails), 15)
    s, r = admin.req('POST', '/api/admin/mail/test', {'to': 'admin@example.com'})
    check('test email delivered', s == 200 and got(lambda m: m['to'] == ['admin@example.com'] and 'test' in m['subject'].lower()), (s, r, mails))
    dave = 'dave' + uuid.uuid4().hex[:6]
    admin.req('POST', '/api/admin/users', {'id': dave, 'password': 'dave-pass-123', 'email': f'{dave}@example.com', 'displayName': 'Dave'})
    s, f2 = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'mail-' + uuid.uuid4().hex[:6]})
    admin.req('POST', f"/api/nodes/{f2['id']}/shares", {'type': 'user', 'shareWith': dave})
    check('share notification emailed', got(lambda m: m['to'] == [f'{dave}@example.com'] and f2['name'] in m['subject']), mails)
    davec = Client(); davec.req('POST', '/api/login', {'user': dave, 'password': 'dave-pass-123'})
    davec.req('PATCH', '/api/me', {'notifyShares': False})
    s, me_d = davec.req('GET', '/api/me')
    check('notification preference saved', me_d.get('notifyShares') is False)
    s, f3 = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'quiet-' + uuid.uuid4().hex[:6]})
    admin.req('POST', f"/api/nodes/{f3['id']}/shares", {'type': 'user', 'shareWith': dave})
    s, _ = Client().req('POST', '/api/auth/forgot', {'login': f'{dave.upper()}@EXAMPLE.COM'})
    check('reset link emailed (lookup by email)', s == 204 and got(lambda m: m['to'] == [f'{dave}@example.com'] and '/reset#' in m['body']), mails)
    check('opted-out user gets no share email', not any(f3['name'] in m['subject'] for m in mails))
    token = re.search(r'/reset#([\w-]+)', [m for m in mails if '/reset#' in m['body']][-1]['body']).group(1)
    s, _ = Client().req('POST', '/api/auth/reset', {'token': token, 'password': 'short'})
    check('reset enforces password rules', s == 400)
    s, _ = Client().req('POST', '/api/auth/reset', {'token': token, 'password': 'dave-new-pass-1'})
    check('reset with emailed link', s == 204)
    s, _ = Client().req('POST', '/api/auth/reset', {'token': token, 'password': 'dave-new-pass-2'})
    check('reset link works only once', s == 400)
    s, _ = davec.req('GET', '/api/me')
    check('reset signs out existing sessions', s == 401)
    s, _ = Client().req('POST', '/api/login', {'user': dave, 'password': 'dave-new-pass-1'})
    check('login with new password', s == 200)
    check('password-changed notice emailed', got(lambda m: m['to'] == [f'{dave}@example.com'] and 'password was changed' in m['subject']), mails)
    # invitations: emailed at once, so the administrator learns about a failure
    ina = f'ina-{uuid.uuid4().hex[:6]}@example.com'
    s, iv = admin.req('POST', '/api/admin/invitations', {'email': ina, 'displayName': 'Ina', 'send': True})
    check('invitation emailed', s == 201 and iv.get('emailed') is True and 'emailError' not in iv, (s, iv))
    check('invitation email: who invited, the name, the link', got(lambda m: m['to'] == [ina] and 'invited you to Cloudy' in m['subject']
          and m['body'].startswith('Hi Ina,') and iv.get('url', '-') in m['body']), [m for m in mails if m['to'] == [ina]])
    s, c = Client().req('POST', '/api/invitations/check', {'token': iv['url'].split('#', 1)[1]})
    check('the emailed link works', s == 200 and c.get('email') == ina, (s, c))
    check('the list says when it was emailed', any(i['id'] == iv['id'] and i['emailedAt'] for i in admin.req('GET', '/api/admin/invitations')[1]))
    s, iv2 = admin.req('POST', f"/api/admin/invitations/{iv['id']}/resend", {'send': True})
    check('resent by email with the new link', s == 200 and iv2.get('emailed') is True
          and got(lambda m: m['to'] == [ina] and iv2.get('url', '-') in m['body']), (s, iv2))
    srv.shutdown(); srv.server_close()
    s, iv3 = admin.req('POST', f"/api/admin/invitations/{iv['id']}/resend", {'send': True})
    listed = [i for i in admin.req('GET', '/api/admin/invitations')[1] if i['id'] == iv['id']]
    check('a failed invitation email is reported; the invitation stays', s == 200 and iv3.get('emailed') is False
          and iv3.get('emailError', '').startswith('Sending failed: ') and listed and listed[0]['emailedAt'] is None, (s, iv3, listed))
    admin.req('DELETE', f"/api/admin/invitations/{iv['id']}")
    admin.req('DELETE', f"/api/nodes/{f2['id']}"); admin.req('DELETE', f"/api/nodes/{f3['id']}")
    admin.req('DELETE', f'/api/admin/users/{dave}', {'adminPassword': ADMIN_PW})
s, _ = admin.req('PUT', '/api/admin/mail', {'host': '', 'adminPassword': ADMIN_PW})
s, opts = Client().req('GET', '/api/auth/options')
check('turning email off hides password reset', opts['passwordReset'] is False)
s, iv = admin.req('POST', '/api/admin/invitations', {'email': f'nomail-{uuid.uuid4().hex[:6]}@example.com', 'send': True})
check('without email set up, an invitation is a link to pass on', s == 201 and iv.get('emailed') is False and 'emailError' not in iv and '/invite#' in iv.get('url', ''), (s, iv))
admin.req('DELETE', f"/api/admin/invitations/{iv.get('id')}")

# (before the 2FA section: its deliberate failures use up the per-address login limit)
print('== review 2026-11-04 (races, account safety)')
import threading
def par(*fns):
    out = [None] * len(fns)
    ts = [threading.Thread(target=lambda i=i, f=f: out.__setitem__(i, f())) for i, f in enumerate(fns)]
    [t.start() for t in ts]; [t.join() for t in ts]
    return out
s, rv = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'review-' + uuid.uuid4().hex[:6]})
rvid = rv['id']
sizes_ok = True
for i in range(4):
    s, d = admin.req('POST', f'/api/nodes/{rvid}/folders', {'name': f'd{i}'})
    s, f = admin.req('POST', f"/api/nodes/{d['id']}/files", {'name': 'f.txt', 'content': 'x' * 1000})
    par(lambda: admin.req('DELETE', f"/api/nodes/{f['id']}")[0], lambda: admin.req('DELETE', f"/api/nodes/{f['id']}")[0])
    sizes_ok &= admin.req('GET', f"/api/nodes/{d['id']}")[1]['node']['size'] == 0
    par(lambda: admin.req('POST', f"/api/trash/{f['id']}/restore")[0], lambda: admin.req('POST', f"/api/trash/{f['id']}/restore")[0])
    s, dd = admin.req('GET', f"/api/nodes/{d['id']}")
    sizes_ok &= dd['node']['size'] == 1000 and [c['name'] for c in dd['children']] == ['f.txt']
check('parallel delete / restore of one file keeps folder sizes right', sizes_ok)
s, a = admin.req('POST', f'/api/nodes/{rvid}/folders', {'name': 'a'})
s, b = admin.req('POST', f'/api/nodes/{rvid}/folders', {'name': 'b'})
res = par(lambda: admin.req('PATCH', f"/api/nodes/{a['id']}", {'parentId': b['id']})[0],
          lambda: admin.req('PATCH', f"/api/nodes/{b['id']}", {'parentId': a['id']})[0])
check('crossed folder moves: one wins, no cycle', sorted(res) == [200, 400], res)
s, body, hd = admin.req('HEAD', f'/api/nodes/{rvid}/download', raw=True)
check('HEAD on a folder download sends no ZIP', s == 200 and body == b'' and 'zip' in hd.get('Content-Type', ''))
s, _ = admin.req('POST', f'/api/nodes/{rvid}/folders', {'name': 'bad\x01name'})
check('control characters in names rejected', s == 400)
s, up = admin.req('POST', '/api/uploads', {'parentId': rvid, 'name': 'cancelled.bin', 'size': 10})
admin.req('DELETE', f"/api/uploads/{up['id']}")
s, _ = admin.req('PUT', f"/api/uploads/{up['id']}", b'0123456789', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
check('chunk for a cancelled upload is 404', s == 404 and not any(c['name'] == 'cancelled.bin' for c in admin.req('GET', f'/api/nodes/{rvid}')[1]['children']))
# an upload belongs to the signed-in user who started it: its id alone is not enough (it used to be)
s, up = admin.req('POST', '/api/uploads', {'parentId': rvid, 'name': 'owned.bin', 'size': 4})
octet = {'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'}
s, _ = Client().req('PUT', f"/api/uploads/{up['id']}", b'abcd', headers=octet)
check('upload chunk without the sign-in is refused', s == 401, s)
check('upload status and cancel without the sign-in are refused',
      Client().req('GET', f"/api/uploads/{up['id']}")[0] == 401 and Client().req('DELETE', f"/api/uploads/{up['id']}")[0] == 401)
s, r = admin.req('PUT', f"/api/uploads/{up['id']}", b'abcd', headers=octet)
check('the user who started the upload finishes it', s == 200 and r.get('done'), r)
# public upload link: the owner's file made while a visitor uploads is never replaced
s, ln = admin.req('POST', f'/api/nodes/{rvid}/shares', {'type': 'link', 'canEdit': True, 'expiresAt': '2999-01-01T00:00:00Z'})
s, up = Client().req('POST', f"/api/public/{ln['token']}/uploads", {'parentId': rvid, 'name': 'race.txt', 'size': 7})
admin.req('POST', f'/api/nodes/{rvid}/files', {'name': 'race.txt', 'content': 'owner'})
s, r = Client().req('PUT', f"/api/uploads/{up['id']}", b'visitor', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
names = {c['name']: c['size'] for c in admin.req('GET', f'/api/nodes/{rvid}')[1]['children']}
check('link upload never overwrites a file the owner made meanwhile', r.get('done') and names.get('race.txt') == 5 and names.get('race (2).txt') == 7, names)
s, _ = admin.req('POST', f'/api/nodes/{rvid}/files', {'name': 'trailing ', 'content': 'x'})
check('a name ending in a space is 400', s == 400, s)
# email change needs the password; the same email does not
s, me0 = admin.req('GET', '/api/me')
s, _ = admin.req('PATCH', '/api/me', {'email': me0['email'], 'displayName': me0['displayName']})
check('profile save with unchanged email needs no password', s == 204)
s, _ = admin.req('PATCH', '/api/me', {'email': 'changed@example.com'})
check('email change without password is 403', s == 403 and admin.req('GET', '/api/me')[1]['email'] == me0['email'])
s, _ = admin.req('PATCH', '/api/me', {'email': 'changed@example.com', 'password': ADMIN_PW})
s2, me1 = admin.req('GET', '/api/me')
check('email change with password', s == 204 and me1['email'] == 'changed@example.com')
admin.req('PATCH', '/api/me', {'email': me0['email'], 'password': ADMIN_PW})
# a deleted user's shares are not inherited by a new account with the same name
ghost = 'ghost' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/users', {'id': ghost, 'password': 'ghost-pass-123'})
admin.req('POST', f'/api/nodes/{rvid}/shares', {'type': 'user', 'shareWith': ghost, 'expiresAt': '2000-01-01T00:00:00Z'})
s, shs = admin.req('GET', f'/api/nodes/{rvid}/shares')
check('user shares carry no expiry', all(x['expiresAt'] is None for x in shs if x['type'] == 'user'), shs)
admin.req('DELETE', f'/api/admin/users/{ghost}', {'adminPassword': ADMIN_PW})
admin.req('POST', '/api/admin/users', {'id': ghost, 'password': 'ghost-pass-123'})
gc = Client(); gc.req('POST', '/api/login', {'user': ghost, 'password': 'ghost-pass-123'})
s, inc = gc.req('GET', '/api/shares/incoming')
check("recreated account doesn't inherit old shares", s == 200 and inc == [], inc)
s, gt = Client().req('POST', '/api/auth/token', {'user': ghost, 'password': 'ghost-pass-123', 'deviceName': 'e2e'})
admin.req('PATCH', f'/api/admin/users/{ghost}', {'password': 'ghost-pass-456', 'adminPassword': ADMIN_PW})
s, _ = Client().req('GET', '/api/me', headers={'Authorization': 'Bearer ' + gt['token']})
check('admin password reset signs devices out', s == 401)
s, _ = admin.req('PATCH', f'/api/admin/users/{ghost}', {'quotaBytes': 'lots'})
check('invalid quota is 400', s == 400)
admin.req('DELETE', f'/api/admin/users/{ghost}', {'adminPassword': ADMIN_PW})
admin.req('DELETE', f'/api/nodes/{rvid}')

print('== two-factor authentication')
import hmac, struct, time
def totp(secret_b32, step_offset=0):
    key = base64.b32decode(secret_b32 + '=' * (-len(secret_b32) % 8))
    step = int(time.time()) // 30 + step_offset
    h = hmac.new(key, struct.pack('>Q', step), 'sha1').digest()
    o = h[-1] & 15
    return '%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 1000000)
carol = 'carol' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/users', {'id': carol, 'password': 'carol-pass-123'})
cc = Client()
cc.req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123'})
s, _ = cc.req('POST', '/api/me/2fa/setup', {'password': 'wrong-pass-1'})
check('2FA setup needs the password', s == 403)
s, setup = cc.req('POST', '/api/me/2fa/setup', {'password': 'carol-pass-123'})
check('2FA setup returns secret + QR', s == 200 and setup['secret'] and '<svg' in setup['qrSvg'] and setup['uri'].startswith('otpauth://totp/'), setup)
s, _ = cc.req('POST', '/api/me/2fa/enable', {'code': '000000' if totp(setup['secret']) != '000000' else '111111'})
check('2FA enable rejects wrong code', s == 400)
s, en = cc.req('POST', '/api/me/2fa/enable', {'code': totp(setup['secret'])})
check('2FA enable returns 10 recovery codes', s == 200 and len(en['recoveryCodes']) == 10, en)
s, me = cc.req('GET', '/api/me')
check('me reports twoFactor', me.get('twoFactor') is True)
s, r = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123'})
check('login without code asks for 2FA', s == 401 and r.get('twoFactor') is True, r)
s, r = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123', 'code': '12345x'})
check('login with bad code rejected', s == 401 and r.get('twoFactor') is True)
s, r = Client().req('POST', '/api/login', {'user': carol, 'password': 'wrong', 'code': totp(setup['secret'])})
check('code does not bypass wrong password', s == 401 and not r.get('twoFactor'))
# The enable step consumed the current code; the next step's code is valid (±1 step drift window).
good = totp(setup['secret'], 1)
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123', 'code': good})
check('login with authenticator code', s == 200)
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123', 'code': good})
check('same code cannot be replayed', s == 401)
rc = en['recoveryCodes'][0]
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123', 'code': rc.upper()})
check('login with recovery code', s == 200)
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123', 'code': rc})
check('recovery code works only once', s == 401)
s, r = Client().req('POST', '/api/auth/token', {'user': carol, 'password': 'carol-pass-123', 'deviceName': 'phone'})
check('device token also needs 2FA', s == 401 and r.get('twoFactor') is True)
s, r = Client().req('POST', '/api/auth/token', {'user': carol, 'password': 'carol-pass-123', 'deviceName': 'phone', 'code': en['recoveryCodes'][1]})
check('device token with second factor', s == 201 and r.get('token'))
s, _ = Client().req('GET', '/api/me', headers={'Authorization': 'Bearer ' + r['token']})
check('that device token works', s == 200, s)
s, _ = cc.req('POST', '/api/me/2fa/disable', {'password': 'wrong'})
check('disabling 2FA needs the password', s == 403)
s, _ = admin.req('PATCH', f'/api/admin/users/{carol}', {'resetTwoFactor': True, 'adminPassword': ADMIN_PW})
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123'})
check('admin reset turns 2FA off', s == 200)
s, setup2 = cc.req('POST', '/api/me/2fa/setup', {'password': 'carol-pass-123'})
cc.req('POST', '/api/me/2fa/enable', {'code': totp(setup2['secret'])})
s, _ = cc.req('POST', '/api/me/2fa/disable', {'password': 'carol-pass-123'})
s, _ = Client().req('POST', '/api/login', {'user': carol, 'password': 'carol-pass-123'})
check('user can turn 2FA off', s == 200)

print('== passkeys (API only; the WebAuthn ceremony needs a real authenticator)')
s, o = Client().req('POST', '/api/passkeys/login/options')
check('passkey login options', s == 200 and o.get('challenge') and o.get('userVerification') == 'required', o)
s, _ = cc.req('POST', '/api/me/passkeys/options', {'password': 'wrong'})
check('adding a passkey needs the password', s == 403)
s, o = cc.req('POST', '/api/me/passkeys/options', {'password': 'carol-pass-123'})
check('passkey registration options', s == 200 and o['user']['name'] == carol and o['authenticatorSelection']['residentKey'] == 'required'
      and {p['alg'] for p in o['pubKeyCredParams']} == {-7, -8, -257}, o)
s, _ = cc.req('POST', '/api/me/passkeys', {'clientDataJSON': 'e30', 'attestationObject': 'oA'})
check('invalid passkey registration rejected', s == 400)
s, keys = cc.req('GET', '/api/me/passkeys')
check('passkey list empty', s == 200 and keys == [])
s, _ = Client().req('POST', '/api/passkeys/login', {})
check('passkey login needs a credential', s == 400)
s, _ = Client().req('POST', '/api/passkeys/login', {'id': 'AAAA', 'clientDataJSON': 'e30', 'authenticatorData': 'AA', 'signature': 'AA'})
check('unknown passkey rejected', s == 401)
s, me = cc.req('GET', '/api/me')
check('me reports passkey count', me.get('passkeys') == 0)
admin.req('DELETE', f'/api/admin/users/{carol}', {'adminPassword': ADMIN_PW})

print('== live updates (Server-Sent Events)')
def listen(client, sink):
    def run():
        try:
            r = client.op.open(urllib.request.Request(BASE + '/api/events', headers={'Accept': 'text/event-stream'}), timeout=30)
            sink.append('open')
            for raw in r:
                line = raw.decode().strip()
                if line.startswith('data:'): sink.append(json.loads(line[5:]))
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()

s, live = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'live-' + uuid.uuid4().hex[:6]})
s, private = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'private-' + uuid.uuid4().hex[:6]})
admin.req('POST', f"/api/nodes/{live['id']}/shares", {'type': 'user', 'shareWith': bob, 'canEdit': False})
bob_events, admin_events = [], []
listen(bobc, bob_events)
listen(admin, admin_events)
check('event stream opens', wait_for(lambda: 'open' in bob_events and 'open' in admin_events))
time.sleep(0.5)
admin.req('POST', f"/api/nodes/{live['id']}/files", {'name': 'new.txt', 'content': 'hi'})
admin.req('POST', f"/api/nodes/{private['id']}/files", {'name': 'secret.txt', 'content': 'hi'})
has = lambda evs, fid: any(isinstance(e, dict) and fid in e['folders'] for e in evs)
check('owner gets live update', wait_for(lambda: has(admin_events, live['id']) and has(admin_events, private['id'])))
check('sharee gets live update for shared folder', wait_for(lambda: has(bob_events, live['id'])), bob_events)
check('sharee gets no update for private folder', not has(bob_events, private['id']), bob_events)
s, _ = Client().req('GET', '/api/events')
check('event stream needs login', s == 401)

print('== office previews (LibreOffice → PDF)')
s, office = admin.req('GET', '/api/office')
check('office preview types listed', s == 200 and {'docx', 'xlsx', 'pptx', 'odt'} <= set(office.get('extensions', [])), office)
rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}} \\f0\\fs24 Hello from Cloudy}'
s, doc = admin.req('POST', f"/api/nodes/{live['id']}/files", {'name': 'Letter.rtf', 'content': rtf})
t0 = time.time()
s, body, hd = admin.req('GET', f"/api/nodes/{doc['id']}/preview", raw=True)
first = time.time() - t0
check('office file converts to PDF', s == 200 and body[:5] == b'%PDF-' and hd.get('Content-Type') == 'application/pdf', (s, body[:200]))
t0 = time.time()
s, body2, _ = bobc.req('GET', f"/api/nodes/{doc['id']}/preview", raw=True)
check('read-only sharee sees the preview (cached)', s == 200 and body2 == body and time.time() - t0 < max(1.0, first / 2), (s, first))
s, _, _ = Client().req('GET', f"/api/nodes/{doc['id']}/preview", raw=True)
check('preview needs login', s == 401)
s, txt = admin.req('POST', f"/api/nodes/{live['id']}/files", {'name': 'plain.txt', 'content': 'x'})
s, _, _ = admin.req('GET', f"/api/nodes/{txt['id']}/preview", raw=True)
check('no preview for non-office files', s == 415)
s, empty = admin.req('POST', f"/api/nodes/{live['id']}/files", {'name': 'Empty.docx', 'content': ''})
s, _, _ = admin.req('GET', f"/api/nodes/{empty['id']}/preview", raw=True)
check('empty document gives a clear error', s == 422)
s, _, _ = admin.req('GET', '/hosting/discovery', raw=True)
check('Collabora endpoints gone', s == 404)
admin.req('DELETE', f"/api/nodes/{live['id']}")
admin.req('DELETE', f"/api/nodes/{private['id']}")

print('== 1.18.1 repairs')
import socket, urllib.parse
def raw_request(target):
    """Sends a request line as-is (clients normalise "//"); returns the status line or '' when the connection died."""
    u = urllib.parse.urlsplit(BASE)
    try:
        sk = socket.create_connection((u.hostname, u.port or 80), timeout=5)
        sk.sendall(b'GET ' + target + b' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
        data = sk.recv(200)
        sk.close()
        return data.split(b'\r\n', 1)[0].decode(errors='replace')
    except OSError:
        return ''
for target in (b'//', b'/\\', b'//[', b'//?x=1'):
    check(f'request target {target!r} answered, not a crash', raw_request(target).startswith('HTTP/1.1 4'), raw_request(target))
s, st = Client().req('GET', '/status')
check('server still up after odd request targets', s == 200 and st.get('ok'), st)
s, _ = admin.req('POST', '/api/zip', 'null')
check('JSON body null → 400 (was 500)', s == 400, s)
s, _ = admin.req('GET', '/api/nodes/99999999999999999999999')
check('id longer than a bigint → 404 (was 500)', s == 404, s)
s, a = admin.req('POST', f'/api/nodes/{root}/files', {'name': 'taken.txt', 'content': 'first'})
admin.req('DELETE', f"/api/nodes/{a['id']}")
s, b = admin.req('POST', f'/api/nodes/{root}/files', {'name': 'taken.txt', 'content': 'second'})
s, r = admin.req('POST', f"/api/trash/{a['id']}/restore")
check('restore when the name is taken: under a free name (was 500)', s == 200 and r['name'] == 'taken (2).txt', (s, r))
admin.req('DELETE', f"/api/nodes/{a['id']}"); admin.req('DELETE', f"/api/nodes/{b['id']}")
s, vf = admin.req('POST', f'/api/nodes/{root}/files', {'name': 'versioned.txt', 'content': 'secret first draft'})
admin.req('PUT', f"/api/nodes/{vf['id']}/content", 'shared text', headers={'Content-Type': 'application/octet-stream'})
s, sh = admin.req('POST', f"/api/nodes/{vf['id']}/shares", {'type': 'user', 'shareWith': bob, 'canEdit': False})
s, _ = bobc.req('GET', f"/api/nodes/{vf['id']}/versions")
check('read-only recipient cannot read older versions', s == 403, s)
s, cp = admin.req('POST', f"/api/nodes/{vf['id']}/copy", {'parentId': root})
s, body, _ = admin.req('GET', f"/api/nodes/{cp['id']}/download", raw=True)
check('copy has the same content (hard-linked blob)', body == b'shared text', body)
admin.req('PUT', f"/api/nodes/{cp['id']}/content", 'changed copy', headers={'Content-Type': 'application/octet-stream'})
s, body, _ = admin.req('GET', f"/api/nodes/{vf['id']}/download", raw=True)
check('changing the copy leaves the original alone', body == b'shared text', body)
admin.req('DELETE', f"/api/nodes/{cp['id']}"); admin.req('DELETE', f"/api/nodes/{vf['id']}")
s, _ = admin.req('PATCH', f'/api/admin/users/{bob}', {'quotaBytes': 0})
s, bm = bobc.req('GET', '/api/me')
check('quota 0 means unlimited', bm.get('quotaBytes') is None, bm)
s, _ = admin.req('PATCH', '/api/me', {'email': 'a@' + '.' * 300000 + ' x'})
check('a huge "email" is refused at once', s == 400, s)

print('== 1.19')
import unicodedata, zlib
s, me19 = admin.req('GET', '/api/me')
s, f19 = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'e2e-119-' + uuid.uuid4().hex[:6]})
F19 = f19['id']
# names in one Unicode form
nfd = unicodedata.normalize('NFD', 'Résumé Müller.txt')
s, n1 = admin.req('POST', f'/api/nodes/{F19}/files', {'name': nfd, 'content': 'x'})
check('a decomposed (Mac) name is stored composed', s == 201 and n1['name'] == unicodedata.normalize('NFC', nfd), (s, n1))
s, _ = admin.req('POST', f'/api/nodes/{F19}/files', {'name': unicodedata.normalize('NFC', nfd), 'content': 'y'})
s, kids = admin.req('GET', f'/api/nodes/{F19}')
check('the same name in the other form is the same file', len([c for c in kids['children'] if c['name'] == n1['name']]) == 1, kids['children'])
# the type follows the name
s, scan = admin.req('POST', f'/api/nodes/{F19}/files', {'name': 'scan', 'content': '%PDF-1.4'})
s, scan2 = admin.req('PATCH', f"/api/nodes/{scan['id']}", {'name': 'scan.pdf'})
check('renaming to .pdf makes it a PDF', scan2.get('mime') == 'application/pdf', scan2)
# keep both
s, kb = admin.req('POST', '/api/uploads', {'parentId': F19, 'name': 'scan.pdf', 'size': 3, 'onConflict': 'rename'})
check('keep both: the upload gets a free name', s == 201 and kb['name'] == 'scan (2).pdf', kb)
admin.req('PUT', f"/api/uploads/{kb['id']}", b'abc', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
s, kids = admin.req('GET', f'/api/nodes/{F19}')
names = [c['name'] for c in kids['children']]
check('both files are there', 'scan.pdf' in names and 'scan (2).pdf' in names, names)
# the editor's version check
s, note = admin.req('POST', f'/api/nodes/{F19}/files', {'name': 'note.txt', 'content': 'one'})
s, _ = admin.req('PUT', f"/api/nodes/{note['id']}/content", 'two', headers={'Content-Type': 'application/octet-stream', 'If-Match': f'"{note["etag"]}"'})
check('save with the current version works', s == 200, s)
s, _ = admin.req('PUT', f"/api/nodes/{note['id']}/content", 'three', headers={'Content-Type': 'application/octet-stream', 'If-Match': f'"{note["etag"]}"'})
check('save from an older version is refused (412)', s == 412, s)
# saving over a file keeps it (links, id); the old content becomes a version
s, doc = admin.req('POST', f'/api/nodes/{F19}/files', {'name': 'doc.txt', 'content': 'version 1'})
s, lnk = admin.req('POST', f"/api/nodes/{doc['id']}/shares", {'type': 'link'})
s, _ = admin.req('PUT', f"/api/nodes/{doc['id']}/content", b'version 2', headers={'Content-Type': 'application/octet-stream'})
s, kids = admin.req('GET', f'/api/nodes/{F19}')
doc2 = next(c for c in kids['children'] if c['name'] == 'doc.txt')
s, body, _ = Client().req('GET', f"/api/public/{lnk['url'].split('/')[-1]}/nodes/{doc2['id']}/download", raw=True)
check('saving over a file keeps the file and its link', doc2['id'] == doc['id'] and body == b'version 2', (doc, doc2, body))
s, vs = admin.req('GET', f"/api/nodes/{doc['id']}/versions")
check('the old content is a version', s == 200 and len(vs) == 1, vs)
s, _ = admin.req('PUT', f"/api/nodes/{doc['id']}/content", b'x', headers={'Content-Type': 'application/octet-stream', 'If-Match': '"stale"'})
check('If-Match with an old version is 412', s == 412, s)
# the account time zone (link expiry uses it); an unknown zone is refused
s, _ = admin.req('PATCH', '/api/me', {'timezone': 'America/New_York'})
check('the account time zone is saved', s == 204 and admin.req('GET', '/api/me')[1].get('timezone') == 'America/New_York', s)
s, _ = admin.req('PATCH', '/api/me', {'timezone': 'Not/AZone'})
check('an unknown time zone is refused', s == 400, s)
admin.req('PATCH', '/api/me', {'timezone': None})
# links
s, l2 = admin.req('POST', f"/api/nodes/{F19}/shares", {'type': 'link', 'password': 'abc'})
check('a link password of 3 characters is refused', s == 400, s)
s, l3 = admin.req('POST', f"/api/nodes/{F19}/shares", {'type': 'link', 'label': 'For the accountant', 'expiresAt': '2031-01-31T23:59:59'})
check('a link label is kept', s == 201 and l3['label'] == 'For the accountant', l3)
# groups
gname = 'g' + uuid.uuid4().hex[:6]
admin.req('POST', '/api/admin/groups', {'id': gname})
s, _ = admin.req('POST', '/api/admin/groups', {'id': gname})
check('a group that exists is said so (409)', s == 409, s)
admin.req('DELETE', f'/api/admin/groups/{gname}')
# search ignores accents when the database can (unaccent), and finds files in folders shared with you
admin.req('POST', f'/api/nodes/{F19}/files', {'name': 'Café menu.txt', 'content': 'x'})
s, found = admin.req('GET', '/api/search?q=cafe%20menu')
check('search ignores accents (or at least finds the exact name)', any(i['name'] == 'Café menu.txt' for i in found) or admin.req('GET', '/api/search?q=Caf%C3%A9')[1] != [], [i['name'] for i in found])
# compression and pages
r = urllib.request.Request(BASE + f'/api/nodes/{root}', headers={'Accept-Encoding': 'gzip', 'Cookie': '; '.join(f'{c.name}={c.value}' for c in admin.jar)})
for i in range(30): admin.req('POST', f'/api/nodes/{F19}/files', {'name': f'pad {i:03}.txt', 'content': 'x'})
r = urllib.request.Request(BASE + f'/api/nodes/{F19}', headers={'Accept-Encoding': 'gzip', 'Cookie': '; '.join(f'{c.name}={c.value}' for c in admin.jar)})
resp = urllib.request.urlopen(r)
raw = resp.read()
check('big listings are sent compressed', resp.headers.get('Content-Encoding') == 'gzip' and json.loads(zlib.decompress(raw, 16 + zlib.MAX_WBITS))['node']['id'] == F19, resp.headers.get('Content-Encoding'))
s, body, hd = Client().req('GET', '/Recent', headers={'Accept': 'text/html'}, raw=True)
check('an unknown page opens the app (404) instead of a bare text', s == 404 and b'/js/app.js' in body, s)
# thumbnails (made in the container; this server may have no image tool)
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
s, up = admin.req('POST', '/api/uploads', {'parentId': F19, 'name': 'dot.png', 'size': len(png)})
s, done = admin.req('PUT', f"/api/uploads/{up['id']}", png, headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
s, tb, hd = admin.req('GET', f"/api/nodes/{done['node']['id']}/thumb", raw=True)
if me19.get('thumbnails'):
    check('a picture gets a WebP thumbnail', s == 200 and hd.get('Content-Type') == 'image/webp' and tb[:4] == b'RIFF', (s, hd.get('Content-Type')))
    s, tb2, _ = admin.req('GET', f"/api/nodes/{scan['id']}/thumb", raw=True)
    check('a file that is no picture gets 404 (the client shows its icon)', s == 404, s)
    # A PDF: its first page, no bigger than a picture's thumbnail (a large page came out thousands of pixels wide).
    objs = [b'<</Type/Catalog/Pages 2 0 R>>', b'<</Type/Pages/Kids[3 0 R]/Count 1>>',
            b'<</Type/Page/Parent 2 0 R/MediaBox[0 0 2384 3370]/Contents 4 0 R>>', None]
    page_ops = b'0.2 0.5 0.8 rg 100 100 2000 3000 re f'
    objs[3] = b'<</Length %d>>stream\n%s\nendstream' % (len(page_ops), page_ops)
    pdf, offsets = bytearray(b'%PDF-1.4\n'), []
    for i, o in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += b'%d 0 obj\n%s\nendobj\n' % (i, o)
    xref = len(pdf)
    pdf += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % off for off in offsets)
    pdf += b'trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    s, up = admin.req('POST', '/api/uploads', {'parentId': F19, 'name': 'A0 poster.pdf', 'size': len(pdf)})
    s, donep = admin.req('PUT', f"/api/uploads/{up['id']}", bytes(pdf), headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
    s, tbp, hdp = admin.req('GET', f"/api/nodes/{donep['node']['id']}/thumb", raw=True)
    # WebP size from the VP8/VP8L/VP8X header: at most 480 on the longest side.
    dims = None
    if s == 200 and tbp[:4] == b'RIFF':
        kind = tbp[12:16]
        if kind == b'VP8X': dims = (1 + int.from_bytes(tbp[24:27], 'little'), 1 + int.from_bytes(tbp[27:30], 'little'))
        elif kind == b'VP8 ': dims = (int.from_bytes(tbp[26:28], 'little') & 0x3FFF, int.from_bytes(tbp[28:30], 'little') & 0x3FFF)
        elif kind == b'VP8L':
            bits = int.from_bytes(tbp[21:25], 'little'); dims = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    check('a PDF gets a thumbnail of its first page, at most 480 px', bool(dims) and max(dims) <= 480 and min(dims) > 100, (s, hdp.get('Content-Type'), dims))
else:
    check('no image tool: thumbnails answer 404', s == 404, s)
# time zone names in their own spelling; a bare offset is no time zone
admin.req('PATCH', '/api/me', {'timezone': 'europe/berlin'})
check('a time zone is stored in its own spelling', admin.req('GET', '/api/me')[1].get('timezone') == 'Europe/Berlin')
s, _ = admin.req('PATCH', '/api/me', {'timezone': '+05:30'})
check('a bare offset is refused', s == 400, s)
admin.req('PATCH', '/api/me', {'timezone': me19.get('timezone')})
# saving text over a file renamed since it was opened: 412, no second file under the old name (here the etag check
# answers; the same rule under the folder lock covers a rename while the text is on its way)
s, ef = admin.req('POST', f'/api/nodes/{F19}/files', {'name': 'edit-me.txt', 'content': 'v1'})
admin.req('PATCH', f"/api/nodes/{ef['id']}", {'name': 'renamed-meanwhile.txt'})
s, _ = admin.req('PUT', f"/api/nodes/{ef['id']}/content", b'v2', headers={'Content-Type': 'application/octet-stream', 'If-Match': f'"{ef["etag"]}"'})
check('saving a file renamed meanwhile asks first (412)', s == 412, s)
check('and leaves no second file under the old name', not any(c['name'] == 'edit-me.txt' for c in admin.req('GET', f'/api/nodes/{F19}')[1]['children']))
# "Keep both" with a folder of the same name: the file gets a free name (it was refused)
admin.req('POST', f'/api/nodes/{F19}/folders', {'name': 'clash'})
s, up = admin.req('POST', '/api/uploads', {'parentId': F19, 'name': 'clash', 'size': 1, 'onConflict': 'rename'})
check('"Keep both" over a folder of the same name stores the file as "clash (2)"', s == 201 and up.get('name') == 'clash (2)', (s, up))
if s == 201: admin.req('DELETE', f"/api/uploads/{up['id']}")
s, _ = admin.req('POST', '/api/uploads', {'parentId': F19, 'name': 'clash', 'size': 1})
check('without it, a folder of that name still refuses the file', s == 409, s)
# a refused name says why
for bad, why in [('a/b', 'slash'), ('..', '".."'), ('x' * 256, '255'), ('a\x01b', 'control')]:
    s, e = admin.req('POST', f'/api/nodes/{F19}/folders', {'name': bad})
    check(f'name {bad[:6]!r} refused with its reason', s == 400 and why in (e or {}).get('error', ''), (s, e))
# folders at most 250 levels deep: creating, moving and copying a folder below that is refused
chain = [F19]  # F19 is 1 level below the top folder
for i in range(248):
    s, d = admin.req('POST', f'/api/nodes/{chain[-1]}/folders', {'name': f'L{i}'})
    chain.append(d['id'])
s, _ = admin.req('POST', f'/api/nodes/{chain[-1]}/folders', {'name': 'level 250'})
check('a folder 250 levels deep can be made', s == 201, s)
s, e = admin.req('POST', f"/api/nodes/{_['id']}/folders", {'name': 'level 251'}) if s == 201 else (0, {})
check('one level more is refused', s == 400 and '250' in (e or {}).get('error', ''), (s, e))
s, two = admin.req('POST', f'/api/nodes/{F19}/folders', {'name': 'two levels'})
admin.req('POST', f"/api/nodes/{two['id']}/folders", {'name': 'inner'})
s, _ = admin.req('PATCH', f"/api/nodes/{two['id']}", {'parentId': chain[-2]})
check('moving a folder in as deep as allowed works', s == 200, s)
s, e = admin.req('PATCH', f"/api/nodes/{two['id']}", {'parentId': chain[-1]})
check('moving it one level deeper is refused', s == 400 and '250' in (e or {}).get('error', ''), (s, e))
s, e = admin.req('POST', f"/api/nodes/{two['id']}/copy", {'parentId': chain[-1]})
check('copying it there is refused too', s == 400 and '250' in (e or {}).get('error', ''), (s, e))
# share lists name people
s, _ = admin.req('POST', f'/api/nodes/{F19}/shares', {'type': 'user', 'shareWith': bob, 'canEdit': False})
s, lst = admin.req('GET', f'/api/nodes/{F19}/shares')
check('a share names the person (display name)', any(x.get('shareWithName') == 'Bob' and x['shareWith'] == bob for x in lst), lst)
s, out = admin.req('GET', '/api/shares/outgoing')
check('so does "Shared by you"', any(x.get('shareWithName') == 'Bob' for x in out if x['nodeId'] == F19), [x.get('shareWithName') for x in out])
admin.req('DELETE', f'/api/nodes/{F19}')

print('== review 2026-11-28 (search, upload links, two-factor setup, administration)')
# (sign-ins here all succeed: the sections above have used most of the wrong guesses an address gets in 15 minutes)
R28 = uuid.uuid4().hex[:6]
# search: files shared by an account that was disabled since are not found (nor listed without a location)
zed = 'zed' + R28
admin.req('POST', '/api/admin/users', {'id': zed, 'password': 'zed-pass-123'})
zc = Client(); zc.req('POST', '/api/login', {'user': zed, 'password': 'zed-pass-123'})
zroot = zc.req('GET', '/api/me')[1]['rootId']
s, zdir = zc.req('POST', f'/api/nodes/{zroot}/folders', {'name': f'zed-shared-{R28}'})
s, zfile = zc.req('POST', f"/api/nodes/{zdir['id']}/files", {'name': f'zed-inside-{R28}.txt', 'content': 'x'})
s, zone = zc.req('POST', f'/api/nodes/{zroot}/files', {'name': f'zed-single-{R28}.txt', 'content': 'x'})
zc.req('POST', f"/api/nodes/{zdir['id']}/shares", {'type': 'user', 'shareWith': bob})
zc.req('POST', f"/api/nodes/{zone['id']}/shares", {'type': 'group', 'shareWith': 'staff'})
zfound = lambda: sorted(x['name'] for x in bobc.req('GET', f'/api/search?q=zed-')[1] if R28 in x['name'])
check('search finds what another account shares (folder, file inside it, file shared with a group)',
      zfound() == sorted([zdir['name'], zfile['name'], zone['name']]), zfound())
s, _ = admin.req('PATCH', f'/api/admin/users/{zed}', {'disabled': True})
check('disabling an account needs no administrator password', s == 204, s)
check("a disabled account's shared files are gone from the sharee's search", zfound() == [], zfound())
check('...as they are from the folder itself', bobc.req('GET', f"/api/nodes/{zdir['id']}")[0] == 404)
admin.req('PATCH', f'/api/admin/users/{zed}', {'disabled': False})
check('enabled again: found again', len(zfound()) == 3, zfound())
admin.req('DELETE', f'/api/admin/users/{zed}', {'adminPassword': ADMIN_PW})

# public upload links: at most 20 unfinished uploads at a time
s, updir = admin.req('POST', f'/api/nodes/{root}/folders', {'name': f'drop-{R28}'})
s, uplink = admin.req('POST', f"/api/nodes/{updir['id']}/shares", {'type': 'link', 'canEdit': True})
visitor = Client()
started = [visitor.req('POST', f"/api/public/{uplink['token']}/uploads", {'parentId': updir['id'], 'name': f'part-{i}.bin', 'size': 4}) for i in range(20)]
check('a link takes 20 uploads at a time', all(st == 201 for st, _ in started), [st for st, _ in started])
s, e = visitor.req('POST', f"/api/public/{uplink['token']}/uploads", {'parentId': updir['id'], 'name': 'part-20.bin', 'size': 4})
check('the 21st is 429 "Too many uploads in progress on this link"', s == 429 and e.get('error') == 'Too many uploads in progress on this link', (s, e))
s, _ = admin.req('POST', '/api/uploads', {'parentId': updir['id'], 'name': 'owner.bin', 'size': 4})
check("the owner's own uploads into that folder are not counted", s == 201, s)
if s == 201: admin.req('DELETE', f"/api/uploads/{_['id']}")
ids20 = [r['id'] for st, r in started if st == 201]
s, r = visitor.req('PUT', f'/api/uploads/{ids20[0]}', b'done', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
s2, r2 = visitor.req('POST', f"/api/public/{uplink['token']}/uploads", {'parentId': updir['id'], 'name': 'part-21.bin', 'size': 4})
check('a finished upload makes room for the next', s == 200 and r.get('done') and s2 == 201, (s, s2, r2))
for uid in ids20[1:] + ([r2['id']] if s2 == 201 else []): visitor.req('DELETE', f'/api/uploads/{uid}')
admin.req('DELETE', f"/api/nodes/{updir['id']}")

# two-factor setup: ten wrong codes in 15 minutes, then 429 (also for the right one)
tess = 'tess' + R28
admin.req('POST', '/api/admin/users', {'id': tess, 'password': 'tess-pass-123'})
tc = Client(); tc.req('POST', '/api/login', {'user': tess, 'password': 'tess-pass-123'})
s, _ = tc.req('POST', '/api/me/2fa/enable', {'code': '123456'})
check('confirming a two-factor setup that was never started is 400', s == 400, s)
s, tsetup = tc.req('POST', '/api/me/2fa/setup', {'password': 'tess-pass-123'})
near = {totp(tsetup['secret'], o) for o in (-2, -1, 0, 1, 2)}
wrong = next(c for c in ('000000', '111111', '222222', '333333', '444444', '555555') if c not in near)
tries = [tc.req('POST', '/api/me/2fa/enable', {'code': wrong})[0] for _ in range(10)]
check('ten wrong setup codes are each refused (400)', tries == [400] * 10, tries)
s, e = tc.req('POST', '/api/me/2fa/enable', {'code': wrong})
check('the eleventh is 429', s == 429, (s, e))
s, e = tc.req('POST', '/api/me/2fa/enable', {'code': totp(tsetup['secret'])})
check('...and so is the right code, for now', s == 429 and tc.req('GET', '/api/me')[1].get('twoFactor') is False, (s, e))
admin.req('DELETE', f'/api/admin/users/{tess}', {'adminPassword': ADMIN_PW})

# administration: making an administrator, setting a password and resetting two-factor need the administrator's own
# password (adminPassword), and so does deleting someone. Eight refused ones here, of the ten an administrator gets
# in 15 minutes.
gus = 'gus' + R28
s, _ = admin.req('POST', '/api/admin/users', {'id': gus, 'password': 'gus-pass-123'})
check('creating a normal user needs no administrator password', s == 204, s)
s, gt = Client().req('POST', '/api/auth/token', {'user': gus, 'password': 'gus-pass-123', 'deviceName': 'e2e'})
gus_h = {'Authorization': 'Bearer ' + gt['token']}
s, e = admin.req('PATCH', f'/api/admin/users/{gus}', {'password': 'gus-pass-456', 'displayName': 'Changed'})
check('setting a password without adminPassword is 403 "Wrong password"', s == 403 and e.get('error') == 'Wrong password', (s, e))
s, e = admin.req('PATCH', f'/api/admin/users/{gus}', {'password': 'gus-pass-456', 'displayName': 'Changed', 'adminPassword': 'not-the-password'})
check('...and with a wrong one', s == 403 and e.get('error') == 'Wrong password', (s, e))
gu = next(u for u in admin.req('GET', '/api/admin/users')[1] if u['id'] == gus)
check('a refused request changes nothing (name, password, devices)', gu['displayName'] != 'Changed' and Client().req('GET', '/api/me', headers=gus_h)[0] == 200, gu)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'isAdmin': True})
s2, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'resetTwoFactor': True})
gu = next(u for u in admin.req('GET', '/api/admin/users')[1] if u['id'] == gus)
check('making an administrator or resetting two-factor without it: 403', s == 403 and s2 == 403 and gu['isAdmin'] is False, (s, s2, gu))
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'email': f'{gus}-elsewhere@example.com'})
check("a new email address for someone needs the administrator's own password (a reset link goes to it)", s == 403, s)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'email': f'{gus}-elsewhere@example.com', 'adminPassword': ADMIN_PW})
check('with it, the address is saved', s == 204, s)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'email': f'{gus}-elsewhere@example.com', 'displayName': 'Gus'})
check('sending the same address again is not a change (no password needed)', s == 204, s)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'displayName': 'Gus', 'quotaBytes': 5000000, 'removePasskeys': True})
check('other changes need no administrator password', s == 204, s)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'password': 'gus-pass-456', 'adminPassword': ADMIN_PW})
check('with adminPassword the password is set and devices are signed out', s == 204 and Client().req('GET', '/api/me', headers=gus_h)[0] == 401, s)
check('the new password signs in', Client().req('POST', '/api/login', {'user': gus, 'password': 'gus-pass-456'})[0] == 200)
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'isAdmin': True, 'resetTwoFactor': True, 'adminPassword': ADMIN_PW})
gu = next(u for u in admin.req('GET', '/api/admin/users')[1] if u['id'] == gus)
check('with adminPassword: an administrator', s == 204 and gu['isAdmin'] is True, (s, gu))
s, _ = admin.req('PATCH', f'/api/admin/users/{gus}', {'isAdmin': False})
check('taking administrator rights away needs none', s == 204, s)
boss = 'boss' + R28
s, e = admin.req('POST', '/api/admin/users', {'id': boss, 'password': 'boss-pass-123', 'isAdmin': True})
check('creating an administrator without adminPassword: 403, no account', s == 403 and not any(u['id'] == boss for u in admin.req('GET', '/api/admin/users')[1]), (s, e))
s, _ = admin.req('POST', '/api/admin/users', {'id': boss, 'password': 'boss-pass-123', 'isAdmin': True, 'adminPassword': ADMIN_PW})
check('...with it: created as an administrator', s == 204 and any(u['id'] == boss and u['isAdmin'] for u in admin.req('GET', '/api/admin/users')[1]), s)
# Deleting someone (all their files go) is confirmed the same way, on both spellings of the request.
names = lambda: [u['id'] for u in admin.req('GET', '/api/admin/users')[1]]
s, e = admin.req('DELETE', f'/api/admin/users/{boss}')
check('deleting a user without adminPassword: 403, the account stays', s == 403 and e.get('error') == 'Wrong password' and boss in names(), (s, e))
s, e = admin.req('POST', f'/api/admin/users/{boss}/delete', {'adminPassword': 'not-the-password'})
check('...and with a wrong one', s == 403 and boss in names(), (s, e))
s, _ = admin.req('POST', f'/api/admin/users/{boss}/delete', {'adminPassword': ADMIN_PW})
check('with adminPassword the user is deleted (POST .../delete)', s == 204 and boss not in names(), s)
s, _ = admin.req('DELETE', f'/api/admin/users/{gus}', {'adminPassword': ADMIN_PW})
check('...and with DELETE and the same body', s == 204 and gus not in names(), s)
s, e = admin.req('POST', f'/api/admin/users/{ADMIN}/delete', {'adminPassword': ADMIN_PW})
check('an administrator still cannot delete themself here', s == 400, (s, e))

print('== cleanup')
s, _ = admin.req('DELETE', f'/api/admin/users/{bob}', {'adminPassword': ADMIN_PW})
check('delete user', s == 204)
admin.req('DELETE', f'/api/nodes/{fid}')
admin.req('DELETE', '/api/trash')
s, t = admin.req('GET', '/api/trash')
check('empty trash', t == [])

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
