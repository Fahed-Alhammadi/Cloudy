// Sync engine against a running Cloudy server, with two engines playing two computers sharing one server folder.
//   CLOUDY_TEST_URL=http://localhost:8080 CLOUDY_TEST_USER=admin CLOUDY_TEST_PASSWORD=… npm test
// Without CLOUDY_TEST_URL the tests are skipped.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Api, ApiError } from '../src/main/api.ts';
import { SyncEngine, stateFitsServer, packState, unpackState, type SyncState } from '../src/main/sync.ts';

const URL = process.env.CLOUDY_TEST_URL;
const skip = !URL && 'CLOUDY_TEST_URL not set';
let api: Api;
let token: string;
let rootId: number;

before(async () => {
  if (skip) return;
  const r = await Api.login(URL!, process.env.CLOUDY_TEST_USER ?? 'admin', process.env.CLOUDY_TEST_PASSWORD ?? '', undefined, 'sync test');
  token = r.token;
  api = new Api(URL!, token);
  rootId = r.user.rootId;
});

/** A fresh server folder and two computers syncing it. */
async function setup(name: string, opts: { confirm?: (n: number) => boolean; now?: () => Date } = {}) {
  const folder = await api.mkdir(rootId, `sync-test-${name}-${Date.now()}`);
  const make = async (label: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), `cloudy-${label}-`));
    let state: SyncState | null = null;
    const trashed: string[] = [];
    const confirms: number[] = [];
    const engine = new SyncEngine({
      api: new Api(URL!, token), root: dir, rootId: folder.id, live: false, now: opts.now,
      saveState: async (s) => { state = structuredClone(s); },
      trash: async (f) => { trashed.push(path.relative(dir, f)); await rm(f, { recursive: true, force: true }); },
      confirmDeletes: async (n) => { confirms.push(n); return opts.confirm ? opts.confirm(n) : true; },
    });
    const sync = async () => {
      await engine.sync();
      assert.equal(engine.status.phase, 'idle', engine.status.error);
      return engine.problems;
    };
    return { dir, engine, sync, trashed, confirms, get state() { return state; } };
  };
  return { folder, a: await make('a'), b: await make('b') };
}

async function tree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { out[p + '/'] = ''; Object.assign(out, await tree(dir, p)); } else out[p] = await readFile(path.join(dir, p), 'utf8');
  }
  return out;
}

const later = () => new Promise((r) => setTimeout(r, 20)); // distinct mtimes

test('uploads, downloads and edits both ways', { skip }, async () => {
  const { a, b } = await setup('basic');
  await mkdir(path.join(a.dir, 'Docs/Deep'), { recursive: true });
  await writeFile(path.join(a.dir, 'Docs/hello.txt'), 'hello');
  await writeFile(path.join(a.dir, 'Docs/Deep/empty.txt'), '');
  await writeFile(path.join(a.dir, 'top.md'), '# top');
  await writeFile(path.join(a.dir, '.DS_Store'), 'ignored');
  assert.deepEqual(await a.sync(), []);
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Docs/': '', 'Docs/Deep/': '', 'Docs/Deep/empty.txt': '', 'Docs/hello.txt': 'hello', 'top.md': '# top' });

  await later();
  await writeFile(path.join(b.dir, 'Docs/hello.txt'), 'hello from b');
  await b.sync();
  await a.sync();
  assert.equal(await readFile(path.join(a.dir, 'Docs/hello.txt'), 'utf8'), 'hello from b');

  // nothing left to do: another pass changes nothing
  const before = structuredClone(a.state!.base);
  await a.sync();
  assert.deepEqual(a.state!.base, before);
});

test('renames and moves are repeated, not re-transferred', { skip }, async () => {
  const { a, b } = await setup('move');
  await mkdir(path.join(a.dir, 'Old'), { recursive: true });
  await writeFile(path.join(a.dir, 'Old/one.txt'), '1');
  await writeFile(path.join(a.dir, 'Old/two.txt'), '2');
  await a.sync();
  await b.sync();
  const id = a.state!.base['Old/one.txt'].id;

  await rename(path.join(a.dir, 'Old'), path.join(a.dir, 'New'));
  await mkdir(path.join(a.dir, 'Archive'));
  await rename(path.join(a.dir, 'New/two.txt'), path.join(a.dir, 'Archive/two.txt'));
  await a.sync();
  assert.equal(a.state!.base['New/one.txt'].id, id, 'same server file, moved');
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Archive/': '', 'Archive/two.txt': '2', 'New/': '', 'New/one.txt': '1' });
  assert.deepEqual(b.trashed, [], 'moved, not deleted and downloaded');
  assert.equal(b.state!.base['New/one.txt'].id, id);
});

test('deletions go to the trash on the other side', { skip }, async () => {
  const { a, b } = await setup('delete');
  await mkdir(path.join(a.dir, 'Gone'), { recursive: true });
  await writeFile(path.join(a.dir, 'Gone/x.txt'), 'x');
  await writeFile(path.join(a.dir, 'keep.txt'), 'k');
  await writeFile(path.join(a.dir, 'bye.txt'), 'b');
  await a.sync();
  await b.sync();
  await rm(path.join(b.dir, 'Gone'), { recursive: true });
  await rm(path.join(b.dir, 'bye.txt'));
  await b.sync();
  await a.sync();
  assert.deepEqual(await tree(a.dir), { 'keep.txt': 'k' });
  assert.deepEqual(a.trashed.sort(), ['Gone', 'bye.txt']);
  const trash = await api.json<{ name: string }[]>('GET', '/api/trash');
  assert.ok(trash.some((t) => t.name === 'bye.txt'), 'in the server trash');
});

test('edits on both sides keep both copies', { skip }, async () => {
  const { a, b } = await setup('conflict');
  await writeFile(path.join(a.dir, 'note.txt'), 'base');
  await a.sync();
  await b.sync();
  await later();
  await writeFile(path.join(a.dir, 'note.txt'), 'from a!');
  await writeFile(path.join(b.dir, 'note.txt'), 'from b, longer');
  await a.sync();
  await b.sync();
  await a.sync();
  const ta = await tree(a.dir);
  const tb = await tree(b.dir);
  assert.deepEqual(ta, tb);
  assert.equal(ta['note.txt'], 'from a!');
  const copy = Object.keys(tb).find((k) => k.startsWith('note (conflicted copy '));
  assert.ok(copy && tb[copy] === 'from b, longer', 'b’s version kept as a conflicted copy');
});

test('first sync of identical files compares them instead of making copies', { skip }, async () => {
  const { a, b } = await setup('compare');
  await writeFile(path.join(a.dir, 'same.txt'), 'identical');
  await writeFile(path.join(a.dir, 'diff.txt'), 'version A');
  await a.sync();
  await writeFile(path.join(b.dir, 'same.txt'), 'identical');
  await writeFile(path.join(b.dir, 'diff.txt'), 'version B');
  await b.sync();
  const tb = await tree(b.dir);
  assert.equal(Object.keys(tb).filter((k) => k.startsWith('same')).length, 1);
  assert.equal(tb['diff.txt'], 'version A');
  assert.ok(Object.keys(tb).some((k) => k.startsWith('diff (conflicted copy ')));
});

test('large files go up and down in chunks', { skip }, async () => {
  const { a, b } = await setup('large');
  const big = Buffer.alloc(9 * 1024 * 1024 + 123, 7);
  big.write('start', 0);
  big.write('end', big.length - 3);
  await writeFile(path.join(a.dir, 'big.bin'), big);
  await a.sync();
  await b.sync();
  assert.ok((await readFile(path.join(b.dir, 'big.bin'))).equals(big));
});

test('mass deletions ask first, and "no" puts the files back', { skip }, async () => {
  const { a, b } = await setup('mass', { confirm: () => false });
  await mkdir(path.join(a.dir, 'Many'));
  for (let i = 0; i < 120; i++) await writeFile(path.join(a.dir, `Many/f${i}.txt`), String(i));
  await a.sync();
  await b.sync();
  await rm(path.join(b.dir, 'Many'), { recursive: true });
  await b.sync();
  assert.deepEqual(b.confirms, [120]);
  await b.sync();
  assert.equal((await readdir(path.join(b.dir, 'Many'))).length, 120, 'downloaded again');
  await a.sync();
  assert.equal((await readdir(path.join(a.dir, 'Many'))).length, 120);
});

test('server-side rename and selective sync', { skip }, async () => {
  const { a } = await setup('remote');
  await mkdir(path.join(a.dir, 'Photos'));
  await mkdir(path.join(a.dir, 'Work'));
  await writeFile(path.join(a.dir, 'Photos/p.jpg'), 'jpg');
  await writeFile(path.join(a.dir, 'Work/w.txt'), 'w');
  await a.sync();
  await api.move(a.state!.base['Work/w.txt'].id!, a.state!.base['Photos'].id!, 'renamed.txt');
  await a.sync();
  assert.deepEqual(await tree(a.dir), { 'Photos/': '', 'Photos/p.jpg': 'jpg', 'Photos/renamed.txt': 'w', 'Work/': '' });
  assert.deepEqual(a.trashed, []);

  await a.engine.setExcluded(['Photos']);
  await a.sync();
  assert.deepEqual(await tree(a.dir), { 'Work/': '' }, 'excluded folder removed here only');
  const listing = await api.node(a.state!.rootId);
  assert.ok(listing.children!.some((c) => c.name === 'Photos'), 'still on the server');
  await a.engine.setExcluded([]);
  await a.sync();
  assert.equal(await readFile(path.join(a.dir, 'Photos/renamed.txt'), 'utf8'), 'w');
});

test('no server: offline, nothing touched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-offline-'));
  await writeFile(path.join(dir, 'keep.txt'), 'k');
  const engine = new SyncEngine({
    api: new Api('http://127.0.0.1:9', 'token'), root: dir, rootId: 1, live: false,
    state: { rootId: 1, base: { 'keep.txt': { dir: false, id: 5, etag: 'e', size: 1, mtime: 1 } }, folders: {} },
    saveState: async () => {}, trash: async () => { throw new Error('must not delete'); },
  });
  await engine.sync();
  engine.stop();
  assert.equal(engine.status.phase, 'offline');
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'k');
});

test('sync folder missing (drive not mounted): stops instead of deleting on the server', async () => {
  let deleted = false;
  const api = new Api('http://127.0.0.1:9', 'token');
  api.trash = async () => { deleted = true; };
  const engine = new SyncEngine({
    api, root: path.join(tmpdir(), `cloudy-missing-${Date.now()}`), rootId: 1, live: false,
    state: { rootId: 1, base: { 'a.txt': { dir: false, id: 5, etag: 'e', size: 1, mtime: 1 } }, folders: {} },
    saveState: async () => {}, trash: async () => {},
  });
  await engine.sync();
  engine.stop();
  assert.equal(engine.status.phase, 'error');
  assert.match(engine.status.error ?? '', /Folder not found/);
  assert.equal(deleted, false);
});

test('paths the scan cannot read are left alone on the server', { skip }, async () => {
  const { a, b } = await setup('unknown');
  await mkdir(path.join(a.dir, 'Photos'));
  await writeFile(path.join(a.dir, 'Photos/p.txt'), 'p');
  await mkdir(path.join(a.dir, 'Locked'));
  await writeFile(path.join(a.dir, 'Locked/l.txt'), 'l');
  await writeFile(path.join(a.dir, 'note.txt'), 'n');
  await a.sync();

  // Photos moved to an external disk and replaced by a symlink; Locked made unreadable: neither is "deleted".
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'cloudy-elsewhere-'));
  await rename(path.join(a.dir, 'Photos'), path.join(elsewhere, 'Photos'));
  await symlink(path.join(elsewhere, 'Photos'), path.join(a.dir, 'Photos'));
  await chmod(path.join(a.dir, 'Locked'), 0o000);
  try {
    const problems = await a.sync();
    assert.ok(problems.some((p) => p.path === 'Locked'), 'unreadable folder is reported');
  } finally {
    await chmod(path.join(a.dir, 'Locked'), 0o755);
  }
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Locked/': '', 'Locked/l.txt': 'l', 'Photos/': '', 'Photos/p.txt': 'p', 'note.txt': 'n' }, 'still all on the server');

  // readable again: back to normal, nothing lost
  await a.sync();
  assert.deepEqual(a.trashed, []);
});

test('a second spelling of a name on the server does not delete the local file', { skip, }, async () => {
  const { a, folder } = await setup('case');
  await writeFile(path.join(a.dir, 'Photo.jpg'), 'one');
  await a.sync();
  const dup = await api.mkdir(folder.id, 'photo.jpg'); // the web app allows it; macOS/Windows cannot hold both
  const engine = new SyncEngine({
    api, root: a.dir, rootId: folder.id, live: false, platform: 'darwin', state: a.state!,
    saveState: async () => {}, trash: async () => { throw new Error('must not delete'); },
  });
  await engine.sync();
  assert.equal(engine.status.phase, 'idle', engine.status.error);
  assert.ok(engine.problems.some((p) => p.path.toLowerCase() === 'photo.jpg'), 'the duplicate is reported');
  assert.equal(await readFile(path.join(a.dir, 'Photo.jpg'), 'utf8'), 'one');
  const listing = await api.node(folder.id);
  assert.equal(listing.children!.filter((c) => c.name.toLowerCase() === 'photo.jpg').length, 2, 'nothing removed on the server');
  await api.trash(dup.id);
});

// ---------------------------------------------------------------- regression tests (review 2026-11-04)

/** How the temp folder's filesystem compares names (APFS: both true; ext4: both false). */
async function folding(): Promise<{ caseFold: boolean; normFold: boolean }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-fold-'));
  await writeFile(path.join(dir, 'xé'), '');
  const exists = async (n: string) => !!(await lstat(path.join(dir, n)).catch(() => null));
  const out = { caseFold: await exists('XÉ'), normFold: await exists('xé') };
  await rm(dir, { recursive: true, force: true });
  return out;
}
const fold = await folding();
const noCaseFold = skip || (!fold.caseFold && 'the temp folder is case-sensitive');
const noNormFold = skip || (!fold.normFold && 'the temp folder does not fold Unicode forms');

/** Server listing of a folder, by name. */
async function names(id: number): Promise<string[]> {
  return ((await api.node(id)).children ?? []).map((c) => c.name).sort();
}

test('Electron network errors (net::ERR_*) mean offline, and nothing is touched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-netfail-'));
  await writeFile(path.join(dir, 'keep.txt'), 'k');
  const fetchImpl = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };
  const engine = new SyncEngine({
    api: new Api('https://cloud.example', 'token', 'test', fetchImpl), root: dir, rootId: 1, live: false,
    state: { rootId: 1, base: { 'keep.txt': { dir: false, id: 5, etag: 'e', size: 1, mtime: 1 } }, folders: {} },
    saveState: async () => {}, trash: async () => { throw new Error('must not delete'); },
  });
  await engine.sync();
  await engine.stop();
  assert.equal(engine.status.phase, 'offline');
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'k');
});

test('live events: a stream that goes silent ends (so the engine reconnects) instead of hanging', async () => {
  const fetchImpl = async (_url: string, init?: RequestInit) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('retry: 5000\n\n'));
      init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const t0 = Date.now();
  await assert.rejects(new Api('https://cloud.example', 't', 'test', fetchImpl).events(() => {}, new AbortController().signal, 300),
    (e: any) => e.code === 'ETIMEDOUT');
  assert.ok(Date.now() - t0 < 5000);
});

test('storage full (507) on one upload does not stop the downloads of the same cycle', { skip }, async () => {
  const { a, b } = await setup('quota');
  await writeFile(path.join(a.dir, 'from-a.txt'), 'a');
  await a.sync();
  await writeFile(path.join(b.dir, 'from-b.txt'), 'b');
  b.engine.api.upload = async () => { throw new ApiError(507, 'Storage quota exceeded'); };
  const problems = await b.sync(); // asserts phase idle, not "error"
  assert.ok(problems.some((p) => p.path === 'from-b.txt' && /quota/i.test(p.message)));
  assert.equal(await readFile(path.join(b.dir, 'from-a.txt'), 'utf8'), 'a', 'downloaded anyway');
});

test('a folder deleted on the server while a file was added to it here comes back with that file', { skip }, async () => {
  const { a, b, folder } = await setup('trashed-parent');
  await mkdir(path.join(a.dir, 'Proj'));
  await writeFile(path.join(a.dir, 'Proj/old.txt'), 'old');
  await a.sync();
  await api.trash(a.state!.base['Proj'].id!);
  await writeFile(path.join(a.dir, 'Proj/new.txt'), 'new');
  assert.deepEqual(await a.sync(), []);
  await a.sync();
  assert.deepEqual(await names(folder.id), ['Proj']);
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Proj/': '', 'Proj/new.txt': 'new' }, 'the new file reached the server');
  assert.deepEqual(a.trashed, ['Proj/old.txt'], 'the file deleted on the server went to the trash here');
});

test('two conflicts on the same file in the same second keep every copy', { skip }, async () => {
  const fixed = () => new Date(2026, 10, 4, 12, 0, 0);
  const { a, b } = await setup('conflict-twice', { now: fixed });
  await writeFile(path.join(a.dir, 'note.txt'), 'base');
  await a.sync();
  await b.sync();
  for (const round of ['1', '2']) {
    await later();
    await writeFile(path.join(a.dir, 'note.txt'), `a${round}`);
    await writeFile(path.join(b.dir, 'note.txt'), `from b, round ${round}`);
    await a.sync();
    await b.sync();
  }
  const tb = await tree(b.dir);
  const copies = Object.entries(tb).filter(([k]) => k.startsWith('note (conflicted copy ')).map(([, v]) => v).sort();
  assert.deepEqual(copies, ['from b, round 1', 'from b, round 2']);
  assert.equal(tb['note.txt'], 'a2');
});

test('a short download never replaces the local file', { skip }, async () => {
  const { a, b } = await setup('short');
  await writeFile(path.join(a.dir, 'doc.txt'), 'first version');
  await a.sync();
  await b.sync();
  await later();
  await writeFile(path.join(a.dir, 'doc.txt'), 'second version, longer');
  await a.sync();
  const real = b.engine.api.download.bind(b.engine.api);
  b.engine.api.download = async (id, dest) => { await writeFile(dest, 'second'); }; // cut off, but "successful"
  const problems = await b.sync();
  assert.ok(problems.some((p) => p.path === 'doc.txt'), 'reported');
  assert.equal(await readFile(path.join(b.dir, 'doc.txt'), 'utf8'), 'first version', 'not replaced by the short copy');
  b.engine.api.download = real;
  await b.sync();
  assert.equal(await readFile(path.join(b.dir, 'doc.txt'), 'utf8'), 'second version, longer');
});

test('a folder deleted on the server is not removed here when a file was added to it during the cycle', { skip }, async () => {
  const { a, b } = await setup('late-add');
  await mkdir(path.join(a.dir, 'Gone'));
  await writeFile(path.join(a.dir, 'Gone/x.txt'), 'x');
  await a.sync();
  await b.sync();
  await rm(path.join(b.dir, 'Gone'), { recursive: true });
  await b.sync();
  const scan = a.engine.scanLocal.bind(a.engine);
  a.engine.scanLocal = async () => {
    const out = await scan();
    await writeFile(path.join(a.dir, 'Gone/late.txt'), 'written after the scan'); // e.g. saved while files transfer
    return out;
  };
  await a.sync();
  a.engine.scanLocal = scan;
  assert.ok(!a.trashed.includes('Gone'), 'the folder was not removed as a whole');
  assert.equal(await readFile(path.join(a.dir, 'Gone/late.txt'), 'utf8'), 'written after the scan');
  await a.sync();
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Gone/': '', 'Gone/late.txt': 'written after the scan' });
});

test('excluding a folder that has changes not on the server yet keeps it on this computer', { skip }, async () => {
  const { a, folder } = await setup('exclude-kept');
  await mkdir(path.join(a.dir, 'Photos'));
  await writeFile(path.join(a.dir, 'Photos/p.jpg'), 'p');
  await mkdir(path.join(a.dir, 'Work'));
  await writeFile(path.join(a.dir, 'Work/w.txt'), 'w');
  await a.sync();
  await writeFile(path.join(a.dir, 'Photos/new.jpg'), 'not uploaded yet');
  const kept: string[] = [];
  a.engine.on('kept', (f: string) => kept.push(f));
  await a.engine.setExcluded(['Photos', 'Work']);
  await a.sync();
  assert.deepEqual(kept, ['Photos']);
  assert.deepEqual(a.trashed, ['Work'], 'the unchanged folder is removed here');
  assert.equal(await readFile(path.join(a.dir, 'Photos/new.jpg'), 'utf8'), 'not uploaded yet');
  assert.deepEqual(await names(folder.id), ['Photos', 'Work'], 'both stay on the server');
});

test('an emptied sync folder (e.g. a disk not mounted) asks before deleting on the server, even with few files', { skip }, async () => {
  const { a, folder } = await setup('emptied', { confirm: () => false });
  for (const n of ['1.txt', '2.txt', '3.txt']) await writeFile(path.join(a.dir, n), n);
  await a.sync();
  for (const n of ['1.txt', '2.txt', '3.txt']) await rm(path.join(a.dir, n));
  await a.sync();
  assert.deepEqual(a.confirms, [3]);
  assert.deepEqual(await names(folder.id), ['1.txt', '2.txt', '3.txt']);
  await a.sync();
  assert.deepEqual(Object.keys(await tree(a.dir)).sort(), ['1.txt', '2.txt', '3.txt'], 'copied back');
});

test('a listing that fails while walking (404) leaves the files in that folder alone', { skip }, async () => {
  const { a } = await setup('walk-404');
  await mkdir(path.join(a.dir, 'F'));
  await writeFile(path.join(a.dir, 'F/one.txt'), '1');
  await a.sync();
  const fid = a.state!.base['F'].id!;
  const real = a.engine.api.node;
  a.engine.api.node = async (id) => { if (id === fid) throw new ApiError(404, 'Not found'); return real(id); };
  a.engine.state.folders = {}; // listings are read again
  await a.sync();
  a.engine.api.node = real;
  assert.deepEqual(a.trashed, []);
  assert.equal(await readFile(path.join(a.dir, 'F/one.txt'), 'utf8'), '1');
});

test('a sync state from another folder is not applied to this one', { skip }, async () => {
  const { a, b } = await setup('other-root');
  await writeFile(path.join(a.dir, 'a.txt'), 'a');
  await a.sync();
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-other-'));
  const engine = new SyncEngine({
    api, root: dir, rootId: a.state!.rootId, live: false, state: structuredClone(a.state!),
    saveState: async () => {}, trash: async () => { throw new Error('must not delete'); },
  });
  await engine.sync();
  assert.equal(engine.status.phase, 'idle', engine.status.error);
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'a', 'downloaded, not deleted on the server');
  await b.sync();
  assert.equal(await readFile(path.join(b.dir, 'a.txt'), 'utf8'), 'a');
});

test('stop() aborts a running download at once and does not report it as an error', { skip }, async () => {
  const { a, b } = await setup('stop');
  await writeFile(path.join(a.dir, 'slow.bin'), 'x');
  await a.sync();
  let started!: () => void;
  const begun = new Promise<void>((r) => { started = r; });
  b.engine.api.download = (_id, _dest, signal) => new Promise((_resolve, reject) => {
    started();
    signal!.addEventListener('abort', () => reject(signal!.reason));
  });
  const running = b.engine.sync();
  await begun;
  const t0 = Date.now();
  await b.engine.stop({ save: true });
  await running;
  assert.ok(Date.now() - t0 < 2000, 'stopped quickly');
  assert.notEqual(b.engine.status.phase, 'error');
  assert.ok(b.state, 'saved once on stop');
  assert.equal(b.state!.base['slow.bin'], undefined, 'the aborted download is not recorded');
});

test('an upload chunk that fails on the way is retried from what the server stored', { skip }, async () => {
  const { a, b } = await setup('retry');
  let cut = 0;
  a.engine.api.fetch = async (url, init) => {
    const res = await fetch(url, init);
    // The first chunk reaches the server, but its answer is lost.
    if (init?.method === 'PUT' && url.includes('/api/uploads/') && cut++ === 0) throw new TypeError('fetch failed');
    return res;
  };
  const big = Buffer.alloc(9 * 1024 * 1024, 3);
  big.write('tail', big.length - 4);
  await writeFile(path.join(a.dir, 'big.bin'), big);
  assert.deepEqual(await a.sync(), []);
  assert.equal(cut, 2, 'one retry, then the second (last) chunk');
  await b.sync();
  assert.ok((await readFile(path.join(b.dir, 'big.bin'))).equals(big));
});

test('a case-only rename on the server is repeated here, without a conflicted copy', { skip: noCaseFold }, async () => {
  const { a, folder } = await setup('case-rename');
  await writeFile(path.join(a.dir, 'Photo.jpg'), 'one');
  await a.sync();
  await api.move(a.state!.base['Photo.jpg'].id!, folder.id, 'photo.jpg');
  assert.deepEqual(await a.sync(), []);
  assert.deepEqual(await readdir(a.dir), ['photo.jpg']);
  assert.deepEqual(await names(folder.id), ['photo.jpg']);
  assert.deepEqual(a.trashed, []);
});

test('a case-only rename here is repeated on the server', { skip: noCaseFold }, async () => {
  const { a, folder } = await setup('case-rename-local');
  await writeFile(path.join(a.dir, 'report.pdf'), 'r');
  await a.sync();
  await rename(path.join(a.dir, 'report.pdf'), path.join(a.dir, 'Report.pdf'));
  await a.sync();
  assert.deepEqual(await names(folder.id), ['Report.pdf']);
  await a.sync();
  assert.deepEqual(await names(folder.id), ['Report.pdf'], 'stable');
});

test('first sync: a local folder spelled differently from the server folder is merged into it', { skip: noCaseFold }, async () => {
  const { a, b, folder } = await setup('case-merge');
  await mkdir(path.join(b.dir, 'Docs'));
  await writeFile(path.join(b.dir, 'Docs/theirs.txt'), 'theirs');
  await b.sync();
  await mkdir(path.join(a.dir, 'docs'));
  await writeFile(path.join(a.dir, 'docs/mine.txt'), 'mine');
  for (let i = 0; i < 3; i++) assert.deepEqual(await a.sync(), []);
  assert.deepEqual(await names(folder.id), ['Docs'], 'one folder on the server, not renamed, nothing trashed');
  assert.deepEqual(a.trashed, []);
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Docs/': '', 'Docs/mine.txt': 'mine', 'Docs/theirs.txt': 'theirs' });
  assert.deepEqual(Object.keys(await tree(a.dir)).sort(), ['docs/', 'docs/mine.txt', 'docs/theirs.txt']);
});

test('a decomposed (NFD) local name is the same file as the composed (NFC) server name', { skip: noNormFold }, async () => {
  const { a, b, folder } = await setup('nfd');
  await writeFile(path.join(b.dir, 'café.txt'), 'same');
  await b.sync();
  await writeFile(path.join(a.dir, 'café.txt'), 'same');
  for (let i = 0; i < 2; i++) assert.deepEqual(await a.sync(), []);
  assert.deepEqual(await names(folder.id), ['café.txt'], 'no duplicate, not renamed');
  assert.deepEqual(a.trashed, []);
});

test('a local symlink spelled differently from a server folder is never written through', { skip: noCaseFold }, async () => {
  const { a, b } = await setup('case-symlink');
  const outside = await mkdtemp(path.join(tmpdir(), 'cloudy-outside-'));
  await symlink(outside, path.join(a.dir, 'Photos'));
  await mkdir(path.join(b.dir, 'photos'));
  await writeFile(path.join(b.dir, 'photos/x.txt'), 'x');
  await b.sync();
  await a.sync();
  assert.deepEqual(await readdir(outside), [], 'nothing written outside the sync folder');
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'photos/': '', 'photos/x.txt': 'x' }, 'and nothing deleted on the server');
});

test('a folder replaced by a symlink after the scan is not written through', { skip }, async () => {
  const { a, b } = await setup('swap-symlink');
  await mkdir(path.join(a.dir, 'Sub'));
  await a.sync();
  await b.sync();
  await writeFile(path.join(b.dir, 'Sub/new.txt'), 'n');
  await b.sync();
  const outside = await mkdtemp(path.join(tmpdir(), 'cloudy-outside-'));
  const scan = a.engine.scanLocal.bind(a.engine);
  a.engine.scanLocal = async () => {
    const out = await scan();
    await rm(path.join(a.dir, 'Sub'), { recursive: true });
    await symlink(outside, path.join(a.dir, 'Sub'));
    return out;
  };
  const problems = await a.sync();
  a.engine.scanLocal = scan;
  assert.deepEqual(await readdir(outside), [], 'nothing written outside the sync folder');
  assert.ok(problems.some((p) => p.path === 'Sub/new.txt'));
});

// ---------------------------------------------------------------- second review (2026-11-04)

test('an edit on the server of a file spelled differently here (case) is not turned into a rename', { skip: noCaseFold }, async () => {
  const { a, b, folder } = await setup('case-edit');
  await writeFile(path.join(b.dir, 'Report.txt'), 'v1');
  await b.sync();
  await writeFile(path.join(a.dir, 'report.txt'), 'v1'); // the same file, already here in another case
  await a.sync();
  await later();
  await writeFile(path.join(b.dir, 'Report.txt'), 'v2, edited elsewhere');
  await b.sync();
  for (let i = 0; i < 2; i++) assert.deepEqual(await a.sync(), []);
  assert.deepEqual(await names(folder.id), ['Report.txt'], 'the server spelling is kept');
  assert.deepEqual(await readdir(a.dir), ['report.txt']);
  assert.equal(await readFile(path.join(a.dir, 'report.txt'), 'utf8'), 'v2, edited elsewhere');
});

test('an interrupted first sync keeps the server spelling of a folder spelled differently here', { skip: noCaseFold }, async () => {
  const { a, b, folder } = await setup('case-interrupted');
  await mkdir(path.join(b.dir, 'Photos'));
  await writeFile(path.join(b.dir, 'Photos/a.txt'), 'aaa');
  await b.sync();
  await mkdir(path.join(a.dir, 'photos'));
  await writeFile(path.join(a.dir, 'photos/b.txt'), 'bbbb');
  const upload = a.engine.api.upload;
  a.engine.api.upload = async () => { throw new TypeError('fetch failed'); }; // the network drops mid-cycle
  await a.engine.sync();
  assert.equal(a.engine.status.phase, 'offline');
  a.engine.api.upload = upload;
  // The app restarts from what was saved (as after quitting mid-cycle).
  const again = new SyncEngine({
    api, root: a.dir, rootId: folder.id, live: false, state: structuredClone(a.state!),
    saveState: async () => {}, trash: async () => { throw new Error('must not delete'); },
  });
  for (let i = 0; i < 2; i++) {
    await again.sync();
    assert.equal(again.status.phase, 'idle', again.status.error);
  }
  assert.deepEqual(await names(folder.id), ['Photos'], 'not renamed to "photos"');
  const photos = (await api.node(folder.id)).children!.find((c) => c.name === 'Photos')!;
  assert.deepEqual(await names(photos.id), ['a.txt', 'b.txt']);
});

test('a folder two levels up replaced by a symlink after the scan gets nothing created through it', { skip }, async () => {
  const { a, b } = await setup('swap-symlink-deep');
  await mkdir(path.join(a.dir, 'Top/Sub'), { recursive: true });
  await a.sync();
  await b.sync();
  await writeFile(path.join(b.dir, 'Top/Sub/new.txt'), 'n');
  await b.sync();
  const outside = await mkdtemp(path.join(tmpdir(), 'cloudy-outside-'));
  const scan = a.engine.scanLocal.bind(a.engine);
  a.engine.scanLocal = async () => {
    const out = await scan();
    await rm(path.join(a.dir, 'Top'), { recursive: true });
    await symlink(outside, path.join(a.dir, 'Top'));
    return out;
  };
  const problems = await a.sync();
  a.engine.scanLocal = scan;
  assert.deepEqual(await readdir(outside), [], 'no folders or files created at the link target');
  assert.ok(problems.some((p) => p.path === 'Top/Sub/new.txt'));
});

/** A server answering only the root listing (for stateFitsServer). */
const fakeRoot = (children: { id: number; name: string; isDir: boolean; etag: string }[]) => ({
  node: async () => ({ node: { id: 1, name: '', isDir: true, size: 0, etag: 'r', mtime: '', parentId: null },
    children: children.map((c) => ({ ...c, size: 0, mtime: '', parentId: 1 })) }),
});
const savedState = (children: { id: number; name: string; isDir: boolean; etag: string }[]): SyncState => ({
  rootId: 1,
  base: Object.fromEntries(children.map((c) => [c.name, { dir: c.isDir, id: c.id, etag: c.etag, size: 0, mtime: 0 }])),
  folders: { '': { id: 1, etag: 'r', children: children.map((c) => ({ ...c, size: 0, mtime: '' })) } },
});

test('signing in again: a state that still fits the server is kept, one from a reset server is not', async () => {
  const before = [
    { id: 2, name: 'Photos', isDir: true, etag: 'p' },
    { id: 3, name: 'Work', isDir: true, etag: 'w' },
    { id: 4, name: 'notes.txt', isDir: false, etag: 'n' },
  ];
  const state = savedState(before);
  assert.equal(await stateFitsServer(fakeRoot(before), state), true, 'unchanged');
  assert.equal(await stateFitsServer(fakeRoot([{ ...before[0], etag: 'p2' }, { ...before[1], name: 'Jobs' }, before[2]]), state), true,
    'a folder edited and one renamed meanwhile');
  assert.equal(await stateFitsServer(fakeRoot([...before, { id: 9, name: 'New', isDir: true, etag: 'x' }]), state), true, 'something added');
  // Reset server, account recreated: ids start again and now name other things.
  assert.equal(await stateFitsServer(fakeRoot([{ id: 2, name: 'Work', isDir: true, etag: 'a' }, { id: 3, name: 'Photos', isDir: true, etag: 'b' }]), state), false);
  assert.equal(await stateFitsServer(fakeRoot([{ id: 2, name: 'Photos', isDir: true, etag: 'a' }, { id: 3, name: 'Work', isDir: true, etag: 'b' },
    { id: 4, name: 'notes', isDir: true, etag: 'c' }]), state), false, 'an id that changed between file and folder');
  assert.equal(await stateFitsServer(fakeRoot([]), state), false, 'empty server');
  assert.equal(await stateFitsServer(fakeRoot([{ id: 4, name: 'notes.txt', isDir: false, etag: 'other' }]), state), false, 'same name, new content id');
  assert.equal(await stateFitsServer(fakeRoot([]), { rootId: 1, base: {}, folders: {} }), true, 'nothing synced yet');
  assert.equal(await stateFitsServer(fakeRoot(before), { rootId: 1, base: state.base, folders: {} }), false, 'no listing to compare with');
});

// ---------------------------------------------------------------- watcher, incremental scans, own writes

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Starts the engine (watcher) and waits for its first cycle to finish. */
async function startEngine(engine: SyncEngine): Promise<void> {
  const before = engine.status.lastSync ?? 0;
  engine.start();
  await waitFor('first cycle after start', () => (engine.status.lastSync ?? 0) > before && engine.status.phase === 'idle');
}

/** Counts the cycles an engine runs. */
function countCycles(engine: SyncEngine) {
  const counter = { n: 0 };
  const cycle = engine.cycle.bind(engine);
  engine.cycle = async () => { counter.n++; return cycle(); };
  return counter;
}

test('with the watcher, local changes are synced by reading only the folders that changed', { skip }, async () => {
  const { a, b } = await setup('watch');
  for (let i = 0; i < 20; i++) {
    await mkdir(path.join(a.dir, `F${i}`));
    await writeFile(path.join(a.dir, `F${i}/x.txt`), `x${i}`);
  }
  await a.sync();
  try {
    await startEngine(a.engine);
    const synced = async (want: Record<string, string>) => {
      await b.sync();
      const t = await tree(b.dir);
      return Object.entries(want).every(([k, v]) => (v === '<gone>' ? !(k in t) : t[k] === v));
    };

    await writeFile(path.join(a.dir, 'F3/new.txt'), 'new');
    await waitFor('new file uploaded', () => synced({ 'F3/new.txt': 'new' }));
    assert.equal(a.engine.lastScan.full, false, 'an incremental scan');
    assert.ok(a.engine.lastScan.read <= 3, `read ${a.engine.lastScan.read} of ${a.engine.lastScan.dirs} folders`);

    await later();
    await writeFile(path.join(a.dir, 'F4/x.txt'), 'edited');
    await waitFor('edit uploaded', () => synced({ 'F4/x.txt': 'edited' }));

    await mkdir(path.join(a.dir, 'New/Sub'), { recursive: true });
    await writeFile(path.join(a.dir, 'New/Sub/deep.txt'), 'deep');
    await waitFor('new nested folder uploaded', () => synced({ 'New/Sub/deep.txt': 'deep' }));

    await rename(path.join(a.dir, 'F5'), path.join(a.dir, 'Renamed'));
    await waitFor('folder rename', () => synced({ 'Renamed/x.txt': 'x5', 'F5/x.txt': '<gone>' }));

    await rm(path.join(a.dir, 'F6'), { recursive: true });
    await waitFor('folder deletion', () => synced({ 'F6/x.txt': '<gone>' }));
    assert.deepEqual(a.engine.problems, []);
  } finally {
    await a.engine.stop();
  }
});

test("the engine's own downloads do not start another cycle", { skip }, async () => {
  const { a, b } = await setup('echo');
  await writeFile(path.join(a.dir, 'one.txt'), '1');
  await a.sync();
  await b.sync();
  try {
    await startEngine(a.engine);
    const cycles = countCycles(a.engine);
    await mkdir(path.join(b.dir, 'Dir'));
    await writeFile(path.join(b.dir, 'Dir/two.txt'), '2');
    await writeFile(path.join(b.dir, 'one.txt'), 'one, edited');
    await b.sync();
    a.engine.schedule(0); // what the server's live event does
    await waitFor('downloads', async () => (await tree(a.dir))['Dir/two.txt'] === '2' && a.engine.status.phase === 'idle');
    assert.equal(await readFile(path.join(a.dir, 'one.txt'), 'utf8'), 'one, edited');
    const after = cycles.n;
    await new Promise((r) => setTimeout(r, 4000)); // the watcher's events for those writes arrive meanwhile
    assert.equal(cycles.n, after, 'no cycle for its own writes');

    // A real edit right after is still seen.
    await later();
    await writeFile(path.join(a.dir, 'Dir/two.txt'), 'two, edited by the user');
    await waitFor('user edit uploaded', async () => { await b.sync(); return (await tree(b.dir))['Dir/two.txt'] === 'two, edited by the user'; });
  } finally {
    await a.engine.stop();
  }
});

test('when the watcher fails, every cycle reads the whole folder again', { skip }, async () => {
  const { a } = await setup('watch-failed');
  await mkdir(path.join(a.dir, 'D'));
  try {
    await startEngine(a.engine);
    a.engine.watcherFailed();
    await writeFile(path.join(a.dir, 'D/f.txt'), 'f');
    await waitFor('cycle after the failure', () => a.engine.status.phase === 'idle' && a.engine.lastScan.full && a.engine.lastScan.read === a.engine.lastScan.dirs);
    a.engine.schedule(0);
    await waitFor('uploaded', async () => !!(await api.node(a.engine.rootId)).children?.find((c) => c.name === 'D'));
  } finally {
    await a.engine.stop();
  }
});

test('files that are the same on both sides are not downloaded when the server knows their hash', { skip }, async () => {
  const { a, b } = await setup('hash');
  await writeFile(path.join(a.dir, 'same.txt'), 'same content');
  await writeFile(path.join(a.dir, 'differs.txt'), 'version A');
  await a.sync();
  const listed = (await api.node(a.engine.rootId)).children!;
  if (!listed.some((c) => c.sha256)) return; // a server before 1.16: nothing to test
  await later();
  await writeFile(path.join(b.dir, 'same.txt'), 'same content'); // already there (another copy, other time)
  await writeFile(path.join(b.dir, 'differs.txt'), 'version B'); // same size, other content
  let downloads = 0;
  const download = b.engine.api.download.bind(b.engine.api);
  b.engine.api.download = async (...args) => { downloads++; return download(...args); };
  await b.sync();
  assert.equal(downloads, 1, 'only the file that differs');
  const t = await tree(b.dir);
  assert.equal(t['same.txt'], 'same content');
  assert.equal(t['differs.txt'], 'version A');
  assert.equal(Object.values(t).filter((v) => v === 'version B').length, 1, 'ours kept as a conflicted copy');
});

test('many folders deleted at once are synced in one go', { skip }, async () => {
  const { a, b } = await setup('many-deletes');
  for (let i = 0; i < 150; i++) {
    await mkdir(path.join(a.dir, `Top/D${i}`), { recursive: true });
    await writeFile(path.join(a.dir, `Top/D${i}/f.txt`), String(i));
  }
  await writeFile(path.join(a.dir, 'Top/keep.txt'), 'keep');
  await a.sync();
  await b.sync();
  for (let i = 0; i < 150; i++) await rm(path.join(a.dir, `Top/D${i}`), { recursive: true });
  await a.sync();
  assert.deepEqual(a.confirms, [150], 'asked once for the 150 files');
  await b.sync();
  assert.deepEqual(await tree(b.dir), { 'Top/': '', 'Top/keep.txt': 'keep' });
  assert.equal(Object.keys(a.state!.base).length, 2, 'base holds only what is left');
});

test('the state is stored compactly and reads back the same (also the older form)', async () => {
  const state: SyncState = {
    rootId: 7, root: '/x',
    base: { 'a': { dir: true, id: 2, size: 0, mtime: 0, ino: 11 }, 'a/f.txt': { dir: false, id: 3, etag: 'e', rmtime: 'm', size: 5, mtime: 9, ino: 12, lname: 'F.txt' }, 'new': { dir: false, size: 1, mtime: 2 } },
    folders: { '': { id: 7, etag: 'r', children: [{ id: 2, name: 'a', isDir: true, size: 0, etag: 'x', mtime: 't' }] },
      'a': { id: 2, etag: 'x', children: [{ id: 3, name: 'f.txt', isDir: false, size: 5, etag: 'e', mtime: 'm', sha256: 'abc' }] } },
  };
  const packed = JSON.parse(JSON.stringify(packState(state)));
  assert.deepEqual(unpackState(packed), state);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(state).length * 0.75);
  assert.deepEqual(unpackState(JSON.parse(JSON.stringify(state))), state, 'version 1 file');
  assert.equal(unpackState(null), null);
  assert.equal(unpackState({ v: 2, rootId: 1, base: 5, folders: {} }), null, 'damaged');
});

test('two folders swapped by renames while the watcher runs: nothing is deleted on the server', { skip }, async () => {
  const { a, folder } = await setup('swap');
  await mkdir(path.join(a.dir, 'A/x'), { recursive: true });
  await mkdir(path.join(a.dir, 'B/x'), { recursive: true });
  await writeFile(path.join(a.dir, 'A/x/f1.txt'), 'one');
  await writeFile(path.join(a.dir, 'B/x/f2.txt'), 'two');
  await a.sync();
  const list = async (p: string) => {
    let id = folder.id;
    for (const n of p.split('/')) id = (await api.node(id)).children!.find((c) => c.name === n)!.id;
    return (await api.node(id)).children!.map((c) => c.name).sort();
  };
  try {
    await startEngine(a.engine);
    await rename(path.join(a.dir, 'A'), path.join(a.dir, 'T'));
    await rename(path.join(a.dir, 'B'), path.join(a.dir, 'A'));
    await rename(path.join(a.dir, 'T'), path.join(a.dir, 'B'));
    await waitFor('swap synced', async () => (await list('A/x')).join() === 'f2.txt' && (await list('B/x')).join() === 'f1.txt');
    await later();
    await writeFile(path.join(a.dir, 'A/x/f2.txt'), 'two, edited'); // an edit in a folder whose path was cached
    await waitFor('edit synced', async () => a.engine.status.phase === 'idle' && a.engine.lastScan.full === false
      && (await list('A/x')).join() === 'f2.txt' && (await list('B/x')).join() === 'f1.txt');
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(await list('A/x'), ['f2.txt']);
    assert.deepEqual(await list('B/x'), ['f1.txt'], 'f1 still on the server');
  } finally {
    await a.engine.stop();
  }
});

test('a folder excluded while a cycle reads the server is not deleted on the server', { skip }, async () => {
  const { a, folder } = await setup('exclude-race');
  await mkdir(path.join(a.dir, 'Keep'));
  for (let i = 0; i < 5; i++) await writeFile(path.join(a.dir, `Keep/f${i}.txt`), `f${i}`);
  for (let i = 0; i < 20; i++) await writeFile(path.join(a.dir, `other${i}.txt`), `o${i}`);
  await a.sync();
  const keepId = (await api.node(folder.id)).children!.find((c) => c.name === 'Keep')!.id;
  await api.mkdir(keepId, 'sub'); // changes Keep's etag, so the next walk lists it
  const node = a.engine.api.node.bind(a.engine.api);
  let fired = false;
  a.engine.api.node = async (id: number) => {
    const out = await node(id);
    if (id === keepId && !fired) { fired = true; await a.engine.setExcluded(['Keep']); } // unticked in Settings right now
    return out;
  };
  await a.sync();
  assert.ok(fired);
  assert.ok((await api.node(folder.id)).children!.find((c) => c.name === 'Keep'), 'Keep is still on the server');
  await a.sync(); // the next cycle removes it here (unchanged), as excluding does
  assert.ok((await api.node(folder.id)).children!.find((c) => c.name === 'Keep'), 'and still on the server');
  assert.deepEqual(a.trashed, ['Keep']);
});
