// Thumbnails: small previews of photos and pictures (and the first page of PDFs) for the web app's grid view and
// public links. Made once per file version with libvips (`vipsthumbnail`, in the image) and cached in
// DATA_DIR/cache/thumbs/<blob>.webp; blobs never change, so a cached thumbnail is never stale. Without the tool (a dev
// Mac) nothing is made and clients show the type icon.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, utimes, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { HttpError } from './http.ts';
import { sendFile } from './download.ts';
import * as F from './files.ts';

/** Longest side in pixels: sharp on 2× screens for a ~200 px grid tile, and for the apps' grids. */
const SIZE = 480;
const MAX_INPUT = 80 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CACHE_DAYS = 60;
const MAX_MEMORY = 2 * 1024 * 1024 * 1024;
const TOOL = process.env.VIPSTHUMBNAIL_PATH || '/usr/bin/vipsthumbnail';
const VIPS = path.join(path.dirname(TOOL), 'vips');
/**
 * Types libvips reads with its own loaders (libheif for HEIC/AVIF, poppler for PDF). SVG is left out on purpose (no
 * script engine), and so is BMP: only ImageMagick reads it, which is blocked for users' files.
 */
const THUMBABLE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif|tiff)|application\/pdf)$/;

const cacheDir = () => path.join(config.dataDir, 'cache', 'thumbs');
const cached = (blob: string) => path.join(cacheDir(), `${blob}.webp`);
const failedMark = (blob: string) => path.join(cacheDir(), `${blob}.none`);

let available: boolean | null = null;
/** Whether thumbnails can be made here (the tool is installed). */
export function thumbnailsAvailable(): boolean {
  available ??= existsSync(TOOL);
  return available;
}

export const canThumb = (node: F.Node) => !node.is_dir && !!node.blob && node.size > 0 && node.size <= MAX_INPUT && THUMBABLE.test(node.mime);

// Two at a time: each one is short, but a grid of hundreds of new photos asks for all of them at once.
const PARALLEL = 2;
let running = 0;
const waiting: (() => void)[] = [];
const inFlight = new Map<string, Promise<string | null>>();

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * Pictures go through vipsthumbnail with libvips' "untrusted" loaders blocked (ImageMagick and other large outside
 * libraries are never asked to read a user's file); PDFs go to the PDF loader by name, so a file that only claims to
 * be a PDF is refused instead of being handed to whichever loader recognises it.
 */
function vips(tool: string, args: string[], blockUntrusted: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const limited = existsSync('/usr/bin/prlimit');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', VIPS_CONCURRENCY: '1', HOME: process.env.TMPDIR || '/tmp' };
    if (blockUntrusted) env.VIPS_BLOCK_UNTRUSTED = '1';
    const p = spawn(limited ? '/usr/bin/prlimit' : tool, limited ? [`--as=${MAX_MEMORY}`, tool, ...args] : args,
      { stdio: ['ignore', 'ignore', 'pipe'], env, detached: true });
    let err = '';
    let timedOut = false;
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    const kill = () => { timedOut = true; try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } };
    const timer = setTimeout(kill, TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // refused: the tool ran and said no (it could not read the picture). Not when it was stopped from outside (out
      // of time, or killed for memory: code is null), and not when what it lacked was room to write the result.
      const refused = !timedOut && typeof code === 'number' && !/no space left|quota exceeded/i.test(err);
      reject(Object.assign(new Error(timedOut ? 'took too long' : err.trim() || `exit ${code}`), { timedOut, refused }));
    });
  });
}

async function run(input: string, output: string, pdf: boolean): Promise<void> {
  // `[0]`: the first frame of an animation. Output options strip metadata (location!) and keep the file small.
  if (!pdf) return vips(TOOL, [`${input}[0]`, '--size', `${SIZE}x${SIZE}>`, '-o', `${output}[Q=72,strip]`], true);
  // The first page at 48 dpi, then down to SIZE like a picture (a poster or a drawing came out thousands of pixels
  // wide). The page in between is in libvips' own format, made by the step before: no user's file, so the second
  // step may read it (libvips counts that format among the "untrusted" loaders, and blocked it failed every PDF).
  const page = `${output}.v`;
  try {
    await vips(VIPS, ['pdfload', input, page, '--page', '0', '--dpi', '48'], false);
    await vips(TOOL, [page, '--size', `${SIZE}x${SIZE}>`, '-o', `${output}[Q=72,strip]`], false);
  } finally {
    await rm(page, { force: true });
  }
}

/** The cached thumbnail of a file, made now if needed; null when this file has none (unsupported or unreadable). */
export async function thumbnail(node: F.Node): Promise<string | null> {
  if (!thumbnailsAvailable() || !canThumb(node)) return null;
  const blob = node.blob!;
  const out = cached(blob);
  if (await stat(out).then(() => true, () => false)) {
    utimes(out, new Date(), new Date()).catch(() => {}); // used: kept by the hourly prune
    return out;
  }
  if (await stat(failedMark(blob)).then(() => true, () => false)) return null;
  const running = inFlight.get(blob);
  if (running) return running;
  const job = slot(async () => {
    await mkdir(cacheDir(), { recursive: true });
    const tmp = path.join(cacheDir(), `.${blob}-${process.pid}-${Date.now()}.webp`);
    try {
      await run(F.blobPath(blob), tmp, node.mime === 'application/pdf');
      await rename(tmp, out);
      return out;
    } catch (e: any) {
      await rm(tmp, { force: true });
      // Not an image libvips can read, or a broken one: remembered, so it is not tried on every view. One that took
      // too long (a busy server?) is remembered for a day only: the mark is dated so that the hourly prune takes it.
      // Anything else (a full disk, the tool not starting, a file that could not be written or renamed) says nothing
      // about the picture and leaves no mark: such a failure used to cost every picture viewed meanwhile its
      // thumbnail for good.
      if (e?.refused || e?.timedOut) await writeFile(failedMark(blob), '').catch(() => {});
      if (e?.timedOut) {
        const soon = new Date(Date.now() - (CACHE_DAYS - 1) * 86_400_000);
        await utimes(failedMark(blob), soon, soon).catch(() => {});
      }
      console.warn(`no thumbnail for node ${node.id}: ${String(e?.message ?? e).split('\n')[0]}`);
      return null;
    }
  });
  inFlight.set(blob, job);
  try {
    return await job;
  } finally {
    inFlight.delete(blob);
  }
}

/** Answers a thumbnail request: the WebP, or 404 (the client shows the file's icon instead). */
export async function sendThumbnail(req: IncomingMessage, res: ServerResponse, node: F.Node): Promise<void> {
  const file = await thumbnail(node);
  if (!file) throw new HttpError(404, 'No thumbnail');
  // Not the blob's own id (internal, and visitors of public links get thumbnails too): a hash of it.
  const etag = `"t-${createHash('sha256').update(node.blob!).digest('hex').slice(0, 32)}"`;
  const headers = {
    'Content-Type': 'image/webp',
    // The address carries the file's version (?v=<etag>): a changed file gets a new address, so this one never changes.
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return void res.end();
  }
  const st = await stat(file);
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return void res.end();
  sendFile(res, file);
}

/** Hourly: thumbnails of files that are gone, and those not used for CACHE_DAYS. */
export async function pruneThumbnails(): Promise<void> {
  const dir = cacheDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - CACHE_DAYS * 86400_000;
  for (const name of names) {
    const p = path.join(dir, name);
    const blob = name.replace(/\.(webp|none)$/, '');
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    const gone = !name.startsWith('.') && !(await stat(F.blobPath(blob)).then(() => true, () => false));
    const stale = Math.max(st.mtimeMs, st.atimeMs) < cutoff;
    const leftover = name.startsWith('.') && st.mtimeMs < Date.now() - 3600_000; // an interrupted run
    if (gone || stale || leftover) await rm(p, { force: true });
  }
}
