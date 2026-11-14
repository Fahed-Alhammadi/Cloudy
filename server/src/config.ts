import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const env = process.env;

/** TRUST_PROXY: off (default); true = any local address may be a proxy; or the proxies' addresses / CIDR ranges. */
function trustProxy(raw: string): boolean | string[] {
  const v = raw.trim();
  if (!v || /^(0|false|no|off)$/i.test(v)) return false;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  return v.split(/[\s,]+/).filter(Boolean);
}

/**
 * PUBLIC_URL as an origin with its scheme. A value without http:// or https:// ("cloud.example.com") is ignored with a
 * note in the log (it used to make passkeys, the email settings and password changes answer 500; guessing https would
 * break sign-in on plain-http installs), as is anything that is no address at all.
 */
function publicUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) {
    console.warn(`PUBLIC_URL "${v}" is ignored: write it with http:// or https:// in front (for example https://${v}).`);
    return '';
  }
  try {
    return new URL(v).origin;
  } catch {
    console.warn(`PUBLIC_URL "${raw}" is not a web address; it is ignored (addresses come from each request instead).`);
    return '';
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const config = {
  port: Number(env.PORT ?? 8080),
  dataDir: env.DATA_DIR ?? '/data',
  databaseUrl: env.DATABASE_URL ?? 'postgres://cloudy@localhost/cloudy?host=/run/cloudy',
  // First administrator, created on the first start. ADMIN_USER / ADMIN_PASSWORD are the names from older .env files.
  adminUser: (env.CLOUDY_ADMIN_USERNAME || env.ADMIN_USER || 'admin').trim(),
  adminPassword: env.CLOUDY_ADMIN_PASSWORD || env.ADMIN_PASSWORD || '',
  // Starting values of the limits in Administration (limits.ts); the saved settings win once an admin saves them.
  trashDays: Number(env.TRASH_RETENTION_DAYS || 30),
  maxVersions: Number(env.MAX_VERSIONS || 20),
  sessionDays: Number(env.SESSION_DAYS || 14),
  /** Honor X-Forwarded-For / -Proto / -Host. Enable only when a reverse proxy sets them (http.ts). */
  trustProxy: trustProxy(env.TRUST_PROXY ?? ''),
  /** Address users open Cloudy at (e.g. https://cloud.example.com); passkeys are bound to it. Empty = from the request. */
  publicUrl: publicUrl(env.PUBLIC_URL ?? ''),
  chunkSize: 8 * 1024 * 1024,
  version: (env.APP_VERSION || pkg.version) as string,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
  schemaFile: fileURLToPath(new URL('./schema.sql', import.meta.url)),
};
