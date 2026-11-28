import type { Router, Ctx } from '../http.ts';
import { config } from '../config.ts';
import { limits } from '../limits.ts';
import { json, noContent, readJson, numId, HttpError } from '../http.ts';
import { q, one } from '../db.ts';
import {
  login, createSession, destroySession, hashPassword, checkPasswordStrength,
  newToken, sha256, createAppToken, bearerToken, requirePassword, dropOtherSessions, attemptTotpSetup,
} from '../auth.ts';
import type { User } from '../auth.ts';
import { createUser, deleteUser, setGroups, userJson, quotaValue, USER_ID_RE } from '../users.ts';
import { rootOf } from '../files.ts';
import { newSecret, otpauthUri, verifyTotp, newRecoveryCodes, normalizeRecoveryCode } from '../totp.ts';
import QRCode from 'qrcode';
import { notifyPasswordChanged, notifyEmailChanged, validEmail } from '../mail.ts';
import { thumbnailsAvailable } from '../thumbs.ts';
import { canonicalTimeZone } from '../timezones.ts';
import { removeAvatar } from './avatars.ts';

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await q(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  for (const c of codes) await q(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, sha256(normalizeRecoveryCode(c))]);
  return codes;
}

async function resetTwoFactor(userId: string): Promise<void> {
  await q(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending = NULL, totp_pending_at = NULL, totp_last_step = 0 WHERE id = $1`, [userId]);
  await q(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
}

type Authed = (ctx: Ctx, user: User) => Promise<void>;

/** How long a two-factor setup waits for its confirming code. */
const TOTP_SETUP_MINUTES = 15;

/** The signed-in user as GET /api/me answers it (also after accepting an invitation). */
export async function meJson(user: User) {
  return { ...(await userJson(user)), rootId: (await rootOf(user.id)).id, trashDays: limits().trashDays, thumbnails: thumbnailsAvailable() };
}

export function registerAccount(r: Router, authed: (h: Authed) => (ctx: Ctx) => Promise<void>, admin: (h: Authed) => (ctx: Ctx) => Promise<void>) {
  r.post('/api/login', async ({ req, res }) => {
    const body = await readJson(req, 64 * 1024);
    const user = await login(req, String(body.user ?? ''), String(body.password ?? ''), body.code == null ? undefined : String(body.code));
    await createSession(req, res, user.id);
    json(res, await userJson(user));
  });

  // Native apps: exchange credentials for a long-lived device token.
  r.post('/api/auth/token', async ({ req, res }) => {
    const body = await readJson(req, 64 * 1024);
    const user = await login(req, String(body.user ?? ''), String(body.password ?? ''), body.code == null ? undefined : String(body.code));
    const device = String(body.deviceName ?? '').trim().slice(0, 60) || 'Mobile device';
    const token = await createAppToken(user.id, `App: ${device}`);
    json(res, { token, user: { ...(await userJson(user)), rootId: (await rootOf(user.id)).id } }, 201);
  });

  r.post('/api/auth/revoke', async ({ req, res }) => {
    const token = bearerToken(req);
    if (token) await q(`DELETE FROM app_passwords WHERE token_hash = $1`, [sha256(token)]);
    noContent(res);
  });

  r.post('/api/logout', async ({ req, res }) => {
    await destroySession(req, res);
    noContent(res);
  });

  r.get('/api/me', authed(async ({ res }, user) => {
    json(res, await meJson(user));
  }));

  r.patch('/api/me', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    if (typeof b.email === 'string' && b.email.trim() && !validEmail(b.email.trim())) throw new HttpError(400, 'Invalid email address');
    if (typeof b.displayName === 'string' && b.displayName.trim().length > 100) throw new HttpError(400, 'Display name is too long (max 100)');
    // The email receives password reset links: changing it needs the password (a stolen session must not be able to
    // take the account over). Saving the profile with the same address does not.
    const emailChanged = typeof b.email === 'string' && b.email.trim() !== user.email;
    if (emailChanged) await requirePassword(req, user.id, b.password);
    await q(`UPDATE users SET display_name = COALESCE($2, display_name), email = COALESCE($3, email),
                              notify_shares = COALESCE($4, notify_shares) WHERE id = $1`,
      [user.id, typeof b.displayName === 'string' ? b.displayName.trim() || user.id : null,
       typeof b.email === 'string' ? b.email.trim() : null, typeof b.notifyShares === 'boolean' ? b.notifyShares : null]);
    // The account's time zone (the web app sets it from the browser): used for link expiry dates from clients that do
    // not send one.
    if ('timezone' in b) {
      const tz = b.timezone ? canonicalTimeZone(b.timezone) : null;
      if (b.timezone && !tz) throw new HttpError(400, 'Unknown time zone');
      await q(`UPDATE users SET timezone = $2 WHERE id = $1`, [user.id, tz]);
    }
    if (emailChanged) notifyEmailChanged(req, user, user.email, b.email.trim());
    noContent(res);
  }));

  // Users delete their own account from the apps and the web (App Store 5.1.1(v), Google Play account deletion):
  // everything goes (files incl. trash and versions, shares, devices, sessions), confirmed with
  // the password. POST, not DELETE with a body, which some proxies drop. The last administrator can't leave the server
  // without one.
  r.post('/api/me/delete', authed(async ({ req, res }, user) => {
    await requirePassword(req, user.id, (await readJson(req)).password);
    if (user.is_admin) {
      const others = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT disabled AND id <> $1`, [user.id]);
      if (!others?.n) throw new HttpError(409, 'You are the only administrator. Make another user an administrator first.');
    }
    await deleteUser(user.id);
    await destroySession(req, res);
    noContent(res);
  }));

  // ---------------------------------------------------------------- two-factor authentication
  // 1. setup: create a secret (kept pending) and return it with a QR code for the authenticator app.
  // Needs the password: otherwise a stolen session could put its own authenticator on the account.
  r.post('/api/me/2fa/setup', authed(async ({ req, res }, user) => {
    await requirePassword(req, user.id, (await readJson(req)).password);
    if (user.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already on');
    const secret = newSecret();
    await q(`UPDATE users SET totp_pending = $2, totp_pending_at = now() WHERE id = $1`, [user.id, secret]);
    const uri = otpauthUri('Cloudy', user.id, secret);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    json(res, { secret, uri, qrSvg });
  }));

  // 2. enable: confirm with a code from the app; returns one-time recovery codes (shown once).
  // Within 15 minutes of step 1 (a setup left open used to wait for its code for ever), and with ten wrong codes at
  // most in 15 minutes (there was no limit: a million codes can be tried in an afternoon).
  r.post('/api/me/2fa/enable', authed(async ({ req, res }, user) => {
    const code = String((await readJson(req)).code ?? '').replace(/\s/g, '');
    const row = await one<{ totp_pending: string | null; expired: boolean }>(
      `SELECT totp_pending, (totp_pending_at IS NULL OR totp_pending_at < now() - interval '${TOTP_SETUP_MINUTES} minutes') AS expired
         FROM users WHERE id = $1`, [user.id]);
    if (!row?.totp_pending) throw new HttpError(400, 'Start the setup first');
    if (row.expired) {
      await q(`UPDATE users SET totp_pending = NULL, totp_pending_at = NULL WHERE id = $1 AND totp_pending = $2`, [user.id, row.totp_pending]);
      throw new HttpError(400, 'This setup has expired. Start it again.');
    }
    const guess = attemptTotpSetup(user.id); // 429 after ten wrong codes
    const step = verifyTotp(row.totp_pending, code);
    if (step === null) throw new HttpError(400, 'That code is not valid — check the time on your phone and try again'); // stays counted
    guess.succeeded();
    // "AND totp_pending = …": the secret this code was checked against, not one a second setup put there meanwhile.
    const done = await one(
      `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_pending_at = NULL, totp_enabled = true, totp_last_step = $2
        WHERE id = $1 AND totp_pending = $3 RETURNING id`, [user.id, step, row.totp_pending]);
    if (!done) throw new HttpError(400, 'Start the setup first');
    json(res, { recoveryCodes: await replaceRecoveryCodes(user.id) });
  }));

  r.post('/api/me/2fa/recovery-codes', authed(async ({ req, res }, user) => {
    await requirePassword(req, user.id, (await readJson(req)).password);
    if (!user.totp_enabled) throw new HttpError(400, 'Two-factor authentication is off');
    json(res, { recoveryCodes: await replaceRecoveryCodes(user.id) });
  }));

  r.post('/api/me/2fa/disable', authed(async ({ req, res }, user) => {
    await requirePassword(req, user.id, (await readJson(req)).password);
    await resetTwoFactor(user.id);
    noContent(res);
  }));

  r.post('/api/me/password', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    await requirePassword(req, user.id, b.current, 'Current password is wrong');
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, await hashPassword(checkPasswordStrength(b.password))]);
    await dropOtherSessions(req, user.id); // a stolen browser session dies with the old password
    // Device tokens too (a stolen laptop or phone keeps syncing otherwise), except the device making this change.
    const bearer = bearerToken(req);
    await q(`DELETE FROM app_passwords WHERE user_id = $1 AND token_hash <> $2`, [user.id, bearer ? sha256(bearer) : '']);
    await notifyPasswordChanged(req, user.id);
    noContent(res);
  }));

  // Signed-in devices (the apps' device tokens), listed and revocable.
  // `current` marks the token this request was made with (the phone asking), so it isn't revoked by mistake.
  r.get('/api/me/app-passwords', authed(async ({ req, res }, user) => {
    const bearer = bearerToken(req);
    json(res, await q(`SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", token_hash = $2 AS current
                         FROM app_passwords WHERE user_id = $1 ORDER BY created_at DESC`, [user.id, bearer ? sha256(bearer) : '']));
  }));

  r.delete('/api/me/app-passwords/:id', authed(async ({ res, params }, user) => {
    await q(`DELETE FROM app_passwords WHERE id = $1 AND user_id = $2`, [numId(params.id), user.id]);
    noContent(res);
  }));

  // Sharee autocomplete: users (with their profile picture's version, or null) and groups.
  r.get('/api/sharees', authed(async ({ res, url }, user) => {
    const pattern = '%' + (url.searchParams.get('q') ?? '').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const users = await q(`SELECT u.id, u.display_name AS "displayName", a.etag AS avatar FROM users u LEFT JOIN avatars a ON a.user_id = u.id
                            WHERE u.id <> $1 AND NOT u.disabled AND (u.id ILIKE $2 OR u.display_name ILIKE $2) ORDER BY u.id LIMIT 20`,
      [user.id, pattern]);
    const groups = await q(`SELECT id FROM groups WHERE id ILIKE $1 ORDER BY id LIMIT 20`, [pattern]);
    json(res, { users, groups });
  }));

  // ---------------------------------------------------------------- admin
  r.get('/api/admin/users', admin(async ({ res }) => {
    const users = await q<User>(`SELECT id, display_name, email, is_admin, disabled, quota_bytes, totp_enabled, notify_shares FROM users ORDER BY id`);
    json(res, await Promise.all(users.map(userJson)));
  }));

  // Making an administrator, setting someone's password or email address, turning off someone's two-factor sign-in
  // and deleting someone need the acting administrator's own password (`adminPassword`), like the sensitive changes to one's own account:
  // an administrator's browser left open, or a stolen session, could otherwise take over every account on the server
  // in one request. The email address counts because a password reset link is sent to it.
  r.post('/api/admin/users', admin(async ({ req, res }, me) => {
    const b = await readJson(req);
    if (typeof b.email === 'string' && b.email.trim() && !validEmail(b.email.trim())) throw new HttpError(400, 'Invalid email address');
    if (b.isAdmin) await requirePassword(req, me.id, b.adminPassword);
    await createUser({
      id: String(b.id ?? '').trim(), password: b.password, displayName: b.displayName, email: b.email,
      isAdmin: !!b.isAdmin, quotaBytes: b.quotaBytes ?? null, groups: Array.isArray(b.groups) ? b.groups : undefined,
    });
    noContent(res);
  }));

  r.patch('/api/admin/users/:id', admin(async ({ req, res, params }, me) => {
    const b = await readJson(req);
    const target = await one<{ id: string; email: string; is_admin: boolean }>(`SELECT id, email, is_admin FROM users WHERE id = $1`, [params.id]);
    if (!target) throw new HttpError(404, 'No such user');
    if (params.id === me.id && (b.isAdmin === false || b.disabled === true)) {
      throw new HttpError(400, 'You cannot remove your own admin rights or disable yourself');
    }
    if (typeof b.displayName === 'string' && b.displayName.trim().length > 100) throw new HttpError(400, 'Display name is too long (max 100)');
    if (typeof b.email === 'string' && b.email.trim() && b.email.trim() !== target.email && !validEmail(b.email.trim())) throw new HttpError(400, 'Invalid email address');
    // Before the first change below: a request refused for its password changes nothing.
    // Only for what actually changes: a page opened before this rule sends `isAdmin` and `email` with every save, and
    // saving an administrator's display name must not be refused for that.
    const promotes = b.isAdmin === true && !target.is_admin;
    const newEmail = typeof b.email === 'string' && b.email.trim() !== (target.email ?? '');
    if ((typeof b.password === 'string' && b.password) || b.resetTwoFactor === true || promotes || newEmail) {
      await requirePassword(req, me.id, b.adminPassword);
    }
    if (typeof b.displayName === 'string') await q(`UPDATE users SET display_name = $2 WHERE id = $1`, [params.id, b.displayName.trim() || params.id]);
    if (typeof b.email === 'string') await q(`UPDATE users SET email = $2 WHERE id = $1`, [params.id, b.email.trim()]);
    if (typeof b.isAdmin === 'boolean') await q(`UPDATE users SET is_admin = $2 WHERE id = $1`, [params.id, b.isAdmin]);
    if (typeof b.disabled === 'boolean') {
      await q(`UPDATE users SET disabled = $2 WHERE id = $1`, [params.id, b.disabled]);
      if (b.disabled) await q(`DELETE FROM sessions WHERE user_id = $1`, [params.id]);
    }
    if ('quotaBytes' in b) await q(`UPDATE users SET quota_bytes = $2 WHERE id = $1`, [params.id, quotaValue(b.quotaBytes)]);
    if (typeof b.password === 'string' && b.password) {
      await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [params.id, await hashPassword(checkPasswordStrength(b.password))]);
      await q(`DELETE FROM sessions WHERE user_id = $1`, [params.id]);
      await q(`DELETE FROM app_passwords WHERE user_id = $1`, [params.id]); // device tokens too: a reset signs out everywhere
    }
    if (Array.isArray(b.groups)) await setGroups(params.id, b.groups);
    // Lost phone: an administrator can turn two-factor off so the user can sign in and set it up again.
    if (b.resetTwoFactor === true) await resetTwoFactor(params.id);
    if (b.removePasskeys === true) await q(`DELETE FROM passkeys WHERE user_id = $1`, [params.id]);
    // Moderation: a profile picture that should not be shown to everyone.
    if (b.removeAvatar === true) await removeAvatar(params.id);
    noContent(res);
  }));

  // Deleting someone removes all their files for good, so it is confirmed with the acting administrator's own
  // password too (`adminPassword`): an administrator's browser left open could otherwise empty the server.
  // POST …/delete is what the web app sends (the same shape as POST /api/me/delete; some proxies drop the body of a
  // DELETE request); DELETE with the same JSON body does the same.
  const removeUser = admin(async ({ req, res, params }, me) => {
    if (params.id === me.id) throw new HttpError(400, 'You cannot delete yourself');
    const b = await readJson(req);
    await requirePassword(req, me.id, b.adminPassword);
    await deleteUser(params.id);
    noContent(res);
  });
  r.post('/api/admin/users/:id/delete', removeUser);
  r.delete('/api/admin/users/:id', removeUser);

  r.get('/api/admin/groups', admin(async ({ res }) => {
    json(res, await q(`SELECT g.id, count(m.user_id)::int AS members FROM groups g
                         LEFT JOIN group_members m ON m.group_id = g.id GROUP BY g.id ORDER BY g.id`));
  }));

  r.post('/api/admin/groups', admin(async ({ req, res }) => {
    const id = String((await readJson(req)).id ?? '').trim();
    if (!USER_ID_RE.test(id)) throw new HttpError(400, 'Invalid group name');
    // A group that exists already is said so (it was silently accepted).
    if (!(await one(`INSERT INTO groups (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [id]))) throw new HttpError(409, 'A group with that name exists');
    noContent(res);
  }));

  r.delete('/api/admin/groups/:id', admin(async ({ res, params }) => {
    await q(`DELETE FROM shares WHERE type = 'group' AND share_with = $1`, [params.id]);
    await q(`DELETE FROM groups WHERE id = $1`, [params.id]);
    noContent(res);
  }));
}
