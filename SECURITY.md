# Security Policy

Cloudy stores people's files, calendars and contacts, so security reports get priority. Thank you for helping
keep Cloudy and its users safe.

## Supported versions

Only the latest release of each product gets security fixes. Please update before you report, and check that the
problem still exists there.

| Product | Supported | Where to get it |
|---|---|---|
| Server (container image) | Latest release | `ghcr.io/fahed-alhammadi/cloudy:latest`, notes in [CHANGELOG.md](CHANGELOG.md) |
| Android app | Latest release | Google Play |
| iPhone app | Latest release | App Store / TestFlight |
| Desktop app (macOS, Windows, Linux) | Latest release | [Releases](https://github.com/Fahed-Alhammadi/Cloudy/releases/latest) (updates itself) |

Server updates: `docker compose pull && docker compose up -d`.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/Fahed-Alhammadi/Cloudy/security/advisories/new)
(Security tab → *Report a vulnerability*). Only the maintainer can see it.

Please include:

- the product and version (the server prints `Cloudy X.Y.Z listening…` at start: `docker logs cloudy | grep listening`);
- what an attacker can do, and what access they need (none, a link, a normal account, an admin account);
- steps to reproduce, ideally against a fresh test server;
- any proof-of-concept code or requests.

Please **don't** include real passwords, tokens, server addresses or other people's files. Test only against
servers and accounts you own.

## What happens next

- You get an answer within a few days, saying whether the report is confirmed.
- Confirmed issues are fixed in a new release of the affected product, usually together with a GitHub security
  advisory. Server fixes are listed in [CHANGELOG.md](CHANGELOG.md), with a "Before you update" note when admins
  must act.
- With your permission, you're credited in the advisory.
- Please keep the details private until a fixed release is out.

## Scope

In scope:

- the server: JSON API, WebDAV/CalDAV/CardDAV, public share links, sign-in (passwords, two-factor codes,
  passkeys, app passwords), office previews;
- the web app served by the server;
- the Android, iPhone and desktop apps;
- the container image and its start-up script;
- the release workflows in this repository.

Out of scope:

- problems that need an admin account to harm the same server (admins already control it);
- servers that ignore the setup advice below, for example served over plain HTTP on the internet or with
  `TRUST_PROXY=true` and no proxy in front;
- your reverse proxy, TLS setup, mail server or operating system;
- denial of service through sheer traffic volume;
- reports from automated scanners without a working example.

## Running Cloudy safely

Cloudy is self-hosted, so the admin's setup matters as much as the code:

- **Use HTTPS.** Put Cloudy behind a reverse proxy with TLS (see *Production* in the [README](README.md)), set
  `PUBLIC_URL` to the `https://` address, and set `TRUST_PROXY=true` only when that proxy is in front.
- **Don't expose the HTTP port directly.** With the proxy on the same host, set `APP_BIND=127.0.0.1`.
- **Set a strong `ADMIN_PASSWORD`** before the first start (otherwise a random one is printed once to the logs).
- **Turn on two-factor authentication or passkeys** for the admin account.
- **Keep the server updated**, and read the changelog before you update.
- **Back up** the database and the files together, and keep the backups private: they contain everyone's data.
- **Keep `.env` private.** It holds your passwords; never commit it or share it.
