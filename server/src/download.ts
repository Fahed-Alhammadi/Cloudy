import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { blobPath, children } from './files.ts';
import type { Node } from './files.ts';

/** Types the browser may render inline (never HTML/SVG: those could run script on our origin). */
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|video\/|audio\/|application\/pdf$|text\/)/;

export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Streams a stored file blob, honoring Range and If-None-Match. */
export function sendBlob(
  req: IncomingMessage,
  res: ServerResponse,
  blob: string,
  opts: { size: number; mime: string; etag: string; mtime: Date; name: string; inline?: boolean },
): void {
  const etag = `"${opts.etag}"`;
  const inline = !!opts.inline && INLINE_SAFE.test(opts.mime);
  // Text is always delivered as plain text so it cannot execute.
  const type = inline && opts.mime.startsWith('text/') ? 'text/plain; charset=utf-8' : opts.mime;
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(opts.mtime).toUTCString(),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', opts.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
  };
  if (!opts.mime.startsWith('application/pdf')) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let start = 0;
  let end = opts.size - 1;
  let status = 200;
  // A resume (If-Range) of a file that changed since gets the whole new file, not a mix of two versions.
  const ifRange = req.headers['if-range'];
  const changed = ifRange !== undefined && ifRange !== etag && ifRange !== headers['Last-Modified'];
  const range = changed ? null : /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && opts.size > 0) {
    if (range[1] === '') {
      start = Math.max(0, opts.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= opts.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${opts.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${opts.size}`;
  }
  headers['Content-Length'] = opts.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || opts.size === 0) {
    res.end();
    return;
  }
  createReadStream(blobPath(blob), { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
}

export function sendNodeFile(req: IncomingMessage, res: ServerResponse, node: Node, inline = false): void {
  sendBlob(req, res, node.blob!, { size: node.size, mime: node.mime, etag: node.etag, mtime: node.mtime, name: node.name, inline });
}

// ---------------------------------------------------------------- zip

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Streams a folder as an uncompressed ZIP (data descriptors, UTF-8 names).
 * Store-only keeps CPU low; most cloud content is already compressed.
 */
export async function sendZip(res: ServerResponse, root: Node): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition('attachment', (root.name || 'files') + '.zip'),
    'Cache-Control': 'no-store',
  });
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  // A client that goes away must end the walk (the catch below destroys the response): a destroyed response never
  // drains, and a write waiting for it would keep the blob's read stream and its file descriptor open for good.
  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (res.destroyed || res.writableEnded) return reject(new Error('client disconnected'));
      offset += buf.length;
      if (res.write(buf)) return resolve();
      const onDrain = () => { res.off('close', onClose); resolve(); };
      const onClose = () => { res.off('drain', onDrain); reject(new Error('client disconnected')); };
      res.once('drain', onDrain);
      res.once('close', onClose);
    });

  const addEntry = async (name: string, node: Node | null) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(node ? new Date(node.mtime) : new Date());
    const isDir = !node || node.is_dir;
    const flags = isDir ? 0x0800 : 0x0808;
    const headerOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([local, nameBuf]));

    let crc = 0;
    let size = 0;
    if (!isDir && node!.blob) {
      for await (const chunk of createReadStream(blobPath(node!.blob))) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        await write(chunk);
      }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
      await write(desc);
    }

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(size, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(isDir ? 0x10 : 0, 38);
    cen.writeUInt32LE(headerOffset, 42);
    central.push(cen, nameBuf);
    count++;
  };

  const walk = async (dir: Node, prefix: string) => {
    for (const c of await children(dir.id)) {
      const name = prefix + c.name + (c.is_dir ? '/' : '');
      await addEntry(name, c);
      if (c.is_dir) await walk(c, name);
    }
  };

  try {
    await walk(root, '');
    const cd = Buffer.concat(central);
    const cdOffset = offset;
    await write(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(cdOffset, 16);
    res.end(end);
  } catch {
    res.destroy();
  }
}
