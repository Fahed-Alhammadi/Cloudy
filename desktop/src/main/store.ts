// Settings and sync state in the app's data folder (userData). The device token is encrypted with the OS keychain
// (safeStorage: Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux) when available.
import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
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

async function writeJson(name: string, data: unknown): Promise<void> {
  const tmp = file(`${name}.${randomBytes(4).toString('hex')}.tmp`); // writes can overlap (worker save + settings change)
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); // settings hold the device token: this user only
  await rename(tmp, file(name));
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
export const clearState = () => rm(file('sync-state.json'), { force: true });
