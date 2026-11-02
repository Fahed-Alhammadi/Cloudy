---
title: Privacy Policy
---

# Privacy Policy

Last updated: November 2, 2026

This privacy policy explains how the **Cloudy** apps for Android (package `io.cloudy.app`), iPhone (bundle ID `io.cloudy.app`) and
desktop computers (macOS, Windows and Linux, `io.cloudy.desktop`) handle your information.
The table below describes the Android app; the [iPhone app](#iphone-app) and [desktop app](#desktop-app) sections list where they differ.
Cloudy is developed by Fahed Alhammadi ("we", "us"). The source code is public at
<https://github.com/Fahed-Alhammadi/Cloudy>.

## In short

- Cloudy is an app for **your own Cloudy server**, which you, your company or someone you trust runs ("self-hosted").
  The app sends your data only to the server address you enter when you sign in.
- **We, the developer, do not run that server and do not receive, collect, store or sell your data.**
- The app contains **no advertising, no analytics and no tracking**. The optional document scanner is provided by Google Play
  services (see below).

## Who is responsible for your data

Your files, photos, calendars, contacts and account live on the Cloudy server you sign in to. The person or organization that operates that server (the "server operator") decides how that data is stored, backed up and deleted, and is responsible for it. If you have questions about the data on a server, contact its operator. If you run your own server, that is you.

## What the app accesses and why

| Information | When and why | Where it goes |
|---|---|---|
| **Server address, username and password** | When you sign in. The password (and, if you use two-factor authentication, the one-time code) is sent once to your server, which returns a device token. The password is not stored on the phone. | Your server only |
| **Device token** | Kept so you stay signed in. You can see and revoke it in Cloudy's web interface (Settings → App passwords). | Stored in the app's private storage on your phone |
| **Device name** (manufacturer and model, e.g. "Samsung SM-S911B") | Sent at sign-in to label the device token, so you can recognize it in the list of signed-in devices. | Your server only |
| **Files and folders** | When you browse, open, upload, download, share, rename, move or delete files, edit text files, or mark files "available offline". Office documents are converted for preview by your server. | Your server; offline copies and temporary previews are stored in the app's private storage. When you use **Send to…**, the file goes to the app you pick (for example WhatsApp or email) |
| **Photos and videos** (permission: *Photos and videos*) | Only if you turn on **Photo backup**. The app then reads photos and videos from your gallery and uploads new ones to your server in the background. You can also pick individual photos or videos to upload. | Your server only |
| **Calendar events** | Events you view, create, edit or delete in the app. | Your server only |
| **Contacts** | Contacts you view, create, edit or delete in the app, and contacts in a file (.vcf or .csv) that **you** choose to import. The app does **not** read your phone's address book and does not request the Contacts permission. Exported contacts go only where you choose in the share sheet. | Your server only |
| **Document scans** | Only when you tap **Scan document**. The scanner is Google's ML Kit document scanner, which runs inside Google Play services: it opens the camera in its own screen and processes the pages on your phone. The app itself has no camera permission and receives only the finished PDF, which it uploads to the folder you chose. Google Play services may send diagnostic and usage information about the scanner to Google ([Google's privacy policy](https://policies.google.com/privacy)). | The PDF goes to your server only |
| **App lock** | Only if you turn on **App lock**. Android asks for your fingerprint, face or screen lock; the app only learns whether it succeeded and never sees biometric data. | Stays on your phone |
| **Language** | The language you choose in the app. It is also saved in your account on your server, so the web interface and emails use it. | Stored on your phone and your server |
| **Network state** | To run photo backup and offline sync only on the network you allow (for example Wi-Fi only). | Stays on your phone |

The app does **not** request access to your location, camera, microphone, phone calls, SMS or phone contacts (the document scanner uses the camera through Google Play services, as described above), and it does not collect advertising IDs or device identifiers.

When you open the app for the first time, a welcome screen explains these uses and lets you grant the *Photos and videos* permission right away or later; you can change it any time in Android's app settings.

## iPhone app

The iPhone app works like the Android app above, with these differences:

- **Device name:** the iPhone model (for example "iPhone (iPhone17,1)") labels the device token. The phone's own name is not sent.
- **Device token:** stored in the iOS Keychain on this device only. It is not synced to iCloud Keychain or included in backups to other devices.
- **Photos and videos:** you pick them with the system photo picker, so the app only receives the items you select. It cannot read your
  photo library and has no photo backup. If you save a file to Photos from the share sheet, iOS asks for permission to *add* to your library.
- **Files:** downloaded copies for preview and sharing are kept in the app's cache, which iOS may clear at any time. Signing out deletes them.
- **Document scans** use Apple's built-in document camera (VisionKit). The camera is used only while you scan; pages are processed on the
  iPhone and only the finished PDF is uploaded to your server. No Google services are used.
- **App lock** uses Face ID, Touch ID or your passcode through iOS. The app only learns whether it succeeded.
- **Language** is chosen in the iOS Settings app (Settings → Cloudy → Language) and stays on the phone.
- **Share to Cloudy:** the app's share extension appears in other apps' share sheets. The files you choose there are uploaded to your
  server with the same device token as the app, into the folder you pick; the extension reads nothing else and keeps no copy.
- **Local network:** iOS may ask to allow access to devices on your local network. This is only used to reach a Cloudy server at a local address.
- **First launch:** a welcome screen lets you answer the iOS permission dialogs (local network, camera, photos, Face ID) before you sign in,
  so your first sign-in to a server on your network works right away. Each one is optional and can be changed later in the iOS Settings app.
  To show the local-network dialog the app briefly announces and looks for a Bonjour service named `_cloudy._tcp` on your network; nothing
  is sent to your server or anyone else.
- The app contains no advertising, analytics or tracking, and does not use Apple's advertising identifier. Apple's privacy policy applies
  to the App Store.

## Desktop app

The desktop app (macOS, Windows, Linux) only syncs files; it has no calendar, contacts, photo backup or scanner. Where it differs:

- **Files:** it keeps a folder you choose on your computer in sync with your files on your server: new and changed files are uploaded,
  changes on the server are downloaded, and deletions on either side are repeated on the other (to the server's trash or your
  computer's trash). It reads only that folder, and only the server folders you leave selected are copied to your computer.
- **Device name:** your computer's name (for example "Desktop (my-laptop)") labels the device token on your server.
- **Device token:** encrypted with your operating system's keychain (Keychain on macOS, the Windows data protection API, the Secret
  Service on Linux) and stored with the app's settings on this computer. Signing out revokes it on the server.
- **Language** follows your account's language on your server, else your computer's.
- **Updates:** see below. There is no advertising, analytics or tracking.

## App updates

The Android and iPhone apps are updated by Google Play and the App Store; they do not check for or download updates themselves. Google's and Apple's privacy policies apply to their stores.

The desktop app checks for a new version once a day (and when you click *Check for updates*) by asking GitHub for the list of
Cloudy releases, and downloads new versions from GitHub. These requests carry no account or file information; like any website,
GitHub sees your IP address and the app's name and version ([GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).

## Sharing of information

We do not sell, rent or share your information with anyone, and we do not have access to it. The apps send data only to:

- the Cloudy server you sign in to (see above);
- Google Play services, only when you use the document scanner (see above);
- GitHub, only for the desktop app's update check and downloads (see [App updates](#app-updates)).

When you share a file or a link, or export contacts, the information goes only to the people or apps you choose.

Your server operator may set up email so the server can send messages such as password reset links or "a file was shared with you" notices. Those emails are sent by your server, using the email address in your Cloudy profile, through the mail service the operator chooses.

## Security

- The app talks to your server over the address you enter. **Use an `https://` address**: the connection is then encrypted in transit (TLS). Plain `http://` is only meant for servers on a private home or office network.
- The device token and offline files are kept in the app's private storage, which other apps cannot read. The app opts out of Android cloud backup, so this data is not copied to a backup service.
- Your server stores passwords only as one-way hashes, and supports two-factor authentication and passkeys.

## Keeping and deleting your information

- **On your phone:** signing out removes the device token and revokes it on the server. Uninstalling the app (or, on Android, *Settings → Apps → Cloudy → Clear storage*) deletes everything the app stored on the phone, including offline copies.
- **On your server:** you can delete your own files, calendars and contacts in the app or the web interface. Deleted files go to the trash first, and the server deletes them permanently after a retention period that the operator sets (30 days by default).
- **Your account:** Cloudy accounts are created by the server operator, not in the app. To delete your account and all its data, ask your server operator, who can do it under *Administration → Users*. If you run the server, you can do it yourself.

## Children

Cloudy is not directed at children under 13 and we do not knowingly collect information from children. Accounts are created and managed by the server operator.

## Changes to this policy

If this policy changes, we will update this page and the "Last updated" date above. Significant changes will also be mentioned in the app's release notes.

## Contact

Questions about this policy or the app:

- Email: [alhammadi.team@gmail.com](mailto:alhammadi.team@gmail.com)
- GitHub: <https://github.com/Fahed-Alhammadi/Cloudy/issues>

For questions about the data stored on a particular Cloudy server, contact that server's operator.
