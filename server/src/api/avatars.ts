// Profile pictures: PUT /api/me/avatar (the picture's bytes), DELETE /api/me/avatar, GET /api/users/:id/avatar.
// Only JPEG, PNG and WebP, recognised by their first bytes (never by the Content-Type the client sends), at most 1 MiB
// and 1024 × 1024 pixels: other people's browsers decode these pictures, and a small file can unpack into gigabytes of
// pixels, so the size written in the header decides. The picture is not re-encoded, but what it says about the photo
// (EXIF with the place and the camera, XMP, comments, text chunks) is cut out before it is stored: every signed-in user
// can see it. The web app sends a 512 px square drawn on a canvas anyway; other clients may not.
import { createHash } from 'node:crypto';
import type { Router, Ctx } from '../http.ts';
import { json, noContent, readBuffer, HttpError } from '../http.ts';
import { q, one } from '../db.ts';
import type { User } from '../auth.ts';
import { USER_ID_RE } from '../users.ts';

type Authed = (ctx: Ctx, user: User) => Promise<void>;
type Wrap = (h: Authed) => (ctx: Ctx) => Promise<void>;

export const MAX_BYTES = 1024 * 1024;
export const MAX_SIDE = 1024;
const TOO_BIG = 'Picture is too large (max 1 MB)';
const WRONG_TYPE = 'Use a JPEG, PNG or WebP picture';
const TOO_MANY_PIXELS = 'Picture is too large (max 1024 × 1024 pixels)';

export interface Picture { mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Type and size of a picture from its header; null when it is no JPEG, PNG or WebP, or when its header cannot be read
 * (a side of 0 included: a JPEG may leave its height to a marker after the image data).
 */
export function pictureInfo(b: Buffer): Picture | null {
  const found = png(b) ?? jpeg(b) ?? webp(b);
  return found && found.width > 0 && found.height > 0 ? found : null;
}

/** The signature, then the IHDR chunk (always first, 13 bytes long) with width and height. */
function png(b: Buffer): Picture | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/**
 * The segments up to the frame header (SOF0…SOF15 without DHT, JPG and DAC), which holds the size. Other segments
 * (EXIF with its own small preview, ICC profiles…) are skipped by their length; markers may be padded with extra 0xFF
 * bytes; RSTn and TEM have no length. Image data or the end of the image before any frame header: unreadable.
 */
function jpeg(b: Buffer): Picture | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const length = b.readUInt16BE(i); // includes its own two bytes
    if (length < 2 || i + length > b.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Baseline, extended and progressive only: browsers do not show the others, and a hierarchical one keeps its
      // real size elsewhere.
      if (marker > 0xc2 || length < 8) return null; // precision, height, width, components
      return { mime: 'image/jpeg', width: b.readUInt16BE(i + 5), height: b.readUInt16BE(i + 3) };
    }
    i += length;
  }
  return null;
}

/** RIFF…WEBP, then the first chunk: simple lossy (VP8), lossless (VP8L) or extended (VP8X: alpha, animation…). */
function webp(b: Buffer): Picture | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // A key frame: 3 bytes of frame tag, the start code 9D 01 2A, then 14-bit width and height (2 bits of scaling).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // The signature byte 0x2F, then 14 bits each of width − 1 and height − 1.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Flags and 3 reserved bytes, then the canvas (every frame fits in it): 24 bits each of width − 1 and height − 1.
    return { mime: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

// ---------------------------------------------------------------- metadata
/**
 * The picture without what it says about the photo; the same bytes when there is nothing to remove; null when its
 * structure cannot be followed (refused like any other unreadable picture).
 */
export function withoutMetadata(b: Buffer, mime: Picture['mime']): Buffer | null {
  return mime === 'image/jpeg' ? jpegWithout(b) : mime === 'image/png' ? pngWithout(b) : webpWithout(b);
}

/**
 * JPEG: APP1 (EXIF, XMP), APP3–APP13 (IPTC and other application data), APP15 and comments go; JFIF (APP0), colour
 * profiles (APP2) and Adobe's colour flags (APP14) stay. Everything from the image data (SOS) on is kept as it is.
 */
function jpegWithout(b: Buffer): Buffer | null {
  const kept: Buffer[] = [b.subarray(0, 2)];
  let dropped = false;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;
    const marker = b[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { kept.push(Buffer.from([0xff, marker])); continue; }
    if (marker === 0xd9) { kept.push(Buffer.from([0xff, 0xd9])); break; } // the end, without image data
    if (marker === 0x00 || i + 2 > b.length) return null;
    const length = b.readUInt16BE(i);
    if (length < 2 || i + length > b.length) return null;
    if (marker === 0xda) { kept.push(Buffer.from([0xff, 0xda]), b.subarray(i)); break; }
    if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2 && marker !== 0xee)) dropped = true;
    else kept.push(Buffer.from([0xff, marker]), b.subarray(i, i + length));
    i += length;
  }
  return dropped ? Buffer.concat(kept) : b;
}

const PNG_TEXT = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** PNG: EXIF, the text chunks and the time stamp go, and anything after IEND. */
function pngWithout(b: Buffer): Buffer | null {
  const kept: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const end = i + 12 + b.readUInt32BE(i);
    if (end > b.length) return null;
    const type = b.toString('latin1', i + 4, i + 8);
    if (!PNG_TEXT.has(type)) kept.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      const out = Buffer.concat(kept);
      return out.length === b.length ? b : out;
    }
  }
  return null;
}

/** WebP: the EXIF and XMP chunks go, and their flags in the extended header (VP8X) are cleared. */
function webpWithout(b: Buffer): Buffer | null {
  const kept: Buffer[] = [];
  let dropped = false;
  let i = 12;
  while (i + 8 <= b.length) {
    const size = b.readUInt32LE(i + 4);
    if (i + 8 + size > b.length) return null;
    const end = Math.min(b.length, i + 8 + size + (size & 1)); // chunks are padded to an even length
    const type = b.toString('latin1', i, i + 4);
    if (type === 'EXIF' || type === 'XMP ') dropped = true;
    else {
      const chunk = Buffer.from(b.subarray(i, end));
      if (type === 'VP8X' && size >= 1 && chunk[8] & 0x0c) { chunk[8] &= ~0x0c; dropped = true; }
      kept.push(chunk);
    }
    i = end;
  }
  if (!dropped) return b;
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** If-None-Match: one or more tags (weak ones too) or "*". */
function matches(header: string | undefined, etag: string): boolean {
  return !!header && header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

export async function removeAvatar(userId: string): Promise<void> {
  await q(`DELETE FROM avatars WHERE user_id = $1`, [userId]);
}

export function registerAvatars(r: Router, authed: Wrap) {
  // The body is the picture itself. Answers its new version: the `avatar` of the user's JSON from now on.
  r.put('/api/me/avatar', authed(async ({ req, res }, user) => {
    // A declared size over the limit is refused before reading (Node then discards the body; the answer arrives).
    if (Number(req.headers['content-length']) > MAX_BYTES) throw new HttpError(413, TOO_BIG);
    let data: Buffer;
    try {
      data = await readBuffer(req, MAX_BYTES);
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) throw new HttpError(413, TOO_BIG);
      throw e;
    }
    const pic = pictureInfo(data);
    if (!pic) throw new HttpError(400, WRONG_TYPE);
    if (pic.width > MAX_SIDE || pic.height > MAX_SIDE) throw new HttpError(400, TOO_MANY_PIXELS);
    const clean = withoutMetadata(data, pic.mime);
    if (!clean || !pictureInfo(clean)) throw new HttpError(400, WRONG_TYPE);
    data = clean;
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 16);
    await q(`INSERT INTO avatars (user_id, data, mime, etag) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, mime = EXCLUDED.mime, etag = EXCLUDED.etag, updated_at = now()`,
      [user.id, data, pic.mime, etag]);
    json(res, { avatar: etag });
  }));

  r.delete('/api/me/avatar', authed(async ({ res }, user) => {
    await removeAvatar(user.id);
    noContent(res);
  }));

  // Any signed-in user sees anyone's picture (names are visible to them too: sharing, shared items).
  r.get('/api/users/:id/avatar', authed(async ({ req, res, url, params }) => {
    // The version first: an unchanged picture is answered (304) without loading it.
    const known = USER_ID_RE.test(params.id)
      ? await one<{ etag: string }>(`SELECT etag FROM avatars WHERE user_id = $1`, [params.id])
      : undefined;
    if (!known) throw new HttpError(404, 'No profile picture');
    if (matches(req.headers['if-none-match'], `"${known.etag}"`)) {
      res.writeHead(304, { ETag: `"${known.etag}"`, 'Cache-Control': url.searchParams.get('v') === known.etag ? 'private, max-age=31536000, immutable' : 'private, no-cache' });
      return void res.end();
    }
    const row = await one<{ data: Buffer; mime: string; etag: string }>(`SELECT data, mime, etag FROM avatars WHERE user_id = $1`, [params.id]);
    if (!row) throw new HttpError(404, 'No profile picture');
    const etag = `"${row.etag}"`;
    const headers: Record<string, string | number> = {
      ETag: etag,
      // The address with the picture's version (?v=<avatar>) never shows another picture: kept for good. Without it,
      // or with an old one, the browser asks each time (a 304 while unchanged).
      'Cache-Control': url.searchParams.get('v') === row.etag ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (matches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': row.mime, 'Content-Length': row.data.length });
    res.end(req.method === 'HEAD' ? undefined : row.data);
  }));
}
