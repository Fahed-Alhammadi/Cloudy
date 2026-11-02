import { XMLParser } from 'fast-xml-parser';
import type { ServerResponse } from 'node:http';
import { HttpError } from '../http.ts';

export const NS = {
  d: 'DAV:',
  cal: 'urn:ietf:params:xml:ns:caldav',
  card: 'urn:ietf:params:xml:ns:carddav',
  cs: 'http://calendarserver.org/ns/',
  ic: 'http://apple.com/ns/ical/',
} as const;

const PREFIX: Record<string, string> = Object.fromEntries(Object.entries(NS).map(([p, ns]) => [ns, p]));

/** A namespace-resolved XML element. */
export interface XEl {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
  text: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  attributeNamePrefix: '',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export function parseXml(text: string): XEl | null {
  if (!text.trim()) return null;
  let tree: any[];
  try {
    tree = parser.parse(text);
  } catch {
    return null;
  }
  const convert = (item: any, scope: Record<string, string>): XEl | null => {
    const key = Object.keys(item).find((k) => k !== ':@');
    if (!key || key === '#text') return null;
    const attrs: Record<string, string> = item[':@'] ?? {};
    const sc = { ...scope };
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'xmlns') sc[''] = v;
      else if (k.startsWith('xmlns:')) sc[k.slice(6)] = v;
    }
    const i = key.indexOf(':');
    const [prefix, local] = i >= 0 ? [key.slice(0, i), key.slice(i + 1)] : ['', key];
    const el: XEl = { ns: sc[prefix] ?? '', name: local, attrs, children: [], text: '' };
    for (const child of item[key] ?? []) {
      if ('#text' in child) el.text += String(child['#text']);
      else {
        const c = convert(child, sc);
        if (c) el.children.push(c);
      }
    }
    return el;
  };
  for (const item of tree) {
    const el = convert(item, {});
    if (el) return el;
  }
  return null;
}

export const key = (ns: string, name: string) => `{${ns}}${name}`;
export const elKey = (el: XEl) => key(el.ns, el.name);

export function child(el: XEl | null | undefined, ns: string, name: string): XEl | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

export function descendant(el: XEl | null | undefined, ns: string, name: string): XEl | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (c.ns === ns && c.name === name) return c;
    const d = descendant(c, ns, name);
    if (d) return d;
  }
  return undefined;
}

export const esc = (s: unknown) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Renders `{ns}name` with content, using our prefixes or an inline xmlns for unknown namespaces. */
export function el(k: string, content = ''): string {
  const m = /^\{(.*)\}(.+)$/.exec(k)!;
  const [ns, name] = [m[1], m[2]];
  // Names come from the client's PROPFIND/PROPPATCH body: only XML names, so nothing can break out of the tag.
  if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new HttpError(400, `Invalid property name`);
  const p = PREFIX[ns];
  const tag = p ? `${p}:${name}` : `x:${name}`;
  const decl = p ? '' : ` xmlns:x="${esc(ns)}"`;
  return content ? `<${tag}${decl}>${content}</${tag}>` : `<${tag}${decl}/>`;
}

export const href = (h: string) => `<d:href>${esc(h)}</d:href>`;

/** What a PROPFIND / REPORT asked for. */
export type PropRequest = { kind: 'all' } | { kind: 'names' } | { kind: 'props'; keys: string[] };

export function propRequest(root: XEl | null | undefined): PropRequest {
  if (!root) return { kind: 'all' };
  if (child(root, NS.d, 'propname')) return { kind: 'names' };
  const prop = child(root, NS.d, 'prop');
  if (prop) return { kind: 'props', keys: prop.children.map(elKey) };
  return { kind: 'all' };
}

/** Properties of a resource. Values are lazy so expensive ones are computed only when asked. */
export type Props = Map<string, () => string | Promise<string>>;

const STATUS: Record<number, string> = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };

export class Multistatus {
  parts: string[] = [];
  extra = '';

  async add(path: string, props: Props, req: PropRequest, hiddenFromAll: string[] = []): Promise<void> {
    const found: string[] = [];
    const missing: string[] = [];
    if (req.kind === 'names') {
      for (const k of props.keys()) found.push(el(k));
    } else {
      const keys = req.kind === 'all' ? [...props.keys()].filter((k) => !hiddenFromAll.includes(k)) : req.keys;
      for (const k of keys) {
        const get = props.get(k);
        if (get) found.push(el(k, await get()));
        else missing.push(el(k));
      }
    }
    let out = `<d:response>${href(path)}`;
    if (found.length) out += propstat(found.join(''), 200);
    if (missing.length) out += propstat(missing.join(''), 404);
    this.parts.push(out + '</d:response>');
  }

  addStatus(path: string, status: number): void {
    this.parts.push(`<d:response>${href(path)}<d:status>HTTP/1.1 ${status} ${STATUS[status] ?? ''}</d:status></d:response>`);
  }

  /** PROPPATCH-style response: each key with its own status. */
  addPropStatus(path: string, results: [string, number][]): void {
    const groups = new Map<number, string[]>();
    for (const [k, s] of results) groups.set(s, [...(groups.get(s) ?? []), el(k)]);
    let out = `<d:response>${href(path)}`;
    for (const [s, list] of groups) out += propstat(list.join(''), s);
    this.parts.push(out + '</d:response>');
  }

  send(res: ServerResponse): void {
    const ns = Object.entries(NS).map(([p, n]) => `xmlns:${p}="${n}"`).join(' ');
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${ns}>${this.parts.join('')}${this.extra}</d:multistatus>`;
    sendXml(res, 207, body);
  }
}

function propstat(props: string, status: number): string {
  return `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status} ${STATUS[status] ?? ''}</d:status></d:propstat>`;
}

export function sendXml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function davError(res: ServerResponse, status: number, condition: string): void {
  sendXml(res, status, `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:cal="${NS.cal}" xmlns:card="${NS.card}">${condition}</d:error>`);
}

/** Encodes each path segment for use in an href. */
export const encodePath = (segments: string[], trailingSlash = false) =>
  '/' + segments.map(encodeURIComponent).join('/') + (trailingSlash && segments.length ? '/' : '');

export const httpDate = (d: Date | string) => new Date(d).toUTCString();

export const PRIVILEGES = ['all', 'read', 'write', 'write-properties', 'write-content', 'bind', 'unbind']
  .map((p) => `<d:privilege><d:${p}/></d:privilege>`).join('');
