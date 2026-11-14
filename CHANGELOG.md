# Changelog: Cloudy server

What changed in each version of the server (the container image `ghcr.io/fahed-alhammadi/cloudy`), newest first.
Read it before you update:

```sh
docker compose pull && docker compose up -d
```

Sections marked **Before you update** need an action from you. The apps (Android, iPhone, desktop) ship through
their stores and the [releases page](https://github.com/Fahed-Alhammadi/Cloudy/releases), each with its own notes.
Newer apps work with older servers and the other way round.

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
