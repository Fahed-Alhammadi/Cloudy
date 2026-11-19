// The Finder badge server (src/main/finder.ts), with a plain TCP socket playing the extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FinderBadges } from '../src/main/finder.ts';

/** A connected "extension" (sends `hello` first unless it is null): each line it receives, parsed, in order. */
async function extension(portFile: string, hello?: string | null) {
  const info = JSON.parse(await readFile(portFile, 'utf8'));
  const sock = net.connect(info.port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const lines: any[] = [];
  const waiters: (() => void)[] = [];
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (c: string) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); waiters.shift()?.(); }
  });
  const send = (m: object) => sock.write(JSON.stringify(m) + '\n');
  const next = async () => { if (!lines.length) await new Promise<void>((r) => waiters.push(r)); return lines.shift(); };
  // The app proves first that it read finder.json, as the extension checks.
  assert.deepEqual(await next(), { app: info.app });
  if (hello !== null) send({ hello: hello ?? info.secret });
  const closed = new Promise((r) => sock.once('close', r));
  return { sock, next, send, closed };
}

async function server(badgeOf: ConstructorParameters<typeof FinderBadges>[1]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-finder-'));
  const portFile = path.join(dir, 'Cloudy', 'finder.json');
  const fb = new FinderBadges(portFile, badgeOf);
  await fb.start();
  return { fb, portFile, done: async () => { await fb.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('the extension gets the folders, its answers and the changed items', async () => {
  const { fb, portFile, done } = await server((p) => (p === '/u/Cloudy/a/x.txt' ? 'synced' : p === '/u/Cloudy/a/bad' ? 'error' : null));
  try {
    if (process.platform !== 'win32') assert.equal((await stat(portFile)).mode & 0o777, 0o600); // Windows: the user's AppData ACL
    fb.setFolders(['/u/Cloudy/a']);
    const ext = await extension(portFile);
    assert.deepEqual(await ext.next(), { folders: ['/u/Cloudy/a'] });

    ext.send({ ask: ['/u/Cloudy/a/x.txt', '/u/Cloudy/a/bad', '/elsewhere', 'relative', 7] });
    assert.deepEqual(await ext.next(), { badges: { '/u/Cloudy/a/x.txt': 'synced', '/u/Cloudy/a/bad': 'error', '/elsewhere': '' } });

    fb.changed(['/u/Cloudy/a/x.txt']);
    fb.changed(['/u/Cloudy/a/x.txt', '/u/Cloudy/a']);
    assert.deepEqual(await ext.next(), { changed: ['/u/Cloudy/a/x.txt', '/u/Cloudy/a'] }); // batched, once each

    fb.changed(['/u/Cloudy/a/y']);
    fb.changed(null);
    assert.deepEqual(await ext.next(), { changed: null });

    fb.setFolders(['/u/Cloudy/a']); // unchanged: nothing sent
    fb.setFolders(['/u/Cloudy/b', '/u/Cloudy/a']);
    assert.deepEqual(await ext.next(), { folders: ['/u/Cloudy/a', '/u/Cloudy/b'] });

    // Garbage closes that connection; the server goes on.
    ext.sock.write('not json\n');
    await ext.closed;
    const again = await extension(portFile);
    assert.deepEqual(await again.next(), { folders: ['/u/Cloudy/a', '/u/Cloudy/b'] });
    again.sock.destroy();
  } finally {
    await done();
  }
});

test('without the secret from finder.json nothing is answered', async () => {
  const { fb, portFile, done } = await server(() => 'synced');
  try {
    fb.setFolders(['/u/Cloudy/a']);
    const wrong = await extension(portFile, 'f'.repeat(64));
    await wrong.closed;
    const none = await extension(portFile, null);
    none.send({ ask: ['/u/Cloudy/a/x'] }); // asking straight away is not a hello
    await none.closed;
    const right = await extension(portFile);
    assert.deepEqual(await right.next(), { folders: ['/u/Cloudy/a'] });
    right.sock.destroy();
  } finally {
    await done();
  }
});

test('closing removes finder.json; a new start writes a new port and secret', async () => {
  const { fb, portFile, done } = await server(() => null);
  const first = JSON.parse(await readFile(portFile, 'utf8'));
  await fb.close();
  await assert.rejects(stat(portFile));
  await fb.start();
  const second = JSON.parse(await readFile(portFile, 'utf8'));
  assert.notEqual(second.port, 0);
  assert.equal(second.secret, first.secret); // same process: same secret
  await done();
});

test('a client that sends too much before its hello is dropped', async () => {
  const { portFile, done } = await server(() => null);
  try {
    const ext = await extension(portFile, null);
    ext.sock.write('x'.repeat(2000));
    await ext.closed;
  } finally {
    await done();
  }
});

test('a Cloudy that quits does not remove the finder.json of another one started since', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-finder-'));
  const portFile = path.join(dir, 'finder.json');
  const first = new FinderBadges(portFile, () => null);
  const second = new FinderBadges(portFile, () => null);
  try {
    await first.start();
    await second.start(); // e.g. a test copy next to the installed app
    await first.close();
    const info = JSON.parse(await readFile(portFile, 'utf8'));
    assert.equal(info.secret, second['secret']);
    first.removePortFileSync();
    await stat(portFile);
    second.removePortFileSync();
    await assert.rejects(stat(portFile));
  } finally {
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
