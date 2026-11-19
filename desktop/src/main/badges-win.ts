// File Explorer badges (Windows): registers the overlay handlers in CloudyBadges.dll (desktop/explorer, shipped in
// resources/explorer): the handlers for the current user (HKCU), their three names in Explorer's list (HKLM, once, with
// the user's permission as administrator). No Electron imports: test/explorer.test.ts uses it on Windows.
//
// Explorer (and every program showing a file dialog) loads the DLL and keeps it loaded, so the copy in the install
// folder could not be replaced by an update. Cloudy copies it to %LOCALAPPDATA%\Cloudy\Explorer\<version>-<size>\ and
// registers that copy; older copies are removed once nothing has them loaded any more.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The three handlers: synced, syncing, not synced (same order as in CloudyBadges.cpp). */
export const CLSIDS = [
  '{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C01}',
  '{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C02}',
  '{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C03}',
];
const LABELS = ['Cloudy synced', 'Cloudy syncing', 'Cloudy not synced'];
/** Explorer uses only the first 15 overlay handlers in name order (Windows keeps about 4 for itself). Two leading
 * spaces put Cloudy's before Windows' own and OneDrive's (one space), after Dropbox's (three). */
export const NAMES = ['  CloudySynced', '  CloudySyncing', '  CloudyError'];
const OVERLAYS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ShellIconOverlayIdentifiers';
const CLASSES = 'HKCU\\Software\\Classes\\CLSID';

function reg(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 15_000, windowsHide: true }, (e, out) => resolve({ ok: !e, out: String(out ?? '') }));
  });
}

/**
 * Imports a .reg file as administrator: Windows asks the user ("Do you want to allow this app to make changes?").
 * Explorer reads its list of overlay handlers only from HKLM (tried on Windows Server 2025: an HKCU list is ignored),
 * so the three names need it, once; the handlers themselves (the DLL path, which changes with each version) stay in
 * HKCU. Resolves when done; whether it worked is checked by reading the registry afterwards (declined: unchanged).
 */
function importAsAdmin(lines: string[], tmpDir: string): Promise<void> {
  return (async () => {
    await mkdir(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `cloudy-badges-${process.pid}-${Date.now()}.reg`);
    // reg.exe reads UTF-16LE with a byte order mark.
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(['Windows Registry Editor Version 5.00', '', ...lines, ''].join('\r\n'), 'utf16le')]));
    try {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = "$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\reg.exe') -ArgumentList ('import \"' + $env:CLOUDY_REG + '\"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode";
      await new Promise<void>((resolve) => {
        execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CLOUDY_REG: file }, timeout: 300_000, windowsHide: true }, () => resolve());
      });
    } finally {
      await rm(file, { force: true });
    }
  })();
}

const HKLM_OVERLAYS = `HKEY_LOCAL_MACHINE\\${OVERLAYS}`;

/** Whether Explorer's list (HKLM) has Cloudy's three handlers. */
export async function listed(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const r = await reg('query', `HKLM\\${OVERLAYS}\\${NAMES[i]}`, '/ve', '/reg:64');
    if (!r.ok || !r.out.toUpperCase().includes(CLSIDS[i])) return false;
  }
  return true;
}

/** The handlers for this user (no administrator needed: also at every start, for the version that runs). */
export async function registerClasses(dll: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const key = `${CLASSES}\\${CLSIDS[i]}`;
    const steps = [
      [key, '/ve', '/d', LABELS[i]],
      [`${key}\\InprocServer32`, '/ve', '/d', dll],
      [`${key}\\InprocServer32`, '/v', 'ThreadingModel', '/d', 'Apartment'],
    ];
    for (const s of steps) {
      const r = await reg('add', ...s, '/f', '/reg:64');
      if (!r.ok) throw new Error(`reg add ${s[0]} failed`);
    }
  }
}

export async function unregisterClasses(): Promise<void> {
  for (const id of CLSIDS) await reg('delete', `${CLASSES}\\${id}`, '/f', '/reg:64');
}

/** Puts Cloudy's handlers into Explorer's list, asking for administrator permission (only when missing). Throws
 * when they are still missing afterwards (the user declined). */
export async function addToList(tmpDir: string): Promise<void> {
  if (await listed()) return;
  await importAsAdmin(NAMES.flatMap((n, i) => [`[${HKLM_OVERLAYS}\\${n}]`, `@="${CLSIDS[i]}"`, '']), tmpDir);
  if (!(await listed())) throw new Error('Not allowed to add the badges to File Explorer');
}

/** Takes them out of Explorer's list again (asks for administrator permission; declined: they stay listed, unused). */
export async function removeFromList(tmpDir: string): Promise<void> {
  let any = false;
  for (const n of NAMES) any ||= (await reg('query', `HKLM\\${OVERLAYS}\\${n}`, '/reg:64')).ok;
  if (any) await importAsAdmin(NAMES.flatMap((n) => [`[-${HKLM_OVERLAYS}\\${n}]`, '']), tmpDir);
}

/** The DLL the handlers point to while they are in Explorer's list, else null. */
export async function registeredDll(): Promise<string | null> {
  if (!(await listed())) return null;
  let dll: string | null = null;
  for (let i = 0; i < 3; i++) {
    const server = await reg('query', `${CLASSES}\\${CLSIDS[i]}\\InprocServer32`, '/ve', '/reg:64');
    // "    (Default)    REG_SZ    C:\…\CloudyBadges.dll" (the first column is in the system's language)
    const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(server.out);
    if (!server.ok || !m) return null;
    if (dll !== null && dll !== m[1]) return null;
    dll = m[1];
  }
  return dll;
}

/** Copies `source` to `<dir>\<version>-<size>\CloudyBadges.dll` (once; a loaded DLL can be neither replaced nor
 * deleted, so another build gets another folder) and removes the other copies that nothing has loaded any more
 * (tried again at the next start). */
export async function installDll(source: string, dir: string, version: string): Promise<string> {
  const { size } = await stat(source);
  const name = `${version}-${size}`;
  const target = path.join(dir, name, 'CloudyBadges.dll');
  if ((await stat(target).catch(() => null))?.size !== size) {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await copyFile(source, tmp);
    await rename(tmp, target);
  }
  for (const other of await readdir(dir).catch(() => [] as string[])) {
    if (other !== name) await rm(path.join(dir, other), { recursive: true, force: true }).catch(() => {});
  }
  return target;
}
