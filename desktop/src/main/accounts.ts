// Several accounts in one desktop app: the settings file format (and the conversion from the one-account format of
// 1.4 and older), where each account's folder goes (~/Cloudy/<username>), and the one-time move of an old ~/Cloudy
// into ~/Cloudy/<username>. No Electron imports: tested in test/accounts.test.ts.
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Account {
  /** Stable id: names the account's sync-state file. "main" for the account converted from 1.4. */
  id: string;
  server: string;
  user: string;
  displayName?: string;
  /** The profile picture's version on the server (null or missing: none). */
  avatar?: string | null;
  /** base64; encrypted when `tokenEncrypted`. Missing: signed out by the server (folder and history kept). */
  token?: string;
  tokenEncrypted?: boolean;
  rootId?: number;
  /** Missing until the user chose it (setup). */
  folder?: string;
  excluded: string[];
  paused: boolean;
  /** Set while an old ~/Cloudy is being moved into ~/Cloudy/<username> (see `runMove`): written before the first
   * rename, removed when done, so an interrupted move is finished (or undone) at the next start. */
  movingFrom?: string;
}

export interface Settings {
  version: 2;
  accounts: Account[];
  openAtLogin: boolean;
  /** Windows and Linux: the user's choice for the file manager badges (missing: Linux on, Windows off; macOS keeps
   * the choice itself). */
  badges?: boolean;
}

/** The id the account from a one-account settings file gets (its state file was sync-state.json). */
export const MIGRATED_ID = 'main';

/**
 * Reads settings.json in either format. 1.4 and older kept one account at the top level; that account becomes
 * `MIGRATED_ID` (only when there is something to keep: a folder, or a token).
 */
export function parseSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const openAtLogin = typeof o.openAtLogin === 'boolean' ? o.openAtLogin : true;
  if (o.version === 2 && Array.isArray(o.accounts)) {
    const accounts = o.accounts.filter((a: any) => a && typeof a.id === 'string' && typeof a.server === 'string' && typeof a.user === 'string')
      .map((a: any): Account => ({ ...a, excluded: Array.isArray(a.excluded) ? a.excluded : [], paused: !!a.paused }));
    return { version: 2, accounts, openAtLogin, ...(typeof o.badges === 'boolean' ? { badges: o.badges } : {}) };
  }
  const accounts: Account[] = [];
  if (typeof o.server === 'string' && typeof o.user === 'string' && (o.folder || o.token)) {
    accounts.push({
      id: MIGRATED_ID,
      server: o.server,
      user: o.user,
      displayName: o.displayName,
      token: o.token,
      tokenEncrypted: o.tokenEncrypted,
      rootId: o.rootId,
      folder: o.folder,
      excluded: Array.isArray(o.excluded) ? o.excluded : [],
      paused: !!o.paused,
    });
  }
  return { version: 2, accounts, openAtLogin };
}

/** A user name as one folder name that every desktop system accepts. */
export function folderName(user: string): string {
  let n = user.normalize('NFC').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!n || n === '.' || n === '..') n = 'account';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n += '_'; // reserved on Windows
  return n;
}

/** `child` is `parent` or somewhere inside it (plain path strings). */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

const caseInsensitive = (platform: string) => platform === 'darwin' || platform === 'win32';

/**
 * The path as the file system sees it: links resolved in the part that exists, and lower-cased where names are
 * case-insensitive (macOS, Windows), so "~/cloudy", "~/Cloudy" and a link to it compare equal.
 */
export async function canonical(p: string, platform: string = process.platform): Promise<string> {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = path.join(await realpath(cur), ...rest);
      return caseInsensitive(platform) ? real.toLowerCase() : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return caseInsensitive(platform) ? path.resolve(p).toLowerCase() : path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Two sync folders must never be the same or one inside the other (each would sync the other's files). */
export async function overlaps(folder: string, others: (string | undefined)[], platform: string = process.platform): Promise<boolean> {
  const f = await canonical(folder, platform);
  for (const o of others) {
    if (!o) continue;
    const c = await canonical(o, platform);
    if (inside(f, c) || inside(c, f)) return true;
  }
  return false;
}

const empty = async (p: string): Promise<boolean> => {
  const names = await readdir(p).catch((e) => (e?.code === 'ENOENT' ? [] : null));
  return !!names && !names.some((n) => !n.startsWith('.'));
};

/**
 * Where a new account syncs by default: <home>/Cloudy/<username>. Taken: "<username> (2)"… The main folder is
 * <home>/Cloudy, unless that is itself another account's sync folder (an old one that could not be moved yet), then
 * "Cloudy Files". Never inside or around another account's folder, never a folder that already has files.
 */
export async function defaultFolder(home: string, user: string, otherFolders: (string | undefined)[]): Promise<string> {
  const name = folderName(user);
  for (const base of ['Cloudy', 'Cloudy Files', 'Cloudy Files 2', 'Cloudy Files 3'].map((b) => path.join(home, b))) {
    const b = await canonical(base);
    let taken = false;
    for (const o of otherFolders) if (o && inside(b, await canonical(o))) taken = true;
    if (taken) continue; // the main folder is an account's own folder
    for (let i = 1; i < 50; i++) {
      const p = path.join(base, i === 1 ? name : `${name} (${i})`);
      if (await overlaps(p, otherFolders)) continue;
      if (await empty(p)) return p;
    }
  }
  return path.join(home, `Cloudy ${name}`);
}

/** Left in ~/Cloudy once it holds account folders: tells a finished move from one that has not started. */
export const MARKER = '.cloudy-accounts';

/** Renames retried for a few seconds: on Windows an antivirus or the indexer briefly holds new folders. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e: any) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/**
 * Whether this account syncs an old one-account ~/Cloudy that should move into ~/Cloudy/<username>: exactly that
 * folder (compared as the file system sees it), a real folder (not a link), and not already the container of
 * account folders.
 */
export async function needsMove(home: string, account: Account, platform: string = process.platform): Promise<boolean> {
  const main = path.join(home, 'Cloudy');
  if (!account.folder || account.movingFrom) return false;
  if (await canonical(account.folder, platform) !== await canonical(main, platform)) return false;
  const st = await lstat(main).catch(() => null);
  if (!st?.isDirectory()) return false;
  return !(await lstat(path.join(main, MARKER)).catch(() => null));
}

/**
 * Moves an old ~/Cloudy into ~/Cloudy/<username>, or finishes a move that was interrupted: rename it aside
 * (~/.Cloudy-moving-<id>), create ~/Cloudy with its marker, rename the aside folder into place. Renames keep every
 * file's identity. Call it for an account whose `movingFrom` was saved first.
 * Returns the new folder; "undone" when it could not be done and everything is back in ~/Cloudy; "stuck" when the
 * files are left in the aside folder (tried again at the next start). Never deletes files.
 */
export async function runMove(home: string, account: Account): Promise<string | 'undone' | 'stuck'> {
  const main = path.join(home, 'Cloudy');
  const aside = path.join(home, `.Cloudy-moving-${account.id}`);
  const target = path.join(main, folderName(account.user));
  if (!(await lstat(aside).catch(() => null))) {
    // Done already (the settings were not saved after it): the marker says ~/Cloudy holds account folders.
    if (await lstat(path.join(main, MARKER)).catch(() => null)) {
      return target; // (if it has gone since, the engine reports the missing folder and touches nothing)
    }
    const st = await lstat(main).catch(() => null);
    if (!st?.isDirectory()) return 'undone';
    try {
      await renameRetrying(main, aside);
    } catch {
      return 'undone'; // nothing moved: try again at the next start
    }
  }
  try {
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, MARKER), 'Cloudy: one folder per account in here.\n');
    await renameRetrying(aside, target);
    return target;
  } catch {
    // Put it back, so syncing goes on as before; if even that fails, the next start finishes the move.
    try {
      await rm(path.join(main, MARKER), { force: true });
      await rmdir(main); // only while empty
      await renameRetrying(aside, main);
      return 'undone';
    } catch {
      return 'stuck';
    }
  }
}

/**
 * The sync folder for a place the user picked with "Change…": the account always gets its own Cloudy/<username>
 * folder there, as by default. Picking the Cloudy folder itself gives Cloudy/<username>; picking a folder that is
 * already named after the account (a Cloudy/<username> from before) keeps it as it is.
 */
export function folderIn(chosen: string, user: string, platform: string = process.platform): string {
  const p = path.resolve(chosen);
  const name = folderName(user);
  const fold = (s: string) => (caseInsensitive(platform) ? s.normalize('NFC').toLowerCase() : s.normalize('NFC'));
  const base = fold(path.basename(p));
  if (base === fold(name) || new RegExp(`^${fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)$`).test(base)) return p;
  if (base === fold('Cloudy')) return path.join(p, name);
  return path.join(p, 'Cloudy', name);
}
