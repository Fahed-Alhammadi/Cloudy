// Settings and sync state in the app's data folder (userData). The device token is encrypted with the OS keychain
// (safeStorage: Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux) when available.
import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SyncState } from './sync.ts';

export interface Settings {
  server?: string;
  user?: string;
  displayName?: string;
  /** base64; encrypted when `tokenEncrypted` */
  token?: string;
  tokenEncrypted?: boolean;
  rootId?: number;
  folder?: string;
  excluded: string[];
  paused: boolean;
  openAtLogin: boolean;
  /** account language from the server (null = follow the computer) */
  language?: string | null;
}

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

export async function loadSettings(): Promise<Settings> {
  return { excluded: [], paused: false, openAtLogin: true, ...(await readJson<Partial<Settings>>('settings.json')) };
}

export const saveSettings = (s: Settings) => writeJson('settings.json', s);

export function encodeToken(s: Settings, token: string): void {
  s.tokenEncrypted = safeStorage.isEncryptionAvailable();
  s.token = s.tokenEncrypted ? safeStorage.encryptString(token).toString('base64') : Buffer.from(token).toString('base64');
}

export function decodeToken(s: Settings): string | null {
  if (!s.token) return null;
  try {
    const raw = Buffer.from(s.token, 'base64');
    return s.tokenEncrypted ? safeStorage.decryptString(raw) : raw.toString();
  } catch {
    return null;
  }
}

export const loadState = () => readJson<SyncState>('sync-state.json');
export const saveState = (s: SyncState) => writeJson('sync-state.json', s);
/** After any save still in flight, so a late write cannot bring the old state back. */
export const clearState = () => queued('sync-state.json', () => rm(file('sync-state.json'), { force: true }));
