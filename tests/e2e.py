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
pages = ['/', '/files', f'/files/{root}', '/recent', '/shared-in', '/search?q=a%2Fb', '/settings', '/admin', '/forgot', '/reset', '/app']
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

print('== language')
check('language defaults to automatic', me.get('language') is None, me.get('language'))
s, _ = admin.req('PATCH', '/api/me', {'language': 'ar'})
s2, me_l = admin.req('GET', '/api/me')
check('language saved', s == 204 and me_l.get('language') == 'ar', me_l.get('language'))
s, _ = admin.req('PATCH', '/api/me', {'language': 'xx'})
check('unsupported language rejected', s == 400)
s, _ = admin.req('PATCH', '/api/me', {'language': None})
s2, me_l = admin.req('GET', '/api/me')
check('language back to automatic', me_l.get('language') is None)
s, body = admin.req('GET', '/i18n/ar.json')
check('web translations served', s == 200 and body.get('Log in') == 'تسجيل الدخول')

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

print('== limits (Administration, applied without a restart)')
s, lim0 = admin.req('GET', '/api/admin/limits')
check('admin reads limits', s == 200 and all(isinstance(lim0.get(k), int) for k in ('trashDays', 'maxVersions', 'sessionDays')), lim0)
s, _ = bobc.req('GET', '/api/admin/limits')
check('non-admin cannot read limits', s == 403)
s, _ = bobc.req('PUT', '/api/admin/limits', {'trashDays': 5})
check('non-admin cannot change limits', s == 403)
for bad in ({'trashDays': -1}, {'maxVersions': -1}, {'sessionDays': 366}, {'trashDays': 2.5}, {'maxVersions': 'many'}):
    s, _ = admin.req('PUT', '/api/admin/limits', bad)
    check(f'limit rejected: {bad}', s == 400, s)
s, lim = admin.req('PUT', '/api/admin/limits', {'trashDays': 45, 'maxVersions': 2, 'sessionDays': 3})
check('limits saved', s == 200 and lim == {'trashDays': 45, 'maxVersions': 2, 'sessionDays': 3}, lim)
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

print('== app passwords & WebDAV')
s, _ = admin.req('POST', '/api/me/app-passwords', {'name': 'test'})
check('new app password needs the account password', s == 403)
s, ap = admin.req('POST', '/api/me/app-passwords', {'name': 'test', 'password': ADMIN_PW})
check('app password created with the password', s == 201 and ap.get('password'), ap)
dav = Client(basic=f"{ADMIN}:{ap['password']}")
s, _ = Client(basic=f'{ADMIN}:nope').req('PROPFIND', f'/dav/files/{ADMIN}/', headers={'Depth': '0'})
check('DAV rejects bad credentials', s == 401)
s, xml = dav.req('PROPFIND', f'/dav/files/{ADMIN}/{top}/', headers={'Depth': '1'})
check('PROPFIND depth 1', s == 207 and 'big.bin' in xml and '<d:collection/>' in xml, xml[:300])
s, xml = dav.req('PROPFIND', f'/dav/files/{ADMIN}/', '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:x="urn:x"><d:prop><d:getetag/><x:nope/></d:prop></d:propfind>', headers={'Depth': '0'})
check('PROPFIND unknown prop -> 404 propstat', s == 207 and '404 Not Found' in xml and 'getetag' in xml, xml)
s, _ = dav.req('MKCOL', f'/dav/files/{ADMIN}/{top}/davdir')
check('MKCOL', s == 201)
s, _, hd = dav.req('PUT', f'/dav/files/{ADMIN}/{top}/davdir/hello%20world.txt', b'dav content', raw=True)
check('PUT creates', s == 201 and hd['ETag'])
s, _ = dav.req('PUT', f'/dav/files/{ADMIN}/{top}/davdir/hello%20world.txt', b'dav content 2')
check('PUT overwrite', s == 204)
s, body, _h = dav.req('GET', f'/dav/files/{ADMIN}/{top}/davdir/hello%20world.txt', raw=True)
check('GET via DAV', body == b'dav content 2')
s, _ = dav.req('MOVE', f'/dav/files/{ADMIN}/{top}/davdir/hello%20world.txt', headers={'Destination': f'{BASE}/dav/files/{ADMIN}/{top}/moved.txt'})
check('MOVE', s == 201)
s, _ = dav.req('COPY', f'/dav/files/{ADMIN}/{top}/moved.txt', headers={'Destination': f'{BASE}/dav/files/{ADMIN}/{top}/davdir/copy.txt'})
check('COPY', s == 201)
s, _ = dav.req('COPY', f'/dav/files/{ADMIN}/{top}/moved.txt', headers={'Destination': f'{BASE}/dav/files/{ADMIN}/{top}/davdir/copy.txt', 'Overwrite': 'F'})
check('COPY Overwrite:F conflict', s == 412)
s, xml, hd = dav.req('LOCK', f'/dav/files/{ADMIN}/{top}/moved.txt', '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner>me</d:owner></d:lockinfo>', raw=True)
check('LOCK returns token', s == 200 and hd['Lock-Token'])
s, _ = dav.req('DELETE', f'/dav/files/{ADMIN}/{top}/moved.txt')
check('DELETE', s == 204)
s, _ = dav.req('PROPFIND', f'/dav/files/{bob}/', headers={'Depth': '0'})
check('cannot access other user DAV', s == 403)
s, _, hd = dav.req('OPTIONS', '/dav/', raw=True)
check('OPTIONS advertises DAV classes', 'calendar-access' in (hd['DAV'] or ''))

print('== CalDAV')
s, xml = dav.req('PROPFIND', '/dav/', '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', headers={'Depth': '0'})
check('current-user-principal', f'/dav/principals/{ADMIN}/' in xml, xml)
s, xml = dav.req('PROPFIND', f'/dav/principals/{ADMIN}/', '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:prop><c:calendar-home-set/><a:addressbook-home-set/></d:prop></d:propfind>', headers={'Depth': '0'})
check('home sets', f'/dav/calendars/{ADMIN}/' in xml and f'/dav/addressbooks/{ADMIN}/' in xml, xml)
s, xml = dav.req('PROPFIND', f'/dav/calendars/{ADMIN}/', headers={'Depth': '1'})
check('calendar home lists personal', s == 207 and '/personal/' in xml and 'cal:calendar' in xml, xml[:400])
s, _ = dav.req('MKCALENDAR', f'/dav/calendars/{ADMIN}/work-{top}/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Work</d:displayname></d:prop></d:set></c:mkcalendar>')
check('MKCALENDAR', s == 201)
s, xml = dav.req('PROPFIND', f'/dav/calendars/{ADMIN}/personal/', '<d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>', headers={'Depth': '0'})
tok0 = re.search(r'<d:sync-token>([^<]+)</d:sync-token>', xml).group(1)
uid = str(uuid.uuid4())
ics = f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261020T100000Z\r\nDTEND:20261020T110000Z\r\nSUMMARY:Weekly sync\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
s, _, hd = dav.req('PUT', f'/dav/calendars/{ADMIN}/personal/{uid}.ics', ics, headers={'Content-Type': 'text/calendar', 'If-None-Match': '*'}, raw=True)
check('PUT event', s == 201 and hd['ETag'])
s, _ = dav.req('PUT', f'/dav/calendars/{ADMIN}/personal/{uid}.ics', ics, headers={'If-None-Match': '*'})
check('If-None-Match:* on existing -> 412', s == 412)
s, _ = dav.req('PUT', f'/dav/calendars/{ADMIN}/personal/bad.ics', 'not ical')
check('invalid iCalendar rejected', s == 400)
q = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261101T000000Z" end="20261201T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>'
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', q, headers={'Depth': '1'})
check('calendar-query time-range hits recurring event', s == 207 and 'Weekly sync' in xml, xml[:300])
q2 = q.replace('20261101', '20270101').replace('20261201', '20270201')
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', q2, headers={'Depth': '1'})
check('calendar-query excludes out-of-range', s == 207 and 'Weekly sync' not in xml)
mg = f'<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/dav/calendars/{ADMIN}/personal/{uid}.ics</d:href><d:href>/dav/calendars/{ADMIN}/personal/missing.ics</d:href></c:calendar-multiget>'
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', mg)
check('calendar-multiget', 'BEGIN:VCALENDAR' in xml and '404' in xml)
sc = f'<d:sync-collection xmlns:d="DAV:"><d:sync-token>{tok0}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>'
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', sc)
check('sync-collection reports new item', s == 207 and f'{uid}.ics' in xml, xml)
tok1 = re.search(r'<d:sync-token>([^<]+)</d:sync-token>', xml).group(1)
s, events = admin.req('GET', '/api/calendars')
personal = next(c for c in events if c['uri'] == 'personal')
s, evs = admin.req('GET', f"/api/calendars/{personal['id']}/events?start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z")
check('JSON API expands 4 occurrences', s == 200 and len([e for e in evs if e['uid'] == uid]) == 4, len(evs))
s, r = admin.req('POST', f"/api/calendars/{personal['id']}/events", {'summary': 'All day thing', 'allDay': True, 'start': '2026-10-22', 'end': '2026-10-23'})
check('create event via JSON', s == 201, r)
s, evs = admin.req('GET', f"/api/calendars/{personal['id']}/events?start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z")
ad = next((e for e in evs if e['summary'] == 'All day thing'), None)
check('all-day event round-trip', ad and ad['allDay'] and ad['start'] == '2026-10-22', ad)
s, _ = admin.req('PUT', f"/api/calendars/{personal['id']}/events/{ad['uri']}", {'summary': 'Renamed', 'allDay': False, 'start': '2026-10-22T09:00:00Z', 'end': '2026-10-22T10:00:00Z', 'rrule': 'DAILY'})
s, body, _h = dav.req('GET', f"/dav/calendars/{ADMIN}/personal/{ad['uri']}", raw=True)
check('JSON edit visible over CalDAV', b'SUMMARY:Renamed' in body and b'RRULE:FREQ=DAILY' in body, body)
dav.req('DELETE', f'/dav/calendars/{ADMIN}/personal/{uid}.ics')
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', sc.replace(tok0, tok1))
check('sync-collection reports deletion', f'{uid}.ics' in xml and '404' in xml, xml)
s, xml = dav.req('REPORT', f'/dav/calendars/{ADMIN}/personal/', sc.replace(tok0, 'http://cloudy.local/sync/999999'))
check('invalid sync token -> 403', s == 403 and 'valid-sync-token' in xml)

print('== CardDAV')
cuid = str(uuid.uuid4())
vcf = f'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{cuid}\r\nFN:Ada Lovelace\r\nN:Lovelace;Ada;;;\r\nEMAIL:ada@example.com\r\nTEL:+44 20 1234\r\nEND:VCARD\r\n'
s, _ = dav.req('PUT', f'/dav/addressbooks/{ADMIN}/contacts/{cuid}.vcf', vcf, headers={'Content-Type': 'text/vcard'})
check('PUT vCard', s == 201)
s, xml = dav.req('REPORT', f'/dav/addressbooks/{ADMIN}/contacts/', '<a:addressbook-query xmlns:d="DAV:" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><a:address-data/></d:prop></a:addressbook-query>', headers={'Depth': '1'})
check('addressbook-query', 'Ada Lovelace' in xml)
s, books = admin.req('GET', '/api/addressbooks')
bk = next(b for b in books if b['uri'] == 'contacts')
s, cts = admin.req('GET', f"/api/addressbooks/{bk['id']}/contacts")
ada = next((c for c in cts if c['uid'] == cuid), None)
check('JSON contact parsed', ada and ada['givenName'] == 'Ada' and ada['emails'] == ['ada@example.com'], ada)
s, c2 = admin.req('POST', f"/api/addressbooks/{bk['id']}/contacts", {'givenName': 'Grace', 'familyName': 'Hopper', 'emails': ['grace@navy.mil'], 'phones': ['555'], 'org': 'US Navy', 'birthday': '1906-12-09', 'address': '1 Main St'})
check('create contact via JSON', s == 201 and c2['fn'] == 'Grace Hopper' and c2['org'] == 'US Navy', c2)
s, body, _h = dav.req('GET', f"/dav/addressbooks/{ADMIN}/contacts/{c2['uri']}", raw=True)
check('JSON contact is valid vCard 3.0', b'VERSION:3.0' in body and b'N:Hopper;Grace' in body and b'EMAIL' in body, body)
s, c3 = admin.req('PUT', f"/api/addressbooks/{bk['id']}/contacts/{c2['uri']}", {**c2, 'title': 'Rear Admiral'})
check('update contact', s == 200 and c3['title'] == 'Rear Admiral', c3)

print('== contacts import / export')
s, books = admin.req('GET', '/api/addressbooks')
book = next((b for b in books), None) or admin.req('POST', '/api/addressbooks', {'name': 'Contacts'})[1]
s, ib = admin.req('POST', '/api/addressbooks', {'name': 'Import test'})
bid = ib['id']
v21 = ('BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=B9=D9=84=D9=8A;;;;\r\n'
       'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=B9=D9=84=D9=8A\r\nTEL;CELL:+971 50 000 0001\r\nEND:VCARD\r\n'
       'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:e2e-uid-1\r\nFN:Jane Doe\r\nN:Doe;Jane;;;\r\nEMAIL:jane@example.com\r\nEND:VCARD\r\n'
       'BEGIN:VCARD\r\nVERSION:2.1\r\nEND:VCARD\r\n').encode()
oct_h = {'Content-Type': 'application/octet-stream'}
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', v21, headers=oct_h)
check('import vCard 2.1 + 3.0', s == 200 and r['imported'] == 2 and r['skipped'] == 1, r)
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', v21, headers=oct_h)
check('re-import adds no duplicates', s == 200 and r['imported'] == 0 and r['updated'] == 1 and r['duplicates'] == 1, r)
upd = v21.replace(b'EMAIL:jane@example.com', b'EMAIL:jane@new.example')
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', upd, headers=oct_h)
s, cs = admin.req('GET', f'/api/addressbooks/{bid}/contacts')
names = sorted(c['fn'] for c in cs)
check('imported contacts readable (Arabic name, updated by UID)', names == sorted(['علي', 'Jane Doe']) and any(c['emails'] == ['jane@new.example'] for c in cs), cs)
csv = ('﻿First Name,Last Name,E-mail 1 - Value,Phone 1 - Value,Organization Name\n'
       'Omar,Saleh,omar@example.com ::: o.saleh@example.com,+971500000002,ACME\n'
       'Jane,Doe,jane@new.example,,\n').encode()
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', csv, headers=oct_h)
check('import Google CSV (existing person skipped)', s == 200 and r['format'] == 'csv' and r['imported'] == 1 and r['duplicates'] == 1, r)
s, cs = admin.req('GET', f'/api/addressbooks/{bid}/contacts')
omar = next((c for c in cs if c['fn'] == 'Omar Saleh'), {})
check('CSV fields mapped', len(omar.get('emails', [])) == 2 and omar.get('org') == 'ACME' and omar.get('phones') == ['+971500000002'], omar)
s, body, hd = admin.req('GET', f'/api/addressbooks/{bid}/export', raw=True)
check('export all as .vcf', s == 200 and body.count(b'BEGIN:VCARD') == 3 and 'vcard' in hd.get('Content-Type', ''), body[:200])
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', b'foo,bar\n1,2\n', headers=oct_h)
check('unrecognized file rejected with a message', s == 400 and 'columns' in r.get('error', ''), r)
s, r = admin.req('POST', f'/api/addressbooks/{bid}/import', body, headers=oct_h)
check('importing own export changes nothing new', s == 200 and r['imported'] == 0, r)
s, _ = bobc.req('POST', f'/api/addressbooks/{bid}/import', v21, headers=oct_h)
check("cannot import into someone else's address book", s == 404)
admin.req('DELETE', f'/api/addressbooks/{bid}')

print('== mobile token auth')
mob = Client()
s, r = mob.req('POST', '/api/auth/token', {'user': ADMIN, 'password': ADMIN_PW, 'deviceName': 'Test phone'})
check('token issued', s == 201 and r.get('token') and r['user']['rootId'], r)
tok_h = {'Authorization': 'Bearer ' + r['token']}
s, me2 = mob.req('GET', '/api/me', headers=tok_h)
check('bearer token authenticates API', s == 200 and me2['id'] == ADMIN)
s, aps = admin.req('GET', '/api/me/app-passwords')
check('token listed as app password', any(a['name'] == 'App: Test phone' for a in aps))
check('web session marks no token as current', not any(a.get('current') for a in aps))
s, aps_m = mob.req('GET', '/api/me/app-passwords', headers=tok_h)
check('the phone sees its own token as current', [a['name'] for a in aps_m if a.get('current')] == ['App: Test phone'], aps_m)
s, _ = Client(basic=f"{ADMIN}:{r['token']}").req('PROPFIND', f'/dav/files/{ADMIN}/', headers={'Depth': '0'})
check('token also works for DAV', s == 207)
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
noredir2 = urllib.request.build_opener(type('NoRedirect2', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *a: None}))
for kind in ('caldav', 'carddav'):
    try:
        r = noredir2.open(BASE + f'/.well-known/{kind}'); s, loc = r.status, r.headers.get('Location')
    except urllib.error.HTTPError as e:
        s, loc = e.code, e.headers.get('Location')
    check(f'/.well-known/{kind} redirects to /dav/', s in (301, 302) and loc.rstrip('/').endswith('/dav'), (s, loc))

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

s, _ = admin.req('PUT', '/api/admin/mail', {'host': 'smtp.invalid', 'port': 2525, 'security': 'none', 'fromEmail': 'no-mail'})
check('invalid sender address rejected', s == 400)
s, _ = Client().req('GET', '/api/admin/mail')
check('mail settings need admin', s == 401)
smtp_host = os.environ.get('CLOUDY_TEST_SMTP_HOST')
s, _ = admin.req('PUT', '/api/admin/mail', {'host': smtp_host or 'smtp.invalid', 'port': 2525, 'security': 'none',
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
    # Emails use the recipient's language.
    dave2 = Client(); dave2.req('POST', '/api/login', {'user': dave, 'password': 'dave-new-pass-1'})
    dave2.req('PATCH', '/api/me', {'language': 'de', 'notifyShares': True})
    s, f4 = admin.req('POST', f'/api/nodes/{root}/folders', {'name': 'de-' + uuid.uuid4().hex[:6]})
    admin.req('POST', f"/api/nodes/{f4['id']}/shares", {'type': 'user', 'shareWith': dave})
    check('share email in the recipient\'s language', got(lambda m: f4['name'] in m['subject'] and 'mit dir geteilt' in m['subject']), mails)
    admin.req('DELETE', f"/api/nodes/{f4['id']}")
    srv.shutdown()
    admin.req('DELETE', f"/api/nodes/{f2['id']}"); admin.req('DELETE', f"/api/nodes/{f3['id']}")
    admin.req('DELETE', f'/api/admin/users/{dave}')
s, _ = admin.req('PUT', '/api/admin/mail', {'host': ''})
s, opts = Client().req('GET', '/api/auth/options')
check('turning email off hides password reset', opts['passwordReset'] is False)

# (before the 2FA section: its deliberate failures use up the per-address login limit, and DAV checks it again)
print('== review 2026-11-04 (races, DAV, recurrence guard, account safety)')
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
# public upload link: the owner's file made while a visitor uploads is never replaced
s, ln = admin.req('POST', f'/api/nodes/{rvid}/shares', {'type': 'link', 'canEdit': True, 'expiresAt': '2999-01-01T00:00:00Z'})
s, up = Client().req('POST', f"/api/public/{ln['token']}/uploads", {'parentId': rvid, 'name': 'race.txt', 'size': 7})
admin.req('POST', f'/api/nodes/{rvid}/files', {'name': 'race.txt', 'content': 'owner'})
s, r = Client().req('PUT', f"/api/uploads/{up['id']}", b'visitor', headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
names = {c['name']: c['size'] for c in admin.req('GET', f'/api/nodes/{rvid}')[1]['children']}
check('link upload never overwrites a file the owner made meanwhile', r.get('done') and names.get('race.txt') == 5 and names.get('race (2).txt') == 7, names)
# DAV
rvname = rv['name']
s, _ = dav.req('MKCOL', f'/dav/files/{ADMIN}/{rvname}/m'); dav.req('MKCOL', f'/dav/files/{ADMIN}/{rvname}/m/n')
s, _ = dav.req('MOVE', f'/dav/files/{ADMIN}/{rvname}/m/n', headers={'Destination': f'{BASE}/dav/files/{ADMIN}/{rvname}/m', 'Overwrite': 'T'})
s2, _ = dav.req('PROPFIND', f'/dav/files/{ADMIN}/{rvname}/m/n', headers={'Depth': '0'})
check('DAV MOVE onto its own parent refused before anything is trashed', s == 409 and s2 == 207, (s, s2))
s, _ = dav.req('MOVE', f'/dav/files/{ADMIN}/{rvname}/m')
check('DAV MOVE without Destination is 400', s == 400)
s, _ = dav.req('PUT', f'/dav/files/{ADMIN}/{rvname}/trailing%20', 'x')
check('DAV PUT with a bad name is 400', s == 400)
# recurrence that never produces a second date (used to freeze the server)
s, cals = admin.req('GET', '/api/calendars')
cal_uri = cals[0]['uri']
bad_ics = ('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:loop-' + uuid.uuid4().hex + '\r\nDTSTAMP:20260101T000000Z\r\n'
           'DTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=2\r\nSUMMARY:loop\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
t0 = time.time()
s, _ = dav.req('PUT', f'/dav/calendars/{ADMIN}/{cal_uri}/loop-{uuid.uuid4().hex[:6]}.ics', bad_ics, headers={'Content-Type': 'text/calendar'})
check('endless RRULE rejected quickly', s == 400 and time.time() - t0 < 10, (s, time.time() - t0))
s, _ = admin.req('GET', '/status')
check('server still answers after it', s == 200)
# a year-less birthday (as phones store it) survives a save from the apps
s, books = admin.req('GET', '/api/addressbooks')
bkid = books[0]['id']; buid = 'bday-' + uuid.uuid4().hex[:8]
dav.req('PUT', f"/dav/addressbooks/{ADMIN}/{books[0]['uri']}/{buid}.vcf", f'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{buid}\r\nFN:Bday Test\r\nN:Test;Bday;;;\r\nBDAY:--04-15\r\nEND:VCARD\r\n', headers={'Content-Type': 'text/vcard'})
s, cts = admin.req('GET', f'/api/addressbooks/{bkid}/contacts')
bc = next(c for c in cts if c['uid'] == buid)
s, saved = admin.req('PUT', f"/api/addressbooks/{bkid}/contacts/{bc['uri']}", {**bc, 'note': 'edited'})
check('unchanged year-less birthday kept on save', s == 200 and saved['birthday'] == '--04-15' and saved['note'] == 'edited', saved)
s, saved = admin.req('PUT', f"/api/addressbooks/{bkid}/contacts/{bc['uri']}", {**bc, 'birthday': ''})
check('empty birthday still clears it', s == 200 and saved['birthday'] == '', saved)
admin.req('DELETE', f"/api/addressbooks/{bkid}/contacts/{bc['uri']}")
# email change needs the password; same email / language only do not
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
admin.req('DELETE', f'/api/admin/users/{ghost}')
admin.req('POST', '/api/admin/users', {'id': ghost, 'password': 'ghost-pass-123'})
gc = Client(); gc.req('POST', '/api/login', {'user': ghost, 'password': 'ghost-pass-123'})
s, inc = gc.req('GET', '/api/shares/incoming')
check("recreated account doesn't inherit old shares", s == 200 and inc == [], inc)
s, gt = Client().req('POST', '/api/auth/token', {'user': ghost, 'password': 'ghost-pass-123', 'deviceName': 'e2e'})
admin.req('PATCH', f'/api/admin/users/{ghost}', {'password': 'ghost-pass-456'})
s, _ = Client().req('GET', '/api/me', headers={'Authorization': 'Bearer ' + gt['token']})
check('admin password reset signs devices out', s == 401)
s, _ = admin.req('PATCH', f'/api/admin/users/{ghost}', {'quotaBytes': 'lots'})
check('invalid quota is 400', s == 400)
admin.req('DELETE', f'/api/admin/users/{ghost}')
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
s, _ = Client(basic=f'{carol}:carol-pass-123').req('PROPFIND', f'/dav/files/{carol}/', headers={'Depth': '0'})
check('DAV rejects account password when 2FA is on', s == 401)
s, _ = Client(basic=f"{carol}:{r['token']}").req('PROPFIND', f'/dav/files/{carol}/', headers={'Depth': '0'})
check('DAV accepts app password when 2FA is on', s == 207)
s, _ = cc.req('POST', '/api/me/2fa/disable', {'password': 'wrong'})
check('disabling 2FA needs the password', s == 403)
s, _ = admin.req('PATCH', f'/api/admin/users/{carol}', {'resetTwoFactor': True})
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
admin.req('DELETE', f'/api/admin/users/{carol}')

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
s, ap19 = admin.req('POST', '/api/me/app-passwords', {'name': 'e2e 1.19', 'password': ADMIN_PW})
d19 = Client(basic=f"{ADMIN}:{ap19['password']}")  # app passwords are never limited (the suite filled the limiter)
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
# WebDAV: saving over a file keeps it (links, id); conditional requests; whole trees
fpath = f"/dav/files/{ADMIN}/{f19['name']}"
d19.req('PUT', f'{fpath}/doc.txt', b'version 1')
s, kids = admin.req('GET', f'/api/nodes/{F19}')
doc = next(c for c in kids['children'] if c['name'] == 'doc.txt')
s, lnk = admin.req('POST', f"/api/nodes/{doc['id']}/shares", {'type': 'link'})
d19.req('PUT', f'{fpath}/doc.txt.tmp', b'version 2')
s, _ = d19.req('MOVE', f'{fpath}/doc.txt.tmp', headers={'Destination': f'{BASE}{fpath}/doc.txt', 'Overwrite': 'T'})
s, kids = admin.req('GET', f'/api/nodes/{F19}')
doc2 = next(c for c in kids['children'] if c['name'] == 'doc.txt')
s, body, _ = Client().req('GET', f"/api/public/{lnk['url'].split('/')[-1]}/nodes/{doc2['id']}/download", raw=True)
check('save-over by MOVE keeps the file and its link', doc2['id'] == doc['id'] and body == b'version 2' and not any(c['name'] == 'doc.txt.tmp' for c in kids['children']), (doc, doc2, body))
s, vs = admin.req('GET', f"/api/nodes/{doc['id']}/versions")
check('the old content is a version', s == 200 and len(vs) == 1, vs)
s, _ = d19.req('PUT', f'{fpath}/doc.txt', b'x', headers={'If-None-Match': '*'})
check('If-None-Match: * on an existing file is 412', s == 412, s)
s, _ = d19.req('PUT', f'{fpath}/doc.txt', b'x', headers={'If-Match': '"stale"'})
check('If-Match with an old version is 412', s == 412, s)
s, _ = d19.req('PROPFIND', f'/dav/files/{ADMIN}/', headers={'Depth': 'infinity'})
check('PROPFIND Depth: infinity is refused (403)', s == 403, s)
# time zones: a weekly 09:00 meeting in Berlin stays at 09:00 across the clock change
s, cals = admin.req('GET', '/api/calendars')
cal = cals[0]['id']
s, ev = admin.req('POST', f'/api/calendars/{cal}/events', {'summary': 'Weekly sync', 'start': '2027-03-15T08:00:00.000Z', 'end': '2027-03-15T09:00:00.000Z', 'rrule': 'WEEKLY', 'tz': 'Europe/Berlin'})
s, occ = admin.req('GET', f'/api/calendars/{cal}/events?start=2027-03-14T00:00:00Z&end=2027-04-12T00:00:00Z')
starts = [o['start'] for o in occ if o['uri'] == ev['uri']]
check('weekly event keeps 09:00 Berlin after the clock change', starts[:2] == ['2027-03-15T08:00:00.000Z', '2027-03-22T08:00:00.000Z'] and starts[2] == '2027-03-29T07:00:00.000Z', starts)
s, raw = d19.req('GET', f"/dav/calendars/{ADMIN}/{cals[0]['uri']}/{ev['uri']}")
check('the event is stored with its time zone', 'DTSTART;TZID=Europe/Berlin:20270315T090000' in raw and 'BEGIN:VTIMEZONE' in raw, raw[:400])
s, _ = admin.req('PUT', f"/api/calendars/{cal}/events/{ev['uri']}", {'summary': 'Weekly sync (renamed)', 'start': '2027-03-15T08:00:00.000Z', 'end': '2027-03-15T09:00:00.000Z', 'rrule': 'WEEKLY'})
s, raw2 = d19.req('GET', f"/dav/calendars/{ADMIN}/{cals[0]['uri']}/{ev['uri']}")
check('an edit of the title leaves the times as they were', 'DTSTART;TZID=Europe/Berlin:20270315T090000' in raw2 and 'renamed' in raw2, raw2[:400])
check('timestamps are UTC', re.search(r'DTSTAMP:\d{8}T\d{6}Z', raw2) is not None, raw2[:400])
admin.req('PATCH', '/api/me', {'timezone': 'America/New_York'})
s, ev2 = admin.req('POST', f'/api/calendars/{cal}/events', {'summary': 'Standup', 'start': '2027-03-01T14:00:00.000Z', 'end': '2027-03-01T14:15:00.000Z', 'rrule': 'DAILY'})
s, raw3 = d19.req('GET', f"/dav/calendars/{ADMIN}/{cals[0]['uri']}/{ev2['uri']}")
check('without a zone from the client, the account zone is used', 'TZID=America/New_York' in raw3, raw3[:300])
s, _ = admin.req('PATCH', '/api/me', {'timezone': 'Not/AZone'})
check('an unknown time zone is refused', s == 400, s)
admin.req('PATCH', '/api/me', {'timezone': None})
admin.req('DELETE', f"/api/calendars/{cal}/events/{ev['uri']}"); admin.req('DELETE', f"/api/calendars/{cal}/events/{ev2['uri']}")
# contacts keep what the form does not show
s, books = admin.req('GET', '/api/addressbooks')
book = books[0]
vc = ('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:e2e-keep\r\nFN:Anna Meier\r\nN:Meier;Anna;Maria;Dr.;PhD\r\nTEL;TYPE=CELL:+49 170 1\r\n'
      'TEL;TYPE=WORK:+49 30 2\r\nitem1.TEL:+49 40 3\r\nitem1.X-ABLABEL:Studio\r\nEMAIL;TYPE=WORK:anna@example.de\r\nORG:Acme;Engineering\r\n'
      'ADR;TYPE=HOME:;;Hauptstr. 1;Berlin;;10115;Germany\r\nADR;TYPE=WORK:;;Werkstr. 2;Berlin;;10117;Germany\r\nNOTE:old\r\nEND:VCARD\r\n')
d19.req('PUT', f"/dav/addressbooks/{ADMIN}/{book['uri']}/e2e-keep.vcf", vc, headers={'Content-Type': 'text/vcard'})
s, cs = admin.req('GET', f"/api/addressbooks/{book['id']}/contacts")
anna = next(c for c in cs if c['fn'] == 'Anna Meier')
s, _ = admin.req('PUT', f"/api/addressbooks/{book['id']}/contacts/{anna['uri']}", {**anna, 'note': 'new note'})
s, after = d19.req('GET', f"/dav/addressbooks/{ADMIN}/{book['uri']}/e2e-keep.vcf")
keep = ['N:Meier;Anna;Maria;Dr.;PhD', 'TEL;TYPE=CELL:+49 170 1', 'ITEM1.X-ABLABEL:Studio', 'ORG:Acme;Engineering', 'ADR;TYPE=WORK:;;Werkstr. 2', 'NOTE:new note']
# (vCard group names ignore case: ical.js writes item1 as ITEM1)
check('saving a contact keeps names, labels, department and other addresses', all(k.upper() in after.upper() for k in keep), [k for k in keep if k.upper() not in after.upper()])
s, ph = admin.req('POST', f"/api/addressbooks/{book['id']}/contacts", {'phones': ['+971 4 555 0100']})
check('a contact with only a phone number can be saved', s == 201, (s, ph))
admin.req('DELETE', f"/api/addressbooks/{book['id']}/contacts/{anna['uri']}")
if s == 201: admin.req('DELETE', f"/api/addressbooks/{book['id']}/contacts/{ph['uri']}")
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
# events near a clock change keep their local time (they were stored an hour off), the VTIMEZONE comes first
s, cals2 = admin.req('GET', '/api/calendars')
c19 = cals2[0]
for label, tz, st, en, want in [
    ('Los Angeles, Saturday evening before the spring change', 'America/Los_Angeles', '2027-03-14T03:00:00.000Z', '2027-03-14T05:00:00.000Z', '20270313T190000'),
    ('New York, Saturday evening before the autumn change', 'America/New_York', '2027-11-07T01:00:00.000Z', '2027-11-07T03:00:00.000Z', '20271106T210000'),
    ('Sydney, Sunday morning of the change', 'Australia/Sydney', '2027-04-03T23:00:00.000Z', '2027-04-04T00:00:00.000Z', '20270404T090000'),
]:
    s, ev = admin.req('POST', f"/api/calendars/{c19['id']}/events", {'summary': label, 'start': st, 'end': en, 'rrule': 'WEEKLY', 'tz': tz})
    s, raw = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{ev['uri']}")
    s, occ = admin.req('GET', f"/api/calendars/{c19['id']}/events?start={st[:10]}T00:00:00Z&end={st[:8]}28T00:00:00Z")
    first = next((o['start'] for o in occ if o['uri'] == ev['uri']), None)
    check(f'{label}: stored at its local time', f'DTSTART;TZID={tz}:{want}' in raw and raw.index('BEGIN:VTIMEZONE') < raw.index('BEGIN:VEVENT')
          and bool(first) and first.startswith(st[:16]), ([l for l in raw.split('\r\n') if l.startswith('DTSTART')], first))
    admin.req('DELETE', f"/api/calendars/{c19['id']}/events/{ev['uri']}")
# the same for a zone known only from the event's own VTIMEZONE (Outlook's names), edited near its clock changes
for tzid, rules, cases in [
    ('Pacific Standard Time', ('-0700', '-0800', '1SU', '11', '-0800', '-0700', '2SU', '3'),
     [('2027-03-14T09:30:00.000Z', '20270314T013000'), ('2027-03-14T11:30:00.000Z', '20270314T043000'), ('2027-07-01T16:00:00.000Z', '20270701T090000')]),
    ('AUS Eastern Standard Time', ('+1100', '+1000', '1SU', '4', '+1000', '+1100', '1SU', '10'),
     [('2027-04-03T15:30:00.000Z', '20270404T023000'), ('2027-10-02T16:30:00.000Z', '20271003T033000')]),
]:
    sf, st_, sday, smon, df, dt_, dday, dmon = rules
    vtz = (f'BEGIN:VTIMEZONE\r\nTZID:{tzid}\r\nBEGIN:STANDARD\r\nDTSTART:16010101T030000\r\nTZOFFSETFROM:{sf}\r\nTZOFFSETTO:{st_}\r\n'
           f'RRULE:FREQ=YEARLY;BYDAY={sday};BYMONTH={smon}\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\n'
           f'TZOFFSETFROM:{df}\r\nTZOFFSETTO:{dt_}\r\nRRULE:FREQ=YEARLY;BYDAY={dday};BYMONTH={dmon}\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n')
    for i, (start, want) in enumerate(cases):
        uid = f'e2e-outlook-{tzid[:3]}-{i}'
        ics = (f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//e2e//EN\r\n{vtz}BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20270101T000000Z\r\n'
               f'DTSTART;TZID={tzid}:20270105T100000\r\nDTEND;TZID={tzid}:20270105T110000\r\nSUMMARY:t\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')
        d19.req('PUT', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics", ics, headers={'Content-Type': 'text/calendar'})
        admin.req('PUT', f"/api/calendars/{c19['id']}/events/{uid}.ics", {'summary': 't', 'start': start, 'end': start[:11] + '23:59:00.000Z'})
        s, raw = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics")
        got = next((l for l in raw.split('\r\n') if l.startswith('DTSTART;TZID=')), '')
        check(f'{tzid} (its own VTIMEZONE), {start}: stored at its local time', got == f'DTSTART;TZID={tzid}:{want}', got)
        d19.req('DELETE', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics")
# time zone names in their own spelling; a bare offset is no time zone
admin.req('PATCH', '/api/me', {'timezone': 'europe/berlin'})
check('a time zone is stored in its own spelling', admin.req('GET', '/api/me')[1].get('timezone') == 'Europe/Berlin')
s, _ = admin.req('PATCH', '/api/me', {'timezone': '+05:30'})
check('a bare offset is refused', s == 400, s)
admin.req('PATCH', '/api/me', {'timezone': me19.get('timezone')})
# contacts: a chosen display name stays, one number as home and as work stays twice, several given names stay
s, cbook = admin.req('POST', '/api/addressbooks', {'name': 'e2e 1.19 contacts'})
vc = ('BEGIN:VCARD\r\nVERSION:3.0\r\nUID:e2e-fn-119\r\nFN:Dr. Anna Maria Meier\r\nN:Meier;Anna,Maria;;Dr.;\r\n'
      'TEL;TYPE=HOME:+1 555 0100\r\nTEL;TYPE=WORK:+1 555 0100\r\nEMAIL;TYPE=HOME:anna@example.com\r\nEMAIL;TYPE=WORK:anna@example.com\r\nEND:VCARD\r\n')
s, _ = d19.req('PUT', f"/dav/addressbooks/{ADMIN}/{cbook['uri']}/e2e-fn-119.vcf", vc, headers={'Content-Type': 'text/vcard'})
s, cts = admin.req('GET', f"/api/addressbooks/{cbook['id']}/contacts")
anna2 = next((c for c in cts if c.get('uid') == 'e2e-fn-119'), None)
if anna2:
    body = {k: anna2.get(k) for k in ('givenName', 'familyName', 'emails', 'phones', 'org', 'title', 'address')}
    s, _ = admin.req('PUT', f"/api/addressbooks/{cbook['id']}/contacts/{anna2['uri']}", {**body, 'note': 'only the note changed'})
    s, raw = d19.req('GET', f"/dav/addressbooks/{ADMIN}/{cbook['uri']}/{anna2['uri']}")
    check('a chosen display name stays when the app sends none', 'FN:Dr. Anna Maria Meier' in raw, raw)
    check('one number as home and as work stays twice', raw.count('+1 555 0100') == 2 and raw.count('anna@example.com') == 2, raw)
    check('several given names stay as they were', 'Anna,Maria' in raw, raw)
    s, _ = admin.req('PUT', f"/api/addressbooks/{cbook['id']}/contacts/{anna2['uri']}", {**body, 'familyName': 'Muster'})
    s, raw = d19.req('GET', f"/dav/addressbooks/{ADMIN}/{cbook['uri']}/{anna2['uri']}")
    check('a new family name keeps the given names and rebuilds the display name', 'N:Muster;Anna,Maria;' in raw and 'FN:Anna Maria Muster\r\n' in raw, raw)
else:
    check('contact stored over CardDAV is listed', False, cts)
# vCard 2.1 import: a folded photo keeps its data (the folding spaces went into it)
photo = base64.b64encode(bytes(range(256)) * 3).decode()
folded = '\r\n '.join(photo[i:i + 60] for i in range(0, len(photo), 60))
v21p = f'BEGIN:VCARD\r\nVERSION:2.1\r\nN:Photo;Paula\r\nFN:Paula Photo\r\nPHOTO;ENCODING=BASE64;TYPE=JPEG:{folded}\r\n\r\nEND:VCARD\r\n'
s, r = admin.req('POST', f"/api/addressbooks/{cbook['id']}/import", v21p.encode(), headers=oct_h)
s, cts = admin.req('GET', f"/api/addressbooks/{cbook['id']}/contacts")
paula = next((c for c in cts if 'Paula' in (c.get('fn') or '')), None)
s, raw = d19.req('GET', f"/dav/addressbooks/{ADMIN}/{cbook['uri']}/{paula['uri']}") if paula else (0, '')
unfolded = re.sub(r'\r\n[ \t]', '', raw)
m = re.search(r'PHOTO[^:]*:([^\r\n]*)', unfolded)
check('a vCard 2.1 photo is stored without the folding spaces', bool(m) and ' ' not in m.group(1) and base64.b64decode(m.group(1)) == bytes(range(256)) * 3, (s, unfolded[:300]))
admin.req('DELETE', f"/api/addressbooks/{cbook['id']}")
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
# calendars and address books do not offer COPY or MOVE (they refuse them)
s, _, hd = d19.req('OPTIONS', f'/dav/calendars/{ADMIN}/', raw=True)
check('calendars do not advertise MOVE or COPY', s == 200 and 'MOVE' not in hd.get('Allow', '') and 'PROPFIND' in hd.get('Allow', ''), hd.get('Allow'))
s, _, hd = d19.req('OPTIONS', f'/dav/files/{ADMIN}/', raw=True)
check('files still do', 'MOVE' in hd.get('Allow', ''), hd.get('Allow'))
admin.req('DELETE', f'/api/nodes/{F19}')

print('== 1.19.1')
import urllib.parse
# Invitations to single meetings of a series kept elsewhere: an object holding changed occurrences only (one UID, no
# series of its own). Each is listed under its own address, and an edit or delete reaches that meeting only (saving
# one answered "Not an event").
uid = 'e2e-invited-' + uuid.uuid4().hex[:8]
occ = lambda u, day, title: (f'BEGIN:VEVENT\r\nUID:{u}\r\nRECURRENCE-ID:2027{day}T150000Z\r\nDTSTAMP:20270101T000000Z\r\n'
                             f'DTSTART:2027{day}T150000Z\r\nDTEND:2027{day}T160000Z\r\nSUMMARY:{title}\r\nEND:VEVENT\r\n')
cal = lambda body: f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//e2e//EN\r\n{body}END:VCALENDAR\r\n'
d19.req('PUT', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics", cal(occ(uid, '1104', 'Board (Nov)') + occ(uid, '1202', 'Board (Dec)')),
        headers={'Content-Type': 'text/calendar'})
evs = lambda: [e for e in admin.req('GET', f"/api/calendars/{c19['id']}/events?start=2027-11-01T00:00:00Z&end=2028-01-01T00:00:00Z")[1] if e['uid'] == uid]
at = lambda u: f"/api/calendars/{c19['id']}/events/{urllib.parse.quote(u, safe='')}"
listed = evs()
check('each invited meeting has its own address', sorted(e['uri'] for e in listed) == [f'{uid}.ics#20271104T150000Z', f'{uid}.ics#20271202T150000Z'],
      [e['uri'] for e in listed])
nov = next((e for e in listed if e['summary'] == 'Board (Nov)'), {})
dec = next((e for e in listed if e['summary'] == 'Board (Dec)'), {})
s, _ = admin.req('PUT', at(dec.get('uri', '')), {'summary': 'Board (Dec) moved', 'start': '2027-12-02T16:00:00.000Z', 'end': '2027-12-02T17:00:00.000Z',
                                                  'allDay': False, 'location': '', 'description': '', 'rrule': ''})
moved = next((e for e in evs() if e['uri'] == dec.get('uri')), {})
_, raw = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics")
blocks = [b.split('END:VEVENT')[0] for b in raw.split('BEGIN:VEVENT')[1:]]
nov_b = next((b for b in blocks if 'RECURRENCE-ID:20271104T150000Z' in b), '')
check('editing one invited meeting changes that one only', s == 204 and moved.get('summary') == 'Board (Dec) moved'
      and moved.get('start') == '2027-12-02T16:00:00.000Z' and len(blocks) == 2 and 'SUMMARY:Board (Nov)' in nov_b
      and 'DTSTART:20271104T150000Z' in nov_b and not any('RRULE' in b for b in blocks), (s, moved, raw))
s, e = admin.req('PUT', at(nov.get('uri', '')), {'summary': 'Board (Nov)', 'start': nov.get('start'), 'end': nov.get('end'), 'allDay': False, 'rrule': 'WEEKLY'})
check('an invited meeting cannot repeat on its own', s == 400 and 'repeat' in (e or {}).get('error', ''), (s, e))
s, _ = admin.req('PUT', at(f'{uid}.ics'), {'summary': 'x', 'start': nov.get('start'), 'end': nov.get('end')})
check('the plain object address of two meetings names neither', s == 404, s)
s, _ = admin.req('DELETE', at(nov.get('uri', '')))
left = evs()
check('deleting one invited meeting keeps the other', s == 204 and [x['summary'] for x in left] == ['Board (Dec) moved'], (s, [x['summary'] for x in left]))
s, _ = admin.req('DELETE', at(left[0]['uri'] if left else f'{uid}.ics#none'))
s2, _ = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid}.ics")
check('deleting the last one removes the calendar object', s == 204 and s2 == 404, (s, s2))
s, _ = admin.req('DELETE', at(f'{uid}.ics#20271104T150000Z'))
check('a meeting that is gone is 404', s == 404, s)
# 1.19.0 listed such a meeting under the object's own address: a meeting alone there is still found by it
uid1 = 'e2e-invited1-' + uuid.uuid4().hex[:8]
d19.req('PUT', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid1}.ics", cal(occ(uid1, '1104', 'Alone')), headers={'Content-Type': 'text/calendar'})
s, _ = admin.req('PUT', at(f'{uid1}.ics'), {'summary': 'Alone renamed', 'start': '2027-11-04T15:00:00.000Z', 'end': '2027-11-04T16:00:00.000Z'})
_, raw1 = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid1}.ics")
check('a meeting alone is still found by the plain address', s == 204 and 'SUMMARY:Alone renamed' in raw1 and 'RECURRENCE-ID:20271104T150000Z' in raw1, (s, raw1))
d19.req('DELETE', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid1}.ics")
# ...but a plain address of two meetings deletes neither (it deleted both)
uid2 = 'e2e-invited2-' + uuid.uuid4().hex[:8]
d19.req('PUT', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid2}.ics", cal(occ(uid2, '1104', 'One') + occ(uid2, '1202', 'Two')), headers={'Content-Type': 'text/calendar'})
s, _ = admin.req('DELETE', at(f'{uid2}.ics'))
s2, raw2 = d19.req('GET', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid2}.ics")
check('a plain address of two meetings deletes neither', s == 404 and s2 == 200 and raw2.count('BEGIN:VEVENT') == 2, (s, s2))
d19.req('DELETE', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid2}.ics")
# Addresses come from the stored RECURRENCE-ID: meetings in a zone the object has no VTIMEZONE for keep theirs when
# another one is edited (adding the zone shifted them), and one that cannot be read hides none of the others.
uid3 = 'e2e-invited3-' + uuid.uuid4().hex[:8]
zoned = lambda day, title: (f'BEGIN:VEVENT\r\nUID:{uid3}\r\nRECURRENCE-ID;TZID=Europe/Berlin:2027{day}T160000\r\nDTSTAMP:20270101T000000Z\r\n'
                            f'DTSTART;TZID=Europe/Berlin:2027{day}T160000\r\nDTEND;TZID=Europe/Berlin:2027{day}T170000\r\nSUMMARY:{title}\r\nEND:VEVENT\r\n')
unreadable = (f'BEGIN:VEVENT\r\nUID:{uid3}\r\nRECURRENCE-ID:notadate\r\nDTSTAMP:20270101T000000Z\r\n'
              f'DTSTART:20271215T150000Z\r\nDTEND:20271215T160000Z\r\nSUMMARY:Unreadable\r\nEND:VEVENT\r\n')
d19.req('PUT', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid3}.ics", cal(unreadable + zoned('1104', 'Zoned Nov') + zoned('1202', 'Zoned Dec')),
        headers={'Content-Type': 'text/calendar'})
mine3 = lambda: {e['summary']: e['uri'] for e in admin.req('GET', f"/api/calendars/{c19['id']}/events?start=2027-11-01T00:00:00Z&end=2028-01-01T00:00:00Z")[1] if e['uid'] == uid3}
before3 = mine3()
check('a meeting that cannot be read hides none of the others', {'Zoned Nov', 'Zoned Dec'} <= set(before3), before3)
s, _ = admin.req('PUT', at(before3.get('Zoned Nov', '')), {'summary': 'Zoned Nov', 'start': '2027-11-04T16:00:00.000Z', 'end': '2027-11-04T17:00:00.000Z',
                                                           'allDay': False, 'location': '', 'description': '', 'rrule': ''})
after3 = mine3()
check("editing one meeting keeps the others' addresses", s == 204 and after3.get('Zoned Dec') == before3.get('Zoned Dec') == f'{uid3}.ics#20271202T160000',
      (s, before3, after3))
s, _ = admin.req('DELETE', at(before3.get('Zoned Dec', '')))
check('...so it still deletes by its address', s == 204 and 'Zoned Dec' not in mine3() and 'Zoned Nov' in mine3(), s)
d19.req('DELETE', f"/dav/calendars/{ADMIN}/{c19['uri']}/{uid3}.ics")

print('== cleanup')
s, _ = admin.req('DELETE', f'/api/admin/users/{bob}')
check('delete user', s == 204)
admin.req('DELETE', f'/api/nodes/{fid}')
admin.req('DELETE', '/api/trash')
s, t = admin.req('GET', '/api/trash')
check('empty trash', t == [])

print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
