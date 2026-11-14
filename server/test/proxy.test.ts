// TRUST_PROXY: which address counts as the client, and when forwarded headers are believed (src/http.ts).
// config.ts reads the env once at import, so every setting runs in its own process.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

type Case = { peer: string; xff?: string; ip: string; https: boolean; origin: string };

function run(trustProxy: string | undefined, cases: Case[]) {
  const script = `
    const { clientIp, isHttps, publicOrigin } = await import(${JSON.stringify(new URL('../src/http.ts', import.meta.url).href)});
    const out = JSON.parse(process.env.CASES).map((c) => {
      const req = { socket: { remoteAddress: c.peer }, headers: { 'x-forwarded-for': c.xff, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com', host: 'internal:8080' } };
      return { ip: clientIp(req), https: isHttps(req), origin: publicOrigin(req) };
    });
    console.log(JSON.stringify(out));`;
  const env: Record<string, string | undefined> = { ...process.env, CASES: JSON.stringify(cases), PUBLIC_URL: '' };
  if (trustProxy === undefined) delete env.TRUST_PROXY;
  else env.TRUST_PROXY = trustProxy;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

function check(trustProxy: string | undefined, cases: Case[]) {
  const r = run(trustProxy, cases);
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  cases.forEach((c, i) => assert.deepEqual(got[i], { ip: c.ip, https: c.https, origin: c.origin }, `TRUST_PROXY=${trustProxy} peer ${c.peer} xff ${c.xff}`));
}

const viaProxy = 'https://cloud.example.com';
const direct = 'http://internal:8080';

test('unset: forwarded headers are ignored', () => {
  check(undefined, [{ peer: '172.18.0.1', xff: '203.0.113.7', ip: '172.18.0.1', https: false, origin: direct }]);
});

test('a range: headers count only from it, and its addresses are skipped', () => {
  check('172.16.0.0/12', [
    { peer: '172.18.0.1', xff: '203.0.113.7', ip: '203.0.113.7', https: true, origin: viaProxy },
    { peer: '::ffff:172.18.0.1', xff: '1.2.3.4, 203.0.113.7', ip: '203.0.113.7', https: true, origin: viaProxy }, // forged entry on the left
    { peer: '172.18.0.1', xff: '172.20.0.5', ip: '172.20.0.5', https: true, origin: viaProxy }, // only proxies: leftmost
    { peer: '192.168.1.50', xff: '203.0.113.7', ip: '192.168.1.50', https: false, origin: direct }, // bypassed the proxy
    { peer: '198.51.100.9', xff: '10.0.0.1', ip: '198.51.100.9', https: false, origin: direct },
  ]);
});

test('single addresses and IPv6 ranges', () => {
  check('10.0.0.5, fd00::/8', [
    { peer: '10.0.0.5', xff: '203.0.113.7', ip: '203.0.113.7', https: true, origin: viaProxy },
    { peer: '10.0.0.6', xff: '203.0.113.7', ip: '10.0.0.6', https: false, origin: direct },
    { peer: 'fd00::1', xff: '2001:db8::1', ip: '2001:db8::1', https: true, origin: viaProxy },
  ]);
});

test('true: the pre-1.17 behaviour (any peer, local addresses are proxies)', () => {
  check('true', [
    { peer: '172.18.0.1', xff: '203.0.113.7', ip: '203.0.113.7', https: true, origin: viaProxy },
    { peer: '192.168.1.50', xff: '10.0.0.9', ip: '10.0.0.9', https: true, origin: viaProxy },
    { peer: '198.51.100.1', xff: '203.0.113.7', ip: '198.51.100.1', https: true, origin: viaProxy },
  ]);
});

test('a bad entry stops the start', () => {
  for (const bad of ['172.16.0.0/33', 'proxy.local', '10.0.0.0/8/1', '10.0.0.0/x']) {
    const r = run(bad, []);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /FATAL: TRUST_PROXY/, bad);
  }
});
