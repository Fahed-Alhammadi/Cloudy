// The Linux file manager extensions and emblems (src/main/badges-linux.ts), installed into a scratch home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { install, installed, uninstall } from '../src/main/badges-linux.ts';

const resources = path.join(import.meta.dirname, '..', 'linux');

test('the extensions and emblems go into ~/.local/share and away again', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cloudy-badges-'));
  const saved = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    const data = path.join(home, '.local', 'share');
    assert.equal(await installed(home), false);
    await install(resources, home);
    assert.equal(await installed(home), true);
    for (const host of ['nautilus', 'nemo', 'caja']) {
      const text = await readFile(path.join(data, `${host}-python`, 'extensions', 'cloudy-badges.py'), 'utf8');
      assert.ok(text.startsWith(`HOST = '${host}'\n`));
      assert.ok(text.includes('class CloudyBadges'));
    }
    for (const id of ['synced', 'syncing', 'error']) await stat(path.join(data, 'icons', 'hicolor', '48x48', 'emblems', `emblem-cloudy-${id}.png`));
    await install(resources, home); // again: nothing changes, no error

    await uninstall(resources, home);
    assert.equal(await installed(home), false);
    await assert.rejects(stat(path.join(data, 'nemo-python', 'extensions', 'cloudy-badges.py')));
    await assert.rejects(stat(path.join(data, 'icons', 'hicolor', '16x16', 'emblems', 'emblem-cloudy-error.png')));
  } finally {
    if (saved !== undefined) process.env.XDG_DATA_HOME = saved;
    await rm(home, { recursive: true, force: true });
  }
});

test('XDG_DATA_HOME is followed', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cloudy-badges-'));
  const saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, 'data');
  try {
    await install(resources, home);
    await stat(path.join(home, 'data', 'caja-python', 'extensions', 'cloudy-badges.py'));
    assert.equal(await installed(home), true);
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(home, { recursive: true, force: true });
  }
});
