# Cloudy desktop

Sync client for macOS, Windows and Linux (Electron + TypeScript). It keeps a folder on the computer in two-way sync
with the user's Cloudy files, for one or several accounts (same server or different ones). It is a menu bar / system
tray app with a small settings window. Files only.

## Accounts (1.5+)

Each account has its own folder, by default `~/Cloudy/<username>` (`~/Cloudy/fahed`, `~/Cloudy/demo1`; the same
username on a second server gets `fahed (2)`), its own sync engine, sync state (`sync-state-<id>.json`) and pause
switch. "Change…" asks for a *place*: the account's folder is `<place>/Cloudy/<username>` (picking a `Cloudy` folder
gives `Cloudy/<username>`, picking a folder already named after the account keeps it; `folderIn` in accounts.ts).
Folders of two accounts may never be the same or one inside the other. The settings window has the accounts on a
night-sky rail at the side (profile picture or initials with a status badge each, "Add account", the app's Settings +
About at the bottom; only the pictures in narrow windows); the account page lets the user change or remove their
profile picture (cropped to a square ≤ 512 px JPEG in the window, `PUT /api/me/avatar`; servers before 1.20 get a
clear message); the tray menu is flat with one account and has a submenu per account
with several. Signing in to an account that is already there (same server and username) updates it instead of adding
it twice. `src/main/accounts.ts` (no Electron imports, `test/accounts.test.ts`) holds the settings format, the default
folders and the move below.

Upgrading from 1.4 or older: the one account becomes account `main` (its `sync-state.json` → `sync-state-main.json`),
and if it synced exactly `~/Cloudy`, that folder is moved once into `~/Cloudy/<username>`: renamed aside
(`~/.Cloudy-moving-<id>`), `~/Cloudy` created, renamed into place. Renames keep every file's identity, so the sync
history still fits and nothing is transferred again; an interrupted move is finished at the next start, and when it
can't be done (a program has the folder open on Windows) the folder stays and the move is tried at the next start.
Other folders are never moved.

## How sync works

`src/main/sync.ts` (no Electron imports) compares three trees by relative path on each pass:

- the **local folder**. Each folder's listing is cached too: while the folder watcher works, a pass re-reads only the
  folders it reported (and the ones the app itself wrote to). Every 5 minutes, at start and whenever the watcher
  is not trusted, every folder is read. Entries are `lstat`ed in parallel, 16 folders at a time;
- the **server**, read through `GET /api/nodes/:id`. Each folder's listing is cached and only re-read when its etag
  changes, and etags change all the way up the tree on every edit. Changed folders are read 8 at a time;
- **base**, which is both sides as of the last sync, saved in `sync-state.json` in the app's data folder.

Each side "changed" if it differs from base. Here is what each case does:

| Case | Result |
|---|---|
| One side changed | The change is copied to the other side. Uploads are chunked; downloads go to a temp file first. |
| Both sides changed | `name (conflicted copy <date>).ext` is kept next to the server version. |
| Only the time of a file changed (touch, restored from a backup) | With a SHA-256 from the server the file is hashed first: same content → only the new time is noted, nothing is uploaded (no new server version). Without the hash it is uploaded. |
| Same size, no history | The content is compared first, so a first sync into a folder that already has the files doesn't duplicate them. Servers from 1.16 list a SHA-256 per file: the local file is hashed and nothing is downloaded when they match. |
| Renamed or moved | Detected by inode (local) or node id (server) and repeated on the other side, not transferred again. |
| Deleted | Goes to the server trash or the computer's trash. |
| ≥ 100 files that are a tenth of the account or more, ≥ 1,000 files, every file of an account with ≥ 10, or every file on one side, deleted at once | The app asks first. "Keep" copies the files back. |
| A folder deleted on one side, but changed on the other | The changed files are kept and synced; only the unchanged ones are deleted. Checked again just before deleting. |
| Same name in another case or Unicode form ("Docs"/"docs", "é" composed/decomposed) on a filesystem that treats them as one (probed: APFS, NTFS, exFAT…) | One item: the server's spelling is used, so nothing is duplicated or deleted. Case-only renames are repeated on the other side. |
| Cannot be read | Unreadable folders, symlinks, names not allowed on this OS and case duplicates are reported and left alone on both sides. They are never treated as deleted. |
| Sync folder missing after something was synced | A disk that is not mounted or a moved folder: syncing stops with "Sync folder not found" instead of emptying the server. |
| A path on this computer leads outside the sync folder (a folder replaced by a link) | Nothing is written there; it is reported. |
| Folder removed from "Folders to sync" | Moved to the computer's trash, unless it has changes that are not on the server yet: then it stays where it is. |

A pass is triggered by:

- the folder watcher: `fs.watch` recursive on macOS (FSEvents) and Windows; on Linux one watcher per folder (Node's
  recursive watch reads the whole tree synchronously and throws uncaught errors at the inotify limit). When watching
  fails (e.g. `ENOSPC`, the inotify limit), every pass reads the whole folder and the timer runs every minute.
  Events caused by the app's own writes (downloads, new folders, deletions) start no pass: within 5 s of a write,
  an event for that path is compared with what was written;
- the server's live events (`/api/events`, SSE);
- a check every 5 minutes;
- waking from sleep.

Ignored names: `.DS_Store`, `Thumbs.db`, `desktop.ini`, Office lock files, `.cloudy-tmp-*`. On Windows, names the
filesystem can't hold, and names that differ only by upper/lower case on macOS and Windows, are listed under
"Not synced".

Work runs in parallel where the server allows it: transfers 6 at a time, new folders level by level and server
deletions 8 at a time (local deletions one by one: the system trash). Anything over the whole tree (which folders
hold changes, file counts for the "many deletions" question, forgetting deleted folders) is done once per pass, never
once per item, so deleting or moving thousands of folders at once stays fast. `sync-state.json` is only written when
something in it changed (at most every 10 s during a pass), stored as arrays rather than objects (version 2; version 1
files are still read).

Downloads go to a temp file and replace the local file only when complete (size checked). Upload chunks that fail on
the way are retried from the offset the server stored. Requests time out instead of hanging (downloads and live events
after a silence). Pausing, signing out and quitting abort running transfers; quitting saves what the cycle finished.
A pause while a pass is still reading the folders ends that pass there: nothing is renamed or deleted and no question
is asked until syncing is resumed.

When a pass fails (offline, the server restarting: no answer, 401, 502/503/504) it stops as a whole and is tried
again after 30 s, then 1, 2, 4 and 5 minutes (one timer; a pass that works starts over; waking up, "Sync now" and
changes still sync at once). Any other 5xx answered for one file is that file's problem: it is listed under "Not
synced" with its path and tried again by the next pass, while the other files go on. Five files in a row answered
like that stop the pass as a failing server does.
Each account's sync state is written atomically (temp file, fsync, rename), one write at a time, and records the folder it
belongs to: a state from another folder or account is never applied (an empty state only compares, never deletes).
After the server signs the app out, "Sign in again" keeps the folder and its state (it must be the same account;
another one is added with "+ Add account").

Sign-in uses `POST /api/auth/token` (a device token named "Desktop (<hostname>)"). The token is encrypted with
`safeStorage` (the OS keychain). Linux without a keyring (no GNOME Keyring or KWallet in the session): the token is
kept in `settings.json` (readable by this user only) without real encryption; the app logs that once at start and
says it under the account's name.

## File manager badges (1.7+)

A green tick (synced), blue arrows (being synced, or new and not synced yet) or a red mark (not synced: the account's
problem list; folders above a problem show it too) on the items in every running account's folder, in Finder, File
Explorer, GNOME Files, Nemo, Caja and Dolphin. The file manager side holds no state: `src/main/finder.ts` serves the
answers on `127.0.0.1` (random port) and writes the port and two random values to `finder.json` (0600, removed at
quit) at a fixed place: `~/Library/Application Support/Cloudy/` (macOS), `%APPDATA%\Cloudy\` (Windows),
`~/.config/Cloudy/` (Linux). The app sends the first value when an extension connects (an extension checks it before
saying anything: a process of another user that took over the port learns nothing), the extension must answer with the
second. Then one JSON object per line (`folders`, `ask`, `badges`, `changed`; see the comment at the top of finder.ts).
The answers come from `SyncEngine.badge(path)`; the engine announces changed paths (`badges` event), so the badges
update live. The badges show only while Cloudy runs. Settings has one switch per computer ("Finder", "File Explorer"
or "File manager"; on Windows and Linux stored as `badges: false` in settings.json, on macOS by pluginkit).

The pictures for Windows and Linux are drawn by `badges/render.swift` (`swift badges/render.swift` from desktop/;
writes `explorer/icons/*.ico` and `linux/icons/hicolor/*/emblems/emblem-cloudy-*.png`, committed). Finder draws its own
from SF Symbols, which may be used only on Apple platforms.

**macOS** (`finder/`): a Finder Sync extension (`io.cloudy.desktop.finder`, Swift, built by `finder/build.sh` with
`swiftc`, no Xcode project). Its sandbox may read only finder.json (temporary-exception entitlement,
`finder/CloudyFinder.entitlements`). An app group's container does not work for this: macOS 27 refuses the
non-sandboxed Electron app there (TCC "AppDataDetailed"), even with the team-prefixed group entitlement.
Packaging: `npm run dist:mac` builds the extension, `scripts/after-pack.cjs` copies it into
`Cloudy.app/Contents/PlugIns/` and signs it (Developer ID from `CSC_NAME`, else ad hoc) before electron-builder signs
the app around it (electron-builder never signs `PlugIns` itself); `mac.x64ArchFiles` lets the universal merge keep the
already-universal binary. At start the app registers the extension (`pluginkit -a`) and turns it on unless the user
turned it off; Settings → Finder switches it (`pluginkit -e use|ignore`). Testing a packaged build next to an installed
Cloudy: `open -n dist/mac-arm64/Cloudy.app --args --user-data-dir=/tmp/x --use-mock-keychain` (launch with `open`;
`env -u ELECTRON_RUN_AS_NODE` from VS Code), then a Finder window on the account's folder.

**Windows** (`explorer/`): `CloudyBadges.dll` (C++, x64, static CRT, built by `node explorer/build.mjs` with MSVC
found through vswhere; `npm run dist:win` runs it) holds three icon overlay handlers (synced, syncing, not synced).
Explorer, and every program that shows a file dialog, calls `IsMemberOf` for each item it draws; it answers from a
cache and a background thread asks the app, then `SHChangeNotify(SHCNE_UPDATEITEM)` makes Explorer draw the item
again. The app (`src/main/badges-win.ts`) copies the DLL to `%LOCALAPPDATA%\Cloudy\Explorer\<version>-<size>\` (a
loaded DLL cannot be replaced by an update; old copies are removed once unused) and registers the handlers for the
current user (`HKCU\Software\Classes\CLSID\{…01-03}`, at every start, no administrator needed). Explorer reads its list
of handlers only from HKLM (`…\Explorer\ShellIconOverlayIdentifiers\  Cloudy*`; tried on a Windows runner with
Explorer screenshots: an HKCU list is ignored), so the badges are off by default on Windows and turning them on in
Settings imports the three names with `reg import` as administrator (one Windows permission prompt; declined: they
stay off). Two leading spaces in the names: Explorer uses only the first 15 handlers by name; this is after Dropbox's,
before OneDrive's and Windows' own. Turning them off asks again to take the names out. Uninstalling (not updating)
removes the handlers and asks to take the names out (`explorer/installer.nsh`). Explorer reads the list when it
starts: the badges appear after signing in to Windows again. Tests: `test/explorer.test.ts` with
`explorer/build/harness.exe` (`node explorer/build.mjs --test`; the registry test only with `CLOUDY_TEST_REGISTRY=1`,
as in CI's Windows package job, which runs as administrator). Not testable on CI: an elevated process (the runner's
Explorer) ignores per-user COM classes, so the screenshots used classes in HKLM; a normal user's Explorer uses HKCU.

**Linux** (`linux/`): `cloudy-badges.py` is one extension for GNOME Files (Nautilus 3.0/4.x API), Nemo and Caja
(their Python extension packages: python3-nautilus, python3-nemo, python3-caja); the app (`src/main/badges-linux.ts`)
copies it into `~/.local/share/{nautilus,nemo,caja}-python/extensions/` with `HOST = '…'` as the first line, and the
emblems into `~/.local/share/icons/hicolor/` (no root, also for the AppImage). It runs on the file manager's main loop
(GLib IO watches, no threads) and calls `invalidate_extension_info()` when an answer or change comes. Dolphin:
`linux/dolphin/cloudyoverlay.cpp`, a KF6 `KOverlayIconPlugin` (Qt plugin), built by `linux/dolphin/build.sh` in
Debian 13 (KF6 6.13, Qt 6.8: loads in those and newer; CI builds x64 and arm64 on their own runners). Only the .deb can
install it (Qt's plugin folder is a system folder): `linux/deb/after-install.sh` copies it to
`/usr/lib/<multiarch>/qt6/plugins/kf6/overlayicon/` when Qt 6 is there, `after-remove.sh` removes it; both scripts
are electron-builder's own templates plus that part (compare them with `app-builder-lib/templates/linux/` when
electron-builder is updated). The file managers load extensions when they start: the first time, the badges appear
after signing out and back in. Checked in containers (Xvfb) with Ubuntu 26.04 (GNOME Files 50, Nemo, Caja) and Debian
13 (Dolphin), the last two with the real .deb against a local server.

## Layout

```
src/main/main.ts      tray, window, IPC handlers, login item
src/main/sync.ts      sync engine
src/main/api.ts       Cloudy API client (chunked upload, download, SSE)
src/main/store.ts     settings.json / sync-state-<account>.json (userData), token encryption
src/main/accounts.ts  several accounts: settings format, default folders ~/Cloudy/<username>, moving an old ~/Cloudy
src/main/finder.ts    file manager badges: loopback server the extensions ask (finder/, explorer/, linux/)
src/main/badges-win.ts   Windows: copies and registers explorer/CloudyBadges.dll for this user
src/main/badges-linux.ts Linux: installs linux/cloudy-badges.py + emblems into ~/.local/share
src/main/updater.ts   updates from the newest GitHub release (tag desktop-X.Y.Z) (electron-updater, generic feed)
src/main/i18n.ts      t(): English texts with {name} placeholders (the app is English only)
src/preload/          contextBridge: cloudy.call(name, ...args), cloudy.onUpdate(fn)
src/ui/               settings window (plain HTML/JS/CSS, no framework)
assets/               app icon: icon.png 1024 px (Windows/Linux); macOS Cloudy.icon (Icon Composer, blue in light+dark) → scripts/mac-icon.sh → Assets.car + icon.icns (committed); tray icons (cloud only: white tray.png for Windows/Linux, trayMacTemplate = 18 pt macOS template image)
test/sync.test.ts     sync tests: two engines against a real server
test/finder.test.ts   the badge server (handshake, answers, change batching)
test/explorer.test.ts Windows: the overlay DLL against the badge server, registry (CI)
test/badges-linux.test.ts  Linux: extension + emblems in and out of ~/.local/share
badges/render.swift   draws the Windows overlay icons and Linux emblems
finder/               macOS Finder Sync extension (Swift) + Info.plist, entitlements, build.sh
explorer/             Windows overlay handlers (C++ DLL), build.mjs, installer.nsh, test harness
linux/                cloudy-badges.py (GNOME Files, Nemo, Caja), dolphin/ (KF6 plugin), deb/ (postinst/postrm), icons/
```

## Develop

```sh
cd desktop && npm install
npm start                                   # build + run (from VS Code's terminal: env -u ELECTRON_RUN_AS_NODE npm start)
CLOUDY_USER_DATA=/tmp/cloudy-dev npm start  # separate settings/profile (CLOUDY_HOME: other default folders)
npm run typecheck
CLOUDY_TEST_URL=http://localhost:8080 CLOUDY_TEST_USER=admin CLOUDY_TEST_PASSWORD=… npm test
npm run dist:mac | dist:win | dist:linux    # packages in dist/ (unsigned locally: CSC_IDENTITY_AUTO_DISCOVERY=false)
```

Packaged builds have Electron's fuses set (`electronFuses` in `electron-builder.json`): `ELECTRON_RUN_AS_NODE`,
`NODE_OPTIONS` and `--inspect` do nothing, and the app is loaded only from `app.asar`, so another program on the
computer cannot run its own code as Cloudy (and so read the sign-in or use Cloudy's folder permissions). `npm start`
is not affected. A packaged build can therefore not be driven through the Node inspector (Playwright's `_electron`
needs it): drive `npm start` instead. electron-builder sets the fuses after `scripts/after-pack.cjs` and right before
it signs, which changes the Electron Framework binary. An **unsigned** Mac build (nothing signs it afterwards) is
left with a framework whose ad hoc signature no longer matches, and Apple Silicon refuses to run that: sign it once
by hand before starting it,
`codesign --force --sign - "dist/mac-arm64/Cloudy.app/Contents/Frameworks/Electron Framework.framework"`.
(`resetAdHocDarwinSignature` is not used: it signs the whole app `--deep` and would replace the Finder extension's
Developer ID signature in release builds.)

## Updates

A new version is released by pushing the tag `desktop-X.Y.Z` (`scripts/version.py bump X.Y.Z desktop`, commit,
`git tag desktop-X.Y.Z && git push origin desktop-X.Y.Z`). The workflow builds and signs the packages and publishes a GitHub
release titled `vX.Y.Z` (the desktop app is the only product with GitHub releases) with all packages and the `latest*.yml`
update files. Installed versions up to 1.2.0 don't find these releases (they looked for an older tag form): install the
new version by hand once. It updates itself on macOS (from the `.zip`), on Windows, from an AppImage and from a
`.deb`. The macOS packages are signed with a Developer ID and notarized; the Windows installer is not signed yet.

Updates are checked before they are installed. On macOS, the system checks that the update is signed with the same
Developer ID as the running app. On Windows and Linux, each release also carries `update-signatures.json` (the SHA-512
of every package) and its Ed25519 signature `update-signatures.json.sig`, made by the release workflow
(`scripts/sign-update.mjs`). The app installs a downloaded update only when the signature matches the public key built
into it (`src/main/updateSignature.ts`) and the download is listed for that version; otherwise it deletes the download
and shows an error. Versions up to 1.7.0 don't have this check yet.
