// Settings and sync state in the app's data folder (userData). The device token is encrypted with the OS keychain
// (safeStorage: Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux) when available.
import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { packState, unpackState, type SyncState } from './sync.ts';
import { parseSettings, MIGRATED_ID, type Account, type Settings } from './accounts.ts';

export type { Account, Settings };

const file = (name: string) => path.join(app.getPath('userData'), name);

async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file(name), 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Writes to one file run one after the other, in call order: two saves in flight (a worker's and the end of a cycle)
 * could otherwise finish in the wrong order and put an older sync state back. The content is taken at call time.
 */
const queues = new Map<string, Promise<void>>();
function queued(name: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(job);
  queues.set(name, next);
  return next;
}

/** Atomic and durable: temp file, fsync, rename. A crash leaves the old file or the new one, never a half-written one. */
function writeJson(name: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data);
  return queued(name, async () => {
    const tmp = file(`${name}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      const fh = await open(tmp, 'w', 0o600); // settings hold the device token: this user only
      try {
        await fh.writeFile(text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, file(name));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
}

/**
 * Settings of every account. A one-account file from 1.4 or older is converted (see accounts.ts); its sync state
 * becomes that account's file first, so an interrupted conversion simply runs again.
 */
export async function loadSettings(): Promise<Settings> {
  const raw = await readJson<unknown>('settings.json');
  const settings = parseSettings(raw);
  if ((raw as any)?.version !== 2 && settings.accounts.some((a) => a.id === MIGRATED_ID)) {
    await rename(file('sync-state.json'), file(stateName(MIGRATED_ID))).catch(() => {});
    await saveSettings(settings);
  }
  return settings;
}

export const saveSettings = (s: Settings) => writeJson('settings.json', s);

/**
 * Linux without a keyring (no GNOME Keyring or KWallet for this desktop session): the sign-in cannot really be
 * protected. Depending on the Electron version safeStorage then refuses to encrypt (the token is stored as it is,
 * `tokenEncrypted` false) or "encrypts" with a key that is the same on every computer (`basic_text`, marked
 * encrypted). Both keep working, in a file only this user can read; the app says so instead of pretending.
 * Only meaningful once the app is ready.
 */
export function weakTokenStorage(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return !safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text';
  } catch {
    return true; // cannot tell: say it rather than promise encryption
  }
}

export function encodeToken(a: Account, token: string): void {
  a.tokenEncrypted = safeStorage.isEncryptionAvailable();
  a.token = a.tokenEncrypted ? safeStorage.encryptString(token).toString('base64') : Buffer.from(token).toString('base64');
}

export function decodeToken(a: Account): string | null {
  if (!a.token) return null;
  try {
    const raw = Buffer.from(a.token, 'base64');
    return a.tokenEncrypted ? safeStorage.decryptString(raw) : raw.toString();
  } catch {
    return null;
  }
}

/** One sync-state file per account (ids are generated hex or "main": safe as file names). */
const stateName = (id: string) => `sync-state-${id}.json`;
export const loadState = async (id: string) => unpackState(await readJson<unknown>(stateName(id)));
export const saveState = (id: string, s: SyncState) => writeJson(stateName(id), packState(s));
/** After any save still in flight, so a late write cannot bring the old state back. */
export const clearState = (id: string) => queued(stateName(id), () => rm(file(stateName(id)), { force: true }));
