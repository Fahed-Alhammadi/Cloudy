import type { Router, Ctx } from '../http.ts';
import { config } from '../config.ts';
import { json, noContent, readJson, numId, HttpError } from '../http.ts';
import { q, one } from '../db.ts';
import {
  login, createSession, destroySession, hashPassword, checkPasswordStrength,
  newToken, sha256, forgetBasicCache, createAppToken, bearerToken, requirePassword, dropOtherSessions,
} from '../auth.ts';
import type { User } from '../auth.ts';
import { createUser, deleteUser, setGroups, userJson, USER_ID_RE } from '../users.ts';
import { rootOf } from '../files.ts';
import { newSecret, otpauthUri, verifyTotp, newRecoveryCodes, normalizeRecoveryCode } from '../totp.ts';
import QRCode from 'qrcode';
import { notifyPasswordChanged, EMAIL_RE } from '../mail.ts';
import { isLanguage } from '../i18n.ts';

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await q(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  for (const c of codes) await q(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, sha256(normalizeRecoveryCode(c))]);
  return codes;
}

async function resetTwoFactor(userId: string): Promise<void> {
  await q(`UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending = NULL, totp_last_step = 0 WHERE id = $1`, [userId]);
  await q(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  forgetBasicCache();
}

type Authed = (ctx: Ctx, user: User) => Promise<void>;

export function registerAccount(r: Router, authed: (h: Authed) => (ctx: Ctx) => Promise<void>, admin: (h: Authed) => (ctx: Ctx) => Promise<void>) {
  r.post('/api/login', async ({ req, res }) => {
    const body = await readJson(req);
    const user = await login(req, String(body.user ?? ''), String(body.password ?? ''), body.code == null ? undefined : String(body.code));
    await createSession(req, res, user.id);
    json(res, await userJson(user));
  });

  // Native apps: exchange credentials for a long-lived device token (an app password).
  r.post('/api/auth/token', async ({ req, res }) => {
    const body = await readJson(req);
    const user = await login(req, String(body.user ?? ''), String(body.password ?? ''), body.code == null ? undefined : String(body.code));
    const device = String(body.deviceName ?? '').trim().slice(0, 60) || 'Mobile device';
    const token = await createAppToken(user.id, `App: ${device}`);
    json(res, { token, user: { ...(await userJson(user)), rootId: (await rootOf(user.id)).id } }, 201);
  });

  r.post('/api/auth/revoke', async ({ req, res }) => {
    const token = bearerToken(req);
    if (token) await q(`DELETE FROM app_passwords WHERE token_hash = $1`, [sha256(token)]);
    forgetBasicCache();
    noContent(res);
  });

  r.post('/api/logout', async ({ req, res }) => {
    await destroySession(req, res);
    noContent(res);
  });

  r.get('/api/me', authed(async ({ res }, user) => {
    json(res, { ...(await userJson(user)), rootId: (await rootOf(user.id)).id, trashDays: config.trashDays });
  }));

  r.patch('/api/me', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    if (typeof b.email === 'string' && b.email.trim() && !EMAIL_RE.test(b.email.trim())) throw new HttpError(400, 'Invalid email address');
    await q(`UPDATE users SET display_name = COALESCE($2, display_name), email = COALESCE($3, email),
                              notify_shares = COALESCE($4, notify_shares) WHERE id = $1`,
      [user.id, typeof b.displayName === 'string' ? b.displayName.trim() || user.id : null,
       typeof b.email === 'string' ? b.email.trim() : null, typeof b.notifyShares === 'boolean' ? b.notifyShares : null]);
    // language: a supported code, or null / '' for "same as the browser or phone".
    if ('language' in b) {
      if (b.language && !isLanguage(b.language)) throw new HttpError(400, 'Unsupported language');
      await q(`UPDATE users SET language = $2 WHERE id = $1`, [user.id, b.language || null]);
    }
    noContent(res);
  }));

  // ---------------------------------------------------------------- two-factor authentication
  // 1. setup: create a secret (kept pending) and return it with a QR code for the authenticator app.
  r.post('/api/me/2fa/setup', authed(async ({ res }, user) => {
    if (user.totp_enabled) throw new HttpError(409, 'Two-factor authentication is already on');
    const secret = newSecret();
    await q(`UPDATE users SET totp_pending = $2 WHERE id = $1`, [user.id, secret]);
    const uri = otpauthUri('Cloudy', user.id, secret);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    json(res, { secret, uri, qrSvg });
  }));

  // 2. enable: confirm with a code from the app; returns one-time recovery codes (shown once).
  r.post('/api/me/2fa/enable', authed(async ({ req, res }, user) => {
    const code = String((await readJson(req)).code ?? '').replace(/\s/g, '');
    const row = await one<{ totp_pending: string | null }>(`SELECT totp_pending FROM users WHERE id = $1`, [user.id]);
    if (!row?.totp_pending) throw new HttpError(400, 'Start the setup first');
    const step = verifyTotp(row.totp_pending, code);
    if (step === null) throw new HttpError(400, 'That code is not valid — check the time on your phone and try again');
    await q(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = true, totp_last_step = $2 WHERE id = $1`,
      [user.id, step]);
    forgetBasicCache();
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
    forgetBasicCache();
    await dropOtherSessions(req, user.id); // a stolen browser session dies with the old password
    await notifyPasswordChanged(req, user.id);
    noContent(res);
  }));

  // App passwords for WebDAV / CalDAV / CardDAV clients.
  // `current` marks the token this request was made with (the phone asking), so it isn't revoked by mistake.
  r.get('/api/me/app-passwords', authed(async ({ req, res }, user) => {
    const bearer = bearerToken(req);
    json(res, await q(`SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", token_hash = $2 AS current
                         FROM app_passwords WHERE user_id = $1 ORDER BY created_at DESC`, [user.id, bearer ? sha256(bearer) : '']));
  }));

  r.post('/api/me/app-passwords', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    const name = String(b.name ?? '').trim() || 'Device';
    const token = [newToken(6), newToken(6), newToken(6)].join('-');
    await q(`INSERT INTO app_passwords (user_id, name, token_hash) VALUES ($1, $2, $3)`, [user.id, name, sha256(token)]);
    json(res, { name, password: token }, 201);
  }));

  r.delete('/api/me/app-passwords/:id', authed(async ({ res, params }, user) => {
    await q(`DELETE FROM app_passwords WHERE id = $1 AND user_id = $2`, [numId(params.id), user.id]);
    forgetBasicCache();
    noContent(res);
  }));

  // Sharee autocomplete: users and groups.
  r.get('/api/sharees', authed(async ({ res, url }, user) => {
    const pattern = '%' + (url.searchParams.get('q') ?? '').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const users = await q(`SELECT id, display_name AS "displayName" FROM users
                            WHERE id <> $1 AND NOT disabled AND (id ILIKE $2 OR display_name ILIKE $2) ORDER BY id LIMIT 20`,
      [user.id, pattern]);
    const groups = await q(`SELECT id FROM groups WHERE id ILIKE $1 ORDER BY id LIMIT 20`, [pattern]);
    json(res, { users, groups });
  }));

  // ---------------------------------------------------------------- admin
  r.get('/api/admin/users', admin(async ({ res }) => {
    const users = await q<User>(`SELECT id, display_name, email, is_admin, disabled, quota_bytes, totp_enabled, notify_shares FROM users ORDER BY id`);
    json(res, await Promise.all(users.map(userJson)));
  }));

  r.post('/api/admin/users', admin(async ({ req, res }) => {
    const b = await readJson(req);
    await createUser({
      id: String(b.id ?? '').trim(), password: b.password, displayName: b.displayName, email: b.email,
      isAdmin: !!b.isAdmin, quotaBytes: b.quotaBytes ?? null, groups: Array.isArray(b.groups) ? b.groups : undefined,
    });
    noContent(res);
  }));

  r.patch('/api/admin/users/:id', admin(async ({ req, res, params }, me) => {
    const b = await readJson(req);
    const target = await one(`SELECT id FROM users WHERE id = $1`, [params.id]);
    if (!target) throw new HttpError(404, 'No such user');
    if (params.id === me.id && (b.isAdmin === false || b.disabled === true)) {
      throw new HttpError(400, 'You cannot remove your own admin rights or disable yourself');
    }
    if (typeof b.displayName === 'string') await q(`UPDATE users SET display_name = $2 WHERE id = $1`, [params.id, b.displayName]);
    if (typeof b.email === 'string') await q(`UPDATE users SET email = $2 WHERE id = $1`, [params.id, b.email]);
    if (typeof b.isAdmin === 'boolean') await q(`UPDATE users SET is_admin = $2 WHERE id = $1`, [params.id, b.isAdmin]);
    if (typeof b.disabled === 'boolean') {
      await q(`UPDATE users SET disabled = $2 WHERE id = $1`, [params.id, b.disabled]);
      if (b.disabled) await q(`DELETE FROM sessions WHERE user_id = $1`, [params.id]);
    }
    if ('quotaBytes' in b) await q(`UPDATE users SET quota_bytes = $2 WHERE id = $1`, [params.id, b.quotaBytes ?? null]);
    if (typeof b.password === 'string' && b.password) {
      await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [params.id, await hashPassword(checkPasswordStrength(b.password))]);
      await q(`DELETE FROM sessions WHERE user_id = $1`, [params.id]);
    }
    if (Array.isArray(b.groups)) await setGroups(params.id, b.groups);
    // Lost phone: an administrator can turn two-factor off so the user can sign in and set it up again.
    if (b.resetTwoFactor === true) await resetTwoFactor(params.id);
    if (b.removePasskeys === true) await q(`DELETE FROM passkeys WHERE user_id = $1`, [params.id]);
    forgetBasicCache();
    noContent(res);
  }));

  r.delete('/api/admin/users/:id', admin(async ({ res, params }, me) => {
    if (params.id === me.id) throw new HttpError(400, 'You cannot delete yourself');
    await deleteUser(params.id);
    noContent(res);
  }));

  r.get('/api/admin/groups', admin(async ({ res }) => {
    json(res, await q(`SELECT g.id, count(m.user_id)::int AS members FROM groups g
                         LEFT JOIN group_members m ON m.group_id = g.id GROUP BY g.id ORDER BY g.id`));
  }));

  r.post('/api/admin/groups', admin(async ({ req, res }) => {
    const id = String((await readJson(req)).id ?? '').trim();
    if (!USER_ID_RE.test(id)) throw new HttpError(400, 'Invalid group name');
    await q(`INSERT INTO groups (id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    noContent(res);
  }));

  r.delete('/api/admin/groups/:id', admin(async ({ res, params }) => {
    await q(`DELETE FROM shares WHERE type = 'group' AND share_with = $1`, [params.id]);
    await q(`DELETE FROM groups WHERE id = $1`, [params.id]);
    noContent(res);
  }));
}
