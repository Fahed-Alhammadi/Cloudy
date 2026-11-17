# App Store assets

This folder holds the tools (`seed.py`, `render.py`). The images and videos live in the git-ignored **`Store/Apple Store/`**
at the repository root (large; regenerated with the steps below): `raw/` (simulator captures + `tour.mov`), `iphone-6.9/`,
`iphone-6.3/`, `creative/`, `app-icon/`, `preview-video/`, and `_previous/` (the set before, same layout).
`render.py` also refreshes the website's copies in `Website/screenshots/ios/` (committed), so the site stays current.

Ready to upload in App Store Connect → the app's version page → *App Previews and Screenshots* (opaque PNGs, order 1–6):

| Slot | Screenshots | Preview video |
|---|---|---|
| **iPhone 6.9" Display** (required) | `iphone-6.9/*.png` (7), 1320×2868 | `preview-video/preview-886x1920.mp4` |
| iPhone 6.1"/6.3" Display (optional: scaled from 6.9" if empty) | `iphone-6.3/*.png`, 1206×2622 | the same `.mp4` (886×1920 is accepted there too) |

**App icon:** not uploaded here. App Store Connect takes it from the build (`AppIcon` 1024×1024, opaque, in
`Cloudy/Resources/Assets.xcassets`) and shows it once a build is selected on the version page. `app-icon/app-icon-1024.png`
is a copy for anything else that asks for it.

**Header and Search Results** (optional creative assets, same section of the version page;
[specs](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications)):

| File | Size | Use for |
|---|---|---|
| `creative/creative-16x9-header-and-search.png` | 5244×2950 (16:9) | product page header **and** search results |
| `creative/creative-21x9-header.png` | 3840×1646 (21:9) | product page header (wide alternative) |
| `creative/creative-3x2-search.png` | 3840×2560 (3:2) | search results (alternative) |

Without a search results asset, the App Store shows the screenshots in search instead.

**App preview video** (optional, same section, plays before the screenshots;
[specs](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications)):
`preview-886x1920.mp4`: 29 s, 886×1920 portrait, 30 fps, H.264 High 4.0 at ~11 Mbps CBR, silent stereo AAC 256 kbps/48 kHz.
Upload it next to the screenshots (6.9" and, if you fill it, 6.1"/6.3"); the default poster frame (5 s) shows the Projects folder.

`raw/` holds the plain simulator captures; `render.py` adds the icon, headline and phone frame, and builds the banners from three of them (headless Chrome):

```sh
python3 -I ios/appstore/render.py     # raw/*.png → iphone-6.9|6.3/*.png + creative/*.png + Website/screenshots/ios/*.jpg
```

## Taking new captures

1. Run a fresh, throwaway local server (Docker, or Postgres + `node src/server.ts` with `PORT=80`) and fill it with the
   fictional demo account: `python3 -I ios/appstore/seed.py http://127.0.0.1 <admin password> [<database url>]`. It prints
   the device token and the `CLOUDY_OPEN` / `CLOUDY_TOUR` values (with the database URL it also backdates file dates).
   The simulator uses `http://cloud.local` (below); seed through `127.0.0.1`, Python's `.local` lookups are flaky.
2. Build for the simulator (`ios/build.sh`) and use the **iPhone Pro Max** simulator (6.9", 1320×2868), light mode,
   status bar `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 …`.
3. Debug builds open screens from the launch environment, so no tapping is needed (`Cloudy/UI/Screenshots.swift`):

   | Capture | Environment (`SIMCTL_CHILD_` + …) |
   |---|---|
   | sign-in skipped | `CLOUDY_SERVER=<url>`, `CLOUDY_TOKEN=<token>` |
   | a tab | `CLOUDY_TAB=0…3` (Files, Recent, Shared, More) |
   | a folder / text file / share sheet | `CLOUDY_OPEN=folder:<id>:<name>`, `text:<id>:<name>`, `share:<id>:<name>` |

   ```sh
   SIMCTL_CHILD_CLOUDY_SERVER=… SIMCTL_CHILD_CLOUDY_TOKEN=… SIMCTL_CHILD_CLOUDY_TAB=1 \
     xcrun simctl launch --terminate-running-process booted io.cloudy.app
   xcrun simctl io booted screenshot "Store/Apple Store/raw/recent.png"
   ```

Public links show the server address, so use a real-looking one rather than `localhost:8080`: e.g. publish
`cloud.local` → 127.0.0.1 with `dns-sd -P "Cloudy demo" _http._tcp local 80 cloud.local 127.0.0.1` and forward port 80
to 8080. Plain http to `.local` names is allowed by the app.

## Recording the preview video

Debug builds play a scripted tour when launched with
`CLOUDY_TOUR=<folder id>:<folder name>:<text file id>:<text file name>` (`Screenshots.runTour()`; a fifth part is
ignored): folder → share sheet → Recent tab → Shared tab → typing in the note. Record it and convert
(needs `brew install ffmpeg`):

```sh
xcrun simctl io booted recordVideo --codec h264 --mask=ignored --force "Store/Apple Store/raw/tour.mov" &   # wait for "Recording started"
env SIMCTL_CHILD_CLOUDY_SERVER=… SIMCTL_CHILD_CLOUDY_TOKEN=… "SIMCTL_CHILD_CLOUDY_TOUR=366:Projects:369:Weekly planning.md" \
  xcrun simctl launch booted io.cloudy.app
# after ~30 s: kill -INT the recorder. The capture ends at the last screen change (~23 s).
ffmpeg -y -ss 2.0 -i "Store/Apple Store/raw/tour.mov" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -filter_complex "[0:v]scale=886:1926:flags=lanczos,crop=886:1920,tpad=stop_mode=clone:stop_duration=2,fps=30,format=yuv420p[v]" \
  -map "[v]" -map 1:a -t 23 -c:v libx264 -profile:v high -level:v 4.0 -preset slow -b:v 11M -minrate 11M -maxrate 11M \
  -bufsize 11M -x264-params nal-hrd=cbr:force-cfr=1 -c:a aac -b:a 256k -ar 48000 -ac 2 -movflags +faststart \
  "Store/Apple Store/preview-video/preview-886x1920.mp4"
```

`-ss 2.0` skips the app launch; check the first and last frames, since launch time varies (2026-10-31: `-ss 2.3` and
`stop_duration=3` to reach 29 s). Before taking a new set, move the current one into `Store/Apple Store/_previous/`.
