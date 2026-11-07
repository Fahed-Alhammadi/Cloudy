---
layout: default
title: Support
description: Help with the Cloudy server and the apps for Android, iPhone, Mac, Windows and Linux.
---

# Support

Help with the Cloudy server and the apps.

## Signing in

The apps connect to a Cloudy server that you, your company or someone you trust runs. There is no sign-up: the
server's admin creates your account. Enter the server's address (for example `https://cloud.example.com`), your
username and your password. If you don't have a server yet, the [install guide](https://github.com/Fahed-Alhammadi/Cloudy#install)
sets one up in a few minutes.

If the app can't reach your server:

- Check that the address opens in your phone's or computer's browser.
- From outside your home network, the server needs HTTPS through a reverse proxy
  ([how to set it up](https://github.com/Fahed-Alhammadi/Cloudy#production)).
- On Android, *More → Connection check* tests the server and the proxy and says how to fix what fails.

Forgot your password? Use *Forgot password* on the web sign-in page if your server sends email, or ask the server's admin
to reset it.

## Updating

- **Android and iPhone:** updated by Google Play and the App Store (TestFlight during the iPhone beta).
- **Mac, Windows and Linux:** the app checks for new versions once a day and downloads them by itself. On a Mac the
  update is installed when you restart or quit Cloudy; on Windows and Linux choose *Restart to update* in the menu.
  *Settings → Check for updates* checks right away.
- **Server:** run `docker compose pull && docker compose up -d`. Read [what changed](https://github.com/Fahed-Alhammadi/Cloudy/blob/main/CHANGELOG.md)
  first: some versions ask you to change a setting.

## Deleting your account

In the web app open *Settings*, or in the phone apps *More → Delete account*, and confirm with your password. This
deletes your files, calendars, contacts and shares from the server. Details are in the
[privacy policy](privacy-policy.html#deleting-your-account).

## Reporting a problem

Report bugs and ask questions in [GitHub Issues](https://github.com/Fahed-Alhammadi/Cloudy/issues). Say which app and
version you use (shown in the app's settings) and what you expected to happen. Please don't include passwords, server
addresses or personal files.

For anything you'd rather not post publicly, email [alhammadi.team@gmail.com](mailto:alhammadi.team@gmail.com).
