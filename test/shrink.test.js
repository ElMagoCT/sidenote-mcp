import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { shrink, quick, orientation, decodePng, TARGET } from '../src/shrink.js';
import decodeJpeg from '../src/vendor/jpeg-decode.js';
import encodeJpeg from '../src/vendor/jpeg-encode.js';
import { fakeServer, seedAccount } from './fake.js';
import { handle } from '../src/rpc.js';
import { Account } from '../src/client.js';
import { getImage } from '../src/media.js';

// A PNG from a pixel function: (x, y) -> [r, g, b] or [r, g, b, a].
function png(w, h, fn, alpha = false) {
  const crc = (b) => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length); o.write(t, 4); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ch = alpha ? 4 : 3, raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = fn(x, y), o = y * (w * ch + 1) + 1 + x * ch; for (let i = 0; i < ch; i++) raw[o + i] = p[i] ?? 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// A JPEG with an EXIF orientation.
function jpeg(w, h, fn, turn = 1) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = fn(x, y), o = (y * w + x) * 4; data.set([p[0], p[1], p[2], 255], o); }
  const b = encodeJpeg({ data, width: w, height: h }, 90).data;
  if (turn === 1) return b;
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, turn, 0, 0, 0, 0, 0, 0];
  const app = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff], seg = [0xff, 0xe1, (app.length + 2) >> 8, (app.length + 2) & 255, ...app];
  return new Uint8Array([...b.subarray(0, 2), ...seg, ...b.subarray(2)]);
}
let seed = 1;
const noise = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;

test('a large photo-like PNG becomes a JPEG at most 1600 px and under the target', async () => {
  const src = png(2400, 1800, (x, y) => [(x / 10 + noise() / 8) & 255, (y / 8 + noise() / 8) & 255, (128 + 100 * Math.sin(x / 90) * Math.cos(y / 70)) & 255]);
  assert.ok(src.length > 4e6, src.length);
  const r = await shrink(src);
  assert.equal(r.type, 'image/jpeg');
  assert.deepEqual([r.w, r.h], [1600, 1200]);
  assert.ok(r.bytes.length <= TARGET, r.bytes.length);
  const d = decodeJpeg(r.bytes, { useTArray: true });
  assert.deepEqual([d.width, d.height], [1600, 1200]);
  // Pure noise doesn't get under the target at 1600 px, so it comes out smaller, same shape.
  const n = await shrink(png(1800, 1350, () => [noise(), noise(), noise()]));
  assert.ok(n.bytes.length <= TARGET && n.w < 1600 && Math.abs(n.w / n.h - 4 / 3) < 0.01, `${n.w}x${n.h}`);
  assert.equal(r.was, src.length);
});

test('a flat screenshot stays a sharp PNG; transparency stays', async () => {
  const shot = await shrink(png(2000, 1000, (x, y) => (y % 40 < 20 ? [250, 250, 250] : x < 1000 ? [30, 30, 30] : [200, 60, 60])));
  assert.equal(shot.type, 'image/png');
  assert.deepEqual([shot.w, shot.h], [1600, 800]);
  const ring = await shrink(png(2000, 1000, (x, y) => [0, 120, 255, Math.hypot(x - 1000, y - 500) < 400 ? 255 : 0], true));
  assert.equal(ring.type, 'image/png');
  const d = await decodePng(ring.bytes);
  assert.ok(d.alpha);
  assert.equal(d.px[3], 0, 'corner stays transparent');
  const c = (400 * 1600 + 800) * 4;
  assert.deepEqual([...d.px.subarray(c, c + 4)], [0, 120, 255, 255], 'middle keeps its colour, not darkened');
});

test('phone photos are turned upright from their EXIF orientation', async () => {
  // Left half red, right half blue, stored sideways with "rotate 90° clockwise" (6).
  const src = jpeg(2000, 1000, (x) => (x < 1000 ? [220, 20, 20] : [20, 20, 220]), 6);
  assert.equal(orientation(src), 6);
  const r = await shrink(src);
  assert.deepEqual([r.w, r.h], [800, 1600]);
  const d = decodeJpeg(r.bytes, { useTArray: true });
  const at = (x, y) => [...d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 3)];
  assert.ok(at(400, 10)[0] > 150 && at(400, 10)[2] < 80, 'top is the red half');
  assert.ok(at(400, 1590)[2] > 150 && at(400, 1590)[0] < 80, 'bottom is the blue half');
  // Small enough to keep as it is: kept, with its upright size.
  const small = jpeg(300, 200, () => [90, 90, 90], 8);
  assert.deepEqual((({ w, h }) => [w, h])(quick(small)), [200, 300]);
});

test('GIFs and WebPs are kept as they are, up to 1 MB', async () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, ...new Array(40).fill(0)]);
  assert.equal((await shrink(gif)).bytes, gif);
  const big = new Uint8Array(1_200_000); big.set(gif);
  await assert.rejects(shrink(big), /GIF is 1\.2 MB/);
  await assert.rejects(shrink(new Uint8Array([1, 2, 3, 4])), /isn’t a PNG/);
});

test('add_image shrinks what it is given and says so', async () => {
  const t = fakeServer().transport;
  const { syncKey } = await seedAccount(t, [{ id: 'lq1trip', title: 'Trip', html: '<p>Day one</p>' }]);
  const ctx = { account: async () => new Account(syncKey, t).refresh() };
  const src = png(2400, 1800, (x, y) => [(x / 10 + noise() / 8) & 255, (y / 8 + noise() / 8) & 255, 90]);
  let bin = ''; for (let i = 0; i < src.length; i += 0x8000) bin += String.fromCharCode(...src.subarray(i, i + 0x8000));
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_image', arguments: { notepad: 'Trip', data: btoa(bin) } } }, ctx);
  const text = r.result.content[0].text;
  assert.ok(!r.result.isError, text);
  assert.match(text, /1600×1200, \d+ KB, shrunk from \d\.\d MB/);
  const back = await getImage(t, r.result.structuredContent.image);
  assert.equal(back.type, 'image/jpeg');
  assert.ok(back.bytes.length <= TARGET);
  // A hosted connector can bring its own shrinker.
  let used = 0;
  const own = { ...ctx, image: async (from) => { used++; assert.deepEqual(from, { url: 'https://example.com/a.png' }); return shrink(src); } };
  const r2 = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_image', arguments: { notepad: 'Trip', url: 'https://example.com/a.png' } } }, own);
  assert.ok(!r2.result.isError, r2.result.content[0].text);
  assert.equal(used, 1);
});
