// The 2026-11-28 review: what can be checked without a database. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Before the server's modules load (they read the environment once): a scratch storage folder, and a database
// address where nothing answers (port 1), so every query fails at once.
const dataDir = await mkdtemp(path.join(tmpdir(), 'cloudy-test-'));
process.env.DATA_DIR = dataDir;
process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
const { isBusy, pool } = await import('../src/db.ts');
const { sweepBlobs, isDiskFull, blobPath } = await import('../src/files.ts');
const { allowShareNotice } = await import('../src/mail.ts');
const { attemptTotpSetup } = await import('../src/auth.ts');

after(async () => {
  await pool.end();
  await rm(dataDir, { recursive: true, force: true });
});

test('busy: the pool had no connection in time, or a lock was not free in time; nothing else', () => {
  assert.ok(isBusy(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })));
  assert.ok(isBusy(new Error('timeout exceeded when trying to connect')));
  assert.ok(isBusy(new Error('Connection terminated due to connection timeout')));
  assert.ok(!isBusy(new Error('Connection terminated unexpectedly')));
  assert.ok(!isBusy(Object.assign(new Error('duplicate key'), { code: '23505' })));
  assert.ok(!isBusy(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })));
  assert.ok(!isBusy(undefined));
});

test('full disk: ENOSPC and EDQUOT only', () => {
  assert.ok(isDiskFull(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })));
  assert.ok(isDiskFull(Object.assign(new Error('quota exceeded'), { code: 'EDQUOT' })));
  assert.ok(!isDiskFull(Object.assign(new Error('gone'), { code: 'ENOENT' })));
  assert.ok(!isDiskFull(null));
});

test('share notices: one per sharer, recipient and item an hour; sixty per sharer an hour', () => {
  const t0 = 1_000_000_000_000;
  assert.ok(allowShareNotice('ann', 'user:bob', 7, t0));
  // Shared again, after taking the share back: no second email within the hour.
  assert.ok(!allowShareNotice('ann', 'user:bob', 7, t0 + 60_000));
  assert.ok(!allowShareNotice('ann', 'user:bob', 7, t0 + 3_599_000));
  // Another item, another recipient (a group is one recipient), another sharer: each its own.
  assert.ok(allowShareNotice('ann', 'user:bob', 8, t0));
  assert.ok(allowShareNotice('ann', 'group:bob', 7, t0));
  assert.ok(allowShareNotice('cy', 'user:bob', 7, t0));
  assert.ok(allowShareNotice('ann', 'user:bob', 7, t0 + 3_600_000));
  // Sixty an hour per sharer, whoever they go to; refused ones are not counted.
  const t1 = t0 + 10 * 3_600_000;
  let sent = 0;
  for (let i = 0; i < 200; i++) if (allowShareNotice('dee', `user:u${i}`, 1, t1 + i)) sent++;
  assert.equal(sent, 60);
  assert.ok(allowShareNotice('eve', 'user:u0', 1, t1));
  assert.ok(!allowShareNotice('dee', 'user:new', 1, t1 + 3_599_000));
  assert.ok(allowShareNotice('dee', 'user:new', 1, t1 + 3_600_500));
});

test('two-factor setup: ten wrong codes per account, a right one gives its count back', () => {
  for (let i = 0; i < 10; i++) attemptTotpSetup('Mallory');
  assert.throws(() => attemptTotpSetup('mallory'), (e: any) => e.status === 429);
  for (let i = 0; i < 25; i++) attemptTotpSetup('alice').succeeded();
  assert.doesNotThrow(() => attemptTotpSetup('alice'));
});

test('leftover blobs: young files and other names are never touched; a failed query removes nothing', async () => {
  const blob = randomUUID();
  const dir = path.dirname(blobPath(blob));
  await mkdir(dir, { recursive: true });
  await writeFile(blobPath(blob), 'bytes');
  await writeFile(path.join(dir, 'notes.txt'), 'not a blob');
  await writeFile(path.join(dir, `${blob}.part`), 'not a blob either');
  // Two days by default: nothing here is that old, so the database is not even asked (it would fail).
  assert.deepEqual(await sweepBlobs(), { removed: 0, bytes: 0 });
  // Every file counts as old: the blob is a candidate, the query fails, the run ends and the file stays.
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(sweepBlobs(0, 1));
  assert.deepEqual((await readdir(dir)).sort(), [blob, `${blob}.part`, 'notes.txt'].sort());
});
