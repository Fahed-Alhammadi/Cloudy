# Cloudy for iPhone

A native iPhone app (Swift, SwiftUI) for your Cloudy server. It needs iOS 17 or newer and has no third-party dependencies.

**Features:**
- Browse, search, sort, upload (photos/videos with the system picker, any file from Files) and download files.
- Preview images, video, audio, PDF and office documents with Quick Look; edit text files.
- Rename, move, copy, delete and favorite files, and use the trash.
- Share by public link (password, expiry date, uploads for folders) or with people and groups. Manage what you shared.
- Scan documents to PDF (VisionKit, real iPhone only, not the simulator); you name the scan before it uploads.
- Send files to other apps or Save to Files with the share sheet.
- **Calendar** (month view, repeating events) and **contacts** (import .vcf/.csv, export .vcf).
- Live updates: changes from other devices show up immediately.
- App lock (Face ID / Touch ID / passcode), Devices (revoke sign-ins), English, Arabic (RTL), German, French, Spanish.

Sign-in works like on Android: the password (plus a two-factor code if needed) is exchanged for a device token stored in
the Keychain. Each iPhone appears on the web under *Settings → App passwords*.

## Build and run

You need Xcode 16 or newer and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
The Xcode project is generated from `project.yml` and is not committed.

```sh
ios/build.sh                # generate Cloudy.xcodeproj + simulator build (checks it compiles)
open ios/Cloudy.xcodeproj   # run on a simulator or your iPhone from Xcode
```

To run on a real iPhone, pick your team in Xcode → target *Cloudy* → *Signing & Capabilities* (or set
`DEVELOPMENT_TEAM` in `project.yml`).

**Local servers:** App Transport Security allows plain `http://` only for local-network addresses (IP addresses and
`.local` names), e.g. `http://192.168.1.10:8080`. Any other server needs `https://` with a valid certificate.

**Simulator shortcuts (Debug builds only):** skip the login screen and choose the first tab:

```sh
SIMCTL_CHILD_CLOUDY_SERVER=http://localhost:8080 SIMCTL_CHILD_CLOUDY_TOKEN=<device token> SIMCTL_CHILD_CLOUDY_TAB=1 \
  xcrun simctl launch booted io.cloudy.app
```

**App Store screenshots and preview video:** [appstore/README.md](appstore/README.md) (`appstore/seed.py` fills a
throwaway server with the demo account, `appstore/render.py` frames the captures).

## Code map

| Path | What it does |
|---|---|
| `project.yml` | XcodeGen spec (targets, versions, build settings) |
| `Cloudy/Info.plist` | Permissions texts, ATS (local networking only), export compliance, languages |
| `Cloudy/Data/API.swift` | JSON API client (URLSession, bearer token, chunked uploads, SSE) |
| `Cloudy/Data/Session.swift` | Server address (App Group), user; `Keychain.swift` = device token (shared keychain group) |
| `CloudyShare/` | Share extension "Share to Cloudy" (`io.cloudy.app.share`): files from other apps' share sheets → folder picker → chunked upload with the app's token |
| `Cloudy/Data/Live.swift` | Live updates (SSE → `.cloudyChange` notifications), download cache |
| `Cloudy/Data/Uploads.swift` | Uploads in progress (with background time) |
| `Cloudy/UI/*.swift` | SwiftUI screens: Files, FileActions (menus, Quick Look), ShareSheet, Lists (favorites, recent, shared, trash), Calendar, Contacts, More |
| `Cloudy/Resources/` | Assets (icon), `Localizable.xcstrings` / `InfoPlist.xcstrings` (translations), `PrivacyInfo.xcprivacy` |
