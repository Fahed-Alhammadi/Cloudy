// Outgoing email: SMTP settings (Administration → Email), password reset by email, and notifications
// (something was shared with you, your password was changed). Mail is sent in the background; a
// failure is logged and never fails the request that caused it.
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { IncomingMessage } from 'node:http';
import type { Router, Ctx } from './http.ts';
import { json, noContent, readJson, HttpError, publicOrigin, clientIp } from './http.ts';
import { config } from './config.ts';
import { q, one } from './db.ts';
import type { User } from './auth.ts';
import { hashPassword, checkPasswordStrength, newToken, sha256, forgetBasicCache } from './auth.ts';
import { pickLanguage, mailText, isRtl } from './i18n.ts';
import type { Lang } from './i18n.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

export interface MailConfig {
  host: string;
  port: number;
  /** 'tls' = implicit TLS (usually 465), 'starttls' = upgrade (587), 'none' = plain (local relays only). */
  security: 'tls' | 'starttls' | 'none';
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  /** Address of the web app as the admin opened it when saving these settings (used for links in emails). */
  origin?: string;
}

const RESET_MINUTES = 60;
export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/**
 * Origin for links in emails. The Host header of an unauthenticated request (password reset) must not decide
 * it: an attacker could request a reset for someone else with `Host: evil.example` and the victim would get a
 * genuine Cloudy email pointing at the attacker's site. So only PUBLIC_URL counts, or the address the admin
 * used when saving the email settings. Returns null when neither is known.
 */
export async function mailOrigin(): Promise<string | null> {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  return (await mailConfig())?.origin || null;
}

// ---------------------------------------------------------------- settings

let cached: MailConfig | null | undefined;
let transport: { key: string; t: Transporter } | null = null;

export async function mailConfig(): Promise<MailConfig | null> {
  if (cached !== undefined) return cached;
  const row = await one<{ value: string }>(`SELECT value FROM settings WHERE key = 'smtp'`);
  cached = row ? (JSON.parse(row.value) as MailConfig) : null;
  return cached;
}

export const mailEnabled = async () => !!(await mailConfig())?.host;

async function saveConfig(c: MailConfig | null): Promise<void> {
  if (c) await q(`INSERT INTO settings (key, value) VALUES ('smtp', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(c)]);
  else await q(`DELETE FROM settings WHERE key = 'smtp'`);
  cached = c;
  transport = null;
}

function transporter(c: MailConfig): Transporter {
  const key = JSON.stringify(c);
  if (transport?.key !== key) {
    transport = {
      key,
      t: nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.security === 'tls',
        requireTLS: c.security === 'starttls',
        ignoreTLS: c.security === 'none',
        auth: c.user ? { user: c.user, pass: c.password } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return transport.t;
}

// ---------------------------------------------------------------- sending

interface Message { to: string; subject: string; text: string; action?: { label: string; url: string }; lang?: Lang }

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function html(m: Message): string {
  const paras = m.text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = m.action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(m.action.url)}" style="background:#3d6ff0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(m.action.label)}</a></p>`
    : '';
  const lang = m.lang ?? 'en';
  return `<!doctype html><html lang="${lang}" dir="${isRtl(lang) ? 'rtl' : 'ltr'}"><body style="margin:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2633">
<div style="max-width:520px;margin:24px auto;background:#fff;border-radius:12px;padding:28px 28px 18px">
<div style="font-weight:600;font-size:18px;margin-bottom:18px">☁ Cloudy</div>${paras}${button}</div></body></html>`;
}

/** Sends now and throws on failure (used by "Send test email"). */
export async function sendMailNow(m: Message): Promise<void> {
  const c = await mailConfig();
  if (!c?.host) throw new HttpError(400, 'Email is not set up');
  const text = m.action ? `${m.text}\n\n${m.action.label}: ${m.action.url}` : m.text;
  await transporter(c).sendMail({
    from: { name: c.fromName || 'Cloudy', address: c.fromEmail },
    to: m.to,
    subject: m.subject,
    text,
    html: html(m),
  });
}

/** Sends in the background; failures are logged. Does nothing when email isn't set up. */
export function sendMail(m: Message): void {
  void (async () => {
    if (!(await mailEnabled())) return;
    await sendMailNow(m);
  })().catch((e) => console.error(`mail to ${m.to} failed:`, e.message));
}

// ---------------------------------------------------------------- notifications

/** Something was shared with a user or a group: tell each recipient who wants to know. */
export async function notifyShare(req: IncomingMessage, sharer: User, nodeId: number, type: string, shareWith: string): Promise<void> {
  if (!(await mailEnabled())) return;
  const node = await one<{ name: string; is_dir: boolean }>(`SELECT name, is_dir FROM nodes WHERE id = $1`, [nodeId]);
  if (!node) return;
  const recipients = await q<{ email: string; display_name: string; language: string | null }>(
    type === 'group'
      ? `SELECT u.email, u.display_name, u.language FROM group_members m JOIN users u ON u.id = m.user_id
          WHERE m.group_id = $1 AND u.id <> $2 AND NOT u.disabled AND u.notify_shares AND u.email <> ''`
      : `SELECT email, display_name, language FROM users WHERE id = $1 AND id <> $2 AND NOT disabled AND notify_shares AND email <> ''`,
    [shareWith, sharer.id],
  );
  const who = sharer.display_name || sharer.id;
  for (const r of recipients) {
    const lang = pickLanguage(r.language);
    const vars = { who, name: node.name, user: r.display_name || '', group: type === 'group' ? mailText(lang, 'shareGroup', { group: shareWith }) : '' };
    sendMail({
      to: r.email, lang,
      subject: mailText(lang, 'shareSubject', vars),
      text: mailText(lang, node.is_dir ? 'shareFolder' : 'shareFile', vars),
      action: { label: mailText(lang, 'open'), url: `${(await mailOrigin()) ?? publicOrigin(req)}/#/shared-in` },
    });
  }
}

/** Security notice after a password change or reset. */
export async function notifyPasswordChanged(req: IncomingMessage, userId: string): Promise<void> {
  const u = await one<{ email: string; display_name: string; language: string | null }>(
    `SELECT email, display_name, language FROM users WHERE id = $1`, [userId]);
  if (!u?.email) return;
  const lang = pickLanguage(u.language, req);
  sendMail({
    to: u.email, lang,
    subject: mailText(lang, 'pwSubject'),
    text: mailText(lang, 'pwText', { user: u.display_name || userId, id: userId, ip: clientIp(req) }),
    action: { label: mailText(lang, 'open'), url: (await mailOrigin()) ?? publicOrigin(req) },
  });
}

// ---------------------------------------------------------------- password reset

// Keeps the reset endpoint from being used to flood inboxes: per IP and per account.
const resetRequests = new Map<string, number[]>();
function allowReset(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (resetRequests.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  resetRequests.set(key, recent);
  if (resetRequests.size > 10_000) resetRequests.clear();
  return true;
}

export async function expirePasswordResets(): Promise<void> {
  await q(`DELETE FROM password_resets WHERE expires_at < now()`);
}

export function registerMail(r: Router, authed: Wrap, admin: Wrap) {
  // What the login page offers (no account information).
  r.get('/api/auth/options', async ({ res }) => {
    json(res, { passwordReset: await mailEnabled() });
  });

  // Step 1: always answers 204, whether or not the account exists, so it can't be used to find accounts.
  r.post('/api/auth/forgot', async ({ req, res }) => {
    const login = String((await readJson(req)).login ?? '').trim();
    if (!login || !(await mailEnabled())) return noContent(res);
    if (!allowReset(`ip:${clientIp(req)}`, 5, 3600_000)) throw new HttpError(429, 'Too many requests, try again later');
    const origin = await mailOrigin();
    if (!origin) {
      console.warn('Password reset requested but neither PUBLIC_URL nor the email settings know the address of this server: set PUBLIC_URL or save the email settings again.');
      return noContent(res);
    }
    const u = await one<{ id: string; email: string; display_name: string; language: string | null }>(
      `SELECT id, email, display_name, language FROM users WHERE (id = $1 OR lower(email) = lower($1)) AND NOT disabled AND email <> '' LIMIT 1`, [login]);
    if (u && allowReset(`user:${u.id}`, 3, 3600_000)) {
      const token = newToken(32);
      await q(`DELETE FROM password_resets WHERE user_id = $1`, [u.id]);
      await q(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [sha256(token), u.id, RESET_MINUTES]);
      const lang = pickLanguage(u.language, req);
      sendMail({
        to: u.email, lang,
        subject: mailText(lang, 'resetSubject'),
        text: mailText(lang, 'resetText', { user: u.display_name || u.id, id: u.id, minutes: RESET_MINUTES }),
        action: { label: mailText(lang, 'resetAction'), url: `${origin}/#/reset/${token}` },
      });
    }
    noContent(res);
  });

  // Step 2: the link's token + a new password. Signs the account out everywhere.
  r.post('/api/auth/reset', async ({ req, res }) => {
    const b = await readJson(req);
    const password = checkPasswordStrength(b.password);
    const row = await one<{ user_id: string }>(
      `DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`, [sha256(String(b.token ?? ''))]);
    if (!row) throw new HttpError(400, 'This reset link is invalid or has expired. Ask for a new one.');
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [row.user_id, await hashPassword(password)]);
    await q(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);
    forgetBasicCache();
    await notifyPasswordChanged(req, row.user_id);
    noContent(res);
  });

  // ---- administration
  r.get('/api/admin/mail', admin(async ({ res }) => {
    const c = await mailConfig();
    json(res, c ? { ...c, password: undefined, hasPassword: !!c.password } : null);
  }));

  // Empty host turns email off. An empty password keeps the stored one (it is never sent back).
  r.put('/api/admin/mail', admin(async ({ req, res }) => {
    const b = await readJson(req);
    const host = String(b.host ?? '').trim();
    if (!host) {
      await saveConfig(null);
      return noContent(res);
    }
    const security = ['tls', 'starttls', 'none'].includes(b.security) ? b.security : 'starttls';
    const port = Number(b.port) || (security === 'tls' ? 465 : 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Invalid port');
    const fromEmail = String(b.fromEmail ?? '').trim();
    if (!EMAIL_RE.test(fromEmail)) throw new HttpError(400, 'Enter the sender address (From email)');
    const prev = await mailConfig();
    await saveConfig({
      host, port, security,
      user: String(b.user ?? '').trim(),
      password: typeof b.password === 'string' && b.password ? b.password : (b.clearPassword ? '' : prev?.password ?? ''),
      fromName: String(b.fromName ?? '').trim().slice(0, 80) || 'Cloudy',
      fromEmail,
      origin: publicOrigin(req), // the admin's own request: a trustworthy address for links in emails
    });
    noContent(res);
  }));

  r.post('/api/admin/mail/test', admin(async ({ req, res }, me) => {
    const to = String((await readJson(req)).to ?? '').trim() || me.email;
    if (!EMAIL_RE.test(to)) throw new HttpError(400, 'Enter an address to send the test to (or add an email to your profile)');
    try {
      const lang = pickLanguage(me.language, req);
      await sendMailNow({
        to, lang,
        subject: mailText(lang, 'testSubject'),
        text: mailText(lang, 'testText'),
        action: { label: mailText(lang, 'open'), url: publicOrigin(req) },
      });
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `Sending failed: ${e.message}`);
    }
    json(res, { to });
  }));
}
