import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { limits } from './limits.ts';
import { q, one } from './db.ts';
import { HttpError, parseCookies, setCookie, clientNet } from './http.ts';
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
  /** IANA time zone (calendar events from clients that send none, link expiry dates from the apps). */
  timezone: string | null;
}

const USER_COLS = 'id, display_name, email, is_admin, disabled, quota_bytes, totp_enabled, notify_shares, language, timezone';
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

/**
 * For unknown or disabled accounts: the same scrypt work as a real check, so the answer time doesn't tell whether
 * an account exists. (The value is a hash of a random password nobody knows.)
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(pw: string): Promise<false> {
  await verifyPassword(pw, await (dummyHash ??= hashPassword(newToken())));
  return false;
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
type Counter = { n: number; first: number };
const failures = new Map<string, Counter>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_ACCOUNT_FAILURES = 30;
/** Names that can be accounts (users.ts USER_ID_RE). Anything else never gets a counter: a "username" of a megabyte
 * would otherwise be kept as a map key for 15 minutes per failed attempt. */
export const ACCOUNT_RE = /^[a-zA-Z0-9._@-]{1,64}$/;

/** `req` null: the account only (a signed-in user re-typing their password, not a stranger). */
function keysFor(req: IncomingMessage | null, account?: string): string[] {
  const keys = req ? [`ip:${clientNet(req)}`] : [];
  if (account && (ACCOUNT_RE.test(account) || /^link:\d{1,18}$/.test(account))) keys.push(`acct:${account.toLowerCase()}`);
  return keys;
}

/** Account counters allow more than the per-address ones (`ip:…`, and `invite:…` for invitation links). */
function limited(key: string): boolean {
  const f = failures.get(key);
  return !!f && Date.now() - f.first < WINDOW_MS && f.n >= (key.startsWith('acct:') ? MAX_ACCOUNT_FAILURES : MAX_FAILURES);
}

function bump(key: string): Counter {
  const now = Date.now();
  if (failures.size > 5000) for (const [k, f] of failures) if (now - f.first >= WINDOW_MS) failures.delete(k);
  const f = failures.get(key);
  if (f && now - f.first < WINDOW_MS) {
    f.n++;
    return f;
  }
  const fresh = { n: 1, first: now };
  failures.set(key, fresh);
  return fresh;
}

export function checkRate(req: IncomingMessage | null, account?: string): void {
  if (keysFor(req, account).some(limited)) throw new HttpError(429, 'Too many failed attempts, try again later');
}

/**
 * One guess (password, two-factor code, link password): checked against the limits and counted as a failure BEFORE
 * the slow check runs, so guesses sent at the same moment cannot all pass the check before the first failure is
 * recorded (they used to: 300 parallel wrong passwords were all tried). `succeeded()` takes the count back.
 */
export function attempt(req: IncomingMessage | null, account?: string): { succeeded(): void } {
  return attemptKeys(keysFor(req, account));
}

/**
 * One guess of an invitation link's token: limited per client address like a sign-in (ten wrong ones in 15 minutes),
 * but on a counter of its own. Sharing the sign-in counter, a household's mistyped passwords would block an invitee on
 * the same network from creating the account, and every wrong link would cost a sign-in attempt (and the reverse).
 */
export function attemptInvitation(req: IncomingMessage): { succeeded(): void } {
  return attemptKeys([`invite:${clientNet(req)}`]);
}

function attemptKeys(keys: string[]): { succeeded(): void } {
  if (keys.some(limited)) throw new HttpError(429, 'Too many failed attempts, try again later');
  const counted = keys.map(bump);
  let done = false;
  return {
    succeeded() {
      if (done) return;
      done = true;
      for (const c of counted) if (c.n > 0) c.n--;
    },
  };
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
  // A name that cannot be an account is answered like an unknown user (same scrypt time), without a database lookup.
  const known = ACCOUNT_RE.test(id);
  const guess = attempt(req, known ? id : undefined);
  const row = known ? await one<User & { password_hash: string; totp_secret: string | null; totp_last_step: number }>(
    `SELECT ${USER_COLS}, password_hash, totp_secret, totp_last_step FROM users WHERE id = $1`,
    [id],
  ) : undefined;
  const ok = row && !row.disabled ? await verifyPassword(password, row.password_hash) : await burnPasswordCheck(password);
  if (!row || !ok) throw new HttpError(401, 'Invalid username or password'); // the guess stays counted
  if (row.totp_enabled) await checkSecondFactor(row, code, guess);
  else guess.succeeded();
  const { password_hash: _, totp_secret: _s, totp_last_step: _l, ...user } = row;
  return user;
}

async function checkSecondFactor(
  row: { id: string; totp_secret: string | null; totp_last_step: number },
  code: string | undefined,
  guess: { succeeded(): void },
): Promise<void> {
  const c = (code ?? '').trim();
  if (!c) {
    guess.succeeded(); // right password, the code is asked for next: not a failure
    throw new HttpError(401, 'Enter the code from your authenticator app', { twoFactor: true });
  }
  const digits = c.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits) && row.totp_secret) {
    const step = verifyTotp(row.totp_secret, digits, row.totp_last_step);
    // Conditional update: two parallel logins can't both use the same code.
    if (step !== null && (await one(`UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id`, [row.id, step]))) return guess.succeeded();
  } else if (c.length <= 64) {
    const used = await one(`DELETE FROM recovery_codes WHERE user_id = $1 AND code_hash = $2 RETURNING user_id`,
      [row.id, sha256(normalizeRecoveryCode(c))]);
    if (used) return guess.succeeded();
  }
  throw new HttpError(401, 'Invalid two-factor code', { twoFactor: true }); // the guess stays counted
}

/** WebAuthn user.id for an account: stable per user, but not the username itself. */
export const passkeyUserHandle = (userId: string) => sign(`passkey:${userId}`);

/**
 * Passwordless login with a passkey. The passkey must verify the user (PIN/biometrics), so it
 * counts as two factors and replaces both the password and the authenticator code.
 */
export async function loginWithPasskey(req: IncomingMessage, body: Record<string, unknown>): Promise<User> {
  // No per-account counter here: that one is fed by wrong passwords, which anyone can send for any username, and
  // must not lock the owner out of their passkey too. Passkey guesses count per client address.
  const credentialId = assertionCredentialId(body); // a malformed request is a 400, not a guess
  const guess = attempt(req);
  const key = await one<{ id: string; user_id: string; public_key: Buffer; alg: number; sign_count: string }>(
    `SELECT p.id, p.user_id, p.public_key, p.alg, p.sign_count FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.credential_id = $1 AND NOT u.disabled`,
    [credentialId],
  );
  if (!key) throw new HttpError(401, 'This passkey is not registered with Cloudy');
  const count = verifyAssertion(req, {
    publicKey: key.public_key, alg: key.alg, signCount: Number(key.sign_count), userHandle: await passkeyUserHandle(key.user_id),
  }, body);
  guess.succeeded(); // a valid signature is never a guess
  // Conditional update: a replayed or parallel assertion with the same counter loses.
  const used = await one(
    `UPDATE passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1 AND ($2 = 0 OR sign_count < $2) RETURNING id`,
    [key.id, count],
  );
  if (!used) throw new HttpError(401, 'Passkey signature was already used');
  return (await one<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [key.user_id]))!;
}

/** An account by its name (also a disabled one). */
export async function getUser(id: string): Promise<User | undefined> {
  return one<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
}

export async function createSession(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  const token = newToken();
  await q(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, limits().sessionDays],
  );
  setCookie(req, res, SESSION_COOKIE, token, limits().sessionDays * 86400);
}

/** Signs the user out everywhere except the browser making this request (after a password change). */
export async function dropOtherSessions(req: IncomingMessage, userId: string): Promise<void> {
  const token = parseCookies(req)[SESSION_COOKIE];
  await q(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, token ? sha256(token) : '']);
}

/**
 * The signed-in user's password, before a sensitive change. Counted against the account only: the per-address counter
 * also takes wrong DAV passwords from a stale calendar app on the same network, which must not block the "confirm
 * your password" step that would fix that app.
 */
export async function requirePassword(_req: IncomingMessage, userId: string, password: unknown, message = 'Wrong password'): Promise<void> {
  const guess = attempt(null, userId);
  const row = await one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!row || !(await verifyPassword(String(password ?? ''), row.password_hash))) throw new HttpError(403, message);
  guess.succeeded();
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
/**
 * Credentials that just failed. A DAV client still holding an old password repeats the same wrong credentials on every
 * request; that is one failed guess, not one per request (it used to fill the per-address counter and lock the
 * household's browsers out of signing in). Repeats are refused from here, without counting and without another scrypt.
 */
const basicFailed = new Map<string, number>();

function rememberFailed(key: string): void {
  const now = Date.now();
  if (basicFailed.size > 5000) {
    for (const [k, until] of basicFailed) if (until <= now) basicFailed.delete(k);
    if (basicFailed.size > 5000) basicFailed.clear();
  }
  basicFailed.set(key, now + WINDOW_MS);
}

/** Checks running now, by credentials: a client that opens many connections at once (rclone, Finder) needs one. */
const basicPending = new Map<string, Promise<User | null>>();

export async function basicUser(req: IncomingMessage): Promise<User | null> {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return null;
  const key = sha256(h);
  const cached = basicCache.get(key);
  if (cached && cached.until > Date.now()) {
    return (await one<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND NOT disabled`, [cached.user])) ?? null;
  }
  // A burst of requests with the same new credentials shares one check (and one counted guess): each used to count
  // as a failure until its own scrypt finished, so twelve parallel requests with the right password got 429.
  const running = basicPending.get(key);
  if (running) return running;
  const check = checkBasic(req, h, key).finally(() => basicPending.delete(key));
  basicPending.set(key, check);
  return check;
}

async function checkBasic(req: IncomingMessage, h: string, key: string): Promise<User | null> {
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const id = decoded.slice(0, i);
  const pw = decoded.slice(i + 1);
  const row = ACCOUNT_RE.test(id) ? await one<User & { password_hash: string }>(
    `SELECT ${USER_COLS}, password_hash FROM users WHERE id = $1 AND NOT disabled`,
    [id],
  ) : undefined;
  // A valid app password always works, before any rate limit: it is a long random token, so a correct one is never
  // a guess, and a stale DAV client (old password, revoked app password) or a stranger filling the counters must
  // not lock out the user's other, correctly configured clients.
  const app = row && await one(
    `UPDATE app_passwords SET last_used_at = now() WHERE user_id = $1 AND token_hash = $2 RETURNING id`,
    [id, sha256(pw)],
  );
  if (!app && (basicFailed.get(key) ?? 0) > Date.now()) return null;
  let ok = !!app;
  if (!app) {
    // With two-factor on, only app passwords work here (the scrypt still runs, so timing shows nothing); only a real
    // password check counts against the account, like the login form.
    const passwordGuess = !!row && !row.totp_enabled;
    const guess = attempt(req, passwordGuess ? id : undefined);
    if (row && passwordGuess) ok = await verifyPassword(pw, row.password_hash);
    else await burnPasswordCheck(pw);
    if (ok) guess.succeeded();
  }
  if (!ok || !row) {
    rememberFailed(key);
    return null;
  }
  basicCache.set(key, { user: id, until: Date.now() + 5 * 60 * 1000 });
  const { password_hash: _, ...user } = row;
  return user;
}

/** After any password or app-password change: cached answers, good and bad, may no longer be right. */
export function forgetBasicCache(): void {
  basicCache.clear();
  basicFailed.clear();
}
