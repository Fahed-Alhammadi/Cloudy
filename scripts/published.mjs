#!/usr/bin/env node
// Is this version already published? Lets a release that failed halfway be finished: the publish jobs skip what is
// already out (the stores refuse a second upload of the same build) and do the rest. No dependencies.
//   node scripts/published.mjs server <version>                 image ghcr.io/$GHCR_IMAGE:<version> (default fahed-alhammadi/cloudy)
//   node scripts/published.mjs ios <version> <build number>     App Store Connect build (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH)
//   node scripts/published.mjs android <version code>           Play bundle with that versionCode (PLAY_JSON = service account JSON)
// Exit 0 = published, 1 = not published, 2 = could not tell (the caller should fail rather than guess).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [product, ...args] = process.argv.slice(2);

async function server(version) {
  const image = process.env.GHCR_IMAGE ?? 'fahed-alhammadi/cloudy';
  const auth = await fetch(`https://ghcr.io/token?scope=repository:${image}:pull`);
  if (!auth.ok) throw new Error(`ghcr.io token: HTTP ${auth.status}`);
  const { token } = await auth.json();
  const res = await fetch(`https://ghcr.io/v2/${image}/manifests/${version}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json',
    },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`ghcr.io manifest: HTTP ${res.status}`);
  return true;
}

function jwt(header, claims, key, opts) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${sign('sha256', Buffer.from(data), { key: createPrivateKey(key), ...opts }).toString('base64url')}`;
}

async function call(url, init, what) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function ios(version, build) {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' },
    { iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' },
    readFileSync(process.env.ASC_KEY_PATH), { dsaEncoding: 'ieee-p1363' });
  const get = (path) => call(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${token}` } }, `App Store Connect ${path.split('?')[0]}`);
  const app = (await get('/v1/apps?filter[bundleId]=io.cloudy.app')).data?.[0];
  if (!app) throw new Error('no App Store Connect app io.cloudy.app');
  const q = new URLSearchParams({ 'filter[app]': app.id, 'filter[version]': build, 'filter[preReleaseVersion.version]': version });
  return ((await get(`/v1/builds?${q}`)).data ?? []).length > 0;
}

async function android(versionCode) {
  const sa = JSON.parse(process.env.PLAY_JSON ?? '');
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' },
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri, iat: now, exp: now + 600 },
    sa.private_key);
  const { access_token } = await call(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  }, 'Google OAuth');
  const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.cloudy.app/edits';
  const headers = { Authorization: `Bearer ${access_token}` };
  const edit = await call(base, { method: 'POST', headers }, 'Play edits.insert'); // read-only use: deleted below, never committed
  try {
    const { bundles = [] } = await call(`${base}/${edit.id}/bundles`, { headers }, 'Play bundles.list');
    return bundles.some((b) => String(b.versionCode) === String(versionCode));
  } finally {
    await fetch(`${base}/${edit.id}`, { method: 'DELETE', headers }).catch(() => {});
  }
}

const checks = { server: [server, 1], ios: [ios, 2], android: [android, 1] };
if (!checks[product] || args.length !== checks[product][1]) {
  console.error('usage: published.mjs server <version> | ios <version> <build> | android <version code>');
  process.exit(2);
}
try {
  const done = await checks[product][0](...args);
  console.log(`${product} ${args.join(' ')}: ${done ? 'already published' : 'not published yet'}`);
  process.exit(done ? 0 : 1);
} catch (e) {
  console.error(`${product}: could not check (${e.message})`);
  process.exit(2);
}
