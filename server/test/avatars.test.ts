// Profile pictures: the type comes from the first bytes, the size from the header (a small file must not unpack into
// gigabytes of pixels in other people's browsers).  Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { pictureInfo, withoutMetadata } from '../src/api/avatars.ts';

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

function png(width: number, height: number, ihdrLength = 13): Buffer {
  const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]).subarray(0, ihdrLength);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))]);
}

/** A JPEG's segments: [marker, payload] (payload without the length bytes), between SOI and EOI. */
function jpeg(...segments: [number, Buffer][]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]),
    ...segments.map(([m, data]) => Buffer.concat([Buffer.from([0xff, m]), u16(data.length + 2), data])), Buffer.from([0xff, 0xd9])]);
}
const sof = (width: number, height: number) => Buffer.concat([Buffer.from([8]), u16(height), u16(width), Buffer.from([1, 1, 0x11, 0])]);
const app0 = Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1');

function webpX(width: number, height: number): Buffer {
  const canvas = Buffer.alloc(10);
  canvas.writeUIntLE(width - 1, 4, 3);
  canvas.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBPVP8X', 'latin1'), u32(10).reverse(), canvas]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from(u32(body.length).reverse()), body]);
}

test('PNG: the size from IHDR', () => {
  assert.deepEqual(pictureInfo(png(640, 480)), { mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(pictureInfo(png(100_000, 1)), { mime: 'image/png', width: 100_000, height: 1 }); // refused by the caller
  assert.equal(pictureInfo(png(0, 10)), null);
  assert.equal(pictureInfo(png(10, 10, 12)), null); // IHDR of the wrong length
  assert.equal(pictureInfo(png(10, 10).subarray(0, 20)), null); // cut off
});

test('JPEG: the frame header, past other segments and fill bytes', () => {
  // EXIF carries its own small preview with a frame header inside: skipped with its segment.
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from([0xff, 0xc0, 0, 17, 8, 0x7f, 0xff, 0x7f, 0xff])]);
  const dht = Buffer.alloc(20);
  assert.deepEqual(pictureInfo(jpeg([0xe0, app0], [0xe1, exif], [0xdb, Buffer.alloc(65)], [0xc0, sof(320, 200)], [0xc4, dht])),
    { mime: 'image/jpeg', width: 320, height: 200 });
  assert.deepEqual(pictureInfo(jpeg([0xe0, app0], [0xc4, dht], [0xc2, sof(1024, 768)])), { mime: 'image/jpeg', width: 1024, height: 768 }); // progressive
  const padded = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xc0]), u16(sof(5, 7).length + 2), sof(5, 7)]);
  assert.deepEqual(pictureInfo(padded), { mime: 'image/jpeg', width: 5, height: 7 });
  assert.deepEqual(pictureInfo(jpeg([0xc0, sof(4000, 3000)])), { mime: 'image/jpeg', width: 4000, height: 3000 });
  assert.equal(pictureInfo(jpeg([0xe0, app0], [0xda, Buffer.alloc(10)])), null); // image data before any frame header
  assert.equal(pictureInfo(jpeg([0xc0, sof(100, 0)])), null); // height left to a later marker
  assert.equal(pictureInfo(jpeg([0xe0, app0]).subarray(0, 12)), null); // segment longer than the file
  assert.equal(pictureInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null);
  // Lossless and hierarchical frames: browsers don't show them, and a hierarchical one keeps its real size elsewhere.
  assert.equal(pictureInfo(jpeg([0xc3, sof(10, 10)])), null);
  assert.equal(pictureInfo(jpeg([0xc5, sof(10, 10)])), null);
});

test('WebP: lossy, lossless and extended headers', () => {
  const samples = {
    lossy: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    lossless: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
    alpha: 'UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==',
    animated: 'UklGRlIAAABXRUJQVlA4WAoAAAASAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GJgAAAAAAAAAAAAAAAAAAAGQAAABWUDhMDQAAAC8AAAAQBxAREYiI/gcA',
  };
  for (const [kind, b64] of Object.entries(samples)) {
    assert.deepEqual(pictureInfo(Buffer.from(b64, 'base64')), { mime: 'image/webp', width: 1, height: 1 }, kind);
  }
  assert.deepEqual(pictureInfo(webpX(5000, 3000)), { mime: 'image/webp', width: 5000, height: 3000 });
  const broken = Buffer.from(samples.lossy, 'base64');
  broken[24] = 0; // the VP8 start code
  assert.equal(pictureInfo(broken), null);
  const other = Buffer.from(samples.lossy, 'base64');
  other.write('ABCD', 12, 'latin1'); // an unknown first chunk
  assert.equal(pictureInfo(other), null);
});

test('anything else is no picture', () => {
  for (const s of ['', 'GIF89a\x01\0\x01\0\0\0\0', '<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><script>x</script>',
    'RIFF\0\0\0\0WAVEfmt ' + ' '.repeat(40), 'hello world, not an image at all']) {
    assert.equal(pictureInfo(Buffer.from(s, 'latin1')), null, JSON.stringify(s.slice(0, 12)));
  }
});

test('metadata is cut out: EXIF, XMP, comments, text chunks', () => {
  // JPEG: APP1 (EXIF) and a comment go; JFIF, the colour profile (APP2), the frame and the image data stay.
  const exif = Buffer.concat([Buffer.from('Exif\0\0GPS 25.2048 N, 55.2708 E', 'latin1')]);
  const icc = Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1');
  const scan = Buffer.concat([Buffer.from([0xff, 0xda]), u16(8), Buffer.from([1, 1, 0, 0, 0x3f, 0]), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56])]);
  const photo = Buffer.concat([jpeg([0xe0, app0], [0xe1, exif], [0xe2, icc], [0xfe, Buffer.from('taken by Sam', 'latin1')], [0xc0, sof(64, 48)]).subarray(0, -2),
    scan, Buffer.from([0xff, 0xd9])]);
  const clean = withoutMetadata(photo, 'image/jpeg')!;
  assert.ok(!clean.includes('Exif') && !clean.includes('GPS') && !clean.includes('taken by Sam'));
  assert.ok(clean.includes('JFIF') && clean.includes('ICC_PROFILE'));
  assert.ok(clean.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9])));
  assert.deepEqual(pictureInfo(clean), { mime: 'image/jpeg', width: 64, height: 48 });
  const plain = jpeg([0xe0, app0], [0xc0, sof(8, 8)]);
  assert.equal(withoutMetadata(plain, 'image/jpeg'), plain); // nothing to remove: the same bytes

  // PNG: tEXt, iTXt, eXIf and tIME go (and anything after IEND); IHDR, IDAT and IEND stay.
  const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
  const base = png(4, 4);
  const iend = base.length - 12;
  const tagged = Buffer.concat([base.subarray(0, iend), chunk('tEXt', Buffer.from('Author\0Sam', 'latin1')), chunk('eXIf', Buffer.from('MM\0*GPS', 'latin1')),
    chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1')), chunk('tIME', Buffer.alloc(7)), base.subarray(iend), Buffer.from('trailing')]);
  const cleanPng = withoutMetadata(tagged, 'image/png')!;
  assert.ok(cleanPng.equals(base), 'only IHDR, IDAT, IEND are left');
  assert.equal(withoutMetadata(base, 'image/png'), base);

  // WebP: EXIF and XMP chunks go and their flags in VP8X are cleared; the RIFF size matches the new length.
  const alpha = Buffer.from('UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==', 'base64');
  const exifChunk = Buffer.concat([Buffer.from('EXIF', 'latin1'), Buffer.from([5, 0, 0, 0]), Buffer.from('GPS!!', 'latin1'), Buffer.from([0])]);
  const xmpChunk = Buffer.concat([Buffer.from('XMP ', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('<x/>', 'latin1')]);
  const body = Buffer.concat([alpha.subarray(12), exifChunk, xmpChunk]);
  const withMeta = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), body]);
  withMeta.writeUInt32LE(withMeta.length - 8, 4);
  withMeta[20] |= 0x0c; // VP8X flags: EXIF and XMP present
  const cleanWebp = withoutMetadata(withMeta, 'image/webp')!;
  assert.ok(!cleanWebp.includes('EXIF') && !cleanWebp.includes('GPS') && !cleanWebp.includes('XMP '));
  assert.equal(cleanWebp[20] & 0x0c, 0);
  assert.equal(cleanWebp.readUInt32LE(4), cleanWebp.length - 8);
  assert.ok(cleanWebp.equals(alpha), 'the picture without its metadata is the original file');
  assert.equal(withoutMetadata(alpha, 'image/webp'), alpha);

  assert.equal(withoutMetadata(base.subarray(0, 30), 'image/png'), null); // cut off: unreadable
});
