# Google Play graphics

This folder holds the tool (`render.py`). The images live in the git-ignored **`Store/Google Play/`** at the repository
root. Each folder there matches one field of **Play Console → Grow users → Store presence → Main store listing**.
Upload the files in their numbered order. All of them are made by `render.py` from the raw emulator captures in
`Store/Google Play/raw/`.

| Folder in `Store/Google Play/` | Play Console field | Size | Files |
|---|---|---|---|
| `feature-graphic/` | Feature graphic | 1024 × 500 PNG | 1 |
| `phone-screenshots/` | Phone screenshots | 1080 × 1920 PNG (9:16) | 8 |
| `7-inch-tablet-screenshots/` | 7-inch tablet screenshots | 1920 × 1080 PNG (16:9) | 8 |
| `10-inch-tablet-screenshots/` | 10-inch tablet screenshots | 1920 × 1080 PNG (16:9) | 8 |
| `desktop-screenshots/` | Desktop screenshots (Desktop assets) | 1920 × 1080 PNG (16:9) | 8 |
| `android-xr-screenshots/` | Android XR screenshots | 3840 × 2160 PNG (16:9) | 8 |
| `raw/{phone,tablet-7-inch,tablet-10-inch,desktop,xr}/` | *Not for Play.* The plain emulator captures (sources) | | 9 each |

Every set tells the same story: 01 Files · 02 Photos grid · 03 Photo backup · 04 Sharing · 05 Recent · 06 Shared ·
07 Editor · 08 Dark theme.

`render.py` also refreshes the website's copies in `Website/screenshots/` (committed): `android/framed/*.jpg`
(540 × 960, the site's Android band + README), `feature-graphic.png` (the site's og:image), `android/phone/*.png` and
the four `android/tablet-7-inch/` captures the site's gallery shows.

To make them again after the app changes: retake the captures into `Store/Google Play/raw/` (see
`Website/screenshots/README.md`), then run

```sh
python3 -I android/playstore/render.py                         # every set
python3 -I android/playstore/render.py phone tablet-7-inch     # only some sets (the feature graphic and website copies always)
```
