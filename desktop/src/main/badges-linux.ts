// File manager badges (Linux): puts linux/cloudy-badges.py (shipped in resources/linux) where GNOME Files, Nemo and
// Caja load Python extensions, and the emblem pictures into the user's icon folder, all in ~/.local/share (no root
// needed, also for the AppImage). Dolphin's plugin comes with the .deb package (linux/deb/after-install.sh) and uses
// the same pictures. No Electron imports: test/badges-linux.test.ts.
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The file managers with a Python extension package (python3-nautilus, python3-nemo, python3-caja). */
const HOSTS = ['nautilus', 'nemo', 'caja'];
const SCRIPT = 'cloudy-badges.py';

export const dataHome = (home: string) => process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
const scriptAt = (data: string, host: string) => path.join(data, `${host}-python`, 'extensions', SCRIPT);

/** The emblem pictures in `resources/linux/icons`: [path below hicolor, …]. */
async function emblems(icons: string): Promise<string[]> {
  const out: string[] = [];
  for (const size of await readdir(path.join(icons, 'hicolor'))) {
    for (const f of await readdir(path.join(icons, 'hicolor', size, 'emblems')).catch(() => [] as string[])) {
      if (/^emblem-cloudy-[a-z]+\.png$/.test(f)) out.push(path.join(size, 'emblems', f));
    }
  }
  return out;
}

/** Installs (or updates) the extensions and the pictures. `resources` = the folder with cloudy-badges.py and icons/. */
export async function install(resources: string, home: string): Promise<void> {
  const data = dataHome(home);
  const script = await readFile(path.join(resources, SCRIPT), 'utf8');
  for (const host of HOSTS) {
    const target = scriptAt(data, host);
    const text = `HOST = '${host}'\n${script}`;
    if ((await readFile(target, 'utf8').catch(() => null)) === text) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, { mode: 0o644 });
  }
  const icons = path.join(resources, 'icons');
  for (const rel of await emblems(icons)) {
    const target = path.join(data, 'icons', 'hicolor', rel);
    const [have, want] = await Promise.all([stat(target).catch(() => null), stat(path.join(icons, 'hicolor', rel))]);
    if (have && have.size === want.size) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(icons, 'hicolor', rel), target);
  }
}

/** Removes what `install` put there (the pictures too: Dolphin's plugin then shows nothing either). */
export async function uninstall(resources: string, home: string): Promise<void> {
  const data = dataHome(home);
  for (const host of HOSTS) await rm(scriptAt(data, host), { force: true });
  for (const rel of await emblems(path.join(resources, 'icons')).catch(() => [] as string[])) {
    await rm(path.join(data, 'icons', 'hicolor', rel), { force: true });
  }
}

/** Whether the extension is in place (for GNOME Files, the one most systems have). */
export async function installed(home: string): Promise<boolean> {
  return !!(await stat(scriptAt(dataHome(home), 'nautilus')).catch(() => null));
}
