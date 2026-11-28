// Cloudy desktop: a tray (menu bar) app that keeps a local folder in sync with the user's Cloudy files, for one or
// several accounts (each its own folder, by default ~/Cloudy/<username>, and its own sync engine).
// The settings window (src/ui) talks to this process through the `cloudy` IPC channel (src/preload/preload.ts).
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, Notification, powerMonitor, net } from 'electron';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { Api, ApiError, normalizeServer } from './api.ts';
import { SyncEngine, stateFitsServer, type Status, type Activity, type Problem } from './sync.ts';
import { loadSettings, saveSettings, encodeToken, decodeToken, loadState, saveState, clearState, type Account, type Settings } from './store.ts';
import { canonical, defaultFolder, folderIn, folderName, inside, needsMove, overlaps, runMove } from './accounts.ts';
import { t } from './i18n.ts';
import { Updater, type UpdateState } from './updater.ts';
import { FinderBadges } from './finder.ts';
import { addToList, installDll, registerClasses, removeFromList, unregisterClasses } from './badges-win.ts';
import { install as installLinuxBadges, uninstall as uninstallLinuxBadges } from './badges-linux.ts';

const OUT = __dirname; // out/ (bundled main.cjs, preload.cjs, ui/, icons/)
const userAgent = `Cloudy Desktop/${app.getVersion()} (${process.platform})`;

/** What runs for one account. */
interface Run {
  engine: SyncEngine | null;
  problems: Problem[];
  activityChanged: boolean;
  /** Suggested folder while the account has none yet (setup). */
  defaultFolder?: string;
  /** The profile picture as a data: address for the window (the version it shows). */
  avatar?: { version: string; data: string };
  /** When /api/me was last asked (name and picture changed elsewhere). */
  meAt?: number;
  /** What the window already has of the large parts (sent again only when they changed). */
  sent: { problems?: Problem[]; engine?: SyncEngine | null; avatar?: string | null };
}

let settings: Settings;
const runs = new Map<string, Run>();
let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let updater: Updater;

// Test runs can use a separate profile, also of a packaged build next to an installed Cloudy (each profile is its own
// single instance): CLOUDY_USER_DATA=/tmp/cloudy-test npm start
if (process.env.CLOUDY_USER_DATA) app.setPath('userData', process.env.CLOUDY_USER_DATA);
// … and another home folder for the default sync folders: CLOUDY_HOME=/tmp/home
const home = process.env.CLOUDY_HOME || homedir();
// A second copy only brings the first one's window to the front. (`quit` is asynchronous: `ready` can still fire,
// so the start-up below is guarded too.)
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else app.on('second-instance', () => showWindow());
// macOS: clicking Cloudy in the Dock (kept there, or opening the app again from Finder/Launchpad while it runs) is a
// "reopen": show the window. Without this, the Dock icon did nothing once the window was closed. Only after start-up
// (the settings are loaded); a click during start-up is answered by the start-up itself.
let started = false;
let activatedEarly = false;
app.on('activate', () => { if (started) showWindow(); else activatedEarly = true; });
if (process.platform === 'win32') app.setAppUserModelId('io.cloudy.desktop'); // notifications under the Start-menu shortcut's identity
app.on('window-all-closed', () => { /* keep running in the tray */ });

const engines = () => [...runs.values()].map((r) => r.engine).filter((e): e is SyncEngine => !!e);

// A tray app must not die (or show Electron's error dialog) over one failure somewhere: log it and keep going.
// Example: Node's recursive fs.watch on Linux throws ENOSPC/EMFILE from inside its own watcher when the inotify
// limits are reached; the engines then fall back to scanning on a timer.
function uncaught(kind: string, e: unknown): void {
  console.error(`Cloudy: ${kind}:`, e);
  const err = e as NodeJS.ErrnoException | undefined;
  if ((err?.code === 'ENOSPC' || err?.code === 'EMFILE') && /watch/i.test(`${err.syscall ?? ''} ${err.message ?? ''}`)) {
    for (const e of engines()) try { e.watcherFailed(); } catch {}
  }
}
process.on('uncaughtException', (e) => uncaught('uncaught exception', e));
process.on('unhandledRejection', (e) => uncaught('unhandled rejection', e));

// Electron's fetch goes through Chromium: the system proxy and the OS certificate store (company CAs) work like in a browser.
const api = (a: Account) => new Api(a.server, decodeToken(a) ?? '', userAgent, net.fetch);
const signedIn = (a: Account) => !!(a.server && decodeToken(a) && a.rootId);
const configured = (a: Account) => signedIn(a) && !!a.folder;
const run = (a: Account): Run => {
  let r = runs.get(a.id);
  if (!r) runs.set(a.id, (r = { engine: null, problems: [], activityChanged: false, sent: {} }));
  return r;
};
const account = (id: unknown): Account => {
  const a = settings.accounts.find((x) => x.id === id);
  if (!a) throw new Error('unknown account');
  return a;
};
const host = (server: string) => { try { return new URL(server).host; } catch { return server; } };

const notSynced = (n: number) => (n === 1 ? t('1 item could not be synced') : t('{count} items could not be synced', { count: n }));

/** "Fahed Alhammadi", or "fahed (cloud.example.com)" when two accounts would look the same. */
function label(a: Account): string {
  const name = a.displayName || a.user;
  const twin = settings.accounts.some((o) => o !== a && (o.displayName || o.user) === name);
  return twin ? `${name} (${host(a.server)})` : name;
}
const several = () => settings.accounts.length > 1;

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

// ---------------------------------------------------------------- sync engines

/** `save`: the same account and folder go on later (quit, sign in again), so keep what the running cycle finished. */
async function stopEngine(a: Account, save = false): Promise<void> {
  const r = run(a);
  const e = r.engine;
  r.engine = null;
  await e?.stop({ save });
}

async function startEngine(a: Account): Promise<void> {
  await stopEngine(a);
  const r = run(a);
  if (!configured(a)) return refresh();
  const state = await loadState(a.id);
  // Only a fresh start gets its folder created. Once something was synced, a missing folder means a disk that is not
  // mounted or a folder that was moved: syncing a new, empty one would delete everything on the server.
  if (!state?.base || !Object.keys(state.base).length) await mkdir(a.folder!, { recursive: true }).catch(() => {});
  // In notifications and questions, which account it is about (only when there are several).
  const who = (text: string) => (several() ? `${label(a)}: ${text}` : text);
  const engine = new SyncEngine({
    api: api(a),
    root: a.folder!,
    rootId: a.rootId!,
    excluded: a.excluded,
    state,
    saveState: (s) => saveState(a.id, s),
    trash: async (file) => {
      try {
        await shell.trashItem(file);
      } catch {
        // No trash here (some Linux desktops, network drives, a disk without a recycle bin), or the item is in use
        // or protected. A rename tells the two apart: what cannot be renamed is in use. It stays, the engine lists
        // it as a problem and tries again in the next pass. What can be renamed is removed: it is in the server's
        // trash. Removing without that check used to delete the rest of a folder for good because one file in it
        // was open in a program. (The name is one the engine ignores and clears away after a crash.)
        const aside = path.join(path.dirname(file), `.cloudy-tmp-${randomBytes(6).toString('hex')}`);
        try {
          await rename(file, aside);
        } catch {
          throw Object.assign(new Error('Could not move to the trash'), { code: 'EBUSY' });
        }
        await rm(aside, { recursive: true, force: true });
      }
    },
    confirmDeletes: async (count, where) => {
      if (process.platform === 'darwin') app.focus({ steal: true }); // a menu bar app: the question must not hide behind other windows
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: who(where === 'local'
          ? t('{count} files were deleted on the server. Delete them on this computer too?', { count })
          : t('{count} files were deleted on this computer. Delete them on the server too?', { count })),
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
  r.engine = engine;
  // UI failures (a window closing mid-send) must never reach the engine's cycle: the handlers swallow them.
  let lastPhase = '';
  engine.on('status', (s: Status) => {
    try {
      if (s.phase === 'auth' && lastPhase !== 'auth') notify(who(t('Cloudy signed you out')), t('Sign in again to keep your files in sync.'));
      if (s.phase !== lastPhase) finder?.changed([a.folder!]); // the folder's own badge follows signed out / missing
      lastPhase = s.phase;
      refresh();
    } catch {}
  });
  engine.on('activity', (act: Activity) => {
    try {
      if (act.kind === 'conflict') notify(who(t('Edited in two places')), t('Kept both versions of {name}.', { name: path.basename(act.path) }));
      r.activityChanged = true;
      scheduleSend();
    } catch {}
  });
  engine.on('problems', (p: Problem[]) => { r.problems = p; try { refresh(); } catch {} });
  const folder = a.folder!;
  // null: everything below the folder may look different (a folder was renamed).
  engine.on('badges', (rels: string[] | null) => {
    try {
      if (finder?.connected) finder.changed(rels && rels.map((p) => (p ? path.join(folder, p) : folder)));
    } catch {}
  });
  engine.on('kept', (folder: string) => {
    try {
      notify(who(t('"{name}" was kept on this computer', { name: folder })),
        t('It has changes that are not on the server yet. It is no longer synced; move what you need elsewhere.'));
    } catch {}
  });
  engine.start();
  if (a.paused) engine.pause();
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

/** A second line under the status: what to do about it, or the error behind "Offline". */
function statusDetail(a: Account): string | null {
  const s = run(a).engine?.status;
  if (!s) return null;
  if (s.phase === 'error' && s.code === 'missing-folder') return t('Connect the disk it is on, or choose the folder again under Settings.');
  if (s.phase === 'offline') return s.error ?? null;
  return null;
}

function statusText(a: Account): string {
  if (!signedIn(a)) return t('Not signed in');
  if (!a.folder) return t('Choose a folder to sync');
  const r = run(a);
  const s = r.engine?.status;
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
    default: return r.problems.length ? notSynced(r.problems.length) : t('Up to date');
  }
}

/** For the tray tooltip and the top of the menu: one account's status, or what matters most across all of them. */
function overallText(): string {
  const list = settings.accounts;
  if (!list.length) return t('Not signed in');
  if (list.length === 1) return statusText(list[0]);
  const bad = list.find((a) => {
    const p = run(a).engine?.status?.phase;
    return !configured(a) || p === 'auth' || p === 'error' || p === 'offline';
  });
  if (bad) return `${label(bad)}: ${statusText(bad)}`;
  if (list.some((a) => run(a).engine?.status?.phase === 'syncing')) return t('Syncing…');
  if (list.every((a) => run(a).engine?.isPaused)) return t('Paused');
  const problems = list.reduce((n, a) => n + run(a).problems.length, 0);
  return problems ? notSynced(problems) : t('Up to date');
}

// ---------------------------------------------------------------- tray

// Just the cloud, monochrome like the system's own icons. macOS: an 18 pt template image (the "Template" suffix
// makes it one), which the menu bar tints white or black to match itself. Windows/Linux: a white cloud.
function trayIcon() {
  const name = process.platform === 'darwin' ? 'trayMacTemplate.png' : 'tray.png';
  return nativeImage.createFromPath(path.join(OUT, 'icons', name));
}

// While syncing, the engines report several status changes per file. The window gets at most ~4 updates a second and
// the tray menu at most one; each is a trailing timer, so the last state always arrives.
const SEND_MS = 250;
const MENU_MS = 1000;
let sendTimer: NodeJS.Timeout | null = null;
let lastSend = 0;
let menuTimer: NodeJS.Timeout | null = null;
let lastMenu = 0;

function refresh(): void {
  finder?.setFolders(settings.accounts.filter((a) => a.folder && run(a).engine).map((a) => a.folder!));
  scheduleSend();
  if (menuTimer) return;
  menuTimer = setTimeout(() => { menuTimer = null; lastMenu = Date.now(); buildMenu(); }, Math.max(0, lastMenu + MENU_MS - Date.now()));
}

let menuKey = '';
let tooltip = '';

/** One account's entries: open its folder and web page, sync now, pause or resume. */
function accountItems(a: Account): Electron.MenuItemConstructorOptions[] {
  const e = run(a).engine;
  return [
    { label: t('Open Cloudy folder'), enabled: !!a.folder, click: () => void shell.openPath(a.folder!) },
    { label: t('Open Cloudy in the browser'), click: () => void shell.openExternal(a.server) },
    { type: 'separator' },
    { label: t('Sync now'), enabled: !!e && !e.isPaused, click: () => run(a).engine?.rescan() },
    e?.isPaused
      ? { label: t('Resume syncing'), click: () => void setPaused(a, false) }
      : { label: t('Pause syncing'), enabled: !!e, click: () => void setPaused(a, true) },
  ];
}

function buildMenu(): void {
  if (!tray) return;
  const text = overallText();
  if (text !== tooltip) tray.setToolTip(`Cloudy: ${(tooltip = text)}`);
  const u = updater?.state;
  // Rebuilding a native menu is not free: only when something it shows changed.
  const key = JSON.stringify([text, settings.accounts.map((a) => [label(a), statusText(a), !!a.folder, !!run(a).engine, run(a).engine?.isPaused]),
    u?.state, u && 'version' in u ? u.version : null, u && 'url' in u ? u.url : null]);
  if (key === menuKey) return;
  menuKey = key;
  const items: Electron.MenuItemConstructorOptions[] = [{ label: text, enabled: false }, { type: 'separator' }];
  if (settings.accounts.length === 1) {
    items.push(...accountItems(settings.accounts[0]));
  } else {
    // Several accounts: each in its own submenu, its status first.
    for (const a of settings.accounts) {
      items.push({ label: label(a), submenu: [{ label: statusText(a), enabled: false }, { type: 'separator' }, ...accountItems(a)] });
    }
  }
  items.push({ type: 'separator' }, { label: t('Settings…'), click: () => showWindow() });
  if (u?.state === 'ready') items.push({ label: t('Restart to update to {version}', { version: u.version }), click: () => void installUpdate() });
  else if (u?.state === 'available' && /^https:\/\/github\.com\//.test(u.url)) items.push({ label: t('Download Cloudy {version}…', { version: u.version }), click: () => void shell.openExternal(u.url) });
  items.push({ type: 'separator' }, { label: t('Quit Cloudy'), role: 'quit' });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

async function setPaused(a: Account, paused: boolean): Promise<void> {
  a.paused = paused;
  await saveSettings(settings);
  const e = run(a).engine;
  if (paused) e?.pause();
  else e?.resume();
  refresh();
}

// ---------------------------------------------------------------- file manager badges

// A green tick, blue arrows or a red mark on the items in the sync folders:
//   macOS    the Finder Sync extension (desktop/finder, in Cloudy.app/Contents/PlugIns), turned on and off with pluginkit
//   Windows  overlay handlers in CloudyBadges.dll (desktop/explorer), registered for this user (badges-win.ts)
//   Linux    extensions for GNOME Files, Nemo and Caja in ~/.local/share (badges-linux.ts); Dolphin's plugin comes
//            with the .deb package
// All of them ask this app (finder.ts) through the loopback port and secret in finder.json, at a fixed place in the
// real home folder (the macOS extension's sandbox may read only that file; not the profile folder, which test runs move).
const FINDER_ID = 'io.cloudy.desktop.finder';
let finder: FinderBadges | null = null;
/** "on", "off" (the user turned them off), "unset" (macOS: never chosen), "missing" (not in this copy of Cloudy). */
type BadgeState = 'on' | 'off' | 'unset' | 'missing';
let badgeState: BadgeState | null = null;

function portFile(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Cloudy', 'finder.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Cloudy', 'finder.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'Cloudy', 'finder.json');
}

/** Which badge the file manager shows on `abs`: asked of the engine of the account whose folder holds it. */
function badgeOf(abs: string): ReturnType<SyncEngine['badge']> {
  const found = badgeIn(abs);
  // macOS spells some system folders two ways ("/tmp/…" is "/private/tmp/…"): try the other one.
  if (found !== undefined || process.platform !== 'darwin') return found ?? null;
  const other = /^\/(tmp|var|etc)\//.test(abs) ? `/private${abs}` : abs.startsWith('/private/') ? abs.slice('/private'.length) : null;
  return other ? badgeIn(other) ?? null : null;
}

/** undefined: in no account's folder. Windows: any case (Explorer passes the names as they are on disk). */
function badgeIn(abs: string): ReturnType<SyncEngine['badge']> | undefined {
  if (abs.split(/[\\/]/).some((n) => n === '.' || n === '..')) return undefined; // only plain paths inside a folder
  const fold = process.platform === 'win32' ? (p: string) => p.toLowerCase() : (p: string) => p;
  for (const a of settings.accounts) {
    const f = a.folder;
    if (!f) continue;
    const head = fold(abs.slice(0, f.length));
    if (head !== fold(f) || (abs.length > f.length && abs[f.length] !== path.sep)) continue;
    return run(a).engine?.badge(abs.slice(f.length + 1).split(path.sep).join('/')) ?? null;
  }
  return undefined;
}

async function serveBadges(on: boolean): Promise<void> {
  if (on && !finder) {
    const f = new FinderBadges(portFile(), badgeOf);
    await f.start();
    finder = f;
  } else if (!on && finder) {
    const f = finder;
    finder = null;
    await f.close();
  }
  refresh();
}

const pluginkit = (...args: string[]) => new Promise<string>((resolve) => {
  execFile('/usr/bin/pluginkit', args, { timeout: 10_000 }, (_e, out) => resolve(String(out ?? '')));
});

async function readFinderState(): Promise<BadgeState> {
  // "+    io.cloudy.desktop.finder(1.7.0)": the first column is the user's choice (+ on, - off, blank never chosen).
  const line = (await pluginkit('-m', '-A', '-i', FINDER_ID)).split('\n').find((l) => l.includes(FINDER_ID));
  if (!line) return 'missing';
  return line.trimStart() !== line ? 'unset' : line.startsWith('+') ? 'on' : line.startsWith('-') ? 'off' : 'unset';
}

/** Windows and Linux: what comes with this copy of Cloudy (in its resources folder). */
const badgeFiles = () => process.platform === 'win32'
  ? path.join(process.resourcesPath, 'explorer', 'CloudyBadges.dll')
  : path.join(process.resourcesPath, 'linux');
const explorerDir = () => path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Cloudy', 'Explorer');

/** Windows and Linux: puts the badges in place (or removes them) for this user. Windows, `ask`: also adds them to
 * (removes them from) File Explorer's list, which needs the user's permission as administrator (throws when declined);
 * only when the user switches them, never at start. */
async function applyBadges(on: boolean, ask = false): Promise<void> {
  if (process.platform === 'win32') {
    if (on) {
      await registerClasses(await installDll(badgeFiles(), explorerDir(), app.getVersion()));
      if (ask) await addToList(app.getPath('temp'));
    } else {
      await unregisterClasses();
      if (ask) await removeFromList(app.getPath('temp'));
    }
  } else if (on) await installLinuxBadges(badgeFiles(), homedir());
  else await uninstallLinuxBadges(badgeFiles(), homedir());
}

/** Windows and Linux: whether the user wants them (Windows: off until turned on, it asks for permission). */
const badgesWanted = () => (process.platform === 'win32' ? settings.badges === true : settings.badges !== false);

/** One badge change at a time (the switch can be clicked again while Windows' registry is still being written),
 * in the order asked, so the last one wins. */
let badgeChain: Promise<void> = Promise.resolve();
function badgeTask(fn: () => Promise<void>): Promise<void> {
  const run = badgeChain.then(fn);
  badgeChain = run.catch(() => {});
  return run;
}

function setBadgesEnabled(on: boolean): Promise<void> {
  return badgeTask(async () => {
    if (process.platform === 'darwin') {
      await pluginkit('-e', on ? 'use' : 'ignore', '-i', FINDER_ID);
      badgeState = await readFinderState();
    } else {
      let now = on;
      try {
        await applyBadges(on, true);
      } catch (e) {
        // Turning them on failed (Windows: permission declined): they stay off. Turning off: off anyway (the next
        // start removes what is left).
        console.error('Cloudy: file manager badges', e);
        now = false;
        if (on) await applyBadges(false).catch(() => {});
      }
      await serveBadges(now);
      settings.badges = now;
      await saveSettings(settings);
      badgeState = now ? 'on' : 'off';
    }
    refresh();
  });
}

/** At start: serves the badges and puts the extension of this copy of Cloudy in place, turned on unless the user
 * turned it off (System Settings or Cloudy's Settings on macOS; Cloudy's Settings elsewhere). */
function startBadges(): Promise<void> {
  return badgeTask(async () => {
    if (process.platform === 'darwin') {
      await serveBadges(true);
      if (!app.isPackaged) return;
      const appex = path.join(path.dirname(path.dirname(app.getPath('exe'))), 'PlugIns', 'CloudyFinder.appex');
      if (await lstat(appex).catch(() => null)) await pluginkit('-a', appex);
      badgeState = await readFinderState();
      if (badgeState === 'unset') {
        await pluginkit('-e', 'use', '-i', FINDER_ID);
        badgeState = await readFinderState();
      }
    } else if (!(await lstat(badgeFiles()).catch(() => null))) {
      badgeState = 'missing';
    } else {
      const on = badgesWanted();
      badgeState = on ? 'on' : 'off';
      await applyBadges(on); // off: leftovers of an earlier run (e.g. one that stopped while turning them off) go
      if (on) await serveBadges(true);
    }
    refresh();
  });
}

// ---------------------------------------------------------------- window

function showWindow(): void {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 520,
    minHeight: 540,
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
    if (/^https:\/\//.test(url) || settings.accounts.some((a) => url.startsWith(a.server + '/'))) void shell.openExternal(url);
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

function accountSnapshot(a: Account) {
  const r = run(a);
  return {
    id: a.id,
    label: label(a),
    server: a.server,
    host: host(a.server),
    user: a.user,
    displayName: a.displayName,
    avatar: (a.avatar && r.avatar?.version === a.avatar ? r.avatar.data : null) as string | null,
    signedIn: signedIn(a),
    configured: configured(a),
    folder: a.folder,
    defaultFolder: r.defaultFolder,
    excluded: a.excluded,
    paused: a.paused,
    status: r.engine?.status ?? null,
    statusText: statusText(a),
    statusDetail: statusDetail(a),
    activity: r.engine?.activity ?? [],
    problems: r.problems,
  };
}

function snapshot() {
  return {
    accounts: settings.accounts.map(accountSnapshot),
    openAtLogin: settings.openAtLogin,
    home: process.platform === 'win32' ? null : home, // the window shows paths in it as "~/…"
    // The Settings switch: which file manager, and whether it is on (null: no badges in this copy).
    badges: badgeState === 'on' || badgeState === 'off' || badgeState === 'unset'
      ? { state: badgeState, where: process.platform === 'darwin' ? 'finder' : process.platform === 'win32' ? 'explorer' : 'linux' }
      : null,
    update: updater?.state,
    version: app.getVersion(),
  };
}

/** The window's state; each account's problems and activity only when they changed since the last message (the
 * window merges updates into what it has, account by account). */
function update() {
  const s = snapshot();
  return {
    ...s,
    accounts: s.accounts.map(({ problems, activity, avatar, ...rest }) => {
      const r = runs.get(rest.id)!;
      const out: Partial<ReturnType<typeof accountSnapshot>> = rest;
      if (avatar !== r.sent.avatar) out.avatar = r.sent.avatar = avatar;
      if (problems !== r.sent.problems) out.problems = r.sent.problems = problems;
      if (r.activityChanged || r.engine !== r.sent.engine) out.activity = activity;
      r.activityChanged = false;
      r.sent.engine = r.engine;
      return out;
    }),
  };
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

/** Checks a folder chosen for syncing: not the home folder or a whole drive, not where Cloudy keeps its own data,
 * and not the same as (or inside, or around) another account's folder. */
async function badFolder(folder: string, a: Account): Promise<string | null> {
  const p = await canonical(folder);
  if (p === path.parse(p).root || p === await canonical(homedir()) || p === await canonical(home)) {
    return t('Choose a folder inside your home folder, not the whole drive or home folder.');
  }
  const data = await canonical(app.getPath('userData'));
  if (inside(p, data) || inside(data, p)) return t('Choose another folder: this one holds Cloudy’s own settings.');
  const others = settings.accounts.filter((o) => o !== a).map((o) => o.folder);
  if (await overlaps(folder, others)) return t('Another account syncs this folder, or a folder inside or around it. Choose another folder.');
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

/**
 * Changes to accounts (sign in, setup, sign out, folders to sync, the delayed start at login) run one at a time:
 * each awaits the network or the disk, and two interleaved could give two accounts the same folder or leave an
 * engine running for an account that was just removed.
 */
let changing: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = changing.catch(() => {}).then(job);
  changing = next;
  return next;
}

/** Folders other accounts sync, or were offered for setup (two new accounts must not be offered the same one). */
const otherFolders = (a: Account) => settings.accounts.filter((o) => o !== a).flatMap((o) => [o.folder, o.folder ? undefined : run(o).defaultFolder]);

const handlers: Record<string, (...args: any[]) => unknown> = {
  state: () => {
    const s = snapshot();
    for (const a of settings.accounts) {
      const r = run(a);
      r.sent = { problems: r.problems, engine: r.engine, avatar: s.accounts.find((x) => x.id === a.id)?.avatar ?? null };
      r.activityChanged = false;
      void refreshMe(a); // a name or picture changed in the web app or a phone shows when the window opens
    }
    return s;
  },

  /**
   * Signs in. The same account again (same server and username: signed out by the server, or signed in twice)
   * keeps its folder and sync history; anyone else becomes a new account. `forId`: signing in again to that
   * account, so it must be that one.
   */
  login: (...args: unknown[]) => exclusive(() => login(...(args as [unknown, unknown, unknown, unknown?, unknown?]))),
  setup: (...args: unknown[]) => exclusive(() => setup(...(args as [unknown, unknown, unknown]))),
  setExcluded: (...args: unknown[]) => exclusive(() => setExcluded(...(args as [unknown, unknown]))),
  signInAgain: (id: unknown) => exclusive(() => signInAgain(id)),
  logout: (id: unknown) => exclusive(() => logout(id)),

  /** Top-level server folders of an account, for choosing what to sync. */
  async folders(id: unknown) {
    const a = account(id);
    const r = await api(a).node(a.rootId!);
    return (r.children ?? []).filter((c) => c.isDir).map((c) => c.name).sort((x, y) => x.localeCompare(y));
  },

  /** Asks where the account's files go; the answer is the place's Cloudy/<username> folder (see `folderIn`). */
  async chooseFolder(id: unknown) {
    if (!win) return null;
    const a = account(id);
    const now = a.folder ?? run(a).defaultFolder;
    const r = await dialog.showOpenDialog(win, {
      title: t('Choose where to keep your Cloudy files'),
      message: t('Cloudy puts a Cloudy/{name} folder in the place you choose.', { name: folderName(a.user) }),
      buttonLabel: t('Choose'),
      defaultPath: !now ? home : path.basename(path.dirname(now)).toLowerCase() === 'cloudy' ? path.dirname(path.dirname(now)) : path.dirname(now),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : folderIn(r.filePaths[0], a.user);
  },

  /** Stores a new profile picture: a JPEG the window made (square, at most 512 pixels, no metadata). */
  async setAvatar(id: unknown, jpeg: unknown) {
    const a = account(id);
    if (!(jpeg instanceof Uint8Array) || jpeg.length < 4 || jpeg.length > 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('bad argument');
    try {
      const { avatar } = await api(a).setAvatar(jpeg);
      a.avatar = avatar;
      run(a).avatar = { version: avatar, data: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` };
      await saveSettings(settings);
      refresh();
      return { ok: true };
    } catch (e) {
      return { error: pictureError(e) };
    }
  },

  async removeAvatar(id: unknown) {
    const a = account(id);
    try {
      await api(a).removeAvatar();
      a.avatar = null;
      run(a).avatar = undefined;
      await saveSettings(settings);
      refresh();
      return { ok: true };
    } catch (e) {
      return { error: pictureError(e) };
    }
  },

  /** The About page's links: fixed addresses only. */
  openLink(name: unknown) {
    const url = LINKS[name as keyof typeof LINKS];
    if (typeof name !== 'string' || !Object.hasOwn(LINKS, name)) throw new Error('bad argument');
    return shell.openExternal(url);
  },

  async folderHasFiles(folder: unknown) {
    return (await readdir(absPath(folder)).catch(() => [])).some((n) => !n.startsWith('.'));
  },

  async setOpenAtLogin(on: unknown) {
    if (typeof on !== 'boolean') throw new Error('bad argument');
    settings.openAtLogin = on;
    await saveSettings(settings);
    await applyOpenAtLogin();
  },

  pause: (id: unknown) => setPaused(account(id), true),
  resume: (id: unknown) => setPaused(account(id), false),
  syncNow: (id: unknown) => run(account(id)).engine?.rescan(),
  openFolder: (id: unknown) => { const a = account(id); return a.folder && shell.openPath(a.folder); },
  openWeb: (id: unknown) => shell.openExternal(account(id).server),
  openRelease: () => updater.state.state === 'available' && /^https:\/\/github\.com\//.test(updater.state.url) && shell.openExternal(updater.state.url),
  checkUpdates: () => updater.check(),
  async setBadges(on: unknown) {
    if (typeof on !== 'boolean' || !badgeState || badgeState === 'missing') throw new Error('bad argument');
    await setBadgesEnabled(on).catch((e) => console.error('Cloudy: file manager badges', e));
    return badgeState; // the window shows this (also when the switch did not change: e.g. permission declined)
  },
  installUpdate: () => installUpdate(),
};

const LINKS = {
  website: 'https://fahed-alhammadi.github.io/Cloudy/',
  help: 'https://fahed-alhammadi.github.io/Cloudy/support.html',
  feedback: 'https://github.com/Fahed-Alhammadi/Cloudy/issues',
  privacy: 'https://fahed-alhammadi.github.io/Cloudy/privacy-policy.html',
};

const pictureError = (e: any): string => {
  if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return t('This server can’t store profile pictures yet. Ask its administrator to update Cloudy.');
  if (e instanceof ApiError) return e.message;
  return t('Could not reach the server: {message}', { message: e?.cause?.message ?? e?.message ?? String(e) });
};

/** Fetches the account's profile picture when the window does not have this version yet. */
async function loadAvatar(a: Account): Promise<void> {
  const r = run(a);
  if (!a.avatar || r.avatar?.version === a.avatar || !signedIn(a)) return;
  const version = a.avatar;
  const data = await api(a).avatar(a.user, version).catch(() => null);
  if (!data || a.avatar !== version) return;
  const mime = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : data[0] === 0x89 && data[1] === 0x50 ? 'image/png'
    : data.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  if (!mime) return;
  r.avatar = { version, data: `data:${mime};base64,${data.toString('base64')}` };
  refresh();
}

/** Picks up a new name or profile picture (changed in the web app or a phone); at most once a minute. */
async function refreshMe(a: Account): Promise<void> {
  const r = run(a);
  if (!signedIn(a) || (r.meAt && Date.now() - r.meAt < 60_000)) return void loadAvatar(a);
  r.meAt = Date.now();
  try {
    const me = await api(a).me();
    if (me.id !== a.user) return;
    const avatar = me.avatar ?? null;
    if (me.displayName !== a.displayName || avatar !== (a.avatar ?? null)) {
      a.displayName = me.displayName;
      a.avatar = avatar;
      if (!avatar) r.avatar = undefined;
      await saveSettings(settings);
      refresh();
    }
  } catch {
    // offline or signed out: the engine reports that
  }
  await loadAvatar(a);
}

/**
 * Signs in. The same account again (same server and username: signed out by the server, or signed in twice)
 * keeps its folder and sync history; anyone else becomes a new account. `forId`: signing in again to that
 * account, so it must be that one.
 */
async function login(server: unknown, user: unknown, password: unknown, code?: unknown, forId?: unknown) {
  try {
    const url = normalizeServer(str(server, 2048));
    const r = await Api.login(url, str(user, 256).trim(), str(password, 1024), code ? str(code, 64) : undefined, `Desktop (${hostname()})`, userAgent, net.fetch);
    let a = settings.accounts.find((x) => x.server === url && x.user === r.user.id);
    if (forId != null && a?.id !== forId) {
      await new Api(url, r.token, userAgent, net.fetch).revoke().catch(() => {});
      const wanted = settings.accounts.find((x) => x.id === forId);
      return { error: t('This signs in as {user}, not {wanted}. To add another account, use Add account.', { user: r.user.id, wanted: wanted?.user ?? '' }) };
    }
    if (a) {
      await stopEngine(a, true);
      if (a.rootId !== r.user.rootId) {
        // The same name, but another account behind it (a reset server): its files must not be merged with this
        // folder without asking, so it starts over.
        await clearState(a.id);
        a.folder = undefined;
        a.excluded = [];
      } else if (a.folder) {
        // Keep the state only if it still describes this server (not a reset one that reuses ids). Can't tell
        // (network): keep it; the engine checks the account's root itself.
        const fresh = new Api(url, r.token, userAgent, net.fetch);
        if (!(await stateFitsServer(fresh, await loadState(a.id)).catch(() => true))) await clearState(a.id);
      }
      if (a.token) await api(a).revoke().catch(() => {}); // signed in twice: the older device token is not needed
    } else {
      a = { id: randomBytes(6).toString('hex'), server: url, user: r.user.id, excluded: [], paused: false };
      settings.accounts.push(a);
    }
    a.displayName = r.user.displayName;
    a.avatar = r.user.avatar ?? null;
    a.rootId = r.user.rootId;
    encodeToken(a, r.token);
    run(a).meAt = Date.now();
    void loadAvatar(a);
    if (!a.folder) run(a).defaultFolder = await defaultFolder(home, a.user, otherFolders(a));
    await saveSettings(settings);
    if (a.folder) await startEngine(a);
    refresh();
    return { ok: true, id: a.id };
  } catch (e: any) {
    if (e instanceof ApiError) return { error: e.message, twoFactor: !!e.body?.twoFactor };
    if (e?.message === 'HTTPS_REQUIRED') return { error: t('Use an https:// address. Plain http:// only works for a server on your local network.') };
    return { error: t('Could not reach the server: {message}', { message: e?.cause?.message ?? e?.message ?? String(e) }) };
  }
}

/** First setup, or a new local folder: syncing starts over (files already there are compared, not overwritten). */
async function setup(id: unknown, rawFolder: unknown, rawExcluded: unknown) {
  const a = account(id);
  if (!signedIn(a)) return { error: t('Not signed in') };
  const folder = absPath(rawFolder);
  const excluded = folderNames(rawExcluded);
  const bad = await badFolder(folder, a);
  if (bad) return { error: bad };
  if (a.folder !== folder) {
    await stopEngine(a); // the old engine must not save its state again
    await clearState(a.id);
    await mkdir(folder, { recursive: true });
  } else if (!(await lstat(folder).catch(() => null))?.isDirectory()) {
    // The same folder, with its sync history: never recreated empty (that would delete everything on the server).
    return { error: t('Sync folder not found') };
  }
  a.folder = folder;
  a.excluded = excluded;
  run(a).defaultFolder = undefined;
  await saveSettings(settings);
  await applyOpenAtLogin();
  await startEngine(a);
  return { ok: true };
}

async function setExcluded(id: unknown, raw: unknown) {
  const a = account(id);
  const excluded = folderNames(raw);
  a.excluded = excluded;
  await saveSettings(settings);
  await run(a).engine?.setExcluded(excluded);
  refresh();
}

/** Signed out by the server (token revoked or expired): sign in again, keeping the folder and what was synced. */
async function signInAgain(id: unknown) {
  const a = account(id);
  await stopEngine(a, true);
  a.token = undefined;
  a.tokenEncrypted = undefined;
  await saveSettings(settings);
  run(a).problems = [];
  refresh();
}

/** Removes an account from this computer: its syncing stops, its files stay where they are. */
async function logout(id: unknown) {
  const a = account(id);
  const { response } = await dialog.showMessageBox(win!, {
    type: 'question',
    message: several() ? t('Sign out of {account}?', { account: label(a) }) : t('Sign out of Cloudy?'),
    detail: t('Syncing stops. The files on this computer stay where they are.'),
    buttons: [t('Sign out'), t('Cancel')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  await stopEngine(a);
  if (decodeToken(a)) await api(a).revoke().catch(() => {});
  settings.accounts = settings.accounts.filter((x) => x !== a);
  runs.delete(a.id);
  await saveSettings(settings);
  await clearState(a.id);
  refresh();
}

ipcMain.handle('cloudy', (e, name: unknown, ...args: unknown[]) => {
  if (e.sender !== win?.webContents || typeof name !== 'string' || !Object.hasOwn(handlers, name)) throw new Error('unknown call');
  return handlers[name](...args);
});

// ---------------------------------------------------------------- quit

// Quitting (menu, log out, shutdown, update): stop the engines first so running transfers end cleanly and what the
// cycles finished is saved; bounded, so quitting never hangs.
let quitting = false;
async function flush(): Promise<void> {
  void finder?.close(); // its finder.json goes: the extension stops badging until Cloudy runs again
  await Promise.race([Promise.all(settings.accounts.map((a) => stopEngine(a, true))), new Promise((r) => setTimeout(r, 4000))]);
}
app.on('before-quit', (e) => {
  if (quitting || !engines().length) return;
  e.preventDefault();
  quitting = true;
  // Not app.quit() straight away: when the engines stop at once, this would run inside the quit that was just
  // prevented, and Electron drops that nested quit (the app kept running).
  void flush().finally(() => setTimeout(() => app.quit(), 0));
});
app.on('will-quit', () => finder?.removePortFileSync());
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

/**
 * 1.4 and older synced the one account straight into ~/Cloudy. Since 1.5 every account has its own folder inside
 * it (~/Cloudy/<username>), so that one is moved there once: renamed, so nothing is transferred again, and its sync
 * state is pointed at the new place (the engine only uses a state made for its folder). The move is written into
 * the settings before it starts, so a crash at any point is finished (or undone) at the next start.
 */
async function moveOldFolders(): Promise<void> {
  for (const a of settings.accounts) {
    try {
      if (await needsMove(home, a)) {
        a.movingFrom = a.folder;
        await saveSettings(settings);
      }
      if (!a.movingFrom) continue;
      const result = await runMove(home, a);
      if (result === 'stuck') {
        notify(t('Your Cloudy files could not be moved'), t('They are in {path}. Cloudy tries again when it starts next time.', { path: path.join(home, `.Cloudy-moving-${a.id}`) }));
        continue; // `movingFrom` stays: this account's engine is not started until the move is finished
      }
      if (result === 'undone') {
        a.folder = a.movingFrom;
      } else {
        const state = await loadState(a.id);
        if (state) await saveState(a.id, { ...state, root: result });
        a.folder = result;
        notify(t('Your Cloudy files have a new place'), t('They are now in {path}, so that more accounts can be added next to them.', { path: result }));
      }
      delete a.movingFrom;
      await saveSettings(settings);
    } catch (e) {
      console.error('Cloudy: moving the old folder', e); // start-up goes on; the next start tries again
    }
  }
}

app.whenReady().then(async () => {
  if (!primary) return;
  // Read first: macOS only knows while it handles the launch.
  const atLogin = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (process.platform === 'darwin') app.dock?.hide();
  settings = await loadSettings();
  await moveOldFolders();
  for (const a of settings.accounts) {
    if (!a.folder) run(a).defaultFolder = await defaultFolder(home, a.user, otherFolders(a)).catch(() => undefined);
  }
  updater = new Updater((s: UpdateState) => {
    if (s.state === 'ready') notify(t('Cloudy {version} is ready', { version: s.version }),
      process.platform === 'darwin' ? t('It is installed when you restart or quit Cloudy.') : t('Choose "Restart to update" in the menu to install it.'));
    refresh();
  });
  tray = new Tray(trayIcon());
  tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
  buildMenu();
  powerMonitor.on('resume', () => { for (const e of engines()) e.rescan(5000); }); // a full scan: nothing the watcher missed while asleep stays unseen
  // One at a time with sign-in, setup and sign-out (which start engines themselves; this one then has nothing to do).
  const startAll = () => exclusive(async () => {
    for (const a of settings.accounts) {
      if (!run(a).engine && configured(a) && !a.movingFrom) await startEngine(a).catch((e) => console.error('Cloudy: start', e));
    }
  });
  for (const a of settings.accounts) void refreshMe(a);
  // Development runs (npm start) leave the badges to an installed Cloudy, unless CLOUDY_FINDER=1.
  if (app.isPackaged || process.env.CLOUDY_FINDER) void startBadges().catch((e) => console.error('Cloudy: file manager badges', e));
  if (atLogin) setTimeout(() => void startAll(), LOGIN_DELAY);
  else await startAll();
  started = true;
  // First run, signed out, or an account still to set up: started at login with --hidden or not. Also when the user
  // opened Cloudy themselves (Dock, Finder, Launchpad) rather than the login item.
  if (!settings.accounts.length || settings.accounts.some((a) => !configured(a)) || (activatedEarly && !atLogin)) showWindow();
  if (app.isPackaged) updater.start();
});
