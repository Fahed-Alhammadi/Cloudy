Screenshots shown on the GitHub Pages site (`Website/index.html`) and in the main README. Only what the site or README
shows is kept here (committed). Everything for the stores, including the raw captures, lives in the git-ignored
`Store/` folder at the repository root:

```
Store/
├── Apple Store/     raw/ (simulator captures), iphone-6.9/, iphone-6.3/, creative/, app-icon/, preview-video/, _previous/
└── Google Play/     raw/{phone,tablet-7-inch,tablet-10-inch,desktop,xr}/, phone-screenshots/, 7-inch-tablet-screenshots/,
                     10-inch-tablet-screenshots/, desktop-screenshots/, android-xr-screenshots/, feature-graphic/
```

The render scripts (`ios/appstore/render.py`, `android/playstore/render.py`) write the store images into `Store/` and
refresh the copies here at the same time, so after new captures one run updates both.

```
Website/screenshots/
├── overview.png          README picture: desktop + Android phone + iPhone together
├── feature-graphic.png   the site's og:image (copy of the Google Play feature graphic)
├── android/
│   ├── phone/            1080×2400 PNG raw captures, Pixel 7 emulator, API 35 (site gallery + hero)
│   ├── tablet-7-inch/    1200×1920 PNG raw captures, "Nexus 7 2013" emulator, API 35 (files, grid, more, dark)
│   └── framed/           540×960 JPEG copies of the Play phone set (site's Android band + README)
├── ios/                  iPhone, 460×1000 JPEG (scaled from Store/Apple Store/raw/)
└── desktop/              Cloudy's own Mac/Windows/Linux app (settings window), not Android
```

## Taking the Android captures

Save them in `Store/Google Play/raw/<form>/`, where every form uses the same file names: `files.png`, `grid.png`
(Photos folder as a grid), `preview.png` (text editor), `sharing.png`, `photos.png` (Photo backup), `recent.png`,
`shared.png` (the Recent and Shared tabs), `more.png`, `dark.png` (Files in the dark theme). Forms: `phone/` (1080×2400,
Pixel 7, API 35), `tablet-7-inch/` (1200×1920, "Nexus 7 2013", API 35), `tablet-10-inch/` (2560×1600, "pixel_tablet",
API 35, landscape), `desktop/` (2560×1440 JPEG, "desktop_medium" + android-desktop image API 34, 3840×2160 scaled, the app
in a resized window: `adb shell am task resize <task> 560 200 3280 1880`), `xr/` (2048×2048 JPEG, "xr_headset_device" +
google-xr image API 34: the headset view). Then run `python3 -I android/playstore/render.py`.

How they are taken: demo account from `ios/appstore/seed.py` (for Android set the quota to 53687091200 so the app shows
50 GB), the debug build (`io.cloudy.app.debug`), `cloud.local` as the server name via `adb root` + a bind-mounted hosts
file (`127.0.0.1 cloud.local`, `chcon u:object_r:system_file:s0`) + `adb reverse tcp:80 tcp:<server port>`, and SystemUI
demo mode for the status bar (clock 09:41, full Wi-Fi with `-e fully true`, full battery, no notifications). Dark:
`adb shell cmd uimode night yes`. The tablet sets can also be taken on the phone emulator with its display overridden
(as done for app version 1.16): `adb shell wm size 1200x1920; adb shell wm density 320` for the 7-inch set,
`wm size 1600x2560` + `wm density 320` + `wm user-rotation lock 1` for the 10-inch set, then
`wm size reset; wm density reset; wm user-rotation lock 0`. Photo backup creates a "Camera Uploads" folder when it is
switched on: take `photos.png` last and delete that folder again. All five sets were retaken for app version 1.19
(Files · Recent · Shared · More). On desktop and XR the hosts trick also works (`adb root` is allowed); on XR use the
app's own back arrow, and scroll the short panel to reach "Weekly planning.md". The desktop and XR images are big (4 and
8 GB): install with `sdkmanager "system-images;android-34;android-desktop;arm64-v8a" "system-images;android-34;google-xr;arm64-v8a"`
and uninstall again afterwards. On XR the system starts in dark mode (`cmd uimode night no`), Back closes the panel (use
the app's own back arrow) and the short panel needs the file actions sheet dragged up to reach "Manage sharing".

## Others

- **iOS** (`ios/*.jpg`): made by `ios/appstore/render.py` from `Store/Apple Store/raw/` (`sips -Z 1000 -s format jpeg`).
  How to take the captures: `ios/appstore/README.md`.
- **Desktop** (`desktop/desktop.png`): the settings window.
- **`overview.png`**: the site's hero (`desktop/desktop.png` + `android/phone/files.png` + `ios/files.jpg`) rendered
  1720×1200 with headless Chrome from `Website/assets/site.css` (`.stage`, 640 px wide at 110,44 on an 860×600
  night-sky page, 2×). Re-render it when those change.
