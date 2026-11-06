# Changelog: Cloudy server

What changed in each version of the server (the container image `ghcr.io/fahed-alhammadi/cloudy`), newest first.
Read it before you update:

```sh
docker compose pull && docker compose up -d
```

Sections marked **Before you update** need an action from you. The apps (Android, iPhone, desktop) ship through
their stores and the [releases page](https://github.com/Fahed-Alhammadi/Cloudy/releases), each with its own notes.
Newer apps work with older servers and the other way round.

## 1.15.0 (2026-11-06)

- No changes to the server. From this version on, every Cloudy product shares one version number, so the server
  goes from 1.13.0 to 1.15.0.

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
