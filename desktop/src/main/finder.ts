// Finder badges (macOS). The Finder Sync extension inside Cloudy.app (desktop/finder) is sandboxed: it may make
// network connections and read one file, ~/Library/Application Support/Cloudy/finder.json, where this process writes
// the loopback port it listens on and two random values (mode 0600, new on every start). Both sides prove they read
// that file, which only this user can: the app first sends {"app": appProof} (so a process of another user that took
// over the port after a crash learns nothing: the extension checks it before saying anything), then the extension's
// first line must be {"hello": secret}; anything else closes the connection. Then one JSON object per line each way:
//   app → extension  {"folders": [abs, …]}       the sync folders Finder should badge (sent on connect and on change)
//   extension → app  {"ask": [abs, …]}           badges wanted for these items
//   app → extension  {"badges": {abs: id, …}}     "synced" | "syncing" | "error" | "" (none)
//   app → extension  {"changed": [abs, …] | null} these items (null: all) may look different now: ask again
// No Electron imports: tested in test/finder.test.ts.
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Badge } from './sync.ts';

export type BadgeOf = (abs: string) => Badge | null;

/** Longest line accepted before and after the hello, and most items answered per line (the extension sends ≤ 1,000). */
const MAX_HELLO = 512;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_ASK = 10_000;
/** Seconds a connection has to say hello; bytes of output an extension may leave unread before it is dropped. */
const HELLO_MS = 10_000;
const MAX_UNREAD = 8 * 1024 * 1024;
/** Changes are collected for this long and sent together (a sync pass changes many items quickly). */
const BATCH_MS = 250;

export class FinderBadges {
  private portFile: string;
  private secret = randomBytes(32).toString('hex');
  private appProof = randomBytes(32).toString('hex');
  private badgeOf: BadgeOf;
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private folders: string[] = [];
  private changedPaths = new Set<string>();
  private changedAll = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(portFile: string, badgeOf: BadgeOf) {
    this.portFile = portFile;
    this.badgeOf = badgeOf;
  }

  async start(): Promise<void> {
    const server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.on('error', (e) => console.error('Cloudy: Finder badges', e));
    this.server = server;
    const { port } = server.address() as net.AddressInfo;
    // Written whole (temp file + rename): the extension may read it at any moment.
    await mkdir(path.dirname(this.portFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.portFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ port, secret: this.secret, app: this.appProof }) + '\n', { mode: 0o600 });
    await rename(tmp, this.portFile);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.clients) c.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.removePortFileSync();
  }

  /** Whether finder.json is still this process's (another Cloudy, e.g. a test copy, may have replaced it). */
  private ownsPortFile(): boolean {
    try {
      return JSON.parse(readFileSync(this.portFile, 'utf8'))?.secret === this.secret;
    } catch {
      return false;
    }
  }

  /** At quit, when there is no time for close(): the extension must not find a port that is gone. */
  removePortFileSync(): void {
    if (this.ownsPortFile()) rmSync(this.portFile, { force: true });
  }

  /** The sync folders to badge (one per running account). */
  setFolders(list: string[]): void {
    const next = [...new Set(list)].sort();
    if (next.length === this.folders.length && next.every((f, i) => f === this.folders[i])) return;
    this.folders = next;
    this.broadcast({ folders: next });
  }

  /** These items (absolute paths; null: everything) may show another badge now. */
  changed(paths: string[] | null): void {
    if (!this.clients.size) return;
    if (paths === null) this.changedAll = true;
    else if (!this.changedAll) for (const p of paths) this.changedPaths.add(p);
    if (!this.changedAll && this.changedPaths.size > 50_000) { this.changedAll = true; this.changedPaths.clear(); }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.broadcast({ changed: this.changedAll ? null : [...this.changedPaths] });
      this.changedAll = false;
      this.changedPaths.clear();
    }, BATCH_MS);
  }

  get connected(): number { return this.clients.size; }

  private accept(sock: net.Socket): void {
    sock.setEncoding('utf8');
    const deadline = setTimeout(() => { if (!this.clients.has(sock)) sock.destroy(); }, HELLO_MS); // no hello: gone
    let buffer = '';
    sock.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > (this.clients.has(sock) ? MAX_LINE : MAX_HELLO)) return sock.destroy();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.handle(sock, line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { clearTimeout(deadline); this.clients.delete(sock); });
    this.send(sock, { app: this.appProof });
  }

  private handle(sock: net.Socket, line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return void sock.destroy();
    }
    if (!this.clients.has(sock)) {
      // The first line proves the other side read finder.json (only this user can): the extension.
      const given = Buffer.from(typeof msg?.hello === 'string' ? msg.hello : '');
      const want = Buffer.from(this.secret);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return void sock.destroy();
      this.clients.add(sock);
      return this.send(sock, { folders: this.folders });
    }
    if (!Array.isArray(msg?.ask)) return;
    const badges: Record<string, string> = {};
    for (const p of msg.ask.slice(0, MAX_ASK)) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) continue;
      let b: Badge | null = null;
      try {
        b = this.badgeOf(p);
      } catch {
        // an account being removed meanwhile: no badge
      }
      badges[p] = b ?? '';
    }
    this.send(sock, { badges });
  }

  private broadcast(msg: object): void {
    for (const c of this.clients) this.send(c, msg);
  }

  private send(sock: net.Socket, msg: object): void {
    if (sock.destroyed) return;
    // An extension that stopped reading (hung, suspended) must not make this process keep its output forever.
    if (sock.writableLength > MAX_UNREAD) return void sock.destroy();
    sock.write(JSON.stringify(msg) + '\n');
  }
}
