Screenshots shown on the GitHub Pages site (`docs/index.html`). The main README shows only `overview.png`.

- Android (1080×2400 emulator captures): `files.png`, `preview.png`, `sharing.png`, `photos.png`, `calendar.png`,
  `contacts.png`, `more.png`. Same demo account as the iPhone (`ios/appstore/seed.py`, quota 53687091200 so Android
  shows 50 GB); `cloud.local` in the emulator via `adb root` + a bind-mounted hosts file (`chcon system_file`); status bar
  via SystemUI demo mode. `docs/play/render.py` turns them into the Google Play screenshots.
- iPhone: `iphone/*.jpg`, scaled from `ios/appstore/raw/` (`sips -Z 1000 -s format jpeg`)
- Desktop: `desktop.png` (the settings window)
- `overview.png` (README): the site's hero (desktop + Android `files.png` + iPhone `iphone/files.jpg`) rendered 1720×1200
  with headless Chrome from `docs/assets/site.css` (`.stage`) on the night-sky background. Re-render it when those change.
