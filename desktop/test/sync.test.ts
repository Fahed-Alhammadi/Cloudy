// Sync engine against a running Cloudy server, with two engines playing two computers sharing one server folder.
//   CLOUDY_TEST_URL=http://localhost:8080 CLOUDY_TEST_USER=admin CLOUDY_TEST_PASSWORD=… npm test
// Without CLOUDY_TEST_URL the tests are skipped.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Api } from '../src/main/api.ts';
import { SyncEngine, type SyncState } from '../src/main/sync.ts';

const URL = process.env.CLOUDY_TEST_URL;
const skip = !URL && 'CLOUDY_TEST_URL not set';
let api: Api;
let rootId: number;

before(async () => {
  if (skip) return;
  const { token, user } = await Api.login(URL!, process.env.CLOUDY_TEST_USER ?? 'admin', process.env.CLOUDY_TEST_PASSWORD ?? '', undefined, 'sync test');
  api = new Api(URL!, token);
  rootId = user.rootId;
});

/** A fresh server folder and two computers syncing it. */
async function setup(name: string, opts: { confirm?: (n: number) => boolean } = {}) {
  const folder = await api.mkdir(rootId, `sync-test-${name}-${Date.now()}`);
  const make = async (label: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), `cloudy-${label}-`));
    let state: SyncState | null = null;
    const trashed: string[] = [];
    const confirms: number[] = [];
    const engine = new SyncEngine({
      api, root: dir, rootId: folder.id, live: false,
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
