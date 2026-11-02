// Updates from GitHub releases. The repository also holds server/Android/iOS releases, so the newest `desktop-v*`
// release is looked up first and electron-updater reads its latest*.yml from that release (generic provider).
// macOS (zip), Windows (NSIS installer) and Linux (AppImage, .deb) download in the background, check the SHA-512 and
// install on restart or quit. Development builds only report.
import { existsSync } from 'node:fs';
import { app, net } from 'electron';
import { autoUpdater } from 'electron-updater';

export const REPO = 'Fahed-Alhammadi/cloudy';
const TAG = 'desktop-v';
const DAY = 24 * 3600 * 1000;

export type UpdateState =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'downloading' | 'ready'; version: string; percent?: number }
  /** newer version, but this build can't install it (development run, .tar.gz): link to the release page */
  | { state: 'available'; version: string; url: string }
  | { state: 'error'; message: string };

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Newest published desktop release, or null. */
export async function latestRelease(): Promise<{ tag: string; version: string; url: string } | null> {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cloudy Desktop' },
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const list = (await res.json()) as { tag_name: string; draft: boolean; prerelease: boolean; html_url: string }[];
  const versions = list
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG))
    .map((r) => ({ tag: r.tag_name, version: r.tag_name.slice(TAG.length), url: r.html_url }))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
  return versions[0] ?? null;
}

export class Updater {
  state: UpdateState = { state: 'idle' };
  private onChange: (s: UpdateState) => void;
  private busy = false;

  constructor(onChange: (s: UpdateState) => void) {
    this.onChange = onChange;
    autoUpdater.autoDownload = true;
    // macOS updates are verified by Squirrel against the running app's signature. Windows builds are unsigned and
    // Linux has no signature check, so there a downloaded update is installed only when the user asks for it.
    autoUpdater.autoInstallOnAppQuit = process.platform === 'darwin';
    autoUpdater.on('download-progress', (p) => {
      if (this.state.state === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) });
    });
  }

  private set(s: UpdateState): void {
    this.state = s;
    this.onChange(s);
  }

  /** Checks now, then once a day. */
  start(): void {
    setTimeout(() => void this.check(), 60_000);
    setInterval(() => void this.check(), DAY);
  }

  /** Can this build replace itself? (packaged, and not a .tar.gz or a dev run) */
  get canInstall(): boolean {
    if (!app.isPackaged) return false;
    if (process.platform === 'linux') return !!process.env.APPIMAGE || existsSync(`${process.resourcesPath}/package-type`);
    return true;
  }

  async check(): Promise<void> {
    if (this.busy || this.state.state === 'ready') return;
    this.busy = true;
    this.set({ state: 'checking' });
    try {
      const rel = await latestRelease();
      if (!rel || !newer(rel.version, app.getVersion())) return this.set({ state: 'none' });
      if (!this.canInstall) return this.set({ state: 'available', version: rel.version, url: rel.url });
      autoUpdater.setFeedURL({ provider: 'generic', url: `https://github.com/${REPO}/releases/download/${rel.tag}` });
      this.set({ state: 'downloading', version: rel.version, percent: 0 });
      const found = await autoUpdater.checkForUpdates();
      if (!found?.isUpdateAvailable || !found.downloadPromise) return this.set({ state: 'none' });
      await found.downloadPromise;
      this.set({ state: 'ready', version: rel.version });
    } catch (e: any) {
      this.set({ state: 'error', message: e?.message ?? String(e) });
    } finally {
      this.busy = false;
    }
  }

  install(): void {
    if (this.state.state === 'ready') autoUpdater.quitAndInstall();
  }
}
