// Several accounts: settings conversion from 1.4, default folders ~/Cloudy/<username>, and the one-time move of an
// old ~/Cloudy into ~/Cloudy/<username>. Runs against temporary folders; no server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultFolder, folderIn, folderName, needsMove, overlaps, parseSettings, runMove, MARKER, MIGRATED_ID, type Account } from '../src/main/accounts.ts';

const tempHome = () => mkdtemp(path.join(tmpdir(), 'cloudy-home-'));
const acct = (o: Partial<Account>): Account => ({ id: 'x1', server: 'https://cloud.example.com', user: 'fahed', excluded: [], paused: false, ...o });

test('a 1.4 settings file becomes one account; an empty one none; the new format is kept', () => {
  const old = parseSettings({ server: 'https://c.example', user: 'fahed', displayName: 'Fahed', token: 'dG9r', tokenEncrypted: true,
    rootId: 7, folder: '/home/f/Cloudy', excluded: ['Photos'], paused: true, openAtLogin: false });
  assert.equal(old.version, 2);
  assert.equal(old.openAtLogin, false);
  assert.deepEqual(old.accounts, [{ id: MIGRATED_ID, server: 'https://c.example', user: 'fahed', displayName: 'Fahed', token: 'dG9r',
    tokenEncrypted: true, rootId: 7, folder: '/home/f/Cloudy', excluded: ['Photos'], paused: true }]);
  // Signed out with nothing synced (1.4 kept only server + user to fill in the form): nothing to keep.
  assert.deepEqual(parseSettings({ server: 'https://c.example', user: 'fahed', excluded: [], paused: false, openAtLogin: true }).accounts, []);
  assert.deepEqual(parseSettings(null), { version: 2, accounts: [], openAtLogin: true });
  const v2 = { version: 2, openAtLogin: true, accounts: [acct({ id: 'a' }), acct({ id: 'b', user: 'demo1' })] };
  assert.deepEqual(parseSettings(JSON.parse(JSON.stringify(v2))), v2);
});

test('user names become safe folder names', () => {
  assert.equal(folderName('fahed'), 'fahed');
  assert.equal(folderName('a/b\\c:d*e?'), 'a_b_c_d_e_');
  assert.equal(folderName('name. '), 'name');
  assert.equal(folderName('..'), 'account');
  assert.equal(folderName('con'), 'con_');
  assert.equal(folderName('Café'), 'Café'); // NFC
});

test('sync folders may not be the same or inside each other, also through case or links', async () => {
  assert.equal(await overlaps('/h/Cloudy/demo1', ['/h/Cloudy/fahed'], 'linux'), false);
  assert.equal(await overlaps('/h/Cloudy/fahed', ['/h/Cloudy/fahed'], 'linux'), true);
  assert.equal(await overlaps('/h/Cloudy/demo1', ['/h/Cloudy'], 'linux'), true); // an old, not yet moved ~/Cloudy
  assert.equal(await overlaps('/h/Cloudy', ['/h/Cloudy/fahed'], 'linux'), true);
  assert.equal(await overlaps('/h/Cloudy/fahed2', ['/h/Cloudy/fahed', undefined], 'linux'), false);
  // macOS and Windows names ignore case: "~/cloudy" holds "~/Cloudy/demo1".
  assert.equal(await overlaps('/h/Cloudy/demo1', ['/h/cloudy'], 'darwin'), true);
  assert.equal(await overlaps('/h/Cloudy/demo1', ['/h/cloudy'], 'linux'), false);
  const home = await tempHome();
  try {
    await mkdir(path.join(home, 'real', 'fahed'), { recursive: true });
    await symlink(path.join(home, 'real'), path.join(home, 'link'));
    assert.equal(await overlaps(path.join(home, 'link', 'fahed', 'sub'), [path.join(home, 'real', 'fahed')], 'linux'), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('default folders: ~/Cloudy/<username>, numbered when taken, never inside another account', async () => {
  const home = await tempHome();
  try {
    assert.equal(await defaultFolder(home, 'fahed', []), path.join(home, 'Cloudy', 'fahed'));
    assert.equal(await defaultFolder(home, 'demo1', [path.join(home, 'Cloudy', 'fahed')]), path.join(home, 'Cloudy', 'demo1'));
    // The same username on a second server.
    assert.equal(await defaultFolder(home, 'fahed', [path.join(home, 'Cloudy', 'fahed')]), path.join(home, 'Cloudy', 'fahed (2)'));
    // A folder with that name already has other files in it: not used.
    await mkdir(path.join(home, 'Cloudy', 'sara'), { recursive: true });
    await writeFile(path.join(home, 'Cloudy', 'sara', 'notes.txt'), 'mine');
    assert.equal(await defaultFolder(home, 'sara', []), path.join(home, 'Cloudy', 'sara (2)'));
    // An empty one (or one with only hidden files) is fine.
    await mkdir(path.join(home, 'Cloudy', 'empty'), { recursive: true });
    await writeFile(path.join(home, 'Cloudy', 'empty', '.DS_Store'), '');
    assert.equal(await defaultFolder(home, 'empty', []), path.join(home, 'Cloudy', 'empty'));
    // ~/Cloudy is still an old account's own sync folder (could not be moved yet): the new one goes beside it.
    assert.equal(await defaultFolder(home, 'demo1', [path.join(home, 'Cloudy')]), path.join(home, 'Cloudy Files', 'demo1'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** What main.ts does at start: journal the move, run it, and (here) record the result like the settings would. */
async function startUp(home: string, a: Account): Promise<string | 'undone' | 'stuck' | null> {
  if (await needsMove(home, a)) a.movingFrom = a.folder;
  if (!a.movingFrom) return null;
  return runMove(home, a);
}

async function oldCloudy(home: string): Promise<number> {
  const old = path.join(home, 'Cloudy');
  await mkdir(path.join(old, 'Photos', 'fahed'), { recursive: true });
  await mkdir(path.join(old, 'fahed'), { recursive: true }); // a server folder named like the user
  await writeFile(path.join(old, 'fahed', 'inside.txt'), 'in the server folder "fahed"');
  await writeFile(path.join(old, 'notes.txt'), 'hello');
  await writeFile(path.join(old, 'Photos', 'fahed', 'a.jpg'), 'jpg');
  await writeFile(path.join(old, '.hidden'), 'x');
  return (await stat(path.join(old, 'notes.txt'))).ino;
}

test('an old ~/Cloudy moves into ~/Cloudy/<username>: same files, same identities, hidden files too', async () => {
  const home = await tempHome();
  try {
    const ino = await oldCloudy(home);
    const a = acct({ folder: path.join(home, 'Cloudy') });
    const target = path.join(home, 'Cloudy', 'fahed');
    assert.equal(await startUp(home, a), target);
    assert.equal(await readFile(path.join(target, 'notes.txt'), 'utf8'), 'hello');
    assert.equal(await readFile(path.join(target, 'fahed', 'inside.txt'), 'utf8'), 'in the server folder "fahed"');
    assert.equal(await readFile(path.join(target, 'Photos', 'fahed', 'a.jpg'), 'utf8'), 'jpg');
    assert.equal(await readFile(path.join(target, '.hidden'), 'utf8'), 'x');
    assert.equal((await stat(path.join(target, 'notes.txt'))).ino, ino); // renamed, not copied
    assert.deepEqual((await readdir(path.join(home, 'Cloudy'))).sort(), [MARKER, 'fahed']);
    assert.deepEqual((await readdir(home)).sort(), ['Cloudy']); // nothing left aside
    // Saved afterwards: nothing more to do.
    assert.equal(await startUp(home, acct({ folder: target })), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a crash after the move but before the settings were saved never moves it a second time', async () => {
  const home = await tempHome();
  try {
    await oldCloudy(home);
    const target = path.join(home, 'Cloudy', 'fahed');
    assert.equal(await startUp(home, acct({ folder: path.join(home, 'Cloudy') })), target);
    // Settings still say ~/Cloudy (with the journal entry): finishing again gives the same folder, no fahed/fahed.
    const again = acct({ folder: path.join(home, 'Cloudy'), movingFrom: path.join(home, 'Cloudy') });
    assert.equal(await startUp(home, again), target);
    assert.equal(await readFile(path.join(target, 'fahed', 'inside.txt'), 'utf8'), 'in the server folder "fahed"');
    assert.equal(await readFile(path.join(target, 'notes.txt'), 'utf8'), 'hello');
    // Without the journal entry (lost settings write): the marker says ~/Cloudy is a container, not a sync folder.
    assert.equal(await needsMove(home, acct({ folder: path.join(home, 'Cloudy') })), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an interrupted move is finished at the next start; other folders are never moved', async () => {
  const home = await tempHome();
  try {
    // Stopped after the first rename: the files are in the aside folder, ~/Cloudy is gone.
    const aside = path.join(home, '.Cloudy-moving-x1');
    await mkdir(aside);
    await writeFile(path.join(aside, 'notes.txt'), 'hello');
    const journal = path.join(home, 'Cloudy');
    assert.equal(await startUp(home, acct({ folder: journal, movingFrom: journal })), path.join(home, 'Cloudy', 'fahed'));
    assert.equal(await readFile(path.join(home, 'Cloudy', 'fahed', 'notes.txt'), 'utf8'), 'hello');
    // A folder the user chose elsewhere, a missing ~/Cloudy, or no folder: left alone.
    await mkdir(path.join(home, 'Documents', 'Cloudy'), { recursive: true });
    assert.equal(await startUp(home, acct({ id: 'x2', folder: path.join(home, 'Documents', 'Cloudy') })), null);
    assert.equal(await startUp(home, acct({ id: 'x3', folder: undefined })), null);
    const other = await tempHome();
    assert.equal(await startUp(other, acct({ id: 'x4', folder: path.join(other, 'Cloudy') })), null); // missing
    await rm(other, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('an old folder chosen as "~/cloudy" on macOS is moved too', async () => {
  const home = await tempHome();
  try {
    await mkdir(path.join(home, 'Cloudy'));
    await writeFile(path.join(home, 'Cloudy', 'notes.txt'), 'hello');
    assert.equal(await needsMove(home, acct({ folder: path.join(home, 'cloudy') }), 'darwin'), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a place chosen with "Change…" gets Cloudy/<username>, unless it is already that folder', () => {
  const p = (...s: string[]) => path.join('/Users/me', ...s);
  assert.equal(folderIn(p('Documents'), 'fahed', 'darwin'), p('Documents', 'Cloudy', 'fahed'));
  assert.equal(folderIn(p('Documents', 'Cloudy'), 'fahed', 'darwin'), p('Documents', 'Cloudy', 'fahed'));
  assert.equal(folderIn(p('Documents', 'cloudy'), 'fahed', 'darwin'), p('Documents', 'cloudy', 'fahed'));
  assert.equal(folderIn(p('Cloudy', 'fahed'), 'fahed', 'darwin'), p('Cloudy', 'fahed'));
  assert.equal(folderIn(p('Cloudy', 'Fahed'), 'fahed', 'darwin'), p('Cloudy', 'Fahed'));
  assert.equal(folderIn(p('Cloudy', 'Fahed'), 'fahed', 'linux'), p('Cloudy', 'Fahed', 'Cloudy', 'fahed'));
  assert.equal(folderIn(p('Cloudy', 'fahed (2)'), 'fahed', 'darwin'), p('Cloudy', 'fahed (2)'));
  assert.equal(folderIn(p('Work'), 'a/b', 'linux'), p('Work', 'Cloudy', 'a_b'));
});
