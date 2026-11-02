"""Renders the Google Play graphics in this folder with headless Chrome (macOS path below).
Usage: python3 -I docs/play/render.py   — sources: ../screenshots/*.png (raw 1080x2400 emulator captures)."""
import os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CLOUD = '<path fill="#fff" d="M34.64,57.98a7.04,7.04 0 1,1 14.08,0a7.04,7.04 0 1,1 -14.08,0ZM40.8,52.7a10.56,10.56 0 1,1 21.12,0a10.56,10.56 0 1,1 -21.12,0ZM52.68,54.46a9.24,9.24 0 1,1 18.48,0a9.24,9.24 0 1,1 -18.48,0ZM63.68,58.86a6.16,6.16 0 1,1 12.32,0a6.16,6.16 0 1,1 -12.32,0ZM39.48,56.22H71.16a4.84,4.84 0 0,1 4.84,4.84V61.06a4.84,4.84 0 0,1 -4.84,4.84H39.48a4.84,4.84 0 0,1 -4.84,-4.84V61.06a4.84,4.84 0 0,1 4.84,-4.84Z"/>'
BASE = '''<!doctype html><meta charset="utf-8"><style>
* { margin: 0; box-sizing: border-box; }
html, body { width: %dpx; height: %dpx; overflow: hidden; }
body { font-family: -apple-system, "SF Pro Display", "Segoe UI", Roboto, sans-serif; color: #fff;
       background: linear-gradient(160deg, #0B6BCB 0%%, #2952B7 100%%); }
</style>'''

SHOTS = [  # (output, source, title, subtitle)
    ('1-files', 'files', 'Your files, your server', 'Browse, upload and organise everything you store'),
    ('2-sharing', 'sharing', 'Share in one tap', 'Links with passwords, or share with people'),
    ('3-photos', 'photos', 'Automatic photo backup', 'New photos and videos go to your own cloud'),
    ('4-calendar', 'calendar', 'Your calendar', 'Synced with your Cloudy server'),
    ('5-contacts', 'contacts', 'All your contacts', 'Import from .vcf or .csv, export any time'),
    ('6-editor', 'preview', 'Edit on the go', 'Open and edit text files anywhere'),
    ('7-more', 'more', 'Everything in one place', 'Favorites, shared files, trash and settings'),
]

def shot_html(src, title, sub):
    return BASE % (1080, 1920) + f'''
<div style="text-align:center;padding:110px 60px 0">
  <div style="font-size:76px;font-weight:700;letter-spacing:-1px">{title}</div>
  <div style="font-size:40px;opacity:.85;margin-top:22px">{sub}</div>
</div>
<img src="file://{HERE}/../screenshots/{src}.png" style="position:absolute;left:50%;top:400px;width:630px;
  transform:translateX(-50%);border-radius:48px;border:14px solid #10213f;box-shadow:0 30px 80px rgba(0,0,0,.35)">'''

FEATURE = BASE % (1024, 500) + f'''
<div style="position:absolute;left:70px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;width:560px">
  <div style="display:flex;align-items:center;gap:22px">
    <svg viewBox="18 18 72 72" width="104" height="104" style="background:rgba(255,255,255,.16);border-radius:26px">{CLOUD}</svg>
    <div style="font-size:84px;font-weight:700;letter-spacing:-2px">Cloudy</div>
  </div>
  <div style="font-size:36px;font-weight:600;margin-top:30px;line-height:1.25">Your own cloud for files, photos, calendars and contacts</div>
  <div style="font-size:24px;opacity:.85;margin-top:18px">Self-hosted · Private · No ads</div>
</div>
<img src="file://{HERE}/../screenshots/files.png" style="position:absolute;right:70px;top:46px;width:250px;
  transform:rotate(6deg);border-radius:26px;border:8px solid #10213f;box-shadow:0 20px 50px rgba(0,0,0,.35)">'''

def render(html, out, w, h):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False) as f:
        f.write(html)
    subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--allow-file-access-from-files', f'--window-size={w},{h}', f'--screenshot={out}', 'file://' + f.name],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.unlink(f.name)

for name, src, title, sub in SHOTS:
    render(shot_html(src, title, sub), os.path.join(HERE, f'screenshot-{name}.png'), 1080, 1920)
render(FEATURE, os.path.join(HERE, 'feature-graphic.png'), 1024, 500)
print('rendered')
