// File Explorer badges (Windows): explorer/CloudyBadges.dll against the badge server, through the helper program
// explorer/build/harness.exe (built with `node explorer/build.mjs --test`). Skipped elsewhere. The registry test
// changes the registration of Cloudy's handlers, so it runs only with CLOUDY_TEST_REGISTRY=1 (CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FinderBadges } from '../src/main/finder.ts';
import type { Badge } from '../src/main/sync.ts';
import { addToList, listed, registerClasses, registeredDll, removeFromList, unregisterClasses } from '../src/main/badges-win.ts';

const build = path.join(import.meta.dirname, '..', 'explorer', 'build');
const dll = path.join(build, 'CloudyBadges.dll');
const harness = path.join(build, 'harness.exe');
const skip = process.platform !== 'win32' || !existsSync(harness) ? 'needs Windows and explorer/build (node explorer/build.mjs --test)' : false;

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(harness, args, { env: { ...process.env, ...env }, timeout: 60_000 }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out) + String(err) });
    });
  });
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-explorer-'));
  const folder = path.join(dir, 'Cloudy', 'admin');
  await mkdir(path.join(folder, 'Sub'), { recursive: true });
  for (const f of ['a.txt', 'b.txt', 'bad_.txt', 'Ünïcode.txt']) await writeFile(path.join(folder, f), 'x');
  await mkdir(path.join(dir, 'elsewhere'), { recursive: true });
  await writeFile(path.join(dir, 'elsewhere', 'x.txt'), 'x');
  const badges = new Map<string, Badge>([
    ['a.txt', 'synced'], ['b.txt', 'syncing'], ['bad_.txt', 'error'], ['sub', 'synced'], ['ünïcode.txt', 'synced'],
  ]);
  // As the app does: case does not matter on Windows.
  const badgeOf = (abs: string): Badge | null => {
    const rel = path.relative(folder, abs);
    if (!rel) return 'synced';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return badges.get(rel.toLowerCase()) ?? null;
  };
  const portFile = path.join(dir, 'finder.json');
  const fb = new FinderBadges(portFile, badgeOf);
  await fb.start();
  fb.setFolders([folder]);
  return { dir, folder, fb, badges, env: { CLOUDY_BADGES_FILE: portFile }, done: async () => { await fb.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('the overlay handlers show what the app answers, and follow changes', { skip }, async () => {
  const { dir, folder, fb, badges, env, done } = await fixture();
  try {
    const at = (n: string) => path.join(folder, n);
    let r = await run(['direct', dll,
      `${at('a.txt')}=synced`, `${at('b.txt')}=syncing`, `${at('bad_.txt')}=error`, `${at('Sub')}=synced`,
      `${at('ÜNÏCODE.TXT')}=synced`, `${folder.toUpperCase()}\\A.TXT=synced`, `${folder}=synced`,
      `${path.join(dir, 'elsewhere', 'x.txt')}=none`, `${at('unknown.txt')}=none`,
    ], env);
    assert.equal(r.code, 0, r.out);
    // Each harness run is a new process with a new connection: a change is what that one sees first.
    badges.set('b.txt', 'synced');
    fb.changed([at('b.txt')]);
    r = await run(['direct', dll, `${at('b.txt')}=synced`], env);
    assert.equal(r.code, 0, r.out);
    // Without the app: nothing.
    await fb.close();
    r = await run(['direct', dll, `${at('a.txt')}=none`], env);
    assert.equal(r.code, 0, r.out);
  } finally {
    await done();
  }
});

// Changes this machine's registry (HKLM through the administrator prompt; on CI runners, which run as administrator,
// without a prompt): CI only. Whether Explorer then draws the badges was checked with screenshots of a real Explorer.
test('the handlers are registered for this user and listed for File Explorer, and removed again', { skip: skip || (!process.env.CLOUDY_TEST_REGISTRY && 'needs CLOUDY_TEST_REGISTRY=1') }, async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'cloudy-reg-'));
  try {
    await registerClasses(dll);
    assert.equal(await registeredDll(), null); // not listed yet
    await addToList(tmp);
    assert.equal(await listed(), true);
    assert.equal(await registeredDll(), dll);
    await addToList(tmp); // already listed: nothing asked
  } finally {
    await removeFromList(tmp);
    await unregisterClasses();
    assert.equal(await listed(), false);
    assert.equal(await registeredDll(), null);
    await rm(tmp, { recursive: true, force: true });
  }
});
