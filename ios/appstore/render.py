"""Renders the App Store screenshots (6.9" iPhone, 1320x2868) and the optional creative assets (product page header,
search results) with headless Chrome (macOS path below).
Usage: python3 -I ios/appstore/render.py — sources: raw/*.png, simulator captures from a demo account (see README.md).
Output: en-US/iphone-6.9/ and en-US/iphone-6.3/<n>-<name>.png (screenshots) and en-US/creative-*.png, opaque PNGs ready to
upload in App Store Connect."""
import os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
ICON = os.path.join(HERE, '../Cloudy/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png')
W, H = 1320, 2868  # the screenshot design size (6.9"); other sizes are rendered from it with CSS zoom
# (folder, width, height): App Store Connect's iPhone 6.9" and 6.1"/6.3" screenshot slots.
SIZES = [('iphone-6.9', 1320, 2868), ('iphone-6.3', 1206, 2622)]

SHOTS = [  # (output, source, title, subtitle)
    ('1-files', 'files', 'Your own cloud,<br>in your pocket', 'Your files and photos on your own server'),
    ('2-photos', 'photos', 'All your files,<br>at a glance', 'Browse, search, upload and preview anything'),
    ('3-sharing', 'share', 'Share in seconds', 'Links with a password and expiry date, or share with people'),
    ('4-recent', 'recent', 'Pick up where<br>you left off', 'The files you opened or changed lately'),
    ('5-shared', 'shared', 'Everything<br>shared with you', 'Folders and files from family and colleagues'),
    ('6-editor', 'editor', 'Edit on the go', 'Open and edit notes and text files anywhere'),
    ('7-more', 'more', 'Everything<br>in one place', 'Favorites, shared files, trash and settings'),
]

PAGE = '''<!doctype html><meta charset="utf-8"><style>
* {{ margin: 0; box-sizing: border-box; }}
html {{ zoom: {Z}; }}
html, body {{ width: {W}px; height: {H}px; overflow: hidden; }}
body {{ font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; color: #fff; text-align: center;
       background: linear-gradient(165deg, #0B6BCB 0%, #2952B7 100%); }}
.brand {{ display: flex; align-items: center; justify-content: center; gap: 26px; padding-top: 120px; }}
.brand img {{ width: 120px; height: 120px; border-radius: 27px; box-shadow: 0 10px 30px rgba(0,0,0,.25);
              outline: 3px solid rgba(255,255,255,.35); outline-offset: -3px; }}
.brand span {{ font-size: 64px; font-weight: 700; letter-spacing: -1px; }}
h1 {{ font-size: 112px; font-weight: 800; letter-spacing: -2.5px; line-height: 1.04; margin-top: 70px; }}
p {{ font-size: 50px; opacity: .88; margin: 34px 110px 0; line-height: 1.25; }}
.phone {{ position: absolute; left: 50%; bottom: -130px; transform: translateX(-50%); width: 1010px;
          border: 22px solid #0f1d38; border-radius: 120px; overflow: hidden; box-shadow: 0 40px 120px rgba(0,0,0,.4);
          background: #0f1d38; }}
.phone img {{ display: block; width: 100%; border-radius: 98px; }}
</style>
<div class="brand"><img src="file://{icon}"><span>Cloudy</span></div>
<h1>{title}</h1>
<p>{sub}</p>
<div class="phone"><img src="file://{shot}"></div>'''


# Creative assets (https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications):
# 16:9 5244x2950 fits both the product page header and search results; 21:9 is header-only, 3:2 search-only.
CREATIVE = [('creative-16x9-header-and-search', 5244, 2950), ('creative-21x9-header', 3840, 1646),
            ('creative-3x2-search', 3840, 2560)]

# Sized in --u = min(1vh, 0.4vw), so the same layout fits 21:9, 16:9 and 3:2 without text and phones overlapping.
BANNER = '''<!doctype html><meta charset="utf-8"><style>
* {{ margin: 0; box-sizing: border-box; }}
html, body {{ width: {w}px; height: {h}px; overflow: hidden; }}
body {{ --u: min(1vh, .4vw); font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; color: #fff;
       background: linear-gradient(160deg, #0B6BCB 0%, #2952B7 100%); }}
.text {{ position: absolute; left: 7vw; top: 50%; transform: translateY(-55%); width: 38vw; }}
.brand {{ display: flex; align-items: center; gap: calc(var(--u) * 2.6); }}
.brand img {{ width: calc(var(--u) * 13); height: calc(var(--u) * 13); border-radius: calc(var(--u) * 2.9);
              box-shadow: 0 calc(var(--u) * 1) calc(var(--u) * 3) rgba(0,0,0,.25); }}
.brand span {{ font-size: calc(var(--u) * 7.5); font-weight: 700; }}
h1 {{ font-size: calc(var(--u) * 10.5); font-weight: 800; letter-spacing: calc(var(--u) * -.25); line-height: 1.05;
      margin-top: calc(var(--u) * 5); }}
p {{ font-size: calc(var(--u) * 4.4); opacity: .88; margin-top: calc(var(--u) * 3); line-height: 1.3; }}
.phone {{ position: absolute; left: 71vw; top: calc(50vh - var(--u) * 38); height: calc(var(--u) * 100);
          aspect-ratio: 1320 / 2868; border: calc(var(--u) * 1.4) solid #0f1d38; border-radius: calc(var(--u) * 7.5);
          overflow: hidden; background: #0f1d38; box-shadow: 0 calc(var(--u) * 3) calc(var(--u) * 8) rgba(0,0,0,.4); }}
.phone img {{ display: block; width: 100%; border-radius: calc(var(--u) * 6.1); }}
.back {{ top: calc(50vh - var(--u) * 31); height: calc(var(--u) * 92); }}
.l {{ transform: translateX(-138%) rotate(-5deg); }}
.c {{ transform: translateX(-50%); z-index: 2; }}
.r {{ transform: translateX(38%) rotate(5deg); }}
</style>
<div class="text">
  <div class="brand"><img src="file://{icon}"><span>Cloudy</span></div>
  <h1>Your own cloud,<br>in your pocket</h1>
  <p>Your files, photos and sharing on the server you choose. No ads, no tracking.</p>
</div>
<div class="phone back l"><img src="file://{raw}/recent.png"></div>
<div class="phone back r"><img src="file://{raw}/share.png"></div>
<div class="phone c"><img src="file://{raw}/files.png"></div>'''


def render(html, out, w=W, h=H):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
        f.write(html)
    png = out + '.tmp.png'
    subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--allow-file-access-from-files', f'--window-size={w},{h}', f'--screenshot={png}', 'file://' + f.name],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.unlink(f.name)
    # App Store Connect rejects images with an alpha channel: round-trip through JPEG to drop it.
    jpg = out + '.tmp.jpg'
    subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '100', png, '--out', jpg], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['sips', '-s', 'format', 'png', jpg, '--out', out], check=True, stdout=subprocess.DEVNULL)
    os.unlink(png)
    os.unlink(jpg)


for folder, w, h in SIZES:
    os.makedirs(os.path.join(HERE, 'en-US', folder), exist_ok=True)
    z = w / W
    for name, src, title, sub in SHOTS:
        html = PAGE.format(W=W, H=h / z, Z=z, icon=ICON, shot=os.path.join(HERE, 'raw', src + '.png'), title=title, sub=sub)
        render(html, os.path.join(HERE, 'en-US', folder, name + '.png'), w, h)
for name, w, h in CREATIVE:
    render(BANNER.format(w=w, h=h, icon=ICON, raw=os.path.join(HERE, 'raw')), os.path.join(HERE, 'en-US', name + '.png'), w, h)
print('rendered', len(SHOTS), 'screenshots ×', len(SIZES), 'sizes and', len(CREATIVE), 'creative assets')
