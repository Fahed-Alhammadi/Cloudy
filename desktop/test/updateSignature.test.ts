// Signed updates: scripts/sign-update.mjs (CI) against src/main/updateSignature.ts (the app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ID, MANIFEST, UPDATE_PUBLIC_KEY, checkFiles, checkManifest, verifyUpdate } from '../src/main/updateSignature.ts';

const SCRIPT = new URL('../../scripts/sign-update.mjs', import.meta.url).pathname;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** A release folder with two packages, signed with a fresh key. */
function release(version = '9.8.7') {
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-sign-'));
  writeFileSync(join(dir, 'Cloudy-9.8.7-win-x64.exe'), 'installer');
  writeFileSync(join(dir, 'Cloudy-9.8.7-linux-x86_64.AppImage'), 'appimage');
  writeFileSync(join(dir, 'latest.yml'), 'not a package');
  const k = keyPair();
  writeFileSync(join(dir, 'key.ts'), `export const K = \`${k.pub}\`;`);
  execFileSync(process.execPath, [SCRIPT, dir, APP_ID, version, join(dir, 'key.ts')], {
    env: { ...process.env, UPDATE_SIGNING_KEY: k.priv },
    stdio: 'pipe',
  });
  const body = readFileSync(join(dir, MANIFEST));
  const sig = readFileSync(join(dir, `${MANIFEST}.sig`), 'utf8');
  return { dir, k, body, sig, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a signed release passes; only packages are listed', async () => {
  const r = release();
  try {
    const m = checkManifest(r.body, r.sig, '9.8.7', r.k.pub);
    assert.deepEqual(Object.keys(m.files).sort(), ['Cloudy-9.8.7-linux-x86_64.AppImage', 'Cloudy-9.8.7-win-x64.exe']);
    await checkFiles([join(r.dir, 'Cloudy-9.8.7-win-x64.exe')], m);
  } finally {
    r.done();
  }
});

test('a changed package, manifest, version or key is refused', async () => {
  const r = release();
  try {
    const m = checkManifest(r.body, r.sig, '9.8.7', r.k.pub);
    writeFileSync(join(r.dir, 'evil.exe'), 'installer!');
    await assert.rejects(checkFiles([join(r.dir, 'evil.exe')], m), /not signed/);
    await assert.rejects(checkFiles([], m), /empty/);
    const tampered = Buffer.from(r.body.toString().replace('9.8.7', '9.8.8'));
    assert.throws(() => checkManifest(tampered, r.sig, '9.8.8', r.k.pub), /not signed/);
    assert.throws(() => checkManifest(r.body, r.sig, '9.8.8', r.k.pub), /not for Cloudy 9.8.8/);
    assert.throws(() => checkManifest(r.body, r.sig, '9.8.7', keyPair().pub), /not signed/);
    assert.throws(() => checkManifest(r.body, r.sig, '9.8.7'), /not signed/); // the real key didn't sign it
    assert.throws(() => checkManifest(r.body, 'AAAA', '9.8.7', r.k.pub), /not signed/);
  } finally {
    r.done();
  }
});

test('verifyUpdate fetches the manifest next to the packages and fails closed', async () => {
  const r = release();
  const served = new Map([
    [`https://x/${MANIFEST}`, r.body],
    [`https://x/${MANIFEST}.sig`, Buffer.from(r.sig)],
  ]);
  const fetch = async (url: string) => {
    const b = served.get(url);
    return b ? new Response(new Uint8Array(b)) : new Response('missing', { status: 404 });
  };
  try {
    const exe = join(r.dir, 'Cloudy-9.8.7-win-x64.exe');
    // signed with a test key, so the app's real key refuses it
    await assert.rejects(verifyUpdate('https://x', '9.8.7', [exe], fetch), /not signed/);
    await assert.rejects(verifyUpdate('https://y', '9.8.7', [exe], fetch), /no signature/);
  } finally {
    r.done();
  }
});

test('the script refuses a key that is not the app key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-sign-'));
  writeFileSync(join(dir, 'a.exe'), 'x');
  try {
    assert.throws(() =>
      execFileSync(process.execPath, [SCRIPT, dir, APP_ID, '1.0.0', new URL('../src/main/updateSignature.ts', import.meta.url).pathname], {
        env: { ...process.env, UPDATE_SIGNING_KEY: keyPair().priv },
        stdio: 'pipe',
      }),
    );
    assert.equal(existsSync(join(dir, MANIFEST)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Local only: Keys/ (git-ignored) holds the private key that CI uses.
const local = new URL('../../Keys/UPDATE_SIGNING_KEY.pem', import.meta.url).pathname;
test('Keys/UPDATE_SIGNING_KEY.pem belongs to UPDATE_PUBLIC_KEY', { skip: !existsSync(local) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloudy-sign-'));
  writeFileSync(join(dir, 'a.exe'), 'x');
  try {
    execFileSync(process.execPath, [SCRIPT, dir, APP_ID, '1.0.0', new URL('../src/main/updateSignature.ts', import.meta.url).pathname], {
      env: { ...process.env, UPDATE_SIGNING_KEY: readFileSync(local, 'utf8') },
      stdio: 'pipe',
    });
    checkManifest(readFileSync(join(dir, MANIFEST)), readFileSync(join(dir, `${MANIFEST}.sig`), 'utf8'), '1.0.0', UPDATE_PUBLIC_KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
