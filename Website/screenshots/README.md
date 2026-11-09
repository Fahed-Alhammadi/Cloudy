Screenshots shown on the GitHub Pages site (`Website/index.html`). The main README shows `overview.png` and four of
the Google Play images (`../play/web/`).

```
screenshots/
├── overview.png        README picture: desktop + Android phone + iPhone together
├── android/
│   ├── phone/          1080×2400 PNG, Pixel 7 emulator, API 35
│   ├── tablet/
│   │   ├── 7-inch/     1200×1920 PNG, "Nexus 7 2013" emulator, API 35
│   │   └── 10-inch/    2560×1600 PNG, "pixel_tablet" emulator, API 35 (landscape)
│   ├── desktop/        2560×1440 JPEG, "desktop_medium" + android-desktop image API 34 (3840×2160 scaled),
│   │                   the app in a resized window (`adb shell am task resize <task> 560 200 3280 1880`)
│   └── xr/             2048×2048 JPEG, "xr_headset_device" + google-xr image API 34: the headset view
├── ios/                iPhone, 460×1000 JPEG
└── desktop/            Cloudy's own Mac/Windows/Linux app (settings window), not Android
```

- **Android** (every folder under `android/` uses the same file names): `files.png`, `grid.png` (Photos folder as a
  grid), `preview.png` (text editor), `sharing.png`, `photos.png` (Photo backup), `calendar.png`, `contacts.png`,
  `more.png`, `dark.png` (Files in the dark theme). The website shows all phone shots and six 7-inch tablet shots;
  `Website/play/render.py` turns them into the Google Play phone and tablet screenshots and the feature graphic.
  How they are taken: demo account from `ios/appstore/seed.py` (for Android set the quota to 53687091200 so the app
  shows 50 GB), the debug build (`io.cloudy.app.debug`), `cloud.local` as the server name via `adb root` + a
  bind-mounted hosts file (`127.0.0.1 cloud.local`, `chcon u:object_r:system_file:s0`) + `adb reverse tcp:80 tcp:<server
  port>`, and SystemUI demo mode for the status bar (clock 09:41, full Wi-Fi with `-e fully true`, full battery, no
  notifications). Dark: `adb shell cmd uimode night yes`. The desktop and XR images are big (4 and 8 GB): install with
  `sdkmanager "system-images;android-34;android-desktop;arm64-v8a" "system-images;android-34;google-xr;arm64-v8a"`
  and uninstall again afterwards. On XR the system starts in dark mode (`cmd uimode night no`), Back closes the panel
  (use the app's own back arrow) and the short panel needs the file actions sheet dragged up to reach "Manage sharing".
- **iOS** (`ios/*.jpg`): scaled from `ios/appstore/raw/` (`sips -Z 1000 -s format jpeg`).
- **Desktop** (`desktop/desktop.png`): the settings window.
- **`overview.png`**: the site's hero (`desktop/desktop.png` + `android/phone/files.png` + `ios/files.jpg`) rendered
  1720×1200 with headless Chrome from `Website/assets/site.css` (`.stage`, 640 px wide at 110,44 on an 860×600
  night-sky page, 2×). Re-render it when those change.
