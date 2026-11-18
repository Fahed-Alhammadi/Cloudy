# Changelog: Cloudy server

What changed in each version of the server (the container image `ghcr.io/fahed-alhammadi/cloudy`), newest first.
Read it before you update:

```sh
docker compose pull && docker compose up -d
```

Sections marked **Before you update** need an action from you. The apps (Android, iPhone, desktop) ship through
their stores and the [releases page](https://github.com/Fahed-Alhammadi/Cloudy/releases), each with its own notes.
Newer apps work with older servers and the other way round.

## 2.1.1 (2026-11-18)

A small fix in the web app. Nothing to do before you update.

- Logging out now goes back to the sign-in page at `/`. Before, the address bar kept the page you were on (for example
  `/files`). When a session expires, the address is still kept, so signing in again brings you back to that page.

## 2.1.0 (2026-11-17)

WebDAV is gone: Cloudy's own apps and the web app are the way in. Nothing to do before you update, unless you use a
WebDAV app.

**Before you update**

- If you open Cloudy in Finder, Windows Explorer, rclone or Cyberduck over WebDAV (`/dav/files/<username>/`), that
  stops working. Use the desktop sync app or the web app instead.

**Removed**

- WebDAV (`/dav/*`), signing in with a username and password over HTTP Basic, and creating app passwords by hand
  (`POST /api/me/app-passwords`). The `fast-xml-parser` library is no longer needed.

**Changed**

- *Settings → Apps & devices* is now *Settings → Devices*: the Android, iPhone and desktop apps signed in to your
  account, each with *Sign out*. Signing out of the apps and resetting a password still sign devices out as before.

## 2.0.0 (2026-11-17)

Cloudy is now about files: calendars, contacts and the translations are gone.

**Before you update**

- **Export your calendars and contacts first** if you still need them (from the 1.20 web app, or with a CalDAV /
  CardDAV app such as Thunderbird or DAVx⁵). 2.0 deletes them from the database on its first start, and there is no
  way back.
- Phones and computers that sync calendars or contacts with Cloudy over CalDAV or CardDAV stop syncing; remove those
  accounts from them.
- Update the apps too: Android 1.20, iPhone 1.18 and desktop 1.4 match this server. Older apps still work for files,
  but their Calendar and Contacts screens show errors.

**Removed**

- Calendars and contacts: the web pages, `/api/calendars`, `/api/addressbooks`, contacts import and export, CalDAV
  and CardDAV under `/dav/calendars/` and `/dav/addressbooks/`, and the `/.well-known/caldav` and `/.well-known/carddav`
  redirects. The database tables `calendars`, `calendar_objects`, `addressbooks`, `cards` and `dav_changes` are
  dropped.
- Languages: the web app and the emails are in English only. The Language setting (web and apps) and the account's
  `language` field are gone.

**Unchanged**

- WebDAV for files (`/dav/files/<username>/`) for Finder, Windows Explorer, rclone and Cyberduck, with app passwords.
- The account's time zone, used for share links that expire at the end of a day.
- File names in any language, including right-to-left scripts, still show correctly.

## 1.20.1 (2026-11-15)

A fix for the web app's new look. Nothing to do before you update.

- The checkboxes in front of files and folders (Files, Recent, Favorites, shared items, search results and Deleted
  files) are always shown again, with a clearer outline that also stands out in the dark theme. 1.20.0 showed them
  only while the mouse was over a row, so they were easy to miss.

## 1.20.0 (2026-11-15)

A new look for the web app, profile pictures, and invitations. Nothing to do before you update.

**New look**

- The web app now looks like the Cloudy website: the navigation sits on the night-sky blue of the logo, the page
  itself is quiet and white, and text is set in IBM Plex (IBM Plex Sans Arabic for Arabic). The fonts are served by
  your server; the web app still makes no requests anywhere else.
- File types have the same colours as in the Android and iPhone apps; documents, spreadsheets and presentations
  each get their own icon.
- **Settings** has tabs: *Account* (profile picture, name, email, language, time zone, storage, delete account),
  *Security* (password, passkeys, two-factor) and *Apps & devices* (WebDAV/CalDAV addresses, app passwords).
- **Administration** moved from the sidebar into the menu under your picture (top right). The menu shows your name
  and username (which opens Settings), *Administration* for administrators only, and *Log out*. Administration has
  tabs too: *Users*, *Groups*, *Email*, *Limits*. Anyone else who opens `/admin` is told the page is for
  administrators; the server refuses their requests as before.
- Press `/` anywhere to jump to the search box.

**Profile pictures**

- Everyone can add a profile picture under *Settings → Account*. The browser crops the middle of the picture to a
  square and makes it small (at most 512 px) before sending it. The server also removes what a picture says about the
  photo (place, camera, comments) before storing it, whichever app sends it: everyone signed in can see it.
- Pictures show in the top bar, in Administration, next to the people a file is shared with, and under
  *Shared with you*. Administrators can remove someone's picture under *Administration → Edit user*.

**Invitations**

- Administrators can invite people instead of choosing a username and password for them: *Administration →
  Users → Invite someone*. With email set up, the person gets an email with a link; without email, you get the link
  to send yourself. The link works once and for 7 days; the person chooses their own username and password and is
  signed in straight away.
- Invited accounts are never administrators; give the role later under *Edit user* if you want. Pending invitations
  are listed above the users, where you can send them again, make a new link or withdraw them.
- New usernames (invited or created by you) start with a letter or a digit, and can't be another account's email
  address. Existing accounts keep their names.

## 1.19.1 (2026-11-15)

A fix for invitations in the calendar. Nothing to do before you update.

- **Invitations to one meeting of a series** (synced into Cloudy by a phone's or computer's calendar app): 1.19.0
  showed them, but saving a change to one failed with "Not an event". Each such meeting now has its own address, so
  editing or deleting it changes that meeting only, also from the apps as they are. A repeat can't be set on one
  (it belongs to a series kept elsewhere); the editor says so.
- The apps that came with this release (Android 1.18.0, iPhone 1.17.0) use the server's thumbnails in their grid view,
  send the phone's time zone with new events and link end dates, and check link passwords (at least 4 characters)
  before sending them. Older app versions keep working with this server.

## 1.19.0 (2026-11-15)

A new Files page in the web app, thumbnails, time zones in the calendar, and the rest of the fixes from the full
review. Nothing to do before you update. Good to know:

- The image is about 140 MB larger (libvips, which makes the thumbnails).
- On the first start, file names are converted once to one Unicode form, and the type of files renamed in older
  versions is corrected (see *Server* below). On a large server this takes a little while before the web app answers.
- With your own PostgreSQL (`DATABASE_URL`), search ignores accents only if Cloudy may add PostgreSQL's `unaccent`
  extension (a trusted extension: the database owner may). Otherwise search works as before and the log says why.

**The Files page**

- **Dragging files in from your computer** (files or whole folders): a strip at the top names the folder they will
  go to: the folder on screen, or the folder under the pointer, which lights up. A drop anywhere in the window
  counts; one that missed the list used to open the file in the browser tab instead. Pages that take no files
  (Recent, Calendar…) say so.
- **Moving by dragging:** items dragged onto a folder, or onto a folder in the path above the list, move there. The
  message names the folder and offers *Undo*.
- **Same names:** when files with the same names are already there, you are asked once for all of them:
  *Replace*, *Keep both* or *Skip*. *Keep both* also works when a folder has the file's name.
- **List or grid, and sorting** by name, date modified or size (numbers in natural order: 2 before 10), from the
  toolbar or the column headings. Both are remembered.
- **Thumbnails** of photos (JPEG, PNG, GIF, WebP, HEIC, AVIF, TIFF) and of the first page of PDFs in the grid,
  also on public links. They are made the first time they are shown, kept in the data volume (`cache/thumbs`) and
  removed after 60 days unused.
- Big folders open at once: the rest of the list is drawn as you scroll (Ctrl+F / ⌘F draws it all, so the browser's
  find sees every name). Back returns to where you were in a folder, and so do your own changes (a rename, a star).
- In the list: Shift-click selects a range, Ctrl-click (⌘-click on a Mac) adds one item, Ctrl+A (⌘A) selects
  everything, Delete moves to the trash, F2 renames, Escape clears the selection. The list is one stop for the Tab
  key (it was three per row): the arrow keys move along it, and Shift+F10 or the menu key opens a row's actions.
- The toolbar stays in view while you scroll. Phones get one "+" button for uploading and creating.
- The upload panel folds into its header, counts the files, has *Cancel all*, and uploads empty folders too. An
  upload that ends no longer clears the items you ticked meanwhile.
- Search finds names whatever their accents (é = e) and also looks inside folders shared with you. It shows up to
  200 results and says when there are more. Search results and Recent have *Show in folder*.
- Public links: grid, thumbnails and sorting; on upload links files can be dropped anywhere on the page.
- In a folder shared with you, the sidebar marks *Shared with you*. A change to the share reaches the open folder at
  once (it becomes editable or read-only), and when the share is taken away the page says so.
- Deleting in someone else's folder says that the items go to the owner's trash, where only the owner can restore
  them (the message pointed to your own trash, where they never appear).
- A refused name says why (a slash, more than 255 characters, "." or "..", control characters).
- On phones, the date (and in Search the location, in *Shared with you* the owner) shows under each name, since
  those columns do not fit.
- The storage line in the sidebar follows changes; it was read once, at sign-in.
- Logging out while files are uploading asks first, then stops them (the upload panel stayed on the sign-in page).
- An unknown address shows "Page not found" instead of your files.

**Viewer and text editor**

- Saving a text file that someone changed after you opened it asks before overwriting their version.
- Back closes the viewer (it left the folder). Unsaved text asks before closing, also when the tab is closed.
- When your sign-in expires while you edit, you sign in again in a dialog and keep the text.
- Files that are not UTF-8 text open read-only (saving would have damaged them). A byte order mark and Windows line
  endings are kept when saving.
- The title shows "3 of 10". Videos and audio no longer start playing by themselves. A video or picture this browser
  cannot play (AVI, MKV, some phone videos) says so and offers the download.

**Calendar**

- New *Settings → Time zone* (set from your browser when you first sign in). Events made or changed in the web app keep
  their time zone, so a weekly 9:00 meeting stays at 9:00 after a daylight-saving change; they were stored in UTC.
  Changing an event keeps the times you did not touch exactly as your phone or calendar app wrote them (editing a
  series made on a phone moved it before).
- The week starts on the day usual for your language and region. *New event* starts in the month on screen.
  An event that runs past midnight shows when it ends on the next day ("– 02:00") instead of its start time again.
  A calendar that could not be loaded says so.
- An invitation to one occurrence of someone else's repeating event (stored without the series) now shows up.

**Contacts**

- Saving a contact in the web app keeps the details the form does not show (more phone and email types, labels,
  groups, other addresses, departments…). They were removed. A display name you chose ("Mom", "Dr. Anna Maria
  Meier") stays too; it was rebuilt from the first and last name at every save, also from the phone apps.
- Contacts with only a phone number or an email address can be saved.
- Importing: Outlook CSV files in German, French and Spanish, phonetic name columns ignored, folded lines in vCard
  2.1, and contacts with only a name are no longer imported twice when the same file is imported again.
- The editor asks before unsaved changes are left behind (another contact, another address book, an import, another
  page, closing the tab); on phones, *All contacts* goes back to the list.

**Sharing**

- Public links can have a label (who you sent it to, for example), shown in *Shared by you*.
- Link passwords need at least 4 characters.
- A link's expiry date now lasts until the end of that day in your time zone. It ended at midnight UTC, up to a
  day early.
- You can share with someone by their display name as well as their user name. The share dialog and *Shared by
  you* name people by their display name.

**Accessibility, phones and tablets**

- Stronger contrast for grey text, touch targets of at least 40 px, focus moves to the page after you navigate,
  and the search field shows a focus ring.
- Dates and the first day of the week follow your region: English in Britain shows 15/11/2026 and weeks starting on
  Monday (the US form was used everywhere).
- *Administration* fits a phone: *Edit* and *Delete* stay in view, Email and Groups are left out there.
- Tablets in portrait (768 px wide and more) get the sidebar instead of the phone layout.
- *Settings → Password* asks for the new password twice and can show it. Changing the language on the sign-in page
  keeps what you typed. *Sign in with a passkey* is hidden on plain IP addresses, where passkeys cannot work. When
  email is off, the *Forgot password?* page says to ask an administrator.

**WebDAV** (programs that sync or mount Cloudy)

- Programs that save by writing a temporary file and renaming it over the original (many editors, Office on a
  mapped drive) no longer replace the item: its shares, public links and favorite stay, and the old content becomes
  a version. The links stopped working before.
- `If-Match` and `If-None-Match` are honoured for uploads, deletes, moves and copies (412 when the file changed).
- `PROPFIND` with `Depth: infinity` is refused the standard way (403, `propfind-finite-depth`), and the program
  then lists folder by folder. It got one level, as if every subfolder were empty.

**Server** (for app and script developers)

- File names are stored in one Unicode form (NFC), so "é" typed on a Mac and on Windows is the same name. On the
  first start, existing names are converted once; an item whose converted name is already taken in its folder gets a
  free one, such as "Café (2).txt" (WebDAV programs could not tell the two apart). Renames and copies now update a file's type (`mime`); files renamed before get theirs on that start.
- `GET /api/nodes/:id/thumb` and `GET /api/public/:token/nodes/:id/thumb` (WebP; add `?v=<etag>` to cache it for
  good). `GET /api/me` has `thumbnails` (whether this server makes them) and `timezone`; `PATCH /api/me` takes
  `timezone`.
- Uploads accept `onConflict: "rename"` (keep both). `PUT /api/nodes/:id/content` honours `If-Match` (412).
- JSON answers and the web app's files are compressed (gzip or Brotli) when the client accepts it.
- Copying a folder takes a few database statements per folder level instead of several per item: 900 files copy
  in a quarter of a second.
- Creating a group with a name that exists answers 409 instead of an error.
- Folders can be nested at most 250 levels deep (creating, moving or copying deeper is refused): every change walks
  a folder's parents, and no computer could sync such a tree.
- Share lists (`GET /api/nodes/:id/shares`, `/api/shares/outgoing`) have `shareWithName`, the person's display name.
- Calendars and address books no longer advertise `COPY` and `MOVE` in `Allow` (they refused them).

## 1.18.1 (2026-11-15)

Security and reliability fixes from a full review of the server and the web app. **Update soon**: one of them lets
anyone who can reach the server stop it. Nothing to do before you update.

**Security and availability**

- A malformed request could stop the server, without signing in. It now gets an error answer.
- The limit on wrong passwords (10 per address, 30 per account in 15 minutes) could be outrun by sending many
  guesses at the same moment. Each guess now counts as it starts. The same applies to two-factor codes, link
  passwords and WebDAV/CalDAV/CardDAV sign-ins.
- A calendar or contacts app still holding an old password no longer locks the household out: its repeated failures
  count once, not once per sync. Confirming your password in Settings no longer counts failures from such apps.
- Some crafted inputs (a contacts import, an email address, a calendar object) could keep the server busy for
  minutes or longer, so nobody else was served. They are handled at once now.
- Copying a big folder no longer makes other people wait: copies of files are made instantly (hard links; the
  storage folder is one filesystem) instead of byte by byte while holding the folder lock.
- A request body that stops arriving is cut off after a minute. An upload chunk interrupted this way (a phone
  leaving the Wi-Fi) no longer stays "in progress" until a restart, so the retry works.
- Uploaded files are flushed to disk before they are listed. An upload resumed after a power cut continues from
  what actually reached the disk.
- Public links of a disabled account stop working while the account is disabled.
- A password reset by email now also removes the account's passkeys, as it already did its sessions and app
  passwords (whoever had the password could have added one). An administrator's reset leaves them, as before; the
  dialog's "Remove all passkeys" does that.
- People with a read-only share no longer see a file's older versions (which could hold what the owner removed
  before sharing it).
- Downloaded `.js`, `.css`, `.html`, `.svg` and `.xml` files are sent as plain files. Opening and previewing them
  works as before.
- LibreOffice (office previews) no longer receives the server's settings, such as the admin password and the
  database address, and does not load images linked from documents.
- Requests from a reverse proxy while `TRUST_PROXY` is not set are noted once in the log, with what to set.

**Fixes**

- *Move or copy* shows the folder path again (it showed `[object HTMLButtonElement]`), so you can go back up. It
  opens in the item's own folder, and inside a folder shared with you it offers your own files too.
- The selection bar stays in view below the top bar when you scroll, and no longer shows the word "false".
- Messages ("Saved", errors) are visible while the viewer or the editor is open. A failed save looked like a
  successful one.
- *Copy* (share links, WebDAV addresses) works on plain `http://` addresses other than `localhost`.
- Word, Excel and PowerPoint files on public links no longer open as unreadable text.
- Restoring an item whose name was taken meanwhile works (it failed with "Internal server error"); it comes back
  as `name (2)`, and the message says where it went.
- An upload whose last answer was lost on the network is no longer reported as failed (the file was stored).
- Live updates start again by themselves after the server or the proxy was briefly unavailable, and a folder that
  keeps changing (another device uploading many files) now refreshes while it changes.
- Arabic: phone numbers, email addresses, WebDAV addresses and codes read left to right; calendar entries are cut
  at the end of the title, not the start.
- Each page has its own tab title (it was "Files – Cloudy" everywhere).
- A storage quota of 0 means unlimited, as an empty field does. Accounts saved with 0 before could not upload
  anything although every screen said "no quota"; they become unlimited when you update (if you set 0 through the
  API to stop an account from uploading, disable the account instead).
- `PUBLIC_URL` without `http://` or `https://` in front is ignored, with a note in the log saying how to write it
  (passkeys, the email settings and password changes failed with it).
- Requests with invalid input (an empty JSON body, an over-long id, an unknown group for a new user) get a clear
  error instead of "Internal server error"; a failing hourly cleanup step no longer stops the others.

## 1.18.0 (2026-11-14)

Web app improvements. Nothing to do before you update.

- **Clean addresses, no `#`.** The web app's pages now have plain addresses: `https://cloud.example.com/`,
  `/files/12`, `/recent`, `/search?q=report`, `/settings`… instead of `/#/files/12`. Back, Forward and reload work
  as before, and a page can be opened in a new tab. Public links open their folders at `/s/<token>/<id>`. Old
  bookmarks and links with `#/…` still work and switch to the new address. Behind a reverse proxy there is nothing
  to change, as long as it passes every path to Cloudy (the usual setup).
- **Several items as one ZIP.** Selecting files and folders and choosing *Download* now gives one ZIP, named after
  their folder, instead of one download per item. Selecting everything in a folder downloads that folder's ZIP.
  Items with the same name from different folders (search results, favorites) are all kept, as `name (2)`.
- **Select in Deleted files.** Tick some items (or click their rows) and restore or delete only those, instead of
  one at a time or emptying the whole trash.
- Password reset emails link to `/reset#…`: the code after `#` never reaches the server or a proxy's access log,
  and the address bar shows just `/reset` once the page is open. Links in reset emails sent before the update
  still work.

## 1.17.0 (2026-11-14)

Shorter setup files and a hardened container. Your current `docker-compose.yml` and `.env` keep working: nothing
to do before you update. If you later switch to the new files, rename the old ones first and copy your changes
over (see the README link below): a new `docker-compose.yml` doesn't read `DATA_PATH`, `DB_PATH` or `APP_PORT`.

- **Two short files.** `docker-compose.yml` now has only the lines you might change (port, where your files and the
  database live). `.env` has who Cloudy runs as and the first administrator:
  `PUID`, `PGID`, `CLOUDY_ADMIN_USERNAME`, `CLOUDY_ADMIN_PASSWORD`. To switch, follow
  [Moving to the short compose and .env files](README.md#moving-to-the-short-compose-and-env-files-server-117).
  The old names (`APP_USER`, `ADMIN_USER`, `ADMIN_PASSWORD`) still work.
- **Hardened container.** The new `docker-compose.yml` drops every capability except `CHOWN`, `SETUID` and
  `SETGID` and sets `no-new-privileges`. The container uses them only at startup to give its folders to
  `PUID:PGID`, then runs everything as that user with no capabilities left, under `tini` as process 1. If they
  are missing, it stops with a message saying which line to add.
- **Limits in the web app.** Days in the trash, versions kept per file and how long a browser sign-in lasts are
  now under *Administration → Limits* and apply at once, without a restart. On its first start, 1.17 copies your
  `TRASH_RETENTION_DAYS`, `MAX_VERSIONS` and `SESSION_DAYS` values there (values outside 0–3650 days, 0–1000
  versions or 1–365 days are brought to the nearest end and logged). After that, change them in the web app: the
  variables no longer have an effect. Lowering a limit asks for confirmation, because it deletes older data.
- **`TRUST_PROXY` accepts addresses and CIDR ranges**, e.g. `TRUST_PROXY=172.16.0.0/12`. Forwarded headers then
  count only on connections from those addresses. `true` keeps working as before: it believes those headers from
  any client, so use it only when nothing but the proxy can reach the port.
- **The example admin password is never used.** If `CLOUDY_ADMIN_PASSWORD` is empty or still the example from
  `.env.example`, the first start generates a random password and prints it to the log.

## 1.16.2 (2026-11-11)

Security hardening in the web app, no changes to the API or the data.

- Moving files by drag and drop only accepts drags that started in Cloudy: something dragged in from another web page
  can no longer make the web app send a request to a different address on your server.
- Folder links (`#/files/<id>`) only accept numeric ids.

## 1.16.1 (2026-11-11)

Maintenance release, no changes to the API or the data.

- Updated server libraries: `pg` 8.23, `nodemailer` 10.4, `fast-xml-parser` 5.12.

## 1.16.0 (2026-11-09)

Faster syncing for the desktop app.

- Files now carry a SHA-256 of their content (`sha256` in the file JSON of folder listings, `GET /api/nodes/:id` and
  the other file lists; folders have none). It is computed while a file is uploaded, so uploads are not slower. Files
  stored by older versions are hashed in the background after the update, one at a time, so for a while after the
  first start some files show no hash yet (`null`); on large servers this can take a while and reads every file once.
- The answer to the last chunk of an upload now contains the whole file entry (etag, modified time, hash…), the same
  as a folder listing, so apps no longer need to ask for it again. Upload links still answer with name and size only.
- Older apps keep working: both are additions.

## 1.15.1 (2026-11-09)

- Removed `GET /api/diagnostics`. Only the Android app's Connection check used it, and that check is gone from
  Android 1.15. On older Android versions, the check now shows "Server too old for the full check"; everything
  else works as before.

## 1.15.0 (2026-11-06)

- No changes to the server (release process test). There is no 1.14.0.

## 1.13.0 (2026-11-04)

Security and bug fixes from a full review.

- Creating an app password, setting up two-factor sign-in and changing your email now ask for your password.
- Resetting a password (by email or by an admin) also signs out every app password of that account.
- When an account is deleted, the shares it made are removed too.
- Sign-in rate limits now also count per account and per IPv6 network, including WebDAV clients and share-link
  passwords. A correct app password is never blocked, so an old client with a wrong password can't lock out good ones.
- Upload links never overwrite a file that is already there.
- Calendar events with endless repeat rules can no longer stall the server.
- Web app: many fixes and better keyboard and screen-reader support.

## 1.12.0 (2026-11-03)

- People can delete their own account: web app → Settings, or in the Android and iPhone apps (More → Delete account).
  It removes everything, including trash, versions, shares and calendar/contact data. The last active admin can't
  delete themselves.

## 1.11.2 (2026-11-03)

- No changes to the server (release process test).

## 1.11.1 (2026-11-02)

- Many changes at the same time (uploads, renames, moves, deletes from several clients) no longer fail with
  errors; folder sizes stay correct.
- Stopping the container is faster and clean: live-update connections close and running requests finish.
- A database connection that drops no longer stops the server.
- Downloads: an aborted ZIP download no longer leaks open files; `If-Range` is supported.
- Unfinished uploads are removed one day after their last part arrived.
- File names that start or end with a space are now refused instead of being changed silently
  (some WebDAV clients kept re-uploading them).

## 1.11.0 (2026-11-02)

Security fixes and a new look.

**Before you update:** password-reset and share emails now use `PUBLIC_URL` for their links (or the address you
used when you saved the email settings), never the address of the incoming request. Set `PUBLIC_URL` in `.env`, or
open Admin → Email once from your public address and save.

- Sign-in cookies are marked `Secure` when `PUBLIC_URL` starts with `https://`.
- Brute-force limits per account, also for changing your password, turning off two-factor sign-in and adding passkeys.
- Changing your password signs out your other sessions.
- Uploads check your quota before they start, also over WebDAV.
- Office previews run with memory limits, and macros and links in documents are turned off.
- Fixed a path problem in cancelling uploads.
- New app icon and a refreshed web app.

## 1.10.3 (2026-10-27)

- Mounting Cloudy in the macOS Finder (Connect to Server, WebDAV) takes a moment instead of 90 seconds.

## 1.10.2 (2026-10-25)

- Parallel uploads into the same folder no longer get stuck (found with the new desktop app).

## 1.10.1 (2026-10-25)

- Web app: select several files at once (long-press on touch screens, right-click or ⋯ → Select) and move, copy,
  download, favorite or delete them together.

Older versions: see the [git history](https://github.com/Fahed-Alhammadi/Cloudy/commits/main/server).
