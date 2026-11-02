// Read-only office previews: Word, Excel, PowerPoint and OpenDocument files are converted to PDF with
// LibreOffice (headless, in the same container) and shown in the browser's or the app's PDF viewer.
// Results are cached per file version (DATA_DIR/cache/previews/<id>-<etag>.pdf), so a document is
// converted once after each change. One conversion runs at a time; LibreOffice is started per file.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Router, Ctx } from './http.ts';
import { json, HttpError } from './http.ts';
import { config } from './config.ts';
import type { User } from './auth.ts';
import { contentDisposition } from './download.ts';
import * as F from './files.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;

/** Extensions converted to PDF for viewing. */
export const OFFICE_EXT = [
  'doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'ott', 'rtf',
  'xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'ods', 'ots',
  'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'otp', 'odg',
];
const OFFICE = new Set(OFFICE_EXT);
const MAX_SIZE = 100 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const CACHE_DAYS = 30;

const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
export const isOffice = (name: string) => OFFICE.has(ext(name));
const cacheDir = () => path.join(config.dataDir, 'cache', 'previews');
const SOFFICE = process.env.SOFFICE_PATH || 'soffice';

// ---------------------------------------------------------------- conversion queue

let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<string>>();

// Own profile outside DATA_DIR (which may be NFS); reused between runs so startup stays fast.
const PROFILE = path.join(process.env.TMPDIR || '/tmp', 'cloudy-libreoffice');
// Address-space cap for one conversion (crafted documents can make LibreOffice allocate without end).
const MAX_MEMORY = 6 * 1024 * 1024 * 1024;
let profileReady = false;

/**
 * Documents come from users: links in them must not be fetched (no requests from inside the container) and
 * macros never run. LibreOffice reads these from the profile; written once per process start.
 */
async function prepareProfile(): Promise<void> {
  if (profileReady) return;
  await mkdir(path.join(PROFILE, 'user'), { recursive: true });
  const item = (p: string, name: string, v: string | number) =>
    `<item oor:path="${p}"><prop oor:name="${name}" oor:op="fuse"><value>${v}</value></prop></item>`;
  await writeFile(path.join(PROFILE, 'user', 'registrymodifications.xcu'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`
    + item('/org.openoffice.Office.Common/Security/Scripting', 'MacroSecurityLevel', 3)
    + item('/org.openoffice.Office.Writer/Content/Update', 'Link', 0) // never
    + item('/org.openoffice.Office.Calc/Content/Update', 'Link', 1) // never
    + `\n</oor:items>\n`);
  profileReady = true;
}

function runSoffice(input: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
      `-env:UserInstallation=file://${PROFILE}`,
      '--convert-to', 'pdf', '--outdir', outDir, input,
    ];
    // util-linux's prlimit (in the image) caps the memory of the whole conversion; absent on a dev Mac.
    const limited = existsSync('/usr/bin/prlimit');
    const p = spawn(limited ? '/usr/bin/prlimit' : SOFFICE, limited ? [`--as=${MAX_MEMORY}`, SOFFICE, ...args] : args,
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: process.env.TMPDIR || '/tmp' }, detached: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    // Kill the whole process group: soffice is a wrapper around soffice.bin, which would otherwise live on.
    const kill = () => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } };
    const timer = setTimeout(kill, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `LibreOffice timed out` : `LibreOffice exited with ${code}: ${err.trim()}`));
    });
  });
}

async function convert(node: F.Node): Promise<string> {
  const out = path.join(cacheDir(), `${node.id}-${node.etag}.pdf`);
  if (await stat(out).then(() => true, () => false)) return out;
  const key = out;
  const running = inFlight.get(key);
  if (running) return running;
  const job = (queue = queue.catch(() => {}).then(async () => {
    await mkdir(cacheDir(), { recursive: true });
    await prepareProfile();
    const work = await mkdtemp(path.join(config.dataDir, 'tmp', 'preview-'));
    try {
      // LibreOffice picks the import filter from the extension; blobs have none, so link with the real one.
      const input = path.join(work, `${node.id}.${ext(node.name)}`);
      await symlink(F.blobPath(node.blob!), input);
      await runSoffice(input, work);
      const pdf = path.join(work, `${node.id}.pdf`);
      if (!(await stat(pdf).catch(() => null))?.size) throw new Error('LibreOffice produced no PDF');
      await rename(pdf, out);
      // Older versions of this file are no longer needed.
      for (const f of await readdir(cacheDir())) {
        if (f.startsWith(`${node.id}-`) && f !== path.basename(out)) await rm(path.join(cacheDir(), f), { force: true });
      }
      return out;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  })) as Promise<string>;
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/** Hourly job: drop previews not converted or used for CACHE_DAYS (and those of deleted files). */
export async function pruneOfficeCache(): Promise<void> {
  const files = await readdir(cacheDir()).catch(() => [] as string[]);
  const cutoff = Date.now() - CACHE_DAYS * 86400 * 1000;
  for (const f of files) {
    const p = path.join(cacheDir(), f);
    const st = await stat(p).catch(() => null);
    if (st && Math.max(st.mtimeMs, st.atimeMs) < cutoff) await rm(p, { force: true });
  }
}

// ---------------------------------------------------------------- routes

export function registerOffice(r: Router, authed: (h: Authed) => (ctx: Ctx) => Promise<void>) {
  // File types shown as PDF previews.
  r.get('/api/office', authed(async ({ res }) => {
    json(res, { enabled: true, extensions: OFFICE_EXT });
  }));

  r.get('/api/nodes/:id/preview', authed(async ({ req, res, params }, user) => {
    const { node } = await F.requireAccess(user.id, params.id, 'read');
    if (node.is_dir || !isOffice(node.name)) throw new HttpError(415, 'No preview for this file type');
    if (!node.blob || !node.size) throw new HttpError(422, 'This document is empty');
    if (node.size > MAX_SIZE) throw new HttpError(413, 'This document is too large to preview');
    const etag = `"pdf-${node.etag}"`;
    const headers = {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('inline', node.name.replace(/\.[^.]+$/, '') + '.pdf'),
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    let pdf: string;
    try {
      pdf = await convert(node);
    } catch (e: any) {
      console.error(`preview of node ${node.id} failed:`, e.message);
      throw new HttpError(422, e.code === 'ENOENT' ? 'Office previews are not available on this server' : 'This document could not be converted for preview');
    }
    const st = await stat(pdf);
    await utimes(pdf, new Date(), new Date()).catch(() => {}); // keeps used previews in the cache
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    createReadStream(pdf).pipe(res);
  }));
}
