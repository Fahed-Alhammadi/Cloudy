import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rename, rm, copyFile, link, writeFile as fsWriteFile, readdir, stat, lstat, statfs, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from './config.ts';
import { limits } from './limits.ts';
import { pool, q, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HttpError, watchIdle } from './http.ts';
import type { IncomingMessage } from 'node:http';

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
      `Give the folder on the /data line of docker-compose.yml to that user (e.g. "chown -R ${uid}:${gid} <path>" or the ` +
      `NFS export's anonuid/anongid), or set PUID and PGID in .env to the owner of the storage.`,
    );
  }
}

/**
 * Makes `file` a blob. `keep`: the file stays where it is too, so a caller whose transaction fails or whose process
 * dies still has it: a hard link, or a copy where the storage has no links (as in duplicateBlob).
 */
/**
 * Blobs this process has put into blobs/ whose transaction has not ended yet. The sweep (sweepBlobs) never takes
 * them, whatever their dates say: it also judges by the change time, and some network mounts report an old one for
 * a fresh hard link, while a big folder copy holds thousands of new blobs in one long transaction.
 */
const unsettled = new Set<string>();

async function adoptBlob(file: string, keep = false): Promise<string> {
  const id = randomUUID();
  unsettled.add(id);
  await mkdir(path.dirname(blobPath(id)), { recursive: true });
  if (!keep) {
    await rename(file, blobPath(id));
    return id;
  }
  try {
    await link(file, blobPath(id));
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw e;
    await copyFile(file, blobPath(id));
  }
  return id;
}

/**
 * A second blob with the same bytes. Blobs are never changed once written, so a hard link is a full copy at no cost
 * (all of /data is one filesystem); copying the bytes is the fallback where links are not possible. A copy of a big
 * folder used to copy every byte while holding the lock on the user's whole tree, and with ten writes waiting behind it
 * every request of every user waited too.
 */
async function duplicateBlob(blob: string): Promise<string> {
  const id = randomUUID();
  unsettled.add(id);
  await mkdir(path.dirname(blobPath(id)), { recursive: true });
  try {
    await link(blobPath(blob), blobPath(id));
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw e;
    await copyFile(blobPath(blob), blobPath(id));
  }
  return id;
}

/**
 * Removes blobs nothing refers to any more. Never throws: every caller runs it after its transaction ended, and a
 * file that cannot be removed (a permission or network-storage error) is a leftover on disk, not a reason to fail
 * the request, or to undo the save it follows.
 */
export async function dropBlobs(blobs: (string | null)[]): Promise<void> {
  const ids = blobs.filter((b): b is string => !!b);
  if (!ids.length) return;
  // A few at a time: emptying a trash of 200,000 files used to queue them all at once on the four threads that do
  // every file operation of the server, and each download and upload waited behind them.
  let failed = 0;
  let reason: string | undefined;
  for (let i = 0; i < ids.length; i += 16) {
    for (const r of await Promise.allSettled(ids.slice(i, i + 16).map((b) => rm(blobPath(b), { force: true })))) {
      if (r.status === 'fulfilled') continue;
      failed++;
      reason ??= r.reason?.message;
    }
  }
  if (failed) console.error(`${failed} of ${ids.length} unused blob(s) could not be removed:`, reason);
  for (let i = 0; i < ids.length; i += 10_000) {
    await q(`DELETE FROM blob_hashes WHERE blob = ANY($1)`, [ids.slice(i, i + 10_000)]).catch(() => {}); // leftovers go with gcHashes()
  }
}

/**
 * Whether a write failed because the storage is full (the disk, or the file system's own quota for the server's
 * user). The request is answered 507 "Not enough space on the server" (server.ts): it used to be a bare 500, or
 * "Upload interrupted" for a chunk, and nobody could tell why uploads had stopped working.
 */
export function isDiskFull(e: any): boolean {
  return e?.code === 'ENOSPC' || e?.code === 'EDQUOT';
}

export const NO_SPACE = 'Not enough space on the server';
export const OVER_QUOTA = 'Storage quota exceeded';

/** How many bytes may still be stored, and what to say (507) to an upload that is bigger. */
export interface Room { max: number; message: string }

/**
 * Spools a request body to DATA_DIR/tmp; `room` (see storageRoom: the owner's remaining quota and the free space)
 * stops it before the disk fills. Also hashes it on the way (SHA-256, hex), so the stored file needs no second read.
 */
export async function streamToTemp(stream: Readable, room: Room = { max: Infinity, message: OVER_QUOTA }): Promise<{ file: string; size: number; sha256: string }> {
  const file = tmpPath(randomUUID());
  let size = 0;
  const hash = createHash('sha256');
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > room.max) return cb(new HttpError(507, room.message));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  // A request body that stalls is cut off (it used to hold the connection and the temporary file for ever).
  const stop = 'socket' in stream ? watchIdle(stream as IncomingMessage) : () => {};
  try {
    // flush: the bytes are on disk before the database says the file exists (a power cut could leave it empty).
    await pipeline(stream, counter, createWriteStream(file, { flush: true }));
  } catch (e) {
    await rm(file, { force: true });
    throw e;
  } finally {
    stop();
  }
  return { file, size, sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------- content hashes (blob_hashes)
// Uploads usually bring their hash along (computed while streaming). Blobs stored without one (a chunked upload resumed
// after a restart, copies of unhashed files, blobs from before 1.16) are hashed here, one at a time, after the request
// has been answered: queued blobs first, then a backfill of every blob still missing a hash.

const hashQueue: string[] = [];
const queued = new Set<string>();
let hashing = false;
let backfill: { from: string; page: string[] } | null = null;

/** Computes the hash of `blob` in the background (no-op when it is known already). */
export function queueHash(blob: string): void {
  if (queued.has(blob)) return;
  queued.add(blob);
  hashQueue.push(blob);
  void runHashes();
}

/** Starts (or continues) hashing every stored blob that has no hash yet. Called at startup and hourly. */
export function backfillHashes(): void {
  backfill ??= { from: '', page: [] };
  void runHashes();
}

/** Removes hashes whose blob no longer exists (rows a crash or a race with a delete left behind). */
export async function gcHashes(): Promise<void> {
  await q(`DELETE FROM blob_hashes h WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.blob = h.blob)
             AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.blob = h.blob)`);
}

async function nextBlob(): Promise<string | undefined> {
  const b = hashQueue.shift();
  if (b !== undefined) return b;
  if (!backfill) return undefined;
  if (!backfill.page.length) {
    const rows = await q<{ blob: string }>(
      `SELECT blob FROM (
         SELECT blob FROM nodes WHERE blob IS NOT NULL UNION SELECT blob FROM versions
       ) x WHERE blob > $1 AND NOT EXISTS (SELECT 1 FROM blob_hashes h WHERE h.blob = x.blob)
       ORDER BY blob LIMIT 200`,
      [backfill.from],
    );
    if (!rows.length) {
      backfill = null;
      return undefined;
    }
    backfill.page = rows.map((r) => r.blob);
    backfill.from = backfill.page.at(-1)!;
  }
  return backfill.page.shift();
}

async function runHashes(): Promise<void> {
  if (hashing) return;
  hashing = true;
  try {
    for (let blob = await nextBlob(); blob !== undefined; blob = await nextBlob()) {
      try {
        await hashBlob(blob);
      } catch (e: any) {
        if (e?.code !== 'ENOENT') console.error(`hashing blob ${blob} failed:`, e?.message ?? e);
      } finally {
        queued.delete(blob);
      }
    }
  } catch (e: any) {
    backfill = null; // database gone: the next hourly run starts over
    console.error('content hashing stopped:', e?.message ?? e);
  } finally {
    hashing = false;
  }
}

async function hashBlob(blob: string): Promise<void> {
  if (await one(`SELECT 1 FROM blob_hashes WHERE blob = $1`, [blob])) return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(blobPath(blob), { highWaterMark: 1 << 20 })) hash.update(chunk);
  await q(`INSERT INTO blob_hashes (blob, sha256) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [blob, hash.digest('hex')]);
}

const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript', yml: 'text/yaml', yaml: 'text/yaml',
  ini: 'text/plain', conf: 'text/plain', ics: 'text/calendar', vcf: 'text/vcard',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff',
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
  return Object.hasOwn(MIME, ext) ? MIME[ext] : 'application/octet-stream';
}

/**
 * Once, from the first start of 1.19 until it has run through: names stored in another Unicode form are brought to
 * NFC (when the folder already has that name, a free one: "Café (2).txt"), and files get the type their name says (it
 * was fixed when they were created, so a file renamed to ".pdf", or uploaded under a temporary name, had no preview).
 */
export async function repairNamesAndTypes(): Promise<void> {
  // Marked done only once it has run through: every step can simply run again after a crash or a failure.
  if (await one(`SELECT 1 FROM settings WHERE key = 'repair:names-types'`)) return;
  let renamed = 0;
  let complete = true;
  try {
    for (const n of await q<{ id: number; parent_id: number; name: string; deleted: boolean }>(
      `SELECT id, parent_id, name, deleted_at IS NOT NULL AS deleted FROM nodes WHERE parent_id IS NOT NULL AND name <> normalize(name, NFC)`)) {
      // The same name in the other form already in the folder: this one gets a free name, "Café (2).txt" (left as it
      // was, a lookup by name could find the other one).
      let name = n.name.normalize('NFC');
      if (!n.deleted && (await childByName(n.parent_id, name))) name = await uniqueName(n.parent_id, name);
      const done = await tx(async (db) => {
        await lockChain(db, n.parent_id);
        const row = await one(`UPDATE nodes SET name = $2, etag = md5(random()::text) WHERE id = $1 RETURNING id`, [n.id, name], db);
        // The folders above list it under its new name: new etags, so sync clients look again.
        if (row && !n.deleted) await propagate(db, n.parent_id, 0);
        return row;
      }).catch(() => null); // the name was taken meanwhile: the next start tries again
      if (done) renamed++;
      else complete = false;
    }
  } catch (e: any) {
    // A database not in UTF-8 (possible with DATABASE_URL) cannot normalize text: that stays so, the repair is done.
    // Anything else: tried again at the next start.
    console.warn(`names were not converted to one Unicode form: ${e.message}`);
    if (!/encoding/i.test(String(e?.message))) complete = false;
  }
  // In batches, so a server with millions of files does not hold them all in memory.
  let typed = 0;
  for (let after = 0; ;) {
    const batch = await q<{ id: number; name: string; mime: string }>(
      `SELECT id, name, mime FROM nodes WHERE NOT is_dir AND id > $1 ORDER BY id LIMIT 5000`, [after]);
    if (!batch.length) break;
    after = batch[batch.length - 1].id;
    const byType = new Map<string, number[]>();
    for (const f of batch) {
      const m = mimeOf(f.name);
      if (m === f.mime) continue;
      const ids = byType.get(m);
      if (ids) ids.push(f.id);
      else byType.set(m, [f.id]);
    }
    for (const [mime, ids] of byType) {
      await q(`UPDATE nodes SET mime = $1 WHERE id = ANY($2::bigint[])`, [mime, ids]);
      typed += ids.length;
    }
  }
  if (complete) await q(`INSERT INTO settings (key, value) VALUES ('repair:names-types', $1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
  if (renamed || typed) console.log(`repaired ${renamed} name(s) to one Unicode form and the type of ${typed} file(s)`);
}

// ---------------------------------------------------------------- lookup

export async function getNode(id: number | string, db: Db = pool): Promise<Node | undefined> {
  if (!/^\d{1,18}$/.test(String(id))) return undefined;
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
  // Names are stored in NFC (see checkName); a lookup with the same name in another form (typed on a Mac) finds it.
  return one<Node>(
    `SELECT ${COLS} FROM nodes WHERE parent_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [parentId, name.normalize('NFC')],
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

export function pathFromChain(chain: Node[]): string {
  return '/' + chain.slice(0, -1).reverse().map((n) => n.name).join('/');
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
        -- A disabled account's shares stop working, like its public links (loadLink).
        AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = shares.owner AND o.disabled)
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
  // For the rest of this transaction: a write that waits more than half a minute for another one's lock gives up
  // (55P03, answered 503 "busy", which the apps try again). Without a limit, writers queued behind one long
  // transaction on a user's tree each held a database connection until none was left for anyone.
  await q(`SET LOCAL lock_timeout = '30s'`, [], db);
  await lockRows(db, ids);
}

async function lockRows(db: Db, ids: number[]): Promise<void> {
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
  await lockRows(db, [startId]); // (the caller's lockChain already set this transaction's lock timeout)
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

/** Bytes the owner's files take, with the ones in the trash and the older versions. */
export async function usage(owner: string, db: Db = pool): Promise<number> {
  // Both halves read the index nodes_owner_files (the owner's files with id and size, schema.sql) and nothing else of
  // `nodes`: this runs for every upload and every /api/me, and used to read every user's rows each time. Only files
  // have versions, so "NOT is_dir" in the second half changes nothing but lets it use that index too.
  const r = await one<{ used: number }>(
    `SELECT (COALESCE((SELECT sum(size) FROM nodes WHERE owner = $1 AND NOT is_dir), 0)
           + COALESCE((SELECT sum(v.size) FROM versions v
                        WHERE v.node_id IN (SELECT id FROM nodes WHERE owner = $1 AND NOT is_dir)), 0))::bigint AS used`,
    [owner],
    db,
  );
  return r?.used ?? 0;
}

/**
 * Bytes that may still be written to DATA_DIR: what is free there minus the reserve set under Administration →
 * Limits. Infinity when the file system does not say (then nothing is refused on its account).
 */
export async function freeSpace(): Promise<number> {
  try {
    const s = await statfs(config.dataDir);
    // Some network and FUSE storage answers with zeros for everything: that is "unknown", not "full".
    if (!s.blocks) return Infinity;
    const free = s.bavail * s.bsize;
    return Number.isFinite(free) ? Math.max(0, free - limits().diskReserveMb * 1024 * 1024) : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * What an upload or a save for `owner` may take: the smaller of the owner's remaining quota and the free space.
 * Accounts without a quota had no limit at all, so anyone allowed to upload (a visitor of an upload link too) could
 * fill the disk to the last byte.
 */
export async function storageRoom(owner: string): Promise<Room> {
  const [quota, free] = await Promise.all([remainingQuota(owner), freeSpace()]);
  return free < quota ? { max: free, message: NO_SPACE } : { max: quota, message: OVER_QUOTA };
}

/** Bytes the owner may still store (Infinity without a quota); counts uploads in progress as used. */
export async function remainingQuota(owner: string): Promise<number> {
  const u = await one<{ quota_bytes: number | null }>(`SELECT quota_bytes FROM users WHERE id = $1`, [owner]);
  if (u?.quota_bytes == null) return Infinity;
  // Running uploads reserve their full size; one without a chunk for 15 minutes only what it has received (an
  // interrupted 15 GB upload used to block the retry with "quota exceeded" for a whole day).
  const pending = await one<{ n: number }>(
    `SELECT COALESCE(sum(CASE WHEN updated_at > now() - interval '15 minutes' THEN size ELSE received END), 0)::bigint AS n
       FROM uploads WHERE owner = $1`, [owner]);
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

/**
 * Folders inside folders, at most this many levels below the top. Every write walks a folder's ancestors, and file
 * systems and programs give up long before (a Windows path ends at 260 characters unless long paths are turned on).
 */
export const MAX_DEPTH = 250;

/** How many levels below the owner's top folder `id` is (the top folder is 0). */
async function depthOf(db: Db, id: number): Promise<number> {
  const r = await one<{ d: number }>(
    `WITH RECURSIVE a AS (
       SELECT id, parent_id, 0 AS d FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, a.d + 1 FROM nodes n JOIN a ON n.id = a.parent_id)
     SELECT max(d)::int AS d FROM a`,
    [id],
    db,
  );
  return r?.d ?? 0;
}

/** How many levels of folders lie inside folder `id` (0 when it holds no folders). */
async function heightOf(db: Db, id: number): Promise<number> {
  const r = await one<{ h: number }>(
    `WITH RECURSIVE t AS (
       SELECT id, 0 AS h FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, t.h + 1 FROM nodes n JOIN t ON n.parent_id = t.id WHERE n.is_dir AND n.deleted_at IS NULL AND t.h <= $2)
     SELECT max(h)::int AS h FROM t`,
    [id, MAX_DEPTH],
    db,
  );
  return r?.h ?? 0;
}

/** A folder placed in `parentId`, with `inside` levels of folders of its own, must not end up too deep. */
async function assertDepth(db: Db, parentId: number, inside: number): Promise<void> {
  if ((await depthOf(db, parentId)) + 1 + inside > MAX_DEPTH) {
    throw new HttpError(400, 'Folders can be nested at most 250 levels deep');
  }
}

export async function createDir(parent: Node, name: string): Promise<Node> {
  if (!parent.is_dir) throw new HttpError(400, 'Parent is not a folder');
  return tx(async (db) => {
    await lockChain(db, parent.id);
    await assertLive(db, parent.id);
    await assertDepth(db, parent.id, 0);
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
  opts: {
    noOverwrite?: boolean; sha256?: string; expectEtag?: string; expectId?: number;
    /** Leave `file` in place as well (see adoptBlob); the caller removes it once this returns. */
    keepSource?: boolean;
    /** Runs in the same transaction as the file, so what it changes is saved with the file or not at all. */
    claim?: (db: Db) => Promise<void>;
  } = {},
): Promise<{ node: Node; created: boolean }> {
  if (!parent.is_dir) throw new HttpError(400, 'Parent is not a folder');
  const blob = await adoptBlob(file, opts.keepSource);
  let pruned: string[] = [];
  let out: { node: Node; created: boolean };
  try {
    out = await tx(async (db) => {
      await lockChain(db, parent.id); // serializes writes to this folder (same name) without deadlocks
      await assertLive(db, parent.id);
      await opts.claim?.(db);
      let existing = await childByName(parent.id, name, db);
      // Under the lock, so nothing can take the name in between: a public-link visitor's file never replaces one
      // the owner created while the upload was running.
      if (existing && opts.noOverwrite) {
        name = await uniqueName(parent.id, name, db);
        existing = undefined;
      }
      if (existing?.is_dir) throw new HttpError(409, 'A folder with that name exists');
      if (opts.expectId && existing?.id !== opts.expectId) throw new HttpError(412, 'Someone else changed this file since you opened it');
      // Checked again under the lock: a save that started from an older version never overwrites a newer one.
      if (opts.expectEtag && existing && existing.etag !== opts.expectEtag) throw new HttpError(412, 'Someone else changed this file since you opened it');
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
        await saveHash(db, blob, opts.sha256);
        return { node, created: false };
      }
      const node = (await one<Node>(
        `INSERT INTO nodes (owner, parent_id, name, is_dir, size, mime, blob)
         VALUES ($1, $2, $3, false, $4, $5, $6) RETURNING ${COLS}`,
        [parent.owner, parent.id, name, size, mimeOf(name), blob],
        db,
      ))!;
      await propagate(db, parent.id, size);
      await saveHash(db, blob, opts.sha256);
      return { node, created: true };
    });
  } catch (e) {
    await dropBlobs([blob]);
    throw e;
  } finally {
    unsettled.delete(blob);
  }
  // The file is saved from here on. Nothing below may reach the catch above: it removes the new content, and a
  // failed clean-up of old versions used to do exactly that to a file that had just been stored.
  await dropBlobs(pruned);
  if (!opts.sha256) queueHash(blob);
  return out;
}

/** Stores a known hash in the same transaction as the node that uses the blob (so gcHashes never sees it orphaned). */
async function saveHash(db: Db, blob: string, sha256: string | undefined): Promise<void> {
  if (sha256) await q(`INSERT INTO blob_hashes (blob, sha256) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [blob, sha256], db);
}

async function pruneVersions(db: Db, nodeId: number): Promise<string[]> {
  const old = await q<{ id: number; blob: string }>(
    `SELECT id, blob FROM versions WHERE node_id = $1 ORDER BY created_at DESC OFFSET $2`,
    [nodeId, limits().maxVersions],
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
    if (node.is_dir && dest.id !== node.parent_id) await assertDepth(db, dest.id, await heightOf(db, node.id));
    const cur = await current(db, node.id); // parent as it is now (a parallel move may have changed it)
    const size = await sizeOf(db, node.id);
    const moved = (await one<Node>(
      `UPDATE nodes SET parent_id = $2, name = $3, etag = md5(random()::text), mime = CASE WHEN is_dir THEN mime ELSE $4 END
        WHERE id = $1 RETURNING ${COLS}`,
      [node.id, dest.id, newName, mimeOf(newName)],
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
    const out = await tx(async (db) => {
      await lockChain(db, dest.id, node.id);
      await assertLive(db, dest.id, node.id);
      // Again under the lock: a parallel move could have put the destination inside the folder since the check above,
      // and the copy would then copy its own output without end.
      if (node.is_dir && (await ancestors(dest.id, db)).some((n) => n.id === node.id)) {
        throw new HttpError(400, 'Cannot copy a folder into itself');
      }
      if (node.is_dir) await assertDepth(db, dest.id, await heightOf(db, node.id));
      const src = await current(db, node.id); // its content now (blob, size), not the caller's copy
      const size = await sizeOf(db, node.id);
      await checkQuota(db, dest.owner, size);
      // One folder level at a time: a few statements per level instead of several per item, so a big folder is copied
      // quickly while its folders are locked. Each file's copy is a hard link (duplicateBlob).
      const copyLevel = async (items: Node[], parentOf: (n: Node) => number, nameOf: (n: Node) => string): Promise<Node[]> => {
        const blobs: (string | null)[] = [];
        for (const n of items) {
          const blob = n.blob ? await duplicateBlob(n.blob) : null;
          if (blob) created.push(blob);
          blobs.push(blob);
        }
        // Same bytes, same hash (where the source's is known yet; the queue below computes the others).
        const linked = items.flatMap((n, i) => (blobs[i] ? [[n.blob!, blobs[i]!]] : []));
        if (linked.length) {
          await q(
            `INSERT INTO blob_hashes (blob, sha256)
             SELECT c.blob, h.sha256 FROM unnest($1::text[], $2::text[]) AS c(src, blob) JOIN blob_hashes h ON h.blob = c.src
             ON CONFLICT DO NOTHING`,
            [linked.map((p) => p[0]), linked.map((p) => p[1])],
            db,
          );
        }
        return q<Node>(
          `INSERT INTO nodes (owner, parent_id, name, is_dir, size, mime, blob)
           SELECT $1, c.parent_id, c.name, c.is_dir, c.size, c.mime, c.blob
             FROM unnest($2::bigint[], $3::text[], $4::boolean[], $5::bigint[], $6::text[], $7::text[])
               AS c(parent_id, name, is_dir, size, mime, blob)
           RETURNING ${COLS}`,
          [dest.owner, items.map(parentOf), items.map(nameOf), items.map((n) => n.is_dir), items.map((n) => n.size),
            items.map((n) => (n.is_dir ? n.mime : mimeOf(nameOf(n)))), blobs],
          db,
        ).catch(conflict);
      };
      const [copy] = await copyLevel([src], () => dest.id, () => newName);
      // Source folder id → its copy's id, for the level being copied.
      let folders = src.is_dir ? new Map([[src.id, copy.id]]) : new Map<number, number>();
      while (folders.size) {
        const next = new Map<number, number>();
        // A level in pieces of 2,000 items, so a wide tree is never all in memory at once.
        for (let after = 0; ;) {
          const items = await q<Node>(
            `SELECT ${COLS} FROM nodes WHERE parent_id = ANY($1::bigint[]) AND deleted_at IS NULL AND id > $2 ORDER BY id LIMIT 2000`,
            [[...folders.keys()], after],
            db,
          );
          if (!items.length) break;
          after = items[items.length - 1].id;
          const copies = await copyLevel(items, (n) => folders.get(n.parent_id!)!, (n) => n.name);
          // Names are unique per folder, so (new parent, name) finds each copy whatever order the rows come back in.
          const byPlace = new Map(copies.map((c) => [`${c.parent_id}/${c.name}`, c.id]));
          for (const n of items) if (n.is_dir) next.set(n.id, byPlace.get(`${folders.get(n.parent_id!)}/${n.name}`)!);
        }
        folders = next;
      }
      await propagate(db, dest.id, size);
      return copy;
    });
    for (const b of created) queueHash(b); // skipped at once when the hash came along
    return out;
  } catch (e) {
    await dropBlobs(created);
    throw e;
  } finally {
    for (const b of created) unsettled.delete(b);
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
    // The item's contents first; the item itself comes back in one statement with its (possibly new) name and place.
    // Undeleting it under its old name first failed (500) whenever another item had taken that name meanwhile.
    await q(
      `WITH RECURSIVE s AS (
         SELECT id FROM nodes WHERE id = $1
         UNION ALL SELECT n.id FROM nodes n JOIN s ON n.parent_id = s.id
          WHERE n.deleted_at = (SELECT deleted_at FROM nodes WHERE id = $1) AND NOT n.trashed_root)
       UPDATE nodes SET deleted_at = NULL WHERE id IN (SELECT id FROM s) AND id <> $1`,
      [node.id],
      db,
    );
    const restored = (await one<Node>(
      `UPDATE nodes SET deleted_at = NULL, trashed_root = false, trash_path = NULL, parent_id = $2, name = $3
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

const BLOB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Leftover blobs removed per run (their names are held in memory until then); more wait for the next day. */
const SWEEP_MAX = 50_000;

/**
 * Which of these blobs a file or a version refers to. One statement on purpose: restoring a version moves a blob
 * from one table to the other, and a single statement sees it in one of them, whenever it looks.
 */
async function referencedBlobs(blobs: string[]): Promise<Set<string>> {
  const rows = await q<{ blob: string }>(
    `SELECT blob FROM nodes WHERE blob = ANY($1::text[]) UNION ALL SELECT blob FROM versions WHERE blob = ANY($1::text[])`, [blobs]);
  return new Set(rows.map((r) => r.blob));
}

/**
 * Sets aside stored files (DATA_DIR/blobs/xx/<uuid>) that no file and no version refers to: what a crash between
 * storing a file and saving its row leaves behind, and what dropBlobs could not remove. They used to stay for ever.
 * They are moved to DATA_DIR/leftover, not deleted; purgeLeftovers() deletes them 30 days later. Until then they can
 * be put back (into blobs/<first two characters>/): after restoring an older database backup, the files uploaded
 * since that backup are "unknown" too, and whoever then restores the right backup must still find them.
 *
 * Careful by design, since a mistake here takes someone's file away:
 * - never a blob whose save is still in progress in this process (`unsettled`);
 * - only names this server gives blobs (a UUID, in the folder of its first two characters), only regular files;
 * - only when both the change time and the modification time are older than `minAgeMs` (two days). A blob gets its
 *   row seconds after it appears in blobs/, in the transaction that follows; appearing there (a rename, a hard link or
 *   a copy) sets the change time, so a blob waiting for its transaction is never old. The modification time alone
 *   would not do: a hard link keeps the one of the file it was made from (a copy of a year-old file, an upload whose
 *   last chunk arrived yesterday);
 * - asked in the database for each folder's files, and once more for the single blob right before it is removed. A
 *   query that fails ends the run: nothing is ever removed on the strength of an answer that did not come;
 * - nothing at all when more than `maxShare` (half) of the stored files are unknown to the database. That is not what
 *   crashes leave behind: it is the wrong or an emptied database (a lost database volume, a restore still to come),
 *   and removing the files would turn that into losing everything.
 *
 * One folder at a time, so memory stays flat however many files are stored.
 */
export async function sweepBlobs(minAgeMs = 2 * 86400_000, maxShare = 0.5): Promise<{ removed: number; bytes: number }> {
  const root = path.join(config.dataDir, 'blobs');
  const cutoff = Date.now() - minAgeMs;
  const aged = async (blob: string) => {
    const st = await lstat(blobPath(blob)).catch(() => null);
    return st && st.isFile() && st.ctimeMs < cutoff && st.mtimeMs < cutoff ? st : null;
  };
  let stored = 0;
  let unknown = 0;
  const leftovers: string[] = [];
  for (const dir of (await readdir(root).catch(() => [] as string[])).sort()) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    const names = (await readdir(path.join(root, dir)).catch(() => [] as string[])).filter((f) => BLOB_NAME.test(f) && f.startsWith(dir));
    stored += names.length;
    const old: string[] = [];
    for (let i = 0; i < names.length; i += 16) {
      const batch = names.slice(i, i + 16);
      const stats = await Promise.all(batch.map(aged));
      for (const [j, st] of stats.entries()) if (st) old.push(batch[j]);
    }
    for (let i = 0; i < old.length; i += 1000) {
      const batch = old.slice(i, i + 1000);
      const known = await referencedBlobs(batch);
      for (const blob of batch) {
        if (known.has(blob) || unsettled.has(blob)) continue;
        unknown++;
        if (leftovers.length < SWEEP_MAX) leftovers.push(blob);
      }
    }
  }
  if (!unknown) return { removed: 0, bytes: 0 };
  if (unknown > stored * maxShare) {
    console.warn(`${unknown} of ${stored} stored file(s) are unknown to the database: none was removed. A few leftovers are normal; `
      + `this many means the server is running on another database than the one these files belong to.`);
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  const aside = path.join(config.dataDir, 'leftover');
  await mkdir(aside, { recursive: true });
  for (const blob of leftovers) {
    const st = await aged(blob);
    if (!st || unsettled.has(blob) || (await referencedBlobs([blob])).size) continue;
    try {
      await rename(blobPath(blob), path.join(aside, blob)); // all of /data is one filesystem; the move restarts its change time
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.error(`leftover blob ${blob} could not be set aside:`, e?.message);
      continue;
    }
    removed++;
    if (st.nlink <= 1) bytes += st.size; // another name of the same bytes (a copy's hard link) keeps them on disk
  }
  if (removed) {
    console.log(`set aside ${removed} stored file(s) that nothing refers to (${bytes} bytes), in ${aside}. They are deleted after `
      + `${LEFTOVER_DAYS} days; if you restore an older or newer database backup before that, move them back into blobs/ first.`);
  }
  return { removed, bytes };
}

const LEFTOVER_DAYS = 30;

/** Deletes what sweepBlobs set aside more than `maxAgeMs` (30 days) ago; the move into leftover/ started that clock. */
export async function purgeLeftovers(maxAgeMs = LEFTOVER_DAYS * 86400_000): Promise<number> {
  const aside = path.join(config.dataDir, 'leftover');
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const f of await readdir(aside).catch(() => [] as string[])) {
    if (!BLOB_NAME.test(f)) continue;
    const st = await lstat(path.join(aside, f)).catch(() => null);
    if (!st || !st.isFile() || st.ctimeMs >= cutoff) continue;
    if (await unlink(path.join(aside, f)).then(() => true, () => false)) n++;
  }
  return n;
}

/**
 * Hourly job: the sweep above, once a day (it reads the whole blob store). The time of the last run is a file next to
 * the blobs, not a row in the database: a restored database backup would bring back an old time with it, and the
 * sweep would run the moment the server starts on the restored data. For the same reason the first run on a storage
 * is a day after the server first saw it, never at once.
 */
export async function sweepBlobsDaily(): Promise<void> {
  const aside = path.join(config.dataDir, 'leftover');
  const mark = path.join(aside, '.swept');
  await mkdir(aside, { recursive: true });
  const last = await stat(mark).catch(() => null);
  if (!last) return void (await fsWriteFile(mark, ''));
  if (Date.now() - last.mtimeMs < 86400_000) return;
  await fsWriteFile(mark, new Date().toISOString());
  await sweepBlobs();
  const gone = await purgeLeftovers();
  if (gone) console.log(`deleted ${gone} leftover file(s) set aside more than ${LEFTOVER_DAYS} days ago`);
}

export async function listTrash(owner: string): Promise<Node[]> {
  return q<Node>(`SELECT ${COLS} FROM nodes WHERE owner = $1 AND trashed_root ORDER BY deleted_at DESC`, [owner]);
}

export async function expireTrash(): Promise<number> {
  const old = await q<{ id: number }>(
    `SELECT id FROM nodes WHERE trashed_root AND deleted_at < now() - make_interval(days => $1)`,
    [limits().trashDays],
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

let unaccent: Promise<boolean> | null = null;
/** PostgreSQL's unaccent (a trusted extension the database owner may add); without it, search stays accent-exact. */
function unaccentAvailable(): Promise<boolean> {
  return (unaccent ??= q(`CREATE EXTENSION IF NOT EXISTS unaccent`).then(() => true, (e) => {
    console.warn(`search ignores accents only with PostgreSQL's unaccent extension: ${e.message}`);
    return false;
  }));
}

export const SEARCH_LIMIT = 200;

/**
 * Names containing `text`, in the user's own files and in folders shared with them. Accents and case are ignored
 * ("cafe" finds "Café") and the text is compared in the same Unicode form the names are stored in.
 */
export async function searchNodes(user: string, text: string): Promise<Node[]> {
  const pattern = '%' + text.normalize('NFC').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const accentFree = await unaccentAvailable();
  const match = (col: string) => (accentFree ? `unaccent(${col}) ILIKE unaccent($2)` : `${col} ILIKE $2`);
  // Own files and shared ones are searched apart and then put together. One query with "owner = me OR id IN
  // (shared)" made the planner scan everybody's files and re-read the shared tree for every match: minutes on a big
  // server, holding a database connection. The time limit keeps any search from doing that again.
  try {
    return await tx(async (db) => {
      await q(`SET LOCAL statement_timeout = '20s'`, [], db);
      return q<Node>(
        `WITH RECURSIVE shared AS (
           SELECT n.id FROM nodes n JOIN shares s ON s.node_id = n.id
            WHERE n.deleted_at IS NULL AND n.owner <> $1
              -- A disabled account's shares stop working (as in access()): its files are not found either.
              AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = s.owner AND o.disabled)
              AND ((s.type = 'user' AND s.share_with = $1)
                OR (s.type = 'group' AND s.share_with IN (SELECT group_id FROM group_members WHERE user_id = $1)))
           UNION
           SELECT c.id FROM nodes c JOIN shared t ON c.parent_id = t.id WHERE c.deleted_at IS NULL)
         SELECT ${COLS} FROM (
           SELECT ${COLS} FROM nodes WHERE owner = $1 AND deleted_at IS NULL AND parent_id IS NOT NULL AND ${match('name')}
           UNION ALL
           SELECT ${COLS.split(', ').map((c) => 'n.' + c).join(', ')} FROM shared t JOIN nodes n ON n.id = t.id
            WHERE n.deleted_at IS NULL AND ${match('n.name')}
         ) found ORDER BY is_dir DESC, lower(name) LIMIT ${SEARCH_LIMIT}`,
        [user, pattern],
        db,
      );
    });
  } catch (e: any) {
    if (e?.code === '57014') throw new HttpError(503, 'The search took too long. Try a longer part of the name.');
    throw e;
  }
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
  const blobs = nodes.map((n) => n.blob).filter((b): b is string => !!b);
  const hashes = new Map(
    blobs.length
      ? (await q<{ blob: string; sha256: string }>(`SELECT blob, sha256 FROM blob_hashes WHERE blob = ANY($1)`, [blobs]))
        .map((r) => [r.blob, r.sha256])
      : [],
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
    // Files only: hex SHA-256 of the content, null while it is still being computed in the background.
    sha256: n.is_dir ? undefined : (n.blob && hashes.get(n.blob)) || null,
  }));
}
