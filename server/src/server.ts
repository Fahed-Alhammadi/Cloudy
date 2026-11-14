import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';
import { migrate, q } from './db.ts';
import { Router, HttpError, json } from './http.ts';
import type { Ctx } from './http.ts';
import { sessionUser, bearerUser } from './auth.ts';
import type { User } from './auth.ts';
import { ensureAdmin } from './users.ts';
import { ensureDirs, expireTrash, cleanStorage, gcHashes, backfillHashes } from './files.ts';
import { handleDav } from './dav/server.ts';
import { sendFile } from './download.ts';
import { registerAccount } from './api/account.ts';
import { registerPasskeys } from './api/passkeys.ts';
import { registerFiles, registerUploadChunks, expireUploads } from './api/files.ts';
import { registerShares } from './api/shares.ts';
import { registerGroupware } from './api/groupware.ts';
import { openStream, startLiveUpdates, closeStreams } from './events.ts';
import { registerOffice, pruneOfficeCache } from './office.ts';
import { registerMail, expirePasswordResets } from './mail.ts';
import { registerLimits, loadLimits } from './limits.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;

const authed = (h: Authed) => async (ctx: Ctx) => {
  const user = (await bearerUser(ctx.req)) ?? (await sessionUser(ctx.req));
  if (!user) throw new HttpError(401, 'Not logged in');
  await h(ctx, user);
};

const admin = (h: Authed) => authed(async (ctx, user) => {
  if (!user.is_admin) throw new HttpError(403, 'Administrators only');
  await h(ctx, user);
});

const router = new Router();
registerAccount(router, authed, admin);
registerPasskeys(router, authed);
registerFiles(router, authed);
registerUploadChunks(router);
registerShares(router, authed);
registerGroupware(router, authed);
registerOffice(router, authed);
registerMail(router, authed, admin);
registerLimits(router, admin);
// Live updates (Server-Sent Events): {folders, shares} whenever something the user can see changes.
router.get('/api/events', authed(async ({ res }, user) => openStream(user.id, res)));
router.get('/status', async ({ res }) => {
  await q('SELECT 1');
  json(res, { ok: true, version: config.version });
});

// ---------------------------------------------------------------- static HTML5 app

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const CSP = [
  "default-src 'self'", "img-src 'self' blob: data:", "media-src 'self' blob:", "frame-src 'self'",
  "style-src 'self' 'unsafe-inline'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "form-action 'self'",
].join('; ');

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel = url.pathname;
  if (rel === '/' || rel === '/app' || rel.startsWith('/app/')) rel = '/index.html';
  else if (/^\/s\/[\w-]+$/.test(rel)) rel = '/public.html';
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return false; }
  const file = path.join(config.publicDir, path.normalize(decoded).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(config.publicDir)) return false;
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  const headers = {
    'Content-Type': STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else sendFile(res, file);
  return true;
}

// ---------------------------------------------------------------- dispatch

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (await handleDav(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      // CSRF guard: browsers cannot send custom headers cross-site without CORS.
      if (!['GET', 'HEAD'].includes(req.method!) && req.headers['x-cloudy-request'] !== '1') {
        throw new HttpError(403, 'Missing X-Cloudy-Request header');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    const m = router.match(req.method!, url.pathname);
    if (m) return await m.handler({ req, res, url, params: m.params });
    if (await serveStatic(req, res, url)) return;
    throw new HttpError(404, 'Not found');
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return void res.destroy();
    const message = status === 500 ? 'Internal server error' : e.message;
    if (url.pathname.startsWith('/api/') || url.pathname === '/status') json(res, { error: message, ...(e instanceof HttpError ? e.data : {}) }, status);
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message + '\n');
    }
  }
}

async function jobs(): Promise<void> {
  try {
    await q(`DELETE FROM sessions WHERE expires_at < now()`);
    await expireUploads();
    await cleanStorage();
    await pruneOfficeCache();
    await expirePasswordResets();
    const n = await expireTrash();
    if (n) console.log(`purged ${n} expired trash item(s)`);
    await gcHashes();
    backfillHashes(); // runs on in the background, one blob at a time
  } catch (e) {
    console.error('background job failed', e);
  }
}

try {
  await ensureDirs();
} catch (e: any) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}
await migrate();
await loadLimits();
await ensureAdmin();
await startLiveUpdates();
const server = createServer((req, res) => void handle(req, res));
server.requestTimeout = 0; // large uploads/downloads
server.headersTimeout = 60_000;
server.listen(config.port, () => console.log(`Cloudy ${config.version} listening on :${config.port}`));
setInterval(jobs, 60 * 60 * 1000).unref();
void jobs();

// Shutdown: stop accepting, end the live-update streams (they would hold the server open for ever), give uploads
// and downloads a few seconds, then go. Docker waits 10 s before SIGKILL, so this stays well under that.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    closeStreams();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
    setTimeout(() => process.exit(0), 7000).unref();
  });
}
