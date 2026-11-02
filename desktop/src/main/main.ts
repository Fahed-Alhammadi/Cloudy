// Cloudy desktop: a tray (menu bar) app that keeps one local folder in sync with the user's Cloudy files.
// The settings window (src/ui) talks to this process through the `cloudy` IPC channel (src/preload/preload.ts).
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, Notification, powerMonitor } from 'electron';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { Api, ApiError, normalizeServer } from './api.ts';
import { SyncEngine, type Status, type Activity, type Problem } from './sync.ts';
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
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => { /* keep running in the tray */ });

const api = () => new Api(settings.server!, decodeToken(settings) ?? '', userAgent);
const signedIn = () => !!(settings.server && decodeToken(settings) && settings.rootId);
const configured = () => signedIn() && !!settings.folder;

function messages() {
  return {
    case: t('Another item has the same name with different upper/lower case'),
    windowsName: t('The name is not allowed on Windows'),
    badName: t('The name is not allowed'),
    spaces: t('Names cannot start or end with a space'),
    noParent: t('Its folder is not on the server yet'),
    locked: t('The file is in use by another program'),
  };
}

// ---------------------------------------------------------------- sync engine

async function startEngine(): Promise<void> {
  engine?.stop();
  engine = null;
  if (!configured()) return refresh();
  await mkdir(settings.folder!, { recursive: true }).catch(() => {});
  engine = new SyncEngine({
    api: api(),
    root: settings.folder!,
    rootId: settings.rootId!,
    excluded: settings.excluded,
    state: await loadState(),
    saveState,
    trash: async (file) => {
      try {
        await shell.trashItem(file);
      } catch {
        await rm(file, { recursive: true, force: true }); // no trash (some Linux desktops): it is in the server trash
      }
    },
    confirmDeletes: async (count, where) => {
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
  engine.on('status', (s: Status) => {
    if (s.phase === 'auth') notify(t('Cloudy signed you out'), t('Sign in again to keep your files in sync.'));
    refresh();
  });
  engine.on('activity', (a: Activity) => {
    if (a.kind === 'conflict') notify(t('Edited in two places'), t('Kept both versions of {name}.', { name: path.basename(a.path) }));
    send({ activity: engine?.activity });
  });
  engine.on('problems', (p: Problem[]) => { problems = p; refresh(); });
  engine.start();
  if (settings.paused) engine.pause();
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
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
    case 'error': return s.error?.startsWith('Folder not found') ? t('Sync folder not found') : t('Problem: {message}', { message: s.error ?? '' });
    case 'syncing': return s.total ? t('Syncing {done} of {total}', { done: s.done, total: s.total }) : t('Checking for changes…');
    default: return problems.length ? t('{count} items could not be synced', { count: problems.length }) : t('Up to date');
  }
}

// ---------------------------------------------------------------- tray

function trayIcon() {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(OUT, 'icons', name));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

let menuTimer: NodeJS.Timeout | null = null;

function refresh(): void {
  send(snapshot());
  if (menuTimer) return;
  menuTimer = setTimeout(() => { menuTimer = null; buildMenu(); }, 300);
}

function buildMenu(): void {
  if (!tray) return;
  const text = statusText();
  tray.setToolTip(`Cloudy: ${text}`);
  const u = updater?.state;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: text, enabled: false },
    { type: 'separator' },
    { label: t('Open Cloudy folder'), enabled: !!settings.folder, click: () => void shell.openPath(settings.folder!) },
    { label: t('Open Cloudy in the browser'), enabled: !!settings.server, click: () => void shell.openExternal(settings.server!) },
    { type: 'separator' },
    { label: t('Sync now'), enabled: !!engine && !engine.isPaused, click: () => engine?.schedule(0) },
    engine?.isPaused
      ? { label: t('Resume syncing'), click: () => void setPaused(false) }
      : { label: t('Pause syncing'), enabled: !!engine, click: () => void setPaused(true) },
    { type: 'separator' },
    { label: t('Settings…'), click: () => showWindow() },
  ];
  if (u?.state === 'ready') items.push({ label: t('Restart to update to {version}', { version: u.version }), click: () => updater.install() });
  else if (u?.state === 'available') items.push({ label: t('Download Cloudy {version}…', { version: u.version }), click: () => void shell.openExternal(u.url) });
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
    webPreferences: { preload: path.join(OUT, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.on('closed', () => { win = null; if (process.platform === 'darwin') app.dock?.hide(); });
  win.once('ready-to-show', () => { win?.show(); if (process.platform === 'darwin') app.focus({ steal: true }); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.platform === 'darwin') void app.dock?.show();
  void win.loadFile(path.join(OUT, 'ui', 'index.html'));
}

function send(data: object): void {
  win?.webContents.send('cloudy:update', data);
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

/** Checks a folder chosen for syncing: not the home folder or a whole drive. */
function badFolder(folder: string): string | null {
  const p = path.resolve(folder);
  if (p === path.parse(p).root || p === homedir()) return t('Choose a folder inside your home folder, not the whole drive or home folder.');
  return null;
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  state: () => snapshot(),

  async login(server: string, user: string, password: string, code?: string) {
    try {
      const url = normalizeServer(server);
      const r = await Api.login(url, user.trim(), password, code || undefined, `Desktop (${hostname()})`, userAgent);
      settings.server = url;
      settings.user = r.user.id;
      settings.displayName = r.user.displayName;
      settings.rootId = r.user.rootId;
      settings.language = r.user.language ?? null;
      encodeToken(settings, r.token);
      setLanguage(path.join(OUT, 'i18n'), settings.language, app.getLocale());
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
    const r = await dialog.showOpenDialog(win!, {
      title: t('Choose the folder to keep in sync'),
      defaultPath: settings.folder ?? homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  },

  /** First setup, or a new local folder: syncing starts over (files already there are compared, not overwritten). */
  async setup(folder: string, excluded: string[]) {
    const bad = badFolder(folder);
    if (bad) return { error: bad };
    await mkdir(folder, { recursive: true });
    if (settings.folder !== folder) await clearState();
    settings.folder = folder;
    settings.excluded = excluded;
    await saveSettings(settings);
    await applyOpenAtLogin();
    await startEngine();
    return { ok: true };
  },

  async folderHasFiles(folder: string) {
    return (await readdir(folder).catch(() => [])).some((n) => !n.startsWith('.'));
  },

  async setExcluded(excluded: string[]) {
    settings.excluded = excluded;
    await saveSettings(settings);
    await engine?.setExcluded(excluded);
    refresh();
  },

  async setOpenAtLogin(on: boolean) {
    settings.openAtLogin = on;
    await saveSettings(settings);
    await applyOpenAtLogin();
  },

  pause: () => setPaused(true),
  resume: () => setPaused(false),
  syncNow: () => engine?.schedule(0),
  openFolder: () => settings.folder && shell.openPath(settings.folder),
  openWeb: () => settings.server && shell.openExternal(settings.server),
  openRelease: () => updater.state.state === 'available' && shell.openExternal(updater.state.url),
  checkUpdates: () => updater.check(),
  installUpdate: () => updater.install(),

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
    engine?.stop();
    engine = null;
    await api().revoke().catch(() => {});
    settings = { excluded: [], paused: false, openAtLogin: settings.openAtLogin, server: settings.server, user: settings.user };
    await saveSettings(settings);
    await clearState();
    problems = [];
    refresh();
  },
};

ipcMain.handle('cloudy', (e, name: string, ...args: unknown[]) => {
  if (e.sender !== win?.webContents || !Object.hasOwn(handlers, name)) throw new Error('unknown call');
  return handlers[name](...args);
});

// ---------------------------------------------------------------- start

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  settings = await loadSettings();
  await pickDefaultFolder();
  setLanguage(path.join(OUT, 'i18n'), settings.language, app.getLocale());
  updater = new Updater((s: UpdateState) => {
    if (s.state === 'ready') notify(t('Cloudy {version} is ready', { version: s.version }),
      process.platform === 'darwin' ? t('It is installed when you restart or quit Cloudy.') : t('Choose "Restart to update" in the menu to install it.'));
    refresh();
  });
  tray = new Tray(trayIcon());
  tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
  buildMenu();
  powerMonitor.on('resume', () => engine?.schedule(5000));
  await startEngine();
  if (!configured()) showWindow(); // first run, or signed out: started at login with --hidden or not
  if (app.isPackaged) updater.start();
  // The account language may have changed on the web.
  if (signedIn()) {
    api().me().then(async (me) => {
      if (me.language === settings.language) return;
      settings.language = me.language ?? null;
      await saveSettings(settings);
      setLanguage(path.join(OUT, 'i18n'), settings.language, app.getLocale());
      refresh();
    }).catch(() => {});
  }
});
