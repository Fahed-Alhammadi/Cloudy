// Invitations: an administrator invites someone (a link, and an email when one is set up), who then chooses their own
// username and password. The link's one-time token rides in the fragment (/invite#<token>, out of proxy logs) and is
// stored as SHA-256; it works for 7 days. An invitation never grants admin rights, and one invitation makes at most
// one account, also when its link is used twice at the same moment.
import type { IncomingMessage } from 'node:http';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, numId, publicOrigin, HttpError } from '../http.ts';
import { q, one, tx } from '../db.ts';
import type { User } from '../auth.ts';
import { newToken, sha256, hashPassword, attemptInvitation, createSession, getUser } from '../auth.ts';
import { checkNewUser, checkGroups, insertUser, quotaValue } from '../users.ts';
import { mailEnabled, mailOrigin, sendMailNow, validEmail } from '../mail.ts';
import { mailText } from '../mailtext.ts';
import { meJson } from './account.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

const VALID_DAYS = 7;
const INVALID = 'This invitation is invalid or has expired. Ask for a new one.';
/** A link's token: newToken(32), 43 base64url characters. Anything else (a link cut off in an email) is not looked up. */
const TOKEN_RE = /^[\w-]{43}$/;

interface Invitation {
  id: number;
  token_hash: string;
  email: string;
  display_name: string;
  quota_bytes: number | null;
  groups: string[];
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  emailed_at: Date | null;
}

export async function expireInvitations(): Promise<void> {
  await q(`DELETE FROM invitations WHERE expires_at < now()`);
}

/**
 * The unexpired invitation of a link. Every lookup counts as a guess for the client's address until it finds one
 * (ten wrong ones in 15 minutes, then 429); a token that cannot be one is answered without a lookup or a count.
 */
async function byToken(req: IncomingMessage, token: unknown): Promise<Invitation & { inviter_name: string | null }> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new HttpError(400, INVALID);
  const guess = attemptInvitation(req);
  const inv = await one<Invitation & { inviter_name: string | null }>(
    `SELECT i.*, u.display_name AS inviter_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.expires_at > now()`, [sha256(token)]);
  if (!inv) throw new HttpError(400, INVALID); // the guess stays counted
  guess.succeeded();
  return inv;
}

/** Text reduced to a username: accents dropped ("Zoë" → "zoe"), spaces as dots, other characters left out, ≤ 64. */
export function usernameFrom(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').trim().replace(/\s+/g, '.').replace(/[^a-zA-Z0-9._@-]+/g, '')
    .replace(/([._@-])[._@-]+/g, '$1').replace(/^[._@-]+/, '').toLowerCase().slice(0, 64).replace(/[._@-]+$/, '');
}

/**
 * A username to offer: the email's local part (without a "+tag"), else the display name, with 2, 3… appended while
 * the name is taken (in any case). '' when nothing usable is left (an Arabic name and no email, say).
 */
export async function suggestUsername(email: string, displayName: string): Promise<string> {
  const base = usernameFrom(email.split('@')[0].split('+')[0]) || usernameFrom(displayName);
  if (!base) return '';
  // Every candidate starts with the first 58 characters (room for a number of six digits): one query finds all taken.
  const stem = base.slice(0, 58).replace(/[\\%_]/g, (c) => '\\' + c);
  const taken = new Set((await q<{ id: string }>(`SELECT lower(id) AS id FROM users WHERE lower(id) LIKE $1`, [stem + '%'])).map((u) => u.id));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n);
    const name = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
}

/** Group names from a request: a list (anything else is none), each once. */
function groupList(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map(String))] : [];
}

/**
 * The answer to creating or renewing an invitation. With `send`, the email goes out now (not in the background), so the
 * administrator sees a failure; the invitation exists either way and its link can be passed on by hand.
 */
async function deliver(req: IncomingMessage, me: User, inv: Invitation, token: string, send: boolean) {
  const url = `${(await mailOrigin()) ?? publicOrigin(req)}/invite#${token}`;
  const out: { id: number; url: string; expiresAt: Date; emailed: boolean; emailError?: string } =
    { id: inv.id, url, expiresAt: inv.expires_at, emailed: false };
  if (!send || !inv.email || !(await mailEnabled())) return out;
  const inviter = inv.invited_by ? await one<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [inv.invited_by]) : undefined;
  const who = inviter?.display_name || me.display_name || me.id;
  try {
    await sendMailNow({
      to: inv.email,
      subject: mailText('inviteSubject', { who }),
      text: mailText('inviteText', {
        who, days: VALID_DAYS, name: inv.display_name ? mailText('inviteName', { name: inv.display_name }) : '',
      }),
      action: { label: mailText('inviteAction'), url },
    });
    await q(`UPDATE invitations SET emailed_at = now() WHERE id = $1`, [inv.id]);
    out.emailed = true;
  } catch (e: any) {
    out.emailError = `Sending failed: ${e?.message ?? e}`;
  }
  return out;
}

export function registerInvitations(r: Router, admin: Wrap) {
  // ---------------------------------------------------------------- administration
  r.get('/api/admin/invitations', admin(async ({ res }) => {
    json(res, await q(
      `SELECT i.id, i.email, i.display_name AS "displayName", i.invited_by AS "invitedBy", u.display_name AS "invitedByName",
              i.quota_bytes AS "quotaBytes", i.groups, i.created_at AS "createdAt", i.expires_at AS "expiresAt", i.emailed_at AS "emailedAt"
         FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.expires_at > now() ORDER BY i.created_at DESC, i.id DESC`));
  }));

  // Checked like a new account (address, display name, groups, quota); there is no admin flag to give.
  r.post('/api/admin/invitations', admin(async ({ req, res }, me) => {
    const b = await readJson(req);
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (email && !validEmail(email)) throw new HttpError(400, 'Invalid email address');
    const send = b.send === true;
    if (send && !email) throw new HttpError(400, 'Enter the email address to send the invitation to');
    const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
    if (displayName.length > 100) throw new HttpError(400, 'Display name is too long (max 100)');
    const quota = quotaValue(b.quotaBytes);
    const groups = groupList(b.groups);
    await checkGroups(groups);
    const token = newToken(32);
    const inv = await tx(async (db) => {
      // A new invitation to the same address replaces the one before (whose link stops working).
      if (email) await q(`DELETE FROM invitations WHERE email <> '' AND lower(email) = lower($1)`, [email], db);
      return (await one<Invitation>(
        `INSERT INTO invitations (token_hash, email, display_name, quota_bytes, groups, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING *`,
        [sha256(token), email, displayName, quota, groups, me.id, VALID_DAYS], db))!;
    });
    json(res, await deliver(req, me, inv, token, send), 201);
  }));

  // A new link with seven new days (the old link stops working), emailed again on request.
  r.post('/api/admin/invitations/:id/resend', admin(async ({ req, res, params }, me) => {
    const send = (await readJson(req)).send === true;
    const id = numId(params.id);
    const current = await one<Invitation>(`SELECT * FROM invitations WHERE id = $1`, [id]);
    if (!current) throw new HttpError(404, 'No such invitation');
    if (send && !current.email) throw new HttpError(400, 'Enter the email address to send the invitation to');
    const token = newToken(32);
    const inv = await one<Invitation>(
      `UPDATE invitations SET token_hash = $2, expires_at = now() + make_interval(days => $3), emailed_at = NULL
        WHERE id = $1 RETURNING *`, [id, sha256(token), VALID_DAYS]);
    if (!inv) throw new HttpError(404, 'No such invitation'); // accepted or withdrawn meanwhile
    json(res, await deliver(req, me, inv, token, send));
  }));

  r.delete('/api/admin/invitations/:id', admin(async ({ res, params }) => {
    await q(`DELETE FROM invitations WHERE id = $1`, [numId(params.id)]);
    noContent(res);
  }));

  // ---------------------------------------------------------------- the invited person (not signed in)
  // What the page shows before the form, with a username to start from.
  r.post('/api/invitations/check', async ({ req, res }) => {
    const inv = await byToken(req, (await readJson(req, 64 * 1024)).token);
    json(res, {
      email: inv.email, displayName: inv.display_name, invitedBy: inv.inviter_name ?? null, expiresAt: inv.expires_at,
      username: await suggestUsername(inv.email, inv.display_name),
    });
  });

  // Creates the account and signs the browser in. A refused name or password, or a name already taken, leaves the
  // invitation as it was (the person tries again). Any admin flag sent along is ignored.
  r.post('/api/invitations/accept', async ({ req, res }) => {
    const b = await readJson(req, 64 * 1024);
    const found = await byToken(req, b.token);
    const id = typeof b.username === 'string' ? b.username.trim() : '';
    const displayName = (typeof b.displayName === 'string' ? b.displayName.trim() : '') || found.display_name;
    checkNewUser({ id, password: b.password, displayName });
    // The invitation's address; one typed in only when the invitation came without.
    let email = found.email;
    if (!email && typeof b.email === 'string' && b.email.trim()) {
      email = b.email.trim();
      if (!validEmail(email)) throw new HttpError(400, 'Invalid email address');
    }
    // A name already taken is answered before the slow hash: the token is valid (its guess was taken back), so 409s
    // are not counted, and each would otherwise cost a full scrypt run. insertUser checks again under its lock.
    if (await one(`SELECT 1 FROM users WHERE lower(id) = lower($1)`, [id])) throw new HttpError(409, 'User already exists');
    const passwordHash = await hashPassword(b.password); // before any lock: scrypt takes a while
    await tx(async (db) => {
      // The invitation stays locked until the account exists: a second use of the link waits here, then finds it gone
      // (or renewed under a new token) and gets the 400.
      const inv = await one<Invitation>(
        `SELECT * FROM invitations WHERE token_hash = $1 AND expires_at > now() FOR UPDATE`, [found.token_hash], db);
      if (!inv) throw new HttpError(400, INVALID);
      await insertUser(db, { id, passwordHash, displayName, email, isAdmin: false, quotaBytes: inv.quota_bytes });
      await q(`INSERT INTO group_members (group_id, user_id) SELECT id, $2 FROM groups WHERE id = ANY($1::text[]) ON CONFLICT DO NOTHING`,
        [inv.groups, id], db); // its groups that still exist
      await q(`DELETE FROM invitations WHERE id = $1`, [inv.id], db);
    });
    await createSession(req, res, id);
    json(res, await meJson((await getUser(id))!), 201);
  });
}
