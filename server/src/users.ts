import { rm } from 'node:fs/promises';
import { config } from './config.ts';
import { q, one, tx } from './db.ts';
import type pg from 'pg';
import { HttpError } from './http.ts';
import { hashPassword, checkPasswordStrength, newToken } from './auth.ts';
import type { User } from './auth.ts';
import { rootOf, purgeNode, usage, uploadPath } from './files.ts';

export const USER_ID_RE = /^[a-zA-Z0-9._@-]{1,64}$/;
/**
 * A new account's name also starts with a letter or digit. Names made of dots (".", "..") collapse in every address
 * (/api/admin/users/.. is /api/admin/): such an account could be neither edited nor deleted. Existing accounts are
 * still found with USER_ID_RE.
 */
export const NEW_USER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/;

export interface NewUser {
  id: string;
  password: string;
  displayName?: string;
  email?: string;
  isAdmin?: boolean;
  quotaBytes?: number | null;
  groups?: string[];
}

/** A quota from the admin API: bytes, or null/'' for unlimited. Anything else is a 400, not a database error. */
export function quotaValue(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'Invalid quota');
  return n === 0 ? null : n;
}

/** The rules for a new account's name, password and display name (administration and invitations). Throws a 400. */
export function checkNewUser(u: { id: string; password: unknown; displayName?: string }): void {
  if (!USER_ID_RE.test(u.id ?? '')) throw new HttpError(400, 'Username may contain letters, digits and . _ @ - (max 64)');
  if (!NEW_USER_ID_RE.test(u.id)) throw new HttpError(400, 'Usernames start with a letter or a digit');
  checkPasswordStrength(u.password);
  if ((u.displayName ?? '').length > 100) throw new HttpError(400, 'Display name is too long (max 100)');
}

/** Unknown groups are a 400 before anything is created (they used to fail after the account existed). */
export async function checkGroups(groups: string[]): Promise<void> {
  if (!groups.length) return;
  const known = new Set((await q<{ id: string }>(`SELECT id FROM groups WHERE id = ANY($1)`, [groups])).map((g) => g.id));
  const missing = groups.filter((g) => !known.has(g));
  if (missing.length) throw new HttpError(400, `Unknown group: ${missing.join(', ')}`);
}

/** First key of the advisory lock taken on a new account's name (the second is the name's hash). */
const NAME_LOCK = 72_416;

/**
 * The account row with its root folder, calendar and address book, inside the caller's transaction (an invitation is
 * used up in the same one). A name that differs only in case counts as taken (409). The lock on the lower-case name
 * makes check and insert one step: two requests for "Anna" and "anna" at the same moment both passed the check.
 */
export async function insertUser(db: pg.PoolClient, u: {
  id: string; passwordHash: string; displayName?: string; email?: string; isAdmin?: boolean; quotaBytes?: number | null;
}): Promise<void> {
  await q(`SELECT pg_advisory_xact_lock(${NAME_LOCK}, hashtext(lower($1)))`, [u.id], db);
  if (await one(`SELECT 1 FROM users WHERE lower(id) = lower($1)`, [u.id], db)) {
    throw new HttpError(409, 'User already exists');
  }
  // Password reset looks the username up first: a name that is someone else's email address would catch their reset
  // requests (and look like them when sharing).
  if (u.id.includes('@') && await one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [u.id], db)) {
    throw new HttpError(409, 'This username is the email address of another account');
  }
  await q(
    `INSERT INTO users (id, display_name, email, password_hash, is_admin, quota_bytes) VALUES ($1, $2, $3, $4, $5, $6)`,
    [u.id, u.displayName || u.id, u.email ?? '', u.passwordHash, !!u.isAdmin, quotaValue(u.quotaBytes)],
    db,
  );
  await rootOf(u.id, db);
  await q(`INSERT INTO calendars (owner, uri, name) VALUES ($1, 'personal', 'Personal')`, [u.id], db);
  await q(`INSERT INTO addressbooks (owner, uri, name) VALUES ($1, 'contacts', 'Contacts')`, [u.id], db);
}

export async function createUser(u: NewUser): Promise<void> {
  checkNewUser(u);
  if (u.groups?.length) await checkGroups(u.groups);
  const passwordHash = await hashPassword(u.password);
  await tx((db) => insertUser(db, { ...u, passwordHash }));
  if (u.groups) await setGroups(u.id, u.groups);
}

export async function setGroups(userId: string, groups: string[]): Promise<void> {
  await tx(async (db) => {
    await q(`DELETE FROM group_members WHERE user_id = $1`, [userId], db);
    for (const g of groups) {
      await q(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [g, userId], db)
        .catch(() => { throw new HttpError(400, `Unknown group: ${g}`); });
    }
  });
}

export async function deleteUser(id: string): Promise<void> {
  const root = await one<{ id: number }>(`SELECT id FROM nodes WHERE owner = $1 AND parent_id IS NULL`, [id]);
  if (root) await purgeNode(root.id);
  // Also the uploads this user started into other people's shared folders (the row goes with the user).
  const uploads = await q<{ id: string }>(`SELECT id FROM uploads WHERE owner = $1 OR user_id = $1`, [id]);
  await Promise.all(uploads.map((u) => rm(uploadPath(u.id), { force: true })));
  // share_with is plain text, not a foreign key: without this, a new account created later with the same name
  // would inherit everything that was shared with the deleted one.
  await q(`DELETE FROM shares WHERE type = 'user' AND share_with = $1`, [id]);
  await q(`DELETE FROM users WHERE id = $1`, [id]);
}

export async function userJson(u: User) {
  const groups = await q<{ group_id: string }>(`SELECT group_id FROM group_members WHERE user_id = $1 ORDER BY 1`, [u.id]);
  const extra = await one<{ passkeys: number; avatar: string | null }>(
    `SELECT (SELECT count(*)::int FROM passkeys WHERE user_id = $1) AS passkeys,
            (SELECT etag FROM avatars WHERE user_id = $1) AS avatar`, [u.id]);
  return {
    id: u.id,
    displayName: u.display_name,
    // The profile picture's version (GET /api/users/:id/avatar?v=<it>), or null when there is none.
    avatar: extra?.avatar ?? null,
    email: u.email,
    isAdmin: u.is_admin,
    twoFactor: !!u.totp_enabled,
    passkeys: extra?.passkeys ?? 0,
    notifyShares: u.notify_shares !== false,
    language: u.language ?? null,
    timezone: u.timezone ?? null,
    disabled: u.disabled,
    quotaBytes: u.quota_bytes,
    used: await usage(u.id),
    groups: groups.map((g) => g.group_id),
  };
}

export async function ensureAdmin(): Promise<void> {
  const any = await one(`SELECT 1 FROM users LIMIT 1`);
  if (any) return;
  let password = config.adminPassword;
  // The examples from .env.example (now and before 1.17) are public: never use them as the real password.
  if (password.length < 8 || password === 'change-me-to-a-long-password' || password === 'change-me-admin-password') {
    password = newToken(12);
    console.log(`\n  CLOUDY_ADMIN_PASSWORD not set, shorter than 8 characters or still the example. Generated admin password: ${password}\n`);
  }
  await createUser({ id: config.adminUser, password, displayName: 'Administrator', isAdmin: true });
  console.log(`created admin user "${config.adminUser}"`);
}
