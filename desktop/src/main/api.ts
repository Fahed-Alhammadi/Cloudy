// Cloudy JSON API client for the sync engine (bearer device token, same endpoints as the mobile apps).
import { open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface RemoteNode {
  id: number;
  name: string;
  isDir: boolean;
  size: number;
  etag: string;
  mtime: string;
  parentId: number | null;
}

/** `id` is the username. */
export interface Me { id: string; displayName?: string; language?: string | null; rootId: number }

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Server address as typed by the user → origin without trailing slash ("cloud.example.com" → https://…). */
export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  // Plain http:// would send the password and the device token in the clear: only on the local network.
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new Error('HTTPS_REQUIRED');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** localhost, .local/.lan/.home.arpa names and private IPv4/IPv6 ranges (like the iPhone app's local-network rule). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.startsWith('fe80:') || h.startsWith('fd') || h.startsWith('fc');
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** No answer at all from the server (Node's fetch, undici, Electron's `net::ERR_*`, our own timeouts). */
export function isNetworkError(e: any): boolean {
  const code = String(e?.cause?.code ?? e?.code ?? '');
  return (e instanceof TypeError && e.message === 'fetch failed') || code.startsWith('UND_ERR') || /^net::ERR_/.test(String(e?.message ?? ''))
    || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code);
}

/** Worth sending a chunk again: no answer, a busy/failing server (not "storage full"), an offset mismatch or a chunk still in progress. */
const retryable = (e: any) => isNetworkError(e) || (e instanceof ApiError && ((e.status >= 500 && e.status !== 507) || e.status === 429
  || (e.status === 409 && (typeof e.body?.received === 'number' || /in progress/i.test(e.message)))));

/** JSON calls and upload chunks give up after this long; downloads and live events after this long without data. */
const JSON_TIMEOUT = 120_000;
const CHUNK_TIMEOUT = 15 * 60_000;
const IDLE_TIMEOUT = 120_000;
const EVENTS_IDLE = 90_000; // the server sends a ping every 25 s

function timedOut(): Error {
  return Object.assign(new Error('The server did not answer in time'), { code: 'ETIMEDOUT' });
}

/** A signal that fires on `signal` or after `ms` (0 = never); `expired()` tells our timeout from the caller's abort. */
function deadline(signal: AbortSignal | undefined, ms: number) {
  const own = new AbortController();
  const timer = ms ? setTimeout(() => own.abort(), ms) : null;
  return {
    signal: signal ? AbortSignal.any([signal, own.signal]) : own.signal,
    /** for idle timeouts: called whenever data arrives */
    touch() { if (timer) timer.refresh(); },
    expired: () => own.signal.aborted && !signal?.aborted,
    abort: () => own.abort(),
    done() { if (timer) clearTimeout(timer); },
  };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

export class Api {
  server: string;
  token: string;
  userAgent: string;
  /** The app passes Electron's `net.fetch` (system proxy and certificate store); tests use Node's. */
  fetch: Fetch;

  constructor(server: string, token: string, userAgent = 'Cloudy Desktop', fetchImpl: Fetch = globalThis.fetch) {
    this.server = server;
    this.token = token;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
  }

  /** Exchanges a username and password (and 2FA code) for a device token. */
  static async login(server: string, user: string, password: string, code: string | undefined, deviceName: string, userAgent?: string, fetchImpl?: Fetch) {
    const api = new Api(server, '', userAgent, fetchImpl);
    return api.json<{ token: string; user: Me }>('POST', '/api/auth/token', { user, password, code, deviceName });
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'X-Cloudy-Request': '1', 'User-Agent': this.userAgent, ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetch(this.server + path, { method, headers: this.headers(headers), body, signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data);
    }
    return res;
  }

  /** `request` + reading the JSON answer, given up after `ms` (a server or network that hangs must not stall a sync forever). */
  async call<T>(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal, ms = JSON_TIMEOUT): Promise<T> {
    const d = deadline(signal, ms);
    try {
      const res = await this.request(method, path, body, headers, d.signal);
      return (res.status === 204 ? undefined : await res.json()) as T;
    } catch (e) {
      throw d.expired() ? timedOut() : e;
    } finally {
      d.done();
    }
  }

  json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.call<T>(method, path, body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { 'Content-Type': 'application/json' }, signal);
  }

  me = () => this.json<Me>('GET', '/api/me');
  revoke = () => this.json<void>('POST', '/api/auth/revoke');
  node = (id: number) => this.json<{ node: RemoteNode; children?: RemoteNode[] }>('GET', `/api/nodes/${id}`);
  mkdir = (parentId: number, name: string) => this.json<RemoteNode>('POST', `/api/nodes/${parentId}/folders`, { name });
  move = (id: number, parentId: number, name: string) => this.json<RemoteNode>('PATCH', `/api/nodes/${id}`, { parentId, name });
  trash = (id: number) => this.json<void>('DELETE', `/api/nodes/${id}`);

  /** Streams a file to `dest`; a connection that stops sending data for `IDLE_TIMEOUT` fails instead of hanging. */
  async download(id: number, dest: string, signal?: AbortSignal): Promise<void> {
    const d = deadline(signal, IDLE_TIMEOUT);
    try {
      const res = await this.request('GET', `/api/nodes/${id}/download`, undefined, {}, d.signal);
      d.touch();
      const alive = new Transform({ transform(chunk, _enc, cb) { d.touch(); cb(null, chunk); } });
      await pipeline(Readable.fromWeb(res.body as any), alive, createWriteStream(dest));
    } catch (e) {
      throw d.expired() ? timedOut() : e;
    } finally {
      d.done();
    }
  }

  /**
   * Chunked upload; replaces a file with the same name, keeping the old one as a version. A chunk that fails on the
   * way (dropped connection, server restart) is retried a few times from the offset the server actually stored.
   */
  async upload(parentId: number, name: string, file: string, size: number, signal?: AbortSignal): Promise<{ id: number }> {
    const up = await this.json<{ id: string; chunkSize: number }>('POST', '/api/uploads', { parentId, name, size }, signal);
    const fh = await open(file, 'r');
    try {
      let offset = 0;
      let failures = 0;
      const buf = Buffer.alloc(Math.min(up.chunkSize, Math.max(size, 1)));
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - offset), offset);
        if (bytesRead === 0 && offset < size) throw new Error('File got shorter while uploading');
        let r: { received: number; done: boolean; node?: { id: number } };
        try {
          r = await this.call('PUT', `/api/uploads/${up.id}`, buf.subarray(0, bytesRead),
            { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' }, signal, CHUNK_TIMEOUT);
        } catch (e) {
          // The server may have stored none, part or all of the chunk: carry on from what it has (404: the upload is gone).
          for (let err = e; ; ) {
            if (signal?.aborted || !retryable(err) || ++failures > 4) throw err;
            await sleep(500 * 2 ** failures, signal);
            try {
              offset = (await this.json<{ received: number }>('GET', `/api/uploads/${up.id}`, undefined, signal)).received;
              break;
            } catch (e2) {
              err = e2;
            }
          }
          continue;
        }
        failures = 0;
        offset = r.received;
        if (r.done) return r.node!;
      }
    } catch (e) {
      // Best effort and short: the server also expires abandoned uploads after a day.
      await this.call('DELETE', `/api/uploads/${up.id}`, undefined, {}, undefined, 10_000).catch(() => {});
      throw e;
    } finally {
      await fh.close();
    }
  }

  /**
   * Server-Sent Events (`/api/events`): calls `onChange` for every change event until `signal` aborts or the stream
   * ends. A stream that goes silent (no ping for `EVENTS_IDLE`: sleep, Wi-Fi change, a proxy dropping it) is ended too,
   * so the caller reconnects instead of waiting for ever.
   */
  async events(onChange: () => void, signal: AbortSignal, idleMs = EVENTS_IDLE): Promise<void> {
    const d = deadline(signal, idleMs);
    try {
      const res = await this.request('GET', '/api/events', undefined, { Accept: 'text/event-stream' }, d.signal);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        d.touch();
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: change$/m.test(block)) onChange();
        }
      }
    } catch (e) {
      throw d.expired() ? timedOut() : e;
    } finally {
      d.done();
    }
  }
}
