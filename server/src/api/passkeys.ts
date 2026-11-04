// Passkeys: passwordless browser login and per-user passkey management.
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readJson, numId, HttpError, clientNet } from '../http.ts';
import { q, one } from '../db.ts';
import { loginWithPasskey, createSession, passkeyUserHandle, requirePassword } from '../auth.ts';
import type { User } from '../auth.ts';
import { userJson } from '../users.ts';
import { ALGORITHMS, newChallenge, relyingParty, verifyRegistration } from '../webauthn.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);

// Sign-in challenges are kept in memory (10,000 at most, oldest dropped first): one client asking for thousands would
// push out everyone else's and break their passkey sign-in. 120 a minute per address (an IPv6 /64): the login page asks on every render for autofill, and an office
// behind one NAT address opens it often.
const optionRequests = new Map<string, number[]>();
function allowOptions(key: string): boolean {
  const now = Date.now();
  const recent = (optionRequests.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 120) return false;
  recent.push(now);
  optionRequests.set(key, recent);
  if (optionRequests.size > 10_000) optionRequests.clear();
  return true;
}

export function registerPasskeys(r: Router, authed: (h: Authed) => (ctx: Ctx) => Promise<void>) {
  // Sign-in: options for navigator.credentials.get(). No allowCredentials — the browser offers
  // the passkeys it has for this site (discoverable credentials), so no username is needed.
  r.post('/api/passkeys/login/options', async ({ req, res }) => {
    if (!allowOptions(clientNet(req))) throw new HttpError(429, 'Too many requests, try again later');
    json(res, { challenge: newChallenge(null), rpId: relyingParty(req).id, userVerification: 'required', timeout: 300_000 });
  });

  r.post('/api/passkeys/login', async ({ req, res }) => {
    const user = await loginWithPasskey(req, await readJson(req));
    await createSession(req, res, user.id);
    json(res, await userJson(user));
  });

  // Registration: options for navigator.credentials.create(); adding a sign-in method needs the password.
  r.post('/api/me/passkeys/options', authed(async ({ req, res }, user) => {
    await requirePassword(req, user.id, (await readJson(req)).password);
    const existing = await q<{ credential_id: string; transports: string[] }>(
      `SELECT credential_id, transports FROM passkeys WHERE user_id = $1`, [user.id]);
    const rp = relyingParty(req);
    json(res, {
      challenge: newChallenge(user.id),
      rp: { id: rp.id, name: 'Cloudy' },
      user: { id: await passkeyUserHandle(user.id), name: user.id, displayName: user.display_name || user.id },
      pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: 300_000,
    });
  }));

  r.post('/api/me/passkeys', authed(async ({ req, res }, user) => {
    const b = await readJson(req);
    const cred = verifyRegistration(req, user.id, b);
    const name = String(b.name ?? '').trim().slice(0, 60) || 'Passkey';
    const transports = Array.isArray(b.transports) ? b.transports.filter((t: unknown) => TRANSPORTS.has(String(t))).map(String) : [];
    const row = await one<{ id: string }>(
      `INSERT INTO passkeys (user_id, credential_id, public_key, alg, sign_count, transports, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
      [user.id, cred.credentialId, cred.publicKey, cred.alg, cred.signCount, transports, name]);
    if (!row) throw new HttpError(409, 'This passkey is already registered');
    json(res, { id: row.id, name }, 201);
  }));

  r.get('/api/me/passkeys', authed(async ({ res }, user) => {
    json(res, await q(`SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt"
                         FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC`, [user.id]));
  }));

  r.patch('/api/me/passkeys/:id', authed(async ({ req, res, params }, user) => {
    const name = String((await readJson(req)).name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name is required');
    await q(`UPDATE passkeys SET name = $3 WHERE id = $1 AND user_id = $2`, [numId(params.id), user.id, name]);
    noContent(res);
  }));

  r.delete('/api/me/passkeys/:id', authed(async ({ res, params }, user) => {
    await q(`DELETE FROM passkeys WHERE id = $1 AND user_id = $2`, [numId(params.id), user.id]);
    noContent(res);
  }));
}
