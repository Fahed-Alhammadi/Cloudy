// Two-way sync between a local folder and a Cloudy folder (no Electron imports, so it runs under plain Node in tests).
//
// Each cycle compares three trees by relative path: the local folder, the server, and `base` (both sides as of the last
// successful sync). A side "changed" if it differs from base; one-sided changes are copied to the other side, changes on
// both sides keep both copies ("conflicted copy"). Deletions go to the server's trash or the computer's trash, never
// straight to oblivion. Renames are detected by inode (local) and node id (server) so moving a folder doesn't re-transfer it.
// The server listing is cached per folder and only re-read when the folder's etag changed (etags change up the tree).
import { readdir, lstat, mkdir, rename, rm, utimes } from 'node:fs/promises';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ApiError, type Api, type RemoteNode } from './api.ts';

/** What both sides looked like after the last sync (`size`/`mtime`/`ino` local, `id`/`etag`/`rmtime` server). */
export interface Entry { dir: boolean; id?: number; etag?: string; rmtime?: string; size: number; mtime: number; ino?: number }
interface Local { dir: boolean; size: number; mtime: number; ino: number }
interface Remote { dir: boolean; id: number; etag: string; size: number; mtime: string }
type Child = Pick<RemoteNode, 'id' | 'name' | 'isDir' | 'size' | 'etag' | 'mtime'>;

export interface SyncState {
  rootId: number;
  base: Record<string, Entry>;
  /** Server listings by folder path, valid while the folder's etag is unchanged. */
  folders: Record<string, { id: number; etag: string; children: Child[] }>;
}

export type Phase = 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'auth';
export interface Status { phase: Phase; done: number; total: number; current?: string; lastSync?: number; error?: string }
export type ActivityKind = 'uploaded' | 'downloaded' | 'deleted-local' | 'deleted-remote' | 'moved' | 'conflict' | 'folder';
export interface Activity { time: number; path: string; kind: ActivityKind }
export interface Problem { path: string; message: string }

export interface EngineOptions {
  api: Api;
  root: string;
  rootId: number;
  excluded?: string[];
  state?: SyncState | null;
  saveState(s: SyncState): Promise<void>;
  /** Moves a local file or folder to the computer's trash. */
  trash(file: string): Promise<void>;
  /** Asked before deleting many files at once (e.g. the server folder was emptied); false keeps them. */
  confirmDeletes?(count: number, where: 'local' | 'remote'): Promise<boolean>;
  /** Label in conflict file names, translated: "report (conflicted copy 2026-10-25 153000).pdf". */
  conflictLabel?: string;
  /** Problems are reported with these texts (translated by the app). */
  messages?: Partial<Record<MessageKey, string>>;
  platform?: NodeJS.Platform;
  /** Seconds between full checks when nothing else triggers a sync. */
  intervalSec?: number;
  live?: boolean;
}

type MessageKey = 'case' | 'windowsName' | 'spaces' | 'noParent' | 'locked' | 'badName';
const MESSAGES: Record<MessageKey, string> = {
  case: 'Another item has the same name with different upper/lower case',
  windowsName: 'The name is not allowed on Windows',
  badName: 'The name is not allowed',
  spaces: 'Names cannot start or end with a space',
  noParent: 'Its folder is not on the server yet',
  locked: 'The file is in use by another program',
};

/** Raised for problems that stop the whole cycle (as opposed to one file). */
export class SyncError extends Error {
  code: 'missing-folder' | 'remote-missing';
  constructor(code: SyncError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const IGNORED = /^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini|\.directory|Icon\r|~\$.*|\.~lock\..*#|.*\.swp|\.cloudy-tmp-.*)$/i;
const WINDOWS_BAD = /[<>:"|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MASS_DELETE = 100;
const PARALLEL = 4;

export const isIgnored = (name: string) => IGNORED.test(name);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const under = (p: string, dir: string) => p.startsWith(dir + '/');
const depth = (p: string) => p.split('/').length;
const sameFile = (l: Local | Entry, b: Local | Entry) => l.size === b.size && l.mtime === b.mtime;

function isNetworkError(e: any): boolean {
  const code = String(e?.cause?.code ?? e?.code ?? '');
  return (e instanceof TypeError && e.message === 'fetch failed') || code.startsWith('UND_ERR')
    || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code);
}

/** Signed out, or the server is failing: stops every worker of the cycle instead of failing file by file. */
const isFatal = (e: any) => (e instanceof ApiError && (e.status === 401 || e.status >= 500)) || isNetworkError(e);

export class SyncEngine extends EventEmitter {
  api: Api;
  root: string;
  rootId: number;
  excluded: string[];
  state: SyncState;
  status: Status = { phase: 'idle', done: 0, total: 0 };
  activity: Activity[] = [];
  problems: Problem[] = [];
  private o: EngineOptions;
  private platform: string;
  private caseInsensitive: boolean;
  private running = false;
  private again = false;
  private paused = false;
  private stopped = false;
  private signedOut = false;
  private inflight: Promise<void> | null = null;
  /**
   * Paths of this cycle that could not be read or are not allowed (unreadable folders, symlinks, bad names, case
   * duplicates). They are left alone on both sides: "missing from the scan" must never turn into "deleted".
   */
  private unknown = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private live: AbortController | null = null;
  private lastSave = 0;

  constructor(o: EngineOptions) {
    super();
    this.o = o;
    this.api = o.api;
    this.root = o.root;
    this.rootId = o.rootId;
    this.excluded = o.excluded ?? [];
    this.platform = o.platform ?? process.platform;
    this.caseInsensitive = this.platform === 'darwin' || this.platform === 'win32';
    this.state = o.state?.rootId === o.rootId ? o.state : { rootId: o.rootId, base: {}, folders: {} };
  }

  // ------------------------------------------------------------ lifecycle

  /** Starts watching the folder and the server's live events, and syncs now. */
  start(): void {
    this.stopped = false;
    this.signedOut = false;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_ev, file) => {
        const name = file ? path.basename(String(file)) : '';
        if (!name || !isIgnored(name)) this.schedule(1500);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      this.watcher = null; // the periodic check still runs
    }
    this.interval = setInterval(() => this.schedule(0), (this.o.intervalSec ?? (this.watcher ? 300 : 60)) * 1000);
    if (this.o.live !== false) void this.listen();
    this.schedule(0);
  }

  /** Stops watching and syncing; resolves once a running cycle has wound down (it saves nothing after this). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.live?.abort();
    await this.inflight?.catch(() => {});
  }

  pause(): void {
    this.paused = true;
    this.setStatus({ phase: 'paused', done: 0, total: 0, current: undefined });
  }

  resume(): void {
    this.paused = false;
    this.signedOut = false;
    this.setStatus({ phase: 'idle' });
    this.schedule(0);
  }

  get isPaused() { return this.paused; }

  schedule(ms = 1000): void {
    if (this.stopped || this.signedOut) return; // signed out: nothing works until a new sign-in restarts the engine
    if (this.running) { this.again = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, ms);
  }

  private async listen(): Promise<void> {
    let wait = 5000;
    while (!this.stopped) {
      this.live = new AbortController();
      const started = Date.now();
      try {
        await this.api.events(() => this.schedule(500), this.live.signal);
      } catch {
        if (this.stopped) return;
      }
      wait = Date.now() - started > 60_000 ? 5000 : Math.min(wait * 2, 120_000);
      await new Promise((r) => setTimeout(r, wait));
      this.schedule(0); // changes made while disconnected
    }
  }

  /** Runs sync cycles until nothing is left to do. Errors end up in `status`. */
  async sync(): Promise<void> {
    if (this.paused || this.running) { if (this.running) this.again = true; return; }
    this.running = true;
    let finish!: () => void;
    this.inflight = new Promise<void>((r) => { finish = r; });
    try {
      do {
        this.again = false;
        this.problems = [];
        for (let i = 0; i < 5 && !this.paused && !this.stopped && (await this.cycle()); i++);
        this.emit('problems', this.problems);
      } while (this.again && !this.paused && !this.stopped);
      if (!this.paused && !this.stopped) this.setStatus({ phase: 'idle', done: 0, total: 0, current: undefined, lastSync: Date.now(), error: undefined });
    } catch (e: any) {
      await this.save(true).catch(() => {});
      if (e instanceof ApiError && e.status === 401) { this.signedOut = true; this.setStatus({ phase: 'auth', current: undefined, error: e.message }); }
      else if (isNetworkError(e)) { this.setStatus({ phase: 'offline', current: undefined, error: e.message }); this.retryLater(); }
      else { this.setStatus({ phase: 'error', current: undefined, error: e?.message ?? String(e) }); this.retryLater(); }
    } finally {
      this.running = false;
      this.inflight = null;
      finish();
    }
  }

  private retryLater(): void {
    setTimeout(() => this.schedule(0), 30_000).unref?.();
  }

  private setStatus(s: Partial<Status>): void {
    this.status = { ...this.status, ...s };
    this.emit('status', this.status);
  }

  private log(p: string, kind: ActivityKind): void {
    const a = { time: Date.now(), path: p, kind };
    this.activity = [a, ...this.activity].slice(0, 100);
    this.emit('activity', a);
  }

  private problem(p: string, message: string): void {
    this.problems.push({ path: p, message });
  }

  private msg(k: MessageKey) { return this.o.messages?.[k] ?? MESSAGES[k]; }

  private async save(force = false): Promise<void> {
    if (this.stopped) return; // a replacement engine (new folder, new account) owns the state file now
    if (!force && Date.now() - this.lastSave < 5000) return;
    this.lastSave = Date.now();
    await this.o.saveState(this.state);
  }

  // ------------------------------------------------------------ selective sync

  isExcluded(p: string): boolean {
    return this.excluded.some((e) => p === e || under(p, e));
  }

  /** Changes which folders are synced. Newly excluded folders are removed from this computer (to the trash). */
  async setExcluded(list: string[]): Promise<void> {
    const added = list.filter((e) => !this.excluded.includes(e));
    this.excluded = list;
    for (const e of added) {
      if (!this.state.base[e]) continue;
      await this.o.trash(this.full(e)).catch(() => {});
      this.forget(e);
    }
    await this.save(true);
    this.schedule(0);
  }

  // ------------------------------------------------------------ one cycle

  full(p: string): string {
    return path.join(this.root, ...p.split('/'));
  }

  /** One pass; true when it moved things around and the trees should be read again. */
  async cycle(): Promise<boolean> {
    if (this.paused || this.stopped) return false;
    const rootStat = await lstat(this.root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new SyncError('missing-folder', `Folder not found: ${this.root}`);
    this.setStatus({ phase: 'syncing', done: 0, total: 0, current: undefined });
    this.unknown = new Set();
    const remote = await this.scanRemote();
    const local = await this.scanLocal();
    if (await this.applyMoves(local, remote)) { await this.save(true); return true; }
    const again = await this.reconcile(local, remote);
    await this.save(true);
    return again;
  }

  private isUnknown(p: string): boolean {
    for (const u of this.unknown) if (p === u || under(p, u)) return true;
    return false;
  }

  private checkName(name: string): string | null {
    // Never let a name (local or from the server) escape the sync folder or break a path.
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) return this.msg('badName');
    if (name !== name.trim()) return this.msg('spaces');
    if ((this.o.platform ?? process.platform) === 'win32' && WINDOWS_BAD.test(name)) return this.msg('windowsName');
    return null;
  }

  async scanRemote(): Promise<Map<string, Remote>> {
    const remote = new Map<string, Remote>();
    const folders: SyncState['folders'] = {};
    const old = this.state.folders;
    let root;
    try {
      root = await this.api.node(this.rootId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new SyncError('remote-missing', 'The server folder no longer exists');
      throw e;
    }
    const strip = (c: RemoteNode): Child => ({ id: c.id, name: c.name, isDir: c.isDir, size: c.size, etag: c.etag, mtime: c.mtime });

    const walk = async (rel: string, id: number, etag: string, prefetched?: RemoteNode[]) => {
      const cached = old[rel];
      let children: Child[];
      if (prefetched) children = prefetched.map(strip);
      else if (cached && cached.id === id && cached.etag === etag) children = cached.children;
      else {
        try {
          children = ((await this.api.node(id)).children ?? []).map(strip);
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) return; // removed while walking: next cycle
          throw e;
        }
      }
      folders[rel] = { id, etag, children };
      const seen = new Set<string>();
      for (const c of children) {
        const p = rel ? `${rel}/${c.name}` : c.name;
        if (isIgnored(c.name) || this.isExcluded(p)) continue;
        const bad = this.checkName(c.name);
        if (bad) { this.problem(p, bad); this.unknown.add(p); continue; }
        if (this.caseInsensitive) {
          // APFS/HFS+ also fold Unicode normalization: "é" composed and decomposed are the same file.
          const k = (this.platform === 'darwin' ? c.name.normalize('NFC') : c.name).toLowerCase();
          if (seen.has(k)) { this.problem(p, this.msg('case')); this.unknown.add(p); continue; }
          seen.add(k);
        }
        remote.set(p, { dir: c.isDir, id: c.id, etag: c.etag, size: c.size, mtime: c.mtime });
        if (c.isDir) await walk(p, c.id, c.etag);
      }
    };
    await walk('', this.rootId, root.node.etag, root.children ?? []);
    this.state.folders = folders;
    return remote;
  }

  async scanLocal(): Promise<Map<string, Local>> {
    const local = new Map<string, Local>();
    const walk = async (dir: string, rel: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e: any) {
        if (!rel) throw e;
        this.problem(rel, e.message);
        this.unknown.add(rel); // unreadable, not empty: nothing below it may be deleted on the server
        return;
      }
      for (const name of names) {
        const p = rel ? `${rel}/${name}` : name;
        if (/^\.cloudy-tmp-/i.test(name)) { await rm(path.join(dir, name), { force: true }).catch(() => {}); continue; } // left by a crash
        if (isIgnored(name) || this.isExcluded(p)) continue;
        const st = await lstat(path.join(dir, name)).catch(() => null);
        if (!st || !(st.isFile() || st.isDirectory())) { this.unknown.add(p); continue; } // symlinks and special files are left alone
        const bad = this.checkName(name);
        if (bad) { this.problem(p, bad); this.unknown.add(p); continue; }
        local.set(p, { dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: Math.floor(st.mtimeMs), ino: st.ino });
        if (st.isDirectory()) await walk(path.join(dir, name), p);
      }
    };
    await walk(this.root, '');
    return local;
  }

  private localChanged(l: Local, b: Entry | undefined): boolean {
    return !b || l.dir !== b.dir || (!l.dir && !sameFile(l, b));
  }

  private remoteChanged(r: Remote, b: Entry | undefined): boolean {
    return !b || r.dir !== b.dir || r.id !== b.id || (!r.dir && r.etag !== b.etag);
  }

  /** Renames base entries `from` (and below) to `to`. */
  private rebase(from: string, to: string): void {
    const base = this.state.base;
    for (const k of Object.keys(base)) {
      if (k === from || under(k, from)) {
        const e = base[k];
        delete base[k];
        base[to + k.slice(from.length)] = e;
      }
    }
  }

  private forget(p: string): void {
    for (const k of Object.keys(this.state.base)) if (k === p || under(k, p)) delete this.state.base[k];
  }

  private remoteId(rel: string, remote: Map<string, Remote>): number | undefined {
    if (!rel) return this.rootId;
    const r = remote.get(rel);
    return r?.dir ? r.id : this.state.base[rel]?.dir ? this.state.base[rel].id : undefined;
  }

  /** Server folder for `rel`, creating it (and its parents) when it only exists here. */
  private async ensureRemoteDir(rel: string, remote: Map<string, Remote>, local: Map<string, Local>): Promise<number | undefined> {
    const known = this.remoteId(rel, remote);
    if (known !== undefined) return known;
    if (!local.get(rel)?.dir || remote.has(rel)) return undefined;
    const parentId = await this.ensureRemoteDir(parentOf(rel), remote, local);
    if (parentId === undefined) return undefined;
    const d = await this.mkdirRemote(parentId, nameOf(rel));
    remote.set(rel, { dir: true, id: d.id, etag: d.etag, size: 0, mtime: d.mtime });
    this.state.base[rel] = { dir: true, id: d.id, size: 0, mtime: 0, ino: local.get(rel)!.ino };
    this.log(rel, 'folder');
    return d.id;
  }

  private async mkdirRemote(parentId: number, name: string): Promise<RemoteNode> {
    try {
      return await this.api.mkdir(parentId, name);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      const existing = (await this.api.node(parentId)).children?.find((c) => c.name === name && c.isDir);
      if (!existing) throw e;
      return existing;
    }
  }

  /** Detects renames/moves on either side and repeats them on the other one. True if anything moved. */
  async applyMoves(local: Map<string, Local>, remote: Map<string, Remote>): Promise<boolean> {
    const base = this.state.base;
    const byIno = new Map<number, string>();
    const byId = new Map<number, string>();
    for (const [p, b] of Object.entries(base)) {
      if (b.ino) byIno.set(b.ino, p);
      if (b.id) byId.set(b.id, p);
    }
    const moves: { from: string; to: string; side: 'remote' | 'local' }[] = [];
    for (const [p, l] of local) {
      if (base[p] || remote.has(p)) continue;
      const from = byIno.get(l.ino);
      if (!from || local.has(from)) continue;
      const b = base[from];
      const r = remote.get(from);
      if (b.dir !== l.dir || (!l.dir && !sameFile(l, b))) continue;
      if (!r || r.id !== b.id || (!r.dir && r.etag !== b.etag)) continue;
      moves.push({ from, to: p, side: 'remote' });
    }
    for (const [p, r] of remote) {
      if (base[p] || local.has(p)) continue;
      const from = byId.get(r.id);
      if (!from || remote.has(from)) continue;
      const b = base[from];
      const l = local.get(from);
      if (b.dir !== r.dir || (!r.dir && (r.size !== b.size || r.mtime !== b.rmtime))) continue; // moved and edited
      if (!l || l.dir !== b.dir || (!l.dir && !sameFile(l, b))) continue;
      moves.push({ from, to: p, side: 'local' });
    }
    moves.sort((a, b) => depth(a.from) - depth(b.from));
    const done: string[] = [];
    for (const m of moves) {
      if (done.some((d) => under(m.from, d))) continue; // moved along with its folder
      if (this.isUnknown(m.from) || this.isUnknown(m.to)) continue;
      try {
        if (m.side === 'remote') {
          const parentId = await this.ensureRemoteDir(parentOf(m.to), remote, local);
          if (parentId === undefined) continue;
          const moved = await this.api.move(base[m.from].id!, parentId, nameOf(m.to));
          this.rebase(m.from, m.to);
          if (!moved.isDir) Object.assign(base[m.to], { etag: moved.etag, rmtime: moved.mtime });
        } else {
          // Something already at the destination (a new local file, or the same name in another case on macOS/
          // Windows) must not be overwritten: reconcile downloads the moved file and keeps both.
          if (await lstat(this.full(m.to)).catch(() => null)) continue;
          await mkdir(this.full(parentOf(m.to)), { recursive: true });
          await rename(this.full(m.from), this.full(m.to));
          const r = remote.get(m.to)!;
          this.rebase(m.from, m.to);
          if (!r.dir) Object.assign(base[m.to], { etag: r.etag, rmtime: r.mtime });
        }
        done.push(m.from);
        this.log(m.to, 'moved');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw e;
        if (isNetworkError(e)) throw e;
        this.problem(m.to, (e as Error).message);
      }
    }
    return done.length > 0;
  }

  /** Works out and carries out what each path needs. True if another pass is needed (conflicts renamed). */
  async reconcile(local: Map<string, Local>, remote: Map<string, Remote>): Promise<boolean> {
    const base = this.state.base;
    const keys = [...new Set([...Object.keys(base), ...local.keys(), ...remote.keys()])].sort();
    type Op = 'mkdirRemote' | 'mkdirLocal' | 'record' | 'upload' | 'download' | 'compare' | 'conflict' | 'deleteRemote' | 'deleteLocal' | 'forget';
    const ops: { op: Op; p: string }[] = [];
    const wholeDir: string[] = []; // folders deleted as a whole: skip what's inside

    const localTreeChanged = (dir: string) => [...local].some(([k, l]) => under(k, dir) && this.localChanged(l, base[k]));
    const remoteTreeChanged = (dir: string) => [...remote].some(([k, r]) => under(k, dir) && this.remoteChanged(r, base[k]));

    for (const p of keys) {
      if (wholeDir.some((d) => under(p, d))) continue;
      if (this.isUnknown(p)) continue;
      const l = local.get(p);
      const r = remote.get(p);
      const b = base[p];
      if (!l && !r) { if (b) ops.push({ op: 'forget', p }); continue; }
      if (l && !r) {
        if (!b) ops.push({ op: l.dir ? 'mkdirRemote' : 'upload', p });
        else if (l.dir) {
          if (localTreeChanged(p)) ops.push({ op: 'mkdirRemote', p });
          else { ops.push({ op: 'deleteLocal', p }); wholeDir.push(p); }
        } else ops.push({ op: this.localChanged(l, b) ? 'upload' : 'deleteLocal', p });
        continue;
      }
      if (!l && r) {
        if (!b) ops.push({ op: r.dir ? 'mkdirLocal' : 'download', p });
        else if (r.dir) {
          if (remoteTreeChanged(p)) ops.push({ op: 'mkdirLocal', p });
          else { ops.push({ op: 'deleteRemote', p }); wholeDir.push(p); }
        } else ops.push({ op: this.remoteChanged(r, b) ? 'download' : 'deleteRemote', p });
        continue;
      }
      // on both sides
      if (l!.dir && r!.dir) { if (!b || b.id !== r!.id || b.ino !== l!.ino) ops.push({ op: 'record', p }); continue; }
      if (l!.dir !== r!.dir) { ops.push({ op: 'conflict', p }); wholeDir.push(p); continue; }
      const lc = this.localChanged(l!, b);
      const rc = this.remoteChanged(r!, b);
      if (!b || (lc && rc)) ops.push({ op: l!.size === r!.size ? 'compare' : 'conflict', p });
      else if (lc) ops.push({ op: 'upload', p });
      else if (rc) ops.push({ op: 'download', p });
    }

    // Many deletions at once usually mean something went wrong (a drive not mounted, a folder emptied by mistake).
    for (const where of ['local', 'remote'] as const) {
      const op = where === 'local' ? 'deleteLocal' : 'deleteRemote';
      const del = ops.filter((o) => o.op === op);
      const files = del.reduce((n, o) => n + Object.keys(base).filter((k) => (k === o.p || under(k, o.p)) && !base[k].dir).length, 0);
      const total = Object.values(base).filter((e) => !e.dir).length;
      // Ask for ≥ 100 files, and for a small account losing every one of its files.
      const suspicious = files >= MASS_DELETE || (files === total && total >= 10);
      if (suspicious && files >= total / 2 && this.o.confirmDeletes && !(await this.o.confirmDeletes(files, where))) {
        // Keep them: forgetting the base makes the files "new" on the side that still has them, so they are copied back.
        for (const o of del) { this.forget(o.p); o.op = 'forget'; }
      }
    }

    const work = ops.filter((o) => o.op !== 'forget');
    for (const o of ops) if (o.op === 'forget') this.forget(o.p);
    let done = 0;
    let again = false;
    let fatal: unknown = null; // signed out / offline: stop every worker
    this.setStatus({ phase: 'syncing', done, total: work.length });
    const run = async (o: { op: Op; p: string }) => {
      if (this.paused || this.stopped || fatal) return;
      this.setStatus({ current: o.p });
      try {
        if (await this.execute(o.op, o.p, local.get(o.p), remote.get(o.p), remote, local)) again = true;
      } catch (e: any) {
        if (isFatal(e)) { fatal ??= e; return; }
        this.problem(o.p, e?.code === 'EBUSY' || e?.code === 'EPERM' ? this.msg('locked') : e?.message ?? String(e));
      }
      this.setStatus({ done: ++done });
      await this.save();
    };
    const phase = (names: Op[]) => work.filter((o) => names.includes(o.op));
    for (const o of phase(['mkdirRemote', 'mkdirLocal', 'record'])) await run(o);
    const queue = phase(['upload', 'download', 'compare', 'conflict']);
    await Promise.all(Array.from({ length: PARALLEL }, async () => { for (let o; (o = queue.shift()); ) await run(o); }));
    for (const o of phase(['deleteRemote', 'deleteLocal'])) await run(o);
    if (fatal) throw fatal;
    return again;
  }

  private conflictName(p: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const name = nameOf(p);
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const out = `${stem} (${this.o.conflictLabel ?? 'conflicted copy'} ${stamp})${ext}`;
    return parentOf(p) ? `${parentOf(p)}/${out}` : out;
  }

  private tmpFor(p: string): string {
    return path.join(path.dirname(this.full(p)), `.cloudy-tmp-${randomBytes(6).toString('hex')}`);
  }

  private async record(p: string, r: Remote): Promise<void> {
    const st = await lstat(this.full(p));
    this.state.base[p] = r.dir
      ? { dir: true, id: r.id, size: 0, mtime: 0, ino: st.ino }
      : { dir: false, id: r.id, etag: r.etag, rmtime: r.mtime, size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino };
  }

  /** Downloads `r` into a temp file next to `p`, dated like on the server. */
  private async fetchTemp(p: string, r: Remote): Promise<string> {
    const tmp = this.tmpFor(p);
    try {
      await this.api.download(r.id, tmp);
      const t = new Date(r.mtime);
      if (!Number.isNaN(t.getTime())) await utimes(tmp, t, t);
      return tmp;
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Puts a downloaded temp file at `p`. A local file there that changed since the scan is kept as a conflicted copy. */
  private async place(p: string, tmp: string, scanned: Local | undefined): Promise<boolean> {
    const dest = this.full(p);
    const now = await lstat(dest).catch(() => null);
    let kept = false;
    if (now && (!scanned || !now.isFile() || now.size !== scanned.size || Math.floor(now.mtimeMs) !== scanned.mtime)) {
      await rename(dest, this.full(this.conflictName(p)));
      this.log(p, 'conflict');
      kept = true;
    }
    await rename(tmp, dest);
    return kept;
  }

  private async execute(op: string, p: string, l: Local | undefined, r: Remote | undefined,
    remote: Map<string, Remote>, local: Map<string, Local>): Promise<boolean> {
    const base = this.state.base;
    switch (op) {
      case 'record':
        await this.record(p, r!);
        return false;

      case 'mkdirLocal':
        await mkdir(this.full(p), { recursive: true });
        await this.record(p, r!);
        this.log(p, 'folder');
        return false;

      case 'mkdirRemote': {
        if (!(await this.ensureRemoteDir(p, remote, local))) this.problem(p, this.msg('noParent'));
        return false;
      }

      case 'upload': {
        const parentId = this.remoteId(parentOf(p), remote);
        if (parentId === undefined) { this.problem(p, this.msg('noParent')); return false; }
        const before = await lstat(this.full(p));
        if (!before.isFile()) return false;
        const up = await this.api.upload(parentId, nameOf(p), this.full(p), before.size);
        const n = (await this.api.node(up.id)).node;
        // The size/mtime from before the upload: if the file changed meanwhile, the next pass uploads it again.
        base[p] = { dir: false, id: n.id, etag: n.etag, rmtime: n.mtime, size: before.size, mtime: Math.floor(before.mtimeMs), ino: before.ino };
        this.log(p, 'uploaded');
        return false;
      }

      case 'download': {
        await mkdir(path.dirname(this.full(p)), { recursive: true });
        const tmp = await this.fetchTemp(p, r!);
        try {
          const kept = await this.place(p, tmp, l);
          await this.record(p, r!);
          this.log(p, 'downloaded');
          return kept;
        } finally {
          await rm(tmp, { force: true });
        }
      }

      case 'compare': {
        // Same size on both sides but no shared history (first sync) or both edited: compare the bytes.
        const tmp = await this.fetchTemp(p, r!);
        try {
          if ((await hashFile(tmp)) === (await hashFile(this.full(p)))) {
            await this.record(p, r!);
            return false;
          }
          await rename(this.full(p), this.full(this.conflictName(p)));
          await rename(tmp, this.full(p));
          await this.record(p, r!);
          this.log(p, 'conflict');
          return true;
        } finally {
          await rm(tmp, { force: true });
        }
      }

      case 'conflict': {
        // Changed on both sides (or a file on one side and a folder on the other): keep ours under a new name.
        await rename(this.full(p), this.full(this.conflictName(p)));
        this.forget(p);
        this.log(p, 'conflict');
        if (r && !r.dir) {
          const tmp = await this.fetchTemp(p, r);
          try {
            await rename(tmp, this.full(p));
            await this.record(p, r);
          } finally {
            await rm(tmp, { force: true });
          }
        }
        return true;
      }

      case 'deleteRemote': {
        try {
          await this.api.trash(base[p].id!);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        this.forget(p);
        this.log(p, 'deleted-remote');
        return false;
      }

      case 'deleteLocal': {
        const now = await lstat(this.full(p)).catch(() => null);
        if (now && !now.isDirectory() && (now.size !== l!.size || Math.floor(now.mtimeMs) !== l!.mtime)) return true; // edited meanwhile
        if (now) await this.o.trash(this.full(p));
        this.forget(p);
        this.log(p, 'deleted-local');
        return false;
      }
    }
    return false;
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}
