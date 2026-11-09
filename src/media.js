// Images and embeds the way the Sidenote extension keeps them (its src/media.js; keep the two
// in step).
//
// An image has its own random key ("img-…"). A note stores only the key; the bytes sit on the
// sync service as their own blob ("i:<id>"), encrypted with a key derived from the image key
// and written once, so anyone who can read the note can read the image. The key commits to
// the picture: the blob holds a random 16-byte salt and the image, the key is the hash of
// both, and readers check it, so nobody who saw a key can store a different picture under it.
// Images are shrunk before they go up (shrink.js here; the extension has its own), and what is
// stored is at most MAX_IMAGE bytes. A source to shrink can be up to SOURCE_MAX.
//
// An embed is a link to a YouTube video or a Google Drive / Docs / Sheets / Slides / Forms
// file, stored in its canonical form (<figure data-embed="https://…">).

import { hex, sha } from './keys.js';

export const MAX_IMAGE = 1_000_000, SOURCE_MAX = 15_000_000;
export const IMG_KEY = /^img-[0-9a-hjkmnp-tv-z]{5}(?:-[0-9a-hjkmnp-tv-z]{5}){4}$/;
export const isImgKey = (k) => IMG_KEY.test(k || '');
export const refs = (html) => [...new Set([...(html || '').matchAll(/data-img="(img-[0-9a-z-]{29})"/g)].map((m) => m[1]).filter(isImgKey))];

const derived = new Map();
export async function deriveImg(key) {
  if (derived.has(key)) return derived.get(key);
  const d = {
    id: 'i:' + hex(await sha('sn2:img:id:' + key)).slice(0, 40),
    w: hex(await sha('sn2:img:w:' + key)),
    k: await crypto.subtle.importKey('raw', await sha('sn2:img:k:' + key), 'AES-GCM', false, ['encrypt', 'decrypt']),
  };
  if (derived.size > 500) derived.clear();
  derived.set(key, d);
  return d;
}
const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz', SALT = 16;
function b32(bytes) {
  let s = '', val = 0, bits = 0;
  for (const x of bytes) { val = ((val << 8) | x) & 0xffff; bits += 8; while (bits >= 5) { s += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return s.slice(0, 25);
}
const keyOf = async (plain) => 'img-' + b32(new Uint8Array(await crypto.subtle.digest('SHA-256', plain)).subarray(0, 16)).match(/.{5}/g).join('-');
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

export function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}
// Width and height from the file's header (PNG, JPEG, GIF, WebP), or zeros.
export function dims(b) {
  const t = sniff(b);
  if (t === 'image/png') return { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  if (t === 'image/gif') return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  if (t === 'image/webp') {
    const f = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (f === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (f === 'VP8L') { const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (f === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (t === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return { w: 0, h: 0 };
}

// Up to the sync service under a new key. send: the /api/sync transport; size: { w, h } when
// known (else read from the file). -> { key, w, h, type, size }
export async function putImage(send, bytes, size = null) {
  const type = sniff(bytes);
  if (!type) throw new Error('That isn’t a PNG, JPEG, GIF or WebP image.');
  if (bytes.length > MAX_IMAGE) throw new Error(`That image is ${(bytes.length / 1e6).toFixed(1)} MB; the most stored is ${MAX_IMAGE / 1e6} MB.`);
  const plain = cat(crypto.getRandomValues(new Uint8Array(SALT)), bytes);
  const key = await keyOf(plain), d = await deriveImg(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, d.k, plain));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  const [r] = await send([{ id: d.id, rev: 0, put: { ifRev: 0, w: d.w, data: b64(all) } }]);
  if (!r?.ok) throw new Error(`Uploading the image failed (${r?.error || 'no answer'}).`);
  return { key, ...(size?.w && size?.h ? { w: size.w, h: size.h } : dims(bytes)), type, size: bytes.length };
}
// -> { bytes, type } or null when nothing is stored under that key (yet). Throws when what is
// stored isn't the picture the key names.
export async function getImage(send, key) {
  if (!isImgKey(key)) throw new Error('That isn’t an image key (they look like img-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx).');
  const d = await deriveImg(key);
  const [r] = await send([{ id: d.id, rev: 0 }]);
  if (!r?.data) return null;
  const all = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, d.k, all.subarray(12))); } catch { plain = null; }
  if (!plain || plain.length <= SALT || (await keyOf(plain)) !== key) throw new Error('The image stored under that key doesn’t match it, so it isn’t shown.');
  const bytes = plain.subarray(SALT);
  return { bytes, type: sniff(bytes) || 'application/octet-stream' };
}
// Addresses on this computer or its network, which an image address should never reach.
const LOCAL = /^(localhost|.*\.(localhost|local|internal|lan|home|arpa)|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.\d+\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;
// An image from the web, at most `max` bytes.
export async function fetchImage(url, fetchImpl = fetch, max = SOURCE_MAX) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That isn’t a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) image addresses work.');
  if (LOCAL.test(u.hostname) || !u.hostname.includes('.')) throw new Error('That address isn’t on the public web.');
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 15000);
  try {
    let r = null, at = u;
    for (let hop = 0; hop < 5; hop++) { // redirects by hand, so each address is checked
      r = await fetchImpl(at.href, { signal: ac.signal, redirect: 'manual', headers: { accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' } });
      if (r.status < 300 || r.status >= 400) break;
      const next = r.headers.get('location');
      if (!next) break;
      at = new URL(next, at);
      if (!/^https?:$/.test(at.protocol) || LOCAL.test(at.hostname)) throw new Error('That image address redirects off the public web.');
    }
    if (!r.ok) throw new Error(`Fetching the image failed (HTTP ${r.status}).`);
    const big = () => new Error(`That image is over ${max / 1e6} MB. Use a smaller one.`);
    if (+(r.headers.get('content-length') || 0) > max) throw big();
    const parts = [];
    let n = 0;
    for (const reader = r.body.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { reader.cancel().catch(() => {}); throw big(); }
      parts.push(value);
    }
    const buf = new Uint8Array(n);
    let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('Fetching the image took too long.') : e;
  } finally { clearTimeout(t); }
}

// --- embeds -------------------------------------------------------------------------------
const YT = /^[\w-]{11}$/, GID = /^[\w-]{10,}$/;
function seconds(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
// { kind, label, canon } for a link Sidenote can show in a frame, else null.
export function embedOf(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, ''), p = u.pathname;
  let id = null, short = false;
  if (h === 'youtu.be') id = p.slice(1).split('/')[0];
  else if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
    if (p === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(embed|shorts|live|v)\/([\w-]{11})/.exec(p); if (m) { id = m[2]; short = m[1] === 'shorts'; } }
  }
  if (id && YT.test(id)) {
    const t = seconds(u.searchParams.get('t') || u.searchParams.get('start'));
    return { kind: 'youtube', label: 'YouTube', canon: `https://www.youtube.com/${short ? 'shorts/' + id : 'watch?v=' + id}${t ? (short ? '?' : '&') + 't=' + t + 's' : ''}`, ratio: short ? 9 / 16 : 16 / 9 };
  }
  if (h === 'drive.google.com') {
    let m = /^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(p);
    const fid = m ? m[1] : p === '/open' || p === '/uc' ? u.searchParams.get('id') : null;
    if (fid && GID.test(fid)) return { kind: 'drive', label: 'Google Drive', canon: `https://drive.google.com/file/d/${fid}/view`, ratio: 4 / 3 };
    m = /^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/.exec(p);
    if (m && GID.test(m[1])) return { kind: 'folder', label: 'Drive folder', canon: `https://drive.google.com/drive/folders/${m[1]}`, ratio: 16 / 10 };
    return null;
  }
  if (h === 'docs.google.com') {
    const m = /^\/(document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/(e\/)?([\w-]+)/.exec(p);
    if (!m || !GID.test(m[3])) return null;
    const [, type, pub, fid] = m, base = `https://docs.google.com/${type}/d/${pub ? 'e/' : ''}${fid}`;
    const T = { document: ['docs', 'Google Docs', 4 / 5, pub ? '/pub' : '/edit'], spreadsheets: ['sheets', 'Google Sheets', 4 / 3, pub ? '/pubhtml' : '/edit'], presentation: ['slides', 'Google Slides', 16 / 10, pub ? '/pub' : '/edit'], forms: ['forms', 'Google Forms', 3 / 4, '/viewform'] }[type];
    return { kind: T[0], label: T[1], canon: base + T[3], ratio: T[2] };
  }
  return null;
}
