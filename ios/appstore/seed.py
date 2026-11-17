"""Fills a fresh, throwaway Cloudy server with the fictional demo account used for the App Store captures (README.md).
Usage: python3 -I ios/appstore/seed.py <server url> <admin password> [<database url>]
Creates user `sarah` (password printed at the end) with folders, files, photos, shares, two calendars around today and
an address book, then backdates file dates in the database (if given) so lists show varied dates instead of "today".
Prints the device token and the CLOUDY_OPEN / CLOUDY_TOUR values. Photos are drawn with headless Chrome (render.py's path).
Never run it against a real server."""
import base64, datetime as dt, json, os, random, subprocess, sys, tempfile, urllib.error, urllib.request, uuid

BASE, ADMIN_PW = sys.argv[1].rstrip('/'), sys.argv[2]
DB = sys.argv[3] if len(sys.argv) > 3 else None
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
USER, PW, NAME = 'sarah', 'demo-' + uuid.uuid4().hex[:10], 'Sarah Collins'
random.seed(7)


def req(method, path, body=None, auth=None, headers=None, cookie=None):
    h = {'X-Cloudy-Request': '1', **(headers or {})}
    if isinstance(body, (dict, list)):
        body, h['Content-Type'] = json.dumps(body).encode(), 'application/json'
    elif isinstance(body, str):
        body = body.encode()
    if auth: h['Authorization'] = 'Basic ' + base64.b64encode(auth.encode()).decode()
    if cookie: h['Cookie'] = cookie
    r = urllib.request.Request(BASE + path, data=body, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path}: {e.code} {e.read()[:200]!r}')
    data = resp.read()
    return json.loads(data) if data and 'json' in (resp.headers.get('content-type') or '') else resp


def session(user, pw):
    r = urllib.request.Request(BASE + '/api/login', data=json.dumps({'user': user, 'password': pw}).encode(), method='POST',
                               headers={'X-Cloudy-Request': '1', 'Content-Type': 'application/json'})
    return urllib.request.urlopen(r).headers['Set-Cookie'].split(';')[0]


admin = session('admin', ADMIN_PW)
# 50 GB as iOS shows it (decimal); for Android captures set 53687091200 (Android shows binary units).
for uid, name in [(USER, NAME), ('daniel', 'Daniel Okafor'), ('elena', 'Elena Rossi')]:
    req('POST', '/api/admin/users', {'id': uid, 'password': PW, 'displayName': name, 'quotaBytes': 50_000_000_000 if uid == USER else None}, cookie=admin)
me = session(USER, PW)
dan = session('daniel', PW)
root = req('GET', '/api/me', cookie=me)['rootId']


# --- photos: simple scenic gradients drawn by Chrome, so the app has real thumbnails --------------------------------
SCENES = {
    'Sunset at the beach': ('#ff9a5a', '#ffcf7a', '#2b6f9e', '#f2d7a6'),
    'Mountain lake': ('#9fd3f2', '#e6f4fb', '#3f7a5a', '#2d5f8a'),
    'Lisbon rooftops': ('#7fb8e6', '#d9eefb', '#c8693f', '#e9b07a'),
    'Morning fog': ('#c9d6df', '#eef2f5', '#6c8a7b', '#9fb3a9'),
    'City lights': ('#1b2a4a', '#4b3d7a', '#f2b84b', '#2a2340'),
    'Desert road': ('#f5b46b', '#fde2b8', '#b5653a', '#8a4b2f'),
    'Forest trail': ('#a8d5a2', '#e8f5e1', '#2f6b3a', '#5a8f4e'),
    'Snowy peaks': ('#8cb9e8', '#f0f6fc', '#e9eef3', '#7d93ab'),
}


def photos():
    out = tempfile.mkdtemp()
    for name, (sky1, sky2, land, accent) in SCENES.items():
        hills = ''.join(f'<path d="M0 {600 + i * 60} Q 300 {480 + i * 70 + random.randint(-60, 60)} 600 {560 + i * 60} T 1200 {520 + i * 70} V 900 H 0 Z" '
                        f'fill="{land if i % 2 else accent}" opacity="{0.55 + i * 0.15}"/>' for i in range(3))
        sun = f'<circle cx="{random.randint(250, 950)}" cy="{random.randint(200, 380)}" r="{random.randint(60, 110)}" fill="#fff8e7" opacity=".85"/>'
        html = (f'<html><body style="margin:0"><svg width="1200" height="900" xmlns="http://www.w3.org/2000/svg">'
                f'<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{sky1}"/>'
                f'<stop offset="1" stop-color="{sky2}"/></linearGradient></defs><rect width="1200" height="900" fill="url(#s)"/>{sun}{hills}</svg></body></html>')
        page = os.path.join(out, 'p.html')
        open(page, 'w').write(html)
        png = os.path.join(out, name + '.png')
        subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,900',
                        f'--screenshot={png}', 'file://' + page], capture_output=True, check=True)
        jpg = os.path.join(out, name + '.jpg')
        subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', png, '--out', jpg], capture_output=True, check=True)
        yield name + '.jpg', open(jpg, 'rb').read()


# --- files -------------------------------------------------------------------------------------------------------------
def folder(parent, name):
    return req('POST', f'/api/nodes/{parent}/folders', {'name': name}, cookie=me)['id']


def upload(parent, name, data):
    up = req('POST', '/api/uploads', {'parentId': parent, 'name': name, 'size': len(data)}, cookie=me)
    r = req('PUT', f"/api/uploads/{up['id']}", data, cookie=me, headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})
    return r['node']['id']


def blob(size):  # files the app only lists: right type and size, no need for real content
    return os.urandom(size)


def text(parent, name, content):
    return req('POST', f'/api/nodes/{parent}/files', {'name': name, 'content': content}, cookie=me)['id']


PLANNING = """# Weekly planning

## This week
- Finish the website redesign review
- Send the Q4 budget to Daniel
- Book flights for the Lisbon trip

## Ideas
- Move the team photos to the shared folder
- Try the new document scanner for receipts

## Shopping
- Coffee beans
- Olive oil
- Fresh basil
"""

days = {}  # node id → days ago (for backdating)
docs, inv, pics, proj, travel = (folder(root, n) for n in ['Documents', 'Invoices', 'Photos', 'Projects', 'Travel'])
days.update({docs: 26, inv: 22, pics: 30, proj: 19, travel: 27})
brand, web = folder(proj, 'Brand assets'), folder(proj, 'Website redesign')
days.update({brand: 22, web: 9})
for name, size, ago in [('Brand guidelines.pdf', 4_800_000, 13), ('Kickoff deck.pptx', 8_300_000, 11), ('Launch video.mp4', 24_500_000, 11),
                        ('Product specs.docx', 410_000, 34), ('Roadmap Q4.xlsx', 220_000, 37)]:
    days[upload(proj, name, blob(size))] = ago
days[text(proj, 'Meeting notes.txt', 'Kickoff with Elena and Daniel\n- Scope agreed\n- Next review on Friday\n')] = 31
plan = text(root, 'Weekly planning.md', PLANNING)
days[plan] = 1
for name, size, ago in [('Budget 2026.xlsx', 184_000, 30), ('Family recipes.docx', 96_000, 37), ('Lisbon itinerary.pdf', 1_200_000, 6)]:
    days[upload(root, name, blob(size))] = ago
for name, size, ago in [('Lease agreement.pdf', 2_100_000, 80), ('Passport scan.pdf', 640_000, 120), ('Tax return 2025.pdf', 1_500_000, 150)]:
    days[upload(docs, name, blob(size))] = ago
for i, ago in enumerate([3, 18, 33, 48]):
    days[upload(inv, f'Invoice 2026-{10 - i:02d}.pdf', blob(180_000 + i * 9_000))] = ago
for i, (name, data) in enumerate(photos()):
    days[upload(pics, name, data)] = 2 + i * 4
days[upload(travel, 'Boarding pass.pdf', blob(320_000))] = 5
days[upload(travel, 'Hotel booking.pdf', blob(540_000))] = 12
for n in ['Photos', 'Budget 2026.xlsx']:
    nid = next(c['id'] for c in req('GET', f'/api/nodes/{root}', cookie=me)['children'] if c['name'] == n)
    req('POST', f'/api/nodes/{nid}/favorite', cookie=me)

req('POST', f'/api/nodes/{proj}/shares', {'type': 'user', 'shareWith': 'elena', 'canEdit': True}, cookie=me)
req('POST', f'/api/nodes/{travel}/shares', {'type': 'user', 'shareWith': 'daniel'}, cookie=me)
expires = (dt.date.today() + dt.timedelta(days=14)).isoformat()
req('POST', f'/api/nodes/{travel}/shares', {'type': 'link', 'password': 'lisbon26', 'expiresAt': expires, 'label': 'Trip photos'}, cookie=me)
dan_root = req('GET', '/api/me', cookie=dan)['rootId']
team = req('POST', f'/api/nodes/{dan_root}/folders', {'name': 'Team photos'}, cookie=dan)['id']
req('POST', f'/api/nodes/{team}/shares', {'type': 'user', 'shareWith': USER}, cookie=dan)
# More shared with Sarah, so the Shared tab (Android) is not a single row.
ele = session('elena', PW)
ele_root = req('GET', '/api/me', cookie=ele)['rootId']
for cookie, parent, name, edit in [(ele, ele_root, 'Recipes', True), (dan, dan_root, 'Office move 2027', False)]:
    nid = req('POST', f'/api/nodes/{parent}/folders', {'name': name}, cookie=cookie)['id']
    req('POST', f'/api/nodes/{nid}/shares', {'type': 'user', 'shareWith': USER, 'canEdit': edit}, cookie=cookie)
for cookie, parent, name, size in [(ele, ele_root, 'Q4 report.pdf', 1_350_000), (dan, dan_root, 'Budget review.xlsx', 142_000)]:
    up = req('POST', '/api/uploads', {'parentId': parent, 'name': name, 'size': size}, cookie=cookie)
    nid = req('PUT', f"/api/uploads/{up['id']}", blob(size), cookie=cookie, headers={'Upload-Offset': '0', 'Content-Type': 'application/octet-stream'})['node']['id']
    req('POST', f'/api/nodes/{nid}/shares', {'type': 'user', 'shareWith': USER}, cookie=cookie)

# --- calendars: events around today (floating local times) --------------------------------------------------------------
work = req('POST', '/api/calendars', {'name': 'Work', 'color': '#E8772E'}, cookie=me)['uri']
today = dt.date.today()
dav = f'{USER}:{PW}'


def event(cal, day, start, end, title, where='', rrule='', allday=False):
    d = today + dt.timedelta(days=day)
    uid = uuid.uuid4().hex
    if allday:
        when = f'DTSTART;VALUE=DATE:{d:%Y%m%d}\r\nDTEND;VALUE=DATE:{d + dt.timedelta(days=end):%Y%m%d}'
    else:
        when = f'DTSTART:{d:%Y%m%d}T{start}00\r\nDTEND:{d:%Y%m%d}T{end}00'
    ics = (f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Cloudy demo//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20261001T000000Z\r\n'
           f'{when}\r\nSUMMARY:{title}\r\n' + (f'LOCATION:{where}\r\n' if where else '') + (f'RRULE:{rrule}\r\n' if rrule else '')
           + 'END:VEVENT\r\nEND:VCALENDAR\r\n')
    req('PUT', f'/dav/calendars/{USER}/{cal}/{uid}.ics', ics, auth=dav, headers={'Content-Type': 'text/calendar'})


wd = today.weekday()  # events keyed to weekdays so any capture day looks like a normal week
event('personal', 0, '1100', '1230', 'Brunch with Elena', 'Café Lumière')
event('personal', -21, '1730', '1830', 'Yoga class', 'Studio 4', 'FREQ=WEEKLY;COUNT=10')
event('personal', 0, '2000', '2030', 'Plan the week')
event('personal', 2, '1900', '2130', 'Dinner with Sam', 'Olive & Thyme')
event('personal', 5, 0, 4, 'Lisbon trip', allday=True)
event('personal', -9, '0830', '0930', 'Dentist', 'Smile Clinic')
event('personal', 19, 0, 1, 'Amira’s birthday', allday=True)
event('personal', -16, '1800', '1930', 'Book club', 'City Library')
for day, start, end, title, where in [(-26, '1000', '1100', 'Design review', 'Room 2'), (-18, '0900', '1200', 'Quarterly planning', 'Board room'),
                                      (-17, '1230', '1330', 'Lunch with Daniel', 'Noodle Bar'), (-11, '1000', '1030', 'Website launch', ''),
                                      (-9, '1500', '1530', '1:1 with Maya', ''), (-4, '1100', '1200', 'Client call – Northwind', 'Video call'),
                                      (-2, '1400', '1500', 'Budget review', 'Room 1'), (2, '0930', '1030', 'Sprint kickoff', 'Room 2'),
                                      (3, '1300', '1400', 'Brand workshop', 'Studio'), (12, '1000', '1130', 'Board meeting', 'Board room'),
                                      (16, '1500', '1600', 'Website retro', 'Room 2')]:
    event(work, day, start, end, title, where)
event(work, -30, '0915', '0930', 'Team stand-up', 'Video call', 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=40')

# --- contacts ----------------------------------------------------------------------------------------------------------
PEOPLE = [('Amira', 'Haddad', 'Northwind Studio', 'Creative Director'), ('Ben', 'Carter', 'Carter & Sons', 'Owner'),
          ('Chloé', 'Martin', '', ''), ('Daniel', 'Okafor', 'Cloud Nine Labs', 'Finance Lead'), ('Elena', 'Rossi', 'Cloud Nine Labs', 'Designer'),
          ('Farah', 'Nasser', '', ''), ('George', 'Lin', 'Brightside Health', 'Physiotherapist'), ('Hannah', 'Schmidt', '', ''),
          ('Isaac', 'Mensah', 'Northwind Studio', 'Developer'), ('Julia', 'Fernández', '', ''), ('Karim', 'Benali', 'Atlas Travel', 'Agent'),
          ('Lena', 'Novak', '', ''), ('Maya', 'Patel', 'Cloud Nine Labs', 'Product Manager'), ('Noah', 'Williams', '', ''),
          ('Olivia', 'Brown', 'Greenleaf School', 'Teacher'), ('Sam', 'Taylor', '', ''), ('Yusuf', 'Kaya', 'Kaya Garage', 'Mechanic')]
book = req('GET', '/api/addressbooks', cookie=me)[0]['uri']
for i, (first, last, org, title) in enumerate(PEOPLE):
    uid = uuid.uuid4().hex
    mail = f'{first.lower().replace("é", "e")}.{last.lower().replace("á", "a")}@example.com'
    v = (f'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{first} {last}\r\nN:{last};{first};;;\r\nEMAIL;TYPE=WORK:{mail}\r\n'
         f'TEL;TYPE=CELL:+1 555 01{i:02d} {random.randint(100, 999)}\r\n' + (f'ORG:{org}\r\nTITLE:{title}\r\n' if org else ''))
    if first == 'Amira':
        v += ('TEL;TYPE=WORK:+1 555 0188 210\r\nADR;TYPE=WORK:;;12 Harbour Street;Portland;OR;97201;USA\r\n'
              'BDAY:1990-' + (today + dt.timedelta(days=19)).strftime('%m-%d') + '\r\nURL:https://northwind.example.com\r\n'
              'NOTE:Met at the design conference. Prefers calls in the morning.\r\n')
    req('PUT', f'/dav/addressbooks/{USER}/{book}/{uid}.vcf', v + 'END:VCARD\r\n', auth=dav, headers={'Content-Type': 'text/vcard'})

# --- backdate file dates, so lists show a realistic history ------------------------------------------------------------
if DB:
    sql = ';'.join(f"UPDATE nodes SET mtime = now() - interval '{d} days' - interval '{random.randint(1, 600)} minutes' WHERE id = {n}"
                   for n, d in days.items())
    subprocess.run(['psql', DB, '-qc', sql], check=True)

token = req('POST', '/api/auth/token', {'user': USER, 'password': PW, 'deviceName': 'iPhone'})['token']
print(json.dumps({'user': USER, 'password': PW, 'token': token, 'projects': proj, 'planning': plan,
                  'open_folder': f'folder:{proj}:Projects', 'open_text': f'text:{plan}:Weekly planning.md',
                  'open_share': f'share:{travel}:Travel', 'contact': 'Amira Haddad',
                  'tour': f'{proj}:Projects:{plan}:Weekly planning.md:Amira Haddad'}, indent=1))
