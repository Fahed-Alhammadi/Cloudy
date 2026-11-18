# Cloudy for iPhone

A native iPhone app (Swift, SwiftUI) for your Cloudy server. It needs iOS 17 or newer and has no third-party dependencies.

**Features:**
- Browse, search, sort, upload (photos/videos with the system picker, any file from Files) and download files.
- Preview images, video, audio, PDF and office documents with Quick Look; edit text files.
- Rename, move, copy, delete and favorite files, and use the trash.
- Share by public link (password, expiry date, uploads for folders) or with people and groups. Manage what you shared.
- Scan documents to PDF (VisionKit, real iPhone only, not the simulator); you name the scan before it uploads.
- Send files to other apps or Save to Files with the share sheet.
- Cloudy in Apple's Files app: a location under *Locations* (and in every app's open/save dialog) while signed in
  and the app lock is off.
- Tabs: Files, Recent, Shared (files shared with you) and More.
- Live updates: changes from other devices show up immediately.
- App lock (Face ID / Touch ID / passcode), Devices (revoke sign-ins). The app is in English.

Sign-in works like on Android: the password (plus a two-factor code if needed) is exchanged for a device token stored in
the Keychain. Each iPhone appears on the web under *Settings → Devices*.

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

Account deletion without tapping: add `SIMCTL_CHILD_CLOUDY_DELETE_TEST=<password>` (with `CLOUDY_TAB=3`) to open the
*Delete account* prompt filled in, or `go:<password>` to submit it (Debug builds only; it really deletes the account).
Password change without typing: `SIMCTL_CHILD_CLOUDY_SCRIPT='1:route:password'` opens *Change password*, and
`SIMCTL_CHILD_CLOUDY_PASSWORD_TEST=[go:]<current>:<new>[:<repeat>]` fills it in (`go:` also submits; it really changes it).
Profile picture without the photo picker (it can't be scripted): `SIMCTL_CHILD_CLOUDY_PICTURE_TEST=<file>` (with `CLOUDY_TAB=3`)
opens *New profile picture* with that file from the Mac, `go:<file>` also saves it, `remove` removes the current picture.
Login screen without typing: `SIMCTL_CHILD_CLOUDY_LOGIN_TEST=<user>:<password>` fills in the form;
`SIMCTL_CHILD_CLOUDY_PASSWORD_VISIBLE=1` starts password fields shown (eye toggled on).

**Testing Cloudy in the Files app (simulator):** `./build.sh` builds unsigned, and then iOS has no App Group for the
extension ("Files location add failed"). Build signed to run locally instead:
`xcodebuild -project Cloudy.xcodeproj -scheme Cloudy -configuration Debug -destination 'generic/platform=iOS Simulator'
-derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO build`. The shortcut sign-in
above is stored like a real one (the extension reads it); `SIMCTL_CHILD_CLOUDY_FILES_RESET=1` removes the location and adds
it again from scratch. iOS asks once to *Turn On* Cloudy in the Files app. Inspect it with
`xcrun simctl spawn booted fileproviderctl dump io.cloudy.app.files` (look for 🛑 = an item iOS can't create, which shows
as "Syncing Paused"), logs with `log show --predicate 'subsystem == "io.cloudy.app"'`. iOS asks the extension again only
when told to: a server change shows up when the Files app opens a folder (at most every 15 s) or when the Cloudy app is open.
Looking at states and motion without tapping (all in `Cloudy/UI/Screenshots.swift`): `SIMCTL_CHILD_CLOUDY_SCRIPT=<seconds>:<step>;…`
plays steps such as `tab:1`, `folder:<id>:<name>`, `route:trash` (or `devices`, `password`, `links`, `about`), `pop`, `grid`, `sort:date`, `select:3`, `done`,
`landscape`; `CLOUDY_LANDSCAPE=1` starts rotated (the simulator can't be rotated from the command line),
`CLOUDY_LOCK=1` shows the app-lock screen, `CLOUDY_ICONS=1` one row per file type, `CLOUDY_LOGIN_ERROR=<text>` the sign-in
screen with an error, and `CLOUDY_SERVER` without a token fills in the sign-in screen's address.

**App Store screenshots and preview video:** [appstore/README.md](appstore/README.md) (`appstore/seed.py` fills a
throwaway server with the demo account, `appstore/render.py` frames the captures).

## Code map

| Path | What it does |
|---|---|
| `project.yml` | XcodeGen spec (targets, versions, build settings) |
| `Cloudy/Info.plist` | Permissions texts, ATS (local networking only), export compliance |
| `Cloudy/Data/API.swift` | JSON API client (URLSession, bearer token, chunked uploads, SSE) |
| `Cloudy/Data/Session.swift` | Server address (App Group), user; `Keychain.swift` = device token (shared keychain group) |
| `CloudyShare/` | Share extension "Share to Cloudy" (`io.cloudy.app.share`): files from other apps' share sheets → folder picker → chunked upload with the app's token |
| `CloudyFiles/` | File Provider extension (`io.cloudy.app.files`): "Cloudy" in the Files app. Lists folders on demand, downloads when a file is opened, uploads saves; changes from elsewhere arrive through a working-set walk (`Remote.changes`, folder etags in `Index`) that the app triggers on live events and the extension triggers when a folder is opened (≤ every 15 s). Port of the old macOS Cloudy Drive extension |
| `Cloudy/Data/FilesDomain.swift` | The Files location: added while signed in, removed (with its copies) on sign-out; `changed()` asks the extension to check for changes |
| `Cloudy/Data/Live.swift` | Live updates (SSE → `.cloudyChange` notifications), download cache |
| `Cloudy/Data/Uploads.swift` | Uploads in progress (with background time) |
| `Cloudy/UI/*.swift` | SwiftUI screens: Files, FileActions (menus, Quick Look), ShareSheet, Lists (favorites, recent, shared, trash), More |
| `Cloudy/Resources/` | Assets (icon), `Localizable.xcstrings` / `InfoPlist.xcstrings` (English texts), `PrivacyInfo.xcprivacy` |
