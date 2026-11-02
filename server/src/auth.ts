import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { q, one } from './db.ts';
import { HttpError, parseCookies, setCookie, clientIp } from './http.ts';
import { verifyTotp, normalizeRecoveryCode } from './totp.ts';
import { assertionCredentialId, verifyAssertion } from './webauthn.ts';

export interface User {
  id: string;
  display_name: string;
  email: string;
  is_admin: boolean;
  disabled: boolean;
  quota_bytes: number | null;
  totp_enabled: boolean;
  notify_shares: boolean;
  language: string | null;
}

const USER_COLS = 'id, display_name, email, is_admin, disabled, quota_bytes, totp_enabled, notify_shares, language';
const SESSION_COOKIE = 'cloudy_session';

function scrypt(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function checkPasswordStrength(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  return pw;
}

// ---- brute-force protection (in memory): per client IP, and per account when one is named ----
// The account counter stops guessing from many addresses (passwords, 2FA codes, recovery codes); it is
// looser than the IP one so that a stranger can't lock someone out for long.
const failures = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_ACCOUNT_FAILURES = 30;

function limited(key: string, max: number): boolean {
  const f = failures.get(key);
  return !!f && Date.now() - f.first < WINDOW_MS && f.n >= max;
}

export function checkRate(req: IncomingMessage, account?: string): void {
  if (limited(`ip:${clientIp(req)}`, MAX_FAILURES) || (account && limited(`acct:${account.toLowerCase()}`, MAX_ACCOUNT_FAILURES))) {
    throw new HttpError(429, 'Too many failed attempts, try again later');
  }
}

/** `req` null: count against the account only (a signed-in user re-typing their password, not a stranger). */
export function recordFailure(req: IncomingMessage | null, account?: string): void {
  const now = Date.now();
  if (failures.size > 5000) for (const [k, f] of failures) if (now - f.first >= WINDOW_MS) failures.delete(k);
  for (const key of [...(req ? [`ip:${clientIp(req)}`] : []), ...(account ? [`acct:${account.toLowerCase()}`] : [])]) {
    const f = failures.get(key);
    if (!f || now - f.first >= WINDOW_MS) failures.set(key, { n: 1, first: now });
    else f.n++;
  }
}

// ---- server secret for signing link-share cookies ----
let secret: string | undefined;
export async function getSecret(): Promise<string> {
  if (secret) return secret;
  await q(`INSERT INTO settings (key, value) VALUES ('secret', $1) ON CONFLICT DO NOTHING`, [newToken()]);
  secret = (await one<{ value: string }>(`SELECT value FROM settings WHERE key = 'secret'`))!.value;
  return secret;
}

export async function sign(value: string): Promise<string> {
  return createHmac('sha256', await getSecret()).update(value).digest('base64url');
}

// ---- sessions (browser) ----
/**
 * Password login (browser session or device token). Users with two-factor enabled must also
 * send `code`: a 6-digit authenticator code or one of their recovery codes. A missing code is
 * answered with 401 + { twoFactor: true } so clients know to ask for it.
 */
export async function login(req: IncomingMessage, id: string, password: string, code?: string): Promise<User> {
  checkRate(req, id);
  const row = await one<User & { password_hash: string; totp_secret: string | null; totp_last_step: number }>(
    `SELECT ${USER_COLS}, password_hash, totp_secret, totp_last_step FROM users WHERE id = $1`,
    [id],
  );
  if (!row || row.disabled || !(await verifyPassword(password, row.password_hash))) {
    recordFailure(req, id);
    throw new HttpError(401, 'Invalid username or password');
  }
  if (row.totp_enabled) await checkSecondFactor(req, row, code);
  const { password_hash: _, totp_secret: _s, totp_last_step: _l, ...user } = row;
  return user;
}

async function checkSecondFactor(
  req: IncomingMessage,
  row: { id: string; totp_secret: string | null; totp_last_step: number },
  code: string | undefined,
): Promise<void> {
  const c = (code ?? '').trim();
  if (!c) throw new HttpError(401, 'Enter the code from your authenticator app', { twoFactor: true });
  const digits = c.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits) && row.totp_secret) {
    const step = verifyTotp(row.totp_secret, digits, row.totp_last_step);
    // Conditional update: two parallel logins can't both use the same code.
    if (step !== null && (await one(`UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id`, [row.id, step]))) return;
  } else {
    const used = await one(`DELETE FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 RETURNING user_id`,
      [row.id, sha256(normalizeRecoveryCode(c))]);
    if (used) return;
  }
  recordFailure(req, row.id);
  throw new HttpError(401, 'Invalid two-factor code', { twoFactor: true });
}

/** WebAuthn user.id for an account: stable per user, but not the username itself. */
export const passkeyUserHandle = (userId: string) => sign(`passkey:${userId}`);

/**
 * Passwordless login with a passkey. The passkey must verify the user (PIN/biometrics), so it
 * counts as two factors and replaces both the password and the authenticator code.
 */
export async function loginWithPasskey(req: IncomingMessage, body: Record<string, unknown>): Promise<User> {
  checkRate(req);
  const key = await one<{ id: string; user_id: string; public_key: Buffer; alg: number; sign_count: string }>(
    `SELECT p.id, p.user_id, p.public_key, p.alg, p.sign_count FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.credential_id = $1 AND NOT u.disabled`,
    [assertionCredentialId(body)],
  );
  if (!key) {
    recordFailure(req);
    throw new HttpError(401, 'This passkey is not registered with Cloudy');
  }
  checkRate(req, key.user_id);
  let count: number;
  try {
    count = verifyAssertion(req, {
      publicKey: key.public_key, alg: key.alg, signCount: Number(key.sign_count), userHandle: await passkeyUserHandle(key.user_id),
    }, body);
  } catch (e) {
    recordFailure(req, key.user_id);
    throw e;
  }
  // Conditional update: a replayed or parallel assertion with the same counter loses.
  const used = await one(
    `UPDATE passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1 AND ($2 = 0 OR sign_count < $2) RETURNING id`,
    [key.id, count],
  );
  if (!used) throw new HttpError(401, 'Passkey signature was already used');
  return (await one<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [key.user_id]))!;
}

export async function createSession(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const token = newToken();
  await q(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, config.sessionDays],
  );
  setCookie(req, res, SESSION_COOKIE, token, config.sessionDays * 86400);
}

/** Signs the user out everywhere except the browser making this request (after a password change). */
export async function dropOtherSessions(req: IncomingMessage, userId: string): Promise<void> {
  const token = parseCookies(req)[SESSION_COOKIE];
  await q(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, token ? sha256(token) : '']);
}

/** The user's password, checked with the same brute-force limits as signing in. */
export async function requirePassword(req: IncomingMessage, userId: string, password: unknown, message = 'Wrong password'): Promise<void> {
  checkRate(req, userId);
  const row = await one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!row || !(await verifyPassword(String(password ?? ''), row.password_hash))) {
    recordFailure(null, userId);
    throw new HttpError(403, message);
  }
}

export async function destroySession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await q(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  setCookie(req, res, SESSION_COOKIE, '', 0);
}

export async function sessionUser(req: IncomingMessage): Promise<User | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const u = await one<User>(
    `SELECT ${USER_COLS.split(', ').map((c) => 'u.' + c).join(', ')}
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [sha256(token)],
  );
  return u ?? null;
}

// ---- Bearer tokens (native mobile apps) ----
// Tokens are app passwords, so they are listed and revocable in Settings and also work for DAV.

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function bearerUser(req: IncomingMessage): Promise<User | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const u = await one<User>(
    `UPDATE app_passwords a SET last_used_at = now() FROM users u
      WHERE a.token_hash = $1 AND u.id = a.user_id AND NOT u.disabled
      RETURNING ${USER_COLS.split(', ').map((c) => 'u.' + c).join(', ')}`,
    [sha256(token)],
  );
  return u ?? null;
}

export async function createAppToken(userId: string, name: string): Promise<string> {
  const token = [newToken(6), newToken(6), newToken(6)].join('-');
  await q(`INSERT INTO app_passwords (user_id, name, token_hash) VALUES ($1, $2, $3)`, [userId, name, sha256(token)]);
  return token;
}

// ---- HTTP Basic (WebDAV / CalDAV / CardDAV clients) ----
// Successful checks are cached briefly: DAV clients authenticate every request
// and scrypt is deliberately slow.
const basicCache = new Map<string, { user: string; until: number }>();

export async function basicUser(req: IncomingMessage): Promise<User | null> {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return null;
  const key = sha256(h);
  const cached = basicCache.get(key);
  if (cached && cached.until > Date.now()) {
    return (await one<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND NOT disabled`, [cached.user])) ?? null;
  }
  checkRate(req);
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const id = decoded.slice(0, i);
  const pw = decoded.slice(i + 1);
  const row = await one<User & { password_hash: string }>(
    `SELECT ${USER_COLS}, password_hash FROM users WHERE id = $1 AND NOT disabled`,
    [id],
  );
  let ok = false;
  if (row) {
    const app = await one(
      `UPDATE app_passwords SET last_used_at = now() WHERE user_id = $1 AND token_hash = $2 RETURNING id`,
      [id, sha256(pw)],
    );
    ok = !!app || (!row.totp_enabled && (await verifyPassword(pw, row.password_hash)));
  }
  if (!ok || !row) {
    recordFailure(req);
    return null;
  }
  basicCache.set(key, { user: id, until: Date.now() + 5 * 60 * 1000 });
  const { password_hash: _, ...user } = row;
  return user;
}

export function forgetBasicCache(): void {
  basicCache.clear();
}
