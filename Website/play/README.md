# Google Play graphics

Each folder matches one field of **Play Console → Grow users → Store presence → Main store listing**.
Upload the files in their numbered order. All of them are made by `render.py` from the raw emulator captures in
`../screenshots/android/`.

| Folder | Play Console field | Size | Files |
|---|---|---|---|
| `feature-graphic/` | Feature graphic | 1024 × 500 PNG | 1 |
| `phone-screenshots/` | Phone screenshots | 1080 × 1920 PNG (9:16) | 8 |
| `7-inch-tablet-screenshots/` | 7-inch tablet screenshots | 1920 × 1080 PNG (16:9) | 8 |
| `10-inch-tablet-screenshots/` | 10-inch tablet screenshots | 1920 × 1080 PNG (16:9) | 8 |
| `desktop-screenshots/` | Desktop screenshots (Desktop assets) | 1920 × 1080 PNG (16:9) | 8 |
| `android-xr-screenshots/` | Android XR screenshots | 3840 × 2160 PNG (16:9) | 8 |
| `website/` | *Not for Play.* Smaller copies of the phone set for the website and README | 540 × 960 JPEG | 8 |

Every set tells the same story: 01 Files · 02 Photos grid · 03 Photo backup · 04 Sharing · 05 Recent · 06 Shared ·
07 Editor · 08 Dark theme.

To make them again after the app changes: retake the captures (see `../screenshots/README.md`), then run

```sh
python3 -I Website/play/render.py                         # every set
python3 -I Website/play/render.py phone tablet-7-inch     # only some sets (the feature graphic and website/ always)
```
