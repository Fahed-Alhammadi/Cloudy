// Cloudy desktop: a tray (menu bar) app that keeps one local folder in sync with the user's Cloudy files.
// The settings window (src/ui) talks to this process through the `cloudy` IPC channel (src/preload/preload.ts).
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, Notification, powerMonitor, net } from 'electron';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { Api, ApiError, normalizeServer } from './api.ts';
import { SyncEngine, stateFitsServer, type Status, type Activity, type Problem } from './sync.ts';
import { loadSettings, saveSettings, encodeToken, decodeToken, loadState, saveState, clearState, type Settings } from './store.ts';
import { t, setLanguage, language, isRtl, strings } from './i18n.ts';
import { Updater, type UpdateState } from './updater.ts';

const OUT = __dirname; // out/ (bundled main.cjs, preload.cjs, ui/, i18n/, icons/)
const userAgent = `Cloudy Desktop/${app.getVersion()} (${process.platform})`;

let settings: Settings;
let engine: SyncEngine | null = null;
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let updater: Updater;
let problems: Problem[] = [];

// Development runs can use a separate profile: CLOUDY_USER_DATA=/tmp/cloudy-test npm start
if (!app.isPackaged && process.env.CLOUDY_USER_DATA) app.setPath('userData', process.env.CLOUDY_USER_DATA);
// A second copy only brings the first one's window to the front. (`quit` is asynchronous: `ready` can still fire,
// so the start-up below is guarded too.)
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else app.on('second-instance', () => showWindow());
if (process.platform === 'win32') app.setAppUserModelId('io.cloudy.desktop'); // notifications under the Start-menu shortcut's identity
app.on('window-all-closed', () => { /* keep running in the tray */ });

// A tray app must not die (or show Electron's error dialog) over one failure somewhere: log it and keep going.
// Example: Node's recursive fs.watch on Linux throws ENOSPC/EMFILE from inside its own watcher when the inotify
// limits are reached; the engine then falls back to scanning on a timer.
function uncaught(kind: string, e: unknown): void {
  console.error(`Cloudy: ${kind}:`, e);
  const err = e as NodeJS.ErrnoException | undefined;
  if ((err?.code === 'ENOSPC' || err?.code === 'EMFILE') && /watch/i.test(`${err.syscall ?? ''} ${err.message ?? ''}`)) {
    try { engine?.watcherFailed(); } catch {}
  }
}
process.on('uncaughtException', (e) => uncaught('uncaught exception', e));
process.on('unhandledRejection', (e) => uncaught('unhandled rejection', e));

/** Account language, else the system's (preferred languages work even when Electron's own locale files were left out). */
const applyLanguage = () => setLanguage(path.join(OUT, 'i18n'), settings.language, app.getLocale(), ...app.getPreferredSystemLanguages());

// Electron's fetch goes through Chromium: the system proxy and the OS certificate store (company CAs) work like in a browser.
const api = () => new Api(settings.server!, decodeToken(settings) ?? '', userAgent, net.fetch);
const signedIn = () => !!(settings.server && decodeToken(settings) && settings.rootId);
const configured = () => signedIn() && !!settings.folder;

function messages() {
  return {
    incomplete: t('The download was incomplete. It is tried again.'),
    outside: t('Its folder links to a place outside the sync folder'),
    case: t('Another item has the same name with different upper/lower case'),
    windowsName: t('The name is not allowed on Windows'),
    badName: t('The name is not allowed'),
    spaces: t('Names cannot start or end with a space'),
    noParent: t('Its folder is not on the server yet'),
    locked: t('The file is in use by another program'),
  };
}

// ---------------------------------------------------------------- sync engine

/** `save`: the same account and folder go on later (quit, sign in again), so keep what the running cycle finished. */
async function stopEngine(save = false): Promise<void> {
  const e = engine;
  engine = null;
  await e?.stop({ save });
}

async function startEngine(): Promise<void> {
  await stopEngine();
  if (!configured()) return refresh();
  const state = await loadState();
  // Only a fresh start gets its folder created. Once something was synced, a missing folder means a disk that is not
  // mounted or a folder that was moved: syncing a new, empty one would delete everything on the server.
  if (!state?.base || !Object.keys(state.base).length) await mkdir(settings.folder!, { recursive: true }).catch(() => {});
  engine = new SyncEngine({
    api: api(),
    root: settings.folder!,
    rootId: settings.rootId!,
    excluded: settings.excluded,
    state,
    saveState,
    trash: async (file) => {
      try {
        await shell.trashItem(file);
      } catch {
        await rm(file, { recursive: true, force: true }); // no trash (some Linux desktops): it is in the server trash
      }
    },
    confirmDeletes: async (count, where) => {
      if (process.platform === 'darwin') app.focus({ steal: true }); // a menu bar app: the question must not hide behind other windows
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: where === 'local'
          ? t('{count} files were deleted on the server. Delete them on this computer too?', { count })
          : t('{count} files were deleted on this computer. Delete them on the server too?', { count }),
        detail: t('Deleted files go to the trash and can be restored.'),
        buttons: [t('Delete'), t('Keep the files')],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    conflictLabel: t('conflicted copy'),
    messages: messages(),
  });
  // UI failures (a window closing mid-send) must never reach the engine's cycle: the handlers swallow them.
  let lastPhase = '';
  engine.on('status', (s: Status) => {
    try {
      if (s.phase === 'auth' && lastPhase !== 'auth') notify(t('Cloudy signed you out'), t('Sign in again to keep your files in sync.'));
      lastPhase = s.phase;
      refresh();
    } catch {}
  });
  engine.on('activity', (a: Activity) => {
    try {
      if (a.kind === 'conflict') notify(t('Edited in two places'), t('Kept both versions of {name}.', { name: path.basename(a.path) }));
      activityChanged = true;
      scheduleSend();
    } catch {}
  });
  engine.on('problems', (p: Problem[]) => { problems = p; try { refresh(); } catch {} });
  engine.on('kept', (folder: string) => {
    try {
      notify(t('"{name}" was kept on this computer', { name: folder }),
        t('It has changes that are not on the server yet. It is no longer synced; move what you need elsewhere.'));
    } catch {}
  });
  engine.start();
  if (settings.paused) engine.pause();
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

/** A second line under the status: what to do about it, or the error behind "Offline". */
function statusDetail(): string | null {
  const s = engine?.status;
  if (!s) return null;
  if (s.phase === 'error' && s.code === 'missing-folder') return t('Connect the disk it is on, or choose the folder again under Settings.');
  if (s.phase === 'offline') return s.error ?? null;
  return null;
}

function statusText(): string {
  if (!signedIn()) return t('Not signed in');
  if (!settings.folder) return t('Choose a folder to sync');
  const s = engine?.status;
  if (!s) return t('Starting…');
  switch (s.phase) {
    case 'auth': return t('Signed out: sign in again');
    case 'offline': return t('Offline: will retry');
    case 'paused': return t('Paused');
    case 'error':
      if (s.code === 'missing-folder') return t('Sync folder not found');
      if (s.code === 'remote-missing') return t('The Cloudy folder no longer exists on the server');
      return t('Problem: {message}', { message: s.error ?? '' });
    case 'syncing': return s.total ? t('Syncing {done} of {total}', { done: s.done, total: s.total }) : t('Checking for changes…');
    default: return problems.length ? t('{count} items could not be synced', { count: problems.length }) : t('Up to date');
  }
}

// ---------------------------------------------------------------- tray

// Just the cloud, monochrome like the system's own icons. macOS: an 18 pt template image (the "Template" suffix
// makes it one), which the menu bar tints white or black to match itself. Windows/Linux: a white cloud.
function trayIcon() {
  const name = process.platform === 'darwin' ? 'trayMacTemplate.png' : 'tray.png';
  return nativeImage.createFromPath(path.join(OUT, 'icons', name));
}

// While syncing, the engine reports several status changes per file. The window gets at most ~4 updates a second and
// the tray menu at most one; each is a trailing timer, so the last state always arrives.
const SEND_MS = 250;
const MENU_MS = 1000;
let sendTimer: NodeJS.Timeout | null = null;
let lastSend = 0;
let menuTimer: NodeJS.Timeout | null = null;
let lastMenu = 0;

function refresh(): void {
  scheduleSend();
  if (menuTimer) return;
  menuTimer = setTimeout(() => { menuTimer = null; lastMenu = Date.now(); buildMenu(); }, Math.max(0, lastMenu + MENU_MS - Date.now()));
}

let menuKey = '';
let tooltip = '';

function buildMenu(): void {
  if (!tray) return;
  const text = statusText();
  if (text !== tooltip) tray.setToolTip(`Cloudy: ${(tooltip = text)}`);
  const u = updater?.state;
  // Rebuilding a native menu is not free: only when something it shows changed.
  const key = JSON.stringify([text, language(), !!settings.folder, !!settings.server, !!engine, engine?.isPaused,
    u?.state, u && 'version' in u ? u.version : null, u && 'url' in u ? u.url : null]);
  if (key === menuKey) return;
  menuKey = key;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: text, enabled: false },
    { type: 'separator' },
    { label: t('Open Cloudy folder'), enabled: !!settings.folder, click: () => void shell.openPath(settings.folder!) },
    { label: t('Open Cloudy in the browser'), enabled: !!settings.server, click: () => void shell.openExternal(settings.server!) },
    { type: 'separator' },
    { label: t('Sync now'), enabled: !!engine && !engine.isPaused, click: () => engine?.rescan() },
    engine?.isPaused
      ? { label: t('Resume syncing'), click: () => void setPaused(false) }
      : { label: t('Pause syncing'), enabled: !!engine, click: () => void setPaused(true) },
    { type: 'separator' },
    { label: t('Settings…'), click: () => showWindow() },
  ];
  if (u?.state === 'ready') items.push({ label: t('Restart to update to {version}', { version: u.version }), click: () => void installUpdate() });
  else if (u?.state === 'available' && /^https:\/\/github\.com\//.test(u.url)) items.push({ label: t('Download Cloudy {version}…', { version: u.version }), click: () => void shell.openExternal(u.url) });
  items.push({ type: 'separator' }, { label: t('Quit Cloudy'), role: 'quit' });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function setPaused(paused: boolean): Promise<void> {
  settings.paused = paused;
  await saveSettings(settings);
  if (paused) engine?.pause();
  else engine?.resume();
  refresh();
}

// ---------------------------------------------------------------- window

function showWindow(): void {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 460,
    minHeight: 520,
    title: 'Cloudy',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(OUT, 'icons', 'icon.png'),
    webPreferences: { preload: path.join(OUT, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  // The window needs no camera, notifications, clipboard reading…: every permission request is refused.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.removeMenu();
  win.on('closed', () => {
    win = null;
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
    if (process.platform === 'darwin') app.dock?.hide();
  });
  win.once('ready-to-show', () => { win?.show(); if (process.platform === 'darwin') app.focus({ steal: true }); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url) || (settings.server && url.startsWith(settings.server + '/'))) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.platform === 'darwin') void app.dock?.show();
  void win.loadFile(path.join(OUT, 'ui', 'index.html'));
}

const hasWindow = () => !!win && !win.isDestroyed();

function send(data: object): void {
  if (hasWindow()) win!.webContents.send('cloudy:update', data);
}

function scheduleSend(): void {
  if (!hasWindow() || sendTimer) return; // no window: nothing to build (it asks for the whole state when it opens)
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSend = Date.now();
    send(update());
  }, Math.max(0, lastSend + SEND_MS - Date.now()));
}

// What the window already has: the large parts are sent again only when they changed (the window merges updates
// into its state). Reset when the window asks for the whole state.
let sent: { strings?: object; problems?: Problem[]; engine?: SyncEngine | null } = {};
let activityChanged = false;

/** The window's state; the translations, problems and activity only when they changed since the last message. */
function update() {
  const { strings: dict, problems: list, activity, ...rest } = snapshot();
  const out: Partial<ReturnType<typeof snapshot>> = rest;
  if (dict !== sent.strings) out.strings = sent.strings = dict;
  if (list !== sent.problems) out.problems = sent.problems = list;
  if (activityChanged || engine !== sent.engine) out.activity = activity;
  activityChanged = false;
  sent.engine = engine;
  return out;
}

function snapshot() {
  return {
    signedIn: signedIn(),
    configured: configured(),
    server: settings.server,
    user: settings.user,
    displayName: settings.displayName,
    folder: settings.folder,
    excluded: settings.excluded,
    openAtLogin: settings.openAtLogin,
    paused: settings.paused,
    status: engine?.status ?? null,
    statusText: statusText(),
    statusDetail: statusDetail(),
    activity: engine?.activity ?? [],
    problems,
    update: updater?.state,
    version: app.getVersion(),
    lang: language(),
    rtl: isRtl(),
    strings: strings(),
    defaultFolder,
  };
}

/** ~/Cloudy, or ~/Cloudy Files (2, 3…) when that already exists with other things in it. */
let defaultFolder = path.join(homedir(), 'Cloudy');
async function pickDefaultFolder(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const p = path.join(homedir(), i === 0 ? 'Cloudy' : i === 1 ? 'Cloudy Files' : `Cloudy Files ${i}`);
    const names = await readdir(p).catch(() => null);
    if (!names || !names.some((n) => !n.startsWith('.'))) { defaultFolder = p; return; }
  }
}

// ---------------------------------------------------------------- login item

async function applyOpenAtLogin(): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'linux') {
    const dir = path.join(homedir(), '.config', 'autostart');
    const file = path.join(dir, 'cloudy.desktop');
    if (!settings.openAtLogin) return rm(file, { force: true });
    const exec = process.env.APPIMAGE ?? process.execPath;
    await mkdir(dir, { recursive: true });
    await writeFile(file, `[Desktop Entry]\nType=Application\nName=Cloudy\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
  } else {
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
  }
}

// ---------------------------------------------------------------- IPC

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Checks a folder chosen for syncing: not the home folder or a whole drive, and not where Cloudy keeps its own data. */
function badFolder(folder: string): string | null {
  const p = path.resolve(folder);
  if (p === path.parse(p).root || p === homedir()) return t('Choose a folder inside your home folder, not the whole drive or home folder.');
  const data = app.getPath('userData');
  if (inside(p, data) || inside(data, p)) return t('Choose another folder: this one holds Cloudy’s own settings.');
  return null;
}

// IPC arguments come from the window: checked before use, whatever the window sends.
const str = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('bad argument');
  return v;
};
const absPath = (v: unknown): string => {
  const p = str(v);
  if (!path.isAbsolute(p) || p.includes('\0')) throw new Error('bad argument');
  return path.resolve(p);
};
/** Top-level folder names for selective sync: plain names only (they become paths under the sync folder). */
const folderNames = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > 10_000) throw new Error('bad argument');
  return [...new Set(v.map((n) => {
    const s = str(n, 1024);
    if (!s || s === '.' || s === '..' || /[\/\\\0]/.test(s)) throw new Error('bad argument');
    return s;
  }))];
};

const handlers: Record<string, (...args: any[]) => unknown> = {
  state: () => {
    const s = snapshot();
    sent = { strings: s.strings, problems: s.problems, engine };
    activityChanged = false;
    return s;
  },

  async login(server: unknown, user: unknown, password: unknown, code?: unknown) {
    try {
      const url = normalizeServer(str(server, 2048));
      const r = await Api.login(url, str(user, 256).trim(), str(password, 1024), code ? str(code, 64) : undefined, `Desktop (${hostname()})`, userAgent, net.fetch);
      // Signing in again after being signed out keeps the folder and its sync state; another account starts over
      // (its files must not be merged with this folder without asking).
      if (settings.folder && (settings.server !== url || settings.user !== r.user.id || settings.rootId !== r.user.rootId)) {
        await stopEngine();
        await clearState();
        settings.folder = undefined;
        settings.excluded = [];
      } else if (settings.folder) {
        // Same account: keep the state only if it still describes this server (not a reset one that reuses ids).
        await stopEngine();
        const fresh = new Api(url, r.token, userAgent, net.fetch);
        if (!(await stateFitsServer(fresh, await loadState()).catch(() => false))) await clearState();
      }
      settings.server = url;
      settings.user = r.user.id;
      settings.displayName = r.user.displayName;
      settings.rootId = r.user.rootId;
      settings.language = r.user.language ?? null;
      encodeToken(settings, r.token);
      applyLanguage();
      await saveSettings(settings);
      if (settings.folder) await startEngine();
      refresh();
      return { ok: true };
    } catch (e: any) {
      if (e instanceof ApiError) return { error: e.message, twoFactor: !!e.body?.twoFactor };
      if (e?.message === 'HTTPS_REQUIRED') return { error: t('Use an https:// address. Plain http:// only works for a server on your local network.') };
      return { error: t('Could not reach the server: {message}', { message: e?.cause?.message ?? e?.message ?? String(e) }) };
    }
  },

  /** Top-level server folders, for choosing what to sync. */
  async folders() {
    const r = await api().node(settings.rootId!);
    return (r.children ?? []).filter((c) => c.isDir).map((c) => c.name).sort((a, b) => a.localeCompare(b));
  },

  async chooseFolder() {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: t('Choose the folder to keep in sync'),
      defaultPath: settings.folder ?? homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  },

  /** First setup, or a new local folder: syncing starts over (files already there are compared, not overwritten). */
  async setup(rawFolder: unknown, rawExcluded: unknown) {
    if (!signedIn()) return { error: t('Not signed in') };
    const folder = absPath(rawFolder);
    const excluded = folderNames(rawExcluded);
    const bad = badFolder(folder);
    if (bad) return { error: bad };
    if (settings.folder !== folder) {
      await stopEngine(); // the old engine must not save its state again
      await clearState();
      await mkdir(folder, { recursive: true });
    } else if (!(await lstat(folder).catch(() => null))?.isDirectory()) {
      // The same folder, with its sync history: never recreated empty (that would delete everything on the server).
      return { error: t('Sync folder not found') };
    }
    settings.folder = folder;
    settings.excluded = excluded;
    await saveSettings(settings);
    await applyOpenAtLogin();
    await startEngine();
    return { ok: true };
  },

  async folderHasFiles(folder: unknown) {
    return (await readdir(absPath(folder)).catch(() => [])).some((n) => !n.startsWith('.'));
  },

  async setExcluded(raw: unknown) {
    const excluded = folderNames(raw);
    settings.excluded = excluded;
    await saveSettings(settings);
    await engine?.setExcluded(excluded);
    refresh();
  },

  async setOpenAtLogin(on: unknown) {
    if (typeof on !== 'boolean') throw new Error('bad argument');
    settings.openAtLogin = on;
    await saveSettings(settings);
    await applyOpenAtLogin();
  },

  pause: () => setPaused(true),
  resume: () => setPaused(false),
  syncNow: () => engine?.rescan(),
  openFolder: () => settings.folder && shell.openPath(settings.folder),
  openWeb: () => settings.server && shell.openExternal(settings.server),
  openRelease: () => updater.state.state === 'available' && /^https:\/\/github\.com\//.test(updater.state.url) && shell.openExternal(updater.state.url),
  checkUpdates: () => updater.check(),
  installUpdate: () => installUpdate(),

  /** Signed out by the server (token revoked or expired): sign in again, keeping the folder and what was synced. */
  async signInAgain() {
    await stopEngine(true);
    settings.token = undefined;
    settings.tokenEncrypted = undefined;
    await saveSettings(settings);
    problems = [];
    refresh();
  },

  async logout() {
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      message: t('Sign out of Cloudy?'),
      detail: t('Syncing stops. The files on this computer stay where they are.'),
      buttons: [t('Sign out'), t('Cancel')],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await stopEngine();
    await api().revoke().catch(() => {});
    settings = { excluded: [], paused: false, openAtLogin: settings.openAtLogin, server: settings.server, user: settings.user };
    await saveSettings(settings);
    await clearState();
    problems = [];
    refresh();
  },
};

ipcMain.handle('cloudy', (e, name: unknown, ...args: unknown[]) => {
  if (e.sender !== win?.webContents || typeof name !== 'string' || !Object.hasOwn(handlers, name)) throw new Error('unknown call');
  return handlers[name](...args);
});

// ---------------------------------------------------------------- quit

// Quitting (menu, log out, shutdown, update): stop the engine first so running transfers end cleanly and what the
// cycle finished is saved; bounded, so quitting never hangs.
let quitting = false;
async function flush(): Promise<void> {
  await Promise.race([stopEngine(true), new Promise((r) => setTimeout(r, 4000))]);
}
app.on('before-quit', (e) => {
  if (quitting || !engine) return;
  e.preventDefault();
  quitting = true;
  // Not app.quit() straight away: when the engine stops at once, this would run inside the quit that was just
  // prevented, and Electron drops that nested quit (the app kept running).
  void flush().finally(() => setTimeout(() => app.quit(), 0));
});
async function installUpdate(): Promise<void> {
  if (updater.state.state !== 'ready') return;
  quitting = true;
  await flush();
  updater.install();
}

// ---------------------------------------------------------------- start

// Started by the login item (--hidden on Windows/Linux; macOS tells): the first sync waits until the login rush
// (other apps starting, disks spinning up) is over.
const LOGIN_DELAY = 15_000;

app.whenReady().then(async () => {
  if (!primary) return;
  // Read first: macOS only knows while it handles the launch.
  const atLogin = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (process.platform === 'darwin') app.dock?.hide();
  settings = await loadSettings();
  await pickDefaultFolder();
  applyLanguage();
  updater = new Updater((s: UpdateState) => {
    if (s.state === 'ready') notify(t('Cloudy {version} is ready', { version: s.version }),
      process.platform === 'darwin' ? t('It is installed when you restart or quit Cloudy.') : t('Choose "Restart to update" in the menu to install it.'));
    refresh();
  });
  tray = new Tray(trayIcon());
  tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
  buildMenu();
  powerMonitor.on('resume', () => engine?.rescan(5000)); // a full scan: nothing the watcher missed while asleep stays unseen
  if (atLogin && configured()) {
    // Sign-in or setup in the meantime starts an engine itself; this one then has nothing to do.
    setTimeout(() => { if (!engine && configured()) void startEngine().catch((e) => console.error('Cloudy: start', e)); }, LOGIN_DELAY);
  } else {
    await startEngine();
  }
  if (!configured()) showWindow(); // first run, or signed out: started at login with --hidden or not
  if (app.isPackaged) updater.start();
  // The account language may have changed on the web.
  if (signedIn()) {
    api().me().then(async (me) => {
      if (me.language === settings.language) return;
      settings.language = me.language ?? null;
      await saveSettings(settings);
      applyLanguage();
      refresh();
    }).catch(() => {});
  }
});
