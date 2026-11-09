// Shrinks an image before it goes into a note, the way the extension shrinks one you paste
// (longest side at most 1600 px, most under 250 KB), in plain JavaScript so it runs wherever
// the connector does: Node, Deno, a browser. JPEG and PNG are decoded here (jpeg-js, vendored,
// and the PNG reader below); phone photos are turned the right way up from their EXIF
// orientation. A picture with transparency stays a PNG; a PNG screenshot stays a PNG when that
// is small enough; everything else becomes a JPEG. GIFs (often animated) and WebPs are kept as
// they are, up to 1 MB.

import decodeJpeg from './vendor/jpeg-decode.js';
import encodeJpeg from './vendor/jpeg-encode.js';
import { sniff, dims, fetchImage, MAX_IMAGE } from './media.js';
import { hex, sha } from './keys.js';

export const MAX_SIDE = 1600, TARGET = 250_000, MAX_PIXELS = 50e6;

// What to store for an image source ({ bytes } or { url }): { bytes, type, w, h, was }.
export async function prepImage({ bytes, url }) {
  if (!bytes) bytes = await fetchImage(url);
  return shrink(bytes);
}

// The header the hosted connector sends to its shrinker (a separate function on the same site,
// since an edge function can't spend a second of CPU), so nobody else can use it.
export const shrinkToken = async (secret) => hex(await sha('sidenote-mcp:shrink:' + secret));

// The image as it is, when it needs no work: { bytes, type, w, h, was }, else null.
export function quick(bytes) {
  const type = sniff(bytes);
  if (!type) throw new Error('That isn’t a PNG, JPEG, GIF or WebP image.');
  const { w, h } = upright(bytes, dims(bytes));
  const keep = { bytes, type, w, h, was: bytes.length };
  if (type === 'image/gif' || type === 'image/webp') {
    if (bytes.length > MAX_IMAGE) throw new Error(`That ${type === 'image/gif' ? 'GIF' : 'WebP'} is ${mb(bytes.length)} MB; the most for one is ${mb(MAX_IMAGE)} MB. Use a smaller one, or a PNG or JPEG (those get shrunk).`);
    return keep;
  }
  return bytes.length <= TARGET && Math.max(w, h) <= MAX_SIDE ? keep : null;
}

export async function shrink(bytes) {
  const kept = quick(bytes);
  if (kept) return kept;
  const type = sniff(bytes), was = bytes.length;
  const { w: W0, h: H0 } = dims(bytes);
  if (W0 * H0 > MAX_PIXELS) throw new Error(`That image is ${Math.round(W0 * H0 / 1e6)} megapixels; the most is ${MAX_PIXELS / 1e6}.`);
  let img;
  try {
    if (type === 'image/png') img = await decodePng(bytes);
    else {
      const d = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 700 });
      img = { w: d.width, h: d.height, px: d.data, alpha: false };
    }
  } catch (e) {
    throw new Error(`Couldn’t read that ${type === 'image/png' ? 'PNG' : 'JPEG'} to shrink it (${e.message}).`);
  }
  const turn = type === 'image/jpeg' ? orientation(bytes) : 1;
  const longest = Math.max(img.w, img.h);
  let scale = Math.min(1, MAX_SIDE / longest), q = 82, out = null, r = null, at = 0;
  for (let i = 0; i < 7; i++) {
    if (at !== scale) {
      const w = Math.max(1, Math.round(img.w * scale)), h = Math.max(1, Math.round(img.h * scale));
      r = rotate(scale < 1 ? resize(img.px, img.w, img.h, w, h, img.alpha) : img.px, w, h, turn);
      at = scale;
    }
    if (img.alpha) out = { bytes: await encodePng(r.px, r.w, r.h, true), type: 'image/png', w: r.w, h: r.h };
    else {
      if (i === 0 && type === 'image/png') { // a screenshot stays sharp as a PNG when that is light enough
        const png = await encodePng(r.px, r.w, r.h, false);
        if (png.length <= TARGET) { out = { bytes: png, type: 'image/png', w: r.w, h: r.h }; break; }
      }
      out = { bytes: encodeJpeg({ data: r.px, width: r.w, height: r.h }, q).data, type: 'image/jpeg', w: r.w, h: r.h };
    }
    if (out.bytes.length <= TARGET || (img.alpha && Math.max(r.w, r.h) <= 800)) break;
    if (!img.alpha && q > 70) q = 70; else scale *= 0.8;
  }
  // Already light and no bigger than ours (and upright): keep the original as it is.
  if (longest <= MAX_SIDE && turn === 1 && bytes.length <= out.bytes.length) return { bytes, type, w: img.w, h: img.h, was };
  if (out.bytes.length > MAX_IMAGE) throw new Error('That image is too large, even shrunk.');
  return { ...out, was };
}

const mb = (n) => (n / 1e6).toFixed(1);

// --- EXIF orientation -----------------------------------------------------------------------
// 1 (as stored) to 8, from a JPEG's EXIF block.
export function orientation(b) {
  for (let i = 2; i + 4 < b.length;) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xda || m === 0xd9) return 1;
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, le = b[t] === 0x49;
      const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
      const u32 = (o) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
      const ifd = u32(4), n = u16(ifd);
      for (let k = 0; k < n && t + ifd + 14 + k * 12 <= b.length; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}
// Width and height as the picture is seen (EXIF orientations 5 to 8 swap them).
function upright(bytes, d) {
  return sniff(bytes) === 'image/jpeg' && orientation(bytes) >= 5 ? { w: d.h, h: d.w } : d;
}
// RGBA pixels turned upright for an EXIF orientation.
function rotate(px, w, h, o) {
  if (o === 1) return { px, w, h };
  const swap = o >= 5, dw = swap ? h : w, dh = swap ? w : h, out = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let sx, sy;
      switch (o) {
        case 2: sx = w - 1 - dx; sy = dy; break;
        case 3: sx = w - 1 - dx; sy = h - 1 - dy; break;
        case 4: sx = dx; sy = h - 1 - dy; break;
        case 5: sx = dy; sy = dx; break;
        case 6: sx = dy; sy = h - 1 - dx; break;
        case 7: sx = w - 1 - dy; sy = h - 1 - dx; break;
        default: sx = w - 1 - dy; sy = dx; // 8
      }
      const s = (sy * w + sx) * 4, d = (dy * dw + dx) * 4;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
    }
  }
  return { px: out, w: dw, h: dh };
}

// --- resizing -------------------------------------------------------------------------------
// Area averaging (each output pixel is the mean of the source pixels it covers), which is what
// a good downscale is. Colours are weighted by alpha so transparent edges don't darken.
function spans(from, to) {
  const k = from / to, out = [];
  for (let i = 0; i < to; i++) {
    const a = i * k, b = a + k, list = [];
    for (let s = Math.floor(a); s < Math.min(from, Math.ceil(b)); s++) list.push(s, Math.min(b, s + 1) - Math.max(a, s));
    out.push(list);
  }
  return out;
}
function resize(px, W, H, w, h, alpha) {
  // Colour sums are weighted by alpha (opaque pixels all weigh 255), so dividing by the alpha
  // sum gives the colour; the alpha sum over the area covered gives the alpha.
  const xs = spans(W, w), ys = spans(H, h), tmp = new Float32Array(w * H * 4), area = (W / w) * (H / h);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < w; x++) {
      const l = xs[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < l.length; j += 2) {
        const s = row + l[j] * 4, wt = px[s + 3] * l[j + 1];
        r += px[s] * wt; g += px[s + 1] * wt; b += px[s + 2] * wt; a += wt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const l = ys[y];
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < l.length; j += 2) {
        const s = (l[j] * w + x) * 4, f = l[j + 1];
        r += tmp[s] * f; g += tmp[s + 1] * f; b += tmp[s + 2] * f; a += tmp[s + 3] * f;
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = r / a + 0.5; out[o + 1] = g / a + 0.5; out[o + 2] = b / a + 0.5; }
      out[o + 3] = alpha ? Math.min(255, a / area + 0.5) : 255;
    }
  }
  return out;
}

// --- PNG ------------------------------------------------------------------------------------
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const join = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export async function decodePng(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), idat = [];
  let p = 8, w = 0, h = 0, depth = 8, ct = 0, lace = 0, plte = null, trns = null;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; ct = b[p + 17]; lace = b[p + 20]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!w || !h || !ch) throw new Error('not a PNG it understands');
  if (lace) throw new Error('interlaced PNGs aren’t supported; save it without interlacing');
  if (w * h > MAX_PIXELS) throw new Error('too many pixels');
  const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
  const raw = await pipe(join(idat), new DecompressionStream('deflate'));
  if (raw.length < (stride + 1) * h) throw new Error('the image data is cut short');
  const rows = new Uint8Array(stride * h);
  for (let y = 0, prev = new Uint8Array(stride); y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v;
    }
    prev = cur;
  }
  const max = (1 << depth) - 1;
  const get = depth === 8 ? (r, i) => r[i] : depth === 16 ? (r, i) => (r[i * 2] << 8) | r[i * 2 + 1] : (r, i) => (r[(i * depth) >> 3] >> (8 - depth - ((i * depth) & 7))) & max;
  const to8 = depth === 16 ? (v) => v >> 8 : depth < 8 ? (v) => Math.round((v * 255) / max) : (v) => v;
  const key = trns && (ct === 0 || ct === 2) ? [0, 2, 4].slice(0, ct === 0 ? 1 : 3).map((o) => (trns[o] << 8) | trns[o + 1]) : null;
  const px = new Uint8Array(w * h * 4);
  let alpha = false;
  for (let y = 0; y < h; y++) {
    const r = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let R, G, B, A = 255;
      if (ct === 3) {
        const k = get(r, x);
        R = plte?.[k * 3] ?? 0; G = plte?.[k * 3 + 1] ?? 0; B = plte?.[k * 3 + 2] ?? 0;
        if (trns && k < trns.length) A = trns[k];
      } else if (ct === 0 || ct === 4) {
        const v = get(r, x * (ct === 4 ? 2 : 1));
        R = G = B = to8(v);
        if (ct === 4) A = to8(get(r, x * 2 + 1));
        else if (key && v === key[0]) A = 0;
      } else {
        const n = ct === 6 ? 4 : 3, rv = get(r, x * n), gv = get(r, x * n + 1), bv = get(r, x * n + 2);
        R = to8(rv); G = to8(gv); B = to8(bv);
        if (ct === 6) A = to8(get(r, x * n + 3));
        else if (key && rv === key[0] && gv === key[1] && bv === key[2]) A = 0;
      }
      px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = A;
      if (A !== 255) alpha = true;
    }
  }
  return { w, h, px, alpha };
}

let CRC = null;
function crc32(parts) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = new Uint8Array(8), t = new TextEncoder().encode(type), tail = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, data.length); head.set(t, 4);
  new DataView(tail.buffer).setUint32(0, crc32([t, data]));
  return join([head, data, tail]);
}
// RGBA pixels -> PNG (RGB when there is no transparency). Each row takes the filter that leaves
// the smallest bytes, the usual heuristic.
async function encodePng(px, w, h, alpha) {
  const ch = alpha ? 4 : 3, stride = w * ch, raw = new Uint8Array((stride + 1) * h), line = new Uint8Array(stride), prev = new Uint8Array(stride), tries = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = x * ch; line[d] = px[s]; line[d + 1] = px[s + 1]; line[d + 2] = px[s + 2]; if (alpha) line[d + 3] = px[s + 3]; }
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = tries[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? line[i - ch] : 0, up = prev[i], c = i >= ch ? prev[i - ch] : 0;
        let v = line[i];
        if (f === 1) v -= a;
        else if (f === 2) v -= up;
        else if (f === 3) v -= (a + up) >> 1;
        else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v -= pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        t[i] = v;
        const sv = t[i];
        sum += sv < 128 ? sv : 256 - sv;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(tries[best], y * (stride + 1) + 1);
    prev.set(line);
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return join([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', await pipe(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array(0))]);
}
