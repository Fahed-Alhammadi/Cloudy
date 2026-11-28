import { createWriteStream } from 'node:fs';
import { writeFile as fsWriteFile, truncate, rm, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, checkName, numId, HttpError, watchIdle } from '../http.ts';
import { config } from '../config.ts';
import { q, one } from '../db.ts';
import type { User } from '../auth.ts';
import { newToken, sha256, bearerUser, sessionUser, getUser } from '../auth.ts';
import * as F from '../files.ts';
import { sendNodeFile, sendBlob, sendZip, sendItemsZip } from '../download.ts';
import { sendThumbnail } from '../thumbs.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

/** Posted ZIP selections (POST /api/zip), fetched once the browser follows the download address. In memory: one process. */
const zipRequests = new Map<string, { user: string; ids: number[]; name: string; expires: number }>();
const ZIP_TTL_MS = 10 * 60_000;
const ZIP_MAX_ITEMS = 10_000;

export function registerFiles(r: Router, authed: Wrap) {
  r.get('/api/nodes/:id', authed(async ({ res, params }, user) => {
    const { node, acc } = await F.requireAccess(user.id, params.id, 'read');
    const [self] = await F.toJson([node], user.id);
    json(res, {
      node: self,
      perm: acc.perm,
      breadcrumb: await F.breadcrumb(node, acc),
      children: node.is_dir ? await F.toJson(await F.children(node.id), user.id) : undefined,
    });
  }));

  r.post('/api/nodes/:id/folders', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    const dir = await F.createDir(node, checkName((await readJson(req)).name));
    json(res, (await F.toJson([dir], user.id))[0], 201);
  }));

  // New (text) file with optional initial content.
  r.post('/api/nodes/:id/files', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    const b = await readJson(req);
    const name = checkName(b.name);
    if (await F.childByName(node.id, name)) throw new HttpError(409, 'An item with that name already exists');
    const file = F.tmpPath(randomUUID());
    const content = Buffer.from(String(b.content ?? ''), 'utf8');
    await fsWriteFile(file, content, { flush: true });
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { node: created } = await F.writeFile(node, name, file, content.length, { sha256 });
    json(res, (await F.toJson([created], user.id))[0], 201);
  }));

  // Replace a file's content (text editor save).
  r.put('/api/nodes/:id/content', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    if (node.is_dir) throw new HttpError(400, 'Not a file');
    // If-Match: the version the editor opened. Someone else saved meanwhile: 412, and the editor asks what to do
    // (the newer text used to be overwritten silently). Clients that do not send it (the apps) save as before.
    const ifMatch = req.headers['if-match'];
    if (ifMatch && ifMatch !== '*' && String(ifMatch).replace(/^W\//, '') !== `"${node.etag}"`) {
      throw new HttpError(412, 'Someone else changed this file since you opened it');
    }
    const parent = await F.mustNode(node.parent_id!);
    const { file, size, sha256 } = await F.streamToTemp(req, await F.remainingQuota(node.owner));
    const expectEtag = ifMatch && ifMatch !== '*' ? node.etag : undefined;
    // With If-Match the save is for this very file: renamed, moved or deleted meanwhile is a change too (412), not a
    // reason to create a new file under the old name.
    const { node: saved } = await F.writeFile(parent, node.name, file, size, { sha256, expectEtag, expectId: expectEtag ? node.id : undefined });
    json(res, (await F.toJson([saved], user.id))[0]);
  }));

  // Rename and/or move.
  r.patch('/api/nodes/:id', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    await F.requireParentEdit(user.id, node);
    const b = await readJson(req);
    const dest = b.parentId != null
      ? (await F.requireAccess(user.id, b.parentId, 'edit')).node
      : await F.mustNode(node.parent_id!);
    const name = b.name != null ? checkName(b.name) : node.name;
    const moved = await F.moveNode(node, dest, name);
    json(res, (await F.toJson([moved], user.id))[0]);
  }));

  r.post('/api/nodes/:id/copy', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    const b = await readJson(req);
    const { node: dest } = await F.requireAccess(user.id, b.parentId, 'edit');
    const name = b.name != null ? checkName(b.name) : await F.uniqueName(dest.id, node.name);
    const copy = await F.copyNode(node, dest, name);
    json(res, (await F.toJson([copy], user.id))[0], 201);
  }));

  r.delete('/api/nodes/:id', authed(async ({ res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    await F.requireParentEdit(user.id, node);
    await F.trashNode(node);
    noContent(res);
  }));

  r.get('/api/nodes/:id/download', authed(async ({ req, res, params, url }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    if (node.is_dir) await sendZip(res, node);
    else sendNodeFile(req, res, node, url.searchParams.has('inline'));
  }));

  // A small WebP preview of a photo, picture or PDF (grid view); 404 when the file has none.
  r.get('/api/nodes/:id/thumb', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    await sendThumbnail(req, res, node);
  }));

  // Several items as one ZIP. A browser saves only what it navigates to (a GET), and the ids of a large selection
  // don't fit in a URL: the list is posted first and answered with a short-lived download address.
  r.post('/api/zip', authed(async ({ req, res }, user) => {
    const { ids } = await readJson(req);
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Nothing to download');
    if (ids.length > ZIP_MAX_ITEMS) throw new HttpError(400, 'Too many items for one download. Download their folder instead.');
    const nodes: F.Node[] = [];
    for (const id of new Set(ids.map(String))) nodes.push((await F.requireAccess(user.id, id, 'read')).node);
    // Named after the folder they come from, if they all share one the user can see (never a hidden folder's name).
    let name = 'files';
    const parentIds = new Set(nodes.map((n) => n.parent_id));
    if (parentIds.size === 1) {
      const parent = await F.getNode(nodes[0].parent_id ?? '');
      if (parent?.name && (await F.access(user.id, parent))) name = parent.name;
    }
    const now = Date.now();
    for (const [k, z] of zipRequests) if (z.expires < now) zipRequests.delete(k);
    // At most 20 waiting per user (one user could otherwise push everyone else's out), 1000 in all; oldest first.
    const mine = [...zipRequests].filter(([, z]) => z.user === user.id);
    if (mine.length >= 20) zipRequests.delete(mine[0][0]);
    if (zipRequests.size >= 1000) zipRequests.delete(zipRequests.keys().next().value!);
    const key = newToken(18);
    zipRequests.set(key, { user: user.id, ids: nodes.map((n) => n.id), name, expires: now + ZIP_TTL_MS });
    json(res, { url: `/api/zip/${key}` }, 201);
  }));

  r.get('/api/zip/:key', authed(async ({ res, params }, user) => {
    const z = zipRequests.get(params.key);
    if (!z || z.user !== user.id || z.expires < Date.now()) throw new HttpError(404, 'Not found');
    // Checked again: an item may have been deleted or unshared since the list was posted.
    await sendItemsZip(res, z.name, async () => {
      const nodes: F.Node[] = [];
      for (const id of z.ids) {
        const node = await F.getNode(id);
        if (node && (await F.access(user.id, node))) nodes.push(node);
      }
      return nodes;
    });
  }));

  r.post('/api/nodes/:id/favorite', authed(async ({ res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    await q(`INSERT INTO favorites (user_id, node_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user.id, node.id]);
    noContent(res);
  }));

  r.delete('/api/nodes/:id/favorite', authed(async ({ res, params }, user) => {
    await q(`DELETE FROM favorites WHERE user_id = $1 AND node_id = $2`, [user.id, numId(params.id)]);
    noContent(res);
  }));

  // ---------------------------------------------------------------- versions
  // Older versions need edit rights: a read-only share shows the file as it is now, not what the owner replaced
  // before sharing it.
  r.get('/api/nodes/:id/versions', authed(async ({ res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    json(res, (await F.listVersions(node.id)).map((v) => ({ id: v.id, size: v.size, mtime: v.mtime })));
  }));

  r.post('/api/nodes/:id/versions/:vid/restore', authed(async ({ res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    json(res, (await F.toJson([await F.restoreVersion(node, numId(params.vid))], user.id))[0]);
  }));

  r.get('/api/nodes/:id/versions/:vid/download', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'edit');
    const v = (await F.listVersions(node.id)).find((x) => String(x.id) === params.vid);
    if (!v) throw new HttpError(404, 'Version not found');
    sendBlob(req, res, v.blob, { size: v.size, mime: node.mime, etag: sha256(v.blob).slice(0, 32), mtime: v.mtime, name: node.name });
  }));

  // ---------------------------------------------------------------- views
  r.get('/api/search', authed(async ({ res, url }, user) => {
    const text = (url.searchParams.get('q') ?? '').replace(/\0/g, '').trim().slice(0, 255);
    if (!text) return json(res, []);
    const nodes = await F.searchNodes(user.id, text);
    const out = await F.toJson(nodes, user.id);
    // The location as the user sees it: from their own top folder, or from the shared folder, never the owner's
    // folders above it. An item shared on its own is at "/" of what was shared, and its folder is not theirs to open.
    for (const [i, item] of out.entries()) {
      const node = nodes[i];
      const own = node.owner === user.id;
      const acc = own ? { perm: 'edit' as const, shareRoot: null } : await F.access(user.id, node);
      const chain = acc ? await F.breadcrumb(node, acc) : [];
      (item as any).path = acc ? '/' + chain.slice(own ? 1 : 0, -1).map((c) => c.name).join('/') : '';
      (item as any).parentVisible = own || (!!acc && acc.shareRoot !== node.id);
    }
    res.setHeader('X-Cloudy-Limit', String(F.SEARCH_LIMIT));
    json(res, out);
  }));

  r.get('/api/recent', authed(async ({ res }, user) => json(res, await F.toJson(await F.recentFiles(user.id), user.id))));
  r.get('/api/favorites', authed(async ({ res }, user) => json(res, await F.toJson(await F.favoriteNodes(user.id), user.id))));

  // ---------------------------------------------------------------- trash
  r.get('/api/trash', authed(async ({ res }, user) => {
    json(res, (await F.listTrash(user.id)).map((n) => ({
      id: n.id, name: n.name, isDir: n.is_dir, size: n.size, mime: n.mime,
      deletedAt: n.deleted_at, originalPath: n.trash_path,
    })));
  }));

  const ownTrashed = async (user: User, id: string) => {
    const n = await F.getNode(id);
    if (!n || n.owner !== user.id || !n.trashed_root) throw new HttpError(404, 'Not in trash');
    return n;
  };

  r.post('/api/trash/:id/restore', authed(async ({ res, params }, user) => {
    const restored = await F.restoreNode(await ownTrashed(user, params.id));
    json(res, (await F.toJson([restored], user.id))[0]);
  }));

  r.delete('/api/trash/:id', authed(async ({ res, params }, user) => {
    await F.purgeNode((await ownTrashed(user, params.id)).id);
    noContent(res);
  }));

  r.delete('/api/trash', authed(async ({ res }, user) => {
    for (const n of await F.listTrash(user.id)) await F.purgeNode(n.id);
    noContent(res);
  }));

  // ---------------------------------------------------------------- chunked uploads
  r.post('/api/uploads', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    const { node: parent } = await F.requireAccess(user.id, b.parentId, 'edit');
    // onConflict "rename": a file with that name stays, the upload is stored as "name (2)" ("Keep both").
    json(res, await startUpload(parent, b.name, b.size, { userId: user.id }, b.onConflict === 'rename'), 201);
  }));
}

/** Who started an upload: a signed-in user, or a public link (its share id). Checked again when the file lands. */
export type UploadBy = { userId: string } | { shareId: number };

export async function startUpload(parent: F.Node, rawName: unknown, rawSize: unknown, by: UploadBy, keepBoth = false) {
  if (!parent.is_dir) throw new HttpError(400, 'Parent is not a folder');
  let name = checkName(rawName);
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Invalid size');
  if (size > (await F.remainingQuota(parent.owner))) throw new HttpError(507, 'Storage quota exceeded');
  const existing = await F.childByName(parent.id, name);
  // Visitors of an "allow upload" link add files; they never replace (and version away) the owner's files.
  const noOverwrite = keepBoth || 'shareId' in by;
  // A folder of that name: with "Keep both" (and on links) the file gets a free name instead of being refused.
  if (existing?.is_dir && !noOverwrite) throw new HttpError(409, 'A folder with that name exists');
  if (existing && noOverwrite) name = await F.uniqueName(parent.id, name);
  const id = newToken(24);
  await fsWriteFile(F.uploadPath(id), '');
  await q(`INSERT INTO uploads (id, owner, parent_id, name, size, user_id, share_id, no_overwrite) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, parent.owner, parent.id, name, size, 'userId' in by ? by.userId : null, 'shareId' in by ? by.shareId : null, noOverwrite]);
  return { id, chunkSize: config.chunkSize, received: 0, size, name };
}

// newToken(24) → 32 base64url characters. Anything else never names an upload (and never reaches the file system).
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const uploadId = (s: string) => {
  if (!UPLOAD_ID_RE.test(s)) throw new HttpError(404, 'Upload not found');
  return s;
};

/** The access that started the upload must still exist when the file lands (revoked share, expired link…). */
async function stillAllowed(u: { parent_id: number; user_id: string | null; share_id: number | null }, parent: F.Node): Promise<boolean> {
  if (u.user_id) {
    // A disabled account stores nothing more, also not into folders shared with it or its own.
    const who = await getUser(u.user_id);
    if (!who || who.disabled) return false;
    const a = await F.access(u.user_id, parent);
    return !!a && a.perm !== 'read';
  }
  if (u.share_id) {
    const s = await one<{ node_id: number }>(
      `SELECT node_id FROM shares WHERE id = $1 AND type = 'link' AND can_edit AND (expires_at IS NULL OR expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = shares.owner AND o.disabled)`, [u.share_id]);
    return !!s && (await F.ancestors(parent.id)).some((n) => n.id === s.node_id);
  }
  return true; // rows from before this column existed
}

/**
 * Running SHA-256 of each chunked upload, as of `at` bytes (= its saved `received`). Kept in memory only: after a
 * restart (or with several processes) the hash is unknown, and the finished file is hashed in the background instead.
 */
const uploadHashes = new Map<string, { at: number; hash: Hash }>();

/**
 * A signed-in user's upload belongs to that user: every request for it (status, chunks, cancel) must be signed in as
 * them. The id alone used to be enough, so an upload started on a device kept working after that device was signed
 * out: after a password change, "Sign out" under Devices, or the account being disabled, whoever held the device
 * could still finish it and replace a file. Uploads through a public link have no account; their 192-bit random id,
 * issued after the link's own checks, is their only key.
 */
async function ownUpload(req: IncomingMessage, u: { user_id: string | null }): Promise<void> {
  if (!u.user_id) return;
  const user = (await bearerUser(req)) ?? (await sessionUser(req));
  if (!user) throw new HttpError(401, 'Not logged in');
  if (user.id !== u.user_id) throw new HttpError(404, 'Upload not found');
}

type Upload = { id: string; parent_id: number; name: string; size: number; received: number; user_id: string | null; share_id: number | null; no_overwrite: boolean };
const UPLOAD_COLS = 'id, parent_id, name, size, received, user_id, share_id, no_overwrite';

/** Uploads with a chunk being written or the finished file being stored: one at a time each (in memory: one process). */
const busy = new Set<string>();

/**
 * Stores a completely received upload as its file. The session row goes in the same transaction as the file, so
 * "the session is gone" always means "the file is stored" (the apps rely on that when the last answer is lost).
 * The row used to be deleted first: a stop or crash before the file was saved lost it, and the apps counted it as
 * uploaded. Now such an upload is still there afterwards and is stored by finishStrandedUploads() or the next request.
 * A refusal (folder gone, access revoked, quota, a folder of that name) ends the session; any other failure keeps it.
 */
async function finishUpload(u: Upload): Promise<F.Node> {
  if (busy.has(u.id)) throw new HttpError(409, 'Chunk already in progress');
  busy.add(u.id);
  const file = F.uploadPath(u.id);
  const refuse = async (e: HttpError): Promise<never> => {
    await q(`DELETE FROM uploads WHERE id = $1`, [u.id]);
    await rm(file, { force: true }).catch(() => {});
    uploadHashes.delete(u.id);
    throw e;
  };
  try {
    const parent = await F.getNode(u.parent_id);
    if (!parent || parent.deleted_at) return await refuse(new HttpError(409, 'Target folder no longer exists'));
    if (!(await stillAllowed(u, parent))) return await refuse(new HttpError(403, 'No longer allowed to upload here'));
    const done = uploadHashes.get(u.id);
    const sha256 = done?.at === u.size ? done.hash.copy().digest('hex') : undefined;
    let taken = false; // someone else finished or cancelled it first: nothing of it is ours to remove
    try {
      const { node } = await F.writeFile(parent, u.name, file, u.size, {
        noOverwrite: !!u.share_id || u.no_overwrite,
        sha256,
        keepSource: true,
        // Claim it: of two requests finishing the same upload, or one finishing and one cancelling, only one wins.
        claim: async (db) => {
          if (await one(`DELETE FROM uploads WHERE id = $1 RETURNING id`, [u.id], db)) return;
          taken = true;
          throw new HttpError(404, 'Upload not found');
        },
      });
      uploadHashes.delete(u.id);
      await rm(file, { force: true }).catch(() => {});
      return node;
    } catch (e: any) {
      if (taken) throw e;
      // Its file is gone (only that: a database that cannot be reached also reports ENOENT, for its socket).
      if (e?.code === 'ENOENT' && e.path === file) return await refuse(new HttpError(404, 'Upload not found'));
      if (e instanceof HttpError) return await refuse(e); // refused for good: quota, a folder of that name, folder gone…
      throw e;
    }
  } finally {
    busy.delete(u.id);
  }
}

/** Whether every byte of `u` is on disk and nothing is working on it: it only needs to be stored. */
async function stranded(u: Upload): Promise<boolean> {
  return u.received >= u.size && !busy.has(u.id) && (await stat(F.uploadPath(u.id)).catch(() => null))?.size === u.size;
}

/**
 * At start and hourly: uploads that were received completely but never stored (the server stopped, or the database
 * failed, between the last chunk and saving the file). A sender that asks again finishes it itself with an empty
 * chunk; this is for the ones that took the lost answer as "done" or gave up. Empty files only after a minute: they
 * are "complete" from the moment their upload starts, and their sender is about to finish them.
 */
export async function finishStrandedUploads(): Promise<void> {
  const rows = await q<Upload>(
    `SELECT ${UPLOAD_COLS} FROM uploads WHERE received >= size AND (size > 0 OR updated_at < now() - interval '1 minute')`);
  for (const u of rows) {
    if (!(await stranded(u))) continue;
    // Its sender has moved on: a file of that name was saved after the last chunk (the app gave up on this upload
    // and sent the file again, perhaps edited since). Storing these older bytes now would replace the newer file.
    // "Keep both" and link uploads never replace anything, so they are stored under a free name as usual.
    if (!u.no_overwrite && !u.share_id && await one(
      `SELECT 1 FROM uploads u JOIN nodes n ON n.parent_id = u.parent_id AND n.name = u.name AND n.deleted_at IS NULL
        WHERE u.id = $1 AND n.mtime > u.updated_at`, [u.id])) {
      if (await one(`DELETE FROM uploads WHERE id = $1 RETURNING id`, [u.id])) await rm(F.uploadPath(u.id), { force: true }).catch(() => {});
      uploadHashes.delete(u.id);
      console.log(`dropped an unfinished upload: a newer "${u.name}" was saved after it`);
      continue;
    }
    try {
      const node = await finishUpload(u);
      console.log(`stored an upload that was left unfinished: node ${node.id}`);
    } catch (e: any) {
      console.error(`unfinished upload ${u.id.slice(0, 6)}… could not be stored: ${e?.message}`);
    }
  }
}

export function registerUploadChunks(r: Router) {
  r.get('/api/uploads/:id', async ({ req, res, params }) => {
    const u = await one<{ received: number; size: number; user_id: string | null }>(
      `SELECT received, size, user_id FROM uploads WHERE id = $1`, [uploadId(params.id)]);
    if (!u) throw new HttpError(404, 'Upload not found');
    await ownUpload(req, u);
    json(res, { received: u.received, size: u.size });
  });

  r.put('/api/uploads/:id', async ({ req, res, params }) => {
    const u = await one<Upload>(`SELECT ${UPLOAD_COLS} FROM uploads WHERE id = $1`, [uploadId(params.id)]);
    if (!u) throw new HttpError(404, 'Upload not found');
    await ownUpload(req, u);
    const file = F.uploadPath(u.id);
    // After a power cut the part file can be shorter than what was confirmed (writes not yet on disk). Continuing at
    // `received` would fill the gap with zeros; instead the client is told the real offset and sends the rest again.
    // (Before the busy check: between that check and busy.add there must be no await, or two parallel chunks both pass.)
    const onDisk = (await stat(file).catch(() => null))?.size;
    if (onDisk !== undefined && onDisk < u.received && !busy.has(u.id)) {
      await q(`UPDATE uploads SET received = $2 WHERE id = $1`, [u.id, onDisk]);
      uploadHashes.delete(u.id);
      return json(res, { error: 'Offset mismatch', received: onDisk }, 409);
    }
    if (busy.has(u.id)) throw new HttpError(409, 'Chunk already in progress');
    const offset = Number(req.headers['upload-offset'] ?? u.received);
    if (offset !== u.received) return json(res, { error: 'Offset mismatch', received: u.received }, 409);

    busy.add(u.id);
    // A chunk whose sender vanished (a phone that left the Wi-Fi sends no goodbye) is cut off after a minute without
    // data; it used to keep the session "in progress" until a restart, so every retry got 409.
    const stopWatch = watchIdle(req);
    let received = u.received;
    // Continue from the hash of the bytes saved so far; a copy, so a failed chunk leaves the saved state untouched.
    const prev = uploadHashes.get(u.id);
    const hash = prev?.at === u.received ? prev.hash.copy() : u.received === 0 ? createHash('sha256') : null;
    try {
      const limit = new Transform({
        transform(chunk, _e, cb) {
          received += chunk.length;
          if (received > u.size) return cb(new HttpError(400, 'More data than declared'));
          hash?.update(chunk);
          cb(null, chunk);
        },
      });
      // Bytes past `received` (a chunk cut off by a crash or restart) go first. 'r+', not 'a': the file must already
      // exist, so a cancelled upload is not recreated holding only this chunk.
      await truncate(file, u.received).catch((e) => {
        throw e?.code === 'ENOENT' ? new HttpError(404, 'Upload not found') : e;
      });
      await pipeline(req, limit, createWriteStream(file, { flags: 'r+', start: u.received, flush: true }));
      // Still ours? DELETE /api/uploads/:id (cancel) may have run while the chunk streamed in.
      const row = await one(`UPDATE uploads SET received = $2, updated_at = now() WHERE id = $1 RETURNING id`, [u.id, received]);
      if (!row) throw new HttpError(404, 'Upload not found');
      if (hash) uploadHashes.set(u.id, { at: received, hash });
      else uploadHashes.delete(u.id);
    } catch (e) {
      await truncate(file, u.received).catch(() => {});
      throw e instanceof HttpError ? e : new HttpError(400, 'Upload interrupted');
    } finally {
      stopWatch();
      // Only after `received` is saved: a retried chunk arriving in between would read the old offset and be appended twice.
      busy.delete(u.id);
    }

    if (received < u.size) return json(res, { received, done: false });
    const node = await finishUpload({ ...u, received });
    // A signed-in uploader gets the node exactly as GET /api/nodes/:id lists it (etag, mtime, sha256…), so it needs no
    // extra request; a public-link visitor only what it had before (no owner name, favorites…).
    const full = u.user_id ? (await F.toJson([node], u.user_id))[0] : { id: node.id, name: node.name, size: node.size };
    json(res, { received, done: true, node: full });
  });

  r.delete('/api/uploads/:id', async ({ req, res, params }) => {
    const id = uploadId(params.id);
    const u = await one<{ user_id: string | null }>(`SELECT user_id FROM uploads WHERE id = $1`, [id]);
    if (u) await ownUpload(req, u);
    const row = await one(`DELETE FROM uploads WHERE id = $1 RETURNING id`, [id]);
    if (row) await rm(F.uploadPath(id), { force: true });
    uploadHashes.delete(id);
    noContent(res);
  });
}

export async function expireUploads(): Promise<void> {
  // Keyed on the last chunk, not the start: a big upload resumed over days keeps its session while it makes progress.
  const old = await q<{ id: string }>(`DELETE FROM uploads WHERE updated_at < now() - interval '1 day' RETURNING id`);
  await Promise.all(old.map((u) => rm(F.uploadPath(u.id), { force: true })));
  // Running hashes of uploads that are gone (expired, cancelled elsewhere, deleted with their user).
  const ids = [...uploadHashes.keys()];
  if (!ids.length) return;
  const live = new Set((await q<{ id: string }>(`SELECT id FROM uploads WHERE id = ANY($1)`, [ids])).map((r) => r.id));
  for (const id of ids) if (!live.has(id)) uploadHashes.delete(id);
}
