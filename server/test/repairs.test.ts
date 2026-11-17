// Repairs from the 2026-11-15 review (server 1.18.1): request targets that crashed the server, sign-in guesses sent in
// parallel, patterns that froze the server on crafted input, characters that broke DAV clients.  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestUrl, checkName } from '../src/http.ts';
import { attempt, checkRate } from '../src/auth.ts';
import { validEmail } from '../src/mail.ts';
import { esc } from '../src/dav/xml.ts';

/** Milliseconds `fn` takes. */
function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

test('request targets: "//…" is a path, never a host, and nothing throws', () => {
  // These used to throw outside any handler ("//", "/\\", "//[") and stop the server, or route "//x/api/…" as "/api/…".
  for (const target of ['//', '///', '//?x=1', '/\\', '/\\/', '//[', '//:', '//%20/', '//x/api/admin/users', '//status']) {
    const url = requestUrl(target);
    assert.ok(url, target);
    assert.equal(url.host, 'localhost', target);
    assert.ok(!url.pathname.startsWith('/api/') && url.pathname !== '/status', `${target} → ${url.pathname}`);
  }
  assert.equal(requestUrl('/files/12?x=1')?.pathname, '/files/12');
  assert.equal(requestUrl('/files/12?x=1')?.search, '?x=1');
  assert.equal(requestUrl('http://cloud.example.com/dav/files/a?b')?.pathname, '/dav/files/a'); // absolute form
  assert.equal(requestUrl('*')?.pathname, '/'); // OPTIONS *
  assert.equal(requestUrl('ftp://x/y'), null);
  assert.equal(requestUrl('nonsense'), null);
});

test('sign-in limit holds for guesses sent at the same moment', () => {
  const req = { socket: { remoteAddress: '203.0.113.7' }, headers: {} } as any;
  // 300 guesses arrive before any of them has been checked: each one is counted as it starts, so after ten (the
  // per-address limit) the rest are refused (they used to be all let through).
  let allowed = 0;
  let refused = 0;
  for (let i = 0; i < 300; i++) {
    try { attempt(req, 'alice'); allowed++; } catch (e: any) { assert.equal(e.status, 429); refused++; }
  }
  assert.equal(allowed, 10);
  assert.equal(refused, 290);
  // A right guess gives its count back: another address can still sign in to the account (30 per account).
  const other = { socket: { remoteAddress: '198.51.100.9' }, headers: {} } as any;
  for (let i = 0; i < 25; i++) attempt(other, 'bob').succeeded();
  assert.doesNotThrow(() => checkRate(other, 'bob'));
});

test('a megabyte "username" gets no counter of its own', () => {
  const req = { socket: { remoteAddress: '192.0.2.44' }, headers: {} } as any;
  const huge = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 5; i++) attempt(req, huge);
  // Only the address counter grew: the next normal account on another address is unaffected.
  assert.doesNotThrow(() => checkRate({ socket: { remoteAddress: '192.0.2.45' }, headers: {} } as any, huge));
});

test('email check is linear and still right', () => {
  assert.ok(validEmail('a@b.co'));
  assert.ok(validEmail('first.last+tag@mail.example.org'));
  for (const bad of ['a@b', 'a@.com', 'a@b.', 'a b@c.de', '@b.de', 'a@b..de', 'x'.repeat(250) + '@b.de']) assert.ok(!validEmail(bad), bad);
  // "a@" + many dots took minutes; it is answered at once now (also because nothing over 254 characters is tested).
  assert.ok(timed(() => validEmail('a@' + '.'.repeat(200) + ' x')) < 50);
  assert.ok(timed(() => validEmail('a@' + '.'.repeat(1_000_000) + ' x')) < 50);
});

test('DAV text never carries characters XML cannot hold', () => {
  assert.equal(esc('line one\u000bline two & <b>'), 'line oneline two &amp; &lt;b&gt;');
  assert.equal(esc('tab\tand\nnew line\r'), 'tab\tand\nnew line\r');
  assert.equal(esc('￾￿ok'), 'ok');
});

test('names: XML-illegal characters are refused, normal names pass', () => {
  for (const bad of ['a￾', 'a￿', 'a\ud800b', 'a\u0000b', 'a/b', '..', '']) assert.throws(() => checkName(bad), undefined, JSON.stringify(bad));
  for (const ok of ['Report.pdf', 'تقرير.txt', 'Résumé.docx', '😀 photo.jpg']) assert.equal(checkName(ok), ok);
});
