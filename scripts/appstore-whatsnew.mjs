#!/usr/bin/env node
// Sets the release notes of an uploaded iOS build through the App Store Connect API (no dependencies):
//   - TestFlight "What to Test" of the build (betaBuildLocalizations), and
//   - App Store "What's New in This Version" of the matching App Store version, if it exists and can still be edited
//     (Apple has no such field for an app's first version, so that part is skipped then),
// then, once the build is processed, adds it to the external TestFlight group (EXTERNAL_GROUP, the public link) and
// sends it to Beta App Review. Each step is skipped when it is already done, so the script can be run again.
// Export compliance needs no step: Info.plist sets ITSAppUsesNonExemptEncryption = NO.
// Usage: node scripts/appstore-whatsnew.mjs <bundle id> <version> <build number> <notes file>
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the AuthKey_<id>.p8 file). Locale: en-US.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [bundleId, version, buildNumber, notesFile] = process.argv.slice(2);
if (!notesFile) { console.error('usage: appstore-whatsnew.mjs <bundle id> <version> <build number> <notes file>'); process.exit(2); }
const notes = readFileSync(notesFile, 'utf8').trim();
const LOCALE = 'en-US';
const API = process.env.ASC_API ?? 'https://api.appstoreconnect.apple.com';

// ES256 JWT, valid 20 minutes (Apple's maximum).
function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
  const body = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' });
  const key = createPrivateKey(readFileSync(process.env.ASC_KEY_PATH));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function asc(method, path, data) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
// External TestFlight group with the public link (https://testflight.apple.com/join/X1M6sYZm).
const EXTERNAL_GROUP = process.env.TESTFLIGHT_EXTERNAL_GROUP ?? 'Testing';
const q = (params) => new URLSearchParams(params).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = (await asc('GET', `/v1/apps?${q({ 'filter[bundleId]': bundleId })}`)).data?.[0];
if (!app) throw new Error(`no app with bundle id ${bundleId}`);

// The build shows up a few minutes after the upload; wait up to 30 minutes.
let build;
for (let i = 0; i < 60 && !build; i++) {
  build = (await asc('GET', `/v1/builds?${q({ 'filter[app]': app.id, 'filter[version]': buildNumber, 'filter[preReleaseVersion.version]': version })}`)).data?.[0];
  if (!build) { console.log(`waiting for build ${version} (${buildNumber}) to appear…`); await sleep(30_000); }
}
if (!build) throw new Error(`build ${version} (${buildNumber}) did not appear in App Store Connect`);

const locs = (await asc('GET', `/v1/builds/${build.id}/betaBuildLocalizations`)).data ?? [];
const loc = locs.find((l) => l.attributes.locale === LOCALE);
if (loc) await asc('PATCH', `/v1/betaBuildLocalizations/${loc.id}`, { type: 'betaBuildLocalizations', id: loc.id, attributes: { whatsNew: notes } });
else await asc('POST', '/v1/betaBuildLocalizations', {
  type: 'betaBuildLocalizations',
  attributes: { locale: LOCALE, whatsNew: notes },
  relationships: { build: { data: { type: 'builds', id: build.id } } },
});
console.log(`TestFlight "What to Test" set for ${version} (${buildNumber})`);

// App Store "What's New": only for a version created in App Store Connect that isn't the app's first one.
const asv = (await asc('GET', `/v1/apps/${app.id}/appStoreVersions?${q({ 'filter[versionString]': version, 'filter[platform]': 'IOS' })}`)).data?.[0];
if (!asv) {
  console.log(`no App Store version ${version} in App Store Connect yet: "What's New" not set`);
} else {
  const vlocs = (await asc('GET', `/v1/appStoreVersions/${asv.id}/appStoreVersionLocalizations`)).data ?? [];
  const vloc = vlocs.find((l) => l.attributes.locale === LOCALE);
  try {
    if (!vloc) throw new Error(`no ${LOCALE} localization`);
    await asc('PATCH', `/v1/appStoreVersionLocalizations/${vloc.id}`, { type: 'appStoreVersionLocalizations', id: vloc.id, attributes: { whatsNew: notes } });
    console.log(`App Store "What's New" set for ${version}`);
  } catch (e) {
    // e.g. the app's first version (no "What's New" field) or a version already in review.
    console.log(`"What's New" not set for ${version}: ${e.message}`);
  }
}

// External testers: wait (up to 30 minutes) for processing, add the build to the group, send it to Beta App Review.
let attrs = build.attributes;
for (let i = 0; i < 60 && attrs.processingState === 'PROCESSING'; i++) {
  await sleep(30_000);
  attrs = (await asc('GET', `/v1/builds/${build.id}`)).data.attributes;
}
if (attrs.processingState !== 'VALID') throw new Error(`build ${version} (${buildNumber}) is ${attrs.processingState}: add it to TestFlight testers in App Store Connect`);
const group = ((await asc('GET', `/v1/apps/${app.id}/betaGroups?limit=200`)).data ?? [])
  .find((g) => g.attributes.name === EXTERNAL_GROUP && !g.attributes.isInternalGroup);
if (!group) throw new Error(`no external TestFlight group named "${EXTERNAL_GROUP}"`);
const inGroup = ((await asc('GET', `/v1/betaGroups/${group.id}/builds?limit=200`)).data ?? []).some((b) => b.id === build.id);
if (!inGroup) await asc('POST', `/v1/betaGroups/${group.id}/relationships/builds`, [{ type: 'builds', id: build.id }]);
console.log(`Added ${version} (${buildNumber}) to the TestFlight group "${EXTERNAL_GROUP}"`);
const externalState = async () => (await asc('GET', `/v1/builds/${build.id}/buildBetaDetail`)).data.attributes.externalBuildState;
let state = await externalState();
if (state === 'READY_FOR_BETA_SUBMISSION') {
  await asc('POST', '/v1/betaAppReviewSubmissions', { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } });
  state = await externalState();
}
console.log(`External testing for ${version} (${buildNumber}): ${state}`);
