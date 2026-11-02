// Cloudy JSON API client for the sync engine (bearer device token, same endpoints as the mobile apps).
import { open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
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

export class Api {
  server: string;
  token: string;
  userAgent: string;

  constructor(server: string, token: string, userAgent = 'Cloudy Desktop') {
    this.server = server;
    this.token = token;
    this.userAgent = userAgent;
  }

  /** Exchanges a username and password (and 2FA code) for a device token. */
  static async login(server: string, user: string, password: string, code: string | undefined, deviceName: string, userAgent?: string) {
    const api = new Api(server, '', userAgent);
    return api.json<{ token: string; user: Me }>('POST', '/api/auth/token', { user, password, code, deviceName });
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'X-Cloudy-Request': '1', 'User-Agent': this.userAgent, ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async request(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.server + path, { method, headers: this.headers(headers), body, signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { 'Content-Type': 'application/json' });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  me = () => this.json<Me>('GET', '/api/me');
  revoke = () => this.json<void>('POST', '/api/auth/revoke');
  node = (id: number) => this.json<{ node: RemoteNode; children?: RemoteNode[] }>('GET', `/api/nodes/${id}`);
  mkdir = (parentId: number, name: string) => this.json<RemoteNode>('POST', `/api/nodes/${parentId}/folders`, { name });
  move = (id: number, parentId: number, name: string) => this.json<RemoteNode>('PATCH', `/api/nodes/${id}`, { parentId, name });
  trash = (id: number) => this.json<void>('DELETE', `/api/nodes/${id}`);

  /** Streams a file to `dest`. */
  async download(id: number, dest: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request('GET', `/api/nodes/${id}/download`, undefined, {}, signal);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
  }

  /** Chunked upload (resumable on the server); replaces a file with the same name, keeping the old one as a version. */
  async upload(parentId: number, name: string, file: string, size: number, signal?: AbortSignal): Promise<{ id: number }> {
    const up = await this.json<{ id: string; chunkSize: number }>('POST', '/api/uploads', { parentId, name, size });
    const fh = await open(file, 'r');
    try {
      let offset = 0;
      const buf = Buffer.alloc(Math.min(up.chunkSize, Math.max(size, 1)));
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - offset), offset);
        const res = await this.request('PUT', `/api/uploads/${up.id}`, buf.subarray(0, bytesRead),
          { 'Upload-Offset': String(offset), 'Content-Type': 'application/octet-stream' }, signal);
        const r = (await res.json()) as { received: number; done: boolean; node?: { id: number } };
        offset = r.received;
        if (r.done) return r.node!;
        if (bytesRead === 0) throw new Error('File got shorter while uploading');
      }
    } catch (e) {
      await this.request('DELETE', `/api/uploads/${up.id}`).catch(() => {});
      throw e;
    } finally {
      await fh.close();
    }
  }

  /** Server-Sent Events (`/api/events`): calls `onChange` for every change event until `signal` aborts. */
  async events(onChange: () => void, signal: AbortSignal): Promise<void> {
    const res = await this.request('GET', '/api/events', undefined, { Accept: 'text/event-stream' }, signal);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event: change$/m.test(block)) onChange();
      }
    }
  }
}
