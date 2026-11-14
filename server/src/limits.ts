// Limits an administrator sets under Administration → Limits: days in the trash, versions kept per file and how
// long a browser sign-in lasts. Stored in `settings` ('limits') and applied at once, without a restart.
// TRASH_RETENTION_DAYS / MAX_VERSIONS / SESSION_DAYS from older .env files only give the starting values: the first
// start stores them, so they stay when an install moves to the short .env without them.
import type { Router, Ctx } from './http.ts';
import { json, readJson, HttpError } from './http.ts';
import { config } from './config.ts';
import { q, one } from './db.ts';
import type { User } from './auth.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

export type Limits = { trashDays: number; maxVersions: number; sessionDays: number };
type Key = keyof Limits;

const RULES: Record<Key, { min: number; max: number; fallback: number; env: string; error: string }> = {
  trashDays: { min: 0, max: 3650, fallback: 30, env: 'TRASH_RETENTION_DAYS', error: 'Days in the trash must be a whole number from 0 to 3650' },
  maxVersions: { min: 0, max: 1000, fallback: 20, env: 'MAX_VERSIONS', error: 'Versions per file must be a whole number from 0 to 1000' },
  sessionDays: { min: 1, max: 365, fallback: 14, env: 'SESSION_DAYS', error: 'Sign-in days must be a whole number from 1 to 365' },
};
const KEYS = Object.keys(RULES) as Key[];

const valid = (k: Key, v: unknown): v is number => Number.isInteger(v) && (v as number) >= RULES[k].min && (v as number) <= RULES[k].max;

/** Starting values from the env: out-of-range numbers are clamped (not reset), so an old MAX_VERSIONS=2000 keeps 1000. */
function seeds(warn: boolean): Limits {
  const out = {} as Limits;
  for (const k of KEYS) {
    const { min, max, fallback, env } = RULES[k];
    const raw = config[k];
    out[k] = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : fallback;
    if (warn && out[k] !== raw) console.warn(`${env}=${process.env[env]} is outside ${min}–${max}: using ${out[k]} (change it under Administration → Limits)`);
  }
  return out;
}

let current: Limits = seeds(false);

/** The limits in force (loaded at startup, replaced when an admin saves). */
export function limits(): Limits {
  return current;
}

export async function loadLimits(): Promise<void> {
  const row = await one<{ value: string }>(`SELECT value FROM settings WHERE key = 'limits'`);
  if (!row) {
    current = seeds(true);
    await store(current);
    return;
  }
  const saved = JSON.parse(row.value) as Partial<Limits>;
  const next = { ...current };
  for (const k of KEYS) if (valid(k, saved[k])) next[k] = saved[k];
  current = next;
}

async function store(l: Limits): Promise<void> {
  await q(`INSERT INTO settings (key, value) VALUES ('limits', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(l)]);
}

export function registerLimits(r: Router, admin: Wrap) {
  r.get('/api/admin/limits', admin(async ({ res }) => json(res, current)));

  // Fields left out keep their value.
  r.put('/api/admin/limits', admin(async ({ req, res }) => {
    const b = await readJson(req);
    if (!b || typeof b !== 'object') throw new HttpError(400, 'Expected a JSON object');
    const next = { ...current };
    for (const k of KEYS) {
      if (b[k] === undefined) continue;
      const v = typeof b[k] === 'string' && b[k].trim() !== '' ? Number(b[k]) : b[k];
      if (!valid(k, v)) throw new HttpError(400, RULES[k].error);
      next[k] = v;
    }
    await store(next);
    current = next;
    json(res, current);
  }));
}
