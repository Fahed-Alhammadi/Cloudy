import type { IncomingMessage } from 'node:http';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, checkName, parseCookies, setCookie, numId, HttpError } from '../http.ts';
import { q, one } from '../db.ts';
import type { User } from '../auth.ts';
import { newToken, hashPassword, verifyPassword, sign, checkRate, attempt } from '../auth.ts';
import * as F from '../files.ts';
import { sendNodeFile, sendZip } from '../download.ts';
import { sendThumbnail, thumbnailsAvailable } from '../thumbs.ts';
import { validTimeZone, zonedToUtc } from '../timezones.ts';
import { notifyShare } from '../mail.ts';
import { startUpload } from './files.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

interface Share {
  id: number;
  node_id: number;
  owner: string;
  type: 'user' | 'group' | 'link';
  share_with: string | null;
  can_edit: boolean;
  token: string | null;
  password_hash: string | null;
  expires_at: Date | null;
  label: string;
  created_at: Date;
  /** Display name of the user it is shared with (from SHARE_ROW). */
  share_with_name?: string | null;
}

/** Share rows with the display name of the user each is shared with: people know each other by name. */
const SHARE_ROW = `SELECT s.*, u.display_name AS share_with_name FROM shares s LEFT JOIN users u ON s.type = 'user' AND u.id = s.share_with`;

function shareJson(s: Share) {
  return {
    id: s.id,
    nodeId: s.node_id,
    type: s.type,
    shareWith: s.share_with,
    shareWithName: s.share_with_name ?? null,
    canEdit: s.can_edit,
    token: s.token,
    url: s.token ? `/s/${s.token}` : null,
    hasPassword: !!s.password_hash,
    expiresAt: s.expires_at,
    label: s.label,
    createdAt: s.created_at,
  };
}

/**
 * An expiry date. The web app sends an instant; the phone apps send the end of the chosen day without a zone
 * ("2026-12-31T23:59:59"), which used to be read in the server's zone (UTC in the container): east of UTC the link
 * lasted into the next day, west of it the link died in the afternoon. Without a zone, the account's zone is used.
 */
function parseExpiry(v: unknown, tz: string | null): Date | null {
  if (v == null || v === '') return null;
  const s = String(v);
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (local && tz && validTimeZone(tz)) {
    const [, y, mo, d, h = '23', mi = '59', sec = local[4] ? '0' : '59'] = local;
    return new Date(zonedToUtc(tz, +y, +mo, +d, +h, +mi, +sec));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid expiry date');
  return d;
}

/** A link password: at least 4 characters (one character was accepted, and guessed in no time). */
function linkPassword(v: unknown): string {
  const s = String(v);
  if (s.length < 4) throw new HttpError(400, 'Link passwords need at least 4 characters');
  return s;
}

async function ownShare(user: User, id: string): Promise<Share> {
  const s = await one<Share>(`SELECT * FROM shares WHERE id = $1`, [numId(id)]);
  if (!s || s.owner !== user.id) throw new HttpError(404, 'Share not found');
  return s;
}

export function registerShares(r: Router, authed: Wrap) {
  r.get('/api/nodes/:id/shares', authed(async ({ res, params }, user) => {
    const { node, acc } = await F.requireAccess(user.id, params.id, 'read');
    if (acc.perm !== 'owner') throw new HttpError(403, 'Only the owner can manage shares');
    json(res, (await q<Share>(`${SHARE_ROW} WHERE s.node_id = $1 ORDER BY s.created_at`, [node.id])).map(shareJson));
  }));

  r.post('/api/nodes/:id/shares', authed(async ({ req, res, params }, user) => {
    const { node, acc } = await F.requireAccess(user.id, params.id, 'read');
    if (acc.perm !== 'owner') throw new HttpError(403, 'Only the owner can share this item');
    if (node.parent_id === null) throw new HttpError(400, 'The root folder cannot be shared');
    const b = await readJson(req);
    const type = b.type;
    let shareWith: string | null = null;
    let token: string | null = null;
    if (type === 'user') {
      shareWith = String(b.shareWith ?? '');
      if (shareWith === user.id) throw new HttpError(400, 'You cannot share with yourself');
      if (!(await one(`SELECT 1 FROM users WHERE id = $1`, [shareWith]))) throw new HttpError(404, 'No such user');
    } else if (type === 'group') {
      shareWith = String(b.shareWith ?? '');
      if (!(await one(`SELECT 1 FROM groups WHERE id = $1`, [shareWith]))) throw new HttpError(404, 'No such group');
    } else if (type === 'link') {
      token = newToken(12);
    } else {
      throw new HttpError(400, 'type must be user, group or link');
    }
    if (shareWith && (await one(`SELECT 1 FROM shares WHERE node_id = $1 AND type = $2 AND share_with = $3`, [node.id, type, shareWith]))) {
      throw new HttpError(409, 'Already shared');
    }
    const pw = typeof b.password === 'string' && b.password ? await hashPassword(linkPassword(b.password)) : null;
    const s = await one<Share>(
      `INSERT INTO shares (node_id, owner, type, share_with, can_edit, token, password_hash, expires_at, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [node.id, user.id, type, shareWith, !!b.canEdit && (type !== 'link' || node.is_dir), token,
       // Expiry is a link feature (checked in loadLink); user/group shares never expire, so none is stored for them.
       type === 'link' ? pw : null, type === 'link' ? parseExpiry(b.expiresAt, user.timezone) : null, String(b.label ?? '').slice(0, 100)],
    );
    if (shareWith) await notifyShare(req, user, node.id, type, shareWith);
    json(res, shareJson((await one<Share>(`${SHARE_ROW} WHERE s.id = $1`, [s!.id]))!), 201);
  }));

  r.patch('/api/shares/:id', authed(async ({ req, res, params }, user) => {
    const s = await ownShare(user, params.id);
    const b = await readJson(req);
    if (typeof b.canEdit === 'boolean') await q(`UPDATE shares SET can_edit = $2 WHERE id = $1`, [s.id, b.canEdit]);
    if ('expiresAt' in b && s.type === 'link') await q(`UPDATE shares SET expires_at = $2 WHERE id = $1`, [s.id, parseExpiry(b.expiresAt, user.timezone)]);
    if (typeof b.label === 'string') await q(`UPDATE shares SET label = $2 WHERE id = $1`, [s.id, b.label.trim().slice(0, 100)]);
    if ('password' in b && s.type === 'link') {
      await q(`UPDATE shares SET password_hash = $2 WHERE id = $1`, [s.id, b.password ? await hashPassword(linkPassword(b.password)) : null]);
    }
    json(res, shareJson((await one<Share>(`${SHARE_ROW} WHERE s.id = $1`, [s.id]))!));
  }));

  // Owners delete a share; direct recipients may also leave a user share.
  r.delete('/api/shares/:id', authed(async ({ res, params }, user) => {
    const s = await one<Share>(`SELECT * FROM shares WHERE id = $1`, [numId(params.id)]);
    if (!s || (s.owner !== user.id && !(s.type === 'user' && s.share_with === user.id))) throw new HttpError(404, 'Share not found');
    await q(`DELETE FROM shares WHERE id = $1`, [s.id]);
    noContent(res);
  }));

  r.get('/api/shares/incoming', authed(async ({ res }, user) => {
    const rows = await q<Share & { owner_name: string }>(
      `SELECT s.*, u.display_name AS owner_name FROM shares s JOIN users u ON u.id = s.owner
        WHERE s.owner <> $1 AND ((s.type = 'user' AND s.share_with = $1)
           OR (s.type = 'group' AND s.share_with IN (SELECT group_id FROM group_members WHERE user_id = $1)))
        ORDER BY s.created_at DESC`,
      [user.id],
    );
    const seen = new Map<number, any>();
    for (const s of rows) {
      const node = await F.getNode(s.node_id);
      if (!node || !(await F.access(user.id, node))) continue;
      const item = seen.get(node.id);
      if (item) {
        item.canEdit ||= s.can_edit;
        continue;
      }
      const [nj] = await F.toJson([node], user.id);
      seen.set(node.id, { ...nj, shareId: s.id, shareType: s.type, canEdit: s.can_edit, ownerName: s.owner_name });
    }
    json(res, [...seen.values()]);
  }));

  r.get('/api/shares/outgoing', authed(async ({ res }, user) => {
    const rows = await q<Share>(
      `${SHARE_ROW} JOIN nodes n ON n.id = s.node_id
        WHERE s.owner = $1 AND n.deleted_at IS NULL ORDER BY s.created_at DESC`,
      [user.id],
    );
    const out = [];
    for (const s of rows) {
      const node = (await F.getNode(s.node_id))!;
      const [nj] = await F.toJson([node], user.id);
      out.push({ ...shareJson(s), node: nj });
    }
    json(res, out);
  }));

  // ---------------------------------------------------------------- public links

  const cookieName = (s: Share) => `cloudy_link_${s.id}`;
  const cookieValue = (s: Share) => sign(`${s.id}:${s.password_hash}`);

  async function loadLink(token: string): Promise<Share> {
    const s = await one<Share>(
      `SELECT * FROM shares WHERE token = $1 AND type = 'link' AND (expires_at IS NULL OR expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = shares.owner AND u.disabled)`,
      [token],
    );
    const node = s && (await F.getNode(s.node_id));
    if (!s || !node || (await F.ancestors(node.id)).some((n) => n.deleted_at)) throw new HttpError(404, 'This link does not exist or has expired');
    return s;
  }

  async function authorized(req: IncomingMessage, s: Share): Promise<boolean> {
    return !s.password_hash || parseCookies(req)[cookieName(s)] === (await cookieValue(s));
  }

  /** Loads the link, enforces its password, and scopes `nodeId` to the shared subtree. */
  async function linkNode(req: IncomingMessage, token: string, nodeId: string) {
    const s = await loadLink(token);
    if (!(await authorized(req, s))) throw new HttpError(401, 'Password required');
    const node = await F.getNode(nodeId);
    const chain = node ? await F.ancestors(node.id) : [];
    const idx = chain.findIndex((n) => n.id === s.node_id);
    if (!node || idx < 0 || chain.some((n) => n.deleted_at)) throw new HttpError(404, 'Not found');
    return { s, node, crumbs: chain.slice(0, idx + 1).reverse().map((n) => ({ id: n.id, name: n.name })) };
  }

  const publicNode = (n: F.Node) => ({ id: n.id, name: n.name, isDir: n.is_dir, size: n.size, mime: n.is_dir ? 'inode/directory' : n.mime, mtime: n.mtime, etag: n.etag });

  r.get('/api/public/:token', async ({ req, res, params }) => {
    const s = await loadLink(params.token);
    if (!(await authorized(req, s))) return json(res, { needsPassword: true });
    const node = (await F.getNode(s.node_id))!;
    const owner = await one<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [s.owner]);
    json(res, { needsPassword: false, node: publicNode(node), canEdit: s.can_edit, ownerName: owner?.display_name, expiresAt: s.expires_at, label: s.label,
      thumbnails: thumbnailsAvailable() });
  });

  r.post('/api/public/:token/auth', async ({ req, res, params }) => {
    checkRate(req);
    const s = await loadLink(params.token);
    const { password } = await readJson(req, 64 * 1024);
    // Also per link: guesses spread over many addresses add up (the account-style counter, keyed by the share).
    const guess = attempt(req, `link:${s.id}`);
    if (s.password_hash && !(await verifyPassword(String(password ?? ''), s.password_hash))) throw new HttpError(403, 'Wrong password');
    guess.succeeded();
    setCookie(req, res, cookieName(s), await cookieValue(s), 86400);
    noContent(res);
  });

  r.get('/api/public/:token/nodes/:id', async ({ req, res, params }) => {
    const { s, node, crumbs } = await linkNode(req, params.token, params.id);
    json(res, {
      node: publicNode(node),
      canEdit: s.can_edit,
      breadcrumb: crumbs,
      children: node.is_dir ? (await F.children(node.id)).map(publicNode) : undefined,
    });
  });

  r.get('/api/public/:token/nodes/:id/download', async ({ req, res, params, url }) => {
    const { node } = await linkNode(req, params.token, params.id);
    if (node.is_dir) await sendZip(res, node);
    else sendNodeFile(req, res, node, url.searchParams.has('inline'));
  });

  // Photo grids on shared links.
  r.get('/api/public/:token/nodes/:id/thumb', async ({ req, res, params }) => {
    const { node } = await linkNode(req, params.token, params.id);
    await sendThumbnail(req, res, node);
  });

  r.post('/api/public/:token/nodes/:id/folders', async ({ req, res, params }) => {
    const { s, node } = await linkNode(req, params.token, params.id);
    if (!s.can_edit) throw new HttpError(403, 'Read-only link');
    const dir = await F.createDir(node, checkName((await readJson(req)).name));
    json(res, publicNode(dir), 201);
  });

  r.post('/api/public/:token/uploads', async ({ req, res, params }) => {
    const b = await readJson(req);
    const { s, node } = await linkNode(req, params.token, String(b.parentId));
    if (!s.can_edit) throw new HttpError(403, 'Read-only link');
    json(res, await startUpload(node, b.name, b.size, { shareId: s.id }), 201);
  });
}
