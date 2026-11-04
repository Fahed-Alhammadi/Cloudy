import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, copyFile, writeFile as fsWriteFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from './config.ts';
import { pool, q, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

export interface Node {
  id: number;
  owner: string;
  parent_id: number | null;
  name: string;
  is_dir: boolean;
  size: number;
  mime: string;
  blob: string | null;
  etag: string;
  mtime: Date;
  deleted_at: Date | null;
  trashed_root: boolean;
  trash_path: string | null;
}

export type Perm = 'owner' | 'edit' | 'read';
export interface Access {
  perm: Perm;
  /** Topmost shared ancestor the user reached this node through (null for owners). */
  shareRoot: number | null;
}

const COLS = 'id, owner, parent_id, name, is_dir, size, mime, blob, etag, mtime, deleted_at, trashed_root, trash_path';

// ---------------------------------------------------------------- blobs

export const blobPath = (blob: string) => path.join(config.dataDir, 'blobs', blob.slice(0, 2), blob);
export const tmpPath = (name: string) => path.join(config.dataDir, 'tmp', name);
export const uploadPath = (id: string) => path.join(config.dataDir, 'uploads', id);

/** Creates the storage layout and fails early, with a useful message, if DATA_DIR is not writable. */
export async function ensureDirs(): Promise<void> {
  const probe = path.join(config.dataDir, 'tmp', `.write-test-${process.pid}`);
  try {
    for (const d of ['blobs', 'tmp', 'uploads']) await mkdir(path.join(config.dataDir, d), { recursive: true });
    await fsWriteFile(probe, 'ok');
    await rm(probe, { force: true });
    // APKs from the old server-side Android publishing (now on GitHub releases).
    await rm(path.join(config.dataDir, 'releases'), { recursive: true, force: true });
  } catch (e: any) {
    const uid = process.getuid?.() ?? '?';
    const gid = process.getgid?.() ?? '?';
    throw new Error(
      `Storage at ${config.dataDir} is not writable by uid:gid ${uid}:${gid} (${e.code ?? e.message}). ` +
      `Give DATA_PATH to that user (e.g. "chown -R ${uid}:${gid} <path>" or the NFS export's anonuid/anongid), ` +
      `or set APP_USER in .env to the owner of the storage.`,
    );
  }
}

async function adoptBlob(file: string): Promise<string> {
  const id = randomUUID();
  await mkdir(path.dirname(blobPath(id)), { recursive: true });
  await rename(file, blobPath(id));
  return id;
}

async function duplicateBlob(blob: string): Promise<string> {
  const id = randomUUID();
  await mkdir(path.dirname(blobPath(id)), { recursive: true });
  await copyFile(blobPath(blob), blobPath(id));
  return id;
}

export async function dropBlobs(blobs: (string | null)[]): Promise<void> {
  await Promise.all(blobs.filter((b): b is string => !!b).map((b) => rm(blobPath(b), { force: true })));
}

/** Streams a request body into a temp file. */
/** Spools a request body to DATA_DIR/tmp; `max` (bytes, e.g. the owner's remaining quota) stops it before the disk fills. */
export async function streamToTemp(stream: Readable, max = Infinity): Promise<{ file: string; size: number }> {
  const file = tmpPath(randomUUID());
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > max ? new HttpError(507, 'Storage quota exceeded') : null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, createWriteStream(file));
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  }
  return { file, size };
}

const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript', yml: 'text/yaml', yaml: 'text/yaml',
  ini: 'text/plain', conf: 'text/plain', ics: 'text/calendar', vcf: 'text/vcard',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', odg: 'application/vnd.oasis.opendocument.graphics',
  rtf: 'application/rtf',
};

export function mimeOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------- lookup

export async function getNode(id: number | string, db: Db = pool): Promise<Node | undefined> {
  if (!/^\d+$/.test(String(id))) return undefined;
  return one<Node>(`SELECT ${COLS} FROM nodes WHERE id = $1`, [id], db);
}

export async function mustNode(id: number | string, db: Db = pool): Promise<Node> {
  const n = await getNode(id, db);
  if (!n) throw new HttpError(404, 'Not found');
  return n;
}

export async function rootOf(owner: string, db: Db = pool): Promise<Node> {
  await q(
    `INSERT INTO nodes (owner, parent_id, name, is_dir) VALUES ($1, NULL, '', true)
     ON CONFLICT (owner) WHERE parent_id IS NULL DO NOTHING`,
    [owner],
    db,
  );
  return (await one<Node>(`SELECT ${COLS} FROM nodes WHERE owner = $1 AND parent_id IS NULL`, [owner], db))!;
}

/** The node and all its ancestors, nearest first. */
export async function ancestors(id: number, db: Db = pool): Promise<Node[]> {
  return q<Node>(
    `WITH RECURSIVE a AS (
       SELECT ${COLS}, 0 AS depth FROM nodes WHERE id = $1
       UNION ALL
       SELECT ${COLS.split(', ').map((c) => 'n.' + c).join(', ')}, a.depth + 1
         FROM nodes n JOIN a ON n.id = a.parent_id)
     SELECT ${COLS} FROM a ORDER BY depth`,
    [id],
    db,
  );
}

export async function childByName(parentId: number, name: string, db: Db = pool): Promise<Node | undefined> {
  return one<Node>(
    `SELECT ${COLS} FROM nodes WHERE parent_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [parentId, name],
    db,
  );
}

export async function children(parentId: number, db: Db = pool): Promise<Node[]> {
  return q<Node>(
    `SELECT ${COLS} FROM nodes WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY is_dir DESC, lower(name)`,
    [parentId],
    db,
  );
}

/** Walks a slash path from the owner's root. */
export async function resolvePath(owner: string, segments: string[]): Promise<Node | undefined> {
  let node: Node | undefined = await rootOf(owner);
  for (const seg of segments) {
    if (!node || !node.is_dir) return undefined;
    node = await childByName(node.id, seg);
  }
  return node;
}

export function pathFromChain(chain: Node[]): string {
  return '/' + chain.slice(0, -1).reverse().map((n) => n.name).join('/');
}

export async function nodePath(id: number): Promise<string> {
  return pathFromChain(await ancestors(id));
}

// ---------------------------------------------------------------- access

/** Effective permission of a user on a live node (owner or via user/group share). */
export async function access(userId: string, node: Node): Promise<Access | null> {
  const chain = await ancestors(node.id);
  if (chain.some((n) => n.deleted_at)) return null;
  if (node.owner === userId) return { perm: 'owner', shareRoot: null };
  const shares = await q<{ node_id: number; can_edit: boolean }>(
    `SELECT node_id, can_edit FROM shares
      WHERE node_id = ANY($1)
        AND ((type = 'user' AND share_with = $2)
          OR (type = 'group' AND share_with IN (SELECT group_id FROM group_members WHERE user_id = $2)))`,
    [chain.map((n) => n.id), userId],
  );
  if (!shares.length) return null;
  const ids = new Set(shares.map((s) => s.node_id));
  let shareRoot = node.id;
  for (const n of chain) if (ids.has(n.id)) shareRoot = n.id;
  return { perm: shares.some((s) => s.can_edit) ? 'edit' : 'read', shareRoot };
}

/** Loads a node and checks the user may read (or edit) it. Hidden nodes are 404. */
export async function requireAccess(
  userId: string,
  id: number | string,
  need: 'read' | 'edit',
): Promise<{ node: Node; acc: Access }> {
  const node = await getNode(id);
  const acc = node && (await access(userId, node));
  if (!node || !acc) throw new HttpError(404, 'Not found');
  if (need === 'edit' && acc.perm === 'read') throw new HttpError(403, 'Read-only');
  return { node, acc };
}

/** For changing or removing a node itself, the user needs edit rights on its parent. */
export async function requireParentEdit(userId: string, node: Node): Promise<Node> {
  if (node.parent_id === null) throw new HttpError(400, 'Cannot modify the root folder');
  const { node: parent } = await requireAccess(userId, node.parent_id, 'edit');
  return parent;
}

export async function breadcrumb(node: Node, acc: Access): Promise<{ id: number; name: string }[]> {
  const chain = (await ancestors(node.id)).reverse();
  const start = acc.shareRoot ? chain.findIndex((n) => n.id === acc.shareRoot) : 0;
  return chain.slice(Math.max(start, 0)).map((n) => ({ id: n.id, name: n.name }));
}

// ---------------------------------------------------------------- mutations

/**
 * Locks `startId` and all its ancestors, always in id order. Concurrent writes in different folders share ancestors
 * (at least the root); taking those row locks in any other order deadlocks (parallel uploads from the desktop client
 * or the browser). Call it before touching any of these rows in a transaction.
 */
async function lockChain(db: Db, ...ids: number[]): Promise<void> {
  // One statement for every chain involved (a move touches two): the rows come back in id order and are locked in
  // that order, and the owner's root (the smallest id of its tree) is always the first one. So every mutation of a
  // tree starts by waiting for its root, and nothing taken afterwards can be held by another writer.
  await q(
    `WITH RECURSIVE a AS (
       SELECT id, parent_id FROM nodes WHERE id = ANY($1::bigint[])
       UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN a ON n.id = a.parent_id)
     SELECT id FROM nodes WHERE id IN (SELECT id FROM a) ORDER BY id FOR UPDATE`,
    [ids],
    db,
  );
}

/**
 * After the lock: the request's access check saw a live folder, but it (or an ancestor) may have been trashed since.
 * Writing into it would leave a live file inside the trash.
 */
async function assertLive(db: Db, ...ids: number[]): Promise<void> {
  const r = await one<{ n: number }>(
    `WITH RECURSIVE a AS (
       SELECT id, parent_id, deleted_at FROM nodes WHERE id = ANY($1::bigint[])
       UNION ALL SELECT n.id, n.parent_id, n.deleted_at FROM nodes n JOIN a ON n.id = a.parent_id)
     SELECT count(*)::int AS n FROM a WHERE deleted_at IS NOT NULL`,
    [ids],
    db,
  );
  if (r!.n) throw new HttpError(404, 'Not found');
}

/**
 * The node as it is now, inside the transaction (after `lockChain`): the caller's copy may predate another writer's
 * change (moved, trashed, restored or overwritten by a parallel request). 404 when it is gone.
 */
async function current(db: Db, id: number): Promise<Node> {
  const n = await getNode(id, db);
  if (!n) throw new HttpError(404, 'Not found');
  return n;
}

/** The node's size as it is now, inside the transaction: the caller's copy may predate another writer's change. */
async function sizeOf(db: Db, id: number): Promise<number> {
  return (await one<{ size: number }>(`SELECT size FROM nodes WHERE id = $1`, [id], db))!.size;
}

/** Adds `delta` to the size of `startId` and all its ancestors and refreshes their etags. */
async function propagate(db: Db, startId: number, delta: number): Promise<void> {
  await lockChain(db, startId);
  await q(
    `WITH RECURSIVE a AS (
       SELECT id, parent_id FROM nodes WHERE id = $1
       UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN a ON n.id = a.parent_id)
     UPDATE nodes SET size = size + $2, etag = md5(random()::text || id),
                      mtime = CASE WHEN id = $1 THEN now() ELSE mtime END
      WHERE id IN (SELECT id FROM a)`,
    [startId, delta],
    db,
  );
}

function conflict(e: any): never {
  if (e?.code === '23505') throw new HttpError(409, 'An item with that name already exists');
  throw e;
}

export async function usage(owner: string, db: Db = pool): Promise<number> {
  const r = await one<{ used: number }>(
    `SELECT (COALESCE((SELECT sum(size) FROM nodes WHERE owner = $1 AND NOT is_dir), 0)
           + COALESCE((SELECT sum(v.size) FROM versions v JOIN nodes n ON n.id = v.node_id WHERE n.owner = $1), 0))::bigint AS used`,
    [owner],
    db,
  );
  return r?.used ?? 0;
}

/** Bytes the owner may still store (Infinity without a quota); counts uploads in progress as used. */
export async function remainingQuota(owner: string): Promise<number> {
  const u = await one<{ quota_bytes: number | null }>(`SELECT quota_bytes FROM users WHERE id = $1`, [owner]);
  if (u?.quota_bytes == null) return Infinity;
  const pending = await one<{ n: number }>(`SELECT COALESCE(sum(size), 0)::bigint AS n FROM uploads WHERE owner = $1`, [owner]);
  return Math.max(0, Number(u.quota_bytes) - (await usage(owner)) - Number(pending?.n ?? 0));
}

async function checkQuota(db: Db, owner: string, extra: number): Promise<void> {
  const u = await one<{ quota_bytes: number | null }>(`SELECT quota_bytes FROM users WHERE id = $1`, [owner], db);
  if (u?.quota_bytes != null && (await usage(owner, db)) + extra > u.quota_bytes) {
    throw new HttpError(507, 'Storage quota exceeded');
  }
}

/** Returns "name (2).ext" style names until free. */
export async function uniqueName(parentId: number, name: string, db: Db = pool): Promise<string> {
  if (!(await childByName(parentId, name, db))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await childByName(parentId, candidate, db))) return candidate;
  }
}

export async function createDir(parent: Node, name: string): Promise<Node> {
  if (!parent.is_dir) throw new HttpError(400, 'Parent is not a folder');
  return tx(async (db) => {
    await lockChain(db, parent.id);
    await assertLive(db, parent.id);
    const n = await one<Node>(
      `INSERT INTO nodes (owner, parent_id, name, is_dir) VALUES ($1, $2, $3, true) RETURNING ${COLS}`,
      [parent.owner, parent.id, name],
      db,
    ).catch(conflict);
    await propagate(db, parent.id, 0);
    return n!;
  });
}

/**
 * Stores a finished temp file as `name` in `parent`. Overwriting an existing
 * file keeps the previous content as a version.
 */
export async function writeFile(
  parent: Node,
  name: string,
  file: string,
  size: number,
  opts: { noOverwrite?: boolean } = {},
): Promise<{ node: Node; created: boolean }> {
  if (!parent.is_dir) throw new HttpError(400, 'Parent is not a folder');
  const blob = await adoptBlob(file);
  let pruned: string[] = [];
  try {
    const out = await tx(async (db) => {
      await lockChain(db, parent.id); // serializes writes to this folder (same name) without deadlocks
      await assertLive(db, parent.id);
      let existing = await childByName(parent.id, name, db);
      // Under the lock, so nothing can take the name in between: a public-link visitor's file never replaces one
      // the owner created while the upload was running.
      if (existing && opts.noOverwrite) {
        name = await uniqueName(parent.id, name, db);
        existing = undefined;
      }
      if (existing?.is_dir) throw new HttpError(409, 'A folder with that name exists');
      await checkQuota(db, parent.owner, size);
      if (existing) {
        await q(`INSERT INTO versions (node_id, blob, size, mtime) VALUES ($1, $2, $3, $4)`,
          [existing.id, existing.blob, existing.size, existing.mtime], db);
        const node = (await one<Node>(
          `UPDATE nodes SET blob = $2, size = $3, etag = md5(random()::text), mtime = now()
            WHERE id = $1 RETURNING ${COLS}`,
          [existing.id, blob, size],
          db,
        ))!;
        await propagate(db, parent.id, size - existing.size);
        pruned = await pruneVersions(db, existing.id);
        return { node, created: false };
      }
      const node = (await one<Node>(
        `INSERT INTO nodes (owner, parent_id, name, is_dir, size, mime, blob)
         VALUES ($1, $2, $3, false, $4, $5, $6) RETURNING ${COLS}`,
        [parent.owner, parent.id, name, size, mimeOf(name), blob],
        db,
      ))!;
      await propagate(db, parent.id, size);
      return { node, created: true };
    });
    await dropBlobs(pruned);
    return out;
  } catch (e) {
    await dropBlobs([blob]);
    throw e;
  }
}

async function pruneVersions(db: Db, nodeId: number): Promise<string[]> {
  const old = await q<{ id: number; blob: string }>(
    `SELECT id, blob FROM versions WHERE node_id = $1 ORDER BY created_at DESC OFFSET $2`,
    [nodeId, config.maxVersions],
    db,
  );
  if (old.length) await q(`DELETE FROM versions WHERE id = ANY($1)`, [old.map((v) => v.id)], db);
  return old.map((v) => v.blob);
}

export async function moveNode(node: Node, dest: Node, newName: string): Promise<Node> {
  if (node.parent_id === null) throw new HttpError(400, 'Cannot move the root folder');
  if (!dest.is_dir) throw new HttpError(400, 'Destination is not a folder');
  if (dest.owner !== node.owner) throw new HttpError(403, "Items can only be moved within the owner's storage; copy instead");
  if ((await ancestors(dest.id)).some((n) => n.id === node.id)) {
    throw new HttpError(400, 'Cannot move a folder into itself');
  }
  return tx(async (db) => {
    await lockChain(db, node.id, dest.id);
    await assertLive(db, node.id, dest.id);
    // Again under the lock: two parallel moves (a into b, b into a) both pass the check above, and the second one
    // would make a cycle that no longer hangs off the root (every recursive query over it then runs for ever).
    if ((await ancestors(dest.id, db)).some((n) => n.id === node.id)) {
      throw new HttpError(400, 'Cannot move a folder into itself');
    }
    const cur = await current(db, node.id); // parent as it is now (a parallel move may have changed it)
    const size = await sizeOf(db, node.id);
    const moved = (await one<Node>(
      `UPDATE nodes SET parent_id = $2, name = $3, etag = md5(random()::text) WHERE id = $1 RETURNING ${COLS}`,
      [node.id, dest.id, newName],
      db,
    ).catch(conflict))!;
    if (dest.id === cur.parent_id) {
      await propagate(db, dest.id, 0);
    } else {
      await propagate(db, cur.parent_id!, -size);
      await propagate(db, dest.id, size);
    }
    return moved;
  });
}

export async function copyNode(node: Node, dest: Node, newName: string): Promise<Node> {
  if (!dest.is_dir) throw new HttpError(400, 'Destination is not a folder');
  if (node.is_dir && (await ancestors(dest.id)).some((n) => n.id === node.id)) {
    throw new HttpError(400, 'Cannot copy a folder into itself');
  }
  const created: string[] = [];
  try {
    return await tx(async (db) => {
      await lockChain(db, dest.id, node.id);
      await assertLive(db, dest.id, node.id);
      const src = await current(db, node.id); // its content now (blob, size), not the caller's copy
      const size = await sizeOf(db, node.id);
      await checkQuota(db, dest.owner, size);
      const copyRec = async (src: Node, parentId: number, name: string): Promise<Node> => {
        const blob = src.blob ? await duplicateBlob(src.blob) : null;
        if (blob) created.push(blob);
        const n = (await one<Node>(
          `INSERT INTO nodes (owner, parent_id, name, is_dir, size, mime, blob)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
          [dest.owner, parentId, name, src.is_dir, src.size, src.mime, blob],
          db,
        ).catch(conflict))!;
        if (src.is_dir) for (const c of await children(src.id, db)) await copyRec(c, n.id, c.name);
        return n;
      };
      const copy = await copyRec(src, dest.id, newName);
      await propagate(db, dest.id, size);
      return copy;
    });
  } catch (e) {
    await dropBlobs(created);
    throw e;
  }
}

export async function trashNode(node: Node): Promise<void> {
  if (node.parent_id === null) throw new HttpError(400, 'Cannot delete the root folder');
  await tx(async (db) => {
    await lockChain(db, node.id);
    // Two parallel deletes of the same item (double click, web + desktop) both pass the access check; the second
    // one would subtract the size from the folder again. A parallel move changes the parent that loses the size.
    await assertLive(db, node.id);
    const cur = await current(db, node.id);
    const size = await sizeOf(db, node.id);
    const where = pathFromChain(await ancestors(node.id, db));
    await q(
      `WITH RECURSIVE s AS (
         SELECT id FROM nodes WHERE id = $1
         UNION ALL SELECT n.id FROM nodes n JOIN s ON n.parent_id = s.id WHERE n.deleted_at IS NULL)
       UPDATE nodes SET deleted_at = now() WHERE id IN (SELECT id FROM s)`,
      [node.id],
      db,
    );
    await q(`UPDATE nodes SET trashed_root = true, trash_path = $2 WHERE id = $1`, [node.id, where], db);
    await propagate(db, cur.parent_id!, -size);
  });
}

export async function restoreNode(node: Node): Promise<Node> {
  if (!node.trashed_root) throw new HttpError(400, 'Not in trash');
  return tx(async (db) => {
    await lockChain(db, node.id);
    // A parallel restore of the same item already did it: doing it again would add its size to the folder twice.
    node = await current(db, node.id);
    if (!node.trashed_root) throw new HttpError(404, 'Not in trash');
    const size = await sizeOf(db, node.id);
    let target = node.parent_id ? await getNode(node.parent_id, db) : undefined;
    if (!target || target.deleted_at) target = await rootOf(node.owner, db);
    const name = await uniqueName(target.id, node.name, db);
    await q(
      `WITH RECURSIVE s AS (
         SELECT id FROM nodes WHERE id = $1
         UNION ALL SELECT n.id FROM nodes n JOIN s ON n.parent_id = s.id
          WHERE n.deleted_at = (SELECT deleted_at FROM nodes WHERE id = $1) AND NOT n.trashed_root)
       UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM s)`,
      [node.id],
      db,
    );
    const restored = (await one<Node>(
      `UPDATE nodes SET trashed_root = false, trash_path = NULL, parent_id = $2, name = $3
        WHERE id = $1 RETURNING ${COLS}`,
      [node.id, target.id, name],
      db,
    ))!;
    await propagate(db, target.id, size);
    return restored;
  });
}

/**
 * Permanently deletes a node, its subtree, versions and blobs: a user's root, or something in the trash. An item that
 * a parallel request restored meanwhile is left alone (deleting it now would also leave its size in the folders).
 */
export async function purgeNode(id: number): Promise<void> {
  const rows = await tx(async (db) => {
    await lockChain(db, id);
    const n = await getNode(id, db);
    if (!n || (n.parent_id !== null && !n.deleted_at)) return [];
    const rows = await q<{ id: string; blob: string | null }>(
      `WITH RECURSIVE s AS (
         SELECT id, blob FROM nodes WHERE id = $1
         UNION ALL SELECT n.id, n.blob FROM nodes n JOIN s ON n.parent_id = s.id)
       SELECT id::text, blob FROM s
       UNION ALL SELECT NULL, v.blob FROM versions v WHERE v.node_id IN (SELECT id FROM s)`,
      [id],
      db,
    );
    await q(`DELETE FROM nodes WHERE id = $1`, [id], db);
    return rows;
  });
  if (!rows.length) return;
  await dropBlobs(rows.map((r) => r.blob));
  // Office previews of the purged files (cache/previews/<id>-<etag>.pdf) go too.
  const ids = new Set(rows.map((r) => r.id).filter(Boolean));
  const previews = path.join(config.dataDir, 'cache', 'previews');
  for (const f of await readdir(previews).catch(() => [] as string[])) {
    if (ids.has(f.split('-')[0])) await rm(path.join(previews, f), { force: true });
  }
}

/**
 * Hourly job: leftovers of interrupted work. tmp/ holds request bodies being spooled and preview conversions (both
 * removed when they end, but not when the process dies); uploads/ files whose session row is gone (a crash between
 * creating the file and its row, or a row deleted with its user). Only entries untouched for a day: anything in use
 * is written to all the time.
 */
export async function cleanStorage(): Promise<void> {
  const cutoff = Date.now() - 86400_000;
  const old = async (dir: string) => {
    const out: string[] = [];
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const st = await stat(path.join(dir, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) out.push(f);
    }
    return out;
  };
  const tmp = path.join(config.dataDir, 'tmp');
  for (const f of await old(tmp)) await rm(path.join(tmp, f), { recursive: true, force: true });
  const files = await old(path.join(config.dataDir, 'uploads'));
  if (!files.length) return;
  const live = new Set((await q<{ id: string }>(`SELECT id FROM uploads WHERE id = ANY($1)`, [files])).map((u) => u.id));
  for (const f of files) if (!live.has(f)) await rm(uploadPath(f), { force: true });
}

export async function listTrash(owner: string): Promise<Node[]> {
  return q<Node>(`SELECT ${COLS} FROM nodes WHERE owner = $1 AND trashed_root ORDER BY deleted_at DESC`, [owner]);
}

export async function expireTrash(): Promise<number> {
  const old = await q<{ id: number }>(
    `SELECT id FROM nodes WHERE trashed_root AND deleted_at < now() - make_interval(days => $1)`,
    [config.trashDays],
  );
  for (const n of old) await purgeNode(n.id);
  return old.length;
}

// ---------------------------------------------------------------- versions

export interface Version { id: number; size: number; mtime: Date; blob: string }

export async function listVersions(nodeId: number): Promise<Version[]> {
  return q<Version>(`SELECT id, size, mtime, blob FROM versions WHERE node_id = $1 ORDER BY created_at DESC`, [nodeId]);
}

export async function restoreVersion(node: Node, versionId: number | string): Promise<Node> {
  return tx(async (db) => {
    await lockChain(db, node.id);
    await assertLive(db, node.id);
    node = (await one<Node>(`SELECT ${COLS} FROM nodes WHERE id = $1`, [node.id], db))!; // current content, not the caller's copy
    const v = await one<Version>(`SELECT id, size, mtime, blob FROM versions WHERE id = $1 AND node_id = $2`,
      [versionId, node.id], db);
    if (!v) throw new HttpError(404, 'Version not found');
    await q(`INSERT INTO versions (node_id, blob, size, mtime) VALUES ($1, $2, $3, $4)`,
      [node.id, node.blob, node.size, node.mtime], db);
    await q(`DELETE FROM versions WHERE id = $1`, [v.id], db);
    const updated = (await one<Node>(
      `UPDATE nodes SET blob = $2, size = $3, mtime = now(), etag = md5(random()::text) WHERE id = $1 RETURNING ${COLS}`,
      [node.id, v.blob, v.size],
      db,
    ))!;
    await propagate(db, node.parent_id!, v.size - node.size);
    return updated;
  });
}

// ---------------------------------------------------------------- views

export async function searchNodes(owner: string, text: string): Promise<Node[]> {
  const pattern = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  return q<Node>(
    `SELECT ${COLS} FROM nodes WHERE owner = $1 AND deleted_at IS NULL AND parent_id IS NOT NULL
        AND name ILIKE $2 ORDER BY is_dir DESC, lower(name) LIMIT 200`,
    [owner, pattern],
  );
}

export async function recentFiles(owner: string): Promise<Node[]> {
  return q<Node>(
    `SELECT ${COLS} FROM nodes WHERE owner = $1 AND deleted_at IS NULL AND NOT is_dir ORDER BY mtime DESC LIMIT 100`,
    [owner],
  );
}

export async function favoriteNodes(userId: string): Promise<Node[]> {
  const rows = await q<Node>(
    `SELECT ${COLS.split(', ').map((c) => 'n.' + c).join(', ')}
       FROM favorites f JOIN nodes n ON n.id = f.node_id
      WHERE f.user_id = $1 AND n.deleted_at IS NULL ORDER BY n.is_dir DESC, lower(n.name)`,
    [userId],
  );
  const out: Node[] = [];
  for (const n of rows) if (await access(userId, n)) out.push(n);
  return out;
}

/** Decorates nodes with per-user flags for the JSON API. */
export async function toJson(nodes: Node[], userId: string) {
  const ids = nodes.map((n) => n.id);
  const favs = new Set(
    (await q<{ node_id: number }>(`SELECT node_id FROM favorites WHERE user_id = $1 AND node_id = ANY($2)`, [userId, ids]))
      .map((r) => r.node_id),
  );
  const shared = new Set(
    (await q<{ node_id: number }>(`SELECT DISTINCT node_id FROM shares WHERE node_id = ANY($1)`, [ids])).map((r) => r.node_id),
  );
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    isDir: n.is_dir,
    size: n.size,
    mime: n.is_dir ? 'inode/directory' : n.mime,
    etag: n.etag,
    mtime: n.mtime,
    owner: n.owner,
    parentId: n.parent_id,
    favorite: favs.has(n.id),
    shared: shared.has(n.id),
  }));
}
