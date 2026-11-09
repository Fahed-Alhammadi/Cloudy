# Cloudy desktop

Sync client for macOS, Windows and Linux (Electron + TypeScript). It keeps one folder on the computer in two-way sync
with the user's Cloudy files. It is a menu bar / system tray app with a small settings window. Files only: no calendar
or contacts.

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
| Same size, no history | The content is compared first, so a first sync into a folder that already has the files doesn't duplicate them. Servers from 1.16 list a SHA-256 per file: the local file is hashed and nothing is downloaded when they match. |
| Renamed or moved | Detected by inode (local) or node id (server) and repeated on the other side, not transferred again. |
| Deleted | Goes to the server trash or the computer's trash. |
| ≥ 100 files (or every file of a folder with ≥ 10, or every file on one side) and ≥ half of them deleted at once | The app asks first. "Keep" copies the files back. |
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
`sync-state.json` is written atomically (temp file, fsync, rename), one write at a time, and records the folder it
belongs to: a state from another folder or account is never applied (an empty state only compares, never deletes).
After the server signs the app out, "Sign in again" keeps the folder and its state; another account starts over.

Sign-in uses `POST /api/auth/token` (an app password named "Desktop (<hostname>)"). The token is encrypted with
`safeStorage` (the OS keychain).

## Layout

```
src/main/main.ts      tray, window, IPC handlers, login item
src/main/sync.ts      sync engine
src/main/api.ts       Cloudy API client (chunked upload, download, SSE)
src/main/store.ts     settings.json / sync-state.json (userData), token encryption
src/main/updater.ts   updates from the newest GitHub release (tag desktop-X.Y.Z) (electron-updater, generic feed)
src/main/i18n.ts      t() + LANGUAGES; translations in i18n/<lang>.json (English keys, as on the web)
src/preload/          contextBridge: cloudy.call(name, ...args), cloudy.onUpdate(fn)
src/ui/               settings window (plain HTML/JS/CSS, no framework)
assets/               app icon: icon.png 1024 px (Windows/Linux); macOS Cloudy.icon (Icon Composer, blue in light+dark) → scripts/mac-icon.sh → Assets.car + icon.icns (committed); tray icons (cloud only: white tray.png for Windows/Linux, trayMacTemplate = 18 pt macOS template image)
test/sync.test.ts     sync tests: two engines against a real server
```

## Develop

```sh
cd desktop && npm install
npm start                                   # build + run (from VS Code's terminal: env -u ELECTRON_RUN_AS_NODE npm start)
CLOUDY_USER_DATA=/tmp/cloudy-dev npm start  # separate settings/profile for development runs
npm run typecheck
CLOUDY_TEST_URL=http://localhost:8080 CLOUDY_TEST_USER=admin CLOUDY_TEST_PASSWORD=… npm test
npm run dist:mac | dist:win | dist:linux    # packages in dist/ (unsigned locally: CSC_IDENTITY_AUTO_DISCOVERY=false)
```

New texts: wrap them in `t('…')` and add them to all four `i18n/*.json` files (`python3 tests/i18n_check.py`).

## Updates

A new version is released by pushing the tag `desktop-X.Y.Z` (`scripts/version.py bump X.Y.Z desktop`, commit,
`git tag desktop-X.Y.Z && git push origin desktop-X.Y.Z`). The workflow builds and signs the packages and publishes a GitHub
release titled `vX.Y.Z` (the desktop app is the only product with GitHub releases) with all packages and the `latest*.yml`
update files. Installed versions up to 1.2.0 don't find these releases (they looked for an older tag form): install the
new version by hand once. It updates itself on macOS (from the `.zip`), on Windows, from an AppImage and from a
`.deb`. The macOS packages are signed with a Developer ID and notarized; the Windows installer is not signed yet.
