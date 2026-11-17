# Cloudy for Android

A native Android app (Kotlin, Jetpack Compose) for your Cloudy server. Requires Android 8.0 or newer.

**Features:**
- Browse, search, upload and download files, including photos and videos from the device. Other apps can share
  files to Cloudy.
- Preview images, video, audio, PDF and text; open other files with any installed app.
- Rename, move, copy, delete and favorite files, and use the trash.
- Share by public link (with optional password) or with people and groups.
- Keep files and folders **available offline**. They're downloaded and refreshed when they change.
- **Photo backup:** new camera-roll photos and videos upload to a folder (default `Camera Uploads`), Wi-Fi only
  if you choose.
- **Recent** and **Shared** tabs: the files you opened lately, and everything shared with you.
- **Document scanner** to PDF, grid view, search filters, app lock, a list of signed-in devices.
- Installed and updated through Google Play.

## Sign-in

Enter the server address, username and password, plus a code from your authenticator app if the account
uses two-factor authentication (the field appears when needed). The password is exchanged for a device token stored in
app-private storage. Each device appears on the web under *Settings → Devices*; revoke it there to sign
a lost phone out.

On a local network, use the server's IP and port, e.g. `http://192.168.1.10:8080`. Plain HTTP is allowed so this
works. Use HTTPS in production, and turn off plain HTTP in `res/xml/network_security_config.xml`.

## Build

You need JDK 17+ (e.g. `brew install openjdk@21`) and the Android SDK (platform 36) with
`sdk.dir` in `android/local.properties` or `ANDROID_HOME`.

```sh
android/build-apk.sh        # → dist/: Google Play bundle (.aab) + .apk for adb testing
cd android && ./gradlew assembleDebug   # debug build (io.cloudy.app.debug, installs next to the Play version)
```

## Code map

| Path | What it does |
|---|---|
| `data/Api.kt` | JSON API client (OkHttp, bearer token) |
| `data/Session.kt` | Server address, token and user |
| `data/Offline.kt` | Pinned files and cached folder listings |
| `work/Workers.kt` | Background jobs: photo backup, offline sync |
| `ui/*Screen.kt` | Compose screens |
