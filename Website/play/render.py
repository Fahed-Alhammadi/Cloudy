"""Renders the Google Play graphics in this folder with headless Chrome (macOS path below).
Usage: python3 -I Website/play/render.py
Sources (raw emulator captures, demo account from ios/appstore/seed.py, see ../screenshots/README.md):
  ../screenshots/android/phone/*.png            phone, 1080x2400 (Pixel 7, API 35)
  ../screenshots/android/tablet/7-inch/*.png    7-inch tablet, 1200x1920 (Nexus 7 2013, API 35)
  ../screenshots/android/tablet/10-inch/*.png   10-inch tablet, 2560x1600 (Pixel Tablet, API 35)
  ../screenshots/android/desktop/*.jpg          Android desktop, 2560x1440 (desktop_medium, android-desktop API 34)
  ../screenshots/android/xr/*.jpg               Android XR headset view, 2048x2048 (xr_headset_device, google-xr API 34)
Output (every set: 8 images, the same story):
  phone/NN-name.png           1080x1920 (9:16)   Play "Phone screenshots"
  tablet-7-inch/NN-name.png   1920x1080 (16:9)   Play "7-inch tablet screenshots"
  tablet-10-inch/NN-name.png  1920x1080 (16:9)   Play "10-inch tablet screenshots"
  desktop/NN-name.png         1920x1080 (16:9)   Play "Desktop screenshots"
  xr/NN-name.png              3840x2400 (8:5)    Play "Android XR screenshots" (8:5 is required for XR)
  feature-graphic.png  1024x500           Play "Feature graphic" (also the website's og:image)
  web/NN-name.jpg      540x960            the phone shots for the website's "Cloudy for Android" section
Design: the website's night-sky palette (site.css) and IBM Plex Sans; device frames drawn in CSS."""
import os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
SHOTS = os.path.join(SITE, 'screenshots', 'android')
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

# (file, kicker, headline, subline); the same story on phone and tablet
SCREENS = [
    ('files', 'Files', 'Your own cloud, in your pocket', 'Every file on the server you run, not on someone else’s'),
    ('grid', 'Photos', 'See your photos at a glance', 'Browse folders as a grid with thumbnails'),
    ('photos', 'Photo backup', 'New photos back up by themselves', 'Straight to your server, on Wi‑Fi only if you like'),
    ('sharing', 'Sharing', 'Share with people or with a link', 'Passwords and expiry dates keep links private'),
    ('calendar', 'Calendar', 'Your calendar on every device', 'Synced with the web app and CalDAV'),
    ('contacts', 'Contacts', 'All your contacts in one place', 'Import .vcf or .csv files, export any time'),
    ('preview', 'Editor', 'Jot it down, wherever you are', 'Open and edit text and Markdown files'),
    ('dark', 'Dark theme', 'Easy on the eyes at night', 'Light and dark follow your device’s setting'),
]

FONTS = f'''
@font-face {{ font-family: Plex; font-weight: 400; src: url("file://{SITE}/assets/fonts/ibm-plex-sans-latin-400-normal.woff2"); }}
@font-face {{ font-family: Plex; font-weight: 600; src: url("file://{SITE}/assets/fonts/ibm-plex-sans-latin-600-normal.woff2"); }}'''

# The logo's cloud (Website/logo.svg geometry), used large and faint behind the devices.
CLOUD = ('<svg viewBox="200 320 660 420" class="cloud" aria-hidden="true"><path fill="#fff" d="M214.63,572.62a108.13,108.13 0 1,1 '
         '216.27,0a108.13,108.13 0 1,1 -216.27,0ZM309.25,491.52a162.2,162.2 0 1,1 324.4,0a162.2,162.2 0 1,1 -324.4,0ZM491.72,'
         '518.55a141.93,141.93 0 1,1 283.85,0a141.93,141.93 0 1,1 -283.85,0ZM660.68,586.14a94.62,94.62 0 1,1 189.24,0a94.62,94.62 '
         '0 1,1 -189.24,0ZM288.97,545.59H775.58a74.34,74.34 0 0,1 74.34,74.34V619.93a74.34,74.34 0 0,1 -74.34,74.34H288.97a74.34,'
         '74.34 0 0,1 -74.34,-74.34V619.93a74.34,74.34 0 0,1 74.34,-74.34Z"/></svg>')

# A few fixed "stars" (x%, y%, size px, opacity) for the night sky.
STARS = [(8, 6, 4, .55), (22, 14, 3, .35), (37, 4, 3, .5), (63, 9, 4, .4), (78, 3, 3, .55), (91, 12, 5, .45), (14, 27, 3, .3),
         (86, 31, 3, .35), (52, 18, 2, .4), (70, 22, 3, .3), (4, 44, 3, .25), (96, 48, 3, .3)]

CSS = FONTS + '''
* { margin: 0; box-sizing: border-box; }
html, body { width: %(w)dpx; height: %(h)dpx; overflow: hidden; }
body { position: relative; font-family: Plex, system-ui, sans-serif; color: #fff; -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(60%% 45%% at %(gx)s 18%%, rgba(77,163,255,.42), transparent 70%%),
    radial-gradient(70%% 50%% at 50%% 105%%, rgba(77,163,255,.55), transparent 70%%),
    linear-gradient(180deg, #041f4d 0%%, #062b66 38%%, #0a4fb5 100%%); }
.star { position: absolute; border-radius: 50%%; background: #fff; }
.cloud { position: absolute; opacity: .07; filter: blur(2px); }
.kicker { display: inline-flex; align-items: center; gap: .5em; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
  color: #9fd0ff; }
.kicker::before { content: ""; width: 1.6em; border-top: .14em solid #4da3ff; }
h1 { font-weight: 600; letter-spacing: -.025em; line-height: 1.06; text-wrap: balance; }
p { color: #c9daf3; line-height: 1.35; text-wrap: balance; }
.device { position: absolute; background: #0d1a33; box-shadow: 0 0 0 2px rgba(255,255,255,.14), 0 40px 90px rgba(0,8,30,.55),
  0 12px 30px rgba(0,8,30,.35); }
.device img { display: block; width: 100%%; }
.device .cam { position: absolute; left: 50%%; transform: translateX(-50%%); border-radius: 50%%; background: #050b16; }
'''


def page(w, h, body, glow='78%'):
    stars = ''.join(f'<i class="star" style="left:{x}%;top:{y}%;width:{s}px;height:{s}px;opacity:{o}"></i>' for x, y, s, o in STARS)
    return f'<!doctype html><meta charset="utf-8"><style>{CSS % {"w": w, "h": h, "gx": glow}}</style>{stars}{body}'


def phone(src, left, top, width, extra=''):
    """A Pixel-style frame around a 1080x2400 capture; width = outer frame width in px."""
    pad = round(width * 0.024)
    return (f'<div class="device" style="left:{left}px;top:{top}px;width:{width}px;padding:{pad}px;border-radius:{round(width * .1)}px;{extra}">'
            f'<img src="file://{src}" style="border-radius:{round(width * .078)}px">'
            f'<i class="cam" style="top:{pad + round(width * .03)}px;width:{round(width * .032)}px;height:{round(width * .032)}px"></i></div>')


def tablet(src, left, top, width, extra=''):
    """A tablet frame around a 1200x1920 capture."""
    pad = round(width * 0.05)
    return (f'<div class="device" style="left:{left}px;top:{top}px;width:{width}px;padding:{pad}px;border-radius:{round(width * .07)}px;{extra}">'
            f'<img src="file://{src}" style="border-radius:{round(width * .018)}px">'
            f'<i class="cam" style="top:{round(pad / 2) - 4}px;width:9px;height:9px"></i></div>')


def phone_shot(i, name, kicker, title, sub):
    glow = '82%' if i % 2 else '18%'
    return page(1080, 1920, f'''
{CLOUD.replace('class="cloud"', 'class="cloud" style="left:-80px;top:880px;width:1240px"')}
<div style="position:absolute;left:80px;right:80px;top:118px;text-align:center">
  <div class="kicker" style="font-size:30px">{kicker}</div>
  <h1 style="font-size:86px;margin-top:26px">{title}</h1>
  <p style="font-size:40px;margin-top:24px">{sub}</p>
</div>
{phone(os.path.join(SHOTS, 'phone', name + '.png'), 200, 600, 680)}''', glow)


def tablet_shot(i, name, kicker, title, sub):
    glow = '30%' if i % 2 else '70%'
    return page(1920, 1080, f'''
{CLOUD.replace('class="cloud"', 'class="cloud" style="left:960px;top:420px;width:1100px"')}
<div style="position:absolute;left:130px;top:0;bottom:0;width:840px;display:flex;flex-direction:column;justify-content:center">
  <div class="kicker" style="font-size:28px">{kicker}</div>
  <h1 style="font-size:88px;margin-top:26px">{title}</h1>
  <p style="font-size:40px;margin-top:26px;max-width:22ch">{sub}</p>
</div>
{tablet(os.path.join(SHOTS, 'tablet', '7-inch', name + '.png'), 1060, 96, 740)}''', glow)


def wide_device(kind, src, width):
    """Landscape devices for the 16:9 sets: a 10-inch tablet (2560x1600 capture), a monitor (2560x1440 Android desktop
    capture) or an Android XR headset view (square capture, cropped to 16:9 around the app panel)."""
    if kind == 'tablet10':
        pad = round(width * 0.04)
        return (f'<div class="device" style="position:relative;width:{width}px;padding:{pad}px;border-radius:{round(width * .05)}px">'
                f'<img src="file://{src}" style="border-radius:{round(width * .012)}px">'
                f'<i class="cam" style="top:{round(pad / 2) - 5}px;width:10px;height:10px"></i></div>')
    if kind == 'monitor':
        pad = round(width * 0.014)
        return (f'<div style="position:relative;width:{width}px">'
                f'<div class="device" style="position:relative;padding:{pad}px;border-radius:{round(width * .018)}px">'
                f'<img src="file://{src}" style="border-radius:{round(width * .006)}px"></div>'
                f'<div style="width:{round(width * .16)}px;height:{round(width * .07)}px;margin:0 auto;background:linear-gradient(#1b2b4a,#0d1a33)"></div>'
                f'<div style="width:{round(width * .3)}px;height:{round(width * .014)}px;margin:0 auto;border-radius:6px 6px 2px 2px;background:#0d1a33;'
                f'box-shadow:0 18px 40px rgba(0,8,30,.5)"></div></div>')
    # xr: the headset's view through a soft visor-like frame
    h = round(width * 5 / 8)
    return (f'<div class="device" style="position:relative;width:{width}px;height:{h}px;padding:0;overflow:hidden;border-radius:{round(width * .06)}px;'
            f'box-shadow:0 0 0 {round(width * .012)}px rgba(13,26,51,.9),0 40px 90px rgba(0,8,30,.55)">'
            f'<img src="file://{src}" style="width:100%;height:100%;object-fit:cover;object-position:50% 58%"></div>')


# Canvas per form factor: (width, height, scale). Android XR wants 8:5 (Play Console help, "Add preview assets"),
# rendered at 2x = 3840x2400; the others 16:9.
CANVAS = {'tablet-10-inch': (1920, 1080, 1), 'desktop': (1920, 1080, 1), 'xr': (1920, 1200, 2)}

WIDE = {  # form factor -> (device kind, capture folder, extension, first headline)
    'tablet-10-inch': ('tablet10', os.path.join('tablet', '10-inch'), 'png', None),
    'desktop': ('monitor', 'desktop', 'jpg', 'Your own cloud, on the big screen'),
    'xr': ('xr', 'xr', 'jpg', 'Your own cloud, all around you'),
}


def wide_shot(form, i, name, kicker, title, sub):
    kind, folder, ext, first = WIDE[form]
    if i == 0 and first:
        title = first
    glow = '30%' if i % 2 else '70%'
    dev_w = {'tablet10': 1200, 'monitor': 1180, 'xr': 1200}[kind]
    w, h, _ = CANVAS[form]
    return page(w, h, f'''
{CLOUD.replace('class="cloud"', 'class="cloud" style="left:900px;top:440px;width:1100px"')}
<div style="position:absolute;left:110px;top:0;bottom:0;width:{1920 - dev_w - 110 - 150}px;display:flex;flex-direction:column;justify-content:center">
  <div class="kicker" style="font-size:24px">{kicker}</div>
  <h1 style="font-size:66px;margin-top:22px">{title}</h1>
  <p style="font-size:32px;margin-top:22px">{sub}</p>
</div>
<div style="position:absolute;right:90px;top:0;bottom:0;display:flex;align-items:center">
{wide_device(kind, os.path.join(SHOTS, folder, name + '.' + ext), dev_w)}
</div>''', glow)


FEATURE = page(1024, 500, f'''
{CLOUD.replace('class="cloud"', 'class="cloud" style="left:520px;top:180px;width:620px;opacity:.08"')}
<div style="position:absolute;left:64px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center">
  <div style="display:flex;align-items:center;gap:20px">
    <img src="file://{SITE}/logo.svg" width="92" height="92" style="border-radius:22px;box-shadow:0 10px 30px rgba(0,8,30,.45)">
    <div style="font-size:76px;font-weight:600;letter-spacing:-.03em">Cloudy</div>
  </div>
  <h1 style="font-size:36px;margin-top:28px;line-height:1.2;letter-spacing:-.01em">Your own cloud for files, photos, calendars and contacts</h1>
  <p style="font-size:21px;margin-top:16px;color:#9fd0ff;font-weight:600;letter-spacing:.02em">Self-hosted · Private · Open source</p>
</div>
{tablet(os.path.join(SHOTS, 'tablet', '7-inch', 'grid.png'), 600, 64, 300, 'transform:rotate(-4deg)')}
{phone(os.path.join(SHOTS, 'phone', 'files.png'), 830, 120, 170, 'transform:rotate(5deg);z-index:2')}''', '75%')


def render(html, out, w, h, scale=1):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
        f.write(html)
    subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', f'--force-device-scale-factor={scale}',
                    '--allow-file-access-from-files', '--virtual-time-budget=3000', f'--window-size={w},{h}',
                    f'--screenshot={out}', 'file://' + f.name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.unlink(f.name)


if __name__ == '__main__':
    for d in ('phone', 'tablet-7-inch', *WIDE):
        os.makedirs(os.path.join(HERE, d), exist_ok=True)
    for i, (name, kicker, title, sub) in enumerate(SCREENS):
        n = f'{i + 1:02d}-{name}.png'
        render(phone_shot(i, name, kicker, title, sub), os.path.join(HERE, 'phone', n), 1080, 1920)
        render(tablet_shot(i, name, kicker, title, sub), os.path.join(HERE, 'tablet-7-inch', n), 1920, 1080)
        for form in WIDE:
            w, h, scale = CANVAS[form]
            render(wide_shot(form, i, name, kicker, title, sub), os.path.join(HERE, form, n), w, h, scale)
    render(FEATURE, os.path.join(HERE, 'feature-graphic.png'), 1024, 500)
    # Smaller JPEG copies of the phone shots for the website's Android section (web/NN-name.jpg, 540x960).
    os.makedirs(os.path.join(HERE, 'web'), exist_ok=True)
    for i, (name, *_rest) in enumerate(SCREENS):
        n = f'{i + 1:02d}-{name}'
        subprocess.run(['sips', '-Z', '960', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', os.path.join(HERE, 'phone', n + '.png'),
                        '--out', os.path.join(HERE, 'web', n + '.jpg')], check=True, stdout=subprocess.DEVNULL)
    print('rendered')
