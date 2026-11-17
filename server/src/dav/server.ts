import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basicUser } from '../auth.ts';
import type { User } from '../auth.ts';
import { readText, checkName, HttpError } from '../http.ts';
import * as F from '../files.ts';
import { sendNodeFile } from '../download.ts';
import {
  NS, parseXml, child, descendant, key, elKey, esc, href, propRequest, Multistatus, sendXml, davError,
  encodePath, httpDate,
} from './xml.ts';
import type { Props, XEl } from './xml.ts';

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, REPORT';
const DAV_HEADER = '1, 2, 3';

const d = (n: string) => key(NS.d, n);

/**
 * If-Match / If-None-Match (RFC 9110 §13.1.1-2) for writes: a client that saw an older version, or expects that no
 * file exists yet, gets 412 instead of overwriting or deleting (they were ignored).
 */
function checkPreconditions(req: IncomingMessage, node: F.Node | undefined): void {
  const tags = (h: string | string[] | undefined) => String(h).split(',').map((s) => s.trim().replace(/^W\//, '')).filter(Boolean);
  const etag = node ? `"${node.etag}"` : null;
  if (req.headers['if-match'] !== undefined) {
    const want = tags(req.headers['if-match']);
    if (!node || !(want.includes('*') || want.includes(etag!))) throw new HttpError(412, 'Precondition failed');
  }
  if (req.headers['if-none-match'] !== undefined && node) {
    const unwanted = tags(req.headers['if-none-match']);
    if (unwanted.includes('*') || unwanted.includes(etag!)) throw new HttpError(412, 'Precondition failed');
  }
}

function depth(req: IncomingMessage, dflt: 0 | 1 = 1): 0 | 1 {
  const h = String(req.headers.depth ?? '').toLowerCase();
  if (h === '0') return 0;
  if (h === '1' || h === 'infinity') return 1;
  return dflt;
}

/** Handles everything under /dav and returns true, or false for other paths. */
export async function handleDav(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/dav' && !path.startsWith('/dav/')) return false;

  res.setHeader('DAV', DAV_HEADER);
  res.setHeader('MS-Author-Via', 'DAV');
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { Allow: ALLOW, 'Content-Length': 0 });
    res.end();
    return true;
  }
  const user = await basicUser(req);
  if (!user) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cloudy", charset="UTF-8"', 'Content-Length': 0 });
    res.end();
    return true;
  }

  let segs: string[];
  try {
    segs = path.split('/').filter(Boolean).slice(1).map((s) => decodeURIComponent(s));
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  const [area, owner, ...rest] = segs;
  if (owner !== undefined && owner !== user.id) throw new HttpError(403, 'Forbidden');

  if (area === 'files' && owner) await files(req, res, user, rest);
  else await discovery(req, res, user, area, owner);
  return true;
}

// ---------------------------------------------------------------- discovery

function principalProps(user: User): Props {
  const p = `/dav/principals/${encodeURIComponent(user.id)}/`;
  return new Map<string, () => string>([
    [d('resourcetype'), () => '<d:principal/>'],
    [d('displayname'), () => esc(user.display_name || user.id)],
    [d('current-user-principal'), () => href(p)],
    [d('principal-URL'), () => href(p)],
    [d('principal-collection-set'), () => href('/dav/principals/')],
    [d('current-user-privilege-set'), () => '<d:privilege><d:read/></d:privilege>'],
  ]);
}

function plainCollection(user: User, name: string): Props {
  return new Map<string, () => string>([
    [d('resourcetype'), () => '<d:collection/>'],
    [d('displayname'), () => esc(name)],
    [d('current-user-principal'), () => href(`/dav/principals/${encodeURIComponent(user.id)}/`)],
    [d('current-user-privilege-set'), () => '<d:privilege><d:read/></d:privilege>'],
  ]);
}

async function discovery(req: IncomingMessage, res: ServerResponse, user: User, area?: string, owner?: string) {
  if (req.method !== 'PROPFIND' && req.method !== 'REPORT') throw new HttpError(405, 'Method not allowed');
  const body = parseXml(await readText(req));
  const pr = propRequest(body);
  const ms = new Multistatus();
  if (req.method === 'REPORT') return ms.send(res);
  const uid = encodeURIComponent(user.id);
  if (!area) {
    await ms.add('/dav/', plainCollection(user, 'Cloudy'), pr);
    if (depth(req) === 1) {
      for (const a of ['files', 'principals']) {
        await ms.add(`/dav/${a}/${uid}/`, a === 'principals' ? principalProps(user) : plainCollection(user, a), pr);
      }
    }
  } else if (area === 'principals') {
    if (owner) await ms.add(`/dav/principals/${uid}/`, principalProps(user), pr);
    else {
      await ms.add('/dav/principals/', plainCollection(user, 'principals'), pr);
      if (depth(req) === 1) await ms.add(`/dav/principals/${uid}/`, principalProps(user), pr);
    }
  } else if (area === 'files') {
    await ms.add(`/dav/${area}/`, plainCollection(user, area), pr);
    if (depth(req) === 1) await ms.add(`/dav/${area}/${uid}/`, plainCollection(user, area), pr);
  } else {
    throw new HttpError(404, 'Not found');
  }
  ms.send(res);
}

// ---------------------------------------------------------------- files (WebDAV)

async function files(req: IncomingMessage, res: ServerResponse, user: User, segs: string[]) {
  const base = ['dav', 'files', user.id];
  const hrefOf = (s: string[], dir: boolean) => encodePath([...base, ...s], dir);
  const node = await F.resolvePath(user.id, segs);
  const parentOf = async () => (segs.length ? F.resolvePath(user.id, segs.slice(0, -1)) : undefined);
  let usedCache: number | undefined;
  const used = async () => (usedCache ??= await F.usage(user.id));
  // macOS's WebDAV client (Finder "Connect to Server") waits 90 s before
  // finishing a mount when the folder reports quota, so it gets none (Finder then shows no free space).
  const quota = !String(req.headers['user-agent'] ?? '').startsWith('WebDAVFS/');

  const props = (n: F.Node): Props => {
    const m: Props = new Map<string, () => string | Promise<string>>([
      [d('resourcetype'), () => (n.is_dir ? '<d:collection/>' : '')],
      [d('displayname'), () => esc(n.name || user.id)],
      [d('getlastmodified'), () => httpDate(n.mtime)],
      [d('getetag'), () => `"${n.etag}"`],
      [d('supportedlock'), () => '<d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry>'],
      [d('lockdiscovery'), () => ''],
    ]);
    if (n.is_dir) {
      if (quota) {
        m.set(d('quota-used-bytes'), async () => String(await used()));
        m.set(d('quota-available-bytes'), async () => String(user.quota_bytes == null ? 1024 ** 4 : Math.max(0, user.quota_bytes - (await used()))));
      }
    } else {
      m.set(d('getcontentlength'), () => String(n.size));
      m.set(d('getcontenttype'), () => esc(n.mime));
    }
    return m;
  };

  switch (req.method) {
    case 'PROPFIND': {
      if (!node) throw new HttpError(404, 'Not found');
      // A whole tree in one answer is refused the standard way (RFC 4918 §9.1): the client then lists folder by
      // folder. It used to get one level, as if every subfolder were empty, which a sync client could act on.
      if (String(req.headers.depth ?? '').toLowerCase() === 'infinity' && node.is_dir) {
        return davError(res, 403, '<d:propfind-finite-depth/>');
      }
      const pr = propRequest(parseXml(await readText(req)));
      const ms = new Multistatus();
      await ms.add(hrefOf(segs, node.is_dir), props(node), pr);
      if (node.is_dir && depth(req) === 1) {
        for (const c of await F.children(node.id)) await ms.add(hrefOf([...segs, c.name], c.is_dir), props(c), pr);
      }
      return ms.send(res);
    }
    case 'PROPPATCH': {
      if (!node) throw new HttpError(404, 'Not found');
      return proppatchAccept(req, res, hrefOf(segs, node.is_dir));
    }
    case 'GET':
    case 'HEAD': {
      if (!node) throw new HttpError(404, 'Not found');
      if (node.is_dir) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return void res.end('This is a WebDAV folder. Connect with a WebDAV client.\n');
      }
      return sendNodeFile(req, res, node);
    }
    case 'PUT': {
      checkPreconditions(req, node); // before the body: a stale client must not upload it for nothing
      const parent = await parentOf();
      if (!parent || !parent.is_dir) throw new HttpError(409, 'Parent folder does not exist');
      if (node?.is_dir) throw new HttpError(405, 'Is a folder');
      // A partial PUT would be stored as the whole file (the rest of it lost). RFC 9110 §9.3.4: answer 400.
      if (req.headers['content-range']) throw new HttpError(400, 'Partial PUT (Content-Range) is not supported');
      const name = checkName(segs.at(-1)!); // before the body: a rejected name must not leave the upload in tmp/
      const { file, size, sha256 } = await F.streamToTemp(req, await F.remainingQuota(parent.owner));
      const { node: saved, created } = await F.writeFile(parent, name, file, size, { sha256 });
      res.writeHead(created ? 201 : 204, { ETag: `"${saved.etag}"`, 'Content-Length': 0 });
      return void res.end();
    }
    case 'MKCOL': {
      if ((await readText(req)).trim()) throw new HttpError(415, 'MKCOL body not supported here');
      if (node) throw new HttpError(405, 'Already exists');
      const parent = await parentOf();
      if (!parent || !parent.is_dir) throw new HttpError(409, 'Parent folder does not exist');
      await F.createDir(parent, checkName(segs.at(-1)!));
      res.writeHead(201, { 'Content-Length': 0 });
      return void res.end();
    }
    case 'DELETE': {
      if (!node) throw new HttpError(404, 'Not found');
      checkPreconditions(req, node);
      await F.trashNode(node);
      res.writeHead(204);
      return void res.end();
    }
    case 'MOVE':
    case 'COPY': {
      if (!node) throw new HttpError(404, 'Not found');
      const destSegs = destination(req, base);
      if (!destSegs.length) throw new HttpError(403, 'Cannot replace the root folder');
      const destParent = await F.resolvePath(user.id, destSegs.slice(0, -1));
      if (!destParent || !destParent.is_dir) throw new HttpError(409, 'Destination folder does not exist');
      const name = checkName(destSegs.at(-1)!);
      const existing = await F.childByName(destParent.id, name);
      if (existing?.id === node.id) throw new HttpError(403, 'Source and destination are the same');
      // Checks that would fail the move/copy itself, made before an existing destination goes to the trash: MOVE
      // /a/b onto /a (Overwrite: T) would otherwise trash a with b inside and then fail, and a folder copied into
      // itself would lose whatever it replaced.
      const destChain = await F.ancestors(destParent.id);
      if (node.is_dir && destChain.some((n) => n.id === node.id)) throw new HttpError(409, 'Cannot move or copy a folder into itself');
      if (existing && existing.is_dir && (await F.ancestors(node.id)).some((n) => n.id === existing.id)) {
        throw new HttpError(409, 'Cannot replace a folder that contains the source');
      }
      if (node.parent_id === null) throw new HttpError(403, 'Cannot move or copy the root folder');
      checkPreconditions(req, node);
      if (existing) {
        if (String(req.headers.overwrite ?? 'T').toUpperCase() === 'F') throw new HttpError(412, 'Destination exists');
        // A file onto a file: programs that save by writing a temporary file and renaming it over the original do
        // this on every save. The original keeps its identity (shares, public links, favorite) and gets the new
        // content as a new version; it used to be trashed and replaced by another item, and its links stopped working.
        if (!node.is_dir && !existing.is_dir) {
          await F.replaceFileContent(node, existing, req.method === 'MOVE');
          res.writeHead(204, { 'Content-Length': 0 });
          return void res.end();
        }
        await F.trashNode(existing);
      }
      if (req.method === 'MOVE') await F.moveNode(node, (await F.getNode(destParent.id))!, name);
      else await F.copyNode(node, (await F.getNode(destParent.id))!, name);
      res.writeHead(existing ? 204 : 201, { 'Content-Length': 0 });
      return void res.end();
    }
    case 'LOCK':
      return fakeLock(req, res, hrefOf(segs, !!node?.is_dir));
    case 'UNLOCK':
      res.writeHead(204);
      return void res.end();
    default:
      throw new HttpError(405, 'Method not allowed');
  }
}

function destination(req: IncomingMessage, base: string[]): string[] {
  const raw = String(req.headers.destination ?? '');
  if (!raw) throw new HttpError(400, 'Destination header required');
  let segs: string[];
  try {
    segs = new URL(raw, 'http://x').pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    throw new HttpError(400, 'Bad Destination header');
  }
  if (base.some((b, i) => segs[i] !== b)) throw new HttpError(502, 'Destination is outside this collection');
  return segs.slice(base.length);
}

/**
 * Locks are accepted but not enforced; macOS Finder and Windows need LOCK
 * support to mount a share read-write.
 */
async function fakeLock(req: IncomingMessage, res: ServerResponse, path: string) {
  const body = parseXml(await readText(req));
  const owner = descendant(body, NS.d, 'owner');
  const token = `opaquelocktoken:${randomUUID()}`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth>${
    owner ? `<d:owner>${esc(owner.children.map((c) => c.text).join('') || owner.text)}</d:owner>` : ''
  }<d:timeout>Second-1800</d:timeout><d:locktoken>${href(token)}</d:locktoken><d:lockroot>${href(path)}</d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;
  sendXml(res, 200, xml, { 'Lock-Token': `<${token}>` });
}

/** Accepts any PROPPATCH (e.g. Windows file times) without storing it. */
async function proppatchAccept(req: IncomingMessage, res: ServerResponse, path: string, apply?: (el: XEl) => Promise<boolean>) {
  const body = parseXml(await readText(req));
  const results: [string, number][] = [];
  for (const action of body?.children ?? []) {
    for (const prop of child(action, NS.d, 'prop')?.children ?? []) {
      const ok = apply ? await apply(prop) : true;
      results.push([elKey(prop), ok ? 200 : 403]);
    }
  }
  const ms = new Multistatus();
  ms.addPropStatus(path, results);
  ms.send(res);
}
