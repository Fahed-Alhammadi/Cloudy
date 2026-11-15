import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';
import { migrate, q } from './db.ts';
import { Router, HttpError, json, requestUrl, acceptedEncoding, compress } from './http.ts';
import type { Ctx } from './http.ts';
import { sessionUser, bearerUser } from './auth.ts';
import type { User } from './auth.ts';
import { ensureAdmin } from './users.ts';
import { ensureDirs, expireTrash, cleanStorage, gcHashes, backfillHashes, repairNamesAndTypes } from './files.ts';
import { handleDav } from './dav/server.ts';
import { sendFile } from './download.ts';
import { registerAccount } from './api/account.ts';
import { registerPasskeys } from './api/passkeys.ts';
import { registerFiles, registerUploadChunks, expireUploads } from './api/files.ts';
import { registerShares } from './api/shares.ts';
import { registerGroupware } from './api/groupware.ts';
import { openStream, startLiveUpdates, closeStreams } from './events.ts';
import { registerOffice, pruneOfficeCache } from './office.ts';
import { pruneThumbnails } from './thumbs.ts';
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
router.get('/api/events', authed(async ({ req, res }, user) => {
  if (req.method === 'HEAD') { // the stream itself never ends; HEAD only asks whether it is there
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    return void res.end();
  }
  openStream(user.id, res, async () => ((await bearerUser(req)) ?? (await sessionUser(req)))?.id === user.id);
}));
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

// The web app's pages have plain addresses (/files/12, /settings…; "#/…" before 1.18): each one is the app, which
// reads the path itself. /app is an older address of the app. Public links: /s/<token> and its folders /s/<token>/<id>.
const APP_PAGES = /^\/(?:(?:files|recent|favorites|shared-in|shared-out|search|trash|calendar|contacts|settings|admin|forgot|reset)(?:\/[^/]*)?|app(?:\/.*)?)?$/;
const PUBLIC_PAGES = /^\/s\/[\w-]+(?:\/\d+)?$/;

const compressedStatic = new Map<string, Buffer>();

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, status = 200): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel = url.pathname;
  if (APP_PAGES.test(rel)) rel = '/index.html';
  else if (PUBLIC_PAGES.test(rel)) rel = '/public.html';
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return false; }
  const file = path.join(config.publicDir, path.normalize(decoded).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(config.publicDir)) return false;
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return false;
  const type = STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream';
  // Text files (the app's scripts, styles, translations) go compressed when the browser accepts it.
  const enc = /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type) ? acceptedEncoding(req) : null;
  const version = `${st.size.toString(16)}-${st.mtimeMs.toString(16)}`;
  const etag = `"${version}${enc ? `-${enc}` : ''}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Accept-Encoding',
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (enc) {
    const key = `${file}|${version}|${enc}`;
    let body = compressedStatic.get(key);
    if (!body) {
      body = compress(await readFile(file), enc);
      if (compressedStatic.size > 200) compressedStatic.clear();
      compressedStatic.set(key, body);
    }
    res.writeHead(status, { ...headers, 'Content-Encoding': enc, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  res.writeHead(status, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else sendFile(res, file);
  return true;
}

// ---------------------------------------------------------------- dispatch

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = requestUrl(req.url ?? '/');
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    return void res.end('Bad request\n');
  }
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
    // A mistyped or outdated address opened in the browser (/Recent, /nope): the app, which says the page does not
    // exist and offers the way back, instead of a bare "Not found" text page.
    if ((req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html')
        && !/^\/(api|dav|s)(\/|$)/.test(url.pathname) && !/\.[\w]+$/.test(url.pathname)
        && (await serveStatic(req, res, new URL('http://localhost/index.html'), 404))) return;
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

/** Hourly housekeeping. Each step on its own: one that fails (a full disk, a database hiccup) no longer skips the rest. */
async function jobs(): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ['sessions', () => q(`DELETE FROM sessions WHERE expires_at < now()`)],
    ['uploads', expireUploads],
    ['storage', cleanStorage],
    ['office previews', pruneOfficeCache],
    ['thumbnails', pruneThumbnails],
    ['password resets', expirePasswordResets],
    ['trash', async () => { const n = await expireTrash(); if (n) console.log(`purged ${n} expired trash item(s)`); }],
    ['hashes', gcHashes],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      console.error(`background job "${name}" failed`, e);
    }
  }
  backfillHashes(); // runs on in the background, one blob at a time
}

try {
  await ensureDirs();
} catch (e: any) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}
await migrate();
// A failure here is logged and the server starts anyway; the repair runs again at the next start.
await repairNamesAndTypes().catch((e) => console.error('repairing names and file types failed (tried again at the next start):', e));
await loadLimits();
await ensureAdmin();
await startLiveUpdates();
// A request that fails outside its own error handling is answered and logged; it never takes the process with it.
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
// keepAlive: TCP probes find peers that vanished (a phone that left the Wi-Fi sends no goodbye) on idle connections.
const server = createServer({ keepAlive: true, keepAliveInitialDelay: 30_000 }, (req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    res.destroy();
  });
});
server.requestTimeout = 0; // large uploads/downloads (stalled bodies are cut by http.ts watchIdle instead)
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
