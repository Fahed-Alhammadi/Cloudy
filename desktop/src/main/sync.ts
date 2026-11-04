// Two-way sync between a local folder and a Cloudy folder (no Electron imports, so it runs under plain Node in tests).
//
// Each cycle compares three trees by relative path: the local folder, the server, and `base` (both sides as of the last
// successful sync). A side "changed" if it differs from base; one-sided changes are copied to the other side, changes on
// both sides keep both copies ("conflicted copy"). Deletions go to the server's trash or the computer's trash, never
// straight to oblivion. Renames are detected by inode (local) and node id (server) so moving a folder doesn't re-transfer it.
// The server listing is cached per folder and only re-read when the folder's etag changed (etags change up the tree).
import { readdir, lstat, mkdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
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
interface Remote { dir: boolean; id: number; etag: string; size: number; mtime: string }
type Child = Pick<RemoteNode, 'id' | 'name' | 'isDir' | 'size' | 'etag' | 'mtime'>;

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

/**
 * Signed out, or the server is failing: stops every worker of the cycle instead of failing file by file. "Storage
 * full" (507) is about one upload: downloads, moves and deletes still go on.
 */
const isFatal = (e: any) => (e instanceof ApiError && (e.status === 401 || (e.status >= 500 && e.status !== 507))) || isNetworkError(e);

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
  /** Aborted by stop() and pause(): running downloads and uploads end at once instead of finishing first. */
  private abort = new AbortController();
  /** Newly excluded folders, removed from this computer at the start of the next cycle (see setExcluded). */
  private pendingRemove: string[] = [];
  /** How the sync folder's filesystem compares names (probed on the first cycle; null = not yet). */
  private fold: { caseFold: boolean; normFold: boolean } | null = null;
  /** Server names per folder path, by folded name: lets the local scan use the server's spelling for the same file. */
  private remoteNames = new Map<string, Map<string, string>>();
  private lastSave = 0;
  private rootReal: string | null = null;

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
    this.state.root = o.root;
  }

  // ------------------------------------------------------------ lifecycle

  /** Starts watching the folder and the server's live events, and syncs now. */
  start(): void {
    this.stopped = false;
    this.signedOut = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
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

  /**
   * Stops watching and syncing; running transfers are aborted. Resolves once a running cycle has wound down; after
   * that the engine saves nothing, unless `save` (quitting the app: keep what this cycle finished), once, here.
   */
  async stop(opts: { save?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.live?.abort();
    this.abort.abort();
    await this.inflight?.catch(() => {});
    if (opts.save) await this.o.saveState(this.state).catch(() => {});
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
    if (this.abort.signal.aborted) this.abort = new AbortController();
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
      if (!this.paused && !this.stopped) this.setStatus({ phase: 'idle', done: 0, total: 0, current: undefined, lastSync: Date.now(), error: undefined, code: undefined });
    } catch (e: any) {
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
    if (!force && Date.now() - this.lastSave < 5000) return;
    this.lastSave = Date.now();
    await this.o.saveState(this.state);
  }

  // ------------------------------------------------------------ selective sync

  isExcluded(p: string): boolean {
    return this.excluded.some((e) => p === e || under(p, e));
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
    this.schedule(0);
  }

  private async removeExcluded(): Promise<void> {
    for (const e of this.pendingRemove.splice(0)) {
      if (!this.excluded.includes(e) || !Object.keys(this.state.base).some((k) => k === e || under(k, e))) continue;
      if (await this.localTreeUnchanged(e)) await this.o.trash(this.full(e)).catch(() => {});
      else this.emit('kept', e);
      this.forget(e);
    }
  }

  /**
   * True when everything at `rel` on this computer is exactly what was last synced (matched by inode, so spelling does
   * not matter): removing it then loses nothing that is not on the server. New, edited or unreadable items → false.
   */
  private async localTreeUnchanged(rel: string): Promise<boolean> {
    const byIno = new Map<number, Entry>();
    const byPath = new Map<string, Entry>(); // filesystems without stable inode numbers (some network and FAT disks)
    for (const [k, b] of Object.entries(this.state.base)) {
      if (k !== rel && !under(k, rel)) continue;
      if (b.ino) byIno.set(b.ino, b);
      byPath.set(this.foldPath(k), b);
    }
    const check = async (file: string, key: string): Promise<boolean> => {
      const st = await lstat(file).catch(() => null);
      if (!st) return true; // already gone
      if (!st.isFile() && !st.isDirectory()) return false;
      const b = byIno.get(st.ino) ?? byPath.get(this.foldPath(key));
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
    const rootStat = await lstat(this.root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new SyncError('missing-folder', `Folder not found: ${this.root}`);
    this.setStatus({ phase: 'syncing', done: 0, total: 0, current: undefined });
    this.unknown = new Set();
    this.rootReal = null;
    await this.probeFs();
    await this.removeExcluded();
    const remote = await this.scanRemote();
    const local = await this.scanLocal();
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
    const probe = path.join(this.root, `.cloudy-tmp-${id}-\u00e9`);
    try {
      await writeFile(probe, '');
      const exists = async (name: string) => !!(await lstat(path.join(this.root, name)).catch(() => null));
      this.fold = {
        caseFold: await exists(`.CLOUDY-TMP-${id.toUpperCase()}-\u00c9`),
        normFold: await exists(`.cloudy-tmp-${id}-e\u0301`),
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
    const f = this.foldPath(p);
    for (const u of this.unknown) if (f === u || under(f, u)) return true;
    return false;
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
        remote.set(p, { dir: c.isDir, id: c.id, etag: c.etag, size: c.size, mtime: c.mtime });
        if (c.isDir) await walk(p, c.id, c.etag);
      }
      if (this.caseInsensitive) this.remoteNames.set(rel, seen);
    };
    await walk('', this.rootId, root.node.etag, root.children ?? []);
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
   */
  async scanLocal(): Promise<Map<string, Local>> {
    const local = new Map<string, Local>();
    const base = this.state.base;
    const walk = async (dir: string, rel: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (e: any) {
        if (!rel) throw e;
        this.problem(rel, e.message);
        this.markUnknown(rel); // unreadable, not empty: nothing below it may be deleted on the server
        return;
      }
      const seen = new Set<string>();
      const serverNames = this.caseInsensitive ? this.remoteNames.get(rel) : undefined;
      for (const name of names) {
        if (/^\.cloudy-tmp-/i.test(name)) { await rm(path.join(dir, name), { force: true }).catch(() => {}); continue; } // left by a crash
        if (isIgnored(name)) continue;
        const st = await lstat(path.join(dir, name)).catch(() => null);
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
            const serverRenamed = !!st && bLocal?.ino === st.ino;
            const localRenamed = !!st && !onlyForm && bServer?.ino === st.ino && bServer.lname !== name;
            if (!serverRenamed && !localRenamed) key = server;
          }
        }
        const p = rel ? `${rel}/${key}` : key;
        if (this.isExcluded(p)) continue;
        if (!st || !(st.isFile() || st.isDirectory())) { this.markUnknown(p); continue; } // symlinks and special files are left alone
        const bad = this.checkName(name);
        if (bad) { this.problem(p, bad); this.markUnknown(p); continue; }
        local.set(p, { dir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: Math.floor(st.mtimeMs), ino: st.ino, name });
        if (st.isDirectory()) await walk(path.join(dir, name), p);
      }
    };
    await walk(this.root, '');
    return local;
  }

  /**
   * Records how `p` is spelled on disk in its base entry (`lname`, see scanLocal). Every write of a base entry for an
   * item that exists here goes through this: a missing `lname` means "spelled like the server", so forgetting it
   * would make the next scan see a case-only rename by the user and repeat it on the server.
   */
  private spell(p: string, disk: string): void {
    const b = this.state.base[p];
    if (!b) return;
    if (this.caseInsensitive && disk !== nameOf(p)) b.lname = disk;
    else delete b.lname;
  }

  /** The name `p` has on disk (on filesystems that fold names it can differ from `p`'s spelling). */
  private async diskName(p: string): Promise<string> {
    const want = nameOf(p);
    if (!this.caseInsensitive) return want;
    const names = await readdir(path.dirname(this.full(p))).catch(() => [] as string[]);
    if (names.includes(want)) return want;
    return names.find((n) => this.folded(n) === this.folded(want)) ?? want;
  }

  /** Backstop for `spell`: remembers local spellings seen by this cycle's scan, for the items synced. */
  private noteSpellings(local: Map<string, Local>): void {
    for (const [k, l] of local) {
      const b = this.state.base[k];
      if (!b || b.ino !== l.ino) continue;
      if (l.name !== nameOf(k)) b.lname = l.name;
      else delete b.lname;
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
    const base = this.state.base;
    const wasFile = base[p]?.dir === false;
    delete base[p];
    if (wasFile) return; // nothing below a file: no need to look through the whole base (large trees)
    for (const k of Object.keys(base)) if (under(k, p)) delete base[k];
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
    this.state.base[rel] = { dir: true, id: d.id, size: 0, mtime: 0, ino: local.get(rel)!.ino };
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
          this.spell(m.to, nameOf(m.to)); // the server now has the local spelling
          if (!moved.isDir) Object.assign(base[m.to], { etag: moved.etag, rmtime: moved.mtime });
        } else {
          // Something already at the destination (a new local file, or the same name in another case on macOS/
          // Windows) must not be overwritten: reconcile downloads the moved file and keeps both. The item itself
          // found there is a rename that only changes case or Unicode form: that rename is done.
          const at = await lstat(this.full(m.to)).catch(() => null);
          if (at && at.ino !== local.get(m.from)!.ino) continue;
          if (!(await this.insideRoot(m.to))) { this.problem(m.to, this.msg('outside')); continue; }
          await mkdir(this.full(parentOf(m.to)), { recursive: true });
          await rename(this.full(m.from), this.full(m.to));
          const r = remote.get(m.to)!;
          this.rebase(m.from, m.to);
          this.spell(m.to, nameOf(m.to)); // renamed here to the server's spelling
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

    // Something unreadable inside a folder counts as a change: deleting the folder as a whole would take it along.
    const unknownIn = (dir: string) => { const f = this.foldPath(dir); return [...this.unknown].some((u) => under(u, f)); };
    const localTreeChanged = (dir: string) => unknownIn(dir) || [...local].some(([k, l]) => under(k, dir) && this.localChanged(l, base[k]));
    const remoteTreeChanged = (dir: string) => unknownIn(dir) || [...remote].some(([k, r]) => under(k, dir) && this.remoteChanged(r, base[k]));

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
    const total = Object.values(base).filter((e) => !e.dir).length;
    const filesAt = (p: string) => (base[p] && !base[p].dir ? 1 : Object.keys(base).filter((k) => under(k, p) && !base[k].dir).length);
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
        if (this.paused || this.stopped) return; // aborted on purpose
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
    this.state.base[p] = r.dir
      ? { dir: true, id: r.id, size: 0, mtime: 0, ino: st.ino }
      : { dir: false, id: r.id, etag: r.etag, rmtime: r.mtime, size: st.size, mtime: Math.floor(st.mtimeMs), ino: st.ino };
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
        const n = (await this.api.node(up.id)).node;
        // The size/mtime from before the upload: if the file changed meanwhile, the next pass uploads it again.
        base[p] = { dir: false, id: n.id, etag: n.etag, rmtime: n.mtime, size: before.size, mtime: Math.floor(before.mtimeMs), ino: before.ino };
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
        // Same size on both sides but no shared history (first sync) or both edited: compare the bytes.
        const tmp = await this.fetchTemp(p, r!);
        try {
          if ((await hashFile(tmp)) === (await hashFile(this.full(p)))) {
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
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}
