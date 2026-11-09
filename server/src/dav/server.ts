import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basicUser } from '../auth.ts';
import type { User } from '../auth.ts';
import { readText, checkName, HttpError } from '../http.ts';
import * as F from '../files.ts';
import { sendNodeFile } from '../download.ts';
import * as G from '../groupware.ts';
import type { Kind, Collection, DavObject } from '../groupware.ts';
import {
  NS, parseXml, child, descendant, key, elKey, esc, href, propRequest, Multistatus, sendXml, davError,
  encodePath, httpDate, PRIVILEGES,
} from './xml.ts';
import type { Props, PropRequest, XEl } from './xml.ts';

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, COPY, MOVE, LOCK, UNLOCK, REPORT';
const DAV_HEADER = '1, 2, 3, calendar-access, addressbook, extended-mkcol';

const d = (n: string) => key(NS.d, n);
const cal = (n: string) => key(NS.cal, n);
const card = (n: string) => key(NS.card, n);
const cs = (n: string) => key(NS.cs, n);
const ic = (n: string) => key(NS.ic, n);

const syncToken = (c: Collection) => `http://cloudy.local/sync/${c.ctag}`;

function depth(req: IncomingMessage, dflt: 0 | 1 = 1): 0 | 1 {
  const h = String(req.headers.depth ?? '').toLowerCase();
  if (h === '0') return 0;
  if (h === '1' || h === 'infinity') return 1;
  return dflt;
}

/** Handles everything under /dav and returns true, or false for other paths. */
export async function handleDav(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path === '/.well-known/caldav' || path === '/.well-known/carddav') {
    res.writeHead(301, { Location: '/dav/' });
    res.end();
    return true;
  }
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
  else if (area === 'calendars' && owner) await groupware(req, res, user, G.CAL, rest);
  else if (area === 'addressbooks' && owner) await groupware(req, res, user, G.CARD, rest);
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
    [cal('calendar-home-set'), () => href(`/dav/calendars/${encodeURIComponent(user.id)}/`)],
    [card('addressbook-home-set'), () => href(`/dav/addressbooks/${encodeURIComponent(user.id)}/`)],
    [cal('calendar-user-address-set'), () => (user.email ? href(`mailto:${user.email}`) : '') + href(p)],
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
      for (const a of ['files', 'calendars', 'addressbooks', 'principals']) {
        await ms.add(`/dav/${a}/${uid}/`, a === 'principals' ? principalProps(user) : plainCollection(user, a), pr);
      }
    }
  } else if (area === 'principals') {
    if (owner) await ms.add(`/dav/principals/${uid}/`, principalProps(user), pr);
    else {
      await ms.add('/dav/principals/', plainCollection(user, 'principals'), pr);
      if (depth(req) === 1) await ms.add(`/dav/principals/${uid}/`, principalProps(user), pr);
    }
  } else if (['files', 'calendars', 'addressbooks'].includes(area)) {
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
      if (existing) {
        if (String(req.headers.overwrite ?? 'T').toUpperCase() === 'F') throw new HttpError(412, 'Destination exists');
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

// ---------------------------------------------------------------- CalDAV / CardDAV

async function groupware(req: IncomingMessage, res: ServerResponse, user: User, k: Kind, segs: string[]) {
  const area = k.key === 'cal' ? 'calendars' : 'addressbooks';
  const homeHref = `/dav/${area}/${encodeURIComponent(user.id)}/`;
  const collHref = (c: Collection) => `${homeHref}${encodeURIComponent(c.uri)}/`;
  const objHref = (c: Collection, o: { uri: string }) => collHref(c) + encodeURIComponent(o.uri);
  const [collUri, objUri, ...extra] = segs;
  if (extra.length) throw new HttpError(404, 'Not found');

  const collProps = (c: Collection): Props => {
    const m: Props = new Map<string, () => string>([
      [d('resourcetype'), () => '<d:collection/>' + (k.key === 'cal' ? '<cal:calendar/>' : '<card:addressbook/>')],
      [d('displayname'), () => esc(c.name)],
      [cs('getctag'), () => String(c.ctag)],
      [d('sync-token'), () => syncToken(c)],
      [d('owner'), () => href(`/dav/principals/${encodeURIComponent(user.id)}/`)],
      [d('current-user-principal'), () => href(`/dav/principals/${encodeURIComponent(user.id)}/`)],
      [d('current-user-privilege-set'), () => PRIVILEGES],
      [d('supported-report-set'), () => (k.key === 'cal'
        ? ['cal:calendar-multiget', 'cal:calendar-query', 'd:sync-collection']
        : ['card:addressbook-multiget', 'card:addressbook-query', 'd:sync-collection'])
        .map((r) => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`).join('')],
    ]);
    if (k.key === 'cal') {
      m.set(ic('calendar-color'), () => esc(c.color));
      m.set(cal('supported-calendar-component-set'), () => '<cal:comp name="VEVENT"/><cal:comp name="VTODO"/>');
    } else {
      m.set(card('supported-address-data'), () => '<card:address-data-type content-type="text/vcard" version="3.0"/>');
    }
    return m;
  };

  const dataKey = k.key === 'cal' ? cal('calendar-data') : card('address-data');
  const objProps = (o: DavObject): Props => new Map<string, () => string>([
    [d('resourcetype'), () => ''],
    [d('getetag'), () => `"${o.etag}"`],
    [d('getcontenttype'), () => (k.key === 'cal' ? `text/calendar; charset=utf-8; component=${o.component.toLowerCase()}` : k.contentType)],
    [d('getcontentlength'), () => String(Buffer.byteLength(o.data))],
    [d('getlastmodified'), () => httpDate(o.updated_at)],
    [dataKey, () => esc(o.data)],
  ]);

  const homeProps = (): Props => {
    const m = plainCollection(user, area);
    m.set(d('current-user-privilege-set'), () => PRIVILEGES);
    return m;
  };

  // ---- home collection
  if (!collUri) {
    if (req.method === 'PROPFIND') {
      const pr = propRequest(parseXml(await readText(req)));
      const ms = new Multistatus();
      await ms.add(homeHref, homeProps(), pr);
      if (depth(req) === 1) for (const c of await G.listCollections(k, user.id)) await ms.add(collHref(c), collProps(c), pr, [dataKey]);
      return ms.send(res);
    }
    if (req.method === 'PROPPATCH') return proppatchAccept(req, res, homeHref);
    if (req.method === 'REPORT') return new Multistatus().send(res);
    throw new HttpError(405, 'Method not allowed');
  }

  const coll = await G.getCollection(k, user.id, collUri);

  // ---- collection
  if (objUri === undefined) {
    switch (req.method) {
      case 'MKCALENDAR':
      case 'MKCOL': {
        if (coll) throw new HttpError(405, 'Already exists');
        if (req.method === 'MKCALENDAR' && k.key !== 'cal') throw new HttpError(403, 'Not a calendar home');
        const body = parseXml(await readText(req));
        const name = descendant(body, NS.d, 'displayname')?.text ?? collUri;
        const color = descendant(body, NS.ic, 'calendar-color')?.text ?? '';
        await G.createCollection(k, user.id, collUri, name, color.slice(0, 7));
        res.writeHead(201, { 'Content-Length': 0 });
        return void res.end();
      }
    }
    if (!coll) throw new HttpError(404, 'Not found');
    switch (req.method) {
      case 'PROPFIND': {
        const pr = propRequest(parseXml(await readText(req)));
        const ms = new Multistatus();
        await ms.add(collHref(coll), collProps(coll), pr);
        if (depth(req, 0) === 1) for (const o of await G.listObjects(k, coll.id)) await ms.add(objHref(coll, o), objProps(o), pr, [dataKey]);
        return ms.send(res);
      }
      case 'PROPPATCH':
        return proppatchAccept(req, res, collHref(coll), async (p) => {
          if (p.ns === NS.d && p.name === 'displayname') await G.updateCollection(k, coll.id, { name: p.text });
          else if (p.ns === NS.ic && p.name === 'calendar-color') await G.updateCollection(k, coll.id, { color: p.text.slice(0, 7) });
          return true;
        });
      case 'REPORT':
        return report(req, res, k, coll, objHref, objProps);
      case 'DELETE':
        await G.deleteCollection(k, coll.id);
        res.writeHead(204);
        return void res.end();
      case 'GET':
      case 'HEAD': {
        // Export the whole collection as one .ics / .vcf.
        const objs = await G.listObjects(k, coll.id);
        const body = k.key === 'cal' ? mergeCalendars(objs) : objs.map((o) => o.data.trim()).join('\r\n') + '\r\n';
        res.writeHead(200, { 'Content-Type': k.contentType, 'Content-Disposition': `attachment; filename="${coll.uri}${k.ext}"` });
        return void res.end(req.method === 'HEAD' ? undefined : body);
      }
      default:
        throw new HttpError(405, 'Method not allowed');
    }
  }

  // ---- object
  if (!coll) throw new HttpError(404, 'Not found');
  const obj = await G.getObject(k, coll.id, objUri);
  switch (req.method) {
    case 'GET':
    case 'HEAD':
      if (!obj) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': k.contentType, ETag: `"${obj.etag}"`, 'Content-Length': Buffer.byteLength(obj.data) });
      return void res.end(req.method === 'HEAD' ? undefined : obj.data);
    case 'PUT': {
      const { obj: saved, created } = await G.putObject(k, coll, objUri, await readText(req, 20 * 1024 * 1024), {
        ifMatch: req.headers['if-match'] as string | undefined,
        ifNoneMatch: req.headers['if-none-match'] as string | undefined,
      });
      res.writeHead(created ? 201 : 204, { ETag: `"${saved.etag}"`, 'Content-Length': 0 });
      return void res.end();
    }
    case 'DELETE':
      if (!(await G.deleteObject(k, coll, objUri, req.headers['if-match'] as string | undefined))) throw new HttpError(404, 'Not found');
      res.writeHead(204);
      return void res.end();
    case 'PROPFIND': {
      if (!obj) throw new HttpError(404, 'Not found');
      const ms = new Multistatus();
      await ms.add(objHref(coll, obj), objProps(obj), propRequest(parseXml(await readText(req))), [dataKey]);
      return ms.send(res);
    }
    case 'PROPPATCH':
      return proppatchAccept(req, res, objHref(coll, { uri: objUri }));
    default:
      throw new HttpError(405, 'Method not allowed');
  }
}

function mergeCalendars(objs: DavObject[]): string {
  const inner: string[] = [];
  for (const o of objs) {
    const m = /BEGIN:VCALENDAR\r?\n([\s\S]*?)END:VCALENDAR/.exec(o.data);
    if (m) inner.push(m[1].replace(/^(VERSION|PRODID|CALSCALE|METHOD):.*\r?\n/gm, '').trim());
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cloudy//EN', ...inner, 'END:VCALENDAR', ''].join('\r\n');
}

function parseCalDavTime(s: string | undefined): Date | undefined {
  const m = s && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : undefined;
}

async function report(
  req: IncomingMessage,
  res: ServerResponse,
  k: Kind,
  coll: Collection,
  objHref: (c: Collection, o: { uri: string }) => string,
  objProps: (o: DavObject) => Props,
) {
  const body = parseXml(await readText(req));
  if (!body) throw new HttpError(400, 'Missing REPORT body');
  const pr: PropRequest = propRequest(body);
  const ms = new Multistatus();

  if (body.name === 'calendar-multiget' || body.name === 'addressbook-multiget') {
    for (const h of body.children.filter((c) => c.ns === NS.d && c.name === 'href')) {
      let uri = '';
      try { uri = decodeURIComponent(h.text.split('/').filter(Boolean).pop() ?? ''); } catch { /* bad %-encoding: 404 below */ }
      const o = uri ? await G.getObject(k, coll.id, uri) : undefined;
      if (o) await ms.add(objHref(coll, o), objProps(o), pr);
      else ms.addStatus(h.text, 404);
    }
    return ms.send(res);
  }

  if (body.name === 'calendar-query' || body.name === 'addressbook-query') {
    let range: { start?: Date; end?: Date; component?: string } | undefined;
    if (k.key === 'cal') {
      const top = descendant(body, NS.cal, 'comp-filter');
      const inner = top?.children.find((c) => c.ns === NS.cal && c.name === 'comp-filter');
      const tr = descendant(inner ?? top, NS.cal, 'time-range');
      range = {
        component: inner?.attrs.name?.toUpperCase(),
        start: parseCalDavTime(tr?.attrs.start),
        end: parseCalDavTime(tr?.attrs.end),
      };
    }
    for (const o of await G.listObjects(k, coll.id, range)) await ms.add(objHref(coll, o), objProps(o), pr);
    return ms.send(res);
  }

  if (body.name === 'sync-collection') {
    const raw = child(body, NS.d, 'sync-token')?.text ?? '';
    if (!raw) {
      for (const o of await G.listObjects(k, coll.id)) await ms.add(objHref(coll, o), objProps(o), pr);
    } else {
      const token = Number(raw.split('/').pop());
      const changes = await G.changesSince(k, coll, token);
      if (!changes) return davError(res, 403, '<d:valid-sync-token/>');
      for (const ch of changes) {
        const o = ch.deleted ? undefined : await G.getObject(k, coll.id, ch.uri);
        if (o) await ms.add(objHref(coll, o), objProps(o), pr);
        else ms.addStatus(objHref(coll, ch), 404);
      }
    }
    ms.extra = `<d:sync-token>${syncToken(coll)}</d:sync-token>`;
    return ms.send(res);
  }

  throw new HttpError(403, `Unsupported report ${body.name}`);
}
