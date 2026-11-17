import type { IncomingMessage, ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { config } from './config.ts';

export class HttpError extends Error {
  status: number;
  /** Extra fields returned with the JSON error (e.g. { twoFactor: true }). */
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

/** Minimal router: patterns like "/api/nodes/:id/shares". */
export class Router {
  routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    this.routes.push({ method, re, keys, handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodePath(m[i + 1])));
      return { handler: r.handler, params };
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    return null;
  }
}

/** The compression the client accepts, best first ("br" or "gzip"), or null. */
export function acceptedEncoding(req: IncomingMessage | undefined): 'br' | 'gzip' | null {
  const h = String(req?.headers['accept-encoding'] ?? '');
  const ok = (name: string) => new RegExp(`(^|,)\\s*${name}\\s*(;\\s*q=(?!0(\\.0*)?\\s*(,|$))[\\d.]+)?\\s*(,|$)`, 'i').test(h);
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}

export function compress(body: Buffer, enc: 'br' | 'gzip'): Buffer {
  // Fast settings: a 1.5 MB listing of 5,000 files becomes about 150 KB in a few milliseconds.
  return enc === 'br' ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipSync(body, { level: 5 });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(data));
  const headers: Record<string, string | number> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  // Folder listings are mostly repeated keys: big ones are compressed (they were sent as they are).
  const enc = body.length >= 4096 ? acceptedEncoding(res.req) : null;
  const out = enc ? compress(body, enc) : body;
  if (enc) Object.assign(headers, { 'Content-Encoding': enc, Vary: 'Accept-Encoding' });
  res.writeHead(status, { ...headers, 'Content-Length': out.length });
  res.end(out);
}

export function noContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** How long a request body may stall (no bytes at all) before the connection is cut. */
export const BODY_IDLE_MS = 60_000;

/**
 * Cuts the connection when the request body stalls for `ms` (requestTimeout is 0 so big uploads can take hours; without
 * this a client that stops sending mid-body holds the connection, its buffered bytes and, for uploads, the upload
 * session for ever). Returns the function that ends the watch once the body is read.
 */
export function watchIdle(req: IncomingMessage, ms = BODY_IDLE_MS): () => void {
  let watching = true;
  const onTimeout = () => req.destroy(new HttpError(408, 'Request body timed out'));
  // Ends when the body has arrived, not when the handler is done: writing it to a slow disk (the final flush) is not
  // the client stalling, and with the timer still set the connection was cut after a complete upload.
  const done = () => {
    if (!watching) return;
    watching = false;
    req.removeListener('timeout', onTimeout);
    req.removeListener('end', done);
    req.socket?.setTimeout(0); // the connection may carry other requests (a live-update stream) next
  };
  if (req.readableEnded) return done;
  req.setTimeout(ms, onTimeout);
  req.once('end', done);
  return done;
}

export async function readBuffer(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stop = watchIdle(req);
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > limit) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
  } finally {
    stop();
  }
  return Buffer.concat(chunks);
}

export async function readText(req: IncomingMessage, limit?: number): Promise<string> {
  return (await readBuffer(req, limit)).toString('utf8');
}

/** A JSON object body (`{}` when empty). `null`, arrays and plain values are a 400, not a crash in the handler. */
export async function readJson<T = any>(req: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  const text = await readText(req, limit);
  if (!text) return {} as T;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Invalid JSON');
  return value as T;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignored */ }
  }
  return out;
}

export function isHttps(req: IncomingMessage): boolean {
  if (config.publicUrl.startsWith('https://')) return true; // the address users open: cookies must be Secure
  if (viaProxy(req)) return req.headers['x-forwarded-proto'] === 'https';
  return 'encrypted' in req.socket && !!req.socket.encrypted;
}

export function setCookie(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  value: string,
  maxAgeSec: number,
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  // Also when an untrusted hop says https (a proxy without TRUST_PROXY): a client that claims it falsely only locks
  // itself out of its own cookie.
  if (isHttps(req) || req.headers['x-forwarded-proto'] === 'https') parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

/**
 * Origin the browser sees, e.g. https://cloud.example.com. PUBLIC_URL wins; otherwise Host
 * (or X-Forwarded-Host behind a trusted proxy) with the request's scheme.
 */
export function publicOrigin(req: IncomingMessage): string {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  const fwd = viaProxy(req) ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
  const host = fwd || req.headers.host || 'localhost';
  try {
    return new URL(`${isHttps(req) ? 'https' : 'http'}://${host}`).origin;
  } catch {
    throw new HttpError(400, 'Invalid Host header');
  }
}

// Private, loopback, link-local, carrier-grade NAT and unique-local addresses: where proxies live.
const LOCAL = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10]] as const) {
  LOCAL.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) LOCAL.addSubnet(net, bits, 'ipv6');

/** IPv4-mapped IPv6 ("::ffff:1.2.3.4") as plain IPv4; brackets and ports removed. */
function normalizeIp(raw: string): string {
  let ip = raw.trim().replace(/^\[|\](:\d+)?$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

function inList(list: BlockList, ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? list.check(ip, 'ipv4') : v === 6 ? list.check(ip, 'ipv6') : false;
}

export function isLocalIp(ip: string): boolean {
  return inList(LOCAL, ip);
}

/** TRUST_PROXY as addresses / CIDR ranges ("172.16.0.0/12, fd00::/8"); null for true/false. Bad entries stop the start. */
const PROXIES = Array.isArray(config.trustProxy) ? proxyList(config.trustProxy) : null;

function proxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr, bits, extra] = entry.split('/');
    const ip = normalizeIp(addr);
    const v = isIP(ip);
    const max = v === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!v || extra !== undefined || !(prefix >= 0 && prefix <= max)) {
      console.error(`FATAL: TRUST_PROXY: "${entry}" is not an IP address or a CIDR range (for example 172.16.0.0/12), or true/false.`);
      process.exit(1);
    }
    list.addSubnet(ip, prefix, v === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** A hop that may set forwarded headers: any local address with TRUST_PROXY=true, else the listed proxies. */
function isProxy(ip: string): boolean {
  return PROXIES ? inList(PROXIES, ip) : isLocalIp(ip);
}

/**
 * Whether this request's forwarded headers count: TRUST_PROXY=true trusts them from any peer (as before 1.17),
 * a list of ranges only when the connection comes from one of them.
 */
export function viaProxy(req: IncomingMessage): boolean {
  if (!config.trustProxy) return false;
  return !PROXIES || inList(PROXIES, normalizeIp(req.socket.remoteAddress || ''));
}

/**
 * Client IP for rate limiting. Forwarded headers are spoofable, so they're only used with TRUST_PROXY.
 * The chain is X-Forwarded-For plus the connecting address. Going from the right (the hop nearest to us),
 * proxies are skipped while another address is further left (TRUST_PROXY=true: every local address counts as
 * a proxy, e.g. Traefik, nginx, Docker; TRUST_PROXY=<ranges>: only addresses in those ranges). The first other
 * address is the visitor, as recorded by the first proxy. Anything a client puts in X-Forwarded-For itself
 * lands left of that address, so it can't be used to dodge the rate limit from the internet. When every
 * address is a proxy (visitors on the home network with TRUST_PROXY=true), the leftmost one is used.
 */
let proxyHintShown = false;

export function clientIp(req: IncomingMessage): string {
  const socket = normalizeIp(req.socket.remoteAddress || '');
  if (!config.trustProxy && !proxyHintShown && req.headers['x-forwarded-for'] && isLocalIp(socket)) {
    proxyHintShown = true;
    console.warn(`Requests arrive through a reverse proxy (${socket}) but TRUST_PROXY is not set: every visitor counts as `
      + `the proxy's address, so ten wrong passwords from anyone block sign-in for everyone for 15 minutes. Set TRUST_PROXY `
      + `in .env to the proxy's address or range (for example ${socket.includes(':') ? 'fd00::/8' : '172.16.0.0/12'}).`);
  }
  if (!viaProxy(req)) return socket || 'unknown';
  const chain = [
    ...String(req.headers['x-forwarded-for'] ?? '').split(',').map(normalizeIp).filter((ip) => isIP(ip)),
    socket,
  ].filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!isProxy(chain[i])) return chain[i];
  return chain[0] || 'unknown';
}

/**
 * Rate-limit key for the client: its IP, but for IPv6 its /64 (one home or one server gets a whole /64, so counting
 * single addresses would let it try 2^64 times).
 */
export function clientNet(req: IncomingMessage): string {
  const ip = clientIp(req);
  if (isIP(ip) !== 6) return ip;
  const [head, tail] = ip.replace(/%.*$/, '').split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

/**
 * The request's path and query. The target is a path ("/files/12"): read as a URL relative to a base, a target that
 * starts with "//" names a host instead ("//x/api/…" was routed as "/api/…") and an empty host ("//", "/\\") threw
 * outside any handler, which stopped the whole server. Absolute targets ("http://host/path", for proxies) and
 * "OPTIONS *" are allowed by HTTP/1.1 and kept working.
 */
export function requestUrl(target: string): URL | null {
  try {
    if (target.startsWith('/')) return new URL('http://localhost' + target);
    if (target === '*') return new URL('http://localhost/');
    const abs = new URL(target);
    return /^https?:$/.test(abs.protocol) ? new URL('http://localhost' + abs.pathname + abs.search) : null;
  } catch {
    return null;
  }
}

/** `decodeURIComponent` that answers 400 instead of crashing the request on `%ZZ`. */
export function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'Bad URL encoding');
  }
}

/** A numeric id from the URL; anything else is 404 (not a database error). */
export function numId(s: string): string {
  if (!/^\d{1,18}$/.test(s)) throw new HttpError(404, 'Not found');
  return s;
}

/** Validates a single file/folder name. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string') throw new HttpError(400, 'Name required');
  const n = name.trim();
  // Each refusal says why ("Invalid name" alone left people guessing).
  if (!n) throw new HttpError(400, 'Name required');
  if (n === '.' || n === '..') throw new HttpError(400, 'The names "." and ".." cannot be used');
  if (n.length > 255) throw new HttpError(400, 'Names can have at most 255 characters');
  if (/[\/\\]/.test(n)) throw new HttpError(400, 'Names cannot contain a slash or a backslash');
  // Control characters (other than tab, LF and CR, allowed inside a name; at the ends the trim check below says no),
  // U+FFFE/U+FFFF and unpaired surrogates: invisible, and unsafe in ZIP downloads and the apps' file systems.
  if (/[\0-\x08\x0b\x0c\x0e-\x1f￾￿]/.test(n) || !n.isWellFormed()) throw new HttpError(400, 'Names cannot contain control characters');
  // Stored under a different name than asked for, sync clients make duplicates: say no instead of silently trimming.
  if (n !== name) throw new HttpError(400, 'Names cannot start or end with a space');
  // One Unicode form for every name (NFC): a Mac sends "é" as "e" + accent, a phone as one character; both were
  // stored as typed, so search missed one of them and two identical-looking files could share a folder.
  return n.normalize('NFC');
}
