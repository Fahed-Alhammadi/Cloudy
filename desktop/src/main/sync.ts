// Two-way sync between a local folder and a Cloudy folder (no Electron imports, so it runs under plain Node in tests).
//
// Each cycle compares three trees by relative path: the local folder, the server, and `base` (both sides as of the last
// successful sync). A side "changed" if it differs from base; one-sided changes are copied to the other side, changes on
// both sides keep both copies ("conflicted copy"). Deletions go to the server's trash or the computer's trash, never
// straight to oblivion. Renames are detected by inode (local) and node id (server) so moving a folder doesn't re-transfer it.
//
// Keeping it cheap on large folders:
// - The server listing is cached per folder and only re-read when the folder's etag changed (etags change up the tree);
//   changed folders are read in parallel.
// - The local listing is cached per folder too. While the folder watcher works, a cycle only re-reads the folders it
//   reported (and the ones this engine wrote to); a full scan still runs at start, every few minutes and whenever the
//   watcher is not trusted. Without a watcher every cycle is a full scan.
// - Events caused by this engine's own writes (downloads, new folders, deletions) do not start another cycle.
// - Work over the whole tree is done once per cycle (sets of changed folders, file counts), never once per item.
// - The state file is only written when something in it changed.
import { readdir, lstat, mkdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, watch, lstat as lstatCb, type FSWatcher, type Stats } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ApiError, isNetworkError, type Api, type RemoteNode } from './api.ts';

/**
 * What both sides looked like after the last sync (`size`/`mtime`/`ino` local, `id`/`etag`/`rmtime` server).
 * `lname`: the name on this computer when it differs from the server's only by case or Unicode form (see scanLocal).
 */
export interface Entry { dir: boolean; id?: number; etag?: string; rmtime?: string; size: number; mtime: number; ino?: number; lname?: string }
/** `name`: the name as it is on disk (the map key uses the server's spelling when the filesystem treats both as one). */
interface Local { dir: boolean; size: number; mtime: number; ino: number; name: string }
/** `sha256`: content hash from servers that have it (1.16+); lets a first sync compare files without downloading them. */
interface Remote { dir: boolean; id: number; etag: string; size: number; mtime: string; sha256?: string }
type Child = Pick<RemoteNode, 'id' | 'name' | 'isDir' | 'size' | 'etag' | 'mtime'> & { sha256?: string };

export interface SyncState {
  rootId: number;
  /** The local folder this state belongs to: a state from another folder is never applied to this one. */
  root?: string;
  base: Record<string, Entry>;
  /** Server listings by folder path, valid while the folder's etag is unchanged. */
  folders: Record<string, { id: number; etag: string; children: Child[] }>;
}

export type Phase = 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'auth';
/** `code`: set for problems that stop the whole cycle (SyncError codes), so the app can explain them. */
export interface Status { phase: Phase; done: number; total: number; current?: string; lastSync?: number; error?: string; code?: string }
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
  /** Clock for conflict names (tests). */
  now?: () => Date;
  /** Seconds between full checks when nothing else triggers a sync. */
  intervalSec?: number;
  live?: boolean;
}

type MessageKey = 'case' | 'windowsName' | 'spaces' | 'noParent' | 'locked' | 'badName' | 'incomplete' | 'outside';
const MESSAGES: Record<MessageKey, string> = {
  case: 'Another item has the same name with different upper/lower case',
  windowsName: 'The name is not allowed on Windows',
  badName: 'The name is not allowed',
  spaces: 'Names cannot start or end with a space',
  noParent: 'Its folder is not on the server yet',
  locked: 'The file is in use by another program',
  incomplete: 'The download was incomplete. It is tried again.',
  outside: 'Its folder links to a place outside the sync folder',
};

/** Raised for problems that stop the whole cycle (as opposed to one file). */
export class SyncError extends Error {
  code: 'missing-folder' | 'remote-missing';
  constructor(code: SyncError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Is a saved state still about this server's files? Used before reusing it after signing in again. Node ids are only
 * unique within one database: after a server reset (`docker compose down -v`, a restored backup) a recreated account
 * gets the same root id and new files reuse old ids, and a stale base would then read as moves and deletions on the
 * server. The top-level listing from the state is compared with the server's: an id never changes between file and
 * folder, and most top-level items keep their id, name (and, for files, etag) across a sign-in. When in doubt the
 * answer is false; starting over is always safe (files are compared, nothing is deleted).
 */
export async function stateFitsServer(api: Pick<Api, 'node'>, state: SyncState | null): Promise<boolean> {
  if (!state?.base || !Object.keys(state.base).length) return true; // nothing that could be misread
  const cached = state.folders?.[''];
  if (!cached || cached.id !== state.rootId) return false;
  if (!cached.children.length) return true;
  const root = await api.node(state.rootId);
  const now = new Map((root.children ?? []).map((c) => [c.id, c]));
  let same = 0;
  for (const c of cached.children) {
    const n = now.get(c.id);
    if (!n) continue;
    if (n.isDir !== c.isDir) return false;
    if (n.name === c.name && (c.isDir || n.etag === c.etag)) same++;
  }
  return same > 0 && same * 2 >= cached.children.filter((c) => now.has(c.id)).length;
}

/**
 * The state as stored on disk (version 2): base entries and server listings as arrays instead of objects with the same
 * keys repeated for every file, about half the size. `unpackState` also reads the older object form.
 */
type PackedEntry = [dir: 0 | 1, id: number | null, etag: string | null, rmtime: string | null, size: number, mtime: number, ino: number | null, lname?: string];
type PackedChild = [id: number, name: string, isDir: 0 | 1, size: number, etag: string, mtime: string, sha256?: string];
export interface PackedState { v: 2; rootId: number; root?: string; base: Record<string, PackedEntry>; folders: Record<string, [id: number, etag: string, children: PackedChild[]]> }

export function packState(s: SyncState): PackedState {
  const base: Record<string, PackedEntry> = {};
  for (const [k, e] of Object.entries(s.base)) {
    const row: PackedEntry = [e.dir ? 1 : 0, e.id ?? null, e.etag ?? null, e.rmtime ?? null, e.size, e.mtime, e.ino ?? null];
    if (e.lname) row.push(e.lname);
    base[k] = row;
  }
  const folders: PackedState['folders'] = {};
  for (const [k, f] of Object.entries(s.folders)) {
    folders[k] = [f.id, f.etag, f.children.map((c) => {
      const row: PackedChild = [c.id, c.name, c.isDir ? 1 : 0, c.size, c.etag, c.mtime];
      if (c.sha256) row.push(c.sha256);
      return row;
    })];
  }
  return { v: 2, rootId: s.rootId, root: s.root, base, folders };
}

export function unpackState(raw: any): SyncState | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== 2) return raw as SyncState; // version 1: stored as it is in memory
  const isObj = (o: unknown) => !!o && typeof o === 'object' && !Array.isArray(o);
  if (!isObj(raw.base) || !isObj(raw.folders)) return null;
  try {
    const base: Record<string, Entry> = {};
    for (const [k, r] of Object.entries(raw.base as Record<string, PackedEntry>)) {
      const e: Entry = { dir: r[0] === 1, size: r[4], mtime: r[5] };
      if (r[1] !== null) e.id = r[1];
      if (r[2] !== null) e.etag = r[2];
      if (r[3] !== null) e.rmtime = r[3];
      if (r[6] !== null) e.ino = r[6];
      if (r[7]) e.lname = r[7];
      base[k] = e;
    }
    const folders: SyncState['folders'] = {};
    for (const [k, [id, etag, children]] of Object.entries(raw.folders as PackedState['folders'])) {
      folders[k] = { id, etag, children: children.map((c) => {
        const child: Child = { id: c[0], name: c[1], isDir: c[2] === 1, size: c[3], etag: c[4], mtime: c[5] };
        if (c[6]) child.sha256 = c[6];
        return child;
      }) };
    }
    return { rootId: raw.rootId, root: raw.root, base, folders };
  } catch {
    return null; // damaged: start over (always safe, nothing is deleted)
  }
}

const IGNORED = /^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini|\.directory|Icon\r|~\$.*|\.~lock\..*#|.*\.swp|\.cloudy-tmp-.*)$/i;
const WINDOWS_BAD = /[<>:"|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const MASS_DELETE = 100;
/** Downloads/uploads at once. */
const TRANSFERS = 6;
/** Server requests at once for listings, new folders and deletions (small, latency-bound requests). */
const REQUESTS = 8;
/** Local folders read at once (each folder's entries are lstat'ed in parallel). */
const SCAN_DIRS = 16;
/** During a long cycle the state is saved at most this often (and always at the end of a cycle, when it changed). */
const SAVE_EVERY = 10_000;
/** How long after its own write an event for that path is checked against what was written (see isEcho). */
const ECHO_MS = 5000;

export const isIgnored = (name: string) => IGNORED.test(name);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const under = (p: string, dir: string) => p.length > dir.length && p.startsWith(dir) && p[dir.length] === '/';
const depth = (p: string) => p.split('/').length;
const sameFile = (l: Local | Entry, b: Local | Entry) => l.size === b.size && l.mtime === b.mtime;
/** Is one of `p`'s folders (not `p` itself) in `set`? O(depth). */
const ancestorIn = (set: Set<string>, p: string) => {
  if (!set.size) return false;
  for (let d = parentOf(p); d; d = parentOf(d)) if (set.has(d)) return true;
  return false;
};
/** Adds every folder above `p` to `set` (stops at the first one already there: its parents are there too). */
const addAncestors = (set: Set<string>, p: string) => {
  for (let d = parentOf(p); d && !set.has(d); d = parentOf(d)) set.add(d);
};

/**
 * Signed out, or the server is failing: stops every worker of the cycle instead of failing file by file. "Storage
 * full" (507) is about one upload: downloads, moves and deletes still go on.
 */
const isFatal = (e: any) => (e instanceof ApiError && (e.status === 401 || (e.status >= 500 && e.status !== 507))) || isNetworkError(e);

/**
 * A folder's entries as last read from disk: `null` = vanished while reading, 'other' = symlink or special file.
 * `ino`: the folder's own inode. A path can name another folder later (two folders swapped by renames, a folder deleted
 * and created again) without anything inside reporting a change: a listing is reused only for the same inode.
 */
interface Listing { full: string; ino: number; names: string[]; stats: (Local | 'other' | null)[] }
/** What a path looked like right after this engine wrote it: null = not there. */
type Snap = { dir: boolean; size: number; mtime: number } | null;
interface SelfWrite { busy: number; until: number; snap?: Snap }

const snapOf = (st: Stats | null): Snap => (st ? { dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.isDirectory() ? 0 : Math.floor(st.mtimeMs) } : null);
const sameSnap = (a: Snap, b: Snap | undefined) => (a === null || b === null || b === undefined ? a === b : a.dir === b.dir && a.size === b.size && a.mtime === b.mtime);

/**
 * lstat of the names in `dir`, up to 1024 at a time (callbacks: far less overhead per entry than fs/promises; the
 * bound keeps a folder with 100k entries from queueing them all at once).
 */
function lstatAll(dir: string, names: string[]): Promise<(Local | 'other' | null)[]> {
  return new Promise((resolve) => {
    const out: (Local | 'other' | null)[] = new Array(names.length).fill(null);
    let next = 0;
    let left = names.length;
    if (!left) return resolve(out);
    const start = () => {
      const i = next++;
      const name = names[i];
      lstatCb(path.join(dir, name), (err, st) => {
        if (!err) {
          out[i] = st.isFile() || st.isDirectory()
            ? { dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: Math.floor(st.mtimeMs), ino: st.ino, name }
            : 'other';
        }
        if (--left === 0) resolve(out);
        else if (next < names.length) start();
      });
    };
    for (let k = 0; k < 1024 && next < names.length; k++) start();
  });
}

/**
 * Runs `work` over `items` with at most `limit` at once; `work` may add more items. On the first error nothing new
 * starts, and it rejects once the running ones have ended (so none of them touches the next cycle's data).
 */
function drain<T>(items: T[], limit: number, work: (item: T, push: (t: T) => void) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let active = 0;
    let error: { e: unknown } | null = null;
    const pump = () => {
      while (!error && active < limit && items.length) {
        const item = items.pop()!;
        active++;
        work(item, push).then(() => { active--; pump(); }, (e) => { error ??= { e }; active--; pump(); });
      }
      if (!active && (error || !items.length)) {
        if (error) reject(error.e);
        else resolve();
      }
    };
    const push = (t: T) => { items.push(t); };
    pump();
  });
}

/** Runs `work` over `items` in order with at most `limit` at once (errors are handled by `work`). */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await work(items[i++]); }));
}

export class SyncEngine extends EventEmitter {
  api: Api;
  root: string;
  rootId: number;
  excluded: string[];
  state: SyncState;
  status: Status = { phase: 'idle', done: 0, total: 0 };
  activity: Activity[] = [];
  problems: Problem[] = [];
  /** The last local scan: whether it read every folder, how many folders it read from disk and how many it went through. */
  lastScan = { full: true, read: 0, dirs: 0 };
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
   * Stored folded (see foldPath).
   */
  private unknown = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  /** Linux: one watcher per folder (Node's recursive watch walks the whole tree synchronously and fails badly at the inotify limit). */
  private dirWatchers = new Map<string, { w: FSWatcher; ino: number }>();
  /** The watcher works: cycles started by its events may re-read only the folders it reported. */
  private watching = false;
  private live: AbortController | null = null;
  /** Aborted by stop() and pause(): running downloads and uploads end at once instead of finishing first. */
  private abort = new AbortController();
  /** Newly excluded folders, removed from this computer at the start of the next cycle (see setExcluded). */
  private pendingRemove: string[] = [];
  /** How the sync folder's filesystem compares names (probed on the first cycle; null = not yet). */
  private fold: { caseFold: boolean; normFold: boolean } | null = null;
  /** Server names per folder path, by folded name: lets the local scan use the server's spelling for the same file. */
  private remoteNames = new Map<string, Map<string, string>>();
  private lastSave = 0;
  /** Something in `state` changed since the last save. */
  private stateDirty: boolean;
  private rootReal: string | null = null;
  /** Local listings by folded path (see foldPath), from the last scan. */
  private dirCache = new Map<string, Listing>();
  /** Folders (folded paths) whose listing must be read again; filled by the watcher and by this engine's own writes. */
  private dirtyDirs = new Set<string>();
  /** The next scan reads every folder. */
  private fullScan = true;
  /** Paths (folded) this engine is writing or just wrote: their watcher events are its own (see isEcho). */
  private selfWrites = new Map<string, SelfWrite>();
  /** Folders forgotten this cycle whose entries below are removed from base in one pass (see flushForget). */
  private pendingForget = new Set<string>();
  /** Base by inode and by folded path, built once per cycle for localTreeUnchanged. */
  private baseIndex: { byIno: Map<number, string>; byPath: Map<string, string> } | null = null;
  /** Names in local folders by folded name, for diskName (one readdir per folder per cycle). */
  private dirNames = new Map<string, Map<string, string>>();
  /** `excluded` as of the start of the running cycle (see isExcluded). */
  private cycleExcluded: string[] | null = null;

  constructor(o: EngineOptions) {
    super();
    this.o = o;
    this.api = o.api;
    this.root = o.root;
    this.rootId = o.rootId;
    this.excluded = o.excluded ?? [];
    this.platform = o.platform ?? process.platform;
    this.caseInsensitive = this.platform === 'darwin' || this.platform === 'win32';
    // A state for another account or folder, or one that is damaged, is not used: an empty base is always safe
    // (nothing is deleted; files on both sides are compared).
    const st = o.state;
    const usable = st && st.rootId === o.rootId && (!st.root || st.root === o.root)
      && st.base && typeof st.base === 'object' && st.folders && typeof st.folders === 'object';
    this.state = usable ? st : { rootId: o.rootId, root: o.root, base: {}, folders: {} };
    this.stateDirty = !usable || st.root !== o.root;
    this.state.root = o.root;
  }

  // ------------------------------------------------------------ lifecycle

  /** Starts watching the folder and the server's live events, and syncs now. */
  start(): void {
    this.stopped = false;
    this.signedOut = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.fullScan = true;
    this.watching = this.startWatching();
    this.resetInterval();
    if (this.o.live !== false) void this.listen();
    this.schedule(0);
  }

  /** Full checks on a timer: every 5 minutes as a safety net while the watcher works, every minute without it. */
  private resetInterval(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => { this.fullScan = true; this.schedule(0); }, (this.o.intervalSec ?? (this.watching ? 300 : 60)) * 1000);
  }

  private get perFolderWatch() { return process.platform === 'linux'; }

  private startWatching(): boolean {
    if (this.perFolderWatch) return true; // added by the scan, before each folder is read (watchDir)
    try {
      this.watcher = watch(this.root, { recursive: true }, (_ev, file) => this.onFsEvent(file == null ? null : String(file)));
      this.watcher.on('error', () => this.watcherFailed());
      return true;
    } catch {
      this.watcher = null; // the periodic check still runs
      return false;
    }
  }

  private closeWatchers(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const { w } of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
  }

  /**
   * The folder watcher stopped working (an error, or Linux's inotify limit, ENOSPC): from now on every cycle reads the
   * whole folder and the timer checks every minute. Also called by the app for watcher errors that Node throws
   * outside of the watcher's 'error' event.
   */
  watcherFailed(): void {
    if (!this.watching) return;
    this.closeWatchers();
    this.watching = false;
    this.fullScan = true;
    if (this.stopped) return;
    this.resetInterval();
    this.schedule(0);
  }

  /** `rel`: the changed path on disk, relative to the root (null: unknown, read everything). */
  private onFsEvent(rel: string | null): void {
    if (this.stopped) return;
    if (rel === null) { this.fullScan = true; this.schedule(1500); return; }
    if (path.sep !== '/') rel = rel.split(path.sep).join('/');
    if (!rel || isIgnored(nameOf(rel))) return;
    const f = this.foldPath(rel);
    this.dirtyDirs.add(parentOf(f));
    this.dirtyDirs.add(f); // a folder of its own: read it too (it is new, or something in it changed)
    this.isEcho(rel, f).then((echo) => { if (!echo) this.schedule(1500); }, () => this.schedule(1500));
  }

  /**
   * True if this event is about a write of this engine: the path is being written, or it still looks exactly like
   * right after the write. Anything else (the user edited the file meanwhile) starts a cycle as usual.
   */
  private async isEcho(rel: string, folded: string): Promise<boolean> {
    const w = this.selfWrites.get(folded);
    if (!w) return false;
    if (w.busy) return true;
    if (Date.now() > w.until) { this.selfWrites.delete(folded); return false; }
    return sameSnap(snapOf(await lstat(this.full(rel)).catch(() => null)), w.snap);
  }

  /** Marks local paths this engine is about to write (and their folders). */
  private beginWrite(paths: string[]): string[] {
    const keys = [...new Set(paths.flatMap((p) => [p, parentOf(p)]).map((p) => this.foldPath(p)))];
    for (const k of keys) {
      const w = this.selfWrites.get(k);
      if (w) { w.busy++; w.until = Infinity; } else this.selfWrites.set(k, { busy: 1, until: Infinity });
    }
    return keys;
  }

  /** After a write: its folders are read again by the next scan, and their state is remembered for isEcho. */
  private async endWrite(keys: string[]): Promise<void> {
    for (const k of keys) this.dirtyDirs.add(k);
    await Promise.all(keys.map(async (k) => {
      const w = this.selfWrites.get(k);
      if (!w || --w.busy > 0) return;
      const st = await lstat(this.full(k)).catch(() => null);
      w.snap = snapOf(st);
      if (!w.busy) w.until = Date.now() + ECHO_MS;
      // Linux: a folder this engine just created needs its own watcher now, not after the next scan (the user may
      // edit in it before then, and its own writes start no cycle).
      if (st?.isDirectory() && this.perFolderWatch && this.watching) this.watchDir(this.full(k), k, st.ino);
    }));
  }

  /**
   * Stops watching and syncing; running transfers are aborted. Resolves once a running cycle has wound down; after
   * that the engine saves nothing, unless `save` (quitting the app: keep what this cycle finished), once, here.
   */
  async stop(opts: { save?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.closeWatchers();
    this.watching = false;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.live?.abort();
    this.abort.abort();
    await this.inflight?.catch(() => {});
    if (opts.save && this.stateDirty) {
      this.flushForget();
      await this.o.saveState(this.state).catch(() => {});
    }
  }

  /** Pauses syncing; a running download or upload is aborted (it starts over on resume). */
  pause(): void {
    this.paused = true;
    this.abort.abort();
    this.setStatus({ phase: 'paused', done: 0, total: 0, current: undefined });
  }

  resume(): void {
    this.paused = false;
    this.signedOut = false;
    this.fullScan = true;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.setStatus({ phase: 'idle' });
    this.schedule(0);
  }

  get isPaused() { return this.paused; }

  /** Syncs soon, reading every local folder (waking from sleep, "Sync now"): nothing that the watcher missed stays unseen. */
  rescan(ms = 0): void {
    this.fullScan = true;
    this.schedule(ms);
  }

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
      if (!this.paused && !this.stopped) this.setStatus({ phase: 'idle', done: 0, total: 0, current: undefined, lastSync: Date.now(), error: undefined, code: undefined });
    } catch (e: any) {
      this.fullScan = true; // whatever this cycle had read is not trusted
      await this.save(true).catch(() => {});
      if (this.stopped || this.paused) return; // aborted on purpose
      const msg = e?.message ?? String(e);
      if (e instanceof ApiError && e.status === 401) { this.signedOut = true; this.setStatus({ phase: 'auth', current: undefined, error: msg, code: undefined }); }
      else if (isNetworkError(e)) { this.setStatus({ phase: 'offline', current: undefined, error: msg, code: undefined }); this.retryLater(); }
      else { this.setStatus({ phase: 'error', current: undefined, error: msg, code: e instanceof SyncError ? e.code : undefined }); this.retryLater(); }
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
    if (!this.stateDirty) return;
    if (!force && Date.now() - this.lastSave < SAVE_EVERY) return;
    this.flushForget();
    this.stateDirty = false;
    this.lastSave = Date.now();
    try {
      await this.o.saveState(this.state);
    } catch (e) {
      this.stateDirty = true;
      throw e;
    }
  }

  // ------------------------------------------------------------ base changes (all of them mark the state dirty)

  private setBase(p: string, e: Entry): void {
    this.state.base[p] = e;
    this.stateDirty = true;
  }

  /** Renames base entries `from` (and below) to `to`. */
  private rebase(from: string, to: string): void {
    const base = this.state.base;
    this.stateDirty = true;
    const e = base[from];
    if (e && !e.dir) { delete base[from]; base[to] = e; return; } // a file: nothing below it (many files moved at once)
    for (const k of Object.keys(base)) {
      if (k === from || under(k, from)) {
        const v = base[k];
        delete base[k];
        base[to + k.slice(from.length)] = v;
      }
    }
  }

  /** Removes `p` from base; the entries below a folder go in one pass over base later (flushForget), not one per folder. */
  private forget(p: string): void {
    const base = this.state.base;
    const wasFile = base[p]?.dir === false;
    if (p in base) { delete base[p]; this.stateDirty = true; }
    if (!wasFile) this.pendingForget.add(p);
  }

  private flushForget(): void {
    if (!this.pendingForget.size) return;
    const base = this.state.base;
    for (const k of Object.keys(base)) if (ancestorIn(this.pendingForget, k)) { delete base[k]; this.stateDirty = true; }
    this.pendingForget.clear();
  }

  // ------------------------------------------------------------ selective sync

  /**
   * Excluded as of the start of this cycle: the server walk and the local scan must agree (a folder unticked between
   * them would otherwise be on the server but "deleted here", and go to the server trash).
   */
  isExcluded(p: string): boolean {
    return (this.cycleExcluded ?? this.excluded).some((e) => p === e || under(p, e));
  }

  /** Excluded since this cycle started: left alone until the next one (removeExcluded). */
  private excludedMeanwhile(p: string): boolean {
    return this.cycleExcluded !== null && this.excluded !== this.cycleExcluded && this.excluded.some((e) => p === e || under(p, e));
  }

  /**
   * Changes which folders are synced. Newly excluded folders are removed from this computer (to the trash) at the
   * start of the next cycle, so a running cycle never writes into a folder that is being removed. A folder holding
   * changes that are not on the server yet is left where it is (event `kept`).
   */
  async setExcluded(list: string[]): Promise<void> {
    const added = list.filter((e) => !this.excluded.includes(e));
    this.excluded = [...list];
    this.pendingRemove = [...this.pendingRemove.filter((e) => list.includes(e)), ...added];
    this.fullScan = true; // folders that are synced again must be read
    this.schedule(0);
  }

  private async removeExcluded(): Promise<void> {
    for (const e of this.pendingRemove.splice(0)) {
      if (!this.excluded.includes(e) || !Object.keys(this.state.base).some((k) => k === e || under(k, e))) continue;
      if (await this.localTreeUnchanged(e)) {
        const w = this.beginWrite([e]);
        try { await this.o.trash(this.full(e)).catch(() => {}); } finally { await this.endWrite(w); }
      } else this.emit('kept', e);
      this.forget(e);
      this.baseIndex = null;
    }
  }

  /**
   * True when everything at `rel` on this computer is exactly what was last synced (matched by inode, so spelling does
   * not matter): removing it then loses nothing that is not on the server. New, edited or unreadable items → false.
   */
  private async localTreeUnchanged(rel: string): Promise<boolean> {
    const base = this.state.base;
    if (!this.baseIndex) {
      // filesystems without stable inode numbers (some network and FAT disks) are matched by path
      const byIno = new Map<number, string>();
      const byPath = new Map<string, string>();
      for (const [k, b] of Object.entries(base)) {
        if (b.ino) byIno.set(b.ino, k);
        byPath.set(this.foldPath(k), k);
      }
      this.baseIndex = { byIno, byPath };
    }
    const { byIno, byPath } = this.baseIndex;
    const inside = (k: string | undefined) => (k !== undefined && (k === rel || under(k, rel)) ? base[k] : undefined);
    const check = async (file: string, key: string): Promise<boolean> => {
      const st = await lstat(file).catch(() => null);
      if (!st) return true; // already gone
      if (!st.isFile() && !st.isDirectory()) return false;
      const b = inside(byIno.get(st.ino)) ?? inside(byPath.get(this.foldPath(key)));
      if (!b || b.dir !== st.isDirectory()) return false;
      if (!b.dir) return b.size === st.size && b.mtime === Math.floor(st.mtimeMs);
      let names: string[];
      try { names = await readdir(file); } catch { return false; }
      for (const n of names) if (!IGNORED.test(n) && !(await check(path.join(file, n), `${key}/${n}`))) return false;
      return true;
    };
    return check(this.full(rel), rel);
  }

  // ------------------------------------------------------------ one cycle

  full(p: string): string {
    return path.join(this.root, ...p.split('/'));
  }

  /** One pass; true when it moved things around and the trees should be read again. */
  async cycle(): Promise<boolean> {
    if (this.paused || this.stopped) return false;
    try {
      return await this.cycleInner();
    } finally {
      this.cycleExcluded = null;
    }
  }

  private async cycleInner(): Promise<boolean> {
    const rootStat = await lstat(this.root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new SyncError('missing-folder', `Folder not found: ${this.root}`);
    this.setStatus({ phase: 'syncing', done: 0, total: 0, current: undefined });
    this.unknown = new Set();
    this.rootReal = null;
    this.baseIndex = null;
    this.dirNames.clear();
    this.cycleExcluded = this.excluded; // setExcluded replaces the array, so this one stays as it is
    const now = Date.now();
    for (const [k, w] of this.selfWrites) if (!w.busy && w.until < now) this.selfWrites.delete(k);
    await this.probeFs();
    await this.removeExcluded();
    this.flushForget();
    const remote = await this.scanRemote();
    const full = this.fullScan || !this.watching;
    this.fullScan = false; // a request arriving during the scan is for the next one
    const local = await this.scanLocal(full);
    this.syncDirWatchers();
    if (await this.applyMoves(local, remote)) { await this.save(true); return true; }
    const again = await this.reconcile(local, remote);
    this.noteSpellings(local);
    await this.save(true);
    return again;
  }

  /**
   * Finds out whether the sync folder's filesystem treats names that differ in case (APFS, NTFS, exFAT…) or in
   * Unicode form (APFS, HFS+: "é" composed or decomposed) as the same name. Probed with a temp file; if that is not
   * possible the platform's usual filesystem is assumed.
   */
  private async probeFs(): Promise<void> {
    if (this.fold) return;
    const usual = { caseFold: this.platform === 'darwin' || this.platform === 'win32', normFold: this.platform === 'darwin' };
    if (this.o.platform) { this.fold = usual; this.caseInsensitive = usual.caseFold || usual.normFold; return; } // tests pretend a platform
    const id = randomBytes(4).toString('hex');
    const probe = path.join(this.root, `.cloudy-tmp-${id}-é`);
    try {
      await writeFile(probe, '');
      const exists = async (name: string) => !!(await lstat(path.join(this.root, name)).catch(() => null));
      this.fold = {
        caseFold: await exists(`.CLOUDY-TMP-${id.toUpperCase()}-É`),
        normFold: await exists(`.cloudy-tmp-${id}-é`),
      };
    } catch {
      this.fold = usual;
    } finally {
      await rm(probe, { force: true }).catch(() => {});
    }
    this.caseInsensitive = this.fold.caseFold || this.fold.normFold;
  }

  /** A name as the filesystem compares it. */
  private folded(name: string): string {
    const f = this.fold ?? { caseFold: this.caseInsensitive, normFold: this.platform === 'darwin' };
    const n = f.normFold ? name.normalize('NFC') : name;
    return f.caseFold ? n.toLowerCase() : n;
  }

  private foldPath(p: string): string {
    return this.caseInsensitive ? this.folded(p) : p;
  }

  /**
   * Unknown paths are compared the way the filesystem compares names: a local symlink "Photos" also covers the
   * server's "photos", which on macOS/Windows is the same path on disk (and would be written through the link).
   */
  private isUnknown(p: string): boolean {
    if (!this.unknown.size) return false;
    const f = this.foldPath(p);
    return this.unknown.has(f) || ancestorIn(this.unknown, f);
  }

  private markUnknown(p: string): void {
    this.unknown.add(this.foldPath(p));
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
    this.remoteNames = new Map();
    let root;
    try {
      root = await this.api.node(this.rootId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new SyncError('remote-missing', 'The server folder no longer exists');
      throw e;
    }
    const strip = (c: RemoteNode): Child => {
      const out: Child = { id: c.id, name: c.name, isDir: c.isDir, size: c.size, etag: c.etag, mtime: c.mtime };
      if (c.sha256) out.sha256 = c.sha256;
      return out;
    };
    let fetched = old['']?.etag !== root.node.etag;

    type Job = { rel: string; id: number; etag: string; prefetched?: RemoteNode[] };
    await drain<Job>([{ rel: '', id: this.rootId, etag: root.node.etag, prefetched: root.children ?? [] }], REQUESTS, async ({ rel, id, etag, prefetched }, push) => {
      const cached = old[rel];
      let children: Child[];
      if (prefetched) children = prefetched.map(strip);
      else if (cached && cached.id === id && cached.etag === etag) children = cached.children;
      else {
        try {
          children = ((await this.api.node(id)).children ?? []).map(strip);
          fetched = true;
        } catch (e) {
          // Removed or hidden while walking: its contents are unknown this cycle (not "deleted"); the next one sees it.
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) { this.markUnknown(rel); return; }
          throw e;
        }
      }
      folders[rel] = { id, etag, children };
      const seen = new Map<string, string>();
      for (const c of children) {
        const p = rel ? `${rel}/${c.name}` : c.name;
        if (isIgnored(c.name) || this.isExcluded(p)) continue;
        const bad = this.checkName(c.name);
        if (bad) { this.problem(p, bad); this.markUnknown(p); continue; }
        if (this.caseInsensitive) {
          // Two server names that are one name here (case, or "é" composed and decomposed on APFS/HFS+).
          const k = this.folded(c.name);
          if (seen.has(k)) { this.problem(p, this.msg('case')); this.markUnknown(p); continue; }
          seen.set(k, c.name);
        }
        const r: Remote = { dir: c.isDir, id: c.id, etag: c.etag, size: c.size, mtime: c.mtime };
        if (c.sha256) r.sha256 = c.sha256;
        remote.set(p, r);
        if (c.isDir) push({ rel: p, id: c.id, etag: c.etag });
      }
      if (this.caseInsensitive) this.remoteNames.set(rel, seen);
    });
    // Folders that are no longer walked (deleted, excluded) leave the state too.
    if (fetched || Object.keys(folders).length !== Object.keys(old).length) this.stateDirty = true;
    this.state.folders = folders;
    return remote;
  }

  /**
   * Reads the local folder. On filesystems that fold case or Unicode form, a local name that is the same name as the
   * server's ("docs" vs "Docs", NFD vs NFC) is keyed by the server's spelling, so both sides line up as one item
   * instead of an upload of a duplicate plus a "deleted" original. Exceptions, so renames still work:
   * - base knows this item under its local spelling: the server renamed it (applyMoves renames it here);
   * - base knows it under the server spelling and its local spelling then was not this one: the user renamed it
   *   here (case only), and applyMoves renames it on the server.
   *
   * `full` false: folders whose listing is cached and that were not reported changed (dirtyDirs) are not read again;
   * only valid while the watcher works. Names are keyed again every time (server spellings and base change).
   */
  async scanLocal(full = true): Promise<Map<string, Local>> {
    const local = new Map<string, Local>();
    const base = this.state.base;
    const dirty = this.dirtyDirs;
    this.dirtyDirs = new Set();
    const old = this.dirCache;
    const cache = new Map<string, Listing>();
    const stats = { full, read: 0, dirs: 0 };
    const read = async (dir: string, diskRel: string, ino: number): Promise<Listing> => {
      stats.read++;
      // Linux: watch before reading, so nothing written in between is missed.
      if (this.perFolderWatch && this.watching) this.watchDir(dir, diskRel, ino);
      const all = await readdir(dir);
      const names: string[] = [];
      for (const name of all) {
        if (/^\.cloudy-tmp-/i.test(name)) { await rm(path.join(dir, name), { force: true }).catch(() => {}); continue; } // left by a crash
        if (!isIgnored(name)) names.push(name);
      }
      return { full: dir, ino, names, stats: await lstatAll(dir, names) };
    };
    try {
      const rootIno = (await lstat(this.root)).ino;
      await drain<[string, string, string, number]>([[this.root, '', '', rootIno]], SCAN_DIRS, async ([dir, rel, diskRel, ino], push) => {
        const ck = this.foldPath(diskRel);
        let listing = full || dirty.has(ck) ? undefined : old.get(ck);
        // Same path but another folder (spelled differently, or swapped/recreated): read it. Checked from the top down,
        // so every level below a changed folder is checked against fresh inodes.
        if (!listing || listing.full !== dir || listing.ino !== ino) {
          try {
            listing = await read(dir, diskRel, ino);
          } catch (e: any) {
            if (!rel) throw e;
            this.problem(rel, e.message);
            this.markUnknown(rel); // unreadable, not empty: nothing below it may be deleted on the server
            return;
          }
        }
        cache.set(ck, listing);
        stats.dirs++;
        const seen = new Set<string>();
        const serverNames = this.caseInsensitive ? this.remoteNames.get(rel) : undefined;
        const { names } = listing;
        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          const st = listing.stats[i];
          const ino = st && st !== 'other' ? st.ino : undefined;
          let key = name;
          if (this.caseInsensitive) {
            const f = this.folded(name);
            const own = rel ? `${rel}/${name}` : name;
            if (seen.has(f)) { this.problem(own, this.msg('case')); this.markUnknown(own); continue; } // e.g. a case-sensitive volume
            seen.add(f);
            const server = serverNames?.get(f);
            if (server && server !== name) {
              const sp = rel ? `${rel}/${server}` : server;
              const bLocal = base[own];
              const bServer = base[sp];
              const onlyForm = name.normalize('NFC') === server.normalize('NFC');
              const serverRenamed = ino !== undefined && bLocal?.ino === ino;
              const localRenamed = ino !== undefined && !onlyForm && bServer?.ino === ino && bServer.lname !== name;
              if (!serverRenamed && !localRenamed) key = server;
            }
          }
          const p = rel ? `${rel}/${key}` : key;
          if (this.isExcluded(p)) continue;
          if (!st || st === 'other') { this.markUnknown(p); continue; } // symlinks and special files are left alone
          const bad = this.checkName(name);
          if (bad) { this.problem(p, bad); this.markUnknown(p); continue; }
          local.set(p, st);
          if (st.dir) push([path.join(dir, name), p, diskRel ? `${diskRel}/${name}` : name, st.ino]);
        }
      });
    } catch (e) {
      for (const d of dirty) this.dirtyDirs.add(d);
      this.fullScan = true;
      throw e;
    }
    this.dirCache = cache;
    this.lastScan = stats;
    return local;
  }

  /**
   * Linux: keeps one (non-recursive) watcher per local folder, in step with the last scan. Hitting the inotify limit
   * (ENOSPC) or the open-files limit drops all of them: the timer then checks the whole folder every minute.
   */
  private syncDirWatchers(): void {
    if (!this.perFolderWatch || !this.watching || this.stopped) return;
    // inotify watches the folder itself, not its path: a watcher whose path now names another folder (renamed,
    // swapped, deleted and created again) reports under the wrong path, so it is replaced.
    for (const [full, { w, ino }] of this.dirWatchers) {
      const l = this.dirCache.get(this.foldPath(path.relative(this.root, full).split(path.sep).join('/')));
      if (!l || l.full !== full || l.ino !== ino) { w.close(); this.dirWatchers.delete(full); }
    }
    // Folders read from the cache whose watcher was lost (an error): watch them and read them once more.
    let added = false;
    for (const l of this.dirCache.values()) {
      if (this.dirWatchers.has(l.full)) continue;
      const rel = path.relative(this.root, l.full).split(path.sep).join('/');
      if (this.watchDir(l.full, rel, l.ino)) { this.dirtyDirs.add(this.foldPath(rel)); added = true; }
      if (!this.watching) return;
    }
    if (added) this.schedule(1500);
  }

  /**
   * One folder's watcher (Linux), replacing one for another folder at that path. False if the folder is gone; the
   * inotify or open-files limit stops all watching.
   */
  private watchDir(full: string, rel: string, ino: number): boolean {
    const had = this.dirWatchers.get(full);
    if (had?.ino === ino) return true;
    had?.w.close();
    this.dirWatchers.delete(full);
    try {
      const w = watch(full, (_ev, file) => this.onFsEvent(file == null ? null : rel ? `${rel}/${file}` : String(file)));
      // A watched folder that is removed ends its watcher; its parent's watcher reports the removal.
      w.on('error', () => { w.close(); if (this.dirWatchers.get(full)?.w === w) this.dirWatchers.delete(full); });
      this.dirWatchers.set(full, { w, ino });
      return true;
    } catch (e: any) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') this.watcherFailed(); // ENOSPC, EMFILE…
      return false;
    }
  }

  /**
   * Records how `p` is spelled on disk in its base entry (`lname`, see scanLocal). Every write of a base entry for an
   * item that exists here goes through this: a missing `lname` means "spelled like the server", so forgetting it
   * would make the next scan see a case-only rename by the user and repeat it on the server.
   */
  private spell(p: string, disk: string): void {
    const b = this.state.base[p];
    if (!b) return;
    const lname = this.caseInsensitive && disk !== nameOf(p) ? disk : undefined;
    if (b.lname === lname) return;
    if (lname) b.lname = lname;
    else delete b.lname;
    this.stateDirty = true;
  }

  /** The name `p` has on disk (on filesystems that fold names it can differ from `p`'s spelling). */
  private async diskName(p: string): Promise<string> {
    const want = nameOf(p);
    if (!this.caseInsensitive) return want;
    const dir = path.dirname(this.full(p));
    let names = this.dirNames.get(dir);
    if (!names) {
      names = new Map();
      for (const n of await readdir(dir).catch(() => [] as string[])) names.set(this.folded(n), n);
      this.dirNames.set(dir, names);
    }
    const f = this.folded(want);
    const found = names.get(f);
    if (found) return found;
    names.set(f, want); // created by this cycle after the folder was read: spelled as written
    return want;
  }

  /** Backstop for `spell`: remembers local spellings seen by this cycle's scan, for the items synced. */
  private noteSpellings(local: Map<string, Local>): void {
    const base = this.state.base;
    for (const [k, l] of local) {
      const b = base[k];
      if (!b || b.ino !== l.ino) continue;
      const lname = l.name !== nameOf(k) ? l.name : undefined;
      if (b.lname === lname) continue;
      if (lname) b.lname = lname;
      else delete b.lname;
      this.stateDirty = true;
    }
  }

  /**
   * Local writes (new folders, downloads, renames) must land inside the sync folder. A folder on the way that is a
   * symlink, or a junction, could otherwise send them elsewhere on the computer.
   */
  private async insideRoot(p: string): Promise<boolean> {
    const rootReal = (this.rootReal ??= await realpath(this.root));
    let dir = path.dirname(this.full(p));
    // The nearest folder that exists (mkdir -p creates the rest inside it).
    for (;;) {
      const real = await realpath(dir).catch(() => null);
      if (real) return real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  }

  private localChanged(l: Local, b: Entry | undefined): boolean {
    return !b || l.dir !== b.dir || (!l.dir && !sameFile(l, b));
  }

  private remoteChanged(r: Remote, b: Entry | undefined): boolean {
    return !b || r.dir !== b.dir || r.id !== b.id || (!r.dir && r.etag !== b.etag);
  }

  /**
   * Server folder id for `rel`, from this cycle's listing only. (The base's id would be a folder that was deleted or
   * moved on the server: uploads into it fail for ever, or land in the folder's new place.)
   */
  private remoteId(rel: string, remote: Map<string, Remote>): number | undefined {
    if (!rel) return this.rootId;
    const r = remote.get(rel);
    return r?.dir ? r.id : undefined;
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
    this.setBase(rel, { dir: true, id: d.id, size: 0, mtime: 0, ino: local.get(rel)!.ino });
    this.spell(rel, local.get(rel)!.name);
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
    // Built only when something new shows up on one side (most cycles have nothing that could be a move).
    let index: { byIno: Map<number, string>; byId: Map<number, string> } | null = null;
    const idx = () => {
      if (index) return index;
      index = { byIno: new Map(), byId: new Map() };
      for (const [p, b] of Object.entries(base)) {
        if (b.ino) index.byIno.set(b.ino, p);
        if (b.id) index.byId.set(b.id, p);
      }
      return index;
    };
    const moves: { from: string; to: string; side: 'remote' | 'local' }[] = [];
    for (const [p, l] of local) {
      if (base[p] || remote.has(p)) continue;
      const from = idx().byIno.get(l.ino);
      if (!from || local.has(from)) continue;
      const b = base[from];
      const r = remote.get(from);
      if (b.dir !== l.dir || (!l.dir && !sameFile(l, b))) continue;
      if (!r || r.id !== b.id || (!r.dir && r.etag !== b.etag)) continue;
      moves.push({ from, to: p, side: 'remote' });
    }
    for (const [p, r] of remote) {
      if (base[p] || local.has(p)) continue;
      const from = idx().byId.get(r.id);
      if (!from || remote.has(from)) continue;
      const b = base[from];
      const l = local.get(from);
      if (b.dir !== r.dir || (!r.dir && (r.size !== b.size || r.mtime !== b.rmtime))) continue; // moved and edited
      if (!l || l.dir !== b.dir || (!l.dir && !sameFile(l, b))) continue;
      moves.push({ from, to: p, side: 'local' });
    }
    if (!moves.length) return false;
    moves.sort((a, b) => depth(a.from) - depth(b.from));
    const done = new Set<string>();
    for (const m of moves) {
      if (ancestorIn(done, m.from)) continue; // moved along with its folder
      if (this.isUnknown(m.from) || this.isUnknown(m.to)) continue;
      try {
        if (m.side === 'remote') {
          const parentId = await this.ensureRemoteDir(parentOf(m.to), remote, local);
          if (parentId === undefined) continue;
          const moved = await this.api.move(base[m.from].id!, parentId, nameOf(m.to));
          this.rebase(m.from, m.to);
          this.spell(m.to, nameOf(m.to)); // the server now has the local spelling
          if (!moved.isDir) Object.assign(base[m.to], { etag: moved.etag, rmtime: moved.mtime });
        } else {
          // Something already at the destination (a new local file, or the same name in another case on macOS/
          // Windows) must not be overwritten: reconcile downloads the moved file and keeps both. The item itself
          // found there is a rename that only changes case or Unicode form: that rename is done.
          const at = await lstat(this.full(m.to)).catch(() => null);
          if (at && at.ino !== local.get(m.from)!.ino) continue;
          if (!(await this.insideRoot(m.to))) { this.problem(m.to, this.msg('outside')); continue; }
          const w = this.beginWrite([m.from, m.to]);
          try {
            await mkdir(this.full(parentOf(m.to)), { recursive: true });
            await rename(this.full(m.from), this.full(m.to));
          } finally {
            await this.endWrite(w);
          }
          const r = remote.get(m.to)!;
          this.rebase(m.from, m.to);
          this.spell(m.to, nameOf(m.to)); // renamed here to the server's spelling
          if (!r.dir) Object.assign(base[m.to], { etag: r.etag, rmtime: r.mtime });
        }
        done.add(m.from);
        this.log(m.to, 'moved');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw e;
        if (isNetworkError(e)) throw e;
        this.problem(m.to, (e as Error).message);
      }
    }
    return done.size > 0;
  }

  /** Works out and carries out what each path needs. True if another pass is needed (conflicts renamed). */
  async reconcile(local: Map<string, Local>, remote: Map<string, Remote>): Promise<boolean> {
    const base = this.state.base;
    const keys = [...new Set([...Object.keys(base), ...local.keys(), ...remote.keys()])].sort();
    type Op = 'mkdirRemote' | 'mkdirLocal' | 'record' | 'upload' | 'download' | 'compare' | 'conflict' | 'deleteRemote' | 'deleteLocal' | 'forget';
    const ops: { op: Op; p: string }[] = [];
    const wholeDir = new Set<string>(); // folders deleted as a whole: skip what's inside

    // "Is anything inside this folder changed?" is answered from sets built once (folders above every changed item),
    // not by looking through the whole tree for every folder.
    // Something unreadable inside a folder counts as a change: deleting the folder as a whole would take it along.
    let unknownAbove: Set<string> | null = null;
    let localAbove: Set<string> | null = null;
    let remoteAbove: Set<string> | null = null;
    const unknownIn = (dir: string) => {
      if (!unknownAbove) { unknownAbove = new Set(); for (const u of this.unknown) addAncestors(unknownAbove, u); }
      return unknownAbove.has(this.foldPath(dir));
    };
    const localTreeChanged = (dir: string) => {
      if (!localAbove) { localAbove = new Set(); for (const [k, l] of local) if (this.localChanged(l, base[k])) addAncestors(localAbove, k); }
      return unknownIn(dir) || localAbove.has(dir);
    };
    const remoteTreeChanged = (dir: string) => {
      if (!remoteAbove) { remoteAbove = new Set(); for (const [k, r] of remote) if (this.remoteChanged(r, base[k])) addAncestors(remoteAbove, k); }
      return unknownIn(dir) || remoteAbove.has(dir);
    };

    for (const p of keys) {
      if (ancestorIn(wholeDir, p)) continue;
      if (this.isUnknown(p) || this.excludedMeanwhile(p)) continue;
      const l = local.get(p);
      const r = remote.get(p);
      const b = base[p];
      if (!l && !r) { if (b) ops.push({ op: 'forget', p }); continue; }
      if (l && !r) {
        if (!b) ops.push({ op: l.dir ? 'mkdirRemote' : 'upload', p });
        else if (l.dir) {
          if (localTreeChanged(p)) ops.push({ op: 'mkdirRemote', p });
          else { ops.push({ op: 'deleteLocal', p }); wholeDir.add(p); }
        } else ops.push({ op: this.localChanged(l, b) ? 'upload' : 'deleteLocal', p });
        continue;
      }
      if (!l && r) {
        if (!b) ops.push({ op: r.dir ? 'mkdirLocal' : 'download', p });
        else if (r.dir) {
          if (remoteTreeChanged(p)) ops.push({ op: 'mkdirLocal', p });
          else { ops.push({ op: 'deleteRemote', p }); wholeDir.add(p); }
        } else ops.push({ op: this.remoteChanged(r, b) ? 'download' : 'deleteRemote', p });
        continue;
      }
      // on both sides
      if (l!.dir && r!.dir) { if (!b || b.id !== r!.id || b.ino !== l!.ino) ops.push({ op: 'record', p }); continue; }
      if (l!.dir !== r!.dir) { ops.push({ op: 'conflict', p }); wholeDir.add(p); continue; }
      const lc = this.localChanged(l!, b);
      const rc = this.remoteChanged(r!, b);
      if (!b || (lc && rc)) ops.push({ op: l!.size === r!.size ? 'compare' : 'conflict', p });
      else if (lc) ops.push({ op: 'upload', p });
      else if (rc) ops.push({ op: 'download', p });
    }

    // Many deletions at once usually mean something went wrong (a drive not mounted, a folder emptied by mistake).
    if (ops.some((o) => o.op === 'deleteLocal' || o.op === 'deleteRemote')) {
      let total = 0;
      const filesBelow = new Map<string, number>(); // one pass over base, not one per deleted folder
      for (const [k, e] of Object.entries(base)) {
        if (e.dir) continue;
        total++;
        for (let d = parentOf(k); d; d = parentOf(d)) filesBelow.set(d, (filesBelow.get(d) ?? 0) + 1);
      }
      const filesAt = (p: string) => (base[p] && !base[p].dir ? 1 : filesBelow.get(p) ?? 0);
      for (const where of ['local', 'remote'] as const) {
        const op = where === 'local' ? 'deleteLocal' : 'deleteRemote';
        const del = ops.filter((o) => o.op === op);
        const files = del.reduce((n, o) => n + filesAt(o.p), 0);
        // Ask for ≥ 100 files, for a small account losing every one of its files, and whenever the side the deletions
        // come from is now completely empty (an unmounted disk's empty mount point, a server folder emptied by mistake).
        const emptied = files > 0 && (where === 'remote' ? local.size === 0 : remote.size === 0);
        const suspicious = files >= MASS_DELETE || (files === total && total >= 10) || emptied;
        if (suspicious && files >= total / 2 && this.o.confirmDeletes && !(await this.o.confirmDeletes(files, where))) {
          // Keep them: forgetting the base makes the files "new" on the side that still has them, so they are copied back.
          for (const o of del) { this.forget(o.p); o.op = 'forget'; }
        }
      }
    }

    const work = ops.filter((o) => o.op !== 'forget');
    for (const o of ops) if (o.op === 'forget') this.forget(o.p);
    this.flushForget();
    let done = 0;
    let again = false;
    let fatal: unknown = null; // signed out / offline: stop every worker
    this.setStatus({ phase: 'syncing', done, total: work.length });
    const run = async (o: { op: Op; p: string }) => {
      if (this.paused || this.stopped || fatal) return;
      this.setStatus({ current: o.p });
      const writes = o.op === 'mkdirLocal' || o.op === 'download' || o.op === 'compare' || o.op === 'conflict' || o.op === 'deleteLocal'
        ? this.beginWrite([o.p]) : null;
      try {
        if (await this.execute(o.op, o.p, local.get(o.p), remote.get(o.p), remote, local)) again = true;
      } catch (e: any) {
        if (this.paused || this.stopped) return; // aborted on purpose
        if (isFatal(e)) { fatal ??= e; return; }
        this.problem(o.p, e?.code === 'EBUSY' || e?.code === 'EPERM' ? this.msg('locked') : e?.message ?? String(e));
      } finally {
        if (writes) await this.endWrite(writes);
      }
      this.setStatus({ done: ++done });
      await this.save();
    };
    const phase = (names: Op[]) => work.filter((o) => names.includes(o.op));
    // Folders level by level (a folder's parent exists before it), each level in parallel.
    const dirs = phase(['mkdirRemote', 'mkdirLocal', 'record']);
    const levels = new Map<number, typeof dirs>();
    for (const o of dirs) { const d = depth(o.p); const l = levels.get(d); if (l) l.push(o); else levels.set(d, [o]); }
    for (const d of [...levels.keys()].sort((a, b) => a - b)) await pool(levels.get(d)!, REQUESTS, run);
    await pool(phase(['upload', 'download', 'compare', 'conflict']), TRANSFERS, run);
    await pool(phase(['deleteRemote']), REQUESTS, run);
    for (const o of phase(['deleteLocal'])) await run(o); // the system trash is slow and not made for parallel calls
    this.flushForget();
    if (fatal) throw fatal;
    return again;
  }

  private conflictName(p: string, n = 1): string {
    const d = this.o.now?.() ?? new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const name = nameOf(p);
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const out = `${stem} (${this.o.conflictLabel ?? 'conflicted copy'} ${stamp}${n > 1 ? ` ${n}` : ''})${ext}`;
    return parentOf(p) ? `${parentOf(p)}/${out}` : out;
  }

  /** Moves the local `p` aside under a conflict name that is free (rename would replace an earlier copy). */
  private async keepAside(p: string): Promise<void> {
    for (let n = 1; n < 1000; n++) {
      const c = this.conflictName(p, n);
      if (await lstat(this.full(c)).catch(() => null)) continue;
      await rename(this.full(p), this.full(c));
      return;
    }
    throw new Error('No free name for a conflicted copy');
  }

  private tmpFor(p: string): string {
    return path.join(path.dirname(this.full(p)), `.cloudy-tmp-${randomBytes(6).toString('hex')}`);
  }

  /** `disk`: the item's name on disk (see `spell`). */
  private async record(p: string, r: Remote, disk = nameOf(p)): Promise<void> {
    const st = await lstat(this.full(p));
    this.setBase(p, r.dir
      ? { dir: true, id: r.id, size: 0, mtime: 0, ino: st.ino }
      : { dir: false, id: r.id, etag: r.etag, rmtime: r.mtime, size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino });
    this.spell(p, disk);
  }

  /** Downloads `r` into a temp file next to `p`, dated like on the server. */
  private async fetchTemp(p: string, r: Remote): Promise<string> {
    if (!(await this.insideRoot(p))) throw new Error(this.msg('outside'));
    const tmp = this.tmpFor(p);
    try {
      await this.api.download(r.id, tmp, this.abort.signal);
      // A short file must never replace a good one (a connection cut that the HTTP stack did not report, or the file
      // changed on the server since the listing: the next cycle gets the new one).
      if ((await lstat(tmp)).size !== r.size) throw new Error(this.msg('incomplete'));
      const t = new Date(r.mtime);
      if (!Number.isNaN(t.getTime())) await utimes(tmp, t, t);
      return tmp;
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /**
   * Puts a downloaded temp file at `p`. A local file there that changed since the scan is kept as a conflicted copy.
   * `disk`: the name the file has afterwards (replacing a file spelled differently may keep that spelling).
   */
  private async place(p: string, tmp: string, scanned: Local | undefined): Promise<{ kept: boolean; disk: string }> {
    const dest = this.full(p);
    const now = await lstat(dest).catch(() => null);
    let kept = false;
    if (now && (!scanned || !now.isFile() || now.size !== scanned.size || Math.floor(now.mtimeMs) !== scanned.mtime)) {
      await this.keepAside(p);
      this.log(p, 'conflict');
      kept = true;
    }
    await rename(tmp, dest);
    const inPlace = !!now && !kept && !!scanned && scanned.name !== nameOf(p);
    return { kept, disk: inPlace ? await this.diskName(p) : nameOf(p) };
  }

  private async execute(op: string, p: string, l: Local | undefined, r: Remote | undefined,
    remote: Map<string, Remote>, local: Map<string, Local>): Promise<boolean> {
    const base = this.state.base;
    // Everything that reads or writes here, before any mkdir/rename/read/trash: a folder on the way that was replaced
    // by a link since the scan must not send it elsewhere on the computer (or upload what is there).
    if (op !== 'deleteRemote' && op !== 'mkdirRemote' && !(await this.insideRoot(p))) {
      this.problem(p, this.msg('outside'));
      return false;
    }
    switch (op) {
      case 'record':
        await this.record(p, r!, l?.name);
        return false;

      case 'mkdirLocal':
        await mkdir(this.full(p), { recursive: true });
        await this.record(p, r!, await this.diskName(p));
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
        const up = await this.api.upload(parentId, nameOf(p), this.full(p), before.size, this.abort.signal);
        // Servers from 1.16 answer the last chunk with the whole node; older ones only with its id.
        const n = up.etag && up.mtime ? up : (await this.api.node(up.id)).node;
        // The size/mtime from before the upload: if the file changed meanwhile, the next pass uploads it again.
        this.setBase(p, { dir: false, id: n.id, etag: n.etag, rmtime: n.mtime, size: before.size, mtime: Math.floor(before.mtimeMs), ino: before.ino });
        this.spell(p, l?.name ?? nameOf(p));
        this.log(p, 'uploaded');
        const after = await lstat(this.full(p)).catch(() => null);
        return !!after && (after.size !== before.size || Math.floor(after.mtimeMs) !== Math.floor(before.mtimeMs));
      }

      case 'download': {
        await mkdir(path.dirname(this.full(p)), { recursive: true });
        const tmp = await this.fetchTemp(p, r!);
        try {
          const { kept, disk } = await this.place(p, tmp, l);
          await this.record(p, r!, disk);
          this.log(p, 'downloaded');
          return kept;
        } finally {
          await rm(tmp, { force: true });
        }
      }

      case 'compare': {
        // Same size on both sides but no shared history (first sync) or both edited: compare the content. With the
        // server's hash nothing is downloaded when they are the same; without it the server's copy is fetched first.
        const ours = await hashFile(this.full(p));
        if (r!.sha256 && r!.sha256 === ours) {
          await this.record(p, r!, l?.name);
          return false;
        }
        const tmp = await this.fetchTemp(p, r!);
        try {
          if (!r!.sha256 && (await hashFile(tmp)) === ours) {
            await this.record(p, r!, l?.name);
            return false;
          }
          await this.keepAside(p);
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
        await this.keepAside(p);
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
        // Back here since the scan (or the scan missed it): never trash on the server what this computer has.
        if (await lstat(this.full(p)).catch(() => null)) return true;
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
        // A folder: something added or edited in it since the scan (transfers run before deletions) is not deleted;
        // the watcher's next cycle sees the change and syncs it.
        if (now?.isDirectory() && !(await this.localTreeUnchanged(p))) return false;
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
    createReadStream(file, { highWaterMark: 1 << 20 }).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}
